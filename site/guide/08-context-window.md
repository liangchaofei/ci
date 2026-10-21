---
title: 第 08 篇｜实现模型输入选择
description: 保留完整 State，从历史中选择成组消息，加入可核对的摘要，并在输入装不下时明确退出。
---

# 第 08 篇：实现模型输入选择

本篇实现的功能叫**模型输入选择**：每次询问模型前，决定这次带哪些历史内容。它发生在 Runtime 内部，每轮调用 decide 之前。

### 什么场景需要它

假设 Agent 正在排查 sum([]) 报错，前面已经读到一大段构建日志，刚才又读到了源码和测试。现在还要问模型：“根据这些材料，错误原因是什么？”

之前的 Runtime 会复制全部历史，把长日志、源码和测试再发一遍。任务持续越久，历史通常越多，每次输入也可能越来越大。这里希望保留用户任务和最近的源码、测试，同时把较早的长日志换成简短事实摘要。

这就是本章代码要实现的行为变化。完整记录仍留在 State 中；只有这一次提供给模型的 Context 可以变短。短任务能全部装下时，仍然发送完整历史，不必为了使用新功能而刻意丢内容。

### 它在 Runtime 哪个位置

沿已有的 Agent Loop 看，本篇增加的位置如下。图中沿工具请求继续，省略完成与失败等出口：

```text
用户任务
   ↓
State：保存到目前为止的完整运行历史
   ↓
【第 8 篇：准备这一次的模型输入】
   选择保留的原文，必要时为较早记录提取摘要
   检查必须保留的内容能否装下
   ↓
Context：本轮选出的消息，以及可选摘要
   ↓
decide：根据这份输入，请模型提出下一步动作
   ↓
Runtime 执行请求的工具
   ↓
结果写入完整 State
   ↓
回到上方，为下一轮重新选择输入
```

因此它不会替模型判断错误原因。它负责让模型这次拿到适当的材料；模型根据材料提出动作，工具执行和结果写回继续使用前面章节的代码。

## 先走一次任务，再看文件

### 到这一轮，程序已经知道什么

用户要求：“结合源码和测试解释 sum([]) 报错；只诊断，不修改文件。”前面已经执行过两次决策：

```text
第 1 次决策：请求读取 build.log
工具返回：退出码 1、失败用例 sum([])、一大段日志

第 2 次决策：一起请求读取源码和测试
工具返回：源码内容、测试内容

接下来：准备第 3 次决策的输入
```

State 已经保存 6 条消息：

```text
0  user       原始任务，包括“只诊断，不修改”
1  assistant  请求读取构建日志
2  tool       构建日志结果，很长
3  assistant  一起请求源码和测试
4  tool       源码结果
5  tool       测试结果
```

此前准备模型输入时，会复制全部 6 条。现在希望第 3 次决策看到这些内容：

```text
原始任务：仍然保留
较早日志的摘要：退出码为 1，失败用例为 sum([])
最近的完整请求：读取源码和测试
对应的完整结果：源码内容、测试内容
```

**这里变短的是本轮 Context，State 的 6 条消息都还在。** 后面的完成检查仍可查看完整 State，下一轮的调用 ID 检查也仍从完整历史中查重。摘要不是删掉旧事实，更不是把失败日志改成“已经修好”。

### 为什么不能只取最后两条消息

最后两条恰好是源码与测试结果。但模型接口还需要知道它们对应哪次请求。只留下两条 tool 消息，会丢掉前面的 assistant 调用记录。

因此本篇按“完整组”选择消息：一个工具请求动作，与它的全部结果放在同一组。前面的日志是 2 条一组；后面的批次是 3 条一组。省略时整组省略，保留时整组保留，不截断某份 JSON，也不只留先返回的结果。

原始 user 消息单独固定保留，防止原始任务和限制随着早期日志一起消失。本篇处理单次任务中的历史选择；运行中用户追加约束会在后续输入队列章节继续展开。

[![完整 State 保留六条消息；负责选择历史的代码省略早期日志组，保留原始任务与最新三条消息，并把日志事实摘要加入 Context](/diagrams/context-window-selection.svg)](/diagrams/context-window-selection.svg)

点击可放大。箭头表示构造新输入，不是从 State 删除消息。最后交给 decide 的仍是 Context；真正发给模型时，还要转换成接口消息。

### “输入大小”和“模型窗口”不是一个计数

