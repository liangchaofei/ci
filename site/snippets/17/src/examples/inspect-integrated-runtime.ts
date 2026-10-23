// #region imports
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runNode } from "../evaluation/process.ts";
import {
  prepareIntegratedScenario,
  runIntegratedScenario,
} from "./integrated-scenario.ts";
import type { IntegrationMode } from "./integrated-scenario.ts";
// #endregion imports

// #region exits
await mkdir(".agent-data", { recursive: true });
const base = await mkdtemp(resolve(".agent-data/integration-review-"));
const expected = [
  ["normal", "completed"],
  ["early-finish", "failed"],
  ["denied", "failed"],
  ["request-limit", "resource-limit"],
  ["context-limit", "context-limit"],
  ["cancel", "cancelled"],
] as const;

for (const [mode, status] of expected) {
  const report = await runIntegratedScenario(join(base, mode), mode);
  // 判定前先保存实际报告，失败时仍可检查首次偏离的位置。
  await writeFile(
    join(base, mode, `${mode}-report.json`),
    JSON.stringify(report, null, 2),
    { flag: "wx" },
  );
  assert.equal(report.result.outcome.status, status);
  assert.equal(report.budget.requests, report.httpCalls);
  assert.equal(report.budget.active, 0);

  // 每次实际传输都必须能通过 runId 对上本段事件，而不是只靠打印顺序。
  assert(
    report.requests.every((request) =>
      report.trace.some((event) => event.runId === request.runId),
    ),
  );
  const observations = report.result.state.messages.filter(
    (message) => message.role === "tool",
  );

  if (mode === "normal") {
    assert.equal(report.httpCalls, 3);
    assert.equal(report.budget.knownTokens, 60);
    assert.equal(report.budget.unreportedRequests, 1);
    assert.equal(observations.length, 2);
    const lastInput = report.requests.at(-1)!.messages as {
      role: string;
      tool_call_id?: string;
    }[];
    assert.deepEqual(
      lastInput.filter((m) => m.role === "tool").map((m) => m.tool_call_id),
      ["source-1", "tests-1"],
    );
  } else if (mode === "denied") {
    assert(
      observations.some(
        (m) =>
          m.result.callId === "tests-1" &&
          m.result.status === "error" &&
          m.result.code === "permission-denied",
      ),
    );
  } else {
    assert.equal(observations.length, 0);
  }

  console.log(`[整合检查通过] ${mode} → ${status}`);
}
// #endregion exits

// #region recovery
// 使用两个真实进程，避免同一内存里的对象让恢复实验碰巧通过。
const command = fileURLToPath(new URL("./run-integrated-runtime.ts", import.meta.url));
const resumeBase = join(base, "process-resume");
await runNode(command, ["pause", resumeBase], base);
const before = await readFile(join(resumeBase, "pause", "journal.jsonl"), "utf8");
await runNode(command, ["resume", resumeBase], base);
const resumed = JSON.parse(
  await readFile(join(resumeBase, "resume-report.json"), "utf8"),
);
assert.equal(resumed.result.outcome.status, "completed");
assert.equal(
  resumed.trace.filter((event: { type: string }) => event.type === "batch-started")
    .length,
  0,
);
assert.equal(
  before,
  await readFile(join(resumeBase, "pause", "journal.jsonl"), "utf8"),
);
console.log("[整合检查通过] 新进程读取旧暂停点，不重复读工具，不改旧日志");
// #endregion recovery

// #region isolation
const left = await prepareIntegratedScenario(join(base, "left"), "normal");
const right = await prepareIntegratedScenario(join(base, "right"), "normal");

try {
  // 同一进程同时运行两个实例，检查模块级可变变量是否造成串线。
  const [a, b] = await Promise.all([
    left.agent.run("任务 A"),
    right.agent.run("任务 B"),
  ]);
  assert.equal(a.outcome.status, "completed");
  assert.equal(b.outcome.status, "completed");
  assert.equal(a.state.goal, "任务 A");
  assert.equal(b.state.goal, "任务 B");
  assert.notEqual(left.directory, right.directory);
  assert.notEqual(left.report().trace[0].runId, right.report().trace[0].runId);
  assert.equal(left.report().budget.requests, 3);
  assert.equal(right.report().budget.requests, 3);

  // 调用方修改返回值，不应污染实例留存结果或另一个实例。
  a.state.messages.length = 0;
  assert(left.agent.result!.state.messages.length > 0);
  assert(right.agent.result!.state.messages.length > 0);
  console.log("[整合检查通过] 两个实例的状态、报告、预算与保存目录各自独立");
} finally {
  await Promise.all([left.close(), right.close()]);
}
console.log(`[整合证据目录] ${base}`);
// #endregion isolation
