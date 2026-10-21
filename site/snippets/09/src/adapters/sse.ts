// #region lines
const maxBufferedCharacters = 1_000_000;

/** 按 UTF-8 解码，再按 CR、LF 或 CRLF 交出完整行；尾部半行不提交。 */
async function* readLines(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  signal.throwIfAborted();

  // 解码器跨读取复用，才能保留落在两个字节块之间的半个字符。
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });

  // 行缓冲与换行状态都要跨字节块保留。
  let line = "";
  let afterCR = false;

  // 停止信号到达时，唤醒可能仍在等待的 reader.read。
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();

      const text = done ? decoder.decode() : decoder.decode(value, { stream: true });

      for (const character of text) {
        // CR 已结束上一行；紧随的 LF 不能再制造一个空行。
        if (afterCR) {
          afterCR = false;
          if (character === "\n") continue;
        }

        // 只交出完整行，剩余字符留待下一次读取。
        if (character === "\r" || character === "\n") {
          yield line;
          line = "";
          afterCR = character === "\r";
        } else {
          line += character;
          if (line.length > maxBufferedCharacters) throw new Error("SSE line is too large");
        }
      }

      if (done) return;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);

    // 提前退出也关闭底层读取；清理错误不覆盖原始失败原因。
    try {
      await reader.cancel();
    } catch {}
    reader.releaseLock();
  }
}
// #endregion lines

// #region data
/** 只提取 SSE 的 data；不实现 EventSource 自动重连、id 或 retry。 */
export async function* readSseData(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  let data: string[] = [];
  let size = 0;

  for await (const line of readLines(body, signal)) {
    signal.throwIfAborted();

    // 空行才结束一条事件，先交出当前 data，再开始收集下一条。
    if (line === "") {
      if (data.length > 0) yield data.join("\n");
      data = [];
      size = 0;
      continue;
    }

    // 注释行不携带模型数据，其余行按第一个冒号拆分。
    if (line.startsWith(":")) continue;

    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field !== "data") continue;

    // 多个 data 行属于同一事件，限制的是整条事件的暂存长度。
    size += value.length + 1;
    if (size > maxBufferedCharacters) throw new Error("SSE event is too large");
    data.push(value);
  }

  // 没有空行结束的事件保持未提交，不能因 EOF 强行补齐。
}
// #endregion data
