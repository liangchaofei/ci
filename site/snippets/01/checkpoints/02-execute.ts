import { createReadSourceCall, simulateReadSource } from "./diagnosis-scenario.ts";

const call = createReadSourceCall();
console.log(`工具请求（request）: ${call.name}`);

// await 等待执行器交回结果，才继续下面的输出。
const result = await simulateReadSource(call);
console.log(`执行状态（result）: ${result.status}`);
console.log(`调用编号（callId）: ${result.callId}`);

if (result.status === "ok") {
  console.log(`读取源码（source）: ${String(result.value)}`);
} else {
  console.log(`错误原因（error）: ${result.message}`);
}
