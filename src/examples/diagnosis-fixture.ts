/** 诊断场景的固定数据，由请求、工具和完成规则共享。 */
export const sourcePath = "src/sum.ts";
export const sourceCallId = "read-1";
export const sourceCode =
  "export const sum = (numbers: number[]) => numbers.reduce((a, b) => a + b);";
export const diagnosis = "sum([]) fails because reduce has no initial value";