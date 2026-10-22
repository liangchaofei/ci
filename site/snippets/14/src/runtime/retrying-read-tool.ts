// #region tool
import { defineTool } from "./tool.ts";
import type { ToolDefinition } from "./tool.ts";
import { retry } from "./retry.ts";
import type { RetrySettings } from "./retry.ts";

/** 仅由可信应用为只读工具选用；写工具继续走原 defineTool。 */
export function defineRetryingReadTool<Args>(
  definition: ToolDefinition<Args>,
  settings: RetrySettings,
  checkAccess: (args: Args, signal: AbortSignal) => Promise<void>,
) {
  return defineTool({
    ...definition,
    execute: async (args, signal) => {
      const original = structuredClone(args);
      return retry(() => definition.execute(structuredClone(original), signal), {
        ...settings,
        safety: "read-only",
        beforeAttempt: () => checkAccess(structuredClone(original), signal),
      }, signal);
    },
  });
}
// #endregion tool
