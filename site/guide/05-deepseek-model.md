---
title: 第 05 篇｜接入 DeepSeek 真实模型
description: 先完成一次真实 API 调用，再将消息、工具说明和模型响应连接到已有 Runtime，完成非流式的多轮工具调用。
---

# 第 05 篇：让真实模型决定下一步

前四篇里，scriptedDecide 遇到 user 就提出读取，看到预期源码就给出固定答案。循环、工具检查和停止控制都在运行，但下一步已经被脚本写好。本篇把这个位置换成 DeepSeek 官方 API：模型接收本轮消息与工具说明，决定请求工具还是回答。

先用一个很短的入口确认“请求发出，服务返回”；再把同一个 HTTP 函数接到已有 Runtime。完成后，诊断任务应经历：模型要求读取 src/sum.ts → 本地工具返回源码 → Runtime 写回 → 下一次模型请求包含源码 → 模型给出诊断。**模型是真实的，读取体仍返回固定源码；本篇没有实际修改文件。**

本篇要理解的主线是“内部消息怎样变成接口请求，接口响应怎样变成内部动作”。循环与停止控制继续复用，不在模型适配器里再写一套循环。暂不处理流式输出、思考内容、多工具批次或自动重试。

## 推荐分支与运行前提

从第 4 篇已验证、已提交的本地版本创建：

```bash
git switch -c codex/chapter-05-deepseek
```

若分支已存在，用 `git switch codex/chapter-05-deepseek` 返回。命令均在仓库根目录执行。继续使用 Node 22.18 或更新版本及原有依赖，不安装模型 SDK；HTTP 请求使用 Node 自带 fetch。

