import type { Dependencies } from "../src/runtime/types.ts";
import { createTextTools } from "../src/tools/text-tools.ts";

export const task = { goal: "Read the project name" };
export function fixture(content: string | null = "name"): Dependencies {
  const registry = createTextTools(content === null ? new Map() : new Map([["project-name.txt", content]]));
  return {
    executeToolCall: (call, signal) => registry.execute(call, signal),
    decide: async (state) => {
      const observation = state.observations.at(-1);
      if (!observation) return { kind: "tool", call: {
        id: `read-${state.decisions}`, name: "read_text", arguments: { path: "project-name.txt" },
      } };
      return observation.status === "ok" && typeof observation.value === "string"
        ? { kind: "finish", answer: observation.value }
        : { kind: "fail", reason: observation.status === "error" ? observation.message : "Bad value" };
    },
    validateFinish: (state, answer) => {
      const observation = state.observations.at(-1);
      return observation?.status === "ok" && observation.toolName === "read_text" && observation.value === answer;
    },
  };
}
