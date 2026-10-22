---
title: 第 01 篇｜第一条反馈闭环
description: 先运行请求、执行和反馈，再从固定流程推导通用循环，逐步补上状态保护与退出处理。
---

# 第 01 篇：让上一次执行结果进入下一次决策

本篇面向没有 Agent 基础、但能阅读函数、对象和数组的读者。从[第 00 篇](/guide/00-project-foundation)继续，当前工程只有配置与环境检查，Runtime 核心还是空的。

## 读完这篇，你会得到什么

- **要解决的问题：** 程序已经读到源码，为什么下一次决策仍可能不知道结果？关键在于结果有没有被保存并传过去。
- **要理解的知识：** 提出动作与实际执行的区别；记录目标、动作和结果的运行状态；结果如何影响下一步，以及工具成功为什么不等于任务完成。
- **要动手完成的内容：** 先分别运行请求与读取，再手动走通两次决策，最后提取一个可重复安排这些步骤的循环。
- **在整个 Runtime 中的位置：** 本篇建立“决策 → 执行 → 保存结果 → 再决策”的主干，后续输入准备、真实模型和运行控制都接入这条链。

完成后，可以从日志和断点中找到：第一次请求了什么、结果在哪里保存、第二次为什么能提出诊断。本篇先用固定脚本和模拟源码观察机制，还不能自主分析任意代码，也没有超时取消与持久化。

正文解释本篇需要的概念、代码和调试步骤。来源链接供查证，不需要先读懂官方文档或 Pi 源码。

## 本篇推荐分支

推荐分支名：`codex/chapter-01-feedback-loop`。从第 00 篇已经完成检查并提交的本地版本创建：

```bash
git switch -c codex/chapter-01-feedback-loop
```

如果已经创建过该分支，用 `git switch codex/chapter-01-feedback-loop` 返回即可。各章代码沿上一章完成版本累积。

## 学习路线与文件变化

本篇日志采用中文说明加英文名称，例如“运行结果（outcome）”“决策次数（decisions）”，便于理解并对照代码。completed、tool、user 等状态值或角色值保留英文，含义在对应步骤说明。

本篇有四个可运行阶段。每完成一个阶段都可以暂停；继续时保留前面的实现，按文中说明追加或替换。

| 阶段 | 本次要看见的事情 | 文件变化 |
|---|---|---|
| 1 生成请求 | “我要读文件”只是数据，文件还没有被读取 | 新建少量类型、场景函数和入口 |
| 2 执行工具 | 执行函数收到请求，才返回源码观察 | 追加结果类型与执行器，替换入口 |
| 3 走通反馈 | 第二次决策收到第一次执行的结果 | 追加动作、状态和决策器，替换入口 |
| 4 提取 Runtime | 统一安排重复步骤，并明确怎样退出 | 新建循环，追加完成规则与结果类型，替换入口 |

最终保留四个文件：

| 文件 | 职责 |
|---|---|
| `src/runtime/types.ts` | 逐步写入函数间交换数据的约定 |
| `src/runtime/agent-loop.ts` | 统一管理决策、执行、结果写回和退出 |
| `src/examples/diagnosis-scenario.ts` | 存放可复现的代码诊断场景；各阶段复用同一组函数 |
| `src/examples/first-loop.ts` | 本篇的运行入口；每阶段整份替换，最终只保留第 4 阶段版本 |

`src/runtime/` 是本系列持续演进的核心实现目录。本章的类型与循环会作为后续章节的起点，之后按新需求扩展或重构，并在对应章节交代迁移；不是每章各写一套、学完就丢弃。当前版本只具备本章明确实现的能力，还不是完整的生产系统。

`src/examples/` 是调用这套核心的运行场景。`first-loop.ts` 负责组装并启动，`diagnosis-scenario.ts` 提供当前任务使用的决策、执行和完成规则。Runtime 不导入这个诊断场景；入口把场景函数交给它，因此循环不用写死“读取 sum.ts”或具体诊断答案。

本章的模块边界可以沿调用方向检查：入口导入场景和循环，循环只依赖通用类型与传入的函数。模型请求怎样发送、文件怎样读取，不应逐步堆进 agent-loop.ts。后续新增独立职责时会拆出相应模块，循环保留运行顺序与状态流转的组织工作；具体拆分随实现需求展开。

本章从模拟场景开始，是为了让每次运行都产生可对照的过程，暂时减少模型响应差异和外部环境的干扰。后续再接入真实模型与工具。两类代码的关系是：**场景提供本次任务的能力，Runtime 安排这些能力怎样协作。**

暂不新增单测，也不改第 00 篇配置。所有命令都在仓库根目录执行：

```bash
mkdir -p src/runtime src/examples
```

每一步先标明文件与新增、追加或替换位置，再用一个连续代码块给出本步代码，讲解紧接在代码下面。简单代码简述，重要的状态变化、分支与异常展开解释。章末另有四个完整文件用于核对，不需要先复制整份文件再回头学习。

## 先看问题：为什么空数组求和会失败

假设应用收到目标：“找出 `sum([])` 为什么抛错。” 项目里的源码是：

```ts
export const sum = (numbers: number[]) => numbers.reduce((a, b) => a + b);
```

`reduce` 没有初始累加值。数组有元素时可以从第一个元素开始累加，空数组没有这个元素，于是抛错。传入初始值 `0` 可以解决这类问题，但本篇只做**读取与诊断**，不修改文件或验证修复。

如果事先知道所有步骤，直接安排“读取文件 → 分析内容 → 输出诊断”即可。让模型根据已有信息选择下一步时，情况会不同：它可能请求读取另一个文件、报告失败，或者提交答案，调用方不能提前写死每个任务的步数。

