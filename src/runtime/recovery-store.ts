import { join } from "node:path";
import type { SessionStore } from "./session-store.ts";
import { assertJsonData } from "./json-data.ts";
import { createSessionStore } from "./session-store.ts";
import { replaceTextFile } from "./atomic-text-file.ts";
import { parseEnvironment, parseRecoveryBoundary, recordDigest, sameEnvironment } from "./recovery-codec.ts";
import type { RecoveryBoundary, RecoveryEnvironment, RecoveryStore } from "./recovery-types.ts";
import type { Dependencies, RunResult } from "./types.ts";
import type { SessionRecord } from "./session-types.ts";


/** 封装同一份写入状态；外部通过工厂取得，不直接修改边界标记。 */
class RecoveryWriter implements RecoveryStore {
  readonly directory: string;
  private readonly store: SessionStore;
  private readonly inspectEnvironment: () => Promise<RecoveryEnvironment>;
  private readonly path: string;
  private boundary: RecoveryBoundary;
  private tail: Promise<void> = Promise.resolve();
  private sequence = 0;
  private active = false;
  private poisoned = false;
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(store: SessionStore, sessionId: string, environment: RecoveryEnvironment, inspect: () => Promise<RecoveryEnvironment>) {
    this.directory = store.directory;
    this.store = store;
    this.inspectEnvironment = inspect;
    this.path = join(store.directory, "recovery.json");
    this.boundary = { version: 1, sessionId, phase: "open", environment, intents: [], receipt: null };
  }

  async initialize(): Promise<void> {
  await this.persist(this.boundary);
}

private async persist(next: RecoveryBoundary): Promise<void> {
  const checked = parseRecoveryBoundary(next);
  await replaceTextFile(this.path, JSON.stringify(checked) + "\n");
  this.boundary = checked;
}

private enqueue(work: () => Promise<void>): Promise<void> {
  if (this.closed) return Promise.reject(new Error("Recovery store is closed"));
  const operation = this.tail.then(async () => {
    if (this.poisoned) throw new Error("Recovery store requires inspection");
    try { await work(); }
    catch (error) { this.poisoned = true; throw error; }
  });
  this.tail = operation.then(() => {}, () => {});
  return operation;
}

begin(): Promise<void> {
  return this.enqueue(async () => {
    if (this.active) throw new Error("A segment is already active");
    if (this.sequence > 0 && this.boundary.phase !== "sealed") throw new Error("Previous segment requires inspection");
    const current = parseEnvironment(await this.inspectEnvironment());
    if (!sameEnvironment(this.boundary.environment, current)) throw new Error("Environment changed before segment start");

    // 必须先使旧的 sealed 失效，再允许本段循环启动。
    await this.persist({ ...this.boundary, phase: "open", intents: [], receipt: null });
    this.active = true;
  });
}

wrap(execute: Dependencies["executeTool"]): Dependencies["executeTool"] {
  return async (call, signal) => {
    signal.throwIfAborted();
    const intent = { id: call.id, name: call.name };
    await this.enqueue(async () => {
      if (!this.active) throw new Error("No active segment");
      const current = parseEnvironment(await this.inspectEnvironment());
      if (current.workspaceId !== this.boundary.environment.workspaceId || !current.allowedTools.includes(intent.name)) {
        throw new Error("Tool is not allowed in the current workspace grant");
      }
      if (this.boundary.intents.some((item) => item.id === intent.id)) throw new Error("Repeated intent identity");

      // 每个请求都先写意图；普通并发调用也不能相互覆盖这份清单。
      await this.persist({ ...this.boundary, intents: [...this.boundary.intents, intent] });
    });

    // 存盘期间也可能取消；不能存完意图后无条件启动工具。
    signal.throwIfAborted();
    return execute(call, signal);
  };
}


save(runId: string, result: Readonly<RunResult>): Promise<void> {
  assertJsonData(result);
  const snapshot = structuredClone(result);
  return this.enqueue(async () => {
    if (!this.active) throw new Error("No active segment to save");
    await this.store.save(runId, snapshot);
    this.sequence += 1;
    this.active = false;

    // 结果已写入日志，才能把本段执行意图与这份结果逐项对照。
    const confirmed = new Set(snapshot.state.messages.flatMap((message) =>
      message.role === "tool" && message.result.status === "ok" ? [message.result.callId] : []));
    if (!this.boundary.intents.every((intent) => confirmed.has(intent.id))) return;

    const current = parseEnvironment(await this.inspectEnvironment());
    if (!sameEnvironment(this.boundary.environment, current)) return;
    const record: SessionRecord = { version: 1, sessionId: this.boundary.sessionId, seq: this.sequence, runId, result: snapshot };
    await this.persist({ ...this.boundary, phase: "sealed", receipt: { seq: this.sequence, runId, digest: recordDigest(record) } });
  });
}

  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.closing = this.tail.then(() => this.store.close());
    }
    return this.closing;
  }
}


/** 仍只创建新目录；旧会话由只读门禁检查，不在这里重新打开写入。 */
export async function createRecoveryStore(
  base: string,
  sessionId: string,
  inspectEnvironment: () => Promise<RecoveryEnvironment>,
  expected: RecoveryEnvironment,
): Promise<RecoveryStore> {
  const environment = parseEnvironment(expected);
  const store = await createSessionStore(base, sessionId);
  const writer = new RecoveryWriter(store, sessionId, environment, inspectEnvironment);

  try { await writer.initialize(); }
  catch (error) { await store.close(); throw error; }
  return writer;
}