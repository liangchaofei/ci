import { mkdtemp, readFile, appendFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore } from "../runtime/session-store.ts";
import { loadSession } from "../runtime/session-reader.ts";
import { Agent } from "../runtime/agent.ts";
import { ResultSaveError } from "../runtime/result-sink.ts";
import type { RunResult } from "../runtime/types.ts";

const mode = process.argv[2] ?? "tail";
if (!["tail", "corrupt", "version", "stale", "save-error"].includes(mode)) throw new Error("Unknown mode");
const base = await mkdtemp(join(tmpdir(), "runtime-session-"));
const store = await createSessionStore(base, "fault");
const journal = join(store.directory, "journal.jsonl");
const checkpoint = join(store.directory, "checkpoint.json");
const sample: RunResult = { state: { goal: "g", decisions: 0, messages: [{ role: "user", content: "g" }] }, outcome: { status: "paused" } };

try {
  if (mode === "save-error") {
    // 用同名目录阻止检查点替换，日志追加仍可能已经完成。
    await mkdir(checkpoint);
    const agent = new Agent({
      decide: async () => ({ kind: "finish", answer: "fixed answer" }),
      executeTool: async () => { throw new Error("No tool expected"); },
      validateFinish: () => true,
    }, { maxDecisions: 1, resultSink: store });
    try { await agent.run("g"); }
    catch (error) { console.log(`保存失败已报告（saveError）: ${error instanceof ResultSaveError}`); }
    console.log(`实例未发布成功结果（resultMissing）: ${agent.result === undefined}`);
  } else {
    await store.save("run-1", sample);
    if (mode === "tail") await appendFile(journal, '{"version":1');
    if (mode === "corrupt") await appendFile(journal, 'not-json\n');
    if (mode === "version") {
      const record = JSON.parse((await readFile(journal, "utf8")).trim());
      record.version = 99;
      await writeFile(journal, JSON.stringify(record) + "\n");
    }
    if (mode === "stale") {
      await store.save("run-2", { ...sample, outcome: { status: "cancelled" } });
      const first = (await readFile(journal, "utf8")).split("\n")[0];
      await writeFile(checkpoint, first + "\n");
    }
  }

  await store.close();
  try {
    const loaded = await loadSession(base, "fault");
    console.log(`最后已保存编号（seq）: ${loaded.latest?.seq}`);
    console.log(`忽略未写完末尾（ignoredTail）: ${loaded.ignoredTail}`);
    console.log(`检查点状态（checkpoint）: ${loaded.checkpointStatus}`);
  } catch {
    console.log("拒绝损坏或不支持的日志（rejected）: true");
  }
} finally {
  await store.close();
  // 仅移除本例自己创建的临时目录，不修改正式 .agent-data 会话。
  await rm(base, { recursive: true, force: true });
}