模型会把文本转换成 token，可以先理解为模型处理文字时使用的小单元。token 数不等于字符数，也不等于 UTF-8 字节数；实际用量应查看服务返回的 usage。[DeepSeek：Token 用量计算](https://api-docs.deepseek.com/zh-cn/quick_start/token_usage/)

**上下文窗口**是一次请求可容纳的输入与输出总量。不能只把历史填满，还要给答案留空间；模型接口的 max_tokens 限制输出，并不能替应用缩短过长的输入。[DeepSeek：max_tokens 与上下文长度](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/)

本篇先实现一个能准确复现的本地规则：限制本轮模型输入对象转为 JSON 后的 UTF-8 字节数。这样能实际比较裁剪前后大小，并观察超限出口。**它不是精确 token 预算，也不是模型窗口不会超限的保证**：适配器还会加入 system、工具说明和协议字段，这些不在本次计数内。

接入真实服务时，要按目标模型的窗口和输出需求留余量；后续资源控制再接实际用量与费用。这里不引入未经核对的换算系数，也不声称限制 1600 字节就等于限制某个固定 token 数。

## 推荐分支与前置版本

从已完成并提交的第 7 篇版本创建：

```bash
git switch -c codex/chapter-08-context-window
```

分支已存在时用 `git switch codex/chapter-08-context-window`。所有命令在仓库根目录执行，不增加依赖。先运行 `npm run typecheck` 与 `node src/examples/inspect-batch-loop.ts parallel`，确认批次闭环仍正常。

::: info 验证范围
本篇候选实现在独立工程验证了完整组、字节预算、摘要、状态副本、三轮反馈、输入超限以及模拟 HTTP 中实际发送的消息。真实 DeepSeek 调用未在编写时执行；联网入口需要本地密钥与账户，不能用离线结果代替真实服务验收。
:::

## 这次改动怎样接到原系统

接下来的实现分三段：先识别必须一起保留的记录，再决定本轮保留哪些内容，最后把这一步接到每次模型调用之前。各阶段沿用同一份任务数据，最终组成同一套 Runtime。

下面的文件表用于查找修改位置，具体实现按后面的阶段顺序进行。

| 文件 | 变化 | 在这次运行中做什么 |
|---|---|---|
| `src/runtime/context-exchanges.ts` | 新增 | 把工具请求与对应结果分组，拒绝残缺关联 |
| `src/examples/context-fixture.ts` | 新增 | 准备长日志和六条历史的固定样本 |
| `src/examples/inspect-context-window.ts` | 新增，阶段间替换 | 先观察组，再比较全量与选出的输入 |
| `src/runtime/types.ts` | 修改 | Context 可带摘要，Outcome 可表达输入限制 |
| `src/runtime/context-window.ts` | 新增 | 检查配置、选择完整组、计量新输入 |
| `src/runtime/context.ts` | 修改 | 每次从 State 构造输入，保留旧全量入口 |
| `src/examples/context-scenario.ts` | 新增 | 从已省略日志提取事实，并提供离线三轮决策 |
| `src/runtime/agent-loop.ts` | 修改 | 决策前准备输入，装不下就先退出 |
| `src/adapters/deepseek/protocol.ts` | 修改 | 把摘要作为参考数据转换成接口消息 |
| `src/examples/inspect-windowed-loop.ts` | 新增 | 在原 Runtime 里观察三轮运行和超限 |
| `src/examples/deepseek-batch-agent.ts` | 修改 | 原真实模型入口增加输入配置 |

共新增 6 个文件、修改 5 个文件。批次调度、工具注册、流式拼接和 RunControl 的代码不需要重写。

## 第一阶段：先把不能拆开的消息放在一起

输入选择需要先知道“哪些记录必须一起保留或省略”。正式运行时，记录来自之前的模型动作与工具结果；这一阶段先准备同样形状的固定样本，单独观察分组，第三阶段再让原循环实际积累这些记录。

### 1. 先把要处理的历史准备出来

先准备一份程序可以实际接收的历史。这样写后面的函数时，我们知道每个变量装的是什么，而不只是看见 Message 这样的类型名称。

新建 `src/examples/context-fixture.ts`，先写顶部导入：

```ts
import type { State, ToolCall, ToolResult } from "../runtime/types.ts";
import { batchCalls, testsCode } from "./batch-fixture.ts";
import { sourceCode } from "./diagnosis-fixture.ts";
```

继续写日志请求、返回值与任务文本：

<<< ../snippets/08/src/examples/context-fixture.ts#log

logCall 描述读取 build.log；logResult 模拟它返回的长日志。exitCode 与 failingCase 是可以直接检查的结构化事实，output 则故意放长，方便观察体积变化。它们是准备好的样本，不会执行 shell 或读取磁盘。

contextGoal 保留“只诊断，不修改文件”。稍后它会作为第一条 user 消息，始终进入本轮输入。

再追加完整样本创建函数：

<<< ../snippets/08/src/examples/context-fixture.ts#state

这就是开头的 6 条消息。第一个 assistant 与后面的日志结果是一组；第二个 assistant 与两份读取结果是一组。decisions 为 2，因为已有两个请求动作，不是因为共有三个工具调用。

每次 createContextFixture 都返回新对象，避免观察时改动样本影响下一次运行。它只为检查输入选择提供一个决策前的 State，不是会话恢复功能；正式循环仍会从用户任务开始自行积累历史。

### 2. 删旧日志时，怎样不把一次请求拆开

这一步服务于刚才的“模型输入选择”。为了让下一次模型输入变短，我们准备省略早期日志；但日志占着两条消息：一条请求、一条结果。需要一起省略，不能只删日志内容却留下没有结果的请求。

近期的源码与测试也一样：虽然有两份结果，它们来自同一个批次请求，三条消息要一起保留。接下来的代码先将这些关系整理成一组组消息，后面再写代码决定省略哪些组。

运行到这一步时，工具早已执行完成，我们处理的是保存下来的历史记录。先看需要怎样整理，再看具体实现。

#### 它拿到什么，希望交回什么

首条 user 任务要一直保留，不参与本次分组。取 `state.messages.slice(1)` 后，传入的数组有 5 条。下面用刚才样本中的关键字段标记它们，省略大段内容，只用于观察：

```text
messages[0]：assistant，请求 log-1
messages[1]：tool，结果属于 log-1
messages[2]：assistant，一次请求 source-1、tests-1
messages[3]：tool，结果属于 source-1
messages[4]：tool，结果属于 tests-1
```

目标是交回两个小数组：

```text
groups = [
  [日志请求, 日志结果],
  [源码与测试的批次请求, 源码结果, 测试结果]
]
```

这就解释了返回类型 Message[][]：最外层数组放两个组，每个组里面放它包含的 Message。不是新造两条消息，也不是执行两个任务；原来的 5 条消息只是被放进两个容器。

接下来选择输入时，可以省略 groups[0]，完整保留 groups[1]。**这一步先整理分组，后面再决定保留或省略哪些组。** 如果没有这一步，直接按最后两条来取，就只剩两个 tool 结果，丢掉它们对应的 assistant 请求。

新建 `src/runtime/context-exchanges.ts`，写入完整内容：

<<< ../snippets/08/src/runtime/context-exchanges.ts

这里导出的函数叫 groupExchanges，group 表示分组，exchanges 在本项目指请求与对应结果的组合。它完成的就是上面的“5 条消息变成两个组”。

#### 先辨认这些变量，不急着读循环

| 变量 | 用这份输入看，它装什么 |
|---|---|
| messages | 上面 5 条已经记录好的消息 |
| index | 当前读到消息数组的哪个位置，从 0 开始 |
| calls | 当前 assistant 提出的调用；日志时有 1 项，批次时有 2 项 |
| group | 正在拼的一组，例如先放日志请求，再加入日志结果 |
| groups | 已经拼好的所有组，是最终返回值 |
| pending | 当前这组还欠哪些调用结果 |
| usedIds | 之前读过的所有调用 ID，用于查重 |

这里复用的 toolCallsOf 来自第 7 篇：从 tool 动作取出单项 call，从 tools 动作取出 calls；没有工具请求时返回空数组。它只把调用取出来，不会执行。validateToolBatch 则检查这些请求的身份和形状，以及有没有重复 ID；不是再次读取文件。

#### 第一组：从日志请求走到日志结果

外层循环从 index=0 开始，message 是日志请求，role 为 assistant。toolCallsOf 找到那份 log-1 调用，所以 calls.length 为 1，不走“没有工具请求”的分支。

检查通过后，pending 先装入 log-1，意思是“这份请求的结果还没找到”；usedIds 也记下 log-1，防止后面另一份请求冒用它。group 先放当前 assistant 消息，现在只有日志请求。

内层循环要读的结果数量等于 calls.length，也就是 1。index 加到 1，observation 取到日志结果。它确实是 tool，而且 callId 是正在等待的 log-1，于是从 pending 移除这个 ID，把结果加入 group。

此时 group 已是 `[日志请求, 日志结果]`，再把它放入 groups。注意这两次 push 的区别：group.push 加入一条结果，groups.push 加入刚拼好的一整个组。

#### 第二组：一个请求动作带两份结果

回到外层循环，for 自己再把 index 从 1 加到 2。message 现在是源码与测试的批次请求。calls 有两项，所以 pending 装入 source-1 和 tests-1，group 先放这条批次请求。

这次内层循环运行两次：先把 index 加到 3，找到源码结果，移除 source-1 并把它加入 group；再把 index 加到 4，找到测试结果，移除 tests-1 并加入 group。然后把三条消息组成的 group 放入 groups。

外层再把 index 加到 5，已经到数组末尾，返回两组。沿途的位置如下：

| 外层从哪里开始 | 内层读哪些结果 | 这一组结束时 index | 下次外层开始 |
|---|---|---:|---:|
| 0：日志请求 | 1：日志结果 | 1 | 2 |
| 2：批次请求 | 3：源码结果，4：测试结果 | 4 | 5，结束 |

所以 tool 消息会在内层被读走，正常情况下不会再次落到外层的 message 上。开头那个“若是 tool 就抛错”，是在防止没有请求带领的孤立结果，不是在拒绝所有工具结果。

#### 这些检查在防什么具体错误

假设批次请求后只有源码结果，没有测试结果。第二次读取 observation 会得到 undefined，函数就抛错；不能把残缺批次交给后面，假装它是一组完整历史。

再假设两条结果都写成 source-1。第一条通过时，pending 已删除 source-1；第二条再执行 delete 会返回 false，于是拒绝。Set.delete 返回的布尔值表示“这个 ID 刚才是否在集合里”，不是判断文件是否删除成功。

条件用 `||` 连接三件事：没有后续消息、后续不是 tool、ID 不在当前等待集合。任意一项成立，就说明不能把这条消息当作所需结果。检查从左到右进行，前面失败就停止，不会对 undefined 继续读 result。

没有工具请求的 user 或 assistant 则单独放成一组。空的 tools 动作属于错误输入，不能伪装成普通无工具消息。usedIds 与 pending 也不能合成一个集合：前者保存整段历史见过的身份，后者只保存当前组尚缺的结果。

返回的两组会在第 6 步用于决定本轮发送哪些历史。到那里才会省略整个日志组、保留整个近期批次，再生成 Context。也就是说，这个函数完成的是输入选择所需的准备工作；真正改变本轮发送内容的位置在后面。

### 3. 第一次运行：先只看分组

新建 `src/examples/inspect-context-window.ts`，先使用这一阶段的完整内容：

<<< ../snippets/08/checkpoints/01-groups.ts

运行：

```bash
npm run typecheck
node src/examples/inspect-context-window.ts
```

应看到：

```text
原历史消息数（stateMessages）: 6
完整组大小（groups）: 2 -> 3
```

slice(1) 跳过固定保留的首条 user，把后面的历史交给 groupExchanges。2 和 3 表示每组包含几条消息，不表示 token 或并发数量。此时只是分组，6 条消息一条都没省略，也没有模型调用。

## 第二阶段：构造更短的 Context

现在已经知道哪些消息应当在一起。接下来才决定保留哪几组、为省略的旧日志提取什么事实，并把它们装成一份可交给 decide 的 Context。这一阶段会实际改变本轮输入的内容，完整 State 继续保留。

### 4. 让 Context 能携带摘要

省略完整日志后，模型还需要知道“之前构建失败，失败用例是 sum([])”。如果只保留近期四条消息，这条线索就不再发送。我们把少量事实放在一个单独的 summary 字段，和保留的消息一起交给 decide。

例如本轮输入要表达的是下面这个形状。它是结构示意，不需要复制到源码：

```text
Context
  messages：原始任务、最近批次请求、源码结果、测试结果
  summary：较早构建退出码为 1，失败用例为 sum([])
```

因此先允许 Context 带这段文本；类型变化不会自行生成摘要，提取事实的函数稍后实现。

在 `src/runtime/types.ts` 中，只用下面整段替换 DecisionContext，其他类型暂时不动：

<<< ../snippets/08/src/runtime/types.ts#context

messages 继续保存本轮选择的原消息。新增的可选 summary 保存省略部分的文字概括，没有摘要时就不提供。它不是工具结果，不添加 callId，也不会冒充某次成功执行。

State 没有增加 summary 字段。这一版每次都从完整历史重新构造 Context，需要时才对本次省略部分生成摘要；不是把上一轮摘要不断叠加回 State。

### 5. 给输入计量，并区分超限

现在能把“保留消息”和“日志摘要”装进同一份输入了，但怎么判断它够不够短？本例给这份输入 1600 字节的上限。程序需要一把明确的尺子，分别量全量历史和选择后的内容。

要量的是 Context，不是 State：State 仍可保留那份长日志，我们只限制这一次准备交给 decide 的内容。下面先定义上限配置、计量函数，以及所有允许保留的内容仍装不下时使用的错误。

新建 `src/runtime/context-window.ts`，先写顶部导入：

```ts
import type { DecisionContext, Message } from "./types.ts";
import { groupExchanges } from "./context-exchanges.ts";
```

接着写配置、错误类型与计量函数：

<<< ../snippets/08/src/runtime/context-window.ts#contracts

maxBytes 是本地消息输入上限；keepRecentExchanges 默认 1，表示至少保留最新的一组；summarize 是可选函数，收到被省略的消息，交回一段文本。它由应用提供，Runtime 不应该内置“构建日志里什么内容最重要”。

measureContextBytes 先把整个 Context 转成 JSON，再用 TextEncoder 得到 UTF-8 字节数。summary 也是 Context 的字段，因此会一起计量。直接读取字符串 length 得到的是 JavaScript 字符串长度，遇到中文时不能当作 UTF-8 字节数。[MDN：TextEncoder](https://developer.mozilla.org/zh-CN/docs/Web/API/TextEncoder)

ContextWindowError 是 Error 的一个专门类型。后面循环通过 instanceof 识别本模块的超限，而不是匹配一句错误文本。配置写成 0 或小数则是配置错误，用 RangeError 表达，和有效配置下仍装不下输入分开。

### 6. 从完整历史里选择

分组已经回答“哪些消息要一起留”，字节计量回答“这份输入有多大”。现在把两件事接起来：先尝试带全部历史；超过 1600，就省略最早的完整日志组，换成摘要，再量一次；能装下才交回。

对当前样本，预期就是从“原始任务 + 日志组 + 源码与测试组”，变成“原始任务 + 源码与测试组 + 日志摘要”。这个函数真正实现本篇的输入选择。

继续在 `context-window.ts` 末尾追加完整创建函数：

<<< ../snippets/08/src/runtime/context-window.ts#selector

#### 先看一次正常选择

createContextWindow 接收配置，返回选择函数。创建时检查上限和最少保留组数；调用返回的函数时，才处理这一次的消息。

用刚才的样本、maxBytes 为 1600、keepRecentExchanges 为 1 来看：

```text
复制历史 → 单独保留最前面的 user
其余分成 [日志组, 源码与测试组]

drop = 0：先试全部保留，体积超过 1600

drop = 1：省略日志组，保留源码与测试组
          如有摘要函数，为日志组生成摘要
          把摘要与保留消息放进同一份 Context 再计量
          能装下 → 返回这一份 Context
```

drop 表示省略最早几组。maxDrop 则限制最多能省略多少：共有两组、必须留一组，所以最多省略一组。for 每次只多省略最早的一组，找到第一份能装下的输入就返回，不会为了更短而继续丢掉更多历史。

groups.slice(drop).flat() 取得保留组并摊平成消息数组，再把 first 放在最前面。摘要从另一边 groups.slice(0, drop) 取得省略的完整组。两边不会把同一组一半当原文、一半当摘要。没有工具历史时 groups 为空，只尝试保留原始任务，不会为了省空间删除它。

构造 context 时，条件展开 `...(summary ? { summary } : {})` 表示有摘要才加入这个字段。摘要函数可能随着 drop 增加而接收不同的省略范围，应只根据参数生成文本，不依赖调用次数。

#### 返回 Context 不等于改掉 State

copy 来自 structuredClone(messages)，后面的组都从这个副本中选。选择器返回新 Context，既没有给 state.messages 赋值，也没有删除原历史。

摘要函数又收到省略部分的独立副本。它即使误改自己的参数，也不能改变 Runtime 保存的事实，或修改最终保留的近期消息。摘要文本随后进入本轮 Context，不是写入另一条虚构 tool 消息。

#### 最近的一组也太大怎么办

如果原始任务、必须保留的近期组和摘要仍超过 maxBytes，尝试结束后抛 ContextWindowError。它不会剪掉源码的一半，不会只留一个批次中的某份结果，也不会无限继续删最新组。

这样“本轮输入无法按当前规则构造”成为可以处理的情况。调用方可以调整预算或改进工具输出；不能让代码偷偷删除必要材料，然后仍假装本轮输入完整。

**context-window.ts 实现本篇的选择规则**：从完整历史得到本轮 Context，或者说明必留内容仍装不下。下一步再把这个返回值接到原来的输入准备入口，最后交给循环中的 decide。这里的摘要回调是同步的，适合快速提取结构化事实；异步模型压缩需要独立的等待、取消和摘要检查，本篇不把它藏在这个同步函数中。

### 7. 接回原 Context 入口

我们刚写的选择器拿到的是消息数组，可原循环手中持有的是 State。还需要一个连接：每次从最新 State 取出 messages，交给选择器，并把返回的 Context 交还循环。

原来这个连接由 context.ts 完成，只会复制全量消息。现在给它增加可选规则：有配置就选择，没有配置就继续全量复制。这样旧例子还能使用原入口。

将 `src/runtime/context.ts` 整个文件替换为：

<<< ../snippets/08/src/runtime/context.ts

createContextBuilder 在一次运行开始时准备选择规则，返回的函数每轮接收最新 State。配置了输入窗口，就把 state.messages 交给 select；没有配置，仍复制全部消息，保留前面章节的行为。

buildDecisionContext 是旧的直接调用入口，现在内部复用同一创建函数，因此旧 inspect-context.ts 不需要重写。接入正式循环时，会提前创建输入构造函数，每轮拿最新 State 来调用它；直接观察时则用已有的 buildDecisionContext。两条入口最终都要把选出的 Context 交给调用方，不会自行开始模型请求。

此时 Runtime 的旧调用还没有启用窗口，原循环仍用旧入口取得全量消息。我们先直接运行新入口，确认选择本身正确，再接回循环。

### 8. 应用怎样从日志里提取事实

选择器知道哪些旧消息被省略，却不知道它们的业务含义。把任意长文本截取前一百个字，也可能恰好丢掉真正的失败原因。

本例的日志结果已经有 exitCode、failingCase 两个字段，因此不用让模型猜：先找到读取 build.log 的对应结果，确认字段，再写成一段简短事实。下面的函数就负责把“日志请求与结果这两条消息”转换成“退出码为 1、失败用例为 sum([])”这段文本。

新建 `src/examples/context-scenario.ts`，先写导入：

```ts
import type { Action, DecisionContext, Message } from "../runtime/types.ts";
import { toolCallsOf } from "../runtime/action-tools.ts";
import { batchCalls } from "./batch-fixture.ts";
import { logCall } from "./context-fixture.ts";
import { diagnosis } from "./diagnosis-fixture.ts";
```

追加完整摘要函数：

<<< ../snippets/08/src/examples/context-scenario.ts#summary

摘要器不能凭空写“日志中发现了错误”。它先从 assistant 请求确认哪些 ID 是读取 build.log，再找这些 ID 对应的成功结果。结果 value 必须是对象，而且明确给出 exitCode=1、failingCase=sum([])，才返回这段事实摘要。

这里成功的是“读到了日志”，日志里的构建退出码仍为 1，两者没有矛盾。第 7 篇提供的完成检查核对源码与测试证据，也不会因为存在日志摘要就把修复当成成功。

output 的长原文不出现在摘要中，所以省了空间；失败用例与退出码仍保留。找不到可核对事实就返回空字符串。这只是本场景的结构化提取，不是通用的语义压缩，也没有调用另一个模型。

再追加离线决策函数，下一阶段会使用：

<<< ../snippets/08/src/examples/context-scenario.ts#decide

第一次输入只有 user，它提出读日志。第二次最新消息是 log-1 的结果，它提出源码与测试批次。第三次同时看到近期测试结果和早期摘要，就返回固定 diagnosis；否则提出 fail。

这个脚本让三轮路径可预测，不会分析任意问题。完成检查仍由原 hasBatchEvidence 从完整 State 核对两份读取材料，不是靠脚本看到 summary 就直接成功。

回到功能主线：输入选择器决定省略日志后，调用 summarizeBuildLog 取得文字，把文字加入 Context；循环再将这份 Context 交给 scriptedWindowDecide。前者帮助准备材料，后者扮演收到材料的模型。真正的 State 写回仍在循环中。

### 9. 比较裁剪、摘要与完整历史

现在先不运行 Agent。拿第 1 步创建的同一份 State，分别准备两种输入：一种带全部消息；另一种在 1600 字节限制下选择消息。比较二者，再确认原始 State 没变，就能单独验证这段功能。

将 `src/examples/inspect-context-window.ts` 整个文件替换为当前完整入口：

<<< ../snippets/08/src/examples/inspect-context-window.ts

入口先准备同一份样本，再构造全量 Context 和配置后的 Context。mode 只是选择观察方式：plain 不带摘要，summary 带结构化摘要；small 与 huge-summary 留给故障实验。除了日志，它没有把选择结果赋回 state。

先运行只裁剪的方式：

```bash
npm run typecheck
node src/examples/inspect-context-window.ts plain
```

主要输出为：

```text
原历史消息数（stateMessages）: 6
完整组大小（groups）: 2 -> 3
全量大小（fullBytes）: 14913
本轮大小（contextBytes）: 571
本轮消息数（contextMessages）: 4
本轮摘要（summary）: 无
最近结果（callIds）: source-1 -> tests-1
原历史仍保留（stateMessages）: 6
```

再带上摘要：

```bash
node src/examples/inspect-context-window.ts summary
```

本轮大小变为 699 字节，消息仍为 4 条；新增的是 summary 字段，而不是第五条本地消息。摘要应为：

```text
较早的构建日志：退出码为 1，失败用例为 sum([])。这是历史诊断线索，不表示已修复。
```

571 与 699 的差额说明摘要也占空间。两次运行最后的 State 都有 6 条消息，这才与“只选择输入、不删除事实”的设计一致。若编辑了样本字符串，字节数会变化；这里的精确数字对应本篇展示的固定数据。

## 第三阶段：每次决策前使用同一规则

### 10. 给输入装不下一个明确出口

独立观察时，装不下可以直接抛错；接回 Runtime 后，调用方需要知道任务为什么结束。例如最新源码本身很大，又必须保留，不能再问模型，也不是决策次数用完了。

因此为运行结果增加 context-limit。接下来的循环会在输入准备失败时返回它，而不会去执行下一次模型请求。

在 `src/runtime/types.ts` 中，用下面完整类型替换 Outcome，其他类型保持不变：

<<< ../snippets/08/src/runtime/types.ts#outcomes

这段还包含原来的 RunResult 类型，替换时一并替换，不能保留两个同名 RunResult。新增分支为 context-limit，含输入超限原因。它不同于 maxDecisions 用完后的 budget-exhausted，也不同于超时或外部取消。

### 11. 循环先构造输入，再调用 decide

前面的选择器和摘要函数都还没有被正式循环使用。这一步才把新功能放进实际运行位置：每轮 decide 之前，先用当前 State 构造这轮 Context；成功就照常询问模型，超限就返回刚增加的出口。

工具执行后仍先写回完整 State，然后下一轮重新选择。否则若只在任务开始时选一次，刚读到的源码与测试就进不了后续输入。

在 `src/runtime/agent-loop.ts` 中，将顶部导入区替换为：

```ts
import { createToolBatchRunner, validateToolBatch } from "./tool-batch.ts";
import type { ToolBatchOptions } from "./tool-batch.ts";
import { toolCallsOf, previousToolCallIds } from "./action-tools.ts";
import { createRunControl } from "./run-control.ts";
import type { RunOptions } from "./run-control.ts";
import { createContextBuilder } from "./context.ts";
import { ContextWindowError } from "./context-window.ts";
import type { ContextWindowOptions } from "./context-window.ts";
import type {
  Action,
  DecisionContext,
  Dependencies,
  Outcome,
  RunResult,
  State,
  ToolResult,
} from "./types.ts";
```

将原 RunAgentOptions 类型替换为：

<<< ../snippets/08/src/runtime/agent-loop.ts#options

context 是输入选择配置，toolExecution 是工具调度配置。两者都由调用方提供，不放进 State 或模型参数。snapshot、failure、errorMessage 三个原辅助函数保持不变。

再用下面完整函数替换原 runAgentLoop：

<<< ../snippets/08/src/runtime/agent-loop.ts#run

#### 沿三轮运行看新增语句

函数开始时新增 buildContext，保存本次运行的输入配置。每轮 while 先调用 buildContext(state)，由 context 接住本轮输入，然后才把它传入 decide。

| 时刻 | State 消息数 | 本轮 Context | 下一步 |
|---|---:|---|---|
| 第 1 轮前 | 1 | 原始任务 | decide 提出日志请求 |
| 日志写回后，第 2 轮前 | 3 | 原始任务、日志请求与长结果 | decide 提出源码与测试批次 |
| 两份读取写回后，第 3 轮前 | 6 | 原始任务、最新三条消息，另带日志摘要 | decide 给诊断 |
| finish 记录后 | 7 | 不再构造下一轮 | 完成检查通过后返回 |

后面的工具调用、整批写回和次数更新继续使用第 7 篇代码。这次只是把“复制全量消息”换成“按配置准备本轮输入”，不是另写一条短历史循环。

#### 为什么输入准备单独放一个 try

最新一组太大时，ContextWindowError 在 decide 之前抛出。循环返回 context-limit，没有调用模型，也没有新增 assistant 消息或增加 decisions。

识别只放在输入准备的 catch。若模型依赖自己抛出一个同名错误对象，后面的决策 catch 仍把它归为 decision 失败，不能把依赖故障冒充成本地输入超限。普通摘要函数抛错也会进入输入准备的 catch，按当前 decision 失败规则处理；并不因为错误出现在这一段就一律叫超限。

控制检查仍优先处理取消和时间到期。摘要是同步代码，不能被计时器抢占，返回后 control.check 会再次核对耗时；因此应用摘要函数应快速完成，不能在这里做耗时网络操作。

#### 隐藏的旧记录仍然要参与核对

假设日志组没有发给第 3 轮模型，模型又提出使用 log-1。查重仍调用 previousToolCallIds(state.messages)，所以会看到完整历史里的 log-1，拒绝复用。不能因为模型没看见旧记录，就当作那次调用从未发生。

完成检查也仍收到 snapshot(state)。Context 负责选择本轮可见材料，State 负责保留运行事实；两者的差别现在开始影响真实行为。

### 12. 在原循环里运行三轮

前面的静态样本已经让我们看见“六条历史可以变成四条消息加摘要”。现在验证这六条历史确实可以由原循环一步步积累出来，而不是只对手工样本有效。

这次从一条 user 消息开始：脚本先提出日志读取，再提出源码与测试批次，最后给诊断。执行包装提供固定长日志，其余读取复用已有工具。观察第三次 decide 实际拿到的内容，才知道输入选择真正接上了。

新建 `src/examples/inspect-windowed-loop.ts`，写入完整内容：

<<< ../snippets/08/src/examples/inspect-windowed-loop.ts

入口仍给 runAgentLoop 三项依赖：脚本 decide、单项 executeTool、原 hasBatchEvidence。源码和测试继续走已有注册表；只有 read_build_log 由本例包装函数返回固定长日志，不会真实执行构建命令。

decide 外层只增加输入日志：每次打印的条数与字节数来自它这次收到的 Context，不是 State。executions 则在工具真正进入包装函数时增加。

默认预算 14600 是为这个固定样本选择的实验值：第二轮的长日志输入能装下，但第三轮再加源码与测试后装不下，需要省略早期日志。真实应用不能照抄这个数值作为模型 token 上限。

运行：

```bash
npm run typecheck
node src/examples/inspect-windowed-loop.ts
```

应看到：

```text
第 1 轮输入（context）: 1 条，118 字节，摘要=false
第 2 轮输入（context）: 3 条，14460 字节，摘要=false
[执行工具 execute] read_source 文件路径（path）=src/sum.ts
第 3 轮输入（context）: 4 条，699 字节，摘要=true
运行结果（outcome）: completed
决策次数（decisions）: 3
工具启动次数（executions）: 3
最终历史消息数（stateMessages）: 7
```

第 3 轮 Context 变短，最终 State 却增长到 7 条，这两件事可以同时成立：前者是输入选择结果，后者保留工具运行记录，并加入了刚产生的 finish 动作。

这个入口检查的是选择规则与原循环是否接通，不证明真实模型一定按固定三轮行动，也不证明摘要足够解决所有任务。

### 13. 把摘要交给真实模型

离线脚本可以直接读取 context.summary，真实模型看不到本地对象。它只看适配器发送的接口 messages。若这里不改，即使前面已经生成摘要，它也会在组装网络请求时被漏掉。

因此要把 summary 转成一条明确标为历史参考的接口消息，再连同原始任务、近期请求和结果一起发出。它只改变发送格式，不重新选择历史。

在 `src/adapters/deepseek/protocol.ts` 中，只用下面完整函数替换 buildDeepSeekMessages，保留 DeepSeekMessage 类型、辅助函数和解码函数：

<<< ../snippets/08/src/adapters/deepseek/protocol.ts#build

转换前，Context 有 4 条 messages 和一个 summary。转换时先加入原 system，再把摘要放入一条标明“较早记录的摘要”的 user 消息，然后转换原始任务与近期请求、结果。

```text
system     原应用说明
user       较早记录的摘要
user       原始任务
assistant  tool_calls = [source-1, tests-1]
tool       tool_call_id = source-1
tool       tool_call_id = tests-1
```

这里应是 6 条接口消息。summary 没有升级成 system 指令，也没有伪造 log-1 的 tool 结果；它是有损的参考数据。角色安排本身不等于完整的提示注入防护，执行权限仍由应用与后续策略控制。

这个函数返回接口数组，不改 State。非流式与流式 decide 都使用它，所以只修改一处，就能让两种请求方式带上摘要。原始调用与两份结果仍完整成对，解码器不用为此再增加动作类型。

### 14. 原真实入口只增加配置

最后在使用 Runtime 的地方打开这项功能。原入口仍提供相同的模型、工具和完成检查，只额外告诉循环：本地输入上限是多少，至少保留几组，省略日志时用哪个事实提取函数。

修改 `src/examples/deepseek-batch-agent.ts`，在顶部新增导入：

```ts
import { summarizeBuildLog } from "./context-scenario.ts";
```

在 runAgentLoop 的 options 中、timeoutMs 下面增加这一项，保留已有 toolExecution：

```ts
context: { maxBytes: 18000, keepRecentExchanges: 1, summarize: summarizeBuildLog },
```

在文件末尾增加对新出口的显示：

```ts
if (result.outcome.status === "context-limit") console.log(`输入限制原因（reason）: ${result.outcome.reason}`);
```

这里只增加配置与日志；章末给出完整文件供核对。18000 同样是本地消息字节预算，不是模型窗口。这个原入口只提供源码与测试工具，不会自动制造长构建日志；若历史本来就短，没有摘要也没有省略才是正常结果。

配置本地 `.env` 后，可分别运行：

```bash
node --env-file=.env src/examples/deepseek-batch-agent.ts
node --env-file=.env src/examples/deepseek-batch-agent.ts stream
```

这两条用于验证旧真实模型入口在启用配置后仍能完成诊断，不把它们当成必然触发裁剪的实验。长日志裁剪已经由前面的离线三轮入口确定地展示。

## 写完后，把这些函数连起来看

上面已经实现了分组、输入选择、日志摘要和循环接入。现在再按实际代码名称走一遍第 3 次决策，核对各部分怎样共同完成“为模型准备本轮材料”。

把上面的功能落到代码，先沿第 3 次决策看各函数怎样合作：

```text
agent-loop.ts 中，buildContext(state) 准备本轮输入
    ↓
context.ts 取出完整 state.messages，交给已创建的 select
    ↓
context-window.ts 选择历史
    ├─ groupExchanges：找出请求与结果的完整组
    ├─ summarizeBuildLog：为省略的日志组提取事实
    └─ measureContextBytes：连同摘要检查输入大小
    ↓
返回 Context，循环用 context 接住
    ↓
dependencies.decide(context, signal)
    ↓
真实模型适配器将 Context 转为接口消息并发送
```

这里的 buildContext 与 select 都是提前创建好的函数。一次任务开始时，循环用 createContextBuilder 准备 buildContext；有输入配置时，它再用 createContextWindow 准备 select。**创建函数是准备规则，每轮调用才处理当时最新的历史。** 第 11 步已把这些调用接回实际循环。

先记住这几件事分别服务于同一个目标：分组避免拆散请求和结果；摘要保留旧材料中的重要线索；计量决定还需不需要省略；Context 入口把选择结果交给下一轮模型。examples 中的样本与脚本负责让这些变化可重复观察。

## 调试：从模型没有看到的那份内容找起

先调试离线入口：

```bash
node --inspect-brk src/examples/inspect-windowed-loop.ts
```

在 Chrome 的 `chrome://inspect` 连接进程。沿正常第三轮走：先在 buildContext(state) 看 6 条历史，再进选择器看两组，观察 drop 从 0 到 1，最后回到 decide 看 4 条消息和 summary。此时完整 state.messages 仍有 6 条。

如果“模型不知道构建失败”，从 summary 向前追：省略了日志组，但应用摘要是否提取到退出码和用例？如果“模型不知道源码”，先看近期组是否还在 Context，再看 buildDeepSeekMessages 是否带上两条 tool。不要仅凭打印过源码，就认定它已经进入这次模型请求。

| 观察位置 | 看什么 | 要确认的关系 |
|---|---|---|
| groupExchanges 的 pending | 两个调用 ID 与后续结果 | 批次是否完整，没有重复或冒用结果 |
| 选择器 for 循环 | drop、maxDrop、groups | 省略的是较早完整组，最新组仍保留 |
| summarizeBuildLog 返回前 | 原日志事实与返回文本 | 摘要是否有依据，没有把失败写成成功 |
| measureContextBytes | messages 与 summary | 两者一起计量，没有漏算摘要 |
| 循环输入准备结束后 | state.messages、context.messages | 完整历史与本轮输入不是同一个数组 |
| 第二次接口组装后 | summary 的角色、tool_calls、tool_call_id | 摘要已发送，近期请求与结果仍对应 |

## 故障实验与一个小迁移

### 原始任务都装不下

```bash
node src/examples/inspect-windowed-loop.ts small
```

maxBytes 为 100，而原始任务的 Context 需要 118 字节。应返回 context-limit，decisions=0、executions=0、State 仍只有 user。不是“模型失败了”，模型还没被调用。

### 最新日志太长，不能先删掉再问模型

```bash
node src/examples/inspect-windowed-loop.ts latest-large
```

maxBytes 为 1600。第一轮能提出日志请求，日志结果写回后成为最新组，必须保留；第二轮因此在准备输入时超限。

预期 context-limit，decisions=1、executions=1、State 为 3 条。不能把最新日志删掉，让模型只看到用户要求后重新请求同一日志；那会把无法构造输入掩盖成无效循环。

### 摘要过长，同样不能绕过预算

```bash
node src/examples/inspect-context-window.ts huge-summary
```

此时即使省略旧日志，新的摘要本身也太长，应抛 ContextWindowError。这个入口直接调用 buildDecisionContext，没有 Runtime 接住错误，所以显示异常并以非零退出；与上一实验的明确 Outcome 是不同层的表现。

这些模式都不改文件。恢复只需重新运行不带模式参数的正常命令。

### 迁移：要求最近两组都保留

只在 `src/examples/inspect-context-window.ts` 中把 keepRecentExchanges 从 1 改为 2，maxBytes 仍为 1600，再运行 summary 模式。现在两组都不能省略，应超限，而不是只返回原先的短输入。

观察后恢复为 1，再运行 summary 模式。这个练习只改选择配置，不修改工具或循环；它用于看清“至少留几组”确实影响可省略范围。

## 对照 Pi：先选择输入，再转换模型协议

固定提交 `8efd314fa3d3232ce197d8d7a6a5660530b9d83e` 的 [streamAssistantResponse](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/agent/src/agent-loop.ts#L350) 先运行可选 transformContext，再 convertToLlm，随后请求模型。可以对照本章的输入选择与协议转换分别发生在哪里；Pi 的回调可以异步，本章同步提取器没有复制那套接口。

Pi Coding Agent 的 [findCutPoint](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/coding-agent/src/core/compaction/compaction.ts#L401) 按估算 token 选择切点，并考虑工具请求与结果关系；同文件的 generateSummary 会请求模型生成或更新摘要。它还有会话条目和压缩记录，本章没有实现这些持久化机制。

本项目选择首条任务固定保留、近期完整组、Context JSON 字节预算和结构化日志摘要。这些是当前可验证的设计，不应说成 Pi 的等价压缩实现。共同要处理的是：模型这次看见哪些材料，以及怎样不破坏它们的关系。

## 完整最终文件

以下为本章新增或修改的 11 个文件；其他第 7 篇代码保留。前面的分阶段修改用于理解和实现，这里供核对最终内容。

### src/runtime/context-exchanges.ts

<<< ../snippets/08/src/runtime/context-exchanges.ts

### src/examples/context-fixture.ts

<<< ../snippets/08/src/examples/context-fixture.ts

### src/examples/inspect-context-window.ts

<<< ../snippets/08/src/examples/inspect-context-window.ts

### src/runtime/types.ts

<<< ../snippets/08/src/runtime/types.ts

### src/runtime/context-window.ts

<<< ../snippets/08/src/runtime/context-window.ts

### src/runtime/context.ts

<<< ../snippets/08/src/runtime/context.ts

### src/examples/context-scenario.ts

<<< ../snippets/08/src/examples/context-scenario.ts

### src/runtime/agent-loop.ts

<<< ../snippets/08/src/runtime/agent-loop.ts

### src/adapters/deepseek/protocol.ts

<<< ../snippets/08/src/adapters/deepseek/protocol.ts

### src/examples/inspect-windowed-loop.ts

<<< ../snippets/08/src/examples/inspect-windowed-loop.ts

### src/examples/deepseek-batch-agent.ts

<<< ../snippets/08/src/examples/deepseek-batch-agent.ts

## 验收、提交与自动部署

恢复迁移实验中 keepRecentExchanges 的改动，再运行：

```bash
npm run typecheck
node src/examples/inspect-context-window.ts groups
node src/examples/inspect-context-window.ts plain
node src/examples/inspect-context-window.ts summary
node src/examples/inspect-windowed-loop.ts
node src/examples/inspect-windowed-loop.ts small
node src/examples/inspect-windowed-loop.ts latest-large
node src/examples/inspect-batch-loop.ts parallel
node src/examples/inspect-stream.ts cut
DOCS_BASE=/ci/ npm run site:build
```

预期：正常三轮完成，State 保留完整历史，Context 按规则变短；输入限制发生在下一次模型调用前；第 7 篇批次和第 6 篇断流行为仍成立；网站构建成功。真实模型入口如已配置，可另行验证，不把离线运行写成已调用真实服务。

提交要包含两部分：src 下本章改动，以及 site 中的教程、参考代码、配图和导航。网站采用 `git add -- site/`，让共享导航与所有已完成的网站更新一起进入提交；只提交 src 不会把电脑上的新教程上传到 GitHub。

下面命令由你复制执行，先检查分支确实为 codex/chapter-08-context-window、改动范围正确，再提交：

```bash
git branch --show-current
git status --short
git add -- src/runtime/context-exchanges.ts src/examples/context-fixture.ts src/examples/inspect-context-window.ts src/runtime/types.ts src/runtime/context-window.ts src/runtime/context.ts src/examples/context-scenario.ts src/runtime/agent-loop.ts src/adapters/deepseek/protocol.ts src/examples/inspect-windowed-loop.ts src/examples/deepseek-batch-agent.ts site/
git diff --cached --stat
git commit -F - <<'COMMIT'
第 08 篇：按完整消息组选择下一轮输入

保留完整运行历史，为每轮决策选择原始任务与近期完整请求和结果，并对省略的构建日志提取事实摘要。

- 增加完整组检查、Context JSON 字节预算与输入超限出口
- 输入准备与模型调用分开，继续使用完整 State 查重和核对完成证据
- 在模型协议中加入参考摘要，保留近期调用与结果对应关系
- 增加分组、裁剪、摘要与三轮运行的观察入口
- 同步课程网站正文、参考代码、配图与导航

验证：类型检查、离线正常与超限场景、批次与断流回归、课程网站构建通过。真实模型调用不包含在本次离线验证中。
COMMIT
git push -u origin codex/chapter-08-context-window
```

本篇得到了可解释的输入选择过程。下一篇再把“每轮构造了什么、执行了什么、何时停止”统一成运行事件，避免依靠散落的 console.log 理解整个任务。
