---
title: 第 01 篇｜第一条反馈闭环
description: 先运行请求、执行和反馈，再从固定流程推导通用循环，逐步补上状态保护与退出处理。
---

# 第 01 篇：让上一次执行结果进入下一次决策

本篇面向没有 Agent 基础、但能阅读函数、对象和数组的读者。从[第 00 篇](/guide/00-project-foundation)继续，当前工程只有配置与环境检查，Runtime 核心还是空的。

这一篇只抓住一条关系：**工具返回的结果，要先进入运行状态，下一次决策才能依据它继续。** 我们会先运行很小的代码，看到请求和结果，再把这些已观察过的步骤组织成循环。主线走通后，才补状态保护、完成验证和错误处理。

## 本篇推荐分支

推荐分支名：`codex/chapter-01-feedback-loop`。从第 00 篇已经完成检查并提交的本地版本创建：

```bash
git switch -c codex/chapter-01-feedback-loop
```

如果已经创建过该分支，用 `git switch codex/chapter-01-feedback-loop` 返回即可。各章代码沿上一章完成版本累积。

## 学习路线与文件变化

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

暂不新增单测，也不改第 00 篇配置。所有命令都在仓库根目录执行：

```bash
mkdir -p src/runtime src/examples
```

正文中短入口给完整内容，长模块分步追加。章末还有全部最终文件，用来核对，不是另一套实现。

## 先看问题：为什么空数组求和会失败

假设应用收到目标：“找出 `sum([])` 为什么抛错。” 项目里的源码是：

```ts
export const sum = (numbers: number[]) => numbers.reduce((a, b) => a + b);
```

`reduce` 没有初始累加值。数组有元素时可以从第一个元素开始累加，空数组没有这个元素，于是抛错。传入初始值 `0` 可以解决这类问题，但本篇只做**读取与诊断**，不修改文件或验证修复。

假如事先知道所有步骤，直接写“读取文件 → 分析内容 → 输出诊断”的固定流程就足够了。这种确定的流程并不需要额外包装成 Agent。问题在于，将来让模型根据已有信息提出下一步时，可能先读文件、读另一个文件、报告失败，或者提交答案。调用方无法提前把每个任务的步数都写死。

Agent（智能体）在本系列中指借助模型围绕目标选择下一步、执行操作并根据结果继续推进的程序。Runtime（运行时）负责管理这个执行过程：保存信息、安排调用、决定继续或停止。它会在固定任务步骤不再够用时派上用场。

大语言模型（Large Language Model，简称 LLM）根据输入生成文字或结构化响应。后续会让它提出动作；本篇先用按固定条件返回动作的函数代替它，称为**脚本决策器**。它没有推理能力，答案也是预设的。我们先用它检查信息传递是否正确，再接入真实模型。

## 阶段 1：先生成请求，马上运行

### 1.1 把“读什么”表示为数据

工具是程序提供的具体能力，例如读取文件的函数。执行工具之前，先需要一份请求，说明工具名称和参数。

创建 `src/runtime/types.ts`，现在只写下面这一个类型：

<<< @/snippets/01/src/runtime/types.ts#tool_call{ts:line-numbers} [src/runtime/types.ts · 阶段 1]

这就是数据契约：函数之间对“传什么形状的数据”的约定。

- `name` 标识工具种类，例如 `read_source`。
- `arguments` 是这次执行的参数，其中 `path` 表示读取哪个文件。
- `id` 标识一次调用。同一个工具可以执行多次，所以工具名不能代替调用 ID。

`Record<string, unknown>` 表示参数对象的键是字符串，值的类型需要使用方确认。不同工具有不同参数，不能在通用请求中把所有值都假定成字符串。它也不意味着 TypeScript 已经替我们检查了外部 JSON；正式的运行时校验留到工具章节。

### 1.2 创建固定场景的请求函数

创建 `src/examples/diagnosis-scenario.ts`。先写导入：

```ts
import type { ToolCall } from "../runtime/types.ts";
```

在导入之后追加：

<<< @/snippets/01/src/examples/diagnosis-scenario.ts#request{ts:line-numbers} [src/examples/diagnosis-scenario.ts · 阶段 1]

