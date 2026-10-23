import { execFile } from "node:child_process";

/** 子进程异常也保留调试输出，不能只剩一句超时或退出码。 */
export class ChildRunError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  constructor(message: string, stdout: string, stderr: string) {
    super(message);
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/** 只启动已知 Node 文件，不经过 shell；每项子调用均有时间和输出上限。 */
export function runNode(file: string, args: string[], cwd: string, expectedExit = 0): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [file, ...args], { cwd, env: {}, timeout: 10_000, maxBuffer: 1_000_000, encoding: "utf8" },
      (error, stdout, stderr) => {
        const code = error ? error.code : 0;
        if (typeof code !== "number" || code !== expectedExit || error?.killed) {
          reject(new ChildRunError(`Child process did not exit as expected: ${String(code)}; ${error?.message || ""}`, stdout, stderr));
          return;
        }
        resolve({ code, stdout, stderr });
      });
  });
}