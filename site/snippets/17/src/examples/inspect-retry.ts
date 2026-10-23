// #region probe
import { DependencyError } from "../runtime/dependency-error.ts";
import { retry } from "../runtime/retry.ts";

let attempts = 0;
const value = await retry(async (attempt) => {
  attempts += 1;
  console.log(`[读取尝试 attempt] ${attempt}`);
  if (attempt === 1) throw new DependencyError({ source: "tool", kind: "transient", message: "模拟只读服务暂时不可用" });
  return "读取成功";
}, {
  safety: "read-only", maxAttempts: 3, baseDelayMs: 20, maxDelayMs: 100, random: () => 0.5,
  onRetry: (notice) => console.log(`[准备重试] 第 ${notice.nextAttempt} 次，等待 ${notice.delayMs}ms`),
}, new AbortController().signal);

console.log(`[最终值] ${value}，实际尝试=${attempts}`);
// #endregion probe
