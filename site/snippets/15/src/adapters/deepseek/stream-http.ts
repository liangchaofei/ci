// #region imports
import { readSseData } from "../sse.ts";
import { readDeepSeekUsage } from "./usage.ts";
import { DependencyError } from "../../runtime/dependency-error.ts";
import type { HttpOptions } from "./http.ts";

// #endregion imports

// #region stream
/** 流式请求只记一次请求与最终用量，不在断流后自动重发。 */
export async function* requestDeepSeekEvents(
  apiKey: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
  options: HttpOptions = {},
): AsyncGenerator<string> {
  signal.throwIfAborted();
  if (!apiKey.trim()) throw new Error("DEEPSEEK_API_KEY is required");
  const encoded = JSON.stringify({ ...body, stream: true });
  const lease = options.budget?.begin();
  let reported = false;
  try {
    const response = await (options.fetch ?? fetch)("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "text/event-stream" },
      body: encoded, signal,
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`DeepSeek HTTP ${response.status}`); }
    const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (mediaType !== "text/event-stream" || !response.body) {
      await response.body?.cancel();
      throw new Error("Expected an SSE response body");
    }

    for await (const data of readSseData(response.body, signal)) {
      signal.throwIfAborted();
      if (lease) {
        if (data === "[DONE]") {
          if (!reported) throw new DependencyError({ source: "model-protocol", kind: "unknown", message: "Stream ended without usage" });
        } else {
          const payload: unknown = JSON.parse(data);
          if (payload && typeof payload === "object" && "usage" in payload && payload.usage != null) {
            lease.report(readDeepSeekUsage(payload));
            reported = true;
          }
        }
      }
      // 先核对用量，再把结束分片交给动作收集器，超额时不能形成可执行动作。
      yield data;
    }
  } finally {
    lease?.close();
  }
}
// #endregion stream
