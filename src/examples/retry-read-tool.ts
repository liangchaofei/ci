import { defineRetryingReadTool } from "../runtime/retrying-read-tool.ts";
import type { RetrySettings } from "../runtime/retry.ts";
import type { ExecutionPolicy } from "../runtime/authorization.ts";
import { createPermissionTools } from "./permission-workspace.ts";
import { runFileProcess } from "./file-process.ts";

/** 默认真实读取；注入 read 仅用于重现依赖临时失败，不绕过访问复核。 */
export function createRetryReadTool(
  root: string,
  getPolicy: () => ExecutionPolicy,
  settings: RetrySettings,
  read: (signal: AbortSignal) => Promise<unknown> = (signal) => runFileProcess(root, { kind: "read", path: "sum.ts" }, signal),
) {
  const tools = createPermissionTools(root);
  return defineRetryingReadTool({
    name: "read_source", description: "读取受限演示副本的源码与版本",
    parameters: { type: "object", properties: { path: { type: "string", enum: ["sum.ts"] } }, required: ["path"], additionalProperties: false },
    parse(input) {
      if (!input || typeof input !== "object" || !("path" in input) || input.path !== "sum.ts") {
        return { ok: false, message: "Only sum.ts is available" };
      }
      return { ok: true, value: { path: "sum.ts" as const } };
    },
    execute: (_args, signal) => read(signal),
  }, settings, async (args, signal) => {
    if (!getPolicy().allowedTools.includes("read_source")) throw new Error("Read permission revoked");
    await tools.inspect({ id: "access-check-only", name: "read_source", arguments: args }, signal);
  });
}