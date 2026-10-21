import { groupExchanges } from "../runtime/context-exchanges.ts";
import { buildDecisionContext } from "../runtime/context.ts";
import { measureContextBytes } from "../runtime/context-window.ts";
import type { ContextWindowOptions } from "../runtime/context-window.ts";
import { createContextFixture } from "./context-fixture.ts";
import { summarizeBuildLog } from "./context-scenario.ts";

const state = createContextFixture();
const mode = process.argv[2] ?? "summary";
if (!["groups", "summary", "plain", "small", "huge-summary"].includes(mode)) throw new Error("Unknown mode");

const groups = groupExchanges(state.messages.slice(1));
console.log(`原历史消息数（stateMessages）: ${state.messages.length}`);
console.log(`完整组大小（groups）: ${groups.map((group) => group.length).join(" -> ")}`);
if (mode !== "groups") {
  const full = buildDecisionContext(state);
  let summarize: ContextWindowOptions["summarize"] = summarizeBuildLog;
  if (mode === "plain") summarize = undefined;
  if (mode === "huge-summary") summarize = () => "过长摘要".repeat(2000);

  const context = buildDecisionContext(state, {
    maxBytes: mode === "small" ? 100 : 1600,
    keepRecentExchanges: 1,
    summarize,
  });

  console.log(`全量大小（fullBytes）: ${measureContextBytes(full)}`);
  console.log(`本轮大小（contextBytes）: ${measureContextBytes(context)}`);
  console.log(`本轮消息数（contextMessages）: ${context.messages.length}`);
  console.log(`本轮摘要（summary）: ${context.summary ?? "无"}`);
  console.log(`最近结果（callIds）: ${context.messages.filter((m) => m.role === "tool").map((m) => m.result.callId).join(" -> ")}`);
  console.log(`原历史仍保留（stateMessages）: ${state.messages.length}`);
}