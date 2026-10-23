// #region imports
import { appendFile, readFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DependencyError, describeFailure } from "../runtime/dependency-error.ts";
import { retry } from "../runtime/retry.ts";
// #endregion imports

// #region experiment
/** 故障装置：观察一个依赖何时停止，不启动新的 Agent 或模型。 */
async function experiment(mode: "permanent" | "unknown" | "exhausted" | "write" | "cancel" | "revoked"): Promise<void> {
  let attempts = 0;
  const controller = new AbortController();
  const directory = mode === "write" ? await mkdtemp(join(tmpdir(), "runtime-retry-")) : "";
  const file = join(directory, "effects.txt");
  try {
    await retry(async () => {
      attempts += 1;
      if (mode === "write") await appendFile(file, "一次外部写入\n");
      if (mode === "unknown") throw new Error("503 timeout retryable（只有文字）");
      throw new DependencyError({ source: "tool", kind: mode === "permanent" ? "permanent" : "transient", message: mode });
    }, {
      safety: mode === "write" ? "never" : "read-only", maxAttempts: 3, baseDelayMs: 20, maxDelayMs: 100,
      random: () => 0.5,
      beforeAttempt: async (attempt) => { if (mode === "revoked" && attempt > 1) throw new Error("permission revoked"); },
      onRetry: () => { if (mode === "cancel") controller.abort(); },
    }, controller.signal);
  } catch (error) {
    console.log(`[${mode}] 尝试=${attempts}，取消=${controller.signal.aborted}，分类=${describeFailure(error).kind}`);
  }
  if (mode === "write") console.log(`[实际外部写入] ${(await readFile(file, "utf8")).trim().split("\n").length} 次；目录=${directory}`);
}
// #endregion experiment

// #region run
for (const mode of ["permanent", "unknown", "exhausted", "write", "cancel", "revoked"] as const) await experiment(mode);
// #endregion run
