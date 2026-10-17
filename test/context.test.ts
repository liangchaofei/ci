import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgentLoop } from "../src/runtime/agent-loop.ts";
import { fixture, task } from "../test-support/runtime-fixture.ts";

test("state records the goal, accepted actions, and matching tool results", async () => {
  const result = await runAgentLoop(task, fixture(), 3);
  assert.deepEqual(result.state.messages, [
    { role: "user", content: task.goal },
    { role: "assistant", action: { kind: "tool", call: { id: "read-1", name: "read_text", arguments: { path: "project-name.txt" } } } },
    { role: "tool", result: { callId: "read-1", toolName: "read_text", status: "ok", value: "name" } },
    { role: "assistant", action: { kind: "finish", answer: "name" } },
  ]);
});

test("failed tool results remain in the message record", async () => {
  const result = await runAgentLoop(task, fixture(null), 3);
  assert.deepEqual(result.state.messages.map((message) => message.role), ["user", "assistant", "tool", "assistant"]);
  const tool = result.state.messages[2];
  assert.equal(tool?.role, "tool");
  if (tool?.role === "tool") assert.equal(tool.result.status, "error");
});

import { buildContext, createContextDecision } from "../src/runtime/context.ts";
import type { State } from "../src/runtime/types.ts";

function sampleState(): State {
  return { goal: "Read", decisions: 2,
    observations: [{ callId: "read-1", toolName: "read_text", status: "ok", value: "name" }],
    messages: [
      { role: "user", content: "Read" },
      { role: "assistant", action: { kind: "tool", call: { id: "read-1", name: "read_text", arguments: { path: "name.txt" } } } },
      { role: "tool", result: { callId: "read-1", toolName: "read_text", status: "ok", value: "name" } },
    ] };
}

test("context exposes messages and tool descriptions, not internal state fields", () => {
  const state = sampleState();
  const tools = [{ name: "read_text", description: "Read allowed text" }];
  const context = buildContext(state, tools);
  assert.deepEqual(Object.keys(context).sort(), ["messages", "tools"]);
  assert.deepEqual(context.messages, state.messages);
  assert.deepEqual(context.tools, tools);
});

test("changing context cannot change retained messages or tool descriptions", () => {
  const state = sampleState();
  const tools = [{ name: "read_text", description: "Read" }];
  const context = buildContext(state, tools);
  const message = context.messages[1];
  if (message?.role === "assistant" && message.action.kind === "tool") {
    const args = message.action.call.arguments;
    if (typeof args === "object" && args !== null && "path" in args) args.path = "outside.txt";
  }
  context.messages.length = 0;
  context.tools[0]!.name = "changed";
  assert.deepEqual(state, sampleState());
  assert.equal(tools[0]!.name, "read_text");
});

test("the context adapter snapshots tools and forwards the current cancellation signal", async () => {
  const state = sampleState();
  const tools = [{ name: "read_text", description: "Read" }];
  const controller = new AbortController();
  const decide = createContextDecision(tools, async (context, signal) => {
    assert.equal(signal, controller.signal);
    assert.equal(context.tools[0]!.name, "read_text");
    assert.deepEqual(Object.keys(context).sort(), ["messages", "tools"]);
    assert.equal(context.messages.at(-1)?.role, "tool");
    return { kind: "finish", answer: "name" };
  });
  tools[0]!.name = "changed";
  assert.deepEqual(await decide(state, controller.signal), { kind: "finish", answer: "name" });
});

test("an adapter receives new messages on each decision and preserves failed results", async () => {
  const dependencies = fixture(null);
  const roles: string[][] = [];
  dependencies.decide = createContextDecision([], async (context) => {
    roles.push(context.messages.map((message) => message.role));
    const last = context.messages.at(-1);
    if (last?.role === "tool" && last.result.status === "error") {
      return { kind: "fail", reason: last.result.message };
    }
    return { kind: "tool", call: { id: "read-1", name: "read_text", arguments: { path: "project-name.txt" } } };
  });
  const result = await runAgentLoop(task, dependencies, 3);
  assert.equal(result.outcome.status, "failed");
  assert.deepEqual(roles, [["user"], ["user", "assistant", "tool"]]);
});

test("a cancelled tool cannot append a late message", async () => {
  const controller = new AbortController();
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const dependencies = fixture();
  dependencies.executeToolCall = async (call) => {
    started();
    await held;
    return { callId: call.id, toolName: call.name, status: "ok", value: "name" };
  };
  const running = runAgentLoop(task, dependencies, 3, { signal: controller.signal });
  await ready;
  controller.abort();
  const result = await running;
  const snapshot = structuredClone(result.state.messages);
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(result.outcome.status, "cancelled");
  assert.deepEqual(result.state.messages, snapshot);
  assert.deepEqual(result.state.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(result.state.observations.length, 0);
});
