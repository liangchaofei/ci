/** 只发送请求并取得未知 JSON；不执行工具，也不修改运行状态。 */
export async function requestDeepSeek(
  apiKey: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  if (!apiKey.trim()) throw new Error("DEEPSEEK_API_KEY is required");

  // 配置检查通过才发请求，取消信号直接传到网络层。
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`DeepSeek HTTP ${response.status}`);
  }

  // 服务返回了 JSON，不等于它已符合 Runtime 的 Action 契约。
  const payload: unknown = await response.json();
  return payload;
}
