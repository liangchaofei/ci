import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadSession } from "./session-reader.ts";
import { checkSessionId } from "./session-codec.ts";
import { parseEnvironment, parseRecoveryBoundary, recordDigest, sameEnvironment } from "./recovery-codec.ts";
import type { RecoveryDecision, RecoveryEnvironment } from "./recovery-types.ts";

/** 只给出允许或阻止的结论；不调用工具、不创建实例，也不改旧会话。 */
export async function inspectRecovery(base: string, sessionId: string, current: RecoveryEnvironment): Promise<RecoveryDecision> {
  checkSessionId(sessionId);
  const environment = parseEnvironment(current);
  const blocked = (reason: string): RecoveryDecision => ({ status: "blocked", reason, intents: [] });

  try {
    const bytes = await readFile(join(base, sessionId, "recovery.json"));
    const boundary = parseRecoveryBoundary(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (boundary.sessionId !== sessionId) return blocked("Recovery session identity mismatch");

    // 先检查开始标记：即使尚无一条完整运行日志，也能看见未确认的调用身份。
    if (boundary.phase === "open") {
      return { status: "blocked", reason: "Segment has no sealed result; inspect possible effects", intents: boundary.intents };
    }

    const loaded = await loadSession(base, sessionId);
    const latest = loaded.latest;
    if (!latest || loaded.ignoredTail || loaded.checkpointStatus !== "matches") {
      return blocked("Journal is empty, incomplete, or checkpoint does not match");
    }
    const receipt = boundary.receipt!;
    if (receipt.seq !== latest.seq || receipt.runId !== latest.runId || receipt.digest !== recordDigest(latest)) {
      return blocked("Recovery receipt does not match the latest saved result");
    }
    if (latest.result.outcome.status !== "paused") return blocked("Only a paused result can be resumed here");
    if (!sameEnvironment(boundary.environment, environment)) return blocked("Workspace revision or current tool grant changed");

    return { status: "ready", result: structuredClone(latest.result), environment };
  } catch (error) {
    return blocked(`Cannot establish recovery evidence: ${error instanceof Error ? error.message : String(error)}`);
  }
}
