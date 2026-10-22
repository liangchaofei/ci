import { createEventBus, createRunReporter } from "../runtime/events.ts";
import type { RunEvent } from "../runtime/events.ts";

// 这里只手动发送两份通知，先检查通知通道；还没有启动 Agent Loop。
const bus = createEventBus();
const trace: RunEvent[] = [];

bus.subscribe((event) => { trace.push(event); });
const unsubscribe = bus.subscribe((event) => {
  console.log(`实时通知（event）: ${event.seq} ${event.type}`);
});
bus.subscribe(() => { throw new Error("Broken display"); });

const report = createRunReporter(bus.emit);
report({ type: "run-started" });
unsubscribe();
report({ type: "run-ended", outcome: { status: "cancelled" }, decisions: 0, messages: 1 });

console.log(`已保存通知（trace）: ${trace.map((event) => event.type).join(" -> ")}`);
console.log(`同一次运行（sameRun）: ${trace[0].runId === trace[1].runId}`);
console.log(`顺序编号（seq）: ${trace.map((event) => event.seq).join(" -> ")}`);
