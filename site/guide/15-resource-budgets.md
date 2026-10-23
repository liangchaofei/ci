---
title: 第 16 篇｜重试也要记账，任务不能无限消耗资源
description: 区分决策次数与传输尝试，累计服务报告的 token 和估算费用，限制模型请求数、并发与单次输出，保留超额、取消和超时的不同出口。
---

# 第 16 篇：重试也要记账，任务不能无限消耗资源

第 15 篇的任务只进行了两次决策，却向模型服务发起了三次 HTTP 尝试。重试让程序更容易继续，也说明一个问题：**maxDecisions 为 2，并不等于最多花两次模型请求的资源。** 工具并发、模型输出长度和整个任务的运行时间，也各有不同的限制。

本篇仍诊断演示副本的空数组求和问题。我们为这一次任务增加一份资源账本：每次准备启动模型传输都先检查名额；收到服务的用量报告后累计 token 与估算费用。预算不足时，保留已经发生的事实，停止后续模型调用，并返回明确的资源出口。

先理解两类动作：**开始之前能知道的，先拦；响应之后才知道的，先记账再决定是否继续。** 不是所有资源都能在发请求之前精确知道。

## 先把已有的限制放回同一次任务

### 这些数字回答的是不同问题

| 数字或限制 | 当前任务中表示什么 | 什么时候能判断 |
|---|---|---|
| maxDecisions | 循环最多接受多少个完整 Action | 循环准备再次决策时 |
| 模型请求次数 | 这份任务已准入多少次 HTTP 尝试，重试也算 | 每次传输启动前 |
| 模型并发 | 这份账本下同时有多少个模型请求尚未释放 | 每次传输启动前 |
| max_tokens | 这一份请求允许模型最多生成多少 token | 发请求时传给服务 |
| 累计 token 与估算费用 | 多次请求已经报告的消耗 | 收到有效 usage 后 |
| timeoutMs | 整段运行还能持续多久 | 沿用第 5 篇的时间与取消检查 |

第 8 篇的工具并发限制仍只管理工具；本篇模型并发不替代它。第 9 篇的 Context 字节预算管理“这轮选哪些输入”，也不是服务报告的 token 用量。**输入放得下、轮数还够，都不表示可以无限请求模型。**

