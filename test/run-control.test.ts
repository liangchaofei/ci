import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgentLoop } from "../src/runtime/agent-loop.ts";
import type {
  Dependencies,
  Observation,
} from "../src/runtime/types.ts";

test("cancelled execution cannot write a late result into state", async () => {
  const task = { targetPath: "project-name.txt" };
  const caller = new AbortController();

  // 保存读取 Promise 的完成函数，稍后手动返回结果。
  let resolveRead!: (value: Observation) => void;

  // 用通知确认执行器已启动，不靠固定延迟猜测。
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });

  const dependencies: Dependencies = {
    decide: async () => ({
      kind: "read",
      path: task.targetPath,
    }),

    executeRead: async () =>
      new Promise<Observation>((resolve) => {
        resolveRead = resolve;
        entered();
      }),
  };

  // 启动任务，但先不等待整次运行结束。
  const pending = runAgentLoop(task, dependencies, 3, {
    signal: caller.signal,
  });

  await started;
  caller.abort();

  const result = await pending;
  assert.equal(result.outcome.status, "cancelled");

  const eventCount = result.events.length;

  // 模拟忽略取消的执行器，迟到返回成功。
  resolveRead({
    kind: "read-ok",
    path: task.targetPath,
    content: "late",
  });

  // 让迟到结果的 Promise 回调有机会执行。
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(result.state.observation, null);
  assert.equal(result.events.length, eventCount);
});
test(
  "a hanging decision times out before any execution",
  { timeout: 2000 },
  async () => {
    const task = { targetPath: "project-name.txt" };
    let executions = 0;

    const dependencies: Dependencies = {
      // 故意不返回动作，模拟挂起的模型请求。
      decide: async () => new Promise(() => {}),

      executeRead: async (action) => {
        executions += 1;

        return {
          kind: "read-ok",
          path: action.path,
          content: "name",
        };
      },
    };

    const result = await runAgentLoop(
      task,
      dependencies,
      3,
      { timeoutMs: 20 },
    );

    assert.equal(result.outcome.status, "timed-out");
    assert.equal(result.state.decisions, 1);
    assert.equal(executions, 0);
  },
);
test("an already cancelled run does not call dependencies", async () => {
  const task = { targetPath: "project-name.txt" };
  const caller = new AbortController();

  // 取消发生在启动 Runtime 之前。
  caller.abort();

  let decisions = 0;
  let executions = 0;

  const dependencies: Dependencies = {
    decide: async () => {
      decisions += 1;
      return { kind: "read", path: task.targetPath };
    },

    executeRead: async (action) => {
      executions += 1;
      return {
        kind: "read-ok",
        path: action.path,
        content: "name",
      };
    },
  };

  const result = await runAgentLoop(
    task,
    dependencies,
    3,
    { signal: caller.signal },
  );

  assert.equal(result.outcome.status, "cancelled");
  assert.equal(result.state.decisions, 0);
  assert.equal(decisions, 0);
  assert.equal(executions, 0);
});
test("an error message cannot impersonate a runtime timeout", async () => {
  const task = { targetPath: "project-name.txt" };
  let executions = 0;

  const dependencies: Dependencies = {
    decide: async () => {
      // 消息像超时，但没有触发 Runtime 的停止机制。
      throw new Error("timed-out");
    },

    executeRead: async (action) => {
      executions += 1;
      return {
        kind: "read-ok",
        path: action.path,
        content: "name",
      };
    },
  };

  const result = await runAgentLoop(
    task,
    dependencies,
    3,
  );

  assert.deepEqual(result.outcome, {
    status: "failed",
    reason: "timed-out",
    source: "decision",
  });

  assert.equal(executions, 0);
});