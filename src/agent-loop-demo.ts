import { runAgentLoop } from "./runtime/agent-loop.ts";
import type { Dependencies } from "./runtime/types.ts";

// 所有内容都在内存中，路径只是 Map 的键，不会访问磁盘。
const files = new Map<string, string>([
  ["project-name.txt", "CI Agent Harness"],
]);

const dependencies: Dependencies = {
  decide: async (state) => {
    const observation = state.observation;
    if (observation === null) return { kind: "read", path: state.targetPath };
    if (observation.kind === "read-failed") {
      return { kind: "fail", reason: observation.reason };
    }
    return { kind: "finish", answer: observation.content };
  },
  executeRead: async (action) => {
    const content = files.get(action.path);
    return content === undefined
      ? { kind: "read-failed", path: action.path, reason: "File not found" }
      : { kind: "read-ok", path: action.path, content };
  },
};

// 改变命令行参数即可观察文件缺失路径，无需修改循环。
const targetPath = process.argv[2] ?? "project-name.txt";
const result = await runAgentLoop({ targetPath }, dependencies, 3);

for (const event of result.events) {
  if (event.kind === "decision") {
    console.log(`decision ${event.index}: ${event.action.kind}`);
  } else {
    console.log(`observation: ${event.observation.kind}`);
  }
}
console.log(`outcome: ${result.outcome.status}`);
if (result.outcome.status === "completed") {
  console.log(`answer: ${result.outcome.answer}`);
} else if (result.outcome.status === "failed") {
  console.log(`reason: ${result.outcome.reason}`);
}