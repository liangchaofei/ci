# ci
使用nodejs开发的agent harness框架

## Usage

The harness is provider-agnostic: pass a model adapter and tool implementations.
The adapter receives the conversation, tool definitions, and optional abort signal,
and returns `{ content, toolCalls }`. Tool calls use
`{ id, name, arguments }`, where `arguments` may be an object or JSON string.

```js
import { AgentHarness } from "node-agent-harness";

const agent = new AgentHarness({
  model: async ({ messages, tools, signal }) => {
    // Call your preferred model provider and map its response to this interface.
    return { content: "Hello!", toolCalls: [] };
  },
  tools: {
    getTime: {
      description: "Get the current time",
      parameters: { type: "object", properties: {} },
      execute: () => new Date().toISOString(),
    },
  },
});

const result = await agent.run({ input: "What time is it?" });
console.log(result.content);
```

`run` returns the final content, conversation messages, model-call count, and a
`finishReason` (`stop` or `max_steps`). A run can be cancelled with an
`AbortSignal`. Execute tests with `npm test`.