本篇沿用 Anthropic 对工作流与 Agent 的区分：工作流沿预先规定的代码路径组织步骤，Agent（智能体）则由模型根据任务与执行反馈动态选择后续步骤和工具。这是本文采用的概念范围。[来源：Anthropic《Building effective agents》](https://www.anthropic.com/engineering/building-effective-agents#what-are-agents)

本系列把保存状态、安排调用、管理继续与退出的程序部分称为 Runtime（运行时）。这是教程对职责的划分，后面的模块名称和接口也由本项目定义。

大语言模型（Large Language Model，简称 LLM）根据输入生成文字或结构化响应。后续会让它提出动作，本篇先用按固定条件返回动作的函数代替它，称为**脚本决策器**。答案已经预设，因此当前代码用于检查信息怎样传递，还不能自主分析任意代码问题。

先沿正常路径从上往下看：两次决策之间，夹着工具执行与结果写回。图中同步标出了消息和计数的变化：

[![第 1 篇反馈流程：读取请求、执行返回、结果写回、第二次决策与完成验证](/diagrams/feedback-writeback.svg)](/diagrams/feedback-writeback.svg)

点击图片可单独打开查看。

图中第 3 步只是拿到局部变量 result，第 4 步才把它记录到 State；这两步分开看，才能解释为什么“工具执行过”不代表下一次决策已经知道结果。

读取函数返回了源码，只表示调用它的程序取得结果。要让下一次询问用到这段源码，程序还得把结果保存并传过去。漏掉中间的保存与传递，第二次询问就缺少这次读取的信息。本篇代码会把表里的每一步展开，让这条数据流可以运行和观察。

## 阶段 1：先生成请求，马上运行

### 1.1 把“读什么”表示为数据

本篇的工具是应用提供的函数，例如读取文件的函数。先用请求说明工具名称和参数，再由执行器调用函数。OpenAI 官方 Function calling 文档也把应用侧的函数执行与模型提出工具请求分成不同步骤，并要求将结果用于后续模型请求；本篇先模拟这个过程。[来源：OpenAI 的函数工具调用流程](https://developers.openai.com/api/docs/guides/function-calling#the-tool-calling-flow)

创建 `src/runtime/types.ts`，现在只写下面这一个类型：

<<< @/snippets/01/src/runtime/types.ts#tool_call{ts:line-numbers} [src/runtime/types.ts · 阶段 1]

先把一次读取写成三个问题：调用什么工具、读哪个路径、这是哪一次调用。ToolCall 用 name、arguments 和 id 分别保存这些信息。它是函数之间传递数据的约定，也叫数据契约。

本例中 name 是 read_source，arguments 里放 path，id 是 read-1。同一种工具可以调用多次，所以工具名不能代替调用身份。下一步会创建这个对象；这里的 `export type` 只声明并导出形状，不会读取文件。

`Record<string, unknown>` 表示参数对象的键是字符串，值还需要使用方确认。通用工具可能接收不同参数，不能预先把每个值都当成字符串。这个类型不会自动检查外部 JSON，外部数据校验留到工具章节。

### 1.2 创建固定场景的请求函数

创建 `src/examples/diagnosis-scenario.ts`。先写导入：

```ts
import type { ToolCall } from "../runtime/types.ts";
```

在导入之后追加：

<<< @/snippets/01/src/examples/diagnosis-scenario.ts#request{ts:line-numbers} [src/examples/diagnosis-scenario.ts · 阶段 1]

调用 `createReadSourceCall()` 后，调用方拿到一个普通对象：id 来自 sourceCallId，name 是 read_source，arguments.path 来自 sourcePath。函数到 return 就结束，此时还没有源码内容。

函数没有参数，因为路径和身份已固定在文件顶部的常量中。后面的执行器与结果检查会复用它们，避免一处请求 src/sum.ts、另一处却期待不同路径。固定 read-1 只用于这次单次读取，不能作为以后多次调用的身份生成方案。

目标路径属于诊断任务，所以放在场景文件；Runtime 的通用类型不写死文件名。`import type` 引入类型，函数后的 `: ToolCall` 检查返回形状，`export` 让入口能够导入函数。导入路径相对当前文件，`../runtime/types.ts` 指向相邻 runtime 目录。

### 1.3 写一个很短的入口并运行

创建 `src/examples/first-loop.ts`，完整写入：

<<< @/snippets/01/checkpoints/01-request.ts{ts:line-numbers} [src/examples/first-loop.ts · 阶段 1 完整入口]

入口调用一次请求创建函数，将对象保存在 call 中，再打印名称、身份和路径。三个 console.log 都只是在检查数据，没有调用执行器。

模板字符串的 `${...}` 将字段值插入日志；`String(...)` 把参数转为便于显示的文字，不校验文件存在。若这里的名称或路径已经错误，应先回到请求创建函数调查。

运行：

```bash
npm run typecheck
node src/examples/first-loop.ts
```

类型检查通过后，入口输出：

```text
工具请求（request）: read_source
调用编号（id）: read-1
文件路径（path）: src/sum.ts
```

三个文件现在可以检查和运行。输出中的工具名、调用 ID 和路径都来自请求对象；还没有执行器，因此不会出现源码结果。

## 阶段 2：让请求得到实际结果

阶段 1 的文件都保留。下面只追加结果类型和执行函数，再替换入口。

### 2.1 结果既可能成功，也可能失败

在 `src/runtime/types.ts` 的 `ToolCall` 类型之后追加：

<<< @/snippets/01/src/runtime/types.ts#tool_result{ts:line-numbers} [src/runtime/types.ts · 追加结果类型]

请求交出去后，调用方需要知道：结果属于哪次调用、是否成功、得到了什么。ToolResult 因此保留 callId，并用 status 区分成功内容 value 与失败原因 message。本例成功时 value 是源码字符串；失败也带回原调用身份。

`|` 表示两种形状之一。判断 `result.status === "ok"` 后才能读取 value，否则读取 message，避免把“读取失败”误当成“成功读到空内容”。TypeScript 根据判断确定对象形状，称为类型收窄。[来源：TypeScript 的可辨识联合类型](https://www.typescriptlang.org/docs/handbook/2/narrowing.html#discriminated-unions)

工具返回、可供后续决策使用的信息，在本篇称为**观察（Observation）**。源码和错误原因都是观察，但处理方式不同。value 使用 unknown，因为其他工具可能返回其他内容，使用前仍需确认。

这些字段是本项目内部约定，不是模型 API 的通用格式；后续接入模型时还要转换。

这次读取成功后，实际返回值会是下面的形状。它是 ToolResult 数据示例，先看字段含义，不要追加到源码：

```json
{
  "callId": "read-1",
  "status": "ok",
  "value": "export const sum = (numbers: number[]) => numbers.reduce((a, b) => a + b);"
}
```

源码在 value 中，callId 用来关联请求。工具函数把这个对象返回给调用方，并不会因此自动加入消息列表；后面还要显式记录。

### 2.2 加入模拟执行器

将 `src/examples/diagnosis-scenario.ts` 顶部原来的单行导入替换为：

```ts
import type { ToolCall, ToolResult } from "../runtime/types.ts";
```

保留请求函数，在文件末尾追加：

<<< @/snippets/01/src/examples/diagnosis-scenario.ts#executor{ts:line-numbers} [src/examples/diagnosis-scenario.ts · 追加执行器]

这次将读取请求 call 交给 `simulateReadSource`。本例名称和路径都匹配，两个 if 都不进入，最后返回原调用身份、ok 状态与固定源码，调用方至此才取得内容。

两个 if 排除本场景不能处理的请求：名称错误返回 Unsupported tool；名称正确但路径不符返回 Source path is not allowed。return 会结束函数，不再返回源码。错误结果也保留 call.id，让调用方知道哪次读取失败。若删掉检查，任意请求都会得到同一份源码，模拟就掩盖了调用错误。

async 使结果表示为 `Promise<ToolResult>`，调用方按异步方式等待，后续可替换为真实输入/输出操作（I/O）。当前 sourceCode 是固定字符串，不读取磁盘，也不要求创建 src/sum.ts；路径比较不是文件系统安全隔离。

开头日志在检查前打印，只说明函数被调用。是否成功要看 status，正常返回的 Promise 也可能携带 error 结果。

### 2.3 完整替换入口，再运行

把 `src/examples/first-loop.ts` 原内容全部删除，替换为：

<<< @/snippets/01/checkpoints/02-execute.ts{ts:line-numbers} [src/examples/first-loop.ts · 阶段 2 完整入口]

入口先创建 call，再用 `await simulateReadSource(call)` 等到结果，接着按 status 打印源码或错误原因。await 保证后面的日志使用已取得的结果。

本例进入 ok 分支读取 value；失败分支只读取 message。内容现在仍只保存在入口变量 result 里，执行器不会替入口安排下一次决策。

async/await 不会把同步计算自动变成并行。等待未完成的异步操作时 Node 可以处理其他任务，但执行器中的耗时同步计算仍可能阻塞其他代码。

运行同样两条命令：

```bash
npm run typecheck
node src/examples/first-loop.ts
```

预期输出：

```text
工具请求（request）: read_source
[执行工具 execute] read_source 文件路径（path）=src/sum.ts
执行状态（result）: ok
调用编号（callId）: read-1
读取源码（source）: export const sum = (numbers: number[]) => numbers.reduce((a, b) => a + b);
```

执行日志和源码结果已经出现。此时 `result` 只保存在入口变量里，还没有被交给下一次决策，反馈过程尚未发生。

## 阶段 3：先手动走通反馈，不急着写通用循环

接下来把读取结果交给决策器。先明确调用两次决策，观察它收到什么，再考虑怎样重复安排这些步骤。

### 3.1 决策方返回动作，运行状态保存已有信息

在 `src/runtime/types.ts` 末尾追加以下连续代码，加入动作、消息与状态类型：

```ts
/** 模型提出的请求。finish 仍要经过应用的完成验证。 */
export type Action =
  | { kind: "tool"; call: ToolCall }
  | { kind: "finish"; answer: string }
  | { kind: "fail"; reason: string };

/** 本章的最小会话记录，按发生顺序追加。 */
export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; action: Action }
  | { role: "tool"; result: ToolResult };

/** 一次运行的当前事实；不同运行不能共享这个对象。 */
export type State = {
  goal: string;
  messages: Message[];
  decisions: number;
};
```

接下来需要表达“下一步做什么”，并保存做过什么、得到了什么。这三种类型分别组织动作、记录和当前运行信息。

**Action 是决策方提出的动作。** tool 携带工具请求，finish 携带候选答案，fail 携带无法继续的原因。kind 区分这三条路径，让调用方知道接下来该处理哪个字段。

**Message 是按来源区分的一条记录。** user 保存目标，assistant 保存返回的 Action，tool 保存执行器返回的 ToolResult。例如读取请求记为 assistant，源码结果记为 tool。保留完整对象，后面才能回查调用身份、参数和内容，而不是只知道“读过一次”。

**State 是这次运行持有的信息。** goal 保存目标，messages 按顺序保存记录，decisions 统计已取得并记录的动作数。user → assistant → tool 有三条消息，却只有一次决策；工具执行不再计一次。

目标同时保存在 goal 与首条 user 消息，分别方便直接访问和回查记录。类型只约定形状，不会自动保存历史，追加工作仍由入口或循环完成。动作与消息结构属于本教程内部协议，本章 assistant 由脚本产生，尚未接入真实模型。

### 同一次读取，为什么会出现几种数据

这些名称不是几种不同工具，而是在不同位置包装同一次读取：

| 数据 | 当前形状与用途 | 谁把它交到下一处 |
|---|---|---|
| ToolCall | 含 id、name、arguments，描述读取请求 | 请求创建函数返回给决策器或入口 |
| Action | `{ kind: "tool", call }`，说明下一步要调用工具 | 决策器返回给调用方，不直接执行 |
| Message | `{ role: "assistant", action }`，或 `{ role: "tool", result }` | 入口或循环追加到消息数组 |
| State | 保存 goal、messages 与 decisions | 本次运行的入口或循环更新，作为下一次决策输入 |

ToolCall 和 Action 中的 kind/name 回答不同问题：kind 决定循环进入哪条分支，name 决定这次请求哪个工具。role 又是另一回事，它标记这条记录来自哪一方。工具结果的 `status: "ok"` 只描述执行成功，不是整个任务完成。

类型定义不会自动创建这些对象。变量 firstAction 是函数返回的动作；把它装进 assistant 消息并追加之后，它才成为历史。result 同样先是局部返回值，装进 tool 消息后才进入状态。

### 3.2 追加会查看状态的脚本决策器

把 `src/examples/diagnosis-scenario.ts` 顶部导入替换为：

<<< @/snippets/01/src/examples/diagnosis-scenario.ts#imports{ts:line-numbers} [src/examples/diagnosis-scenario.ts · 替换导入]

保留已有请求函数与执行器，在文件末尾追加：

<<< @/snippets/01/src/examples/diagnosis-scenario.ts#decision{ts:line-numbers} [src/examples/diagnosis-scenario.ts · 追加决策器]

#### 两次调用怎样得到不同动作

第一次传入的 messages 只有 user 目标。`messages.at(-1)` 取最后一条消息，role 是 user，第一个 if 便返回读取请求。return 结束本次函数，**文件还没读，状态也没更新**，这些由调用方接着安排。

调用方执行读取、保存 tool 结果后，再把最新 state 传进来。第二次最后一条是 tool，代码开始检查结果；符合条件才返回 finish 和 diagnosis。diagnosis 是预设字符串，不是这个函数分析源码生成的答案。

函数两次返回不同动作，是因为输入记录变了。它只提出下一步，不执行工具、不追加消息。阶段 3 由入口调用，阶段 4 由 Runtime 调用；async 与 `Promise<Action>` 让调用方都按异步接口等待。

#### 为什么不是看到 tool 就完成

工具消息可能是失败，也可能属于别的调用。四个条件必须同时成立：

| 条件 | 核对什么 | 缺少检查的后果 |
|---|---|---|
| role 是 tool | 这是一条执行结果 | 可能把目标或动作当成结果 |
| callId 等于 sourceCallId | 结果属于 read-1 | 其他结果可能冒充本次读取 |
| status 是 ok | 这次读取成功 | 可能把错误原因当成源码 |
| value 等于 sourceCode | 内容是脚本认识的固定源码 | 任意成功结果都可能触发固定诊断 |

`&&` 从前往后判断，遇到假就停止。确认 tool 后才访问 result，确认 ok 后才比较 value，这些判断也帮助 TypeScript 确定可用字段。`lastMessage?.role` 的 `?.` 让消息不存在时得到 undefined，而不直接读取空值。

本例一次只安排一个动作，并立即处理结果，所以脚本用最后一条消息选分支。真实模型还需要任务与相关历史，不能把这个简化当作通用决策算法。finish 也只提交答案，是否接受留给阶段 4 的完成规则。

#### 不符合预期时如何返回

漏写回结果时，最后一条仍是 assistant；读取失败时，虽是 tool，status 却是 error。这两种情况都走最后的 fail，返回 No usable source observation。空消息或其他不匹配结果也走这里。本脚本尚无重试或补读策略。

#### 日志与类型约束

开头 map 取消息角色，join 连成日志中的顺序；`state.decisions + 1` 显示本轮序号，不修改计数。日志用于观察输入，不参与决策，也不证明工具内容正确。

`Readonly<State>` 约束顶层属性重新赋值，不深度冻结嵌套消息。本阶段依赖已知脚本，正式循环再用副本保护留存状态。[来源：TypeScript 的 readonly 属性及嵌套可变性](https://www.typescriptlang.org/docs/handbook/2/objects.html#readonly-properties)

### 3.3 替换入口，显式记录一次执行

把 `src/examples/first-loop.ts` 全部删除，再依次写入本小节和下一小节的三段代码。先初始化状态：

<<< @/snippets/01/checkpoints/03-feedback.ts#initialize{ts:line-numbers} [src/examples/first-loop.ts · 阶段 3 第 1 段]

先创建这次运行自己的 state：目标已知，messages 只有 user，decisions 为 0。还没发生的读取不能预先记成结果。

state 用 let，因为后面会让它指向新状态；目标不变，用 const。此时实际数据如下，这是一份用于观察的快照：

```json
{
  "goal": "Diagnose why sum([]) fails",
  "messages": [
    {
      "role": "user",
      "content": "Diagnose why sum([]) fails"
    }
  ],
  "decisions": 0
}
```

这些内容只在当前程序内存里。变量名 state 不是磁盘位置，写入 src/runtime/types.ts 的类型也不是会话存储。第 4 阶段会将初始化移入 runAgentLoop，使一次调用拥有自己的状态。

现在继续在入口末尾追加：

<<< @/snippets/01/checkpoints/03-feedback.ts#first_turn{ts:line-numbers} [src/examples/first-loop.ts · 阶段 3 第 2 段]

两次 state 赋值分别记录请求与执行结果，沿本例看：

1. decide 返回 tool 后，入口先追加 assistant 消息，decisions 从 0 加到 1。此时有目标和读取请求，还没有源码。
2. 将 firstAction.call 交给执行器，等到 result 后再追加 tool 消息。工具返回不增加决策计数。

`...state` 保留旧字段，后写的同名字段覆盖旧值；`[...state.messages, 新消息]` 创建带历史与新项的数组。赋值使 state 指向新对象，但不会深复制旧消息。

先记录请求，再记录结果，使历史与实际调用顺序一致。若漏掉第二次赋值，下一次传入的仍是 user → assistant，决策器就拿不到源码。

中间的 kind 检查是本阶段的前提检查：入口只演示先读取的路径，若拿到 finish 或 fail 就停止，不能继续访问它们不存在的 call。通用循环稍后才会分别处理这些分支。

### 3.4 用最新状态进行第二次决策

在入口末尾追加：

<<< @/snippets/01/checkpoints/03-feedback.ts#next_turn{ts:line-numbers} [src/examples/first-loop.ts · 阶段 3 第 3 段]

第二次传入的是最新 state：decisions 为 1，消息为 user → assistant → tool。脚本检查到预期源码，返回 finish；入口将它记录为下一条 assistant 消息，计数变为 2。

日志同时显示返回动作与更新后的记录。只有 finish 才读取 answer，因此称为 proposed-answer：我们观察到了提交诊断，还没有验证任务完成。

现在运行：

```bash
npm run typecheck
node src/examples/first-loop.ts
```

预期输出：

```text
[决策 decide 1] 消息角色（roles）=user
[执行工具 execute] read_source 文件路径（path）=src/sum.ts
[决策 decide 2] 消息角色（roles）=user -> assistant -> tool
下一步动作（next-action）: finish
决策次数（decisions）: 2
消息顺序（messages）: user -> assistant -> tool -> assistant
候选答案（proposed-answer）: sum([]) fails because reduce has no initial value
```

输出 `下一步动作（next-action）: finish` 表示决策方提交了诊断。是否接受这个答案，要到阶段 4 增加规则后才能判断。

把输出对应到状态变化：

| 时刻 | 决策计数 | 已有消息 |
|---|---:|---|
| 初始化 | 0 | user |
| 记录第一次动作后 | 1 | user → assistant |
| 记录读取结果后 | 1 | user → assistant → tool |
| 记录第二次动作后 | 2 | user → assistant → tool → assistant |

第二次决策看到三条消息；第四条消息是它自己返回的动作，之后才被记录。**观察进入状态，再影响下一步**，就形成反馈闭环。把决策、执行、记录与再决策反复安排起来的过程，称为 Agent Loop（智能体循环）。

### 3.5 故障观察：读取成功却没有反馈

暂时将本阶段入口中的结果回写语句：

```ts
state = { ...state, messages: [...state.messages, { role: "tool", result }] };
```

改为：

```ts
state = { ...state };
```

运行入口。读取日志仍出现，但后面变成：

```text
[决策 decide 2] 消息角色（roles）=user -> assistant
下一步动作（next-action）: fail
决策次数（decisions）: 2
消息顺序（messages）: user -> assistant -> assistant
```

错误发生在执行之后、下一次决策之前。执行器已经工作，决策器却没有收到结果，所以不能靠增加决策次数修复这个缺口。恢复原语句，再运行至正常输出。

替换后的 `{ ...state }` 只复制顶层已有字段，messages 仍保留原来的两条消息，没有追加 result。第二次脚本因此看到最后一条是 assistant，返回 fail；入口再记录这个 fail，最终就出现 user → assistant → assistant。新增的最后一条不是工具结果，而是报告无法继续的动作。

## 阶段 4：把重复安排提取成 Runtime，再补齐可靠性

下面将已经运行过的请求、执行和反馈步骤提取成通用函数，并为它们补上退出条件与错误处理。

### 4.1 从固定两步推导通用循环

阶段 3 把两次决策直接写在入口里。如果决策方第二次想再读一个文件，入口却只打印动作，就不会继续执行。若改成复制第三次、第四次调用，仍然需要提前猜任务长度。

提取一个调度函数后，每次按返回动作决定执行、结束或失败，执行结果进入状态后再请求下一步。本章还限制取得动作的次数，防止不断重复；次数用尽只说明停止条件触发，不能证明答案正确。

```text
创建本次运行状态
    ↓
还有决策额度？ ── 没有 → 返回预算耗尽
    │ 有
    ▼
取得动作并记录
    ├─ tool → 执行 → 记录结果 → 回到额度检查
    ├─ finish → 核对完成规则 → 返回结果
    └─ fail → 返回失败
```

Runtime 在这里负责安排决策、执行、结果留存与停止。while 表达重复，依据输入选择动作的能力来自决策方，本篇仍由脚本扮演这一角色。

先把这条主线与阶段 3 对上，再阅读下面的工程处理：保护状态、关联结果、限制次数、区分失败来源。它们围绕同一条链增加约束，不是另一套框架。

### 4.2 分开表达“留下什么事实”和“为什么退出”

在 `src/runtime/types.ts` 末尾追加：

<<< @/snippets/01/src/runtime/types.ts#outcomes{ts:line-numbers} [src/runtime/types.ts · 追加退出结果]

沿用同一个读取场景：源码可能已经进入状态，运行却因额度用尽而停止。因此返回值既要保留“已经做了什么”，也要说明“为什么结束”。State 负责前者，Outcome 负责后者，RunResult 将两者一起交回调用方。

Outcome 按 status 分为三类：completed 带答案，failed 带原因和 source，budget-exhausted 表示没有额度继续决策。source 标记本实现中的决策、执行或完成验证阶段，便于找到调查位置。后面的入口先检查 status，再访问该分支的字段。

Outcome 不追加成工具消息，也不覆盖 State，它是 RunResult 的另一个字段。决定返回 completed 的是循环核对完成规则后的分支；决策器返回的 finish 只是一个待核对动作。这解释了为什么记录中能出现 finish，最终结果却仍可能是 failed。

继续追加依赖接口：

<<< @/snippets/01/src/runtime/types.ts#dependencies{ts:line-numbers} [src/runtime/types.ts · 追加依赖接口]

循环需要三个外部能力：询问下一步、执行请求、核对完成。Dependencies 约定这三个函数怎样被调用，入口再把已有的 scriptedDecide、simulateReadSource 和接下来编写的完成规则放进来。

例如循环调用 dependencies.decide(state) 时，实际运行的是入口提供的脚本函数。循环不必导入场景文件，也不用知道模型名称或目标路径。把需要的函数从外部传入，称为依赖注入。

前两项返回 Promise，调用方须等待动作或工具结果；validateFinish 只检查本例内存记录，所以直接返回布尔值。将来若它需要等待外部验证，必须连同接口和调用方式一起调整。

validateFinish 是本教程选择的完成规则接口，不是模型 API 标准。诊断与修复需要不同证据，因此由场景提供规则，循环负责安排核对时机。

#### types.ts 写完后，先把几类约定连起来

这个文件是场景与循环共同使用的数据约定，不会自己运行决策或保存任务。ToolCall、ToolResult 描述一次请求与结果；Action 描述下一步；Message、State 描述按顺序留下的事实；Outcome、RunResult 描述退出时交回什么；Dependencies 则约定循环能调用的三个外部函数。

因此读它时可以沿一条关系核对：决策返回 Action，工具动作里带 ToolCall；执行返回 ToolResult，循环把动作和结果包装成 Message 留在 State；退出时把 State 与 Outcome 一起组成 RunResult。实际对象在哪创建、什么时候更新，要继续看场景、循环和入口，类型声明不会替它们执行这些操作。

### 4.3 在场景里补上有限的完成规则

在 `src/examples/diagnosis-scenario.ts` 末尾追加：

<<< @/snippets/01/src/examples/diagnosis-scenario.ts#validation{ts:line-numbers} [src/examples/diagnosis-scenario.ts · 追加完成规则]

正常路径中，脚本已提出固定诊断，历史里也有读取成功的记录。本函数先比较 answer 与 diagnosis，再在历史中寻找对应的工具结果，两项都成立才交回 true。它只回答“接受吗”，真正退出运行仍由 Runtime 安排。

为什么用 some 遍历历史，而不看最后一条？调用完成规则时，最后一条已经是刚记录的 finish 动作，源码证据在它前面。some 会逐条检查：user 与 assistant 不符合，回调返回 false 后继续；找到 callId 正确、status 为 ok、内容匹配的 tool 消息才返回 true。

这使“答案字符串正确，但根本没有读取证据”的提前完成被拒绝；有证据但答案不符也被拒绝。它验证的仍只是固定场景，不会判断任意诊断的语义正确性，更没有证明文件已经修复。

#### diagnosis-scenario.ts：把本例的业务能力放在一起

到这里，这个分多次追加的文件已经完整。它负责固定诊断场景，向调用方提供四个函数：

| 导出函数 | 在一次任务里负责什么 |
|---|---|
| createReadSourceCall | 创建带本例路径和身份的读取请求，只交出数据 |
| scriptedDecide | 读取输入中的消息，提出 tool、finish 或 fail 动作 |
| simulateReadSource | 接收请求，检查名称与路径，返回固定源码或失败结果 |
| hasDiagnosisEvidence | 接收运行记录与候选答案，返回是否满足本例证据规则 |

它们没有在文件里自动串成循环。接下来的入口会把后三个函数交给 Runtime，由 Runtime 决定何时调用、记录哪些返回值。换一个任务时，场景函数可以变化，循环不应因此知道 sourcePath 或 diagnosis。

### 4.4 创建循环文件：先看状态保护和错误表达

创建 `src/runtime/agent-loop.ts`，写入：

<<< @/snippets/01/src/runtime/agent-loop.ts#helpers{ts:line-numbers} [src/runtime/agent-loop.ts · 导入与辅助函数]

循环接下来会把状态交给外部函数。为避免对方误改留下的消息，snapshot 用 structuredClone 复制状态，再交出副本。只用对象展开复制顶层不够，嵌套消息仍可能共享引用；本章状态只有字符串、数组和普通对象，适合这种复制方式。[来源：Node.js 的 structuredClone 文档](https://nodejs.org/download/release/v22.18.0/docs/api/globals.html#structuredclonevalue-options)

另外两个辅助函数用于统一错误表达：failure 组装带 reason 和 source 的失败结果；errorMessage 取得可显示的原因。后者先用 instanceof Error 判断，是 Error 就读 message，否则用 String 转换，因为 JavaScript 也允许直接抛出字符串等其他值。

辅助函数不决定循环何时结束，结束由调用处的 return 控制。快照也只保护内存记录，不能撤销工具已产生的外部操作。当前它们服务这一个循环，暂作为文件内私有函数；后续若形成独立职责或被其他模块共享，再说明抽离位置。

### 4.5 追加一次运行的循环函数

在 `src/runtime/agent-loop.ts` 的辅助函数之后追加下面的完整函数。它负责一次任务的调度，代码保持连续；下方按运行顺序解释重点，不需要在函数内部交替插入片段。

```ts
/**
 * 驱动一次任务，并返回最后状态与退出原因。
 * maxDecisions 限制取得 Action 的次数；一次决策最多请求一个工具。
 */
export async function runAgentLoop(
  goal: string,
  dependencies: Dependencies,
  maxDecisions: number,
): Promise<RunResult> {
  if (!Number.isInteger(maxDecisions) || maxDecisions < 1) {
    throw new RangeError("maxDecisions must be a positive integer");
  }

  // State 只属于这次调用；再次运行会得到新的消息与计数。
  let state: State = {
    goal,
    messages: [{ role: "user", content: goal }],
    decisions: 0,
  };

  while (state.decisions < maxDecisions) {
    let action: Action;

    try {
      action = structuredClone(await dependencies.decide(snapshot(state)));
    } catch (error) {
      return { state, outcome: failure(errorMessage(error), "decision") };
    }

    // 先记下模型提出了什么，再判断能否执行或完成。
    state = {
      ...state,
      decisions: state.decisions + 1,
      messages: [...state.messages, { role: "assistant", action }],
    };
    if (action.kind === "fail") {
      return { state, outcome: failure(action.reason, "decision") };
    }

    if (action.kind === "finish") {
      try {
        // 模型的完成请求不是成功事实，必须交给应用规则核对。
        if (dependencies.validateFinish(snapshot(state), action.answer)) {
          return { state, outcome: { status: "completed", answer: action.answer } };
        }

        return { state, outcome: failure("Completion lacks verified evidence", "validation") };
      } catch (error) {
        return { state, outcome: failure(errorMessage(error), "validation") };
      }
    }

    let result: ToolResult;

    try {
      result = structuredClone(await dependencies.executeTool(structuredClone(action.call)));
    } catch (error) {
      // 执行错误也是观察，下一轮决策需要知道这次调用失败了。
      result = { callId: action.call.id, status: "error", message: errorMessage(error) };
    }

    // 一个调用的结果不能写到另一个调用名下。
    if (result.callId !== action.call.id) {
      return {
        state,
        outcome: failure("Tool result callId does not match the request", "execution"),
      };
    }

    // 只有确认属于本次调用的结果才能进入 State，供下一轮 decide 使用。
    state = { ...state, messages: [...state.messages, { role: "tool", result }] };
  }

  return { state, outcome: { status: "budget-exhausted" } };
}
```

#### 先沿本例走完一次正常运行

**起点：只有目标，还没有执行。** 入口将目标、三个依赖函数和上限 3 传进 runAgentLoop。函数创建自己的 state：一条 user 消息，decisions 为 0。这个状态只属于本次调用，下次运行会重新创建。

::: info 以下摘录仅供对照
解释中的代码片段已包含在上方对应的完整实现中，**无需再次写入、追加或替换文件**。继续实现时，以标明“新增、追加、替换”的步骤为准。
:::

**讲解摘录 · 取得动作，并记入历史（无需写入文件）**

<<< ../snippets/01/src/runtime/agent-loop.ts#decide

**第一次决策：取得读取请求。** `while` 检查 0 < 3，允许开始。`dependencies.decide(snapshot(state))` 把当前信息交给脚本；await 等到返回动作，外层 structuredClone 再复制动作并保存到 action。本例得到 tool，循环先记录 assistant 消息，再将计数加到 1。现在历史是 user → assistant，尚无源码。

先记录再执行，是为了无论接下来成功还是失败，都能回查本次请求。这里的 state 赋值仍是阶段 3 的做法，只是由循环统一负责了。

**讲解摘录 · 执行请求并核对返回结果（无需写入文件）**

<<< ../snippets/01/src/runtime/agent-loop.ts#execute

**执行与写回：请求变成可供下一轮使用的结果。** action 既不是 fail，也不是 finish，于是进入工具路径。循环将 action.call 交给 executeTool，等到属于 read-1 的成功结果。确认 result.callId 与请求 id 相同后，追加 tool 消息，历史变成 user → assistant → tool。工具执行没有产生新决策，计数仍为 1。

**讲解摘录 · 将已核对的结果追加到状态（无需写入文件）**

<<< ../snippets/01/src/runtime/agent-loop.ts#writeback

这里没有 return，执行到循环末尾就回到 while。再次检查 1 < 3 后，下一次 decide 收到的是已含源码的新状态。**这次结果能影响下一次决策，靠的就是写回 state 后重新调用 decide。**

**讲解摘录 · 完成请求要经过证据检查（无需写入文件）**

<<< ../snippets/01/src/runtime/agent-loop.ts#finish

**第二次决策：提出诊断并核对完成。** 脚本返回 finish，循环先记录这个动作，计数变为 2，历史已有四条消息。接着调用 validateFinish，将状态副本与 action.answer 交给场景规则。规则找到读取证据并返回 true，循环便返回 state 与 completed，不再进入第三次决策。

到这里，一次正常运行已经走完。下面再分别看这条主线周围的保护与退出条件。

#### 为什么要复制输入和返回值

复制发生在数据交给外部函数、或从外部函数拿回的时候。decide 收到状态副本，executeTool 收到请求副本；它们返回的动作与结果也复制后保存。这样外部函数修改手里的对象时，不会直接改掉循环留存的记录。

这些复制不改变上面的调用顺序，也不检查未知数据是否符合协议。当前依赖须遵守 TypeScript 接口；外部 JSON 的结构校验后续实现。

#### 两种失败为什么处理不同

工具失败仍可能帮助下一次决策。例如执行器返回 error，或者调用过程抛错，循环都可以保留一条 error 观察。catch 会从原请求补上 callId 并保存错误文本；通过身份检查后，结果照常写回，下一轮脚本再决定怎么办。本章不会在执行器失败后自动重试。

决策失败则没有工具请求可继续。decide 调用或该 try 内的复制操作抛错时，循环直接返回 source 为 decision 的失败，不增加已记录动作数。若 decide 正常返回 fail，则先记录该动作、计数加一，再用 action.reason 返回失败。两者都结束函数，但历史不同。

还有一种执行边界失败：请求是 read-1，结果却标为 other。循环无法把它安全归到当前请求，所以在写回前返回 execution 失败。**可以记录一次调用的失败结果，不能把别的调用结果记到它名下。** 这里检查的是本次关联，还没有实现并发调用身份管理。

#### 完成验证不通过会怎样

finish 提供候选答案，Runtime 再决定是否接受。规则返回 false 时，循环返回 validation 失败；规则或该 try 内的状态复制抛错时，也从 validation 退出，并保留错误文本。本章采取直接停止策略，不自动把拒绝原因交回模型重试。

这些路径都用 return 结束整个函数，所以不会在 finish 后继续执行工具。把每个工具成功直接当成任务完成，会绕过第二次决策和这里的证据检查。

#### 次数上限怎样影响这次运行

maxDecisions 限制的是已取得并记录的动作数。上限 3 允许本例完成两次决策后提前退出，不要求必须做满三次；若上限改为 1，第一次读取结果仍会写回，但随后 1 < 1 不成立，返回 budget-exhausted。状态中的源码不会被删除，只是不能继续询问下一步。

函数开头拒绝 0、负数与非整数，抛出 RangeError，表示配置本身有误；预算耗尽则是在有效配置下运行后正常触发的停止条件。两者不要混淆。

次数检查只在循环回到 while 时发生。若某次等待的 Promise 永不返回，就无法走到下一次条件判断；次数上限不能代替超时，时间边界将在后续实现。

函数追加完成后，运行 `npm run typecheck`。类型检查通过只说明代码可以继续组装，下一小节调用入口才会真正启动任务。

#### agent-loop.ts：把这些能力组织成一次运行

这个文件的公开入口是 runAgentLoop。调用方交入目标、Dependencies 与次数上限，最后取得 RunResult；snapshot、failure、errorMessage 是支持它的内部辅助函数，不各自启动任务。

把整个文件按一次调用连起来看：

```text
入口调用 runAgentLoop
  → 初始化本次 State
  → decide 返回动作，循环记录 assistant
  → tool：executeTool 返回结果，核对身份后记录 tool，再决策
  → finish：validateFinish 核对证据，决定是否 completed
  → fail、异常或次数耗尽：带着已有 State 退出
  → RunResult 交回入口显示
```

消息更新与次数计数集中在这个文件，具体“读哪个文件、怎样得到结果、什么证据算完成”由传入函数提供。它没有连接真实模型、磁盘读取或超时管理；本篇先实现反馈与调度。

### 4.6 最后一次替换入口，使用通用循环

将 `src/examples/first-loop.ts` 的阶段 3 内容全部删除，替换为下面的完整入口。前面已写的场景文件和类型保留：

这次入口的目标是把“安排下一步”交给刚实现的循环。自己只保留：选依赖 → 调用循环 → 显示结果，不再手动执行两轮。

**第 1 步：清空阶段 3 的入口内容，先写导入。**

<<< @/snippets/01/src/examples/first-loop.ts#imports{ts:line-numbers} [src/examples/first-loop.ts · 导入]

场景文件继续提供原来的三个函数，新增导入的是通用循环。导入函数不会执行它们。

**第 2 步：在同一文件末尾追加组装、启动与结果显示。**

<<< @/snippets/01/src/examples/first-loop.ts#run{ts:line-numbers} [src/examples/first-loop.ts · 组装与运行]

入口将 scriptedDecide、simulateReadSource 和 hasDiagnosisEvidence 放入 Dependencies，再调用 runAgentLoop，等待这次运行的结果。这里传的是函数本身，没有加括号提前执行；循环需要在正确时机给它们传入最新状态或请求。

这里的 result 是 runAgentLoop 返回的 RunResult，不是前面执行器返回的 ToolResult。不同函数里的局部变量可以同名，判断含义要看它接住哪次调用的返回值。

返回后，result.state 是留下的记录，result.outcome 是退出原因。入口先输出通用信息，再按 status 读取答案或失败原因；预算耗尽没有这些额外字段，因此只显示前面的日志。

把 first-loop.ts 作为一个完整文件看，它是本例的启动入口：选择三个场景函数，交给 runAgentLoop，再根据返回的 state、outcome 显示结果。与阶段 3 相比，手动写回与第二次决策已经移入循环；这个入口不再自己推进运行。依赖方向是入口同时导入场景和循环，循环不反向导入场景。

运行：

```bash
npm run typecheck
node src/examples/first-loop.ts
```

预期输出：

```text
[决策 decide 1] 消息角色（roles）=user
[执行工具 execute] read_source 文件路径（path）=src/sum.ts
[决策 decide 2] 消息角色（roles）=user -> assistant -> tool
运行结果（outcome）: completed
决策次数（decisions）: 2
消息顺序（messages）: user -> assistant -> tool -> assistant
最终答案（answer）: sum([]) fails because reduce has no initial value
```

完成规则返回 true，因此这次输出 completed。`maxDecisions` 为 3 是上限，第二次验证通过就会返回。场景函数继续复用前面的实现，入口中的重复安排交给了循环。

这几行日志跨过了场景与 Runtime 两侧。第一次 decide 日志在脚本函数内打印，表示循环已经把初始状态传给它；execute 日志表示循环已经调到执行器；第二次 decide 带着 tool 角色，说明执行结果又被送回决策方。最后的 outcome 由入口打印，是循环返回的退出结果。

日志能帮助定位数据流，但只看到角色列表，不能证明源码内容和调用 ID 正确，也不能证明真正读取过磁盘。调试时还要查看消息里的具体字段，下面的断点与故障实验会检查这些位置。

`npm run check` 也可以运行，但其中现有测试只检查第 00 篇环境，不验证本篇闭环。本篇行为证据来自上述入口轨迹和故障实验。

## 模拟能力以后怎样换成真实能力

真实模型接入时需要 API Key，也就是访问模型服务的身份凭据；本篇没有外部请求，所以不需要配置它。

| 当前实现 | 本篇模拟什么 | 后续会替换或扩展什么 | 继续需要的机制 |
|---|---|---|---|
| `scriptedDecide` | 模型根据已有信息提出下一步 | 内部消息与模型协议转换、真实模型请求 | 根据最新信息发起下一次决策，记录响应 |
| `simulateReadSource` | 工具读取并返回内容 | 工具注册、参数检查、真实 I/O 与权限控制 | 请求和结果关联，结果写回状态 |
| `hasDiagnosisEvidence` | 本例诊断的完成标准 | 按真实任务核对相应证据 | 提交完成请求与接受完成分开处理 |
| `runAgentLoop` | 当前已是真实的调度代码 | 后续增加取消、事件等运行机制 | 状态所有权、反馈和明确退出 |

这里保留的是职责与机制，不是承诺循环文件以后永远不修改。脚本答案只是可重复观察的材料，不能据此认为系统已经能自主分析任意项目。

## 怎样调试：在输入和写回处看变量

以下针对阶段 4 的最终版本。在仓库根目录运行：

```bash
node --inspect-brk=127.0.0.1:9229 src/examples/first-loop.ts
```

进程先等调试器，尚无业务日志是正常的。在 Chrome 打开 `chrome://inspect`，确认 Configure 中有 `127.0.0.1:9229`，点击对应 Node 进程的 inspect，再在 Sources 中打开源码设断点并继续。操作入口也可查阅 [Node.js 官方调试说明](https://nodejs.org/en/learn/getting-started/debugging)。

| 断点位置 | 观察变量 | 正常事实 |
|---|---|---|
| 循环内调用 `dependencies.decide(...)` | `state.messages`、`state.decisions` | 第一次为 user 和 0，第二次为 user → assistant → tool 和 1 |
| 循环内调用 `dependencies.executeTool(...)` | `action.call` | read_source、src/sum.ts、read-1 |
| 追加 tool 消息的语句 | `result` 与追加前的消息 | 结果属于 read-1，追加前只有 user → assistant |
| 执行回写语句后 | 新的 `state.messages` | 多出含源码的 tool 消息 |
| 调用 `dependencies.validateFinish(...)` | 当前状态、答案 | 已有四条消息和约定诊断 |

断点停在赋值行时，通常该行尚未执行。需要单步越过它再看新状态，不能把“写回前没有结果”当成反馈丢失。

暂不用图形调试器，也可以在回写后输出 `state.messages`。已有日志显示角色顺序，临时日志可进一步检查完整内容。观察后移除额外输出，回到本文正常轨迹。

### 常见现象与调查位置

| 现象 | 优先检查 |
|---|---|
| `.ts` 导入失败 | 文件是否在本阶段要求的位置、是否保留 `.ts` 后缀、是否满足第 00 篇环境要求 |
| 没有执行日志 | 决策方是否真的返回 tool 动作，是否还在运行前一阶段入口 |
| 执行过但第二次无 tool | 回写语句是否更新变量 state，下一次是否使用最新状态 |
| 调用 ID 不匹配 | 比较请求 id 和结果 callId，不能靠改消息角色掩盖问题 |
| 第二次有结果仍失败 | 检查执行状态、调用 ID 和返回源码是否满足本例条件 |
| 一直等待且无新日志 | 找到正在等待的依赖；次数预算不能终止挂起请求 |

## 最终版本的两个故障实验

阶段 3 已观察了漏写回结果。这里继续验证新增的完成与预算边界。每次只改一处，运行后恢复，再做下一项；无需新增单测。

### 完成请求不是成功事实

在 `src/examples/diagnosis-scenario.ts` 的 `scriptedDecide` 中，找到首次 user 消息分支，将其中的工具请求 return 暂时替换为：

```ts
return { kind: "finish", answer: diagnosis };
```

运行最终入口，应该没有 `[执行工具 execute]` 日志，并出现：

```text
[决策 decide 1] 消息角色（roles）=user
运行结果（outcome）: failed
决策次数（decisions）: 1
消息顺序（messages）: user -> assistant
失败信息（failure）: validation: Completion lacks verified evidence
```

答案虽是约定字符串，却没有读取证据，因而完成规则拒绝。恢复原来的 `return { kind: "tool", call: createReadSourceCall() };`，再运行正常入口。

### 一次工具成功不够完成两次决策

只把 `src/examples/first-loop.ts` 的 `const maxDecisions = 3` 暂时改成 1。运行应有第一次决策和执行日志，没有第二次决策，最终输出：

```text
运行结果（outcome）: budget-exhausted
决策次数（decisions）: 1
消息顺序（messages）: user -> assistant -> tool
```

源码已经保留，但没有额度取得下一步。恢复为 3，重新运行类型检查与正常入口。

## 一个小迁移：改变资源位置，保持循环不动

将诊断场景读取的目标从 `src/sum.ts` 改成 `src/math/sum.ts`，模拟源码内容与诊断保持不变。只修改 `src/examples/diagnosis-scenario.ts` 的场景配置，数据类型和 Runtime 循环保持原样。

运行最终入口：执行日志中的路径应改变，仍有两次决策并完成诊断。由于本篇是模拟读取，不用创建磁盘文件。如果需要修改循环里的业务路径，说明任务细节放错了层。

这次改动用来验证：能否在同一个运行机制下更换任务资源，而不复制另一套循环。后续再把模拟读取换成真实读取时，仍会沿这条职责边界推进。

## 对照 Pi，只看同一个反馈问题

现在打开固定提交 `8efd314` 的 [Agent Core 循环源码](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/agent/src/agent-loop.ts#L151)，不用通读：

1. 在 `runLoop` 找到工具批次返回后处理 `toolResults` 的位置，观察结果如何进入当前消息。
2. 在 `streamAssistantResponse` 看它如何使用当前消息准备模型输入。

在这个 Pi 版本中，`runLoop` 将工具结果加入当前消息，`streamAssistantResponse` 再从当前消息准备模型输入，对应本篇的“结果写回 → 下一次决策”。两处位置分别见 [结果追加](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/agent/src/agent-loop.ts#L240) 与 [请求输入转换](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/agent/src/agent-loop.ts#L350)。Pi 还处理流式响应和工具批次，本篇只比较反馈机制。`validateFinish` 与固定诊断规则由本教程设计。

## 本篇知识地图

- 请求描述“想做什么”，执行器才真正产生结果。
- 状态保存目标、动作和观察；下一次决策必须使用更新后的状态。
- 反馈让结果影响下一步；循环统一安排这些步骤，本身不提供模型判断能力。
- 场景提供决策、执行和完成规则；Runtime 持有状态并控制继续与退出。
- 本实现用 completed、failed 与 budget-exhausted 区分不同的结束原因。

主线最重要的是找到结果写回与再次决策的位置。快照、错误来源和完成规则围绕这条主线提供工程约束，可以结合对应实验回读，不必先背类型名称。

## 参考依据与本篇约定

以下资料用于按主题查证，正文已在相关位置给出出处。核对日期为 2026 年 10 月 17 日；Pi 使用固定提交，Node.js 的复制 API 对照本项目最低支持版本的文档。

| 主题 | 资料与适用范围 |
|---|---|
| Agent 与工作流 | [Anthropic：Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)，用于概念区分和环境反馈的作用。本文不据其旧工具清单选择当前依赖 |
| 函数工具调用 | [OpenAI：Function calling](https://developers.openai.com/api/docs/guides/function-calling#the-tool-calling-flow)，用于核对应用执行函数、向后续模型请求回传结果的过程 |
| Pi 的反馈实现 | [Pi Agent Core 源码，提交 8efd314](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/agent/src/agent-loop.ts)，只比较该版本的结果回写和请求准备 |
| TypeScript 类型机制 | 官方手册的 [Narrowing](https://www.typescriptlang.org/docs/handbook/2/narrowing.html)、[Utility Types](https://www.typescriptlang.org/docs/handbook/utility-types.html) 与 [readonly 属性](https://www.typescriptlang.org/docs/handbook/2/objects.html#readonly-properties)，用于核对类型收窄、Record、Readonly 及其限制 |
| Node.js 数据复制与调试 | [Node.js 22.18.0 的 structuredClone](https://nodejs.org/download/release/v22.18.0/docs/api/globals.html#structuredclonevalue-options) 与 [官方调试指南](https://nodejs.org/en/learn/getting-started/debugging)，用于核对运行环境与操作方法 |

内部 Action 和 Message 形状、State 字段、Outcome 分类、快照策略与完成规则由本项目选择。它们围绕本章需求设计，不能因为参考了这些资料，就被当作模型 API 标准或所有 Agent 必须采用的架构。

## 最终四个文件：用于核对

下面只对应阶段 4 的最终状态。阶段 1、2、3 的入口已被替换，不需要同时保留或再次追加。正文分步代码与完整文件来自同一份参考源码。

完整文件用于核对拼接，设计与执行解释位于前面的对应步骤：请求和执行见阶段 1、2；动作、消息、状态和手动反馈见阶段 3；退出类型、依赖、完成规则和循环各分支见阶段 4。核对时沿“入口组装 → 循环调用 → 场景返回 → 循环写回与退出”的顺序连接四个文件，不需要再复制一份独立实现。

### `src/runtime/types.ts`

<<< @/snippets/01/src/runtime/types.ts{ts:line-numbers} [src/runtime/types.ts]

### `src/examples/diagnosis-scenario.ts`

<<< @/snippets/01/src/examples/diagnosis-scenario.ts{ts:line-numbers} [src/examples/diagnosis-scenario.ts]

### `src/runtime/agent-loop.ts`

<<< @/snippets/01/src/runtime/agent-loop.ts{ts:line-numbers} [src/runtime/agent-loop.ts]

### `src/examples/first-loop.ts`

<<< @/snippets/01/src/examples/first-loop.ts{ts:line-numbers} [src/examples/first-loop.ts]

本篇得到的是可重复观察的反馈与调度机制，还没有真实模型、超时取消或持久化。后续会从已有消息记录出发，区分程序持有的 State 与本轮供模型使用的输入信息，即上下文（Context）。

## 保存本篇版本并推送到 GitHub

完成阶段 4，恢复故障实验和路径迁移的临时改动，使代码回到本篇最终版本；先运行：

```bash
npm run typecheck
node src/examples/first-loop.ts
git branch --show-current
git status --short
```

类型检查应通过，入口应输出正常的两次决策与 completed。当前分支应是 `codex/chapter-01-feedback-loop`。下面按路径选择本篇四个源码文件和 site/ 网站更新；若暂存区此前已有其他文件，先用 `git diff --cached --stat` 核对，因为新的 git add 不会移除先前的暂存内容。确认提交范围后，复制执行：

```bash
git add -- src/runtime/types.ts src/runtime/agent-loop.ts src/examples/diagnosis-scenario.ts src/examples/first-loop.ts site/
git commit -F - <<'COMMIT'
第 01 篇：实现智能体反馈循环

将决策、工具执行与结果写回组织为可复用的运行流程，
使下一次决策能够使用上一次执行得到的观察。

- 定义工具请求、结果、消息和运行状态
- 分离诊断场景与通用循环，保留可替换的决策和执行入口
- 增加完成验证、决策次数限制和异常出口

验证：类型检查与示例运行通过；复现结果漏写回、提前完成和预算耗尽场景。
COMMIT
git push -u origin codex/chapter-01-feedback-loop
```

`git add` 选择本次要保存的文件，`git commit` 生成本地版本，`git push` 将该分支上传到 GitHub。提交信息采用中文标题加详细正文：第一行概括变化，空行之后说明目的、实现范围与验证。填写自己实际完成的检查，不把尚未运行的验证写成已通过。

`-F -` 从标准输入读取正文；复制时保留 `<<'COMMIT'` 与最后独占一行、不缩进的 `COMMIT`，中间的换行会原样进入提交信息。`-u` 建立远程关联，后续在这个分支提交后可直接执行 `git push`。命令默认第 00 篇已提交、origin 已配置；若使用其他分支名，修改最后一个参数。

命令中的四个源码路径对应本篇最终文件清单，中间入口版本已经被最终入口替换。site/ 包含教程、参考代码与导航；推送后将 Pull Request 合并到 main，网站才会自动部署。
