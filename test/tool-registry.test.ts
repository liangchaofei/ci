import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolRegistry } from "../src/runtime/tool-registry.ts";
import { createTextTools } from "../src/tools/text-tools.ts";

const signal = () => new AbortController().signal;
test("one registry executes two different tools", async () => {
  const registry = createTextTools(new Map([["name.txt", "hello"]]));
  const read = await registry.execute({ id: "1", name: "read_text", arguments: { path: "name.txt" } }, signal());
  const count = await registry.execute({ id: "2", name: "text_length", arguments: { text: "hello" } }, signal());
  assert.deepEqual(read, { callId: "1", toolName: "read_text", status: "ok", value: "hello" });
  assert.deepEqual(count, { callId: "2", toolName: "text_length", status: "ok", value: 5 });
});
test("invalid arguments never reach execute", async () => {
  let calls = 0;
  const registry = new ToolRegistry();
  registry.register({ name: "checked", description: "test", parse: () => { throw new Error("Bad input"); },
    execute: async () => { calls += 1; return "unexpected"; } });
  const result = await registry.execute({ id: "1", name: "checked", arguments: 42 }, signal());
  assert.equal(result.status, "error");
  if (result.status === "error") assert.equal(result.code, "invalid-arguments");
  assert.equal(calls, 0);
});
test("unknown tools return structured errors", async () => {
  const result = await new ToolRegistry().execute({ id: "1", name: "missing", arguments: {} }, signal());
  assert.deepEqual(result, { callId: "1", toolName: "missing", status: "error", code: "unknown-tool", message: "Tool not registered" });
});
test("tool exceptions become execution-failed observations", async () => {
  const registry = new ToolRegistry();
  registry.register({ name: "broken", description: "test", parse: () => null,
    execute: async () => { throw new Error("Tool failed"); } });
  const result = await registry.execute({ id: "1", name: "broken", arguments: {} }, signal());
  assert.equal(result.status, "error");
  if (result.status === "error") assert.equal(result.code, "execution-failed");
});
test("duplicate tool names are rejected", () => {
  const registry = createTextTools(new Map());
  assert.throws(() => registry.register({ name: "read_text", description: "test", parse: () => null,
    execute: async () => null }), /Duplicate tool name/);
});
test("tool cancellation is not converted into an ordinary error", async () => {
  const controller = new AbortController();
  const reason = new Error("Stop request");
  const registry = new ToolRegistry();
  registry.register({ name: "cancel", description: "test", parse: () => null,
    execute: async () => { controller.abort(reason); return "late"; } });
  await assert.rejects(registry.execute({ id: "1", name: "cancel", arguments: {} }, controller.signal),
    (error) => error === reason);
});
