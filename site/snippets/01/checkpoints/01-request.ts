import { createReadSourceCall } from "./diagnosis-scenario.ts";

// 这里只得到数据，没有调用执行器。
const call = createReadSourceCall();
console.log(`工具请求（request）: ${call.name}`);
console.log(`调用编号（id）: ${call.id}`);
console.log(`文件路径（path）: ${String(call.arguments.path)}`);
