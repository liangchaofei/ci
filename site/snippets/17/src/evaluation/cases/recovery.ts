// #region imports
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runNode } from "../process.ts";
import { readEvidence, runCriteria } from "../evidence.ts";
import { inspectRecovery } from "../../runtime/recovery-reader.ts";
import { inspectWorkspace } from "../../examples/recovery-workspace.ts";
import type { EvaluationCase } from "../contracts.ts";
// #endregion imports

// #region resume
export const recoveryCase: EvaluationCase = {
  id: "recovery",
  title: "跨进程：接续已确认暂停点，不重读已有材料",
  async run(directory) {
    // 用已知入口启动真实 Node 进程，不在当前内存里假装重启。
    const leg = fileURLToPath(new URL("../recovery-leg.ts", import.meta.url));
    await runNode(leg, ["save", directory], directory);

    const saved = readEvidence(
      JSON.parse(await readFile(join(directory, "save-evidence.json"), "utf8")),
    );
    const before = await readFile(join(directory, "saved", "journal.jsonl"), "utf8");

    // save 已退出，resume 才启动；新进程必须从磁盘恢复。
    await runNode(leg, ["resume", directory], directory);
    const resumed = readEvidence(
      JSON.parse(await readFile(join(directory, "resume-evidence.json"), "utf8")),
    );

    // 新进程的结果与旧消息前缀、旧日志分别核对。
    return {
      ...resumed,
      facts: {
        saveStatus: saved.result?.outcome.status,
        saveExecutions: saved.facts.executions,
        resumeExecutions: resumed.facts.executions,
        historyPreserved:
          saved.result !== null &&
          JSON.stringify(saved.result.state.messages) ===
            JSON.stringify(
              resumed.result?.state.messages.slice(
                0,
                saved.result.state.messages.length,
              ),
            ),
        oldJournalUnchanged:
          before ===
          (await readFile(join(directory, "saved", "journal.jsonl"), "utf8")),
      },
    };
  },
  criteria: [
    {
      name: "旧进程确实读取两项后暂停",
      actual: (e) => [e.facts.saveStatus, e.facts.saveExecutions],
      expected: ["paused", 2],
    },
    {
      name: "新进程完成",
      actual: (e) => e.result?.outcome.status,
      expected: "completed",
    },
    {
      name: "新进程实际工具调用为零",
      actual: (e) => e.facts.resumeExecutions,
      expected: 0,
    },
    {
      name: "已有消息前缀保留",
      actual: (e) => e.facts.historyPreserved,
      expected: true,
    },
    {
      name: "旧日志原文未修改",
      actual: (e) => e.facts.oldJournalUnchanged,
      expected: true,
    },
    ...runCriteria(),
  ],
};
// #endregion resume

// #region crash
export const unknownWriteCase: EvaluationCase = {
  id: "unknown-write",
  title: "写后崩溃：外部已改变，恢复检查仍阻止自动重放",
  async run(directory) {
    // 复用“写完并同步磁盘，再以 23 退出”的故障装置。
    const file = fileURLToPath(
      new URL("../../examples/crash-after-write.ts", import.meta.url),
    );
    const child = await runNode(file, [directory], directory, 23);
    const effect = join(directory, "effect.log");
    const before = await readFile(effect, "utf8");

    // 只检查能否恢复，不重复执行那次身份未确认的写入。
    const decision = await inspectRecovery(
      directory,
      "fault",
      await inspectWorkspace(join(directory, "workspace12"), ["append_mark"]),
    );

    // 崩溃没有正常 RunResult，以退出码和磁盘事实作为证据。
    return {
      result: null,
      trace: [],
      facts: {
        exitCode: child.code,
        recovery: decision.status,
        intents: decision.status === "blocked" ? decision.intents.map((i) => i.id) : [],
        effects: before.split("\n").filter(Boolean).length,
        effectUnchanged: before === (await readFile(effect, "utf8")),
      },
    };
  },
  criteria: [
    {
      name: "子进程在指定故障点退出",
      actual: (e) => e.facts.exitCode,
      expected: 23,
    },
    {
      name: "文件证明已有一次副作用",
      actual: (e) => e.facts.effects,
      expected: 1,
    },
    {
      name: "恢复没有获准",
      actual: (e) => e.facts.recovery,
      expected: "blocked",
    },
    {
      name: "待核查调用身份保留",
      actual: (e) => e.facts.intents,
      expected: ["write-1"],
    },
    {
      name: "检查没有追加第二次效果",
      actual: (e) => e.facts.effectUnchanged,
      expected: true,
    },
  ],
};
// #endregion crash

// #region stale
export const staleRecoveryCase: EvaluationCase = {
  id: "stale-recovery",
  title: "恢复前资源改变：旧证据不能继续授予接续资格",
  async run(directory) {
    // 用已知入口启动真实 Node 进程，不在当前内存里假装重启。
    const leg = fileURLToPath(new URL("../recovery-leg.ts", import.meta.url));
    await runNode(leg, ["save", directory], directory);
    const journal = join(directory, "saved", "journal.jsonl");
    const before = await readFile(journal, "utf8");

    // 暂停点原本有效；只改变真实资源，观察旧证据是否失效。
    await writeFile(join(directory, "workspace12", "sum.ts"), "// changed after pause");

    const decision = await inspectRecovery(
      directory,
      "saved",
      await inspectWorkspace(join(directory, "workspace12")),
    );

    return {
      result: null,
      trace: [],
      facts: {
        status: decision.status,
        reason: decision.status === "blocked" ? decision.reason : "",
        oldJournalUnchanged: before === (await readFile(journal, "utf8")),
      },
    };
  },
  criteria: [
    {
      name: "恢复检查阻止接续",
      actual: (e) => e.facts.status,
      expected: "blocked",
    },
    {
      name: "确实因为资源或授权变化",
      actual: (e) => e.facts.reason,
      expected: "Workspace revision or current tool grant changed",
    },
    {
      name: "没有改写旧日志掩盖变化",
      actual: (e) => e.facts.oldJournalUnchanged,
      expected: true,
    },
  ],
};
// #endregion stale