本篇选定 DeepSeek 官方的 Chat Completions 接口、非思考模式，示例模型名为 `deepseek-flash`。这是编写时官方文档列出的模型名；模型可用性与账户状态仍以服务实际返回为准，不沿用旧文章中的 deepseek-chat 名称。[官方模型列表](https://api-docs.deepseek.com/quick_start/pricing/)

::: info 验证范围
本篇的类型、消息转换、模拟 HTTP 两轮交互、错误与取消路径已在独立候选工程验证。真实服务调用还需要本地有效密钥与可用账户；联网运行以你的实际结果为准。下方标为“典型轨迹”的模型输出用于解释流程，不是固定答案或逐字承诺。
:::

## 先看整个系统怎样变化

[![第 5 篇数据流：Context 经适配器转为 DeepSeek 消息，模型返回工具请求，解码成 Action；原循环执行、写回，再准备下一轮模型输入](/diagrams/deepseek-adapter-flow.svg)](/diagrams/deepseek-adapter-flow.svg)

点击图片可单独打开。蓝色区域是新增的接口适配，绿色区域沿用现有 Runtime；读取体仍是模拟的。

**适配器**是连接两种数据约定的代码。本项目内部用 Action 表达下一步，DeepSeek 接口使用 messages、tool_calls 等字段；两种格式不会因为都叫“消息”就自动兼容。

| 本项目中是什么 | 发给或取自 DeepSeek 时是什么 |
|---|---|
| user 消息的 content | user 消息的 content |
| assistant 的 tool Action | assistant 消息中的 tool_calls |
| ToolCall.id | tool_calls 中的 id |
| ToolResult.callId | tool 消息中的 tool_call_id |
| ToolCall.arguments 对象 | function.arguments 中的 JSON 字符串 |
| finish 动作的 answer | 普通 assistant 回答的 content |

模型接口返回的是请求数据，不会替你执行本地函数。名称、说明和参数格式让模型知道有哪些工具；真正执行仍走第 3 篇的注册表和执行器。[DeepSeek：工具调用流程](https://api-docs.deepseek.com/zh-cn/guides/tool_calls/)

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

这个函数只做一件事：带着密钥、请求体与 signal 请求 DeepSeek，返回服务给出的未知 JSON。它不知道 State，也不会执行工具。

正常调用时，apiKey 形成 Authorization 请求头；body 经 JSON.stringify 变为请求文本；fetch 返回 HTTP Response。状态成功后读取 response.json，payload 接住解析后的值，再 return 给调用方。body 中的字段由调用方提供，本函数不暗中增加会话历史。

这里有两种尚未确定的事：HTTP 成功不代表模型给出了完整答案，JSON 能解析也不代表字段符合 Action。因此返回类型保持 unknown，第二阶段再检查。

非成功 HTTP 状态会先取消尚未使用的响应体，再抛出带状态码的错误。signal 直接交给 fetch，使第 4 篇的停止通知可以到达实际网络请求；本函数不另外建立自己的计时器。[DeepSeek：Chat Completions 接口](https://api-docs.deepseek.com/api/create-chat-completion/)

### 3. 用一个短入口确认连接

新建 `src/examples/ask-deepseek.ts`，写入完整内容：

<<< ../snippets/05/src/examples/ask-deepseek.ts

先认清三个变量：apiKey 与 model 从本机环境读取，control 复用上一章的等待控制。control.wait 启动一次 requestDeepSeek，payload 接住服务原始响应；finally 清理计时器。这里没有 Agent Loop、工具或 State。

请求的 messages 只有一条 user 消息，内容是“请只回复：连接成功”。stream:false 表示取得完整响应后再处理。thinking.disabled 显式关闭思考模式；本章不保存或回传 reasoning_content，不能只删除这一配置就认为已经支持思考工具调用。[DeepSeek：思考模式及历史回传要求](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)

运行：

```bash
npm run typecheck
node --env-file=.env src/examples/ask-deepseek.ts
```

原始 JSON 通常含 choices 数组；在其第一项的 message.content 中应能找到回答。response.id、用量和具体措辞可能变化，不要逐字对比整份 JSON。此时只确认请求与响应链路，**没有完成工具调用，也没有实现循环决策**。

若出现 HTTP 401，先检查密钥；HTTP 402 检查账户余额；连接或 TLS 错误先调查网络；30 秒后停止则先确认响应是否一直没到达。不要因为任何错误都发生在这个命令里，就先改 Runtime 的状态逻辑。

## 第二阶段：把模型接口接到已有契约

接下来有四个已有文件需要迁移：types.ts、tool.ts、tool-registry.ts、read-source-tool.ts。完成本阶段全部修改后再运行整项目检查，避免将迁移到一半的缺字段当成最终故障。

### 4. 保存工具调用附带的文字

在 `src/runtime/types.ts` 中，用以下整段替换 Action，其他类型保持不变：

<<< ../snippets/05/src/runtime/types.ts#actions

真实模型提出工具请求时，还可能附带“先读取文件”这样的文字。新增可选 content 保存这部分，而不是转换成 Action 时丢掉。旧脚本仍可返回只有 kind、call 的动作；循环照常整体记录 action，不需要修改。

content 是模型这次回复的文字，不是工具结果；源码仍需要等工具执行后作为 tool 消息写回。

### 5. 让工具同时提供说明与本地执行入口

在 `src/runtime/tool.ts` 中，保留 ParseResult、ToolOutput，用以下两个类型替换原 Tool 与 ToolDefinition：

<<< ../snippets/05/src/runtime/tool.ts#callable

工具定义现在同时包含两类内容：description、parameters 告诉模型“何时使用、参数怎样写”；parse、execute 和 invoke 负责本地检查与操作。parameters 是描述参数形状的 JSON Schema 对象，不是执行函数，也不会替代 parse。

再用下面完整函数替换 defineTool：

<<< ../snippets/05/src/runtime/tool.ts#define

invoke 的检查与执行顺序沿用上一章，只新增对说明与参数描述的保存；parameters 复制后放到工具对象上。后面模型适配器只提取名称、说明和参数描述，不将 invoke、parse、execute 发送给服务。

接着修改 `src/runtime/tool-registry.ts`：找到 byName.set 的旧语句，用下面整条语句替换，其他代码保留：

```ts
byName.set(tool.name, {
  name: tool.name,
  description: tool.description,
  parameters: structuredClone(tool.parameters),
  invoke: tool.invoke,
});
```

这一步让注册表继续保存新字段。若只在 Tool 类型上增加字段，注册时仍只保留 name、invoke，后面就取不到给模型的说明。它们都是内存配置，不加入 State 消息。

### 6. 给读取工具补上准确的参数说明

在 `src/examples/read-source-tool.ts` 中，保留顶部导入和 parseReadSourceArgs；用下面完整定义替换原 readSourceTool：

<<< ../snippets/05/src/examples/read-source-tool.ts#definition

description 说明用途，parameters 描述“对象中必须有 path，它是字符串且只能为本例路径，不能有多余字段”。enum 表示允许值列表；required 表示必填字段；additionalProperties:false 表示不接受未声明字段。

正常模型请求应生成 `{"path":"src/sum.ts"}`。但是给模型一份规则，不等于任何返回都已通过本地检查；真正执行前依旧运行原来的 parseReadSourceArgs。两份规则需要保持一致：本章的声明供模型生成参数，解析器决定程序是否接受本次实际数据。

本篇使用标准接口，不启用 DeepSeek 的 Beta strict 模式。不要把普通 parameters 描述理解成服务器保证每次都严格符合，解码与本地参数检查都保留。[DeepSeek：strict 模式的额外要求](https://api-docs.deepseek.com/zh-cn/guides/tool_calls/#strict-模式beta)

### 7. 把内部消息转成接口消息

新建 `src/adapters/deepseek/protocol.ts`。先写导入：

```ts
import type { Action, DecisionContext } from "../../runtime/types.ts";
```

接着写入以下类型与完整函数，后面再追加响应解码：

<<< ../snippets/05/src/adapters/deepseek/protocol.ts#messages

#### 这个函数接收什么，返回什么

buildDeepSeekMessages 接收最新 Context 和本应用的 systemPrompt，返回一份新的 DeepSeekMessage 数组。它不维护另一份隐藏会话，不向 State 反写接口数据。

DeepSeekMessage 是本章用到的接口消息形状。system 消息用来提供应用的行为说明，user 消息承载用户任务，assistant 保存模型回复或工具请求，tool 保存对应调用的结果。

#### 正常两轮怎样转换

第一次 Context 只有 user。函数先放入 systemPrompt，再把 user 内容放进去，所以服务收到 `system -> user`。

模型要求读取后，循环记录 assistant 请求并执行工具，将结果写为 tool。第二次 Context 有三条消息，转换后成为四条：`system -> user -> assistant -> tool`。注意新增的 system 是适配时加入的，不是偷偷写入 State 的新消息。

assistant 的 tool 分支将 call.id 放入 tool_calls[].id，将 call.name 放进 function.name，将 arguments 对象序列化为 JSON 字符串。tool 分支再把 result.callId 放入 tool_call_id，并将完整结果序列化为 content。于是模型知道“这份观察属于哪次请求”，而不只是收到一段没有来源的源码。

例如本地调用身份为 call_abc，发送的请求记录与结果记录必须使用同一个 call_abc。**这里保留服务生成的身份，不再将真实调用固定为 read-1。** 工具成功和失败结果都保留 status，失败时模型也能看到 code、message。[DeepSeek：工具结果的关联字段](https://api-docs.deepseek.com/api/create-chat-completion/)

#### 为什么要检查终止动作

finish 转成普通 assistant 文本。fail 表示本次已终止，正常循环不会再向模型请求决策；如果外部手工构造了包含 fail 的 Context，本函数直接拒绝，避免假装仍在原任务中继续。

本章只有文本、单工具和非思考模式。这份类型没有声称覆盖图像、流式增量或思考记录。JSON.stringify 负责序列化，不是校验任意循环引用或不可表示的数据；这类错误会在决策边界失败。

### 8. 检查响应，并转换成 Action

继续在 `protocol.ts` 末尾追加三个检查函数：

<<< ../snippets/05/src/adapters/deepseek/protocol.ts#helpers

这些函数检查真实值，不使用 `as Action` 让编译器直接相信网络数据。record 接受非 null、非数组的对象，nonEmptyText 接受非空字符串；标签只用于说明错误发生在哪个字段。isRecord 的返回类型告诉 TypeScript：检查通过后可以按键读取这个对象。

然后追加完整解码函数：

<<< ../snippets/05/src/adapters/deepseek/protocol.ts#decode

#### 接收的未知值来自哪里

requestDeepSeek 交回 payload:unknown。本函数先确认最外层对象，再检查 choices 恰有一个选择，并取得其中的 assistant message。只有形成合法 Action，循环才会记录动作或执行工具。

这里两种 JSON 不要混淆：response.json 已解析整份 HTTP JSON，但 function.arguments 仍是服务返回的字符串，比如 `"{\"path\":\"src/sum.ts\"}"`。因此还要单独 JSON.parse 参数，再确认得到的是对象。

#### 模型提出读取时

正常工具响应的 finish_reason 为 tool_calls，message.tool_calls 中包含一次调用。函数检查调用种类、非空 ID、名称与参数文本，然后构造 tool Action：保留模型 content，以模型 ID、名称和解析后的参数创建 call。

此处检查“是否能形成工具请求”；它没有检查 path 是否字符串、路径是否允许，也没有自动执行。后面注册表查名称，工具 parse 检查参数，循环保存结果，仍是独立步骤。

#### 模型给出普通答案时

finish_reason 为 stop、没有工具请求且 content 是非空字符串，才转成 finish。finish 仍需通过应用完成规则，不能在这里直接返回 completed。

若同时返回多个调用，本章直接拒绝，不悄悄挑第一个。如果 finish_reason 表示截断等未完成状态，也拒绝，不执行看似能解析的半份请求。思考内容非空、角色错误、参数 JSON 不合法都会在此失败。它们属于决策输入输出边界的问题，还没有工具执行结果可写回。[DeepSeek：响应字段与结束原因](https://api-docs.deepseek.com/api/create-chat-completion/)

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

#### 创建时与运行时各发生什么

应用创建 decider 时交入密钥、模型名、systemPrompt 和注册表。函数先核对配置，再从注册表取出工具说明，形成接口的 tools 列表。此时还没有网络请求，也没有运行工具。

返回的函数才是 Dependencies.decide：循环调用它，传入本轮 Context 与 signal。它依次构造 messages、请求服务、检查 payload、返回 Action。声明 `Dependencies["decide"]` 表示返回函数必须符合已有依赖类型，不需要重写循环接口。

#### 正常路径的数据经过哪里

本轮 Context → buildDeepSeekMessages 返回 messages → requestDeepSeek 返回 payload → decodeDeepSeekAction 返回 action → 原循环接住并记录。适配器从不直接调用 executeTool，也不自己追加 State。

日志只显示实际发给服务的消息角色和解码后的动作种类。它没有打印密钥；原始响应可先在 ask-deepseek 观察。system 角色出现在这里，不意味着 State 中也多了一条 system 消息。

#### 边界与当前限制

模型可能重复调用同一工具，但每次调用需要自己的身份。返回 tool Action 后，代码从本次 Context 的历史请求中核对 ID，若已使用就拒绝，避免新结果与旧结果归属混淆。注册表在创建阶段提取说明，本章不支持运行中热更新工具清单。

提示词要求每轮最多一次调用，但不是强制机制。真正的数量限制由解码器检查；本篇没有设置未经 DeepSeek 本接口文档确认的 parallel_tool_calls 字段。非思考模式、stream:false、max_tokens:1024 都在请求体中明确设置；输出额度用完不会被当成完整答案。

## 第三阶段：先写清应用规则，再运行同一个 Runtime

### 10. 应用提供提示词与完成规则

新建 `src/examples/deepseek-scenario.ts`，写入导入：

```ts
import type { State } from "../runtime/types.ts";
import { sourcePath, sourceCode } from "./diagnosis-fixture.ts";
```

追加本例提示词：

<<< ../snippets/05/src/examples/deepseek-scenario.ts#prompt

这段话提供任务约束，没有把预设 diagnosis 作为答案交给模型。它要求模型读取后再解释；约束是否真正执行，仍要看工具记录与完成规则，不能只依靠提示词。

再追加完整完成检查：

<<< ../snippets/05/src/examples/deepseek-scenario.ts#evidence

旧 hasDiagnosisEvidence 要求固定答案和固定 read-1，不能直接用于真实模型。本函数改为检查“答案非空，而且历史中存在对应请求与成功读取”。它遍历 assistant 的读取请求，再核对紧随其后的 tool 消息：ID 对应、成功且源码匹配才通过。

紧随关系来自当前单工具顺序循环；以后支持批次或并发时，要重新检查这项假设。这里的 completed 只表示**本例的读取证据与非空答案检查通过**，不证明诊断语义必然正确，也没有证明修改或验证修复完成。诊断内容需要阅读核对，自动质量评估后续展开。

### 11. 用短入口组装并运行

新建 `src/examples/deepseek-agent.ts`，写入完整内容：

<<< ../snippets/05/src/examples/deepseek-agent.ts

这里依次完成配置读取、注册工具、创建 decide、启动 runAgentLoop、显示结果。没有额外的 Promise 开始通知或迟到结果控制：主入口只表现正常使用方式。

同一份 registry 同时用于提取模型可见工具与创建本地执行器。decide 换成真实适配器，executeTool 继续使用已有入口，validateFinish 则由新场景规则提供。次数上限为 5，累计时间限制为 120 秒；它们是本例控制值，可以因网络与任务调整，不是企业服务指标。

配置好 .env 后运行：

```bash
npm run typecheck
node --env-file=.env src/examples/deepseek-agent.ts
```

**典型的两轮轨迹如下，属于流程示意，不保证每次模型都恰好两轮：**

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

第二次请求多出 assistant 和 tool，是本章最重要的观察。它说明工具观察已经经 State、Context、接口消息进入下一次真实请求，不是脚本根据最后一条消息直接返回固定答案。

合理诊断应指出：没有初始值的 reduce 在空数组上失败，给 reduce 提供 0 可以处理空数组。具体说法可以不同。模型若直接回答、没有成功读取，本例完成规则会拒绝；若参数格式不合法、HTTP 失败或响应不完整，按对应边界失败，不应出现“假装已读取”的执行记录。

原有入口继续保留作对照：

```bash
node src/examples/first-loop.ts
node src/examples/inspect-tools.ts
node src/examples/inspect-context.ts
```

它们仍使用原脚本场景，不需要密钥。真实模型接入是替换一个依赖，不是删除所有可重复观察的入口。

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

第一次正常调试只追踪 call.id：响应中的 ID → Action.call.id → ToolResult.callId → 下一次消息的 tool_call_id。再追踪一份源码：工具返回 → state.messages → Context → 接口 content。不要同时展开所有 JSON 字段。

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

以下只列本篇新增或修改文件。循环、RunControl、Context、执行器保持第 4 篇实现；不要用真实模型的自由回答替换旧脚本的固定诊断常量。

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

```bash
git add -- .env.example src/adapters/deepseek/http.ts src/adapters/deepseek/protocol.ts src/adapters/deepseek/decider.ts src/runtime/types.ts src/runtime/tool.ts src/runtime/tool-registry.ts src/examples/read-source-tool.ts src/examples/ask-deepseek.ts src/examples/deepseek-scenario.ts src/examples/deepseek-agent.ts
git diff --cached --stat
git commit -F - <<'COMMIT'
第 05 篇：接入 DeepSeek 真实模型决策

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
