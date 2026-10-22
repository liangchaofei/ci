import { createAuthorizedExecutor } from "../runtime/authorization.ts";

let executions = 0;
const execute = createAuthorizedExecutor({
  getPolicy: () => ({ version: "probe-1", allowedTools: ["write_source"] }),
  inspect: async () => ({ effect: "write", version: "demo-version", summary: "模拟写入" }),
  approve: async () => false,
  execute: async (call) => {
    executions += 1;
    return { callId: call.id, status: "ok", value: "模拟执行" };
  },
  approvalMs: 1_000,
});

const result = await execute({ id: "probe-1", name: "write_source", arguments: {} }, new AbortController().signal);
console.log(`[工具观察] ${JSON.stringify(result)}`);
console.log(`[执行次数] ${executions}`);