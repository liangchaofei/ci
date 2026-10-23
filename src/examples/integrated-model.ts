import { batchCalls } from "./batch-fixture.ts";
import { diagnosis } from "./diagnosis-fixture.ts";


/** 只替代远端 HTTP 服务；JSON 解码、重试、记账仍走正式适配器。 */
export function createIntegratedModel(earlyFinish = false) {
  let attempts = 0;

  const send: typeof fetch = async (_url, init) => {
    attempts += 1;

    // 每个新服务替身先返回 503，确认重试也经过同一预算和观察入口。
    if (attempts === 1)
      return new Response("busy", {
        status: 503,
        headers: { "retry-after": "0" },
      });

    const body = JSON.parse(String(init?.body));
    if (!Array.isArray(body.messages)) throw new Error("Missing model messages");
    const hasObservation = body.messages.some(
      (message: { role?: string }) => message.role === "tool",
    );

    // 读取结果已经反馈，才提出答案；earlyFinish 专门制造无证据完成。
    const finish = earlyFinish || hasObservation;
    const message = finish
      ? {
          role: "assistant",
          content: diagnosis,
        }
      : {
          role: "assistant",
          content: null,
          tool_calls: batchCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: call.name,
              arguments: JSON.stringify(call.arguments),
            },
          })),
        };

    return Response.json({
      choices: [
        {
          finish_reason: finish ? "stop" : "tool_calls",
          message,
        },
      ],
      usage: {
        prompt_tokens: 20,
        completion_tokens: 10,
        total_tokens: 30,
      },
    });
  };

  return {
    send,
    count: () => attempts,
  };
}