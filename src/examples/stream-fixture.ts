/** 人工响应只复现分片，不调用模型。每次使用都创建独立的流。 */
export function createToolStream(complete: boolean): ReadableStream<Uint8Array> {
  // 三个模型增量：文字、第一片参数、第二片参数。
  const chunks = [
    { content: "先查看源码。", role: "assistant" },
    {
      tool_calls: [{
        index: 0,
        id: "call_stream",
        type: "function",
        function: {
          name: "read_source",
          arguments: '{"path":'
        }
      }]
    },
    { tool_calls: [{ index: 0, function: { arguments: '"src/sum.ts"}' } }] },
  ];

  // 为增量补上事件结构；断流模式故意不提供正常结束部分。
  const frames: unknown[] = chunks.map((delta) => ({
    choices: [{ index: 0, delta, finish_reason: null }],
  }));

  if (complete) {
    frames.push({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  }

  // 先组成 SSE 文本，再按任意字节边界切开，模拟网络读取。
  const wire = frames.map((frame) => `data: ${JSON.stringify(frame)}\r\n\r\n`).join("") +
    (complete ? "data: [DONE]\r\n\r\n" : "");
  const bytes = new TextEncoder().encode(wire);

  return new ReadableStream<Uint8Array>({
    start(controller) {
      // 字节切分故意不对齐字符、JSON 或事件边界。
      for (let offset = 0; offset < bytes.length; offset += 7) {
        controller.enqueue(bytes.slice(offset, offset + 7));
      }

      controller.close();
    },
  });
}