import { readSseData } from "../adapters/sse.ts";

const bytes = new TextEncoder().encode("data: 你\r\ndata: 好\r\n\r\ndata: [DONE]\n\n");

const body = new ReadableStream<Uint8Array>({
  start(controller) {
    // 故意每两字节切一次，中文字符和换行都可能跨块。
    for (let offset = 0; offset < bytes.length; offset += 2) {
      controller.enqueue(bytes.slice(offset, offset + 2));
    }

    controller.close();
  },
});

// 取出的次数按完整事件计算，不按 enqueue 的字节块数量计算。
for await (const data of readSseData(body, new AbortController().signal)) {
  console.log(`完整事件（data）: ${JSON.stringify(data)}`);
}
