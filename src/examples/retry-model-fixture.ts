import { diagnosis } from "./diagnosis-fixture.ts";

/** 替代远端 HTTP 服务；第一次 503，之后按输入交回固定模型响应。 */
export function createRetryModelFixture() {
  let requests = 0;
  const send: typeof fetch = async (_url, init) => {
    requests += 1;
    console.log(`[模拟模型 HTTP 请求] ${requests}`);
    if (requests === 1) return new Response("busy", { status: 503, headers: { "retry-after": "0" } });

    const body = JSON.parse(String(init?.body));
    const last = body.messages.at(-1);
    if (last?.role === "user") {
      return Response.json({ choices: [{ finish_reason: "tool_calls", message: {
        role: "assistant", content: null, tool_calls: [{ id: "read-1", type: "function",
          function: { name: "read_source", arguments: JSON.stringify({ path: "sum.ts" }) } }],
      } }] });
    }
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: diagnosis } }] });
  };
  return { send, count: () => requests };
}