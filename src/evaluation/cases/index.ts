import { normalCase, requestLimitCase } from "./normal.ts";
import { streamCutCase } from "./stream.ts";
import { writeDeniedCase, pathEscapeCase } from "./permissions.ts";
import { lateCancelCase, parallelOrderCase } from "./concurrency.ts";
import { recoveryCase, unknownWriteCase, staleRecoveryCase } from "./recovery.ts";

/** 名单由应用代码决定，CLI 只选择已有 ID，不接受模型给出的执行脚本。 */
export const runtimeCases = [normalCase, requestLimitCase, streamCutCase, writeDeniedCase,
  pathEscapeCase, lateCancelCase, parallelOrderCase, recoveryCase, unknownWriteCase, staleRecoveryCase];