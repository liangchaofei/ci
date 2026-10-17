import { createReadSourceCall, simulateReadSource } from "./diagnosis-scenario.ts";

const call = createReadSourceCall();
console.log(`request: ${call.name}`);

// await 等待执行器交回结果，才继续下面的输出。
const result = await simulateReadSource(call);
console.log(`result: ${result.status}`);
console.log(`callId: ${result.callId}`);

if (result.status === "ok") {
  console.log(`source: ${String(result.value)}`);
} else {
  console.log(`error: ${result.message}`);
}
