import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CheckpointStatus, LoadedSession, SessionRecord } from "./session-types.ts";
import { checkSessionId, encodeSessionRecord, parseSessionRecord } from "./session-codec.ts";

/** 只读扫描日志；完整行必须合法，未以换行结束的末尾不会假装写完。 */
export function decodeJournal(text: string, sessionId: string): { records: SessionRecord[]; ignoredTail: boolean } {
  checkSessionId(sessionId);
  const lastNewline = text.lastIndexOf("\n");
  const committed = text.slice(0, lastNewline + 1);
  const records: SessionRecord[] = [];

  for (const line of committed.split("\n").slice(0, -1)) {
    const record = parseSessionRecord(JSON.parse(line));
    if (record.sessionId !== sessionId || record.seq !== records.length + 1) {
      throw new Error("Session identity or sequence mismatch");
    }
    records.push(record);
  }

  return { records, ignoredTail: lastNewline + 1 < text.length };
}

/** 检查点是日志末项的副本；坏副本不能盖过仍有效的日志。 */
async function checkpointStatus(path: string, latest: SessionRecord | undefined): Promise<CheckpointStatus> {
  try {
    const bytes = await readFile(path);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const checkpoint = parseSessionRecord(JSON.parse(text));
    return latest && encodeSessionRecord(checkpoint) === encodeSessionRecord(latest) ? "matches" : "stale";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "missing";
    return "invalid";
  }
}

/** 返回已保存的数据，不调用模型、工具或 Agent.resume，也不修改磁盘。 */
export async function loadSession(base: string, sessionId: string): Promise<LoadedSession> {
  checkSessionId(sessionId);
  const directory = join(base, sessionId);
  const bytes = await readFile(join(directory, "journal.jsonl"));
  // 先按字节定位最后完整行，末尾半个 UTF-8 字符也不能破坏此前记录。
  const lastNewline = bytes.lastIndexOf(0x0a);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, lastNewline + 1));
  const decoded = decodeJournal(text, sessionId);
  decoded.ignoredTail = lastNewline + 1 < bytes.length;
  const latest = decoded.records.at(-1);

  return {
    ...decoded,
    latest,
    checkpointStatus: await checkpointStatus(join(directory, "checkpoint.json"), latest),
  };
}
