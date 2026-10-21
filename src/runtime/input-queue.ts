/** steer 在下一轮前补充要求；follow-up 在本来可以完成时接着处理。 */
export type InputKind = "steer" | "follow-up";
export type PendingInput = { kind: InputKind; content: string };
export type InputBoundary = "before-decision" | "before-finish";

/** 循环只拉取输入与暂停请求，不直接修改实例队列。 */
export type RunInbox = {
  take: (boundary: InputBoundary) => PendingInput[];
  isPauseRequested: () => boolean;
};

/** 队列只保存待处理文本；取出不等于已经进入 State。 */
export function createInputQueue() {
  const steering: PendingInput[] = [];
  const followUps: PendingInput[] = [];

  function push(kind: InputKind, content: string): void {
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("Input must be non-empty text");
    }

    const input: PendingInput = { kind, content };
    if (kind === "steer") steering.push(input);
    else if (kind === "follow-up") followUps.push(input);
    else throw new Error("Unknown input kind");
  }

  function take(boundary: InputBoundary): PendingInput[] {
    // 当前要求优先；一次取出全部 steer，保留它们的进入顺序。
    if (steering.length > 0) return steering.splice(0);
    if (boundary === "before-decision") return [];

    // 只有可以结束当前回答时，才接着处理一条追问。
    const next = followUps.shift();
    return next ? [next] : [];
  }

  function clear(): void {
    steering.length = 0;
    followUps.length = 0;
  }

  return {
    push,
    take,
    clear,
    counts: () => ({ steering: steering.length, followUps: followUps.length }),
  };
}