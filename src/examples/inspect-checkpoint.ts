import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { replaceTextFile } from "../runtime/atomic-text-file.ts";
import type { SessionRecord } from "../runtime/session-types.ts";

const directory = process.argv[2] ?? ".agent-data";
await mkdir(directory, { recursive: true });
const path = join(directory, "checkpoint-probe.json");
const record: SessionRecord = {
  version: 1,
  sessionId: "probe",
  seq: 1,
  runId: "probe-run",
  result: {
    state: { goal: "诊断空数组报错", messages: [{ role: "user", content: "诊断空数组报错" }], decisions: 0 },
    outcome: { status: "paused" },
  },
};

// 本例只检查文本往返；尚未把外部 JSON 当成可信 State。
await replaceTextFile(path, JSON.stringify(record) + "\n");
const text = await readFile(path, "utf8");
console.log(`检查点文件（file）: ${path}`);
console.log(`磁盘文本（text）: ${text.trim()}`);