`createReadSourceCall()` 返回普通对象，不调用读取函数。`sourcePath` 是文件位置，`sourceCallId` 是本次请求的身份。本例只发出一次读取请求，暂用固定 ID；它不能直接作为以后多次调用的 ID 生成方案。

`import type` 只导入类型约定，不会在运行时创建请求。函数后的 `: ToolCall` 要求返回对象符合该形状；`export` 则允许入口从这个模块导入函数。本地导入路径相对于当前文件，所以场景文件用 `../runtime/types.ts` 找到相邻目录里的类型文件。

文件内容在哪里？现在还没有。我们只有“想读什么”的描述。

### 1.3 写一个很短的入口并运行

创建 `src/examples/first-loop.ts`，完整写入：

<<< @/snippets/01/checkpoints/01-request.ts{ts:line-numbers} [src/examples/first-loop.ts · 阶段 1 完整入口]

运行：

```bash
npm run typecheck
node src/examples/first-loop.ts
```

类型检查通过后，入口输出：

```text
request: read_source
id: read-1
path: src/sum.ts
```

现在三个文件都能检查和运行，但还没有执行器，所以也没有读取结果。这个阶段要区分的就是：**创建请求对象与真正执行操作，是两件事。**

## 阶段 2：让请求得到实际结果

阶段 1 的文件都保留。下面只追加结果类型和执行函数，再替换入口。

### 2.1 结果既可能成功，也可能失败

在 `src/runtime/types.ts` 的 `ToolCall` 类型之后追加：

<<< @/snippets/01/src/runtime/types.ts#tool_result{ts:line-numbers} [src/runtime/types.ts · 追加结果类型]

成功结果带 `value`，失败结果带 `message`。两者都有 `callId`，说明这是哪次请求的结果。例如请求的 ID 是 `read-1`，返回的结果也应该属于 `read-1`。

`status` 的两个固定值构成分支。代码判断 `result.status === "ok"` 后，TypeScript 就知道可以读取 `value`；否则应读取错误消息。这种根据字段值确定对象形状的机制叫类型收窄。

工具执行后得到、能用于后续决策的信息，常称为**观察（Observation）**。本例的成功观察是源码，失败观察则是读取没能完成的原因；代码中用 ToolResult 表达它们。

### 2.2 加入模拟执行器

将 `src/examples/diagnosis-scenario.ts` 顶部原来的单行导入替换为：

```ts
import type { ToolCall, ToolResult } from "../runtime/types.ts";
```

保留请求函数，在文件末尾追加：

<<< @/snippets/01/src/examples/diagnosis-scenario.ts#executor{ts:line-numbers} [src/examples/diagnosis-scenario.ts · 追加执行器]

执行器接收请求，先检查工具名，再检查路径。只有本例支持的读取才返回源码；错误名称和路径会得到错误结果。即使使用模拟数据，也不能对任何请求都返回成功，否则错误行为会被假结果掩盖。

`sourceCode` 是固定字符串，代替磁盘上的内容。因此这一段不会真正读取 `src/sum.ts`，也不要求磁盘存在这个文件。这里的路径比较只是固定场景检查，还不是文件系统安全隔离。

函数使用 `async`，其结果表示为 `Promise<ToolResult>`：结果可以稍后才取得。模拟实现本身没有等待磁盘，但采用异步接口，后续才能换成真实输入/输出操作（I/O）。

### 2.3 完整替换入口，再运行

把 `src/examples/first-loop.ts` 原内容全部删除，替换为：

<<< @/snippets/01/checkpoints/02-execute.ts{ts:line-numbers} [src/examples/first-loop.ts · 阶段 2 完整入口]

`await` 让这个入口等待执行器交回结果，再继续输出。它暂停当前异步执行过程，不会阻塞整个 Node 进程。

运行同样两条命令：

```bash
npm run typecheck
node src/examples/first-loop.ts
```

预期输出：

```text
request: read_source
[execute] read_source path=src/sum.ts
result: ok
callId: read-1
source: export const sum = (numbers: number[]) => numbers.reduce((a, b) => a + b);
```

与阶段 1 相比，多了执行日志和读取结果。此时 `result` 只保存在入口的变量里，程序还没有安排下一次决策，所以“执行成功”不等于“Agent 已经用过这个结果”。

## 阶段 3：先手动走通反馈，不急着写通用循环

