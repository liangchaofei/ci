// #region imports
import { createHash } from "node:crypto";
import { assertJsonData } from "./json-data.ts";
import { checkSessionId, encodeSessionRecord } from "./session-codec.ts";
import type { SessionRecord } from "./session-types.ts";
import type { RecoveryBoundary, RecoveryEnvironment } from "./recovery-types.ts";
// #endregion imports

// #region environment
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected recovery object");
  return value as Record<string, unknown>;
}

function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new Error("Expected non-empty recovery string");
}

/** 排序使工具清单的顺序不影响比较，重复项则直接拒绝。 */
export function parseEnvironment(value: unknown): RecoveryEnvironment {
  assertJsonData(value);
  const data = object(value);
  text(data.workspaceId);
  text(data.revision);
  if (!Array.isArray(data.allowedTools)) throw new Error("Expected allowed tools");

  const names = data.allowedTools.map((name: unknown) => { text(name); return name; });
  if (new Set(names).size !== names.length) throw new Error("Duplicate allowed tool");
  return { workspaceId: data.workspaceId, revision: data.revision, allowedTools: names.sort() };
}

export function sameEnvironment(left: RecoveryEnvironment, right: RecoveryEnvironment): boolean {
  return JSON.stringify(parseEnvironment(left)) === JSON.stringify(parseEnvironment(right));
}

/** 摘要只绑定两份本地记录的一致性，不提供签名或防篡改认证。 */
export function recordDigest(record: SessionRecord): string {
  return createHash("sha256").update(encodeSessionRecord(record)).digest("hex");
}
// #endregion environment

// #region boundary
export function parseRecoveryBoundary(value: unknown): RecoveryBoundary {
  assertJsonData(value);
  const data = object(value);
  if (data.version !== 1 || (data.phase !== "open" && data.phase !== "sealed")) {
    throw new Error("Unknown recovery boundary format");
  }
  text(data.sessionId);
  checkSessionId(data.sessionId);
  if (!Array.isArray(data.intents)) throw new Error("Expected execution intents");

  const ids = new Set<string>();
  const intents = data.intents.map((item: unknown) => {
    const intent = object(item);
    text(intent.id);
    text(intent.name);
    if (ids.has(intent.id)) throw new Error("Duplicate execution intent");
    ids.add(intent.id);
    return { id: intent.id, name: intent.name };
  });

  let receipt: RecoveryBoundary["receipt"] = null;
  if (data.receipt !== null) {
    const saved = object(data.receipt);
    if (!Number.isSafeInteger(saved.seq) || (saved.seq as number) < 1) throw new Error("Invalid receipt sequence");
    text(saved.runId);
    text(saved.digest);
    if (!/^[a-f0-9]{64}$/.test(saved.digest)) throw new Error("Invalid receipt digest");
    receipt = { seq: saved.seq as number, runId: saved.runId, digest: saved.digest };
  }
  if ((data.phase === "sealed") !== (receipt !== null)) throw new Error("Boundary phase and receipt disagree");

  return {
    version: 1, sessionId: data.sessionId, phase: data.phase,
    environment: parseEnvironment(data.environment), intents, receipt,
  };
}
// #endregion boundary
