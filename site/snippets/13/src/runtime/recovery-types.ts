import type { RunResult, Dependencies } from "./types.ts";
import type { ResultSink } from "./result-sink.ts";

/** 由应用检查当前资源和当前授权；不是从旧会话恢复权限。 */
export type RecoveryEnvironment = {
  workspaceId: string;
  revision: string;
  allowedTools: string[];
};

export type ExecutionIntent = { id: string; name: string };
export type RecoveryBoundary = {
  version: 1;
  sessionId: string;
  phase: "open" | "sealed";
  environment: RecoveryEnvironment;
  intents: ExecutionIntent[];
  receipt: { seq: number; runId: string; digest: string } | null;
};

export type RecoveryDecision =
  | { status: "ready"; result: RunResult; environment: RecoveryEnvironment }
  | { status: "blocked"; reason: string; intents: ExecutionIntent[] };

export type RecoveryStore = ResultSink & {
  begin: () => Promise<void>;
  wrap: (execute: Dependencies["executeTool"]) => Dependencies["executeTool"];
  directory: string;
  close: () => Promise<void>;
};
