import { buildDecisionContext } from "../runtime/context.ts";
import type { DecisionContext, State } from "../runtime/types.ts";
import { createReadSourceCall } from "./diagnosis-scenario.ts";
import { createToolRegistry } from "../runtime/tool-registry.ts";
import { createToolExecutor } from "../runtime/tool-executor.ts";
import { readSourceTool } from "./read-source-tool.ts";


/** 只展示输入，不修改状态，也不发起下一次决策。 */
function showContext(label: string, context: DecisionContext): void {
  console.log(`观察时刻（stage）: ${label}`);
  console.log(`上下文字段（keys）: ${Object.keys(context).join(", ")}`);
  console.log(`消息顺序（messages）: ${context.messages.map((message) => message.role).join(" -> ")}`);

  const lastMessage = context.messages.at(-1);
  if (lastMessage?.role === "tool" && lastMessage.result.status === "ok") {
    console.log(`读取源码（source）: ${String(lastMessage.result.value)}`);
  }
}

const goal = "Diagnose why sum([]) fails";
let state: State = {
  goal,
  messages: [{ role: "user", content: goal }],
  decisions: 0,
};

const firstContext = buildDecisionContext(state);
showContext("读取前", firstContext);


const call = createReadSourceCall();
const executeTool = createToolExecutor(createToolRegistry([readSourceTool]));
const result = await executeTool(call, new AbortController().signal);
state = {
  ...state,
  decisions: state.decisions + 1,
  messages: [
    ...state.messages,
    { role: "assistant", action: { kind: "tool", call } },
    { role: "tool", result },
  ],
};

const secondContext = buildDecisionContext(state);
showContext("读取并写回后", secondContext);
console.log(`旧上下文消息数（oldMessages）: ${firstContext.messages.length}`);
console.log(`状态中的决策次数（decisions）: ${state.decisions}`);