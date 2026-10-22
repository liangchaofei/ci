import type { ResultSink } from "./result-sink.ts";
import { ResultSaveError } from "./result-sink.ts";
import { runAgentLoop } from "./agent-loop.ts";
import type { RunAgentOptions } from "./agent-loop.ts";
import { createEventBus } from "./events.ts";
import type { EventListener } from "./events.ts";
import { createInputQueue } from "./input-queue.ts";
import type { Dependencies, RunResult, State } from "./types.ts";

/** 循环配置沿用原接口，运行身份、输入与续运行状态由实例管理。 */
export type AgentOptions = {
  maxDecisions: number;
  resultSink?: ResultSink;
  run?: Omit<RunAgentOptions, "signal" | "onEvent" | "inbox" | "initialState">;
};

/** State 仍由循环写入；实例只持有队列、活动控制器和结束快照。 */
export class Agent {
  private readonly dependencies: Dependencies;
  private readonly options: AgentOptions;
  private readonly events = createEventBus();
  private readonly inputs = createInputQueue();
  private controller: AbortController | undefined;
  private lastResult: RunResult | undefined;
  private pauseRequested = false;
  private acceptingInputs = false;

  constructor(dependencies: Dependencies, options: AgentOptions) {
    this.dependencies = dependencies;
    this.options = options;
  }

  get isRunning(): boolean { return this.controller !== undefined; }
  get isPaused(): boolean { return !this.isRunning && this.lastResult?.outcome.status === "paused"; }
  get pendingInputs() { return this.inputs.counts(); }

  get result(): RunResult | undefined {
    return this.lastResult === undefined ? undefined : structuredClone(this.lastResult);
  }

  subscribe(listener: EventListener): () => void { return this.events.subscribe(listener); }
  cancel(): void { this.controller?.abort(); }

  private assertCanQueue(): void {
    if (!(this.isRunning && this.acceptingInputs) && !this.isPaused) {
      throw new Error("Input requires an active or paused run");
    }
  }

  steer(content: string): void {
    this.assertCanQueue();
    this.inputs.push("steer", content);
  }

  followUp(content: string): void {
    this.assertCanQueue();
    this.inputs.push("follow-up", content);
  }

  pause(): void {
    if (!this.isRunning || !this.acceptingInputs) throw new Error("No active run to pause");
    this.pauseRequested = true;
  }

  async run(goal: string): Promise<RunResult> {
    if (this.isRunning) throw new Error("Agent is already running");
    // 显式启动新任务会丢弃旧暂停点和未消费输入，不与新任务混用。
    this.inputs.clear();
    return this.start(goal);
  }

  async resume(content: string): Promise<RunResult> {
    if (this.isRunning) throw new Error("Agent is already running");
    const previous = this.lastResult;
    if (previous?.outcome.status !== "paused") throw new Error("No paused run to resume");

    // 继续是一次明确的用户输入；与暂停期间的其他 steer 一起按顺序写回。
    this.inputs.push("steer", content);
    return this.start(previous.state.goal, previous.state);
  }

  private async start(goal: string, initialState?: Readonly<State>): Promise<RunResult> {
    const controller = new AbortController();
    this.controller = controller;
    this.pauseRequested = false;
    this.acceptingInputs = true;
    this.lastResult = undefined;
    let runId: string | undefined;

    try {
      const result = await runAgentLoop(goal, this.dependencies, this.options.maxDecisions, {
        ...this.options.run,
        signal: controller.signal,
        initialState,
        inbox: { take: this.inputs.take, isPauseRequested: () => this.pauseRequested },
        onEvent: (event) => {
          if (event.type === "run-started") runId = event.runId;
          // 结束通知的回调已不能再给本段运行塞输入，避免“收到了却没人处理”。
          if (event.type === "run-ended" || event.type === "run-crashed") this.acceptingInputs = false;
          this.events.emit(event);
        },
      });
      if (this.options.resultSink) {
        try {
          if (!runId) throw new Error("Missing run identity for result persistence");
          await this.options.resultSink.save(runId, structuredClone(result));
        } catch (error) {
          throw new ResultSaveError(error);
        }
      }

      this.lastResult = structuredClone(result);
      return result;
    } finally {
      this.controller = undefined;
      this.acceptingInputs = false;
      if (this.lastResult?.outcome.status !== "paused") this.inputs.clear();
    }
  }
}