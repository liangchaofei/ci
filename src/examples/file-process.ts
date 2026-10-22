import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export type FileRequest =
  | { kind: "read"; path: "sum.ts" }
  | { kind: "write"; path: "sum.ts"; content: string; expectedVersion: string };

/** 只启动固定的可信脚本，模型不能提供命令、环境变量或权限标志。 */
export function runFileProcess(root: string, request: FileRequest, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const worker = fileURLToPath(new URL("./file-worker.ts", import.meta.url));
  const target = join(root, "sum.ts");
  const args = ["--permission", `--allow-fs-read=${worker}`, `--allow-fs-read=${target}`];
  if (request.kind === "write") args.push(`--allow-fs-write=${target}`);
  args.push(worker);

  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, args, {
      cwd: root, env: {}, signal, timeout: 5_000, maxBuffer: 65_536, encoding: "utf8", shell: false,
    }, (error, stdout, stderr) => {
      if (error) { reject(new Error(stderr.trim() || error.message)); return; }
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error("Invalid worker response")); }
    });

    // 进程退出或取消时 stdin 可能已关闭；最终错误由 execFile 回调处理。
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(JSON.stringify(request));
  });
}