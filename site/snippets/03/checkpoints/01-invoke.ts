import { readSourceTool } from "./read-source-tool.ts";

console.log("检查场景（case）: 合法参数");
const valid = await readSourceTool.invoke({ path: "src/sum.ts" });
console.log(`工具状态（status）: ${valid.status}`);

console.log("检查场景（case）: 路径类型错误");
const invalid = await readSourceTool.invoke({ path: 42 });
console.log(`工具状态（status）: ${invalid.status}`);
if (invalid.status === "error") {
  console.log(`错误代码（code）: ${invalid.code}`);
  console.log(`错误说明（message）: ${invalid.message}`);
}
