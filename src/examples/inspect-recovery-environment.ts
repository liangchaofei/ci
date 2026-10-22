import { join } from "node:path";
import { prepareWorkspace, inspectWorkspace } from "./recovery-workspace.ts";

const root = join(".agent-data", "workspace12");
await prepareWorkspace(root);
const environment = await inspectWorkspace(root);
console.log(`工作区（workspaceId）: ${environment.workspaceId}`);
console.log(`资源版本（revision）: ${environment.revision}`);
console.log(`当前可用工具（allowedTools）: ${environment.allowedTools.join(" -> ")}`);