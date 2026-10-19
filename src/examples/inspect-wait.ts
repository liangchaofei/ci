import { createRunControl } from "../runtime/run-control.ts";

const control = createRunControl({ timeoutMs: 30 });
try {
  console.log("等待位置（stage）: 模拟决策一直不返回");
  await control.wait(() => new Promise<never>(() => {}));
} catch (error) {
  const stopped = control.outcome();
  if (!stopped) throw error;
  console.log(`停止原因（outcome）: ${stopped.status}`);
} finally {
  control.dispose();
}