已经能执行读取，下一步是让“决定下一步的函数”看到它。先用两次明确的函数调用观察这个过程，避免同时理解循环、预算和错误处理。

### 3.1 决策方返回动作，运行状态保存已有信息

在 `src/runtime/types.ts` 末尾按顺序追加下面两段：

<<< @/snippets/01/src/runtime/types.ts#actions{ts:line-numbers} [src/runtime/types.ts · 追加动作]

<<< @/snippets/01/src/runtime/types.ts#state{ts:line-numbers} [src/runtime/types.ts · 追加消息与状态]

动作（Action）表示决策方提出的下一步：tool 请求工具，finish 提交答案并请求结束，fail 表示无法继续。`kind` 是区分这些对象形状的字段；例如 finish 需要答案，但不需要工具调用参数。

消息（Message）是有顺序的记录，`role` 说明来源：

| 角色值 | 当前例子中记录什么 |
|---|---|
| user | 用户希望诊断 `sum([])` 的目标 |
| assistant | 决策方提出的读取请求或诊断完成请求 |
| tool | 执行器返回的源码或错误 |

assistant 是消息角色；本篇由脚本函数扮演决策方，还没有连接真实模型。

状态（State）表示本次运行当前持有的信息。`goal` 是目标，`messages` 是消息列表，`decisions` 是已取得并记录的动作数。目标既保留在 `goal` 字段里，也进入第一条用户消息：前者便于访问，后者保留完整交流记录。

为什么不只传一段源码？下一次决策还需要知道用户原来的目标、前面请求过什么。将这些信息按顺序保留，比只留一个孤立结果更容易追踪。

### 3.2 追加会查看状态的脚本决策器

把 `src/examples/diagnosis-scenario.ts` 顶部导入替换为：

<<< @/snippets/01/src/examples/diagnosis-scenario.ts#imports{ts:line-numbers} [src/examples/diagnosis-scenario.ts · 替换导入]

保留已有请求函数与执行器，在文件末尾追加：

<<< @/snippets/01/src/examples/diagnosis-scenario.ts#decision{ts:line-numbers} [src/examples/diagnosis-scenario.ts · 追加决策器]

第一次，最后一条消息是 user，就复用阶段 1 的函数产生读取请求。第二次，如果最后一条消息是本次读取成功后的预期源码，才提出 finish。没有可用观察就提出 fail。

这里的答案预先写在 `diagnosis` 中，脚本没有分析任意源码的能力。它要验证的是：**读到结果前后，输入变化是否足以让下一步动作变化。** 将来由真实模型承担判断，Runtime 仍要负责送入正确的信息。

`messages.at(-1)` 读取最后一项；`?.role` 在没有最后一项时得到 undefined。`Readonly<State>` 只限制顶层属性重新赋值，不会深度冻结嵌套消息；本阶段只把它交给我们自己编写的只读脚本，正式循环还会补数据保护。

### 3.3 替换入口，显式记录一次执行

把 `src/examples/first-loop.ts` 全部删除，再依次写入本小节和下一小节的三段代码。先初始化状态：

<<< @/snippets/01/checkpoints/03-feedback.ts#initialize{ts:line-numbers} [src/examples/first-loop.ts · 阶段 3 第 1 段]

状态属于这次执行，最初只有用户消息，决策计数为 0。接着追加：

<<< @/snippets/01/checkpoints/03-feedback.ts#first_turn{ts:line-numbers} [src/examples/first-loop.ts · 阶段 3 第 2 段]

执行顺序是：请求决策 → 记录该动作并计数 → 确认本阶段预期的 tool 动作 → 执行读取 → 把结果写入状态。

对象展开 `...state` 带入旧字段，后面的同名字段覆盖旧值。数组展开 `[...state.messages, 新消息]` 创建一个含旧消息和新消息的新数组；它不会深复制旧消息。赋值之后，变量 `state` 指向更新后的对象。

本段只演示预期路径。如果首个动作不是 tool，就抛错停止演示；这里还不是负责处理所有分支的通用 Runtime。

### 3.4 用最新状态进行第二次决策

在入口末尾追加：

<<< @/snippets/01/checkpoints/03-feedback.ts#next_turn{ts:line-numbers} [src/examples/first-loop.ts · 阶段 3 第 3 段]

