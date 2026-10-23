// #region worker
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runtimeCases } from "./cases/index.ts";

const id = process.argv[2];
const directory = process.argv[3];

// 只能选择仓库里已声明的场景，不执行外部传入的脚本。
const definition = runtimeCases.find((item) => item.id === id);
if (!definition || !directory) throw new Error("Unknown case or missing directory");

// 工作进程只产出事实；父进程负责应用规则并判定。
const evidence = await definition.run(directory);

// 新目录中首次创建，拒绝覆盖旧证据。
await writeFile(join(directory, "evidence.json"), JSON.stringify(evidence, null, 2), {
  flag: "wx",
});
// #endregion worker
