const maxBufferedCharacters = 1_000_000;

/** 按 UTF-8 解码，再按 CR、LF 或 CRLF 交出完整行；尾部半行不提交。 */
async function* readLines(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  signal.throwIfAborted();
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let line = "";
  let afterCR = false;
  const onAbort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      const text = done ? decoder.decode() : decoder.decode(value, { stream: true });
      for (const character of text) {
        if (afterCR) {
          afterCR = false;
          if (character === "\n") continue;
        }
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
    try { await reader.cancel(); } catch {}
    reader.releaseLock();
  }
}




/** 只提取 SSE 的 data；不实现 EventSource 自动重连、id 或 retry。 */
export async function* readSseData(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  let data: string[] = [];
  let size = 0;
  for await (const line of readLines(body, signal)) {
    signal.throwIfAborted();
    if (line === "") {
      if (data.length > 0) yield data.join("\n");
      data = [];
      size = 0;
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field !== "data") continue;
    size += value.length + 1;
    if (size > maxBufferedCharacters) throw new Error("SSE event is too large");
    data.push(value);
  }
  // 没有空行结束的事件保持未提交，不能因 EOF 强行补齐。
}