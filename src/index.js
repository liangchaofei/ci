export class AgentHarness {
  constructor({ model, tools = {}, maxSteps = 10 }) {
    if (typeof model !== "function") {
      throw new TypeError("model must be a function");
    }
    if (!Number.isInteger(maxSteps) || maxSteps < 1) {
      throw new RangeError("maxSteps must be a positive integer");
    }

    this.model = model;
    this.tools = tools;
    this.maxSteps = maxSteps;
  }

  async run({ input, messages = [], signal } = {}) {
    if (!Array.isArray(messages)) {
      throw new TypeError("messages must be an array");
    }

    const history = messages.map((message) => ({ ...message }));
    if (input !== undefined) {
      history.push({ role: "user", content: String(input) });
    }
    if (history.length === 0) {
      throw new TypeError("run requires input or at least one message");
    }

    const toolDefinitions = Object.entries(this.tools).map(([name, tool]) => ({
      name,
      description: tool.description ?? "",
      parameters: tool.parameters ?? { type: "object", properties: {} },
    }));

    for (let step = 1; step <= this.maxSteps; step += 1) {
      signal?.throwIfAborted();
      const response = await this.model({
        messages: history.map((message) => ({ ...message })),
        tools: toolDefinitions,
        signal,
      });
      signal?.throwIfAborted();

      if (!response || typeof response !== "object") {
        throw new TypeError("model must return an object");
      }
      const toolCalls = response.toolCalls ?? [];
      if (!Array.isArray(toolCalls)) {
        throw new TypeError("model response toolCalls must be an array");
      }

      const content = response.content ?? null;
      if (content !== null && typeof content !== "string") {
        throw new TypeError("model response content must be a string or null");
      }

      history.push({ role: "assistant", content, toolCalls });
      if (toolCalls.length === 0) {
        return { content, messages: history, steps: step, finishReason: "stop" };
      }

      for (const call of toolCalls) {
        signal?.throwIfAborted();
        if (!call || typeof call.id !== "string" || typeof call.name !== "string") {
          throw new TypeError("each tool call must include string id and name fields");
        }

        const tool = Object.hasOwn(this.tools, call.name) ? this.tools[call.name] : null;
        let result;
        let isError = false;

        try {
          if (!tool || typeof tool.execute !== "function") {
            throw new Error(`Unknown tool: ${call.name}`);
          }
          let args = call.arguments ?? {};
          if (typeof args === "string") {
            args = JSON.parse(args);
          }
          result = await tool.execute(args, { signal });
        } catch (error) {
          isError = true;
          result = { error: error instanceof Error ? error.message : String(error) };
        }

        let resultContent;
        try {
          resultContent = typeof result === "string" ? result : JSON.stringify(result ?? null);
          if (typeof resultContent !== "string") {
            throw new TypeError("Tool result must be JSON-serializable");
          }
        } catch {
          isError = true;
          resultContent = JSON.stringify({ error: "Tool result must be JSON-serializable" });
        }

        history.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: resultContent,
          ...(isError ? { isError: true } : {}),
        });
      }
    }

    return {
      content: null,
      messages: history,
      steps: this.maxSteps,
      finishReason: "max_steps",
    };
  }
}
