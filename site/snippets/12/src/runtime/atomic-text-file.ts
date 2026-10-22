import { open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";

/** 同目录临时文件写完并同步后再替换；调用方负责先创建父目录。 */
export async function replaceTextFile(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);

  try {
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    // 不在原文件上逐字覆盖，避免读到半份新检查点。
    await rename(temporary, path);
  } catch (error) {
    // 只清理本次创建的临时文件，清理失败不覆盖原始错误。
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
