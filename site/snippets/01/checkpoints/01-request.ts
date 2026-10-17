import { createReadSourceCall } from "./diagnosis-scenario.ts";

// 这里只得到数据，没有调用执行器。
const call = createReadSourceCall();
console.log(`request: ${call.name}`);
console.log(`id: ${call.id}`);
console.log(`path: ${String(call.arguments.path)}`);