token 是模型表示和计量文本的单位，不与字符数一一对应。本章使用服务响应中的 usage，而不是拿字符串 length 充当精确 token 数。官方也指出，实际用量以返回的 usage 为准。[DeepSeek：Token 与用量](https://api-docs.deepseek.com/quick_start/token_usage/)

### 一次正常任务，账本怎样变化

继续沿用第 15 篇的模型 HTTP 替身：第一次 503，第二次返回读取请求，第三次返回答案。成功响应新增固定用量：第一次成功报告输入 40、输出 10；第二次成功报告输入 60、输出 10。

| 时刻 | 累计请求 | 已报告 token | 演示费用单位 | 没有用量报告的已结束请求 |
|---|---:|---:|---:|---:|
| 开始 | 0 | 0 | 0 | 0 |
| 第一次 HTTP 返回 503 | 1 | 0 | 0 | 1 |
| 重试成功，返回读取动作 | 2 | 50 | 60 | 1 |
| 工具成功，结果进入 State | 2 | 50 | 60 | 1 |
| 下一轮模型返回诊断 | 3 | 120 | 140 | 1 |

本例为了容易手算，输入每 token 记 1 个单位，输出每 token 记 2 个单位：第一次是 40 + 10 × 2 = 60，第二次是 60 + 10 × 2 = 80，累计 140。**这些是演示单位，不是 DeepSeek 当前价格，也不是人民币账单。**

第一行 503 没有报告用量，我们只知道有一次失败尝试，不知道其实际费用。账本的 140 只对已收到报告的部分按配置估算，不能据此说整个任务只花了 140，更不能把那次失败当成免费。

输入 token 按每次请求的报告相加。第二轮再次发送历史时，它仍属于第二轮输入消耗；不是只统计最后一份 Context，也不是看到历史内容重复就把对应 token 减掉。

### 预算不足时应该在哪里停

若最多允许两次模型请求，前面的 503 与成功重试已经用完名额。读取仍能完成并写入 State；下一轮准备向模型请求答案时，被账本挡住，**不会发第三次 HTTP**。返回状态仍含已读取的源码。

若 token 上限设为 49，第一份成功报告却是 50，我们只能在收到报告后发现超额。先把这 50 个 token 保存进账本，再停止交付本轮动作；循环不会执行这个尚未接收的读取动作。已经发生的模型消耗无法回滚。

[![每次传输前检查请求名额和已知预算；响应后记录用量，再决定是否交付候选响应；失败但无用量的请求另记未知](/diagrams/resource-budget-flow.svg)](/diagrams/resource-budget-flow.svg)

点击可放大。实线是调用顺序，虚线是返回。State 保存任务事实，资源账本保存请求与用量，它们有各自的写入位置。

### 本篇控制的强弱边界

请求次数和模型并发数可以在同一进程、同一账本的启动点严格拦住。本篇并发满额时直接拒绝，不排队；这不是跨进程全局限流器。

token 与费用是**依据已收到报告作出的停止策略**。当前请求、已经在途的其他请求、缺少报告的失败请求，都可能带来额外消耗；不能承诺不超过账单额度。单次输出上限有助于约束生成，但不包括输入和所有重试。更严格的费用上限还需要可靠的输入计量、请求前预留、服务端限额及账单核对，本篇不伪造这些保证。

本章保留原来的运行超时；它控制等待和继续执行，不能追回已经产生的计算或写入。CPU、内存、磁盘和工具服务费用也不在这份模型账本内。

## 前置版本与新增文件

完成并提交第 15 篇后，在仓库根目录运行：

```bash
git status --short
git switch -c codex/chapter-15-resource-budgets
npm run typecheck
```

已有分支时使用 `git switch codex/chapter-15-resource-budgets`。本章不新增依赖、不安排单测编写，不需要 API Key。所有模型响应在本地构造，文件副本读取沿用第 14、15 篇。

| 文件 | 改动 | 它接在任务的哪一步 |
|---|---|---|
| src/runtime/resource-types.ts | 新增 | 资源维度、用量、快照和资源错误 |
| src/runtime/usage-ledger.ts | 新增 | 收到报告后累加 token 与估算费用 |
| src/runtime/model-budget.ts | 新增 | 发请求前领名额，报告与结束后释放 |
| src/examples/inspect-model-budget.ts | 新增，独立入口 | 最早观察名额、记账与未报告请求 |
| src/adapters/deepseek/usage.ts | 新增 | 把服务 usage 转为内部 TokenUsage |
| src/adapters/deepseek/http.ts | 修改 | 每次非流式尝试领名额、报告、释放 |
| src/adapters/deepseek/stream-http.ts | 修改 | 一次流式请求只计一次，核对最终用量 |
| src/adapters/deepseek/decider.ts | 修改 | 传递共享账本，配置单次输出上限 |
| src/runtime/types.ts | 修改 | Outcome 增加 resource-limit |
| src/runtime/agent-loop.ts | 修改 | 决策因资源不足停止时返回专门结果 |
| src/runtime/session-codec.ts | 修改 | 读回时认可新结果及其资源类别 |
| src/examples/budget-model-fixture.ts | 新增，被导入 | 给原离线模型响应补固定用量 |
| src/examples/budget-scenario.ts | 新增，被导入 | 组装共享同一账本的原 Agent |
| src/examples/budgeted-diagnosis-agent.ts | 新增，独立入口 | 跑正常任务并查看资源结果 |
| src/examples/inspect-resource-faults.ts | 新增，独立入口 | 对比超额、取消与超时 |
| src/examples/inspect-stream-budget.ts | 新增，独立入口 | 观察流式用量与动作交付的先后 |

共 10 个新增文件、6 个修改文件。新增通用能力只有类型、用量累计与模型请求门禁三部分；模型字段解析留在适配器，任务组装留在 examples，循环只多识别一种退出原因。

下面每步给出要写入的完整代码。**“讲解摘录（无需写入文件）”已经包含在上方实现里，不要重复写入。** 修改已有文件时，只按指定范围替换；章末保留全部最终文件。

## 阶段一：先看见一份请求怎样占用和释放名额

### 1. 资源名、用量与快照分别是什么

新建 src/runtime/resource-types.ts：

<<< ../snippets/15/src/runtime/resource-types.ts#contracts{ts}

ResourceLimits 来自应用配置，模型不能修改。TokenUsage 是单次成功读取到的服务报告；UsageTotals 是已经累加的结果；BudgetSnapshot 再加上请求与活动数，供应用观察。

| 快照字段 | 中文含义 |
|---|---|
| inputTokens / outputTokens | 已报告的累计输入 / 输出 token |
| knownTokens | 上面两项之和，未报告部分不在其中 |
| estimatedCostUnits | 按本任务固定演示费率计算的已报告部分估算 |
| requests | 已准入传输尝试数，不保证服务实际收到请求 |
| active / peak | 当前未释放请求数 / 历史最高同时活动数 |
| unreportedRequests | 已结束、但没有成功记入用量的请求数 |

ResourceLimitError 带具体 resource，例如 model-requests。它不等于用户取消，也不等于 maxDecisions 耗尽。nonNegativeInteger 要求非负安全整数，避免负数、小数、无穷或超出精确整数范围的账目被当成有效数据。

这个文件不发请求、不计数，也不写 State；后面两个模块依赖这些约定。

### 2. 先做“收到多少，就累计多少”的账本

新建 src/runtime/usage-ledger.ts：

<<< ../snippets/15/src/runtime/usage-ledger.ts#ledger{ts}

createUsageLedger 复制本任务的阈值和费率，保存在函数内部。应用之后修改原配置对象，不会追溯改变已经采用的计价方式。totals 初始为四个 0；只有 record 真正更新它，snapshot 只返回副本。

**讲解摘录（无需写入文件）：**

<<< ../snippets/15/src/runtime/usage-ledger.ts#record{ts}

拿 `{ inputTokens: 40, outputTokens: 10 }` 走一次：输入累计为 40，输出为 10，knownTokens 为 50；用输入费率 1、输出费率 2 得到 60。下次收到 60、10，则累计输入 100、输出 20，knownTokens 120、费用 140。next 全部校验成功后才赋给 totals，避免更新一半的账目。

这里每次按累计输入与输出乘固定费率。真实服务可能区分缓存命中、模型型号等价目，本篇没有混用这些费率，也没有把示例估算当成发票或真实账单。

**讲解摘录（无需写入文件）：**

<<< ../snippets/15/src/runtime/usage-ledger.ts#check{ts}

check(true) 在请求开始前使用，已有消耗达到上限就不再开始；check(false) 在报告后使用，只有**超过**上限才拒绝本次候选响应。例如上限 50，本次报告正好使累计达到 50，仍能交回结果，但下一次不能再领名额。上限 49、报告 50，则本次响应也不会交付给动作解析。

record 与 check 分开，是为了先保留已发生的消耗，再作控制决定。超额不能把真实报告删掉。这个模块不统计失败请求和并发；下一份模块把请求生命周期与它连接起来。

### 3. 请求开始时领取一张本地凭条

新建 src/runtime/model-budget.ts，先写入：

<<< ../snippets/15/src/runtime/model-budget.ts#contracts{ts}

RequestLease 是一次请求的本地凭条：report 只报一次用量，close 释放这次占用。它不是第 14 篇的用户批准，不授予文件权限，也不交给模型。ModelBudget 只公开 begin 与快照，调用方不能直接改 active。

继续追加完整工厂函数：

<<< ../snippets/15/src/runtime/model-budget.ts#budget{ts}

createModelBudget 先建立刚才的用量账本，再保存 requests、active、peak 与 unreportedRequests。begin 从应用调用的位置开始工作，创建工厂本身不会占用额度。

**讲解摘录（无需写入文件）：**

<<< ../snippets/15/src/runtime/model-budget.ts#admission{ts}

begin 先确认已知用量尚有余量，再核对总请求次数与并发名额。通过才将 requests、active 加一。这个检查与递增没有 await；同一 JavaScript 进程里的两个调用不会同时通过“还剩一个名额”的旧判断。跨进程或多份独立账本没有这项共享保证。

并发满额直接抛 model-concurrency，既不排队，也不增加 requests。本篇选择明确拒绝，便于观察实际启动边界；需要排队时，应另外定义等待队列的上限、取消和公平性，不能把它藏在这里。

**讲解摘录（无需写入文件）：**

<<< ../snippets/15/src/runtime/model-budget.ts#lease{ts}

每次 begin 都创建自己独立的 closed 与 reported。第一次调用 report，先记账，再将 reported 设为 true，最后检查是否超额。因此即使检查抛错，close 也知道这次有有效报告，不会又算作未知。

close 无论成功失败都应调用，但重复调用只释放一次。结束时还没报用量，才增加 unreportedRequests；没有把 inputTokens、outputTokens 伪造成一个“本次为 0”的报告。缺失、格式错误或计算范围异常都会保留这层不确定性。

这个文件串起的过程是：应用在实际传输前 begin → 取得凭条 → 有报告时 report → finally 调 close。传输在外部执行；原循环仍写任务历史。

### 4. 最早的可运行检查点

新建独立入口 src/examples/inspect-model-budget.ts：

<<< ../snippets/15/src/examples/inspect-model-budget.ts#probe{ts}

先领 first，不释放就再领一次：maxConcurrent 为 1，所以第二次被拒绝。给 first 报 40、10 并释放两次，active 仍为 0，requests 仍为 1。随后再领 second，不提供报告就关闭：requests 变成 2，未知报告数变成 1，原来的已知用量不变。

```bash
npm run typecheck
node src/examples/inspect-model-budget.ts
```

第一行应为 model-concurrency。第一次快照为已知 50 token、估算 60、requests 1、active 0、未知报告 0；第二份为 requests 2、未知报告 1，已知数字仍是 50 与 60。

这个入口没有发 HTTP，也没有调用模型；它验证名额与凭条行为。真实传输是否经过这里，要在下一阶段的接入语句中确认。

## 阶段二：把真实传输尝试和服务用量接进来

### 5. 把服务字段转为内部用量

新建 src/adapters/deepseek/usage.ts：

<<< ../snippets/15/src/adapters/deepseek/usage.ts#usage{ts}

服务响应把用量放在 payload.usage，字段为 prompt_tokens、completion_tokens、total_tokens。本函数要求三项为非负安全整数，并核对总数等于输入加输出，然后返回内部 `{ inputTokens, outputTokens }`。[DeepSeek 响应用量字段](https://api-docs.deepseek.com/api/create-chat-completion/)

例如 usage 为 `{ prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 }`，返回 40 与 10。reasoning_tokens 等细分项不再额外相加，避免把已经包含在输出中的子项重复记入；缓存细分暂不用于本章演示计价。

没有用量或形状错误时，抛模型协议异常。本章接入账本的成功响应必须有可核对的报告，不能缺字段就默认 0。未配置账本的旧入口仍保留原兼容行为。

解析器只处理服务协议。它不更改预算，真正累计发生在 lease.report 里；同样，读取到报告也不代表模型动作合法。

### 6. 替换非流式传输的导入与配置

本次重建 src/adapters/deepseek/http.ts：先清空旧内容，再写入以下导入与类型。

<<< ../snippets/15/src/adapters/deepseek/http.ts#imports{ts}

相对第 15 篇，HttpOptions 只新增可选 budget；fetch 与 retry 保留。调用者必须把同一账本传给需要共同受限的请求，传输层不会偷偷创建一份每次归零的预算。

继续追加原来的 Retry-After 函数，内容不变：

<<< ../snippets/15/src/adapters/deepseek/http.ts#header{ts}

### 7. 每次重试都要重新领请求名额

继续追加完整 requestDeepSeek：

<<< ../snippets/15/src/adapters/deepseek/http.ts#request{ts}

与上一章相比，新增流程只有：每次传输尝试先 begin；JSON 取得后解析并报告用量；finally 关闭凭条。原网络错误分类、HTTP 状态、Retry-After 与退避配置保留。

begin 放在 retry 的 operation **里面**。第一次 503 占一次请求；finally 释放活动名额并记为未报告；等待重试期间不占活动名额。第二次开始再次 begin，请求数才会成为 2。若把 begin 放在 retry 外面，就会把多次 HTTP 伪装成一次消耗。

**讲解摘录（无需写入文件）：**

<<< ../snippets/15/src/adapters/deepseek/http.ts#account{ts}

拿到 JSON 后，先检查停止，再从 payload 提取用量，交给这次 lease。超额时 report 抛 ResourceLimitError，原 retry 不把它识别为 transient，所以不会为了预算不足继续重试。它还没有 return payload，后面的动作解码与工具执行也都没有启动。

报告放在 JSON 读取的 try/catch 之外，避免资源错误被误改成“JSON 格式错误”。不论 503、网络失败、解析异常、超额还是成功返回，finally 都会关闭已取得的凭条。begin 自己拒绝时还没有凭条，也没有要释放的名额。

超额拒绝只阻止交付候选响应，不抹去这次服务已经报告的用量。自定义 fetch 仍是可信应用注入点；模型参数不能换掉 budget 或它的配置。

### 8. 流式请求也只记一次最终报告

重建 src/adapters/deepseek/stream-http.ts：先清空旧内容，写入导入：

<<< ../snippets/15/src/adapters/deepseek/stream-http.ts#imports{ts}

再追加完整生成器函数：

<<< ../snippets/15/src/adapters/deepseek/stream-http.ts#stream{ts}

流式 HTTP 相对上一章新增同一份 HttpOptions、begin/finally，以及分片里的用量检查。原 SSE 读取和完整动作收集器保留，不增加流式自动重试。

先走正常路径：生成器开始被读取时领名额，发一次请求，逐条取得 SSE data。普通内容仍往后交给原收集器；看到非空 usage 时，先解析并 report，再把这个事件交出去。最后 [DONE] 到达时，必须已经有一份有效报告，收集器才能完成动作。

这不是每片内容都记一次 token。服务报告的是这一份请求的总用量，字段为 null 或不存在的中间片段不记账。重复非空报告会被凭条拒绝，避免重复累加。这里按当前 DeepSeek 协议处理最后事件的用量，不能直接套到其他厂商。[DeepSeek 流式用量与结束事件](https://api-docs.deepseek.com/api/create-chat-completion/)

若最后报告超额，生成器在 yield 该事件之前抛错，原草稿不会成为可执行 Action；此前界面已经显示的文字不保证能撤回。若断流或缺少报告，不能以没有收到 usage 推断免费，也不能把不完整动作交给执行器。

finally 在正常结束、错误或收集器提前结束读取时关闭凭条。已有报告但后面缺 [DONE]，任务仍失败，用量仍保留；动作合法性与消耗事实是两件事。

### 9. 让适配器把同一配置传到两种传输

修改 src/adapters/deepseek/decider.ts，原有内容大部分保留。

第一处，在顶部新增：

```ts
import type { HttpOptions } from "./http.ts";
```

第二处，在 DeepSeekOptions 中，紧邻 stream 配置新增：

```ts
http?: HttpOptions;
maxOutputTokens?: number;
```

第三处，找到 API key and model 的配置检查。在它之后、创建工具说明的注释之前插入：

```ts
if (options.request && options.http?.budget) throw new Error("Use http.fetch instead of request when enabling a budget");
```

继续在这行后插入：

<<< ../snippets/15/src/adapters/deepseek/decider.ts#output-limit{ts}

这个验证范围 1 至 4096 是本项目允许的输出配置，默认仍是 1024；不是服务本身的最大容量。max_tokens 表示单次生成上限，不是输入加输出总预算。[DeepSeek max_tokens](https://api-docs.deepseek.com/api/create-chat-completion/)

request 是第 15 篇保留的传输覆盖接口，自定义实现可能忽略第四个配置参数。开启预算时明确拒绝同时覆盖 request，改用 http.fetch 注入服务替身，确保正式传输中的记账语句确实执行。

第四处，在 body 中，把 `max_tokens: 1024` 替换为 `max_tokens: maxOutputTokens`，其余字段保留。

第五处，找到从 let action: Action 开始的整个 if/else 分支，替换到它的闭合大括号为止，后面的历史调用身份检查保留：

<<< ../snippets/15/src/adapters/deepseek/decider.ts#dispatch{ts}

两条路径都收到 options.http，因此同一任务可以沿同一个账本统计非流式或流式请求。每轮构造的新 Context 不会重新创建预算。原 Action 解码、完整性检查和调用 ID 核对仍保留。

## 阶段三：让预算不足成为明确的 Runtime 结果

HTTP 能抛资源错误，还不够。原循环会把任何 decide 异常变成 failed/decision；调用方就无法区分“服务坏了”和“应用主动限制资源”。本阶段只改这个结果分类，不把网络或费用计算塞进循环。

### 10. 增加结果类型

在 src/runtime/types.ts 顶部新增：

```ts
import type { ResourceKind } from "./resource-types.ts";
```

在 Outcome 联合中，紧邻 context-limit 一项新增：

```ts
| { status: "resource-limit"; resource: ResourceKind; reason: string }
```

这是在联合中添加一个成员，保留原有分号和其他类型，不在末尾新建第二份 Outcome。budget-exhausted 继续表示决策次数耗尽，timed-out 表示时间到期，cancelled 表示用户停止。

### 11. 只替换决策等待对应的 catch

在 src/runtime/agent-loop.ts 顶部新增：

```ts
import { ResourceLimitError } from "./resource-types.ts";
```

找到 decide 返回后、原工具调用身份校验之后的 catch。它紧邻“先记下模型提出了什么”的注释上方；**不要替换 Context 构建、完成验证或批次执行的 catch**。将这一整个 catch 替换为：

<<< ../snippets/15/src/runtime/agent-loop.ts#resource-catch{ts}

原停止原因检查仍然最先进行：如果用户已经取消或整段运行已超时，就走原停止出口。没有停止，且错误确为 ResourceLimitError，才返回 resource-limit；其他异常继续 failed/decision。

finish 沿用第 10 篇报告器，所以最后的 run-ended 事件也带同一个资源结果，无需再添加一套结束通知。这个 catch 在保存 assistant 动作之前；被预算拒绝的候选响应不计已记录决策，也不会触发工具。

因此 tokens 实验里“已记录决策 0”不表示模型从未计算，只表示循环没有接受这次 Action。实际请求和用量要看资源账本，不能拿 State 的决策数反推服务消耗。

### 12. 同步保存结果的读回检查

在 src/runtime/session-codec.ts 的 checkOutcome 中，找到 context-limit 分支，在它之前插入：

<<< ../snippets/15/src/runtime/session-codec.ts#resource-outcome{ts}

这让新的 Outcome 能经过原第 12 篇的保存与读回格式检查。它只保存“为什么停”，没有把内存中的预算计数自动持久化。若以后跨进程续运行，不能凭读回这条结果就宣称恢复了原费用额度。

本阶段对循环的完整改变只有一种异常出口。计数、费率、并发凭条和服务字段仍在各自模块中。

## 阶段四：正常任务共享一份账本

### 13. 给旧服务替身补上用量

新建 src/examples/budget-model-fixture.ts：

<<< ../snippets/15/src/examples/budget-model-fixture.ts#fixture{ts}

这个模块复用第 15 篇的 createRetryModelFixture：503 仍然没有 usage；成功响应才补上本章的 40/10 和 60/10。没有修改旧替身，因此旧入口和旧实验继续保留原行为。

它不是独立命令，不打开网络端口。新 send 调用旧替身、取得 Response，补充 JSON 后返回；真实 http.ts 的报告语句仍然会执行。count 沿用旧请求计数，而不是为新报告另记一次请求。

### 14. 分开“应用组装”和“运行命令”

新建 src/examples/budget-scenario.ts，先写入导入与正常配置：

<<< ../snippets/15/src/examples/budget-scenario.ts#imports{ts}

normalLimits 允许 3 次模型请求、同时 1 次、已报告 200 token、估算 300 个单位。这些给前面的正常轨迹留出余量，不是通用推荐配置。

继续追加完整组装函数：

<<< ../snippets/15/src/examples/budget-scenario.ts#prepare{ts}

先看与上一章相同的部分：新建演示副本，创建只读工具和注册表，再用第 14 篇许可入口包住原执行器。validateFinish 仍要求固定答案和实际读到的源码，不能把模型的 finish 当作成功证据。

新增连接集中在 budget 与 http：**只创建一次 budget，把它交给同一个 decide 使用**，http.fetch 接离线响应，http.retry 接旧重试规则。单次输出设置为 128。模型传输失败后等 10ms 再试，每次都会经过同一 budget.begin。

这个入口不再故意让文件读取失败，以免两个故障装置盖过资源主线。只读工具的重试能力仍保留，需要时可由第 15 篇入口单独观察。正常过程中唯一注入的失败是第一次模型 503。

prepareBudgetScenario 返回 agent、budget 和替身计数，供两个运行命令复用。它创建应用对象，不启动 Agent；State 仍在 agent.run 调用以后由原循环创建。timeoutMs 也沿原 Agent 配置传入，没有另建一个“费用超时”控制器。

[![应用只创建一份模型账本；每次 HTTP 尝试在账本领名额并报告，原循环仍独自更新 State；输出上限、资源阈值和总超时各有位置](/diagrams/resource-budget-files.svg)](/diagrams/resource-budget-files.svg)

点击可放大。资源快照不是 Context 字段，也不会因传给日志就进入 State。用户输入或模型参数不能调整这份 limits。

### 15. 启动任务，看见账目与结束结果

新建独立入口 src/examples/budgeted-diagnosis-agent.ts：

<<< ../snippets/15/src/examples/budgeted-diagnosis-agent.ts#run{ts}

这个短文件只做三件事：取得已组装对象，订阅原结束报告，运行后读取快照。没有隐藏另一份模型或工具代码。日志来自同一次 agent 与同一 budget；run-ended 的 outcome 与返回值一致。

```bash
npm run typecheck
node src/examples/budgeted-diagnosis-agent.ts
```

末尾应为 completed、决策 2；资源账本为：

```json
{
  "inputTokens": 100,
  "outputTokens": 20,
  "knownTokens": 120,
  "estimatedCostUnits": 140,
  "requests": 3,
  "active": 0,
  "peak": 1,
  "unreportedRequests": 1
}
```

这是观察用的快照，不写入源码。active 为 0 表示这次正常流程的凭条都释放了；不是保证远端没有后台计算。unreportedRequests 为 1 表示 503 那次没有报告，不能把快照当完整账单。

### 16. 迁移时最容易接错的位置

把本章能力接到另一份非流式 Agent 时，要迁移的是“应用创建 budget → DeepSeekOptions.http 接收它 → 实际 HTTP 尝试调用 begin/report/close”，不是在 decide 外简单增加一次 requests++。

同一逻辑任务在同进程 resume 时可以继续使用捕获同一 budget 的适配器；新任务应明确创建新账本与相应依赖。跨进程没有自动恢复预算，本篇也没有在新进程把旧用量猜成 0 后宣称会话总额受控。

独立迁移练习可以先做一个很小的变化：将正常配置的 maxRequests 从 3 改成 2，运行后找到 State 中已经保留的读取事实，确认没有第 3 次 HTTP 日志。下一阶段给出同一个故障的可重复入口；观察完恢复正常配置。

## 阶段五：超额、取消与超时不是同一件事

### 17. 复用同一场景对照五种出口

新建独立入口 src/examples/inspect-resource-faults.ts：

<<< ../snippets/15/src/examples/inspect-resource-faults.ts#faults{ts}

每次循环都复制 normalLimits，并创建新副本、新 Agent 和新账本，实验互不共享可变状态。requests 只改请求上限，tokens 只改已知 token，cost 只改估算费用。不是通过改模型参数“宣称预算已变”。

cancel 在 decision-started 通知里调用原 agent.cancel，原循环通知后检查，所以传输尚未启动。time 使用原 timeoutMs 限制，不手工构造一个 timed-out 对象；很短的期限用于复现停止，不是正常运行推荐值。

```bash
node src/examples/inspect-resource-faults.ts
```

| 标签 | 预期结果 | 已有事实怎样保留 |
|---|---|---|
| requests | resource-limit / model-requests | 已记录 1 次读取动作与源码结果，第三次传输未启动 |
| tokens | resource-limit / known-tokens | 已报告 50 大于 49；未接受本轮读取动作 |
| cost | resource-limit / estimated-cost | 已估算 60 大于 59；未接受本轮读取动作 |
| cancel | cancelled | 通知后停止，未启动模型传输 |
| time | timed-out | 保留此前事实，停止等待；具体已启动次数取决于实际时序 |

tokens 和 cost 不是“提前没有花费”，而是“看到已发生超额后停止交付并继续记录”。账本中仍为 50 和 60，不会改成 49 或 59 来凑上限。每个结束报告也应显示同一 status，不能只在打印里改个名字。

## 阶段六：核对流式用量不会变成另一套规则

### 18. 构造一份完整的离线流

新建 src/examples/inspect-stream-budget.ts，先写入导入：

<<< ../snippets/15/src/examples/inspect-stream-budget.ts#imports{ts}

继续追加本地响应函数：

<<< ../snippets/15/src/examples/inspect-stream-budget.ts#response{ts}

它构造与第 7 篇相同形态的 SSE：最后一个内容事件含合法的结束原因与 usage，再发送 [DONE]。这只是模型响应替身，不调用模型，也不直接提交动作；后面的正式流式传输与收集器仍然运行。

### 19. 相同报告，分别给足额度与限制额度

继续追加运行部分：

<<< ../snippets/15/src/examples/inspect-stream-budget.ts#run{ts}

上限 200 时，50 token 合法，收集器交回 finish；上限 49 时，账本仍记入 50，但最后事件尚未交给收集器就被资源错误拦住，所以没有可执行动作。两次都只记一个请求，并在结束时释放名额。

```bash
node src/examples/inspect-stream-budget.ts
```

应看到一次“动作=finish”，一次“动作未交付，原因=known-tokens”。两份账本都保留 knownTokens 50、估算 60，active 为 0；这说明“拒绝使用结果”和“删除消耗事实”没有混成一件事。

## 如何调试：从额度变动追到控制流

```bash
node --inspect-brk src/examples/budgeted-diagnosis-agent.ts
```

连接 Node 调试器后，按下列顺序设断点：

| 位置 | 看什么 | 下一步是谁继续 |
|---|---|---|
| model-budget.ts 的 begin | requests、active、当前已知用量 | 通过后才是 fetch |
| http.ts 的 finally | 503 也会 close；等待重试时 active 已归零 | retry 等待后重新 begin |
| usage.ts 返回前 | 服务的三项原字段与内部输入输出 | 本次凭条 report |
| usage-ledger.ts 的 totals = next | 50/60，再到 120/140 | 凭条检查超额，决定能否交付响应 |
| agent-loop.ts 新 catch | ResourceLimitError 与 signal 停止原因 | finish 报告明确结果 |
| 原循环追加 tool 消息处 | 资源记账没有代替 State 写回 | 下一轮使用新 Context |

检查请求上限时，不要只在 main 的打印处看一个最终数字。真正的控制点是 begin 在 fetch 之前；检查超额时也不要只看报错，必须确认 totals 已经保留真实报告。

### 常见现象该调查哪一层

- 多次重试却只计一次请求：begin 很可能误放在 retry 外面。
- 每轮额度都恢复初始值：账本可能被建在 decide 里面，而非任务组装时。
- 报告超额却仍执行了候选工具：检查 report 是否在 return payload / yield 最后事件之前，以及资源错误有没有被吞成普通数据。
- 失败请求费用看起来是 0：检查是否用缺失 usage 伪造零值，是否显示 unreportedRequests。
- 并发满额后请求偷偷排队：本篇没有队列，应在 begin 拒绝；核对是否接了另一层调度。
- 用户取消却返回资源不足：检查循环 catch 中原 control.outcome 的优先判断是否保留。

停止等待后，底层依赖可能尚未结束。active 应反映凭条实际释放，而不是为了输出好看提前清零；迟到报告或释放可能继续改变独立账本，但不会恢复原循环或修改已返回的 State。返回的 snapshot 本身是副本，不会随之改变。需要完整结算时，应等待底层清理与服务账单，不能把一次界面结束通知当成结算完成。

本章用量只保存在应用持有的内存账本中，Outcome 可沿原日志保存。生产审计还需要明确记录用量、费率版本、缺失报告和恢复策略；本文没有偷偷改写第 12 篇的磁盘协议。

## 对照 Pi：累计用量与限制执行是不同职责

Pi 固定版本的 usage-totals.ts 分别累计 input、output、cacheRead、cacheWrite 和 cost，也提供合并 Usage 的函数。它让会话可以回看不同来源的消耗。[Pi 用量累计](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/coding-agent/src/core/usage-totals.ts#L1)

本篇同样把累计从循环抽离，但只实现单一演示费率，未覆盖 Pi 的缓存计价等细项。更要分清：会累计不等于会拦截，usage-totals 的求和函数本身不是请求预算门禁。本项目另用 begin/report/close 与资源错误连接执行控制，不能把这套内部协议说成 Pi 的标准接口。

## 本篇验收

```bash
npm run check
node src/examples/inspect-model-budget.ts
node src/examples/budgeted-diagnosis-agent.ts
node src/examples/inspect-resource-faults.ts
node src/examples/inspect-stream-budget.ts
node src/examples/retrying-diagnosis-agent.ts
```

确认：并发拒绝不多计请求；正常任务为 2 次决策、3 次请求、120 已知 token 与 140 演示单位；未报告为 1；资源超额、取消、超时走不同结果；流式超额不交付动作；旧第 15 篇正常流程仍可运行。

这些实验验证的是本实现的控制边界，不代表完整财务结算或全局资源平台。当前已经把“可重试”与“还有额度”接在同一次任务里；下一步仍要用完整故障场景检查它们与其他机制组合时的行为。

## 最终完整文件

前面的步骤写完即得到这些文件。这里用于核对，不要再次追加；已有文件只需确认对应修改没有误删其他内容。

<details>
<summary>src/runtime/resource-types.ts</summary>

<<< ../snippets/15/src/runtime/resource-types.ts{ts}

</details>

<details>
<summary>src/runtime/usage-ledger.ts</summary>

<<< ../snippets/15/src/runtime/usage-ledger.ts{ts}

</details>

<details>
<summary>src/runtime/model-budget.ts</summary>

<<< ../snippets/15/src/runtime/model-budget.ts{ts}

</details>

<details>
<summary>src/adapters/deepseek/usage.ts</summary>

<<< ../snippets/15/src/adapters/deepseek/usage.ts{ts}

</details>

<details>
<summary>src/adapters/deepseek/http.ts</summary>

<<< ../snippets/15/src/adapters/deepseek/http.ts{ts}

</details>

<details>
<summary>src/adapters/deepseek/stream-http.ts</summary>

<<< ../snippets/15/src/adapters/deepseek/stream-http.ts{ts}

</details>

<details>
<summary>src/adapters/deepseek/decider.ts</summary>

<<< ../snippets/15/src/adapters/deepseek/decider.ts{ts}

</details>

<details>
<summary>src/runtime/types.ts</summary>

<<< ../snippets/15/src/runtime/types.ts{ts}

</details>

<details>
<summary>src/runtime/session-codec.ts</summary>

<<< ../snippets/15/src/runtime/session-codec.ts{ts}

</details>

<details>
<summary>src/runtime/agent-loop.ts</summary>

<<< ../snippets/15/src/runtime/agent-loop.ts{ts}

</details>

<details>
<summary>src/examples/inspect-model-budget.ts</summary>

<<< ../snippets/15/src/examples/inspect-model-budget.ts{ts}

</details>

<details>
<summary>src/examples/budget-model-fixture.ts</summary>

<<< ../snippets/15/src/examples/budget-model-fixture.ts{ts}

</details>

<details>
<summary>src/examples/budget-scenario.ts</summary>

<<< ../snippets/15/src/examples/budget-scenario.ts{ts}

</details>

<details>
<summary>src/examples/budgeted-diagnosis-agent.ts</summary>

<<< ../snippets/15/src/examples/budgeted-diagnosis-agent.ts{ts}

</details>

<details>
<summary>src/examples/inspect-resource-faults.ts</summary>

<<< ../snippets/15/src/examples/inspect-resource-faults.ts{ts}

</details>

<details>
<summary>src/examples/inspect-stream-budget.ts</summary>

<<< ../snippets/15/src/examples/inspect-stream-budget.ts{ts}

</details>

## 保存本章

恢复正常配置，确认上述检查与实验结果符合实际，再执行：

```bash
git add \
  src/runtime/resource-types.ts \
  src/runtime/usage-ledger.ts \
  src/runtime/model-budget.ts \
  src/adapters/deepseek/usage.ts \
  src/adapters/deepseek/http.ts \
  src/adapters/deepseek/stream-http.ts \
  src/adapters/deepseek/decider.ts \
  src/runtime/types.ts \
  src/runtime/session-codec.ts \
  src/runtime/agent-loop.ts \
  src/examples/inspect-model-budget.ts \
  src/examples/budget-model-fixture.ts \
  src/examples/budget-scenario.ts \
  src/examples/budgeted-diagnosis-agent.ts \
  src/examples/inspect-resource-faults.ts \
  src/examples/inspect-stream-budget.ts \
  site/ \
  AGENTS.md
git commit -F - <<'COMMIT'
第 16 篇：累计模型资源并在预算不足时停止

增加已知用量账本、请求次数与模型并发门禁及未知报告计数。
将每次非流式重试与流式最终用量接入同一份任务预算。
区分已发生的用量记录与候选动作交付，不把超额事实删成上限值。
增加资源不足的运行结果，保留取消、超时和决策预算的原有含义。
补充整体流程、逐步代码、完整文件、离线实验与调试路径。
COMMIT
git push -u origin codex/chapter-15-resource-budgets
```

这些命令由本地执行，不会因阅读网页而自动提交或发布。演示计价不作为真实费用声明；不要提交 .env、密钥或临时数据。