第二次 `scriptedDecide(state)` 读取的是刚刚更新过的变量。上一次的结果若只停在 `result` 变量中，没有进入 `messages`，决策器不会自动知道它。

现在运行：

```bash
npm run typecheck
node src/examples/first-loop.ts
```

预期输出：

```text
[decide 1] roles=user
[execute] read_source path=src/sum.ts
[decide 2] roles=user -> assistant -> tool
next-action: finish
decisions: 2
messages: user -> assistant -> tool -> assistant
proposed-answer: sum([]) fails because reduce has no initial value
```

注意输出是 `next-action: finish`，还不是任务已验证完成。这一阶段只看到决策方提交了诊断；是否接受这个答案，要在阶段 4 增加规则。

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
[decide 2] roles=user -> assistant
next-action: fail
decisions: 2
messages: user -> assistant -> assistant
```

错误发生在执行之后、下一次决策之前。执行器已经工作，决策器却没有收到结果，所以不能靠增加决策次数修复这个缺口。恢复原语句，再运行至正常输出。

## 阶段 4：把重复安排提取成 Runtime，再补齐可靠性

到这里已经实际观察过请求、执行和反馈。接下来的代码会更多，但它们处理的是刚才已经走过的步骤。

### 4.1 从固定两步推导通用循环

阶段 3 把两次决策直接写在入口里。如果决策方第二次想再读一个文件，入口却只打印动作，就不会继续执行。若改成复制第三次、第四次调用，仍然需要提前猜任务长度。

因此提取一个负责安排步骤的函数：每次取得动作，按动作决定执行、结束或失败；执行结果进入状态后，再请求下一步。决策次数上限只负责防止无限重复，不能替我们判断答案正确。

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

这是本篇 Runtime 的系统位置：它不负责理解 `sum()`，而是管理“什么时候问、什么时候执行、怎么留存结果、什么时候停止”。换成 while 只是表达重复；依据信息选择动作的能力仍来自决策方，本篇暂由脚本代替模型。

先把这条主线与阶段 3 对上，再阅读下面的工程处理：保护状态、关联结果、限制次数、区分失败来源。它们围绕同一条链增加约束，不是另一套框架。

### 4.2 分开表达“留下什么事实”和“为什么退出”

在 `src/runtime/types.ts` 末尾追加：

<<< @/snippets/01/src/runtime/types.ts#outcomes{ts:line-numbers} [src/runtime/types.ts · 追加退出结果]

State 保存到当前为止的记录；Outcome 表示退出原因。读取成功但额度只有一次时，状态中有源码，退出却是 `budget-exhausted`，不应混为成功或异常。

失败的 `source` 区分决策、执行和完成验证边界。普通工具失败可能成为下一步需要处理的观察；调用身份对不上等情况则不能安全归档，稍后会从 execution 来源退出。

继续追加依赖接口：

<<< @/snippets/01/src/runtime/types.ts#dependencies{ts:line-numbers} [src/runtime/types.ts · 追加依赖接口]

前面已经写出两个具体函数，现在用接口约定它们应当怎样被循环调用。把函数从外面提供给循环，叫依赖注入：循环依赖这些能力，但不写死使用哪个模型或哪个读取函数。

第三个函数 `validateFinish` 由应用给出完成规则。模型提出 finish 不等于已经证明完成：诊断场景与修复场景有不同的证据要求，所以规则属于场景，调用规则的时机属于 Runtime。

### 4.3 在场景里补上有限的完成规则

在 `src/examples/diagnosis-scenario.ts` 末尾追加：

<<< @/snippets/01/src/examples/diagnosis-scenario.ts#validation{ts:line-numbers} [src/examples/diagnosis-scenario.ts · 追加完成规则]

先检查答案是约定诊断，再用 `some` 找到至少一条对应本次读取、状态成功、内容正确的工具消息。非工具消息提前返回 false，后面就可以安全访问 result。

这个规则只能检查本例的固定证据，不能证明任意自然语言诊断都正确，也没有验证文件已修复。以后任务变成“修复并检查”，需要新的完成证据，不能继续把字符串匹配当成完整验证。

### 4.4 创建循环文件：先看状态保护和错误表达

创建 `src/runtime/agent-loop.ts`，写入：

<<< @/snippets/01/src/runtime/agent-loop.ts#helpers{ts:line-numbers} [src/runtime/agent-loop.ts · 导入与辅助函数]

阶段 3 直接把状态交给已知脚本。正式接口面对可替换依赖，如果对方误改消息数组，循环不应因此多出虚构观察。因此 `snapshot` 用 `structuredClone` 创建当前状态的独立副本，让依赖改动副本而不是留存记录。

本章的字符串、数组和普通对象可被这种方式复制；函数和某些资源句柄不适合放入会话。`Readonly` 提供编译期提醒，快照提供数据复制，但它们都不能撤销工具已经产生的外部操作。

`failure` 统一失败结果字段。`errorMessage` 把捕获值转换成消息：JavaScript 允许抛出非 Error 值，不能无条件读取 `.message`。

这里用普通函数组织一次运行，因为状态只属于本次调用。有状态的 Agent 实例及事件订阅留待相关章节，不需要第一天建立继承层次。

### 4.5 建立循环骨架，取得并记录动作

接着在同一文件追加下面两段。函数与循环暂未闭合，直到 4.8 才组装完成：

<<< @/snippets/01/src/runtime/agent-loop.ts#loop_start{ts:line-numbers} [src/runtime/agent-loop.ts · 初始化与循环]

入口接收目标、依赖和决策上限。上限不是正整数时抛 `RangeError`，这是错误配置；有效配置运行后用完额度，则返回预算耗尽。两者含义不同。

状态在函数内部初始化，所以每次调用拥有不同的消息列表。while 只检查次数；某个 Promise 永远不返回时，次数上限无法让它超时，后续会专门实现时间边界。

继续在 while 内追加：

<<< @/snippets/01/src/runtime/agent-loop.ts#decide{ts:line-numbers} [src/runtime/agent-loop.ts · 决策与记录]

与阶段 3 对照：仍然是等待决策、记录动作、计数加一，只是现在通过依赖接口调用，并且提供状态副本。返回的动作也复制后再留存，防止依赖在返回后继续修改同一个对象。

复制不是结构校验；当前依赖须遵守 TypeScript 接口，未知 JSON 的正式校验在后续实现。决策器抛错时返回 decision 失败；没有拿到动作，就不会增加已记录决策数。

### 4.6 明确处理 fail 和 finish

继续追加这两个分支：

<<< @/snippets/01/src/runtime/agent-loop.ts#fail{ts:line-numbers} [src/runtime/agent-loop.ts · 主动失败]

fail 是决策方明确提出的动作，已经记入历史并计数；它不同于决策函数自己抛出异常。return 结束整个循环函数，不会再执行工具。

<<< @/snippets/01/src/runtime/agent-loop.ts#finish{ts:line-numbers} [src/runtime/agent-loop.ts · 完成验证]

finish 先交给场景完成规则，返回 true 才成为 completed；没有证据或验证函数抛错，都从 validation 来源退出。本篇对验证拒绝采取直接失败策略，不自动再问模型。

在这个位置，当前 finish 已记入状态，所以验证规则看到四条消息；第二次 decide 则在 finish 产生前看到三条消息。这个先后关系之后会用于调试。

### 4.7 执行工具，先核对结果身份

接着追加：

<<< @/snippets/01/src/runtime/agent-loop.ts#execute{ts:line-numbers} [src/runtime/agent-loop.ts · 执行与关联]

前面两个动作分支触发时已经 return，走到这里的联合类型只剩 tool，因此可以访问 `action.call`。Runtime 调用执行器并等待结果。

普通执行异常被转成带原调用 ID 的 error 结果，让下一次决策知道发生了失败。它可以据此决定是否继续；本篇脚本会提出 fail。循环不应假定每种错误都能安全重试。

如果请求是 read-1，结果却标成 other，就无法安全关联，必须在写入状态前拒绝。**失败结果可以记录，身份不匹配的结果不能假装属于这次请求。** 本章只核对一次请求的对应关系，不宣称已解决多调用身份管理。

### 4.8 写回结果，并闭合循环

最后追加：

<<< @/snippets/01/src/runtime/agent-loop.ts#writeback{ts:line-numbers} [src/runtime/agent-loop.ts · 回写结果]

<<< @/snippets/01/src/runtime/agent-loop.ts#loop_end{ts:line-numbers} [src/runtime/agent-loop.ts · 退出循环]

这还是阶段 3 已验证过的状态更新。工具返回值本身不够，必须追加为 tool 消息，下一轮才能收到。工具执行不会额外增加决策计数。

回到 while 条件时，额度足够就再问下一步；否则返回 budget-exhausted。不能因为最后一个工具成功，便跳过完成规则直接宣告完成。

现在循环文件已完整，运行 `npm run typecheck` 排除导入、类型和括号拼接问题。它还没有被入口调用，所以不会自动开始任务。

### 4.9 最后一次替换入口，使用通用循环

将 `src/examples/first-loop.ts` 的阶段 3 内容全部删除，按顺序写入下面两段。前面已写的场景文件和类型保留：

<<< @/snippets/01/src/examples/first-loop.ts#imports{ts:line-numbers} [src/examples/first-loop.ts · 最终入口导入]

<<< @/snippets/01/src/examples/first-loop.ts#run{ts:line-numbers} [src/examples/first-loop.ts · 最终入口调用]

依赖对象传入的是函数本身，没有加括号立即执行。循环会在需要时传入当前状态或请求。这时入口无需写死先调用两次决策：下一步由每次返回的动作决定，重复安排由循环负责。

运行：

```bash
npm run typecheck
node src/examples/first-loop.ts
```

预期输出：

```text
[decide 1] roles=user
[execute] read_source path=src/sum.ts
[decide 2] roles=user -> assistant -> tool
outcome: completed
decisions: 2
messages: user -> assistant -> tool -> assistant
answer: sum([]) fails because reduce has no initial value
```

这次有 completed，因为完成规则已接受证据。`maxDecisions` 为 3 不要求运行三次；第二次验证完成就直接返回。前面的固定步骤已被统一调度，但请求、执行、决策的场景函数仍是同一组。

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

运行最终入口，应该没有 `[execute]` 日志，并出现：

```text
[decide 1] roles=user
outcome: failed
decisions: 1
messages: user -> assistant
failure: validation: Completion lacks verified evidence
```

答案虽是约定字符串，却没有读取证据，因而完成规则拒绝。恢复原来的 `return { kind: "tool", call: createReadSourceCall() };`，再运行正常入口。

### 一次工具成功不够完成两次决策

只把 `src/examples/first-loop.ts` 的 `const maxDecisions = 3` 暂时改成 1。运行应有第一次决策和执行日志，没有第二次决策，最终输出：

```text
outcome: budget-exhausted
decisions: 1
messages: user -> assistant -> tool
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

