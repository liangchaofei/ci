import { Agent } from "../runtime/agent.ts";
import type { AgentOptions } from "../runtime/agent.ts";
import { createDeepSeekDecider } from "../adapters/deepseek/decider.ts";
import type { DeepSeekOptions } from "../adapters/deepseek/decider.ts";
import { createModelBudget } from "../runtime/model-budget.ts";
import { createAuthorizedExecutor } from "../runtime/authorization.ts";
import type { AuthorizationOptions } from "../runtime/authorization.ts";
import { createRecoveryStore } from "../runtime/recovery-store.ts";
import { inspectRecovery } from "../runtime/recovery-reader.ts";
import type { RecoveryEnvironment } from "../runtime/recovery-types.ts";
import type { Dependencies } from "../runtime/types.ts";
import type { ToolRegistry } from "../runtime/tool-registry.ts";
import type { ResourceLimits, UsageRates } from "../runtime/resource-types.ts";
import type { RunEvent } from "../runtime/events.ts";

/** 业务资源与工具由应用提供；组装层不认识 sum 或任何具体任务。 */
export type WorkspaceBindings = {
  registry: ToolRegistry;
  inspect: AuthorizationOptions["inspect"];
  execute: Dependencies["executeTool"];
  inspectEnvironment: () => Promise<RecoveryEnvironment>;
};

/** 一次模型传输的定位信息；不是完整网络抓包，也不保存密钥。 */
export type RequestObservation = {
  runId: string;
  number: number;
  messages: unknown[];
};

export type RuntimeSessionOptions = {
  base: string;
  sessionId: string;
  recoverFrom?: string;
  workspace: WorkspaceBindings;
  getPolicy: AuthorizationOptions["getPolicy"];
  approve: AuthorizationOptions["approve"];
  validateFinish: Dependencies["validateFinish"];
  model: Pick<DeepSeekOptions, "apiKey" | "model" | "systemPrompt"> & {
    fetch: typeof fetch;
  };
  limits: ResourceLimits;
  rates: UsageRates;
  maxContextBytes?: number;
};

/** 只观察适配器实际发出的消息；保留服务替身或真实 fetch 原有行为。 */
function observeTransport(
  send: typeof fetch,
  requests: RequestObservation[],
  currentRunId: () => string | undefined,
): typeof fetch {
  return async (url, init) => {
    const runId = currentRunId();
    if (!runId) throw new Error("Model request has no active run identity");

    const body: unknown = JSON.parse(String(init?.body));
    if (
      !body ||
      typeof body !== "object" ||
      !("messages" in body) ||
      !Array.isArray(body.messages)
    ) {
      throw new Error("Expected model messages");
    }

    // 重试也经过这里；number 是本实例的传输序号，不是决策次数。
    requests.push({
      runId,
      number: requests.length + 1,
      messages: structuredClone(body.messages),
    });
    return send(url, init);
  };
}

/** 组合已有模块，交回原 Agent；不在这里实现第二套循环。 */
export async function createRuntimeSession(options: RuntimeSessionOptions) {
  const { workspace } = options;
  const budget = createModelBudget(options.limits, options.rates);
  const trace: RunEvent[] = [];
  const requests: RequestObservation[] = [];
  let currentRunId: string | undefined;

  const decide = createDeepSeekDecider({
    ...options.model,
    registry: workspace.registry,
    maxOutputTokens: 128,
    http: {
      fetch: observeTransport(options.model.fetch, requests, () => currentRunId),
      budget,
      retry: {
        maxAttempts: 3,
        baseDelayMs: 10,
        maxDelayMs: 30,
        random: () => 0.5,
      },
    },
  });

  // 先审查旧证据，再创建新日志目录；拒绝恢复不能改写旧会话。
  const environment = await workspace.inspectEnvironment();
  const recovery =
    options.recoverFrom === undefined
      ? undefined
      : await inspectRecovery(options.base, options.recoverFrom, environment);
  if (recovery?.status === "blocked")
    throw new Error(`Recovery blocked: ${recovery.reason}`);

  const store = await createRecoveryStore(
    options.base,
    options.sessionId,
    workspace.inspectEnvironment,
    environment,
  );

  try {
    // 只有通过权限检查的请求，才进入意图落盘与实际执行。
    const executeTool = createAuthorizedExecutor({
      getPolicy: options.getPolicy,
      inspect: workspace.inspect,
      approve: options.approve,
      approvalMs: 1_000,
      execute: store.wrap(workspace.execute),
    });

    const agentOptions: AgentOptions = {
      maxDecisions: 5,
      resultSink: store,
      run: {
        timeoutMs: 5_000,
        context: { maxBytes: options.maxContextBytes ?? 32_000 },
      },
    };
    const agent = new Agent(
      {
        decide,
        executeTool,
        validateFinish: options.validateFinish,
      },
      agentOptions,
    );

    // 订阅在启动前安装；身份用于把请求观察与本段事件串在一起。
    agent.subscribe((event) => {
      if (event.type === "run-started") currentRunId = event.runId;
      trace.push(structuredClone(event));
    });

    if (recovery?.status === "ready") agent.restore(recovery.result);

    return {
      agent,
      directory: store.directory,
      report: () =>
        structuredClone({
          trace,
          requests,
          budget: budget.snapshot(),
        }),
      async close() {
        // close 释放保存器，不代替 cancel；调用方须先等待运行返回。
        if (agent.isRunning) throw new Error("Wait for the active run before closing");
        await store.close();
      },
    };
  } catch (error) {
    await store.close();
    throw error;
  }
}