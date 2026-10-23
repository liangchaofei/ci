import type { ModelBudget } from "../../runtime/model-budget.ts";
import { readDeepSeekUsage } from "./usage.ts";
import { DependencyError } from "../../runtime/dependency-error.ts";
import { retry } from "../../runtime/retry.ts";
import type { RetrySettings } from "../../runtime/retry.ts";

export type HttpOptions = { fetch?: typeof fetch; retry?: RetrySettings; budget?: ModelBudget };

/** 本章支持 Retry-After 的秒数和日期；无效值不作为等待依据。 */
function retryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.max(0, time - Date.now()) : undefined;
}

/** 非流式请求局部重试；原 Action 解码和工具执行仍在这个函数之外。 */
export async function requestDeepSeek(
  apiKey: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
  options: HttpOptions = {},
): Promise<unknown> {
  if (!apiKey.trim()) throw new Error("DEEPSEEK_API_KEY is required");
  const encoded = JSON.stringify(body);
  const send = options.fetch ?? fetch;

  return retry(async () => {
    signal.throwIfAborted();
    const lease = options.budget?.begin();
    try {
      let response: Response;
      try {
        response = await send("https://api.deepseek.com/chat/completions", {
          method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: encoded, signal,
        });
      } catch (error) {
        signal.throwIfAborted();
        const cause = error instanceof Error ? error.cause : undefined;
        const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
        const transient = ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"].includes(String(code));
        throw new DependencyError({ source: "transport", kind: transient ? "transient" : "unknown",
          message: transient ? `DeepSeek network ${code}` : "DeepSeek network failure without a recognized cause" });
      }

      if (!response.ok) {
        const wait = retryAfter(response.headers.get("retry-after"));
        await response.body?.cancel();
        const kind = [429, 500, 503].includes(response.status) ? "transient" :
          [400, 401, 402, 422].includes(response.status) ? "permanent" : "unknown";
        throw new DependencyError({ source: "transport", kind,
          message: `DeepSeek HTTP ${response.status}`, retryAfterMs: wait });
      }

      let payload: unknown;
      try { payload = await response.json(); }
      catch {
        signal.throwIfAborted();
        throw new DependencyError({ source: "model-protocol", kind: "unknown", message: "Invalid or interrupted DeepSeek JSON" });
      }
      signal.throwIfAborted();
      if (lease) lease.report(readDeepSeekUsage(payload));
      return payload;
    } finally {
      lease?.close();
    }
  }, { ...(options.retry ?? { maxAttempts: 3, baseDelayMs: 300, maxDelayMs: 3_000 }), safety: "read-only" }, signal);
}