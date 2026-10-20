import { collectDeepSeekAction } from "../adapters/deepseek/stream-protocol.ts";
import { toolCallsOf } from "../runtime/action-tools.ts";

/** 故意让 index 1 先到，只检查多调用草稿，不访问网络或执行工具。 */
async function* events(): AsyncGenerator<string> {
  const deltas = [
    {
      tool_calls: [{
        index: 1,
        id: "tests-1",
        type: "function",
        function: { name: "read_tests", arguments: '{"path":' },
      }],
    },
    {
      tool_calls: [{
        index: 0,
        id: "source-1",
        type: "function",
        function: { name: "read_source", arguments: '{"path":' },
      }],
    },
    { tool_calls: [{ index: 1, function: { arguments: '"test/sum.test.ts"}' } }] },
    { tool_calls: [{ index: 0, function: { arguments: '"src/sum.ts"}' } }] },
  ];

  for (const delta of deltas) {
    yield JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] });
  }
  yield JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  yield "[DONE]";
}

const action = await collectDeepSeekAction(events(), new AbortController().signal, (event) => {
  if (event.type === "tool-arguments-delta") {
    console.log(`参数片段（index=${event.index}）: ${JSON.stringify(event.delta)}`);
  }
});
console.log(`动作类型（kind）: ${action.kind}`);
for (const call of toolCallsOf(action)) {
  console.log(`完整调用（call）: ${call.id} -> ${JSON.stringify(call.arguments)}`);
}