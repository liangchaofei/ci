import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgentLoop } from "../src/runtime/agent-loop.ts";
import { fixture, task } from "../test-support/runtime-fixture.ts";

test("the next decision receives the tool result", async () => {
  const result = await runAgentLoop(task, fixture(), 3);
  assert.deepEqual(result.outcome, { status: "completed", answer: "name" });
  assert.equal(result.state.decisions, 2);
  assert.equal(result.state.observations.length, 1);
  assert.deepEqual(result.events.map((e) => e.kind), ["decision", "observation", "decision"]);
});
test("a missing allowed file fails instead of inventing an answer", async () => {
  const result = await runAgentLoop(task, fixture(null), 3);
  assert.equal(result.outcome.status, "failed");
  assert.equal(result.state.observations[0]?.status, "error");
});
test("an empty file is still successful", async () => {
  const result = await runAgentLoop(task, fixture(""), 3);
  assert.deepEqual(result.outcome, { status: "completed", answer: "" });
});
test("early finish cannot bypass application validation", async () => {
  const dependencies = fixture();
  dependencies.decide = async () => ({ kind: "finish", answer: "name" });
  const result = await runAgentLoop(task, dependencies, 3);
  assert.deepEqual(result.outcome, { status: "failed", reason: "Finish lacks matching evidence" });
});
test("repeated reads stop at the decision limit", async () => {
  const dependencies = fixture();
  dependencies.decide = async (state) => ({ kind: "tool", call: {
    id: `read-${state.decisions}`, name: "read_text", arguments: { path: "project-name.txt" },
  } });
  const result = await runAgentLoop(task, dependencies, 2);
  assert.equal(result.outcome.status, "budget-exhausted");
  assert.equal(result.state.decisions, 2);
});
test("out-of-scope input returns a failed tool observation", async () => {
  const dependencies = fixture();
  dependencies.decide = async (state) => state.observations.length === 0
    ? { kind: "tool", call: { id: "x", name: "read_text", arguments: { path: "outside.txt" } } }
    : { kind: "fail", reason: "Rejected path" };
  const result = await runAgentLoop(task, dependencies, 3);
  assert.equal(result.state.observations[0]?.status, "error");
  assert.equal(result.outcome.status, "failed");
});
test("runs do not share task facts", async () => {
  const first = await runAgentLoop(task, fixture(), 3);
  const second = await runAgentLoop(task, fixture(null), 3);
  assert.equal(first.outcome.status, "completed");
  assert.equal(second.outcome.status, "failed");
  assert.notEqual(first.state.observations, second.state.observations);
});
test("one decision cannot finish the two-decision task", async () => {
  const result = await runAgentLoop(task, fixture(), 1);
  assert.equal(result.outcome.status, "budget-exhausted");
  assert.equal(result.state.observations[0]?.status, "ok");
});
test("a wrong answer fails after successful execution", async () => {
  const dependencies = fixture();
  const decide = dependencies.decide;
  dependencies.decide = async (state, signal) => state.observations.length > 0
    ? { kind: "finish", answer: "wrong" } : decide(state, signal);
  const result = await runAgentLoop(task, dependencies, 3);
  assert.equal(result.outcome.status, "failed");
});
test("a result for another call is rejected before state update", async () => {
  const dependencies = fixture();
  dependencies.executeToolCall = async () => ({ callId: "wrong", toolName: "read_text", status: "ok", value: "name" });
  const result = await runAgentLoop(task, dependencies, 3);
  assert.deepEqual(result.outcome, { status: "failed", reason: "Tool result does not match call" });
  assert.equal(result.state.observations.length, 0);
});
test("an executor boundary exception returns its source", async () => {
  const dependencies = fixture();
  dependencies.executeToolCall = async () => { throw new Error("Executor unavailable"); };
  const result = await runAgentLoop(task, dependencies, 3);
  assert.deepEqual(result.outcome, { status: "failed", reason: "Executor unavailable", source: "execution" });
});
test("duplicate call ids cannot execute twice", async () => {
  const dependencies = fixture();
  dependencies.decide = async () => ({ kind: "tool", call: { id: "same", name: "read_text", arguments: { path: "project-name.txt" } } });
  const result = await runAgentLoop(task, dependencies, 3);
  assert.equal(result.outcome.status, "failed");
  assert.equal(result.state.observations.length, 1);
});
test("a decision cannot mutate retained tool facts", async () => {
  const dependencies = fixture();
  const decide = dependencies.decide;
  dependencies.decide = async (state, signal) => {
    if (state.observations.length > 0) state.observations.length = 0;
    return decide(state, signal);
  };
  const result = await runAgentLoop(task, dependencies, 3);
  assert.equal(result.outcome.status, "budget-exhausted");
  assert.equal(result.state.observations.length, 3);
});

test("an executor cannot rewrite the expected call identity", async () => {
  const dependencies = fixture();
  dependencies.executeToolCall = async (call) => {
    call.id = "unrequested";
    call.name = "other_tool";
    return { callId: call.id, toolName: call.name, status: "ok", value: "name" };
  };
  const result = await runAgentLoop(task, dependencies, 3);
  assert.deepEqual(result.outcome, { status: "failed", reason: "Tool result does not match call" });
  assert.equal(result.state.observations.length, 0);
});
