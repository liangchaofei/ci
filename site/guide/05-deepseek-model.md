---
title: 第 06 篇｜接入 DeepSeek 真实模型
description: 先完成一次真实 API 调用，再将消息、工具说明和模型响应连接到已有 Runtime，完成非流式的多轮工具调用。
---

# 第 06 篇：让真实模型决定下一步

前四篇里，scriptedDecide 遇到 user 就提出读取，看到预期源码就给出固定答案。循环、工具检查和停止控制都在运行，但下一步已经被脚本写好。本篇把这个位置换成 DeepSeek 官方 API：模型接收本轮消息与工具说明，决定请求工具还是回答。

先用一个很短的入口确认“请求发出，服务返回”；再把同一个 HTTP 函数接到已有 Runtime。完成后，诊断任务应经历：模型要求读取 src/sum.ts → 本地工具返回源码 → Runtime 写回 → 下一次模型请求包含源码 → 模型给出诊断。**模型是真实的，读取体仍返回固定源码；本篇没有实际修改文件。**

本篇要理解的主线是“内部消息怎样变成接口请求，接口响应怎样变成内部动作”。循环与停止控制继续复用，不在模型适配器里再写一套循环。暂不处理流式输出、思考内容、多工具批次或自动重试。

## 推荐分支与运行前提

从第 5 篇已验证、已提交的本地版本创建：

```bash
git switch -c codex/chapter-05-deepseek
```

若分支已存在，用 `git switch codex/chapter-05-deepseek` 返回。命令均在仓库根目录执行。继续使用 Node 22.18 或更新版本及原有依赖，不安装模型 SDK；HTTP 请求使用 Node 自带 fetch。

