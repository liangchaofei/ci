import type { State } from "./types.ts";
import type { SessionRecord } from "./session-types.ts";
import { assertJsonData } from "./json-data.ts";
import { toolCallsOf } from "./action-tools.ts";
import { validateToolBatch } from "./tool-batch.ts";


function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected session object");
  return value as Record<string, unknown>;
}

function text(value: unknown): asserts value is string {
  if (typeof value !== "string") throw new Error("Expected session text");
}

function checkCall(value: unknown): void {
  const call = object(value);
  text(call.id);
  text(call.name);
  object(call.arguments);
  if (!call.id.trim() || !call.name.trim()) throw new Error("Invalid saved tool identity");
}


function checkAction(value: unknown): void {
  const action = object(value);
  if (action.content !== undefined && action.content !== null) text(action.content);

  if (action.kind === "tool") { checkCall(action.call); return; }
  if (action.kind === "tools") {
    if (!Array.isArray(action.calls)) throw new Error("Expected saved tool batch");
    action.calls.forEach(checkCall);
    return;
  }
  if (action.kind === "finish") { text(action.answer); return; }
  if (action.kind === "fail") { text(action.reason); return; }
  throw new Error("Unknown saved action kind");
}

function checkMessage(value: unknown): void {
  const message = object(value);
  if (message.role === "user") { text(message.content); return; }
  if (message.role === "assistant") { checkAction(message.action); return; }
  if (message.role !== "tool") throw new Error("Unknown saved message role");

  const result = object(message.result);
  text(result.callId);
  if (result.status === "ok" && "value" in result) return;
  if (result.status !== "error" || (typeof result.code !== "string" || !["unknown-tool", "invalid-arguments", "tool-error", "permission-denied"].includes(result.code))) {
    throw new Error("Invalid saved tool result");
  }
  text(result.message);
}

/** 核对请求与结果的关系；允许日志记录末尾尚未完成的批次，但不允许中间缺项。 */
function checkHistory(state: State): boolean {
  const seen = new Set<string>();
  const pending = new Set<string>();

  for (const message of state.messages) {
    if (message.role === "tool") {
      if (!pending.delete(message.result.callId)) throw new Error("Saved tool result has no matching request");
      continue;
    }
    if (pending.size > 0) throw new Error("Saved history interrupts a tool batch");
    if (message.role !== "assistant") continue;

    const calls = toolCallsOf(message.action);
    if (calls.length > 0 || message.action.kind === "tools") {
      validateToolBatch(calls, seen);
      for (const call of calls) { seen.add(call.id); pending.add(call.id); }
    }
  }

  return pending.size > 0;
}

function checkOutcome(value: unknown): void {
  const outcome = object(value);
  text(outcome.status);
  if (["paused", "cancelled", "timed-out", "budget-exhausted"].includes(outcome.status)) return;
  if (outcome.status === "completed") { text(outcome.answer); return; }
  if (outcome.status === "context-limit") { text(outcome.reason); return; }
  if (outcome.status === "failed") {
    text(outcome.reason);
    text(outcome.source);
    if (!["decision", "execution", "validation"].includes(outcome.source)) throw new Error("Invalid saved failure source");
    return;
  }
  throw new Error("Unknown saved outcome");
}

function checkResult(value: unknown): void {
  const result = object(value);
  const state = object(result.state);
  text(state.goal);
  if (!Array.isArray(state.messages)) throw new Error("Expected saved messages");
  state.messages.forEach(checkMessage);
  const first = object(state.messages[0]);
  if (first.role !== "user" || first.content !== state.goal) throw new Error("Saved original request mismatch");

  const recorded = state.messages.filter((item) => object(item).role === "assistant").length;
  if (!Number.isSafeInteger(state.decisions) || state.decisions !== recorded) throw new Error("Invalid saved decision count");
  checkOutcome(result.outcome);

  // 形状检查已完成后才用内部类型核对交互关系，不把类型断言当作校验。
  const pending = checkHistory(state as State);
  const status = object(result.outcome).status;
  if (pending && (status === "completed" || status === "paused")) {
    throw new Error("Completed or paused state cannot contain an unfinished tool batch");
  }
}


/** 文件系统会话名称，不允许路径分隔符或点号形成目录跳转。 */
export function checkSessionId(sessionId: string): void {
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) throw new Error("Invalid sessionId");
}

/** 同时用于写入前校验与从磁盘读回后的校验。 */
export function parseSessionRecord(value: unknown): SessionRecord {
  assertJsonData(value);
  const record = object(value);
  if (record.version !== 1) throw new Error("Unsupported session version");
  text(record.sessionId);
  checkSessionId(record.sessionId);
  text(record.runId);
  if (!record.runId.trim()) throw new Error("Invalid saved runId");
  if (!Number.isSafeInteger(record.seq) || Number(record.seq) < 1) throw new Error("Invalid session sequence");
  checkResult(record.result);
  return value as SessionRecord;
}

export function encodeSessionRecord(record: SessionRecord): string {
  return JSON.stringify(parseSessionRecord(record));
}