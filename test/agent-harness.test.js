import test from "node:test";
import assert from "node:assert/strict";
import { AgentHarness } from "../src/index.js";

test("returns a model response when no tools are requested", async () => {
  const harness = new AgentHarness({
    model: async ({ messages }) => {
      assert.equal(messages.at(-1).content, "Hello");
      return { content: "Hi!" };
    },
  });

  const result = await harness.run({ input: "Hello" });

  assert.equal(result.content, "Hi!");
  assert.equal(result.finishReason, "stop");
  assert.equal(result.steps, 1);
});

test("executes tools and returns their results to the model", async () => {
  let calls = 0;
  const harness = new AgentHarness({
    tools: {
      add: {
        description: "Add two numbers",
        parameters: { type: "object" },
        execute: ({ a, b }) => a + b,
      },
    },
    model: async ({ messages, tools }) => {
      calls += 1;
      assert.equal(tools[0].name, "add");
      if (calls === 1) {
        return {
          content: null,
          toolCalls: [{ id: "call-1", name: "add", arguments: '{"a":2,"b":3}' }],
        };
      }
      assert.equal(messages.at(-1).content, "5");
      return { content: "The answer is 5." };
    },
  });

  const result = await harness.run({ input: "What is 2 + 3?" });

  assert.equal(result.content, "The answer is 5.");
  assert.equal(result.steps, 2);
  assert.equal(result.messages.at(-1).role, "assistant");
});

test("returns max_steps when the model keeps requesting tools", async () => {
  const harness = new AgentHarness({
    maxSteps: 1,
    tools: { noop: { execute: () => "done" } },
    model: async () => ({
      content: null,
      toolCalls: [{ id: "call-1", name: "noop" }],
    }),
  });

  const result = await harness.run({ input: "Continue" });

  assert.equal(result.finishReason, "max_steps");
  assert.equal(result.steps, 1);
});

test("reports tool errors to the model", async () => {
  let calls = 0;
  const harness = new AgentHarness({
    model: async ({ messages }) => {
      calls += 1;
      if (calls === 1) {
        return { toolCalls: [{ id: "call-1", name: "missing" }] };
      }
      assert.equal(messages.at(-1).isError, true);
      assert.match(messages.at(-1).content, /Unknown tool: missing/);
      return { content: "Recovered" };
    },
  });

  const result = await harness.run({ input: "Try the tool" });

  assert.equal(result.content, "Recovered");
});

test("rejects invalid configuration and empty runs", async () => {
  assert.throws(() => new AgentHarness({ model: "not a function" }), TypeError);
  assert.throws(() => new AgentHarness({ model: () => {}, maxSteps: 0 }), RangeError);

  const harness = new AgentHarness({ model: async () => ({ content: "ok" }) });
  await assert.rejects(harness.run(), /requires input or at least one message/);
});
