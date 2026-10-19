import { requestDeepSeek } from "../adapters/deepseek/http.ts";
import { createRunControl } from "../runtime/run-control.ts";

const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required");
const model = process.env.DEEPSEEK_MODEL?.trim() || "deepseek-flash";
const control = createRunControl({ timeoutMs: 30_000 });
try {
  const payload = await control.wait((signal) => requestDeepSeek(apiKey, {
    model,
    messages: [{ role: "user", content: "请只回复：连接成功" }],
    thinking: { type: "disabled" },
    stream: false,
    max_tokens: 32,
  }, signal));
  console.log(`模型原始响应（response）: ${JSON.stringify(payload, null, 2)}`);
} finally {
  control.dispose();
}
