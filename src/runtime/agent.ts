import { runAgentLoop } from "./agent-loop.ts";
import type { RunAgentOptions } from "./agent-loop.ts";
import { createEventBus } from "./events.ts";
import type { EventListener } from "./events.ts";
import type { Dependencies, RunResult } from "./types.ts";

/** 信号与事件由实例统一连接，其余循环配置沿用前章。 */
export type AgentOptions = {
  maxDecisions: number;
  run?: Omit<RunAgentOptions, "signal" | "onEvent">;
};

/** 管理同一实例的启动与取消；循环仍是唯一的运行历史写入者。 */
export class Agent {
  private readonly dependencies: Dependencies;
  private readonly options: AgentOptions;
  private readonly events = createEventBus();
  private controller: AbortController | undefined;
  private lastResult: RunResult | undefined;

  constructor(dependencies: Dependencies, options: AgentOptions) {
    this.dependencies = dependencies;
    this.options = options;
  }

  get isRunning(): boolean {
    return this.controller !== undefined;
  }

  get result(): RunResult | undefined {
    // 调用方拿到自己的副本，不能改掉实例留存的最终记录。
    return this.lastResult === undefined ? undefined : structuredClone(this.lastResult);
  }

  subscribe(listener: EventListener): () => void {
    return this.events.subscribe(listener);
  }

  cancel(): void {
    this.controller?.abort();
  }

  async run(goal: string): Promise<RunResult> {
    if (this.isRunning) throw new Error("Agent is already running");

    // 必须在调用循环、发送首个事件以及第一次 await 之前占住实例。
    const controller = new AbortController();
    this.controller = controller;
    this.lastResult = undefined;

    try {
      const result = await runAgentLoop(goal, this.dependencies, this.options.maxDecisions, {
        ...this.options.run,
        signal: controller.signal,
        onEvent: this.events.emit,
      });
      this.lastResult = structuredClone(result);
      return result;
    } finally {
      // 失败、取消、配置错误都释放实例；不会留下永久忙碌标志。
      this.controller = undefined;
    }
  }
}