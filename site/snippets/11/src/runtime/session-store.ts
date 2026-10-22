import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import type { RunResult } from "./types.ts";
import type { ResultSink } from "./result-sink.ts";
import type { SessionRecord } from "./session-types.ts";
import { checkSessionId, encodeSessionRecord } from "./session-codec.ts";
import { replaceTextFile } from "./atomic-text-file.ts";
import { assertJsonData } from "./json-data.ts";

export type SessionStore = ResultSink & {
  directory: string;
  close: () => Promise<void>;
};

// #region store
/** 每个会话只创建一次，由当前进程单独写；本篇不重开旧会话继续追加。 */
export async function createSessionStore(base: string, sessionId: string): Promise<SessionStore> {
  checkSessionId(sessionId);
  await mkdir(base, { recursive: true });
  const directory = join(base, sessionId);
  await mkdir(directory);
  const handle = await open(join(directory, "journal.jsonl"), "ax", 0o600);
  let sequence = 0;
  let closed = false;
  let poisoned = false;
  let closing: Promise<void> | undefined;
  let tail: Promise<void> = Promise.resolve();

  async function save(runId: string, result: Readonly<RunResult>): Promise<void> {
    if (closed) throw new Error("Session store is closed");
    // 先检查原值，避免复制时访问 getter 或静默丢掉不可保存的属性。
    assertJsonData(result);

    // 排队前复制，之后调用方改变返回结果也不改变本次待写内容。
    const snapshot = structuredClone(result);

    const operation = tail.then(async () => {
      if (poisoned) throw new Error("Session store requires inspection after a failed write");
      try {
        // #region commit
        const record: SessionRecord = { version: 1, sessionId, seq: sequence + 1, runId, result: snapshot };
        const text = encodeSessionRecord(record) + "\n";

        // 日志是依据：先追加并同步，再更新最新检查点副本。
        await handle.appendFile(text, "utf8");
        await handle.sync();
        sequence = record.seq;
        await replaceTextFile(join(directory, "checkpoint.json"), text);
        // #endregion commit
      } catch (error) {
        // 可能已经写入部分数据，不自动重试或让后续写入掩盖这次故障。
        poisoned = true;
        throw error;
      }
    });

    // 即使前一次失败，也接住链上的拒绝；下一项会在内部被 poisoned 拒绝。
    // #region chain
    tail = operation.then(() => {}, () => {});
    return operation;
    // #endregion chain
  }

  function close(): Promise<void> {
    if (!closing) {
      closed = true;
      closing = tail.then(() => handle.close());
    }
    return closing;
  }

  return { directory, save, close };
}
// #endregion store
