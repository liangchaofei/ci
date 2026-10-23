import { mkdtemp, readFile, appendFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { inspectRecovery } from "../runtime/recovery-reader.ts";
import { inspectWorkspace } from "./recovery-workspace.ts";

const mode = process.argv[2] ?? "changed";
if (!["changed", "revoked", "tail", "receipt", "old", "crash"].includes(mode)) throw new Error("Unknown recovery experiment");
const base = await mkdtemp(join(tmpdir(), "runtime-recovery-"));

/** 子进程复用正式演示入口；不另写一套保存场景。 */
function runExample(name: string, args: string[], expected = 0): void {
  const file = fileURLToPath(new URL(name, import.meta.url));
  const child = spawnSync(process.execPath, [file, ...args], { encoding: "utf8", timeout: 10000 });
  if (child.status !== expected) throw new Error(`Unexpected child exit: ${child.status}: ${child.stderr}`, { cause: child.error });
}

try {
  if (mode === "crash") {
    runExample("./crash-after-write.ts", [base], 23);
    const effects = (await readFile(join(base, "effect.log"), "utf8")).trim().split("\n");
    console.log(`实际写入次数（effects）: ${effects.length}`);
  } else {
    runExample("./save-recoverable-session.ts", ["fault", base]);
    const directory = join(base, "fault");
    if (mode === "changed") await appendFile(join(base, "workspace12", "sum.ts"), "\n// changed");
    if (mode === "tail") await appendFile(join(directory, "journal.jsonl"), '{"version":');
    if (mode === "receipt") {
      const path = join(directory, "recovery.json");
      const boundary = JSON.parse(await readFile(path, "utf8"));
      boundary.receipt.digest = "0".repeat(64);
      await writeFile(path, JSON.stringify(boundary));
    }
    // 去掉本章新增的标记，复现第 11 篇旧会话“可读但缺恢复依据”的情况。
    if (mode === "old") await rm(join(directory, "recovery.json"));
  }

  const names = mode === "revoked" ? ["read_source"] : ["read_source", "read_tests"];
  const current = await inspectWorkspace(join(base, "workspace12"), names);
  const decision = await inspectRecovery(base, "fault", current);
  console.log(`恢复检查（status）: ${decision.status}`);
  if (decision.status === "blocked") {
    console.log(`停止原因（reason）: ${decision.reason}`);
    console.log(`待核查调用（intents）: ${decision.intents.map((item) => item.id).join(", ") || "无可确认清单"}`);
  }
} finally {
  // 只清理由本入口创建的临时目录，保留正式 .agent-data 会话。
  await rm(base, { recursive: true, force: true });
}
