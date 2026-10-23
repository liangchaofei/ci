// #region usage
import { DependencyError } from "../../runtime/dependency-error.ts";
import type { TokenUsage } from "../../runtime/resource-types.ts";

/** 只解析响应的 usage；不从文字长度猜 token，不重复加 reasoning 子项。 */
export function readDeepSeekUsage(payload: unknown): TokenUsage {
  const usage = payload && typeof payload === "object" && "usage" in payload ? payload.usage : undefined;
  if (!usage || typeof usage !== "object" || !("prompt_tokens" in usage) || !("completion_tokens" in usage) || !("total_tokens" in usage)) {
    throw new DependencyError({ source: "model-protocol", kind: "unknown", message: "Missing model usage" });
  }
  const { prompt_tokens: input, completion_tokens: output, total_tokens: total } = usage;
  if (typeof input !== "number" || typeof output !== "number" || typeof total !== "number" ||
      !Number.isSafeInteger(input) || input < 0 || !Number.isSafeInteger(output) || output < 0 ||
      !Number.isSafeInteger(total) || total !== input + output) {
    throw new DependencyError({ source: "model-protocol", kind: "unknown", message: "Invalid model usage" });
  }
  return { inputTokens: input, outputTokens: output };
}
// #endregion usage
