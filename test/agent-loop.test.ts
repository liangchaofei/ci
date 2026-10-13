import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgentLoop } from "../src/runtime/agent-loop.ts";
import type { Dependencies, State } from "../src/runtime/types.ts";

/** 可预测的假模型与内存执行器，不访问网络或真实文件。 */
function fakeDependencies(
  files: ReadonlyMap<string, string>,
  onDecision?: (state: Readonly<State>) => void,
): Dependencies {
  return {
    decide: async (state) => {
      onDecision?.(state);
      // 先依据执行事实分流，不能根据调用次数假装已经读取。
      const result = state.observation;
      if (result === null) return { kind: "read", path: state.targetPath };
      if (result.kind === "read-failed") return { kind: "fail", reason: result.reason };
      return { kind: "finish", answer: result.content };
    },
    executeRead: async (action) => {
      // 空字符串是合法内容，只有 undefined 表示目标不存在。
      const content = files.get(action.path);
      return content === undefined
        ? { kind: "read-failed", path: action.path, reason: "File not found" }
        : { kind: "read-ok", path: action.path, content };
    },
  };
}

const task = { targetPath: "project-name.txt" };

test("the next decision receives the observation", async () => {
  const seen: State[] = [];
  const result = await runAgentLoop(task, fakeDependencies(
    new Map([[task.targetPath, "CI Agent Harness"]]),
    (state) => seen.push({ ...state }),
  ), 3);
  // 检查下一轮输入，能够捕获忘记更新 State 的错误。
  assert.equal(seen[0]?.observation, null);
  assert.deepEqual(seen[1]?.observation, {
    kind: "read-ok", path: task.targetPath, content: "CI Agent Harness",
  });
  assert.deepEqual(result.outcome, { status: "completed", answer: "CI Agent Harness" });
  assert.equal(result.state.decisions, 2);
  assert.deepEqual(result.events.map((event) => event.kind),
    ["decision", "observation", "decision"]);
});

test("a missing file fails instead of inventing an answer", async () => {
  const result = await runAgentLoop(task, fakeDependencies(new Map()), 3);
  assert.deepEqual(result.outcome, { status: "failed", reason: "File not found" });
  assert.equal(result.state.observation?.kind, "read-failed");
});

test("an empty file is still a successful read", async () => {
  const result = await runAgentLoop(task,
    fakeDependencies(new Map([[task.targetPath, ""]])), 3);
  assert.deepEqual(result.outcome, { status: "completed", answer: "" });
});

test("an early finish cannot bypass evidence checks", async () => {
  // 错误决策器提前结束，循环应自己守住证据门禁。
  let executions = 0;
  const result = await runAgentLoop(task, {
    decide: async () => ({ kind: "finish", answer: "Guess" }),
    executeRead: async (action) => {
      executions += 1;
      return { kind: "read-ok", path: action.path, content: "Guess" };
    },
  }, 3);
  assert.deepEqual(result.outcome,
    { status: "failed", reason: "Finish lacks matching evidence" });
  assert.equal(executions, 0);
});

test("repeated reads stop at the decision limit", async () => {
  let calls = 0;
  const dependencies = fakeDependencies(new Map([[task.targetPath, "name"]]));
  dependencies.decide = async () => {
    calls += 1;
    return { kind: "read", path: task.targetPath };
  };
  const result = await runAgentLoop(task, dependencies, 2);
  assert.equal(result.outcome.status, "budget-exhausted");
  assert.equal(calls, 2);
});

test("an out-of-scope read is rejected before execution", async () => {
  let executions = 0;
  const result = await runAgentLoop(task, {
    decide: async () => ({ kind: "read", path: "other.txt" }),
    executeRead: async (action) => {
      executions += 1;
      return { kind: "read-ok", path: action.path, content: "other" };
    },
  }, 3);
  assert.equal(result.outcome.status, "failed");
  assert.equal(executions, 0);
});

test("a later run does not inherit an earlier observation", async () => {
  const first = await runAgentLoop(task,
    fakeDependencies(new Map([[task.targetPath, "name"]])), 3);
  const second = await runAgentLoop(task, fakeDependencies(new Map()), 3);
  assert.equal(first.outcome.status, "completed");
  assert.equal(second.outcome.status, "failed");
  assert.notEqual(first.state, second.state);
  assert.notEqual(first.events, second.events);
});


test("one decision cannot complete the two-decision task", async () => {
  const result = await runAgentLoop(task,
    fakeDependencies(new Map([[task.targetPath, "name"]])), 1);
  assert.equal(result.state.observation?.kind, "read-ok");
  assert.equal(result.outcome.status, "budget-exhausted");
  assert.equal(result.state.decisions, 1);
});

test("a wrong answer fails even after a successful read", async () => {
  const dependencies = fakeDependencies(new Map([[task.targetPath, "name"]]));
  dependencies.decide = async (state) => state.observation === null
    ? { kind: "read", path: task.targetPath }
    : { kind: "finish", answer: "wrong" };
  const result = await runAgentLoop(task, dependencies, 3);
  assert.deepEqual(result.outcome,
    { status: "failed", reason: "Finish lacks matching evidence" });
});

test("a result for another path cannot update task facts", async () => {
  const dependencies = fakeDependencies(new Map());
  dependencies.executeRead = async () => ({
    kind: "read-ok", path: "other.txt", content: "name",
  });
  const result = await runAgentLoop(task, dependencies, 3);
  assert.deepEqual(result.outcome,
    { status: "failed", reason: "Observation path mismatch" });
  assert.equal(result.state.observation, null);
});

test("an execution exception returns a failed outcome", async () => {
  const dependencies = fakeDependencies(new Map());
  dependencies.executeRead = async () => { throw new Error("Simulated error"); };
  const result = await runAgentLoop(task, dependencies, 3);
  assert.deepEqual(result.outcome, { status: "failed", reason: "Simulated error" });
});