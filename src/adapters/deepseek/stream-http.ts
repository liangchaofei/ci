import { readSseData } from "../sse.ts";

/** 流式 HTTP 只交出完整 SSE data，不拼 Action，也不写 State。 */
export async function* requestDeepSeekEvents(
  apiKey: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  signal.throwIfAborted();
  if (!apiKey.trim()) throw new Error("DEEPSEEK_API_KEY is required");

  // 请求体仍是 JSON，但期望服务返回 SSE；signal 同时控制网络等待。
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`DeepSeek HTTP ${response.status}`);
  }

  // HTTP 成功还不够，普通 JSON 响应不能当作 SSE 字节流读取。
  const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "text/event-stream" || !response.body) {
    await response.body?.cancel();
    throw new Error("Expected an SSE response body");
  }

  // 直接转交完整事件，不先积累整份响应，也不在传输层形成 Action。
  yield* readSseData(response.body, signal);
}