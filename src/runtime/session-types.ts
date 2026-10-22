import type { RunResult } from "./types.ts";

/** 每条日志保存一段运行的完整结束结果；version 是本项目文件格式版本。 */
export type SessionRecord = {
  version: 1;
  sessionId: string;
  seq: number;
  runId: string;
  result: RunResult;
};

export type CheckpointStatus = "matches" | "missing" | "stale" | "invalid";
export type LoadedSession = {
  records: SessionRecord[];
  latest: SessionRecord | undefined;
  ignoredTail: boolean;
  checkpointStatus: CheckpointStatus;
};