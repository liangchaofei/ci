import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");


/** 独立子进程入口：仅处理可信应用传来的固定文件读写协议。 */
async function main(): Promise<void> {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (Buffer.byteLength(input) > 65_536) throw new Error("Worker input too large");
  }

  const request = JSON.parse(input);
  if (request.path !== "sum.ts" || !["read", "write"].includes(request.kind)) {
    throw new Error("Invalid worker request");
  }
  if (request.kind === "write" && (typeof request.content !== "string" || request.content.length > 8_192)) {
    throw new Error("Invalid write content");
  }

  // 不跟随目标文件的符号链接；同一个句柄用于检查和实际写入。
  const flags = (request.kind === "write" ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW;
  const file = await open("sum.ts", flags);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16_384) throw new Error("Unsafe target file");
    const content = await file.readFile("utf8");

    if (request.kind === "read") {
      console.log(JSON.stringify({ content, version: digest(content) }));
      return;
    }

    if (digest(content) !== request.expectedVersion) throw new Error("resource-changed: worker check failed");

    // 截断和写入不是事务；中途失败可能留下部分内容，不能自动重放。
    await file.truncate(0);
    await file.write(request.content, 0, "utf8");
    await file.sync();
    const bytes = Buffer.alloc(Buffer.byteLength(request.content));
    await file.read(bytes, 0, bytes.length, 0);
    const version = digest(bytes.toString("utf8"));
    if (version !== digest(request.content)) throw new Error("Write verification failed");
    console.log(JSON.stringify({ version }));
  } finally {
    await file.close();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});