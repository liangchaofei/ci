// #region fixture
import { createRetryModelFixture } from "./retry-model-fixture.ts";

/** 沿用第 14 篇的 503 和动作响应，只为成功响应补上本例固定 usage。 */
export function createBudgetModelFixture() {
  const original = createRetryModelFixture();
  const send: typeof fetch = async (url, init) => {
    const response = await original.send(url, init);
    if (!response.ok) return response;
    const payload = await response.json();
    const input = original.count() === 2 ? 40 : 60;
    return Response.json({ ...payload, usage: { prompt_tokens: input, completion_tokens: 10, total_tokens: input + 10 } });
  };
  return { send, count: original.count };
}
// #endregion fixture
