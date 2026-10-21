---
title: 第 10 篇｜接收新输入，暂停后继续
description: 从运行中的代码诊断出发，逐步实现补充要求与追问队列、状态写回、协作式暂停和同进程续运行。
---

# 第 10 篇：接收新输入，暂停后继续

Agent 已经读完源码和测试，正准备解释 `sum([])` 报错。此时用户又说：“请用中文，只诊断，不修改文件。”这句话应该放在哪里？再调用一次 run，会启动另一个任务；只打印到终端，模型又看不到。

本篇实现的是：**让运行中的任务接收新消息，并能在完整步骤后暂停、带着新输入继续。** 仍然沿用同一套循环、读取工具与诊断场景。先弄清消息什么时候生效，再写队列和暂停代码。

## 本篇先建立什么认知

### 已有能力与这次补的地方

到第 9 篇，一个 Agent 实例能启动、取消、报告过程、保存最终结果，并拒绝重复启动。但运行开始以后，它只能处理最初的用户任务。

本篇补三种行为：

| 用户想做什么 | 本篇提供的行为 | 可以观察到什么 |
|---|---|---|
| 补充当前要求，例如“请用中文” | 先排队，在下一次决策前写入用户消息 | 下一轮 Context 含新要求 |
| 等当前问题答完，再追问测试遗漏 | 先排队，当前答案符合完成规则时再接入 | 同一历史上多一次决策，不重复读取已有材料 |
| 先停下来，看完材料后再继续 | 请求暂停，循环在完整步骤后的检查位置返回 | Outcome 为 paused；继续后保留读取结果与累计次数 |

前两种都接收文字，但时机不同。第三种改变运行是否继续，不是一条“请停止”的模型提示词。

本篇先用固定脚本让顺序可重复，再给出复用 DeepSeek 适配器的可选联网入口。**examples 是组装与观察入口；队列、输入写回、暂停与实例管理是累计的 Runtime 实现。**

### 新功能在整条运行链的哪里

```text
用户发来新消息 → 实例先保存到待处理队列
                              ↓
已有循环：上一批结果写回 → 检查暂停 → 接入补充要求
                                          ↓
                                写入 State 的 user 消息
                                          ↓
                                 构造 Context → 决策
                                          ↓
          工具请求：执行、写回、继续     完成请求：核对后检查追问
```

[![实例接收补充要求、追问和暂停请求；循环在下一轮前或完成前接入，写入 State 后再构造 Context，暂停则返回快照等待继续](/diagrams/input-pause-boundaries.svg)](/diagrams/input-pause-boundaries.svg)

点击可放大。箭头表示运行步骤或输入传递；它没有让界面直接修改 State，也没有从观察回调里另起一条循环。图中省略普通失败与超时出口，原处理继续保留。

### 先解释四个容易混淆的词

**排队**是先保存待处理输入。本篇用数组保存；先进去的同类消息先处理，称为先进先出。进入队列不代表模型已经看到它，必须等循环取出并写回历史。

**补充要求，steer**：在当前任务下一轮决策前接入，例如“请用中文”。本篇每次取出当前已有的全部 steer，保留它们的进入顺序。

