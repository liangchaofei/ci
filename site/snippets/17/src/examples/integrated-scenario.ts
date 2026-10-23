// #region imports
import { join } from "node:path";
import { createRuntimeSession } from "../application/runtime-session.ts";
import { prepareWorkspace } from "./recovery-workspace.ts";
import {
  createIntegratedWorkspace,
  validateIntegratedFinish,
} from "./integrated-workspace.ts";
import { createIntegratedModel } from "./integrated-model.ts";
// #endregion imports

// #region modes
export const integrationModes = [
  "normal",
  "early-finish",
  "denied",
  "request-limit",
  "context-limit",
  "cancel",
  "pause",
  "resume",
] as const;
export type IntegrationMode = (typeof integrationModes)[number];

export function parseIntegrationMode(value: string): IntegrationMode {
  if (!integrationModes.includes(value as IntegrationMode))
    throw new Error(`Unknown integration mode: ${value}`);
  return value as IntegrationMode;
}
// #endregion modes

// #region prepare
/** 改变实验条件，沿用完全相同的组装入口；不复制另一套 Agent Loop。 */
export async function prepareIntegratedScenario(base: string, mode: IntegrationMode) {
  const root = join(base, "workspace");
  await prepareWorkspace(root);

  // 工具“已注册”与“本次获准执行”是两件事；denied 只撤去测试读取许可。
  const allowedTools =
    mode === "denied" ? ["read_source"] : ["read_source", "read_tests"];
  const getPolicy = () => ({
    version: "integration-read-1",
    allowedTools,
  });
  const workspace = createIntegratedWorkspace(root, () => getPolicy().allowedTools);
  const fixture = createIntegratedModel(mode === "early-finish");

  const session = await createRuntimeSession({
    base,
    sessionId: mode,
    ...(mode === "resume" ? { recoverFrom: "pause" } : {}),
    workspace,
    getPolicy,
    approve: async () => false,
    validateFinish: validateIntegratedFinish,
    model: {
      apiKey: "offline-placeholder",
      model: "offline-fixture",
      systemPrompt: "读取源码和测试后诊断，不修改文件。",
      fetch: fixture.send,
    },
    limits: {
      maxRequests: mode === "request-limit" ? 1 : 4,
      maxConcurrent: 1,
      maxKnownTokens: 300,
      maxEstimatedCostUnits: 500,
    },
    rates: {
      inputUnitsPerToken: 1,
      outputUnitsPerToken: 2,
    },
    maxContextBytes: mode === "context-limit" ? 1 : 32_000,
  });

  // 同步观察者只发控制请求；状态更新与退出仍由原 Agent/Loop 执行。
  if (mode === "pause")
    session.agent.subscribe((event) => {
      if (event.type === "results-recorded") session.agent.pause();
    });
  if (mode === "cancel")
    session.agent.subscribe((event) => {
      if (event.type === "batch-started") session.agent.cancel();
    });

  return {
    ...session,
    root,
    httpCalls: fixture.count,
  };
}
// #endregion prepare

// #region run
/** 共用的一次运行：resume 显式接续，其他模式均启动新任务。 */
export async function runIntegratedScenario(
  base: string,
  mode: IntegrationMode,
  goal = "诊断空数组求和为什么失败，只读取，不修改。",
) {
  const session = await prepareIntegratedScenario(base, mode);

  try {
    const result =
      mode === "resume"
        ? await session.agent.resume("沿用已读材料给出诊断。")
        : await session.agent.run(goal);

    // agent 返回意味着本段保存已等待完成；事件结束本身不作这个保证。
    return {
      result,
      ...session.report(),
      httpCalls: session.httpCalls(),
      sessionDirectory: session.directory,
    };
  } finally {
    await session.close();
  }
}
// #endregion run