本篇选定 DeepSeek 官方的 Chat Completions 接口、非思考模式，示例模型名为 `deepseek-flash`。这是编写时官方文档列出的模型名；模型可用性与账户状态仍以服务实际返回为准，不沿用旧文章中的 deepseek-chat 名称。[官方模型列表](https://api-docs.deepseek.com/quick_start/pricing/)

::: info 验证范围
本篇的类型、消息转换、模拟 HTTP 两轮交互、错误与取消路径已在独立候选工程验证。真实服务调用还需要本地有效密钥与可用账户；联网运行以你的实际结果为准。下方标为“典型轨迹”的模型输出用于解释流程，不是固定答案或逐字承诺。
:::

## 先看整个系统怎样变化

这次仍然处理同一个问题：用户问“为什么 `src/sum.ts` 中的 `sum([])` 会失败”。工具提供的源码仍是：

```ts
export const sum = (numbers: number[]) => numbers.reduce((a, b) => a + b);
```

这是被诊断的固定源码，不是本章新增的 Runtime 文件。旧脚本看到指定源码就返回预先写好的 diagnosis；现在改为把源码发给真实模型，由它生成原因与建议。读取工具依旧返回固定字符串，本章还没有读取任意磁盘文件或自动修改代码。

### 为什么不能把 API 调用直接塞进循环

先回忆循环等待的是什么：`decide(context, signal)` 返回一个 Action，循环才知道是执行工具还是检查完成。但模型接口不会直接返回本项目的 Action，它返回的是带 choices、message、tool_calls 的 JSON。

两边的差别可以用一次读取说明：

| 位置 | 同一次请求怎样表示 |
|---|---|
| 模型接口 | `message.tool_calls[0].function.name` 是 `"read_source"` |
| 本项目动作 | `action.call.name` 是 `"read_source"` |
| 模型接口 | `function.arguments` 是字符串 `'{"path":"src/sum.ts"}'` |
| 本项目动作 | `call.arguments` 是对象 `{ path: "src/sum.ts" }` |

因此需要一层**适配器**：把 Runtime 的输入转成服务接受的格式，再把服务响应检查、转换为 Runtime 接受的动作。它连接两种约定；循环继续只处理 Action，不需要认识 DeepSeek 的 choices 字段。

[![第 6 篇数据流：Context 经适配器转为 DeepSeek 消息，模型返回工具请求，解码成 Action；原循环执行、写回，再准备下一轮模型输入](/diagrams/deepseek-adapter-flow.svg)](/diagrams/deepseek-adapter-flow.svg)

点击图片可放大。蓝色部分是本章新增的适配代码；绿色部分沿用已有 Runtime。箭头表示传递数据，不表示每个模块都能修改 State。

### 先用两轮运行理解要实现什么

下面是一种正常过程，不是模型每次都必须遵守的固定轮数：

```text
第 1 次决策
  Runtime：Context 里只有用户任务
  适配器：把任务、应用说明和工具说明发给模型
  模型：提出 read_source({ path: "src/sum.ts" })
  适配器：把响应转换成 tool Action，交回循环
  Runtime：记录动作 → 调用执行器 → 把源码结果写入 State

第 2 次决策
  Runtime：从更新后的 State 构造 Context，里面已有请求与源码结果
  适配器：把这些历史记录转换后，再发一次请求
  模型：根据源码给出诊断与建议
  适配器：把回答转换成 finish Action
  Runtime：记录回答 → 调用应用完成规则 → 返回运行结果
```

这里不是模型自己在云端执行了本地函数。模型只返回“想调用什么、参数是什么”；实际操作发生在本地执行器。工具返回之后，仍由本地程序主动再发一次模型请求，模型才收到结果。[DeepSeek 官方工具调用示例](https://api-docs.deepseek.com/zh-cn/guides/tool_calls/)

### 本章新增和修改哪些文件

| 文件 | 操作 | 为什么需要 |
|---|---|---|
| `.env.example` | 新增 | 列出密钥与模型名的配置字段 |
| `src/adapters/deepseek/http.ts` | 新增 | 发 HTTP 请求，取得原始 JSON |
| `src/examples/ask-deepseek.ts` | 新增 | 先单独确认一次请求能够得到响应 |
| `src/runtime/types.ts` | 修改 Action | 保存工具请求附带的模型文字 |
| `src/runtime/tool.ts` | 修改工具类型与 defineTool | 让工具保留模型可读的说明和参数描述 |
| `src/runtime/tool-registry.ts` | 修改注册对象 | 注册时保留新增字段 |
| `src/examples/read-source-tool.ts` | 修改工具定义 | 描述 read_source 的用途和允许参数 |
| `src/adapters/deepseek/protocol.ts` | 新增 | 转换发出的消息，检查收到的响应 |
| `src/adapters/deepseek/decider.ts` | 新增 | 把请求和转换组装成 decide |
| `src/examples/deepseek-scenario.ts` | 新增 | 提供诊断提示词与读取证据检查 |
| `src/examples/deepseek-agent.ts` | 新增 | 组装已有 Runtime，运行真实模型诊断 |

`agent-loop.ts`、Context 构造、工具执行器与 RunControl 沿用第 5 篇。下面按三个阶段实现：先联网，再接数据格式，最后运行完整任务。每阶段都复用前面写好的代码。

## 第一阶段：先取得一次真实响应

本阶段只新增 HTTP 函数、一个短入口和环境配置，不修改 Runtime 接口。先确认联网链路，再处理工具调用，避免把网络问题与循环问题混在一起。

### 1. 配置密钥与模型名

在仓库根目录新建 `.env.example`，写入：

```text
# 复制为 .env 后，仅在 .env 填入自己的密钥；不要提交 .env。
DEEPSEEK_API_KEY=
DEEPSEEK_MODEL=deepseek-flash
```

如果尚无 `.env`，运行：

```bash
cp .env.example .env
```

然后在本地 `.env` 填入自己的 DEEPSEEK_API_KEY。若已有 `.env`，保留已有内容，补齐这两个字段即可，不要覆盖原配置。密钥可在 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys) 管理。

.env 是本机配置，已有 .gitignore 会忽略它；.env.example 只有字段与空占位，供其他人配置。后面的命令使用 `--env-file=.env` 加载，源码只从 process.env 读取。网页本身不会接收密钥或发送模型请求；联网代码在本地 Node 进程中运行。

### 2. 写只负责 HTTP 的函数

新建目录 `src/adapters/deepseek/`，在其中新建 `http.ts`，写入完整代码：

<<< ../snippets/05/src/adapters/deepseek/http.ts

#### 一次请求怎样经过这个函数

requestDeepSeek 接收三个参数：apiKey 是本机密钥，body 是本次要发送的对象，signal 是上一章的取消信号。它返回 `Promise<unknown>`：调用方要 await 才能取得 JSON，而这个 JSON 的业务结构还没有检查。

先假设 body 中有一条消息：“请只回复：连接成功”。沿代码看一次正常请求：

1. 检查 apiKey 非空。如果缺少配置，在发请求之前就抛错。
2. `fetch` 用 POST 向固定地址发送请求。Authorization 携带密钥，Content-Type 告诉服务请求正文是 JSON。
3. `JSON.stringify(body)` 把 JavaScript 对象变成可发送的 JSON 文本。这里只转换格式，不执行 body 中提到的任何工具。
4. `await fetch(...)` 等到 HTTP 响应，response 接住响应对象；它包含状态码与响应体，还不是模型的回答字符串。
5. `await response.json()` 读取并解析响应体，payload 接住解析后的值；`return payload` 把它交给本函数的调用方。

::: info 以下摘录仅供对照
解释中的代码片段已包含在上方对应的完整实现中，**无需再次写入、追加或替换文件**。继续实现时，以标明“新增、追加、替换”的步骤为准。
:::

**讲解摘录 · HTTP 响应由 response 接住（无需写入文件）**

<<< ../snippets/05/src/adapters/deepseek/http.ts#explain-http

注意两个 await 的等待内容不同：第一个取得 HTTP 响应，第二个取得响应体中的 JSON 数据。调用方最终拿到的是 payload，不是 response，也不是已转换的 Action。

#### 为什么先返回 unknown

假设服务返回了 `{ choices: [...] }`，这只是“收到了一份能解析的 JSON”。我们还没确认 choices 是不是数组、消息是否完整、工具参数是否能解析。unknown 要求后面的代码先检查实际值，不能直接把网络内容当成 Action 使用。第 8 步会完成这些检查。

非成功 HTTP 状态走 `!response.ok` 分支：取消未使用的响应体，再抛出带状态码的错误，不执行后面的 JSON 读取。这里取消的是响应体读取，不是撤回已经发出的请求。

signal 原样交给 fetch：Runtime 超时或外部取消时，停止通知可以传到网络请求。函数自身不另设计时器，也没有 State 参数，不负责记录会话。[DeepSeek：Chat Completions 接口](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/)

#### http.ts：把本次请求发出，把原始 JSON 交回

这个文件只有 requestDeepSeek：接收密钥、请求体与 signal，等待 HTTP 响应并返回 payload:unknown。下一步的连接入口可以调用它，后面正式 decide 也会复用它。

因此它连接的是“本地请求对象 → DeepSeek 服务 → 未检查的 JSON”，没有理解 Action、执行工具或写入 State。这样连接失败时可以先单独调查 HTTP，而不用同时修改循环与协议转换。

### 3. 用一个短入口确认连接

这个短入口只验证“请求发得出去、响应拿得回来”，还不让模型调用工具，也不启动 Agent Loop。已有 HTTP 函数处理网络请求，入口只准备配置、交给等待控制并显示原始 JSON。

新建 `src/examples/ask-deepseek.ts`，写入下面完整内容；文件较短，保留连续 try/finally，随后沿一次调用解释：

<<< ../snippets/05/src/examples/ask-deepseek.ts

#### 入口怎样调用刚才的 HTTP 函数

这个文件是最小的运行入口。执行它只会问一次普通问题，不会启动 Agent Loop。

先看请求对象里的字段：

| 字段 | 在这次请求中的含义 |
|---|---|
| model | 使用哪个模型，从环境变量读取，未配置时使用示例默认值 |
| messages | 这次发给模型的对话，只有一条 user 消息 |
| thinking | 显式关闭思考模式，本章只处理普通回答和工具请求 |
| stream:false | 等待完整响应，不逐段接收输出 |
| max_tokens:32 | 限制这次输出的 token 数量；token 是服务计量文本的单位，不等于固定字数 |

apiKey 与 model 只是从 process.env 取配置；`createRunControl` 创建的 control 管理这次最多 30 秒的等待。30_000 中的下划线只为方便读数，数值就是 30000。

读下面这条调用时，先看传给 wait 的函数：`(signal) => requestDeepSeek(...)`。control 会先检查这次运行能否开始，再调用这个函数；函数取得 signal 后才发网络请求。外面的 await 等到 requestDeepSeek 返回的 JSON，payload 接住它，最后打印出来。`finally` 无论成功还是失败都会清理计时器。

这条连接沿用第 5 篇机制：

```text
control.wait
  → 启动 requestDeepSeek，并传入 signal
  → requestDeepSeek 内部取得 payload
  → 返回 payload，等待结束
  → ask-deepseek.ts 的 payload 接住同一份返回数据
  → console.log 显示 JSON
```

两个函数中都叫 payload 的变量分别属于自己的作用域；不是一个全局变量，也没有自动写入 State。这里还没有 State。

思考模式会涉及额外的 reasoning_content 历史处理，本章尚未实现，所以显式设置 disabled。不能只删掉这项配置就认为支持了思考工具调用。[DeepSeek：思考模式的配置与历史要求](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)

#### 运行后先看哪几个字段

在仓库根目录运行：

```bash
npm run typecheck
node --env-file=.env src/examples/ask-deepseek.ts
```

终端会打印原始响应。下面只展示阅读时要关注的字段，是结构示意，不是本次联网实测记录：

```json
{
  "choices": [{
    "finish_reason": "stop",
    "message": { "role": "assistant", "content": "连接成功" }
  }]
}
```

choices 是候选回复列表，本章只处理一个候选；`choices[0].message.content` 是回复文字。finish_reason 表示模型为什么结束这一段生成，这里 stop 表示自然结束。它不代表 Runtime 的任务已验收，当前入口根本没有调用完成规则。

真实响应还有 ID、用量等字段，措辞也可能不同，不要逐字比较整份 JSON。若出现 HTTP 401，先检查密钥；HTTP 402 检查余额；连接或 TLS 错误先调查网络；30 秒后停止则查看响应是否迟迟没有到达。[DeepSeek：错误码说明](https://api-docs.deepseek.com/quick_start/error_codes)

到这里完成的是“配置 → 发一次请求 → 读到一次响应”。确认连接后，再把这份能力接到 Runtime。

## 第二阶段：把模型接口接到已有契约

接下来有四个已有文件需要迁移：types.ts、tool.ts、tool-registry.ts、read-source-tool.ts。完成本阶段全部修改后再运行整项目检查，避免将迁移到一半的缺字段当成最终故障。

第一阶段的两个文件已经接起来：ask-deepseek.ts 读取配置、创建一次等待控制，调用 http.ts，再打印返回的原始响应并清理；http.ts 只负责请求与响应。前者是可直接运行的观察入口，后者是接下来会复用的适配模块，二者尚未组成 Agent Loop。

### 4. 保存工具调用附带的文字

在 `src/runtime/types.ts` 中，用以下整段替换 Action，其他类型保持不变：

<<< ../snippets/05/src/runtime/types.ts#actions

上一章的 tool Action 只有 kind 和 call。真实模型还可能在提出读取时说一句“先查看源码”，所以新增可选 content 保存这句话。问号表示旧脚本可以不提供它，旧调用不用跟着重写。

下面是一个**用于理解类型的动作示意，不需要写入文件**：

```ts
const action = {
  kind: "tool",
  content: "先查看源码。",
  call: {
    id: "call_abc",
    name: "read_source",
    arguments: { path: "src/sum.ts" },
  },
};
```

content 是模型附带文字；call 才是要执行的请求，源码不在这里。循环原来就会把整个 action 记录为 assistant 消息，所以增加字段后不必修改记录语句。工具执行成功后，源码仍另存为 tool 消息，不能拿“先查看源码”这句话充当已读取的证据。

### 5. 让工具同时提供说明与本地执行入口

在 `src/runtime/tool.ts` 中，保留 ParseResult、ToolOutput，用以下两个类型替换原 Tool 与 ToolDefinition：

<<< ../snippets/05/src/runtime/tool.ts#callable

#### 为什么工具需要两种信息

第 4 篇的工具已经知道怎么检查与执行，但这些是本地函数。远程模型不能通过一个 JavaScript 函数引用知道该传什么参数。因此现在补 description 和 parameters，让工具同时保存“给模型看的说明”和“本地执行的实现”：

| 字段 | 谁使用 | read_source 中的作用 |
|---|---|---|
| name | 模型和本地注册表 | 用 read_source 指定同一种工具 |
| description | 模型 | 说明这个工具能读取什么 |
| parameters | 模型接口 | 描述参数对象应包含字符串 path |
| parse | 本地 invoke | 检查本次实际传入的值是否允许执行 |
| execute | 本地 invoke | 参数合格后执行操作 |
| invoke | 本地执行器 | 把检查和执行封装成统一入口 |

parameters 使用 JSON Schema，也就是用 JSON 对象描述数据规则；它不是函数。`ToolDefinition<Args>` 中的 Args 把 parse 成功产出的参数类型与 execute 接收的类型连在一起。Tool 则是 defineTool 包装后可注册的对象，对外提供统一 invoke。

类型定义本身还不会复制说明，也不会发请求。接下来修改实际创建对象的函数。

再用下面完整函数替换 defineTool：

<<< ../snippets/05/src/runtime/tool.ts#define

这次新增的保存动作发生在返回对象开头：name 和 description 从 definition 取出，parameters 用 structuredClone 复制后保存。复制的是参数描述对象，不是去复制 execute 函数。创建工具时还没有调用 invoke，也不会读取源码。

invoke 内部顺序沿用上一章：先检查停止信号，再让 parse 检查原始 input；只有 parsed.ok 为 true 才把 parsed.value 交给 execute。value 接住执行返回值后，包装成 `{ status: "ok", value }`。

以 `{ path: "src/sum.ts" }` 为例，parse 交出已检查的参数，execute 返回源码字符串。若传入 `{ path: 123 }`，parse 返回失败，invoke 交回 invalid-arguments，execute 不会运行。这些本地检查不会因为新增 parameters 就消失。

#### 注册时也要保留新字段

接着修改 `src/runtime/tool-registry.ts`：找到原先保存 `{ name: tool.name, invoke: tool.invoke }` 的 byName.set 语句，用下面整条替换，其他代码保留：

```ts
byName.set(tool.name, {
  name: tool.name,
  description: tool.description,
  parameters: structuredClone(tool.parameters),
  invoke: tool.invoke,
});
```

原因在于注册表不是直接存原工具对象，而是创建另一份对象放进 Map。如果这里只保留 name、invoke，即使原工具有 description，稍后 `registry.get("read_source")` 取出的对象也没有它。

修改后，工具说明沿着这条路径保留：

```text
工具定义 definition
  → defineTool 返回 Tool
  → 注册表保存名称、说明、参数描述和 invoke
  → 模型适配器取名称、说明、参数描述
  → 本地执行器取 invoke
```

同一份注册信息连接模型和本地执行。稍后发给服务时只提取前三项，不发送本地函数。这些对象是程序启动时的内存配置，不属于某次运行的 State 消息。

到这里，tool.ts 仍负责把检查与操作组成 Tool，tool-registry.ts 仍负责保存和查找这些对象；本篇只是让两者在创建、注册时一并保留模型可读说明。后面适配器从同一张表提取说明，执行器从中取 invoke，两者不会因为新增描述字段就直接调用对方。

### 6. 给读取工具补上准确的参数说明

在 `src/examples/read-source-tool.ts` 中，保留顶部导入和 parseReadSourceArgs；用下面完整定义替换原 readSourceTool：

<<< ../snippets/05/src/examples/read-source-tool.ts#definition

#### 用一份参数读懂这份声明

本例希望模型提出的参数是：

```json
{ "path": "src/sum.ts" }
```

与上面的 parameters 逐项对照：

| 声明 | 约束含义 | 对应例子 |
|---|---|---|
| type:"object" | 参数整体应是对象 | 不能只返回字符串 `"src/sum.ts"` |
| properties.path | 描述 path 字段 | 这个字段代表读取路径 |
| type:"string" | path 应是字符串 | 不能是数字 123 |
| enum:[sourcePath] | 值限定在列表中 | 这里仅允许 src/sum.ts |
| required:["path"] | 必须包含 path | 空对象不满足描述 |
| additionalProperties:false | 不接受其他字段 | 不应增加未声明的 mode 等参数 |

这些描述帮助模型生成调用；真正来到本地的仍是外部数据，必须经过 parseReadSourceArgs。声明负责告诉模型“应该生成什么”，parse 负责决定“这次实际值能否执行”。如果以后允许新路径，两边规则都要同步修改。

execute 这次只打印路径并返回 sourceCode；它并没有调用文件系统。修改 description 为“能读任意文件”不会让它真的具备该能力，所以说明必须符合实现。

本篇使用标准接口，不启用 Beta strict 模式；不能把 parameters 描述当作服务保证输出总是合格。[DeepSeek：strict 模式的额外要求](https://api-docs.deepseek.com/zh-cn/guides/tool_calls/#strict-模式beta)

### 7. 把内部消息转成接口消息

新建 `src/adapters/deepseek/protocol.ts`。先写导入：

```ts
import type { Action, DecisionContext } from "../../runtime/types.ts";
```

接着写入以下类型与完整函数，后面再追加响应解码：

<<< ../snippets/05/src/adapters/deepseek/protocol.ts#messages

#### 先辨认三份消息

这里最容易混淆的是下面三个位置：

| 位置 | 谁创建或持有 | 用途 |
|---|---|---|
| `state.messages` | Runtime 持有并更新 | 这次运行已经记录的用户任务、动作和工具结果 |
| `context.messages` | buildDecisionContext 从 State 复制 | 本轮交给 decide 的输入 |
| 函数中的局部 `messages` | buildDeepSeekMessages 新建 | 本次发给 DeepSeek 的接口消息 |

buildDeepSeekMessages 接收 Context 与 systemPrompt，返回第三份数组。它没有 State 参数，不会往 State 里追加消息。每轮都重新转换当前 Context，因此上一轮刚写回的结果能进入下一次请求。

DeepSeekMessage 是本章声明的接口消息类型，不是运行中的历史对象。system 表示应用行为说明，user 表示用户任务，assistant 表示模型回复或请求，tool 表示某次调用的结果。

#### 第一次调用：只有用户任务时怎样转换

先看输入，以下是**数据示意，不需要写入实现文件**：

```ts
const context = {
  messages: [{
    role: "user",
    content: "请诊断 src/sum.ts 中 sum([]) 失败的原因，并给出最小修复建议。",
  }],
};
```

沿函数从上到下执行：

1. 创建局部 messages，第一项放入 `{ role: "system", content: systemPrompt }`。
2. for 遍历 context.messages，当前只有一条 user。
3. 命中 user 分支，将该消息的 content 放入新的 user 消息。
4. 遍历结束，返回局部 messages。调用方接到的是 `system -> user` 两条接口消息。

systemPrompt 由应用提供，用来说明先读取、再诊断等要求。它是在转换时加进去的，所以服务看到两条消息，State 此刻仍只有一条 user。数组长度不同是正常的。

#### 第二次调用：新增的请求与结果怎样转换

假设模型第一次提出读取，工具也执行成功。Runtime 会保留一条 assistant 请求和一条 tool 结果。下面先单独看这两条新增记录，sourceCode 表示前面展示的固定源码：

```ts
// 数据示意：这是 state.messages 中新增的两项，不是新增实现。
const request = {
  role: "assistant",
  action: {
    kind: "tool",
    content: "先查看源码。",
    call: { id: "call_abc", name: "read_source", arguments: { path: "src/sum.ts" } },
  },
};
const observation = {
  role: "tool",
  result: { callId: "call_abc", status: "ok", value: sourceCode },
};
```

第二次转换仍先加 system，再遍历 user、assistant、tool，得到四条接口消息。两条新增记录分别走不同分支：

- **assistant 请求**：取出 action 中的 call 和 content，用 call.id 作为 tool_calls[0].id，用 call.name 作为 function.name，用 JSON.stringify 将参数对象转换成 function.arguments 字符串。
- **tool 结果**：用 result.callId 作为 tool_call_id，将整个 result 转成 content 字符串。模型不仅看到源码，也能看到 status 与调用身份。

两种转换后的字段对应如下：

```text
原 assistant.action.call.id         "call_abc"
  → 接口 assistant.tool_calls[0].id "call_abc"

原 tool.result.callId               "call_abc"
  → 接口 tool.tool_call_id          "call_abc"

原 call.arguments                  { path: "src/sum.ts" }，对象
  → 接口 function.arguments        '{"path":"src/sum.ts"}'，字符串
```

同一个 ID 将“模型提出的请求”与“本地得到的结果”连起来。这里保留模型生成的 ID，不能继续把每次真实调用都固定为旧脚本的 read-1。[DeepSeek：工具结果关联示例](https://api-docs.deepseek.com/zh-cn/guides/tool_calls/)

**讲解摘录 · 把本地结果转换为接口的 tool 消息（无需写入文件）**

<<< ../snippets/05/src/adapters/deepseek/protocol.ts#explain-result

content 中的 `content ?? null` 表示：有文字就保留，没有提供或为 null 就使用 null；空字符串仍是空字符串。它处理的是附带文字，不影响 call。发送工具结果时则保留整个 result，工具失败时 code 与 message 也会进入下一轮。

#### 剩余分支为什么存在

本例两轮正常运行主要经过 user、assistant tool、tool 三个分支。finish 分支将已有答案转成普通 assistant 文本；fail 分支直接拒绝，因为它表示任务已主动终止。正常循环不会在 fail 后再请求模型，这个检查防止外部手工构造此类 Context 后继续调用。

转换只覆盖本章的文本、单工具、非思考模式。JSON.stringify 是格式转换，不负责验证任意值都能表示为 JSON；本例消息与结果使用可表示的数据。

### 8. 检查响应，并转换成 Action

继续在 `protocol.ts` 末尾追加三个检查函数：

<<< ../snippets/05/src/adapters/deepseek/protocol.ts#helpers

这些辅助函数处理“外部数据能不能继续往下读”的问题：

| 函数 | 成功时交回什么 | 失败例子 |
|---|---|---|
| isRecord | true，并帮助 TypeScript 确认是可按键读取的对象 | null 或数组返回 false |
| record | 原来的对象 | 传入字符串时抛错 |
| nonEmptyText | 原来的非空字符串 | 空字符串、只有空格或数字时抛错 |

`Record<string, unknown>` 表示键是字符串、值尚未确认的对象；它没有声称某个字段一定存在。`value is ...` 是类型谓词，表示这次布尔检查成功后，TypeScript 可以按该类型继续分析。它依赖实际检查，不是用 `as Action` 直接跳过检查。

label 只用于错误信息，例如 record 检查 response 失败时说明哪个位置需要对象。函数返回原值，没有修改 State。

然后追加完整解码函数：

<<< ../snippets/05/src/adapters/deepseek/protocol.ts#decode

#### 拿一份工具响应，从入口走到返回值

requestDeepSeek 返回 payload:unknown，decodeDeepSeekAction 负责把它变成 Action。**下面是结构示意，不是要求新增到文件里的固定响应，也不是联网实测记录：**

```json
{
  "choices": [{
    "finish_reason": "tool_calls",
    "message": {
      "role": "assistant",
      "content": "先查看源码。",
      "tool_calls": [{
        "id": "call_abc",
        "type": "function",
        "function": {
          "name": "read_source",
          "arguments": "{\"path\":\"src/sum.ts\"}"
        }
      }]
    }
  }]
}
```

对照解码函数分段阅读：

1. **取得候选消息**：record 确认 payload 是对象，root 接住；确认 root.choices 是数组且只有一项，再用 choice 接住这一项，message 接住其中的消息对象。
2. **确认消息能处理**：role 必须是 assistant，本章不接收非空 reasoning_content；content 必须是字符串或 null。calls 接住 tool_calls，没有提供时先用空数组。
3. **进入工具分支**：finish_reason 为 tool_calls，要求 calls 恰有一项；call 接住它，fn 接住 call.function。继续确认 type 是 function，以及 ID、名称、参数文本都不是空值。
4. **解析参数**：rawArguments 此刻仍是字符串。JSON.parse 后 args 才变成 `{ path: "src/sum.ts" }` 对象；record 再确认它确实是对象，而不是数组或数字。
5. **交回动作**：把取得的 id、name、参数对象与附带文字组成 tool Action，return 给调用方。

最终交回的值是：

```ts
// 解码结果示意：只交回请求，尚未运行 read_source。
const action = {
  kind: "tool",
  content: "先查看源码。",
  call: {
    id: "call_abc",
    name: "read_source",
    arguments: { path: "src/sum.ts" },
  },
};
```

**讲解摘录 · 参数文本需要再解析一次（无需写入文件）**

<<< ../snippets/05/src/adapters/deepseek/protocol.ts#explain-arguments

这里有两次不同的 JSON 解析：HTTP 函数里的 response.json 解析整份响应；解码器里的 JSON.parse 再解析 function.arguments。后者在接口中本来就是字符串，所以第一次解析后仍需要单独处理。

#### 返回 tool Action 为什么还不能立即执行

解码器只确认“这份外部数据能形成请求”。例如参数解析成 `{ path: 123 }` 仍是对象，这一步可以形成 tool Action，但本地 parseReadSourceArgs 随后会拒绝它。

同样，模型给出一个非空的未知工具名，仍要由注册表查找决定是否存在。把这些职责分开后，接口转换不必知道每个工具的业务参数规则，执行器仍保留统一检查入口。调用成功、参数允许、任务完成是不同判断。

#### 模型直接给答案时，走另一条分支

假设响应的 finish_reason 为 stop，content 是非空诊断文字，而且没有工具调用。前面的结构检查通过后，不进入工具分支；最后返回 `{ kind: "finish", answer: content }`。

stop 表示这段模型生成自然结束，finish 表示本项目收到候选答案，completed 则必须等循环调用应用完成规则后才能产生。模型可以跳过读取直接回答，本章会在完成规则那里拒绝缺少证据的答案。

#### 哪些响应会在这里被拒绝

| 输入问题 | 拒绝位置 | 为什么不能继续 |
|---|---|---|
| choices 为空或多于一项 | 开头数量检查 | 本适配器没有定义如何选择多个候选 |
| 一次提出多个调用 | calls.length 检查 | 当前循环只接收一个 tool Action |
| arguments 不是合法 JSON | JSON.parse 的 catch | 还没有可交给工具的参数对象 |
| arguments 是数组或数字 | record(args) | 不符合本项目参数对象契约 |
| finish_reason 为 length | 最后的结束原因检查 | 生成因输出额度结束，不能当作完整动作或答案 |
| 答案只有空格 | nonEmptyText | 没有可供应用验收的答案 |

这些失败发生在 decide 返回 Action 之前，不应出现工具执行日志。[DeepSeek：响应字段与结束原因](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/)

#### protocol.ts：同一文件里的两个转换方向

前两步在同一文件里先写消息转换、再写响应解码，现在可以作为一个整体看。这个文件对外提供两条独立路径：

```text
发请求前：Context ＋ systemPrompt
  → buildDeepSeekMessages → DeepSeekMessage[]

收响应后：payload:unknown
  → decodeDeepSeekAction → 检查结构与结束原因 → Action
```

record、isRecord、nonEmptyText 是解码用的内部辅助函数；两个公开函数不相互调用，也不自行发 HTTP 请求。后面的 decider 会在请求前后分别调用它们，把输入、输出转换接成一次决策。

文件内的 messages、payload 和 action 都是一次调用中的数据，没有第二份隐藏会话。向服务提供历史，需要从 Runtime 当前 Context 重新构造；保存新动作也仍由 Runtime 负责。

#### 先离线看见一次“响应变成动作”

完成第 4～8 步后，先运行类型检查，再做一次不需要密钥的小观察。它只使用刚写好的解码函数与消息转换函数，没有另建框架，也不会发送请求。在仓库根目录复制运行：

```bash
npm run typecheck
node --input-type=module <<'JS'
import { decodeDeepSeekAction, buildDeepSeekMessages } from "./src/adapters/deepseek/protocol.ts";
import { sourceCode } from "./src/examples/diagnosis-fixture.ts";

// 人工构造一份响应，只观察本地转换，不代表真实模型输出。
const payload = {
  choices: [{
    finish_reason: "tool_calls",
    message: {
      role: "assistant",
      content: "先查看源码。",
      tool_calls: [{
        id: "call_abc",
        type: "function",
        function: { name: "read_source", arguments: JSON.stringify({ path: "src/sum.ts" }) },
      }],
    },
  }],
};
const action = decodeDeepSeekAction(payload);
console.log("解码动作（action）:", JSON.stringify(action, null, 2));

// 为观察第二次请求，手工准备已含结果的 Context；这里没有实际执行工具。
const context = {
  messages: [
    { role: "user", content: "请诊断 sum([]) 失败的原因。" },
    { role: "assistant", action },
    { role: "tool", result: { callId: "call_abc", status: "ok", value: sourceCode } },
  ],
};
const messages = buildDeepSeekMessages(context, "先读取，再诊断。");
console.log("接口消息（messages）:", JSON.stringify(messages, null, 2));
JS
```

观察两个结果：action.call.arguments 是对象；接口 assistant.tool_calls 中的 arguments 又成为字符串。接口消息共有 system、user、assistant、tool 四项，两处调用 ID 都是 call_abc，最后一条 content 中包含源码。这说明转换关系接上了；此实验没有检查真实网络和 Runtime 写回，后面再运行完整入口。

### 9. 组装真正的 decide

新建 `src/adapters/deepseek/decider.ts`，先写顶部导入与配置类型：

```ts
import type { Dependencies } from "../../runtime/types.ts";
import type { ToolRegistry } from "../../runtime/tool-registry.ts";
import { requestDeepSeek } from "./http.ts";
import { buildDeepSeekMessages, decodeDeepSeekAction } from "./protocol.ts";
```

<<< ../snippets/05/src/adapters/deepseek/decider.ts#options

然后追加完整创建函数：

<<< ../snippets/05/src/adapters/deepseek/decider.ts#factory

#### 先分清“创建 decide”和“调用 decide”

createDeepSeekDecider 返回一个函数。`Dependencies["decide"]` 的意思是取出 Dependencies 类型中 decide 属性的类型；所以返回函数必须符合已有的 `(context, signal) => Promise<Action>` 接口。

这不是创建函数时就运行一次决策。下面是调用关系示意，第 11 步会提供完整入口：

```text
程序启动时
  createDeepSeekDecider(options)
    → 读取固定配置与工具说明
    → 返回一个 async 函数
    → 入口用 decide 变量保存这个函数

任务运行时，每一轮
  runAgentLoop 调用 decide(context, signal)
    → 返回函数的函数体才开始执行
    → 发请求，取得响应，转换为 Action
```

外层函数结束后，返回的函数还能使用 apiKey、model、systemPrompt、tools；这是闭包：函数保留了访问创建它时那些变量的能力。不同轮次重新传入 context，不需要重新创建固定配置。

#### 创建阶段：tools 从哪里来

先看 `registry.names().map(...)`。假设只注册了 read_source：

1. names 返回 `["read_source"]`。
2. map 对这个名称执行回调，registry.get(name) 取得已注册工具对象。
3. 回调只取 name、description、parameters，组成接口要求的 `{ type: "function", function: ... }`。
4. map 返回数组，tools 保存它，后续每次请求都使用这份清单。

发送的结构如下，只表示工具能力说明，不是模型已经提出的某次调用：

```json
{
  "type": "function",
  "function": {
    "name": "read_source",
    "description": "读取指定源码文件的内容；本例仅提供 src/sum.ts。",
    "parameters": {
      "type": "object",
      "properties": { "path": { "type": "string", "enum": ["src/sum.ts"] } },
      "required": ["path"],
      "additionalProperties": false
    }
  }
}
```

不要混淆 tools 与 tool_calls：tools 是应用在请求里提供的可用工具清单；tool_calls 是模型在响应里提出的实际请求，才会有本次调用 ID 和参数。invoke 没有被发送，远程服务拿不到本地函数。

#### 调用阶段：按一个返回值走完 decide

**讲解摘录 · 取得响应，再转换为内部动作（无需写入文件）**

<<< ../snippets/05/src/adapters/deepseek/decider.ts#explain-model-call

进入返回的 async 函数后，按变量接收的顺序读：

| 语句位置 | 变量接到什么 | 交给谁 |
|---|---|---|
| buildDeepSeekMessages(context, systemPrompt) | messages，接口消息数组 | requestDeepSeek 的请求体 |
| await requestDeepSeek(...) | payload，原始响应 JSON | decodeDeepSeekAction |
| decodeDeepSeekAction(payload) | action，本项目的 tool 或 finish 动作 | 检查 ID 后 return 给循环 |

第一次 context 只有用户任务，messages 就是 system 与 user。HTTP 请求体还同时带 tools，模型因此既知道要诊断什么，也知道可申请哪种本地操作。tool_choice:"auto" 表示让模型选择是否调用工具；“必须先读”的应用要求仍需提示词和完成检查配合。

拿到响应后，payload 不直接交给执行器，而是先解码。action.kind 日志显示的是解码后的动作类型。直到 `return action`，本函数仍没有执行工具、没有增加 decisions，也没有写入 State。循环中的 `dependencies.decide(context, signal)` 才是接住这个返回值的位置。

requestDeepSeek 中的 signal 来自本轮调用，最终传给 fetch。非思考、非流式和 max_tokens:1024 是本例请求配置；这里的输出额度与循环最多决策 5 次是两件事，不能用增加次数解决一份响应被截断的问题。

#### 为什么返回前还检查调用 ID

如果这次得到 tool Action，代码会查看 context.messages 中是否已有 assistant 工具请求使用同一个 ID。some 找到任意一条符合条件的记录就返回 true；条件只比较工具请求的 ID，不是禁止再次使用同一个工具名。

例如历史中已出现 call_abc，再收到 call_abc 就抛错；新 ID call_def 再读同一路径可以通过这个检查。当前代码防止调用身份混淆，尚未判断重复读取是否有价值，也不保证操作幂等。

注册表只在创建阶段提取说明，本章不支持运行过程中更新工具清单。每轮最多一个工具请求由解码器实际检查，不能只依赖提示词；本例没有设置未经该接口文档确认的 parallel_tool_calls 字段。

完成这一步后运行：

```bash
npm run typecheck
```

此时真实 decide 已能创建，但还没有入口把它交给循环。下一阶段补应用规则与完整组装。

### decider.ts：把已有模块组装成一次真实决策

createDeepSeekDecider 的输入是密钥、模型名、提示词与注册表，返回值是符合 Dependencies.decide 的函数。创建阶段只准备工具说明；调用返回函数时，才进行“Context → protocol 转消息 → http 取响应 → protocol 解码 → 检查调用 ID → Action”。

这是本章三个适配文件的分工：decider.ts 安排一次决策所需的调用顺序，http.ts 管传输，protocol.ts 管数据约定。runAgentLoop 调用 decide 并等待一个 Action；适配器不自己开工具循环，也不记录 State，所以下一轮仍由原 Runtime 驱动。

## 第三阶段：先写清应用规则，再运行同一个 Runtime

### 10. 应用提供提示词与完成规则

新建 `src/examples/deepseek-scenario.ts`，写入导入：

```ts
import type { State } from "../runtime/types.ts";
import { sourcePath, sourceCode } from "./diagnosis-fixture.ts";
```

追加本例提示词：

<<< ../snippets/05/src/examples/deepseek-scenario.ts#prompt

diagnosisPrompt 是几句文字，用换行连接为一个字符串。它告诉模型三件事：先读取源码、每次最多请求一个工具、用中文解释原因并提出最小修复建议。

这段配置属于诊断应用，所以放在 examples/deepseek-scenario.ts；通用循环不应固定知道 sum 或 read_source。以后换成别的任务，应该更换提示词与相应工具，而不是往循环中加入业务判断。

提示词没有包含旧脚本的预设 diagnosis，模型要根据工具结果生成回答。但“请先读取”仍只是发给模型的要求，模型也可能直接回答。为避免这种情况下被当成任务完成，还需要本地检查读取证据。

再追加完整完成检查：

<<< ../snippets/05/src/examples/deepseek-scenario.ts#evidence

#### 为什么旧完成规则不能直接复用

旧 hasDiagnosisEvidence 使用固定答案与固定 read-1。真实模型的措辞和调用 ID 都可能变化，即使正常读取并正确回答，也不一定符合旧常量。

新规则检查的是：答案不是空白，历史里确实有针对本例路径的请求，而且后面有匹配的成功源码结果。它返回 boolean，供循环决定是否接受 finish。

#### 用四条历史记录走一次检查

假设正常运行记录如下，括号中是数组下标：

```text
(0) user       用户诊断任务
(1) assistant  tool 请求：call_abc，read_source，path 为 src/sum.ts
(2) tool       成功结果：callId 为 call_abc，value 为 sourceCode
(3) assistant  finish：本次模型生成的诊断与建议
```

循环已经记录 finish 才调用 hasReadEvidence，所以这里看得到四条消息。对照函数逐步检查：

1. `answer.trim()` 确认答案不是空白。空白立即返回 false，不继续查历史。
2. index 为 0 时，request 是 user，不满足 assistant 工具请求条件，continue 跳到下一次遍历。
3. index 为 1 时，request 是 tool Action，call 接到里面的请求；核对名称和路径，确认它是本例要读取的文件。
4. `state.messages[index + 1]` 取得紧随请求的观察，即下标为 2 的 tool 消息。核对 role、调用 ID、status、源码值。
5. 全部符合才返回 true；若遍历结束仍找不到这样的记录，返回 false。

index + 1 能用于取对应结果，是因为当前循环逐个执行工具，结果紧跟请求记录。以后支持并发批次时，要重新设计查找方式，不能继续默认相邻。

例如模型第一次就回答，State 只有 user 和 assistant finish，没有成功读取，函数返回 false。若工具结果是 error，或 callId 不匹配，也不能作为成功读取证据。答案里声称“我已经读过”不能代替这些运行记录。

本检查只证明**本例确有读取证据并取得非空答案**。它没有自动判断诊断是否正确，也没有修改文件、运行修复验证；这些事情不能从 completed 这个名称推断出来。真实诊断仍需核对内容。

#### deepseek-scenario.ts：应用要求怎样进入与退出运行

本文件导出两项本例规则：diagnosisPrompt 在请求前进入适配器，用文字说明要完成什么；hasReadEvidence 在模型提出 finish 后由循环调用，用历史记录判断是否允许本例完成。它们服务于运行的不同位置，不是先调用一个函数就自动触发另一个。

提示词不是验证结果，完成检查也不负责请求模型。把二者放在场景文件中，是因为换任务时这些要求会一起变化，而通用 HTTP、消息转换与运行调度不应内置 sum 的规则。

### 11. 用短入口组装并运行

新建 `src/examples/deepseek-agent.ts`，写入完整内容：

这个入口要把已实现的 HTTP、协议转换与循环真正连起来：创建能请求模型的 decide → 与本地执行器一起交给原循环 → 等最终结果。这里不再实现模型协议或工具逻辑。

**第 1 步：读取连接配置。** 在 `src/examples/deepseek-agent.ts` 中先写入以下内容：

<<< ../snippets/05/src/examples/deepseek-agent.ts#tutorial-part-1

导入的循环、工具与完成规则均已实现。apiKey 和 model 从环境变量取值；缺少密钥会在启动任务前退出，尚未发模型请求。不要把密钥改写成源码中的字符串。

**第 2 步：让模型说明与本地执行共用注册表。** 在 `src/examples/deepseek-agent.ts` 末尾追加以下完整代码：

<<< ../snippets/05/src/examples/deepseek-agent.ts#tutorial-part-2

registry 既提供模型可见的工具说明，也供本地按名称执行。createDeepSeekDecider 返回 decide 函数，此处只是创建它，真正调用要由后面的循环安排。

**第 3 步：启动已有循环并等待。** 在 `src/examples/deepseek-agent.ts` 末尾追加以下完整代码：

<<< ../snippets/05/src/examples/deepseek-agent.ts#tutorial-part-3

本章新增的连接是把真实 decide 传进去。循环仍负责记录动作、执行工具、写回结果与再次决策；5 是决策额度，timeoutMs 是本次运行时间限制。

**第 4 步：显示已经返回的结果。** 在 `src/examples/deepseek-agent.ts` 末尾追加以下完整代码：

<<< ../snippets/05/src/examples/deepseek-agent.ts#tutorial-part-4

这里读取的是 RunResult，completed 才显示正式答案，failed 显示来源与原因。日志不会替循环判断完成，也不会把接口原始响应直接当答案。

三个依赖各自回答一个不同问题：

| 依赖 | 回答的问题 | 本章提供者 |
|---|---|---|
| decide | 根据当前消息，下一步做什么？ | DeepSeek 适配器 |
| executeTool | 这个请求能否执行，执行得到什么？ | 注册表与本地工具执行器 |
| validateFinish | 这个候选答案是否满足本例完成要求？ | hasReadEvidence |

同一份 registry 用于模型工具说明和本地执行查找。否则容易发生模型看见一个工具、本地却没有注册的情况。5 是最多取得 5 次动作，120_000 是一次运行最多 120 秒；都是本例配置，不是生产服务的固定指标。

#### 先运行，再把日志对应回数据

配置好 .env 后，在仓库根目录运行：

```bash
npm run typecheck
node --env-file=.env src/examples/deepseek-agent.ts
```

**以下是典型两轮轨迹的示意。模型回复、ID 与轮数可能变化，不是预先承诺的实测输出：**

```text
[请求模型 model] 消息角色（roles）=system -> user
[模型动作 action] tool
[执行工具 execute] read_source 文件路径（path）=src/sum.ts
[请求模型 model] 消息角色（roles）=system -> user -> assistant -> tool
[模型动作 action] finish
运行结果（outcome）: completed
决策次数（decisions）: 2
消息顺序（messages）: user -> assistant -> tool -> assistant
模型答案（answer）: ……模型本次生成的诊断与建议……
```

第一条日志来自适配器，表示转换后准备发送的消息角色；不能单凭它判断 HTTP 已成功。第二条在响应解码后出现，表示取得了 tool Action。第三条来自读取工具的 execute，说明请求已到本地执行体。它不是模型打印的，也不是服务替本地执行了函数。

第二次 model 日志出现 assistant 与 tool，表示本次准备发送的输入中已含上一轮请求与结果。调试时还要展开 content，确认里面确实是源码，不能只凭角色名称断言内容正确。

合理诊断应指出：没有初始值的 reduce 在空数组上失败，提供初始值 0 可以处理空数组。模型措辞可以变化，完成规则也没有自动证明这段诊断正确。

#### 对照已有循环，看 State 真正在哪里改变

前面的解码器、HTTP 函数都没有写 State。真正的记录语句仍在 `src/runtime/agent-loop.ts`。下面是**已有代码回顾，不需要再次追加或修改**：

```ts
// 已取得并检查 action 后，循环记录模型动作。
state = {
  ...state,
  decisions: state.decisions + 1,
  messages: [...state.messages, { role: "assistant", action }],
};
```

工具执行成功、结果 ID 匹配后，循环再记录工具结果：

```ts
// 仍由循环写回，执行器不直接接触内部 State。
state = { ...state, messages: [...state.messages, { role: "tool", result }] };
```

用这两处更新，对照一次正常运行的计数与消息：

| 时刻 | decisions | State 中的消息 | 此时发生什么 |
|---|---:|---|---|
| 刚启动 | 0 | user | 第一轮 Context 由此构造 |
| 收到 tool Action 并记录 | 1 | user → assistant | 请求已记录，还没取得工具结果 |
| 读取完成并写回 | 1 | user → assistant → tool | 工具执行不另算一次决策 |
| 回到 while，准备第二轮 | 1 | user → assistant → tool | 重新构造 Context，再转换接口消息 |
| 收到 finish 并记录 | 2 | user → assistant → tool → assistant | 完成规则通过后返回 completed |

这解释了为什么不需要在工具里主动调用模型。工具只返回数据；循环写回后回到 while，才会再次调用 decide。若工具已返回，但缺少第二处写回，下次 Context 就没有源码，真实模型也不会凭空知道结果。

Context 的构造只选择并复制消息；decisions 和整个控制器都不会发给模型。转换时加上的 systemPrompt 也没有写入 State，所以第二轮网络请求有四条消息，而当时 State 只有三条。

同样，模型返回 finish 后，仍由原循环调用 hasReadEvidence。若没有读取证据，返回的是 validation 来源的 failed；不会因为 HTTP 成功、模型停止生成就直接完成任务。

原有入口继续保留作对照：

```bash
node src/examples/first-loop.ts
node src/examples/inspect-tools.ts
node src/examples/inspect-context.ts
```

它们仍使用原脚本场景，不需要密钥。真实模型接入是替换一个依赖，不是删除所有可重复观察的入口。

### deepseek-agent.ts：正式使用方式的组装入口

整个文件从环境配置开始，建立注册表与真实 decide，再把 decide、统一执行器和应用完成规则交给 runAgentLoop；最终接住 RunResult 并显示。这就是使用当前 Runtime 发起一次任务的位置，不负责实现 HTTP、协议检查或 State 更新。

需要追调用时，从这个入口进入循环，再分别进入对应依赖；不能因为它导入了所有模块，就把各模块逻辑也写回这里。第 6 篇替换的是决策来源，原反馈链继续复用。

## 怎样调试：一次只找一个边界

调试命令：

```bash
node --env-file=.env --inspect-brk src/examples/deepseek-agent.ts
```

| 现象 | 先检查哪里 | 要观察的内容 |
|---|---|---|
| 普通消息都请求失败 | http.ts 的 fetch 与 HTTP 状态 | 地址、网络、密钥配置、账户状态 |
| 模型不知道工具 | decider.ts 创建 tools 处 | 注册表是否保留 description、parameters |
| 有工具响应，但没有执行 | decodeDeepSeekAction | finish_reason、调用数量、参数字符串能否解析 |
| 进入执行器但被拒绝 | 现有查找与参数检查 | 名称是否注册，path 类型与允许路径 |
| 模型下一轮不知道源码 | buildDeepSeekMessages | 是否有 assistant tool_calls 和对应 tool_call_id |
| 答案被完成规则拒绝 | hasReadEvidence | 历史请求与观察的 ID、状态和源码证据 |
| 等待过久后退出 | 既有 RunControl | timed-out 与 HTTP/解析失败分别处理 |

#### 第一次调试，只跟踪一份调用和一份源码

运行带 `--inspect-brk` 的命令后，程序会在开始处暂停。可在 Chrome 打开 `chrome://inspect`，找到该 Node 进程并进入调试器。调试连接方式可参照 [Node.js 调试指南](https://nodejs.org/en/learn/getting-started/debugging)。先给下面四处设置断点，再继续执行，不必同时展开整个响应。

1. **decider.ts，`const action = decodeDeepSeekAction(payload)` 之后**：观察 action.call.id、name、arguments。此时应是请求对象，尚未执行工具。若 action 是 finish，先看模型是否跳过读取。
2. **agent-loop.ts，工具结果写回 state 的语句之后**：观察 `state.messages.at(-1)`。应为 tool 消息，callId 对应这次请求，成功结果的 value 为固定源码。若没有来到这里，先查参数检查、取消或执行错误。
3. **decider.ts，第二轮 messages 构造之后、HTTP 请求之前**：观察 messages。确认 assistant.tool_calls 中的 id 与 tool.tool_call_id 相同，tool.content 中包含源码。这里有记录而模型回答不对，和这里根本没有记录，是不同问题。
4. **deepseek-scenario.ts，hasReadEvidence 内部**：观察传入的 state、answer，以及被选中的 request 和 observation。确认完成判断用的是运行证据，而非模型一句自述。

如果想展开 arguments 或 content 的字符串，在调试控制台用 JSON.parse 读取它；不要把字符串与对象混为一类数据。

例如模型再次要求读取，不要立即判断它“忘了”。先看第 2 处有没有写回，再看第 3 处有没有转换并准备发送；这两处都正常，才继续调查模型实际回复和提示词。按这条路径可以找到第一次偏离预期的位置。

主线确认后，再做下面两个独立故障实验。它们不需要把正常入口改造成一套人工故障框架。

## 两个单独的故障实验

### HTTP 失败不会变成工具执行

临时在命令前覆盖本次进程的密钥：

```bash
DEEPSEEK_API_KEY=invalid node --env-file=.env src/examples/deepseek-agent.ts
```

正常鉴权拒绝应表现为 decision 失败和 HTTP 状态说明，没有读取执行日志。该命令不修改 .env；下一次不带前缀即可恢复正常配置。若网络先失败，就先处理网络，不能将连接错误当作已经收到 401。

### 不完整响应不产生动作

下面是**离线解码实验**，不会调用模型，也无需密钥。在仓库根目录运行：

```bash
node --input-type=module <<'JS'
import { decodeDeepSeekAction } from "./src/adapters/deepseek/protocol.ts";
const incomplete = {
  choices: [{
    finish_reason: "length",
    message: { role: "assistant", content: "尚未完整", tool_calls: [] },
  }],
};
console.log(decodeDeepSeekAction(incomplete));
JS
```

应抛出 `Incomplete or unsupported model response`，不会返回 finish 或 tool Action。它只验证响应解码的拒绝行为，不是一次真实服务返回；不需要将这段实验另建成复杂示例工程。

## 对照 Pi：模型格式在边界转换

固定提交 `8efd314fa3d3232ce197d8d7a6a5660530b9d83e` 中，Pi 的 [streamAssistantResponse](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/agent/src/agent-loop.ts#L354) 在请求边界调用 convertToLlm，再向模型调用传入 signal。可对照本章“内部记录转换为模型输入”的职责位置；Pi 还处理流式事件，本章尚未实现。

本章使用 DeepSeek 的具体协议与自己的 Action 类型，不等同于 Pi 的消息格式，也没有实现其全部提供商兼容逻辑。下一篇再处理流式增量与完整提交边界，不能将本篇 HTTP JSON 读取改为 stream:true 就认为已经完成。

## 完整最终文件

以下只列本篇新增或修改文件。循环、RunControl、Context、执行器保持第 5 篇实现；不要用真实模型的自由回答替换旧脚本的固定诊断常量。

### .env.example

```text
# 复制为 .env 后，仅在 .env 填入自己的密钥；不要提交 .env。
DEEPSEEK_API_KEY=
DEEPSEEK_MODEL=deepseek-flash
```

### src/adapters/deepseek/http.ts

<<< ../snippets/05/src/adapters/deepseek/http.ts

### src/adapters/deepseek/protocol.ts

<<< ../snippets/05/src/adapters/deepseek/protocol.ts

### src/adapters/deepseek/decider.ts

<<< ../snippets/05/src/adapters/deepseek/decider.ts

### src/runtime/types.ts

<<< ../snippets/05/src/runtime/types.ts

### src/runtime/tool.ts

<<< ../snippets/05/src/runtime/tool.ts

### src/runtime/tool-registry.ts

<<< ../snippets/05/src/runtime/tool-registry.ts

### src/examples/read-source-tool.ts

<<< ../snippets/05/src/examples/read-source-tool.ts

### src/examples/ask-deepseek.ts

<<< ../snippets/05/src/examples/ask-deepseek.ts

### src/examples/deepseek-scenario.ts

<<< ../snippets/05/src/examples/deepseek-scenario.ts

### src/examples/deepseek-agent.ts

<<< ../snippets/05/src/examples/deepseek-agent.ts

## 验收与保存

检查四项行为：普通消息取得真实响应；模型提出的合法工具调用实际经过本地执行入口；下一次请求包含对应工具结果；响应或请求失败时不会先执行工具。典型两轮不是强制轮数，答案也不应逐字匹配旧常量。

恢复故障实验后，运行类型检查、真实入口与原脚本入口，确认分支和文件范围：

```bash
npm run typecheck
node --env-file=.env src/examples/ask-deepseek.ts
node --env-file=.env src/examples/deepseek-agent.ts
node src/examples/first-loop.ts
git branch --show-current
git status --short
git diff --stat
```

确认联网结果符合本例规则后，再复制提交命令。只暂存源码与空配置模板，不包含 .env：

提交同时包含本章源码和 `site/` 网站更新；推送章节分支后，还需将 Pull Request 合并到 main，Actions 才会发布网页。

```bash
git add -- .env.example src/adapters/deepseek/http.ts src/adapters/deepseek/protocol.ts src/adapters/deepseek/decider.ts src/runtime/types.ts src/runtime/tool.ts src/runtime/tool-registry.ts src/examples/read-source-tool.ts src/examples/ask-deepseek.ts src/examples/deepseek-scenario.ts src/examples/deepseek-agent.ts site/
git diff --cached --stat
git commit -F - <<'COMMIT'
第 06 篇：接入 DeepSeek 真实模型决策

在原有循环、状态和停止控制上连接 DeepSeek 非思考模式，保留模型与执行器的职责边界。

- 新增 HTTP 请求、消息转换、响应解码与决策适配
- 为工具补充模型可见说明和参数格式
- 保留工具调用附带文字，使用真实调用 ID 关联结果
- 新增最小连接入口与真实多轮诊断入口
- 拒绝不完整响应和当前不支持的多调用

验证：类型检查、真实接口及多轮诊断通过，旧脚本入口行为保持有效。未提交密钥配置。
COMMIT
git push -u origin codex/chapter-05-deepseek
```

提交正文中的真实接口验证以实际运行结果为准。没有配置密钥或联网尚未通过时，不能将离线验证写成真实服务已通过。
