import { mkdtemp, mkdir, writeFile, readFile, lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { defineTool } from "../runtime/tool.ts";
import { createToolRegistry } from "../runtime/tool-registry.ts";
import { createToolExecutor } from "../runtime/tool-executor.ts";
import type { Operation } from "../runtime/authorization.ts";
import type { ToolCall } from "../runtime/types.ts";
import { sourceCode } from "./diagnosis-fixture.ts";
import { runFileProcess } from "./file-process.ts";
import type { FileRequest } from "./file-process.ts";

export const fixedSource = "export const sum = (numbers: number[]) => numbers.reduce((a, b) => a + b, 0);";
export const versionOf = (content: string) => createHash("sha256").update(content).digest("hex");

/** 每次运行都创建演示副本，不覆盖项目源码或上次实验。 */
export async function createPermissionWorkspace(): Promise<string> {
  await mkdir(".agent-data", { recursive: true });
  const root = await mkdtemp(resolve(".agent-data/permission-"));
  await writeFile(join(root, "sum.ts"), sourceCode, { flag: "wx" });
  return realpath(root);
}

/** 固定能力只允许 sum.ts；这里没有任意路径或任意 shell 功能。 */
function parseRequest(call: ToolCall): FileRequest {
  const args = call.arguments;
  if (args.path !== "sum.ts") throw new Error("scope-denied: only sum.ts is available");

  if (call.name === "read_source") return { kind: "read", path: "sum.ts" };
  if (call.name !== "write_source") throw new Error("Unknown file tool");
  if (typeof args.content !== "string" || args.content.length > 8_192 ||
      typeof args.expectedVersion !== "string" || !/^[a-f0-9]{64}$/.test(args.expectedVersion)) {
    throw new Error("Invalid write arguments");
  }
  return { kind: "write", path: "sum.ts", content: args.content, expectedVersion: args.expectedVersion };
}

/** 返回检查器和原执行接口；应用负责路径知识，Runtime 负责审批顺序。 */
export function createPermissionTools(root: string) {
  async function inspect(call: ToolCall, signal: AbortSignal): Promise<Operation> {
    signal.throwIfAborted();
    const request = parseRequest(call);
    const path = join(root, "sum.ts");
    const stat = await lstat(path);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16_384 || await realpath(path) !== path) {
      throw new Error("scope-denied: unsafe target file");
    }
    const content = await readFile(path, { encoding: "utf8", signal });
    const version = versionOf(content);
    if (request.kind === "write" && request.expectedVersion !== version) {
      throw new Error("resource-changed: read the current file first");
    }
    return { effect: request.kind, version, summary: `${request.kind} sum.ts` };
  }

  const tools = ["read_source", "write_source"].map((name) => defineTool({
    name, description: `受限工作区 ${name}`, parameters: { type: "object" },
    parse(input) {
      try {
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected arguments object");
        return { ok: true as const, value: parseRequest({ id: "parse-only", name, arguments: input as Record<string, unknown> }) };
      } catch (error) {
        return { ok: false as const, message: error instanceof Error ? error.message : String(error) };
      }
    },
    execute: (request, signal) => runFileProcess(root, request, signal),
  }));

  return { inspect, execute: createToolExecutor(createToolRegistry(tools)) };
}