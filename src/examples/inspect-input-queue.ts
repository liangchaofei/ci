import { createInputQueue } from "../runtime/input-queue.ts";

const queue = createInputQueue();
queue.push("follow-up", "最后说明已有测试漏了什么。");
queue.push("steer", "请用中文。");
queue.push("steer", "只诊断，不修改文件。");

console.log(`决策前取出（beforeDecision）: ${queue.take("before-decision").map((input) => input.content).join(" | ")}`);
console.log(`尚未处理（pending）: ${JSON.stringify(queue.counts())}`);
console.log(`可结束时取出（beforeFinish）: ${queue.take("before-finish").map((input) => input.content).join(" | ")}`);
console.log(`再取为空（empty）: ${queue.take("before-finish").length}`);