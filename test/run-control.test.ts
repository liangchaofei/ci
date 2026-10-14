import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgentLoop } from "../src/runtime/agent-loop.ts";
import type { ToolResult } from "../src/runtime/types.ts";
import { fixture, task } from "../test-support/runtime-fixture.ts";

test("cancelled tool execution cannot write a late result", async () => {
  const caller = new AbortController();
  let resolveTool!: (value: ToolResult) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const dependencies = fixture();
  dependencies.executeToolCall = async () => new Promise<ToolResult>((resolve) => {
    resolveTool = resolve; entered();
  });
  const pending = runAgentLoop(task, dependencies, 3, { signal: caller.signal });
  await started; caller.abort();
  const result = await pending;
  assert.equal(result.outcome.status, "cancelled");
  const eventCount = result.events.length;
  resolveTool({ callId: "read-1", toolName: "read_text", status: "ok", value: "late" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(result.state.observations.length, 0);
  assert.equal(result.events.length, eventCount);
});
test("a hanging decision times out before execution", { timeout: 2000 }, async () => {
  const dependencies = fixture();
  let executions = 0;
  dependencies.decide = async () => new Promise(() => {});
  dependencies.executeToolCall = async (call) => {
    executions += 1; return { callId: call.id, toolName: call.name, status: "ok", value: "name" };
  };
  const result = await runAgentLoop(task, dependencies, 3, { timeoutMs: 20 });
  assert.equal(result.outcome.status, "timed-out");
  assert.equal(executions, 0);
});
test("pre-cancelled run starts no decision", async () => {
  const caller = new AbortController(); caller.abort();
  const dependencies = fixture(); let calls = 0;
  dependencies.decide = async () => { calls += 1; return { kind: "fail", reason: "unexpected" }; };
  const result = await runAgentLoop(task, dependencies, 3, { signal: caller.signal });
  assert.equal(result.outcome.status, "cancelled");
  assert.equal(result.state.decisions, 0); assert.equal(calls, 0);
});
test("error text cannot impersonate a runtime timeout", async () => {
  const dependencies = fixture();
  dependencies.decide = async () => { throw new Error("timed-out"); };
  const result = await runAgentLoop(task, dependencies, 3);
  assert.deepEqual(result.outcome, { status: "failed", reason: "timed-out", source: "decision" });
});