**接续追问，follow-up**：在当前回答本来可以结束时，再处理下一件事，例如“再说明已有测试漏了什么”。本篇每次只取一条；回答完再检查下一条。两种队列是本项目的接口设计，借鉴 Pi 的输入消费时机，不是模型 API 的字段。[Pi：steer 与 followUp](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/agent/src/agent.ts#L283-L290)

**协作式暂停**：先记下暂停请求，循环走到约定检查位置才停。它不抢占正在等待的模型请求或工具批次。挂起依赖仍需要第 4 篇的取消和超时；暂停不替代它们。

### 这句话什么时候才会生效

假设用户在工具执行途中补充要求。已经发出的模型请求不能倒回去加入文字，本篇也不打断已启动的工具批次。等本批结果确认写回，循环才接入消息，再构造新的模型输入。

所以 steer 适合指导**后续决策**，不能承诺立即阻止已经开始的操作。真正限制写文件等权限，仍需执行前的程序检查，后续权限章节会实现。本篇工具只返回固定片段，不进行写入。

若用户在模型生成最终答案时补充要求，循环收到这份 finish 后会先检查新要求。有输入就继续决策，不把旧答案直接当作整个任务完成。旧候选答案仍保留在历史中，记录它曾经提出过什么。

## 用同一份历史比较三种行为

### 补充要求：在第二轮前多一条 user

```text
原始任务
→ assistant 请求源码与测试
→ 两条 tool 结果写回
→ 【新增 user：请用中文，只诊断，不修改文件】
→ 第二次决策看到 5 条消息
→ assistant 给出中文诊断，结束
```

工具结果已经在 State 中，追加输入不需要清空它们。正常情况下总计仍是 2 次决策、2 项读取，最终有 6 条消息。

### 追问：先处理当前完成，再接下一问

```text
原始任务 → 两份读取结果 → 第二次决策给出诊断
→ 当前答案通过证据检查
→ 【新增 user：再说明已有测试遗漏了什么】
→ 第三次决策使用已有材料回答
→ 结束
```

第一份答案留在历史里，但此时还不发最终 run-ended；先把追问接进去。最终结果是最后一份答案，之前的答案可从 State 回查。正常场景总计 3 次决策、7 条消息。

### 暂停：把“等用户继续”作为单独结果

```text
原始任务 → 两份读取结果写回
→ 收到暂停请求，在下一轮前返回 paused
→ 调用方查看结果，等待用户决定
→ 用户明确输入继续要求
→ 沿用暂停历史，追加 user，再进行第 2 次决策
```

暂停期间没有一份永远挂着的运行 Promise：本段 run 已返回，isRunning=false；实例还保留暂停快照，isPaused=true。**paused 不等于 completed，也不等于 cancelled。**

这只是同一进程中保留对象后的继续。关掉进程就丢失队列和快照；重启恢复需要第 11、12 篇的日志与副作用处理。手动 pause 也不是审批许可，不能据此授权写入。

## 推荐分支与前置版本

从已完成并提交的第 9 篇本地版本创建：

```bash
git switch -c codex/chapter-10-input-pause
```

分支已存在时使用 `git switch codex/chapter-10-input-pause`。不增加依赖，以下命令均在仓库根目录运行。

```bash
npm run typecheck
node src/examples/inspect-agent.ts
```

先确认旧的两轮场景仍完成。后续仍累计修改同一 Runtime，不删除第 9 篇入口。

::: info 实现与验证范围
本篇候选实现在独立工程验证了队列顺序、消息写回、补充要求与追问、暂停后继续、取消优先、结果副本、输入裁剪保留用户消息，以及模拟 HTTP 中的三轮真实适配器组装。DeepSeek 入口通过类型检查，但编写时未读取密钥、未调用真实服务；可选联网步骤需要自行运行。暂不增加单测编写任务。
:::

## 文件改动怎样接起来

| 文件 | 变化 | 用途 |
|---|---|---|
| `src/runtime/input-queue.ts` | 新增 | 保存两类待处理文字，按检查位置取出 |
| `src/examples/inspect-input-queue.ts` | 新增 | 先独立观察消费顺序 |
| `src/runtime/types.ts` | 修改 | Outcome 增加 paused |
| `src/runtime/events.ts` | 修改 | 报告新输入已写回、区分续运行开始 |
| `src/runtime/run-state.ts` | 新增 | 初始化新任务，或复制核对暂停状态 |
| `src/runtime/context-window.ts` | 修改 | 裁剪时保留全部 user 消息 |
| `src/runtime/agent-loop.ts` | 修改 | 在约定位置接入输入、暂停或继续 |
| `src/runtime/agent.ts` | 修改 | 实例管理队列、暂停请求和 resume |
| `src/examples/trace-printer.ts` | 修改 | 显示新输入与续运行 |
| `src/examples/batch-scenario.ts` | 修改 | 导出已有读取证据检查，供新脚本复用 |
| `src/examples/input-scenario.ts` | 新增 | 按已有材料与新要求返回固定答案 |
| `src/examples/inspect-input-agent.ts` | 新增 | 运行补充要求、追问、暂停和故障模式 |
| `src/examples/deepseek-follow-up.ts` | 新增，可选运行 | 用既有模型适配器处理一次追加追问 |

下面按阶段完成这 13 个文件。完整函数保持连续可复制；解释中的摘录仅供对照，已在上方实现中，**无需再次写入、追加或替换文件**。

## 阶段一：先观察两种输入怎样排队

### 1. 定义输入与循环拉取接口

新建 `src/runtime/input-queue.ts`，先写入：

<<< ../snippets/10/src/runtime/input-queue.ts#contracts

PendingInput 是队列中的一项，保存种类和文字。例如 `{ kind: "steer", content: "请用中文。" }`。此时它不是 Message，尚未进入 State，也不带工具调用 ID。

InputBoundary 表示循环来检查输入的位置：before-decision 是准备下一轮之前，before-finish 是当前答案已经可以完成、准备结束之前。它是本项目内部标记，不会发送给模型。

RunInbox 描述循环需要的两个操作：取出当前允许处理的输入，询问是否有人请求暂停。循环不持有实例里的数组，也不负责接收键盘事件；它只在正确时机拉取。

### 2. 同类先进先出，补充要求优先

先拿一个具体例子：追问“测试漏了什么”先进入队列，随后两条当前要求“请用中文”“只诊断”也进来。下一轮开始前，应先接入两条要求；追问仍等到当前答案可以完成时再处理。

在 `src/runtime/input-queue.ts` 末尾追加完整创建函数：

<<< ../snippets/10/src/runtime/input-queue.ts#queue

push 先拒绝空文字，再保存一个新对象。steering 与 followUps 是本次创建函数拥有的两个数组，调用方只拿到操作函数，不能直接重排它们。

take 先看 steering。只要里面有内容，`splice(0)` 就取出并移除全部要求，顺序与进入时一致。因此即使先排了一条 follow-up，也不会挡住当前要求。没有 steer，且位置是 before-decision 时，返回空数组，不提前消费追问。

来到 before-finish，若仍没有 steer，`shift()` 才拿走最早一条 follow-up。包装成一项数组，让循环无论收到一条还是多条，都能按相同方式追加 user 消息。没有下一项则返回空数组。

clear 清空两份待处理列表，counts 每次返回新的计数对象。它们服务实例清理与界面观察，**不是删除已经写进 State 的消息**。本文件只负责排队与取出，不知道模型、工具或完成规则。

### 3. 第一个可运行检查点

新建 `src/examples/inspect-input-queue.ts`：

<<< ../snippets/10/src/examples/inspect-input-queue.ts

```bash
npm run typecheck
node src/examples/inspect-input-queue.ts
```

输出：

```text
决策前取出（beforeDecision）: 请用中文。 | 只诊断，不修改文件。
尚未处理（pending）: {"steering":0,"followUps":1}
可结束时取出（beforeFinish）: 最后说明已有测试漏了什么。
再取为空（empty）: 0
```

这里只证明两类输入的消费顺序，没有启动 Agent。`take` 已把消息移出队列，但本例只打印它们；下一阶段会让循环接住并保存，模型才可能看到。

## 阶段二：为暂停与新输入准备数据约定

### 4. 增加暂停结果与输入事件

修改 `src/runtime/types.ts`，在 Outcome 联合类型的 `| StopOutcome` 前新增这一项；其他类型不变：

```ts
  | { status: "paused" }
```

这是一种退出原因，不是 Message 的新角色。暂停结果仍是 `{ state, outcome }`，调用方能看见此前完成的读取，且知道任务没有完成。

修改 `src/runtime/events.ts`，在顶部新增类型导入：

```ts
import type { InputKind } from "./input-queue.ts";
```

把 EventPayload 中原来单独的 run-started 一项替换为以下两项，其他事件和分发函数保留：

```ts
  | { type: "run-started"; resumed?: boolean }
  | { type: "inputs-recorded"; kinds: InputKind[]; count: number; messages: number }
```

resumed 为 true 表示本段循环使用了已有状态。inputs-recorded 报告已经追加的输入种类、条数与当前总消息数；它不报告尚在队列中的消息，也不把消息正文复制进事件。

### 5. 新任务与续运行，从哪里取得 State

第 9 篇循环每次都创建空历史。现在若暂停后仍这样做，前面的源码与测试会消失，累计次数也被清零。

新建 `src/runtime/run-state.ts`，写入完整文件：

<<< ../snippets/10/src/runtime/run-state.ts

没有 previous 时与以前一样初始化。提供 previous 时先复制，再核对原始目标、首条 user、累计动作数和消息组完整性，返回这份可继续使用的状态。

原始 goal 不随追加要求重命名。它记录任务起点，也是暂停状态与本次目标相符的依据；后来的要求按顺序放进 messages。决策器使用的是新 Context 里的消息，不是只读最初 goal。因此“任务名称没改”不表示模型看不到新输入。

recorded 数的是已经保存的 assistant 动作，必须与 decisions 一致。旧次数保留下来，继续时仍受同一个 maxDecisions 上限约束；不会靠暂停反复获得额度。

groupExchanges 复用第 8 篇：若有一份请求却没有完整结果，就拒绝续跑。不能把运行一半、结果未知的工具请求当作还没执行，再默默做一遍。本章在完整批次写回之后才暂停，正常快照能通过这个检查。

这个函数只核对**本进程中按本项目类型生成的快照**，不声称已经完成任意磁盘 JSON 的校验、版本迁移或副作用恢复。那些问题后续单独处理。它返回 State 给循环，由循环继续写；不调用模型，不保存文件。

### 6. 裁剪不能丢掉用户后来补充的要求

假设历史已变成：原始任务、很长的旧回答、新增“只诊断”、较新的材料。第 8 篇只固定保留首条 user，若继续把中间所有旧组都省略，新要求也可能消失。

本篇先采用一条保守规则：**全部 user 原文保留，工具请求与结果仍成组选择。** 这样不会因为省输入而悄悄丢掉用户约束；用户文字本身太多、必须保留的材料装不下时，仍明确返回输入限制。它不是长期对话的最终压缩策略。

用下面完整文件替换 `src/runtime/context-window.ts`：

<<< ../snippets/10/src/runtime/context-window.ts

类型、测量、配置检查以及从全量开始尝试的顺序都沿用第 8 篇。新增部分在选择循环里：

**讲解摘录 · 哪些原文能保留，哪些能交给摘要（无需写入文件）**

<<< ../snippets/10/src/runtime/context-window.ts#selection

retained 的条件是：位于本次保留范围，**或者这一组是 user**。user 原本就单独成组，因此会以原顺序留下；不会为了固定它而挪到历史最前面。

omitted 则只取早期范围内的非 user 组。摘要回调接到的是实际省略的那些记录，不再把仍保留的用户文字重复摘要。最后把原任务、retained 与可选摘要组成 Context，一起计量，能装下才返回。

State 仍保持完整。这次只改变了选择新 Context 的规则；没有往 State 增加 context 字段，也没有让输入队列直接修改选择器。keepRecentExchanges 仍按第 8 篇的完整组计数，额外固定 user 不等于它们能绕过大小限制。

保存以上文件后，运行 `npm run typecheck` 与 `node src/examples/inspect-windowed-loop.ts`。旧的日志场景只有首条 user，仍应按原规则三轮完成。

### 先验证旧要求确实留下来

仍用第 8 篇的长日志样本，模拟用户在早期就补充了“请用中文”。后面的选择会省略旧日志，但不能把这条用户要求一并省略。

下面是终端观察命令，直接复制到终端运行，**不创建或修改源码文件**。history 仅是这个命令里独立生成的历史样本，不是正在运行的 State。

```bash
node --input-type=module <<'JS'
import { createContextFixture } from './src/examples/context-fixture.ts';
import { createContextWindow, ContextWindowError } from './src/runtime/context-window.ts';

const history = createContextFixture().messages;
history.splice(1, 0, { role: 'user', content: '请用中文。' });
const context = createContextWindow({ maxBytes: 1600 })(history);
const users = context.messages.filter((message) => message.role === 'user');
console.log(`用户消息条数（users）: ${users.length}`);
console.log(`后补要求仍在（kept）: ${users.some((message) => message.content === '请用中文。')}`);

try {
  createContextWindow({ maxBytes: 50 })(history);
} catch (error) {
  console.log(`明确报告输入超限（contextLimit）: ${error instanceof ContextWindowError}`);
}
JS
```

预期输出：

```text
用户消息条数（users）: 2
后补要求仍在（kept）: true
明确报告输入超限（contextLimit）: true
```

第一次选择能省略长日志，保留原始任务、后补要求与近期批次；第二次预算太小就明确拒绝。这里不通过删掉用户要求来换取一次看似成功的模型调用。命令结束后无需恢复源码。

## 阶段三：由循环接入输入，决定是否继续

### 7. 扩展配置，保留原来的状态与控制模块

在 `src/runtime/agent-loop.ts` 顶部新增两项导入：

```ts
import { createRunState } from "./run-state.ts";
import type { InputBoundary, RunInbox } from "./input-queue.ts";
```

保留其余导入和 snapshot、failure、errorMessage，用下面类型替换 RunAgentOptions：

<<< ../snippets/10/src/runtime/agent-loop.ts#options

inbox 是本次运行拉取输入与暂停请求的接口；initialState 是续运行使用的已有快照。不传它们时，旧调用方仍按第 9 篇运行。实例会负责提供这两个配置，正常应用入口不需要手工拼接历史。

### 8. 完整替换循环函数

删除原来的整个 runAgentLoop，用下面完整函数替换。不要保留两份同名函数，也不要把后面的讲解摘录再追加到文件中。

<<< ../snippets/10/src/runtime/agent-loop.ts#loop

先沿这次任务理解新增的位置，再分别看追问与暂停。

#### 取出输入之后，谁真正保存了它

**讲解摘录 · 循环内部的输入写回函数（无需写入文件）**

<<< ../snippets/10/src/runtime/agent-loop.ts#accept

acceptInputs 接收检查位置。例如 before-decision 时，实例的队列可能交回一条“请用中文”。此时 inputs 接住的是从队列取出的 PendingInput 数组，还不是历史。

state 赋值为每一项创建 `{ role: "user", content: ... }`，追加到原消息之后。**这一条赋值才让消息进入 State。** decisions 没有加一，因为收到用户消息不是取得模型动作。kind 只决定消费时机，并保留在事件里；模型收到的仍是普通 user 消息，不需要认识 steer 或 follow-up 这些应用方法。随后报告 inputs-recorded；从此这份消息能进入下一次 buildContext(state)。

返回 true 表示刚刚追加过输入，供后面的完成分支决定“先别结束，继续下一轮”。没有输入则返回 false，不构造空消息，不凭空计一次决策。

report 之后仍 check，保留第 9 篇观察回调可能触发取消的处理。若回调里又排了新文字，它留在队列，由下一次检查接入，不直接改正在使用的输入数组。

#### 下一轮开始前，先决定暂停还是接入消息

**讲解摘录 · while 开头的检查位置（无需写入文件）**

<<< ../snippets/10/src/runtime/agent-loop.ts#checkpoints

先检查取消与时间，再询问暂停请求。已经要求暂停，就返回 paused，不消费队列；消息仍由实例保留，等待继续。

没有暂停才接入 steer。接入事件也可能让调用方请求暂停，所以再检查一次，随后才进入原来的 Context 构造与决策流程。本篇没把追问提前塞进每一轮；before-decision 没有 steer 时只返回空数组。

之后的工具分支仍等整批结果、核对关联、一次写回。暂停请求不会从 worker 中间强行返回，也不会保留一半工具结果作为“完整可继续”的历史。

#### 模型提出了答案，但还有补充要求

**讲解摘录 · finish 分支里，先处理暂停与 steer（无需写入文件）**

<<< ../snippets/10/src/runtime/agent-loop.ts#finish-input

走到这里，模型的 finish 动作已经记进 State，计数也已增加，但并未返回 completed。若此时要求暂停，就保留这个候选动作并返回 paused。

若有 steer，acceptInputs 把新要求追加为 user，然后 continue 回到 while。下一次构造 Context 时，模型能同时看见先前的候选答案与新要求。旧答案不会被假装没有产生过，也不会直接成为最终结果。

这时不必让旧答案先通过验证：它已经被新输入要求继续处理。若没有新要求，才按原流程核对完成证据。主动 fail、普通模型错误或验证拒绝仍按原出口结束，不自动拿 follow-up 掩盖失败。

#### 当前答案通过验证后，才接续追问

**讲解摘录 · 可以完成时再检查 follow-up（无需写入文件）**

<<< ../snippets/10/src/runtime/agent-loop.ts#follow-up

accepted 为 true，只表示当前答案符合场景完成规则。此时先检查暂停，再检查 before-finish：有 steer 仍优先接入；否则接入一条 follow-up。

有输入，continue 继续同一个循环，不返回 completed，不重置次数与本段计时，也不换一份 State。没有输入，才报告并返回 completed。因此正常追问场景只有最后一次 run-ended，前一个候选答案仍能从历史回查。

若最后一份额度刚好用完，输入可能已经写入 State，continue 后却发现没有额度再决策，返回 budget-exhausted。**“已接收并记录”不等于“已经回答”。** 后面用 budget 模式实际观察这一点。

#### 暂停、取消与最终报告怎样配合

最外层 catch 仍先读取 control.outcome，因此同一检查位置既有暂停请求又已取消时，返回 cancelled；超时也是原来的 timed-out。它们不被 paused 覆盖。

每个已知结果仍交给原内部 finish 报告 run-ended，再返回 State 与 Outcome。paused 也有结束报告：它结束的是**本段运行调用**，不是宣布用户任务已经完成。控制资源在 finally 释放，暂停期间没有旧计时器偷偷继续取消下一段。

本文件仍是唯一的历史写入者。队列负责暂存，run-state 负责复制初始状态，context-window 负责模型输入选择，run-control 负责本段的等待与停止；循环把它们接在正确位置。

保存后运行 `npm run typecheck` 与 `node src/examples/inspect-trace.ts`。不提供 inbox 的旧入口仍是两轮、8 份事件。

### 9. 显示新输入与续运行

用下面完整文件替换 `src/examples/trace-printer.ts`：

<<< ../snippets/10/src/examples/trace-printer.ts

只新增 inputs-recorded 的显示，并根据 resumed 显示“续运行开始”。其余事件含义不变。messages 是循环写回后的总数，count 才是本次新追加的条数，不能把这两个数字当作一回事。

## 阶段四：让实例接收操作，保存暂停点

### 10. 完整替换实例文件

循环已经能接收接口，接下来由第 9 篇 Agent 对象持有队列、暂停标志与已有结果。用下面完整代码替换 `src/runtime/agent.ts`：

<<< ../snippets/10/src/runtime/agent.ts

#### 先辨认新增字段与对外状态

inputs 是实例独有的队列；pauseRequested 记录用户请求；acceptingInputs 表示当前这一段是否还接收新输入。controller 与 lastResult 沿用上一章。

| 对外属性或方法 | 当前含义 |
|---|---|
| isRunning | 本段循环仍在执行，包括等待工具 |
| isPaused | 本段已返回 paused，实例仍保留可继续快照 |
| pendingInputs | 尚未写进 State 的两类输入数量 |
| result | 本段已经返回的结果副本，不是实时 State |
| run(goal) | 明确开始一个新任务，创建新历史 |
| resume(content) | 对已有暂停任务输入文字，沿同一历史继续 |

创建实例不自动启动。与第 9 篇一样，订阅只是登记接收者；控制器只在一段 start 运行期间存在。

#### 排队操作没有直接改模型输入

**讲解摘录 · 接收 steer、followUp 和 pause 请求（无需写入文件）**

<<< ../snippets/10/src/runtime/agent.ts#input-methods

steer、followUp 先检查当前可以接收输入，再调用队列的 push。它们都没有 State 参数，也不调用模型。调用成功后应等待 inputs-recorded，才能知道循环已经把文字接进去。

运行中或已暂停时可以排队。普通空闲、已经完成或失败时不接收，避免新文字无人消费。pause 只接受当前还在工作的运行，保存一个布尔值；它不 abort，不替循环拼造 paused 结果。

若观察者自己抛错，第 9 篇通知通道仍隔离它。因此不要靠未检查的观察回调承担必须成功的用户输入提交；正常界面调用这些方法时应处理其同步错误。本章固定示例在已知可接收位置调用。

#### run 是新任务，resume 才沿用暂停状态

**讲解摘录 · 两个公开启动入口（无需写入文件）**

<<< ../snippets/10/src/runtime/agent.ts#entries

run 先拒绝重入，再清空旧待处理队列，调用 start，不提供旧状态。显式 run 意味着开始新任务；若原来还有暂停结果，它会被这次新任务替换。

resume 先确认没有活动运行，且上一份结果确实 paused。把继续文字加入 steer，然后把原始 goal 与保存的 state 交给 start。继续文字必须非空；它是一条明确的用户输入，不是自动注入的虚构工具结果。

暂停期间先排的 steer 会排在这次继续文字之前，一起在下一轮接入。已有 follow-up 继续等待完成位置。请在 await 上一段 run 返回后再 resume；在 run-ended 回调中实例可能尚未释放，仍会拒绝重入。

#### 一段运行怎样连接队列、信号与事件

**讲解摘录 · 实例内部 start 的完整连接（无需写入文件）**

<<< ../snippets/10/src/runtime/agent.ts#start

start 在调用循环前保存 controller，清掉旧暂停请求与本段结果，再打开输入接收。它仍在第一次 await 之前占住实例，重复启动保护没有被队列功能绕开。

inbox.take 使用队列的闭包函数；isPauseRequested 使用箭头函数读取本实例的最新标志。循环看到的是操作接口，不能从中取得可变数组。initialState 只在 resume 时提供，循环内部复制并核对后继续。

收到 run-ended 或 run-crashed 时，先关闭 acceptingInputs，再向外分发。这样结束报告中的接收者不能趁 isRunning 暂时仍为 true，排入一条已经没人消费的新消息。它应等待本段返回，再根据结果决定后续操作。

拿到结果后仍复制保存。finally 清空 controller 并关闭输入；只有 paused 保留待处理队列，完成、失败、取消、超时和预算退出都清空未消费内容，不自动把它们带入下次新任务。已经写进 State 的消息不会被 clear 删除。

#### 两段运行的次数、时间与身份分别怎么算

续运行保留 state.decisions，因此上一段用了一次，下一次从第 2 次开始，仍受原额度限制。State 消息也保留，工具调用 ID 继续从整段历史查重。

本段 timeoutMs 则在每次 start 创建控制器时重新计时；暂停等待用户的时间不算在任一活动段内。**当前没有跨暂停段的整任务总时长限制**，资源控制章节再补这项能力。

每次进入循环创建新的报告器，所以续运行的 runId 改变、seq 从 1 重新开始，run-started 带 resumed=true。当前应用通过同一 Agent 与保存的暂停结果连接这两段；没有实现持久会话 ID 或跨进程 Trace 关联。

cancel 仍只中断正在运行的本段；已经 paused 时没有活动控制器，它不会将暂停快照变成 cancelled。需要开始另一件事时显式 run，新任务不会继承旧队列。恢复被取消、超时或崩溃的工具执行不在本篇范围内。

现在 agent.ts 完成：公开方法接收操作，私有 start 连接循环；队列与结束快照由实例持有，实时 State 仍由循环独占更新。没有额外启动第二套 Agent Loop。

## 阶段五：在原诊断场景里观察新行为

### 11. 复用读取证据，避免遇到新 user 就重新读取

第 7 篇 scriptedBatchDecide 用“最后一条是 user”判断首次读取。现在追问也是 user，直接复用这个条件，会重复提出 source-1、tests-1，随后被历史 ID 查重拒绝。

这不是循环坏了，而是旧脚本只模拟最初两轮，没实现追加输入场景。需要让新脚本先问“已有读取证据吗”，而不是“最后一条是不是 user”。

修改 `src/examples/batch-scenario.ts`，只给原来的 hasBothReads 加上 export，函数体保持不变：

```ts
export function hasBothReads(messages: readonly Message[]): boolean {
```

这是**替换已有函数声明行**，不是再追加一份函数。其他导出和旧脚本保留。它仍按调用 ID、工具名、路径、成功状态和固定内容检查两份证据；新脚本直接检查 Context 消息，不需要构造假的 State。

新建 `src/examples/input-scenario.ts`：

<<< ../snippets/10/src/examples/input-scenario.ts

第一次还没有 assistant 请求，返回固定两项读取。之后复用 hasBothReads 检查已知材料，没有证据就 fail，不伪造成功。

有证据时，收集所有 user 消息，识别本例两份固定输入：追问存在就返回测试遗漏；只有中文要求时返回中文诊断；都没有则给原诊断。每次仍只返回 Action，消息写回和继续都由循环安排。

这些答案是预设内容，脚本不能理解任意自然语言。它只是让“同一历史中新增的输入改变后续回答”可重复观察。换成模型时替换 decide，Runtime 的队列、输入写回和暂停机制保留；完成规则也仍只是本例的有限证据检查。

### 12. 组装入口，先不启动

新建 `src/examples/inspect-input-agent.ts`，先写入：

<<< ../snippets/10/src/examples/inspect-input-agent.ts#setup

注册表、两份工具与完成规则沿用旧实现，decide 换成刚才的新脚本。mode 选择本次实验，默认 steer。budget 模式把额度从 5 临时改为 2，其余模式一致。

这一步只是创建实例并登记中文显示，还没运行任何请求。

### 13. 用固定事件位置模拟一次用户操作

在入口末尾追加：

<<< ../snippets/10/src/examples/inspect-input-agent.ts#inject

收到 results-recorded 表明两份读取已经进入 State。这里精确模拟一次用户操作，避免用“等待 10 毫秒再输入”猜运行进度。injected 保证只发生一次，不会在下一轮又不断追加同一句话。

这个接收者调用实例方法，只把文字排队或记下暂停请求，没有直接拼接 State。真正接入后，循环会发出另一种 inputs-recorded 事件。两个事件名字相似，前者是工具结果写回，后者是用户输入写回。

cancel 模式同时请求暂停与取消，检查停止原因优先的行为。这是故障装置，不是正常业务需要同时调用的两个按钮。

### 14. 启动，必要时继续，再显示结果

在入口末尾追加：

<<< ../snippets/10/src/examples/inspect-input-agent.ts#run

first 接住第一段运行结果。只有 outcome 为 paused 才调用 resume，不能因为 isRunning=false 就恢复任意已结束任务。resume 接到明确的继续文字，返回下一段结果。

入口最后用 agent.result 取得最近一段的结束副本。若 paused 后已继续，它对应续运行结果；first 仍保留先前的暂停快照，不会被下一段修改。统计 toolMessages 证明两份读取还在，后面日志也能看到没有再次进入 batch-started。

```bash
npm run typecheck
node src/examples/inspect-input-agent.ts steer
```

正常输出：

```text
事件（event）#1 run-started：运行开始
事件（event）#2 decision-started：第 1 次决策，输入消息=1，输入字节=94，有摘要=false
事件（event）#3 decision-recorded：动作=tools，调用=source-1,tests-1
事件（event）#4 batch-started：准备执行批次 source-1,tests-1
[执行工具 execute] read_source 文件路径（path）=src/sum.ts
事件（event）#5 results-recorded：已写回 source-1,tests-1，状态=ok,ok
事件（event）#6 inputs-recorded：写入用户消息=1，种类=steer，消息=5
事件（event）#7 decision-started：第 2 次决策，输入消息=5，输入字节=633，有摘要=false
事件（event）#8 decision-recorded：动作=finish，调用=无
事件（event）#9 run-ended：结果=completed，决策=2，消息=6
本段结果（outcome）: completed
本段决策累计（decisions）: 2
是否暂停（isPaused）: false
最终消息顺序（messages）: user -> assistant -> tool -> tool -> user -> assistant
最终答案（answer）: 空数组调用 reduce 时没有初始值，因此报错；本次只诊断，未修改文件。
```

94、547 或 633 等字节数由固定文字决定，不是 token 数。这里重要的是：第 2 次决策前新增了一条 user，输入从原来的 4 条变为 5 条，而且两份 tool 仍然存在。不能只根据答案中文了就断言状态正确，还要核对消息与次数。

## 比较追问、暂停与两条失败路径

### 追问没有抢在当前诊断之前

```bash
node src/examples/inspect-input-agent.ts follow-up
```

前 5 份事件仍是读取过程，接下来有：

```text
事件（event）#6 decision-started：第 2 次决策，输入消息=4，输入字节=547，有摘要=false
事件（event）#7 decision-recorded：动作=finish，调用=无
事件（event）#8 inputs-recorded：写入用户消息=1，种类=follow-up，消息=6
事件（event）#9 decision-started：第 3 次决策，输入消息=6，输入字节=724，有摘要=false
事件（event）#10 decision-recorded：动作=finish，调用=无
事件（event）#11 run-ended：结果=completed，决策=3，消息=7
```

最后答案为“现有测试只覆盖非空数组，遗漏了 sum([])；应补上空数组用例。”中间没有第二份批次读取，也没有在第 7 份事件后先发 completed 再创建新任务。

### 暂停返回了，但用户任务尚未完成

```bash
node src/examples/inspect-input-agent.ts pause
```

第一段在两份结果写回后结束：

```text
事件（event）#6 run-ended：结果=paused，决策=1，消息=4
本段结果（outcome）: paused
本段决策累计（decisions）: 1
是否暂停（isPaused）: true
```

入口随后显式调用 resume，第二段有新的编号：

```text
事件（event）#1 run-started：续运行开始
事件（event）#2 inputs-recorded：写入用户消息=1，种类=steer，消息=5
事件（event）#3 decision-started：第 2 次决策，输入消息=5，输入字节=633，有摘要=false
事件（event）#4 decision-recorded：动作=finish，调用=无
事件（event）#5 run-ended：结果=completed，决策=2，消息=6
续运行结果（outcome）: completed
续运行决策累计（decisions）: 2
两次读取结果仍在（toolMessages）: 2
```

注意“事件 #3”报告“第 2 次决策”：事件编号属于本段，决策次数属于保留的任务 State。两段的 runId 也不同；不能把 seq 相同的事件误认为同一次运行。

### 已取消时，不把原因改成暂停

```bash
node src/examples/inspect-input-agent.ts cancel
```

最终为 cancelled、decisions=1、4 条消息，isPaused=false。两份工具结果在请求取消前已经写回，因此保留。`agent.resume(...)` 只接受 paused，不能以此恢复被取消的运行。

### 用户输入已记录，但没有额度回答

```bash
node src/examples/inspect-input-agent.ts budget
```

前两次决策分别读取和诊断；随后追问写成 user，但额度上限也是 2。最终应看到：

```text
事件（event）#8 inputs-recorded：写入用户消息=1，种类=follow-up，消息=6
事件（event）#9 run-ended：结果=budget-exhausted，决策=2，消息=6
本段结果（outcome）: budget-exhausted
```

最后一条是 user，说明还有已记录、未被回答的要求。不能因为前一份答案通过过验证就宣称整个运行 completed，也不能靠接入输入自动重置次数。

## 调试时先区分“排队、写回、成为输入”

```text
agent.steer(text)
  → inputs.push：实例队列保存 PendingInput
  → 下一次循环检查，inbox.take 取出
  → acceptInputs：追加 user，State 改变
  → buildContext：从最新历史准备输入
  → decide(context)：脚本或模型实际看到这份输入
```

这五步发生在不同地方。只调用了 steer、只看到队列计数，或者只打印了文字，都不能证明模型已经收到它。inputs-recorded 与下一次 decision-started 可以帮助找到中间停在哪一步。

| 症状 | 先看哪里 | 应核对的值 |
|---|---|---|
| 排队成功，下一轮却没收到 | acceptInputs 与 buildContext 的顺序 | inputs、State 最后的 user、context.messages |
| 追问提前影响当前任务 | take 的 boundary | before-decision 不能取 followUps |
| 新输入导致重复旧调用 ID | 场景脚本首次读取条件 | 是否仅按“最后一条 user”判断首次请求 |
| 暂停后重新读取或次数归零 | resume 传入 start 的 initialState | 暂停快照有几条 tool，decisions 是否保留 |
| 一直不返回，pause 没立即生效 | 当前模型或整批等待 | 暂停不抢占等待，需要 cancel 或 timeout |
| 输入裁剪后忘掉新限制 | retained、omitted | user 是否始终保留；是否按完整组选择 |
| 结束事件里追加输入报错 | acceptingInputs 与重入保护 | 结果已确定，本段不再接收输入 |

运行可附加调试器：

```bash
node --inspect-brk src/examples/inspect-input-agent.ts pause
```

设置四个断点：

1. input-queue.ts 的 push：刚保存时文字只在实例数组，不在 State。
2. agent-loop.ts 的 acceptInputs 中 state 赋值：执行前后比较 messages，decisions 不变。
3. agent-loop.ts 的 paused 出口：检查是否已收齐上批结果，没有未完成请求。
4. agent.ts 的 start：第二段 initialState 非空，复制后仍有原读取，不是重新创建只有 user 的状态。

调试暂停会消耗实际时间。需要停留查看时，临时把 inspect-input-agent.ts 的 timeoutMs 从 1000 改成 60000，结束后恢复。Node 附加调试的含义沿用第 9 篇。[Node：调试选项](https://nodejs.org/en/learn/getting-started/debugging)

### 一个小迁移：同一位置排两种输入

只修改 inspect-input-agent.ts 的 steer 模式分支：先调用 `agent.followUp(followUpText)`，再调用 `agent.steer(steerText)`；其他部分不变。

运行 steer 模式。尽管追问先进入队列，下一轮应先接入中文要求，第二次决策给中文诊断；可以完成时才接入追问，第三次决策说明测试遗漏。两份读取结果仍只执行一次。

观察 inputs-recorded 的 kinds 顺序应为 steer、follow-up。这检验的是两种时机的优先关系，而不是仅按全局入队顺序处理。完成后恢复原来的单条 steer 分支。

## 可选：复用 DeepSeek，真实处理追加追问

离线行为清楚后，再写联网入口。它使用相同 Agent、队列、循环、注册表和完成规则，只把 decide 换回第 5～7 篇的真实模型适配器；不再增加第三种输入协议。

新建 `src/examples/deepseek-follow-up.ts`：

<<< ../snippets/10/src/examples/deepseek-follow-up.ts

先创建注册表与真实决策器，再交给 Agent。第一份结果写回时，模拟用户追加一次追问；queued 防止模型多读一次时又重复追加。模型可以分两轮读取，也可以一次提出两项，后续仍由相同完成规则与队列安排。

这是**真实模型决策、固定读取工具**的组合，不会真的修改文件或执行测试。模型回复和决策次数不保证与脚本逐字、逐次相同；它若没有先取得两份证据，原完成规则会拒绝，不为了得到 completed 降低检查。

本地已经配置 `.env` 时运行，密钥沿用前章变量，不写进教程或代码：

```bash
node --env-file=.env src/examples/deepseek-follow-up.ts
```

验收时检查：至少一条输入写回事件标记 follow-up；后续模型请求包含对应 user，保留已有请求与结果关系；最终 Outcome 与 State 一致。若额度耗尽、模型或网络失败，按实际原因排查，不把它改成预设成功输出。

编写时只用模拟 HTTP 核对了这个组装的三轮请求、工具 ID 与追问消息，**没有执行真实服务调用**。真实验证与离线验证分别记录。模型协议本身仍按前章的官方接口，应用负责执行与回传工具结果。[DeepSeek：工具调用](https://api-docs.deepseek.com/zh-cn/guides/tool_calls/)

## 对照 Pi：先看相同问题，再看差异

仍对照固定提交 `8efd314fa3d3232ce197d8d7a6a5660530b9d83e`。

看 [Agent 中的输入队列与公开方法](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/agent/src/agent.ts#L135-L165)：队列保存待处理消息，再由不同方法接收 steer 与 follow-up。本篇也由实例持有队列，不让界面直接改循环内部历史。

看 [循环接入 steering 与检查 follow-up 的位置](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/agent/src/agent-loop.ts#L163-L295)：新输入在下一次模型响应之前进入消息，follow-up 则在原本准备结束的位置让运行继续。本篇保留两类输入的时机区别，但采用自己的简化规则：一次取全部 steer，一次取一条 follow-up，工具批次不被 steer 中途打断。

Pi 有自己的队列模式、会话与继续接口。本篇的 paused Outcome、必须提供继续文字的 resume、同进程状态复制，以及固定保留全部 user，都是本项目的设计，不声称与 Pi 的暂停或压缩实现等价。

比较时重点看：输入先存在哪里、谁把它追加到历史、什么时候又调用模型，以及结束前是否仍有可消费输入。队列名称相同不代表这些细节完全相同。

## 完整最终文件

以下 13 个文件与前面的步骤属于同一套实现。其他第 9 篇文件保留。

### src/runtime/input-queue.ts

<<< ../snippets/10/src/runtime/input-queue.ts

### src/examples/inspect-input-queue.ts

<<< ../snippets/10/src/examples/inspect-input-queue.ts

### src/runtime/types.ts

<<< ../snippets/10/src/runtime/types.ts

### src/runtime/events.ts

<<< ../snippets/10/src/runtime/events.ts

### src/runtime/run-state.ts

<<< ../snippets/10/src/runtime/run-state.ts

### src/runtime/context-window.ts

<<< ../snippets/10/src/runtime/context-window.ts

### src/runtime/agent-loop.ts

<<< ../snippets/10/src/runtime/agent-loop.ts

### src/examples/trace-printer.ts

<<< ../snippets/10/src/examples/trace-printer.ts

### src/runtime/agent.ts

<<< ../snippets/10/src/runtime/agent.ts

### src/examples/batch-scenario.ts

<<< ../snippets/10/src/examples/batch-scenario.ts

### src/examples/input-scenario.ts

<<< ../snippets/10/src/examples/input-scenario.ts

### src/examples/inspect-input-agent.ts

<<< ../snippets/10/src/examples/inspect-input-agent.ts

### src/examples/deepseek-follow-up.ts

<<< ../snippets/10/src/examples/deepseek-follow-up.ts

## 最后检查与保存本章

恢复迁移与调试的临时改动，运行：

```bash
npm run check
node src/examples/inspect-input-queue.ts
node src/examples/inspect-input-agent.ts steer
node src/examples/inspect-input-agent.ts follow-up
node src/examples/inspect-input-agent.ts pause
node src/examples/inspect-input-agent.ts cancel
node src/examples/inspect-input-agent.ts budget
node src/examples/inspect-agent.ts
node src/examples/inspect-agent-faults.ts reentry
node src/examples/inspect-agent-faults.ts mismatch
node src/examples/inspect-windowed-loop.ts
node src/examples/inspect-windowed-loop.ts small
node src/examples/inspect-batch-loop.ts parallel
node src/examples/inspect-stream.ts cut
DOCS_BASE=/ci/ npm run site:build
```

检查的是具体行为：补充要求在下一轮前写回，追问等到可完成时才接入；暂停与取消分开，继续保留结果和次数；新用户文字不会被输入裁剪省略。旧的事件、关联拒绝、输入限制与断流行为仍成立。可选真实模型调用不包含在上述离线检查内。

确认当前分支为 codex/chapter-10-input-pause、检查通过、改动范围正确后，再复制提交命令。验证描述只在实际完成对应检查后使用；网站正文、参考代码和导航一起包含在 site/ 中。

```bash
git branch --show-current
git status --short
git add -- src/runtime/input-queue.ts src/examples/inspect-input-queue.ts src/runtime/types.ts src/runtime/events.ts src/runtime/run-state.ts src/runtime/context-window.ts src/runtime/agent-loop.ts src/examples/trace-printer.ts src/runtime/agent.ts src/examples/batch-scenario.ts src/examples/input-scenario.ts src/examples/inspect-input-agent.ts src/examples/deepseek-follow-up.ts site/
git diff --cached --stat
git commit -F - <<'COMMIT'
第 10 篇：接收新输入并在暂停后继续

为运行中的任务保存补充要求与接续追问，由循环在约定位置写入历史；暂停后沿用已有状态继续。

- 增加两类输入队列与确定的消费时机
- 循环追加用户消息后重新构造输入，不以重复启动替代接续
- 增加暂停结果、实例暂停与同进程续运行，保留历史和决策次数
- 输入选择保留全部用户消息，装不下时仍明确退出
- 增加离线正常与故障入口、可选 DeepSeek 追问入口和详细课程说明

验证：类型检查、现有环境检查、离线队列与补充输入及追问、暂停继续、取消与预算场景、旧章节相关回归、网站构建。真实模型调用另行验证。
COMMIT
git push -u origin codex/chapter-10-input-pause
```
