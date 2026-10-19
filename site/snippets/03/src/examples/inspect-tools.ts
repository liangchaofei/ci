import { createToolRegistry } from "../runtime/tool-registry.ts";
import { createToolExecutor } from "../runtime/tool-executor.ts";
import type { ToolCall } from "../runtime/types.ts";
import { readSourceTool } from "./read-source-tool.ts";

const registry = createToolRegistry([readSourceTool]);
const executeTool = createToolExecutor(registry);
console.log(`已注册工具（tools）: ${registry.names().join(", ")}`);

const cases: { label: string; call: ToolCall }[] = [
  { label: "合法请求", call: { id: "probe-1", name: "read_source", arguments: { path: "src/sum.ts" } } },
  { label: "未知工具", call: { id: "probe-2", name: "remove_file", arguments: { path: "src/sum.ts" } } },
  { label: "路径类型错误", call: { id: "probe-3", name: "read_source", arguments: { path: 42 } } },
  { label: "多余参数", call: { id: "probe-4", name: "read_source", arguments: { path: "src/sum.ts", force: true } } },
];

for (const item of cases) {
  console.log(`检查场景（case）: ${item.label}`);
  const result = await executeTool(item.call);
  console.log(`调用编号（callId）: ${result.callId}`);
  console.log(`工具状态（status）: ${result.status}`);
  if (result.status === "error") {
    console.log(`错误代码（code）: ${result.code}`);
    console.log(`错误说明（message）: ${result.message}`);
  }
}