共同机制是工具结果进入后续请求。Pi 还处理真实模型流式响应和工具批次，本篇尚未实现。`validateFinish` 和固定诊断规则是本系列自己的应用完成标准设计，不能推断 Pi 使用相同接口。

## 本篇知识地图

- 请求描述“想做什么”，执行器才真正产生结果。
- 状态保存目标、动作和观察；下一次决策必须使用更新后的状态。
- 反馈让结果影响下一步；循环统一安排这些步骤，本身不提供模型判断能力。
- 场景提供决策、执行和完成规则；Runtime 持有状态并控制继续与退出。
- completed、failed 与 budget-exhausted 表达不同的结束事实。

主线最重要的是找到结果写回与再次决策的位置。快照、错误来源和完成规则围绕这条主线提供工程约束，可以结合对应实验回读，不必先背类型名称。

## 最终四个文件：用于核对

下面只对应阶段 4 的最终状态。阶段 1、2、3 的入口已被替换，不需要同时保留或再次追加。正文分步代码与完整文件来自同一份参考源码。

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

类型检查应通过，入口应输出正常的两次决策与 completed。当前分支应是 `codex/chapter-01-feedback-loop`。下面按路径选择本篇四个源码文件；若暂存区此前已有其他文件，先用 `git diff --cached --stat` 核对，因为新的 git add 不会移除先前的暂存内容。确认提交范围后，复制执行：

```bash
git add src/runtime/types.ts src/runtime/agent-loop.ts src/examples/diagnosis-scenario.ts src/examples/first-loop.ts
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

命令中的四个路径对应本篇最终文件清单，中间入口版本已经被最终入口替换。课程网页的修改可以按文档变更另行提交。
