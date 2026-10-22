---
title: 第 09 篇｜观察运行过程，管理运行实例
description: 从一次代码诊断出发，逐步实现运行事件、内存轨迹、订阅、取消和同一实例的重复启动保护。
---

# 第 09 篇：观察运行过程，管理运行实例

任务开始了，终端却一时没有输出。它是在等模型回答，还是正在读取文件？如果此时再点一次“发送”，会不会把第二个任务也启动起来？

本篇解决这两个相连的问题：**运行时能看见正在做什么；同一个运行实例一次只负责一个任务。** 仍然用“读取源码和测试，解释 `sum([])` 为什么报错”的场景，不增加新的业务问题。

### 先知道这篇会做出什么

到第 8 篇，循环已经能准备模型输入、取得动作、执行一批工具、保存结果，再询问模型。调用方 `await runAgentLoop(...)`，最后能拿到完整结果；但运行中的进度，主要靠不同文件里的 `console.log`。

这次让循环在关键位置主动报告：“开始了”“现在准备问模型”“工具结果已经写回”“以什么原因结束”。界面可以显示这些报告，记录器也可以把同一批报告存起来。后来查看时，就知道程序最后走到了哪一步。

然后把启动、取消、是否忙碌、最终结果放到一个对象里。它负责拒绝同一对象上的重复启动。**原来的循环保留，仍负责真正的任务推进。** 不需要在对象里再写一套循环。

本章结束后，你能运行同一任务，看见两轮决策和一次工具批次的有序通知；能拒绝重复启动；也能取消任务，并从通知与最终消息判断停止发生在哪里。

### 它在整个 Runtime 的哪里

第 8 篇是在“每次问模型之前”增加输入选择。这一篇是在已有步骤旁边增加一条观察通道：

```text
任务 → 准备本轮输入 → 问模型 → 记录动作
                               ↓
                      执行工具 → 写回结果 → 下一轮

上述关键步骤 → 发出报告 → 显示进度 / 保存运行轨迹
```

[![Runtime 继续负责决策、执行和写回，新增通道将关键步骤报告给显示器和记录器](/diagrams/run-events-position.svg)](/diagrams/run-events-position.svg)

点击可放大。右边接收报告的代码不会自动执行下一步；左边的循环才会继续调用模型和工具。取消请求仍走第 4 篇的停止机制。

本篇先实现**内存中的过程记录与实例管理**。没有新增网页聊天界面、磁盘日志、崩溃恢复或输入排队；后面章节再接这些能力。事件也不会让固定脚本变得更聪明。

## 先走一遍任务，不急着看代码

### 一次正常运行，外部应该看见什么

先不考虑具体名字，按已经熟悉的过程走：

1. 调用方交来“读取源码和测试，诊断空数组报错”。循环创建本次 State，通知外部任务开始。
2. 从 State 构造第一轮 Context，通知外部现在要进行第 1 次决策。
3. 脚本提出一批读取。循环检查调用身份，把动作记入 State，再通知外部动作已经记录。
4. 循环准备执行两项读取，发出一份批次通知。
5. 两项结果收齐、关联检查通过，循环把它们写入 State，再通知外部结果已经记录。
6. 根据更新后的 State 准备第二轮输入，再发出决策通知。
7. 脚本看到两份证据，提出 finish。循环先记录动作，再用场景规则检查证据。
8. 检查通过，通知外部 completed，随后把最终 State 与 Outcome 返回给调用方。

通知必须贴着这些真实步骤产生。不能在入口先打印一份预设的“成功流程”，否则工具出错时，日志仍可能说已经完成。

本章离线入口沿用第 7 篇脚本：它能认出固定的两份读取结果并返回预设诊断，不能分析任意代码。读取工具也仍返回固定片段，没有真的打开硬盘上的 `src/sum.ts`。**脚本和工具是教学替身；循环、状态更新、取消、通知与实例管理是真正执行的代码。**

### 事件、日志、Trace：三个词先分开

**事件（Event）**是程序发给外部的一份结构化通知，例如：

```json
{
  "type": "results-recorded",
  "runId": "本次运行的唯一标识",
  "seq": 5,
  "callIds": ["source-1", "tests-1"],
  "statuses": ["ok", "ok"]
}
```

这份通知说的是：这次运行的第 5 份报告，两项调用结果已经进入历史。这里的 `seq` 是通知编号，不是决策次数，也不是工具调用 ID。

**日志**是把通知显示成文字，例如“已写回 source-1,tests-1”。同一个通知也能变成界面状态，不一定要输出到终端。

本篇把**同一次运行按顺序收集的事件列表**叫作运行轨迹 **Trace**。这只是本项目当前采用的轨迹格式，用于回查执行过程；不是模型的内部思考记录，也不是可以从中恢复全部历史的日志。它没有每份工具结果的原文，进程退出后内存数组也会消失。

事件类型和字段由本项目定义，不是 DeepSeek 协议要求。Pi 也把运行、消息和工具过程报告给应用，但有自己的事件类型；本篇末尾再对照它的局部实现。[Pi：事件类型](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/agent/src/types.ts#L474-L504)

### 它与前几篇的数据是什么关系

| 数据 | 本例中的内容 | 谁保存，谁使用 |
|---|---|---|
| State | 用户任务、两次动作、两项工具结果、决策次数 | 循环拥有并更新；完成规则看副本 |
| Context | 这一次提供给决策器的消息与可选摘要 | 输入构造器创建；决策器读取 |
| 流式增量 | 模型逐渐返回的文字、尚未拼完的参数 | 第 6、7 篇适配器处理；不能当完整动作执行 |
| 运行事件 | 开始、准备决策、记录动作、写回结果、结束 | 循环发出；观察者接收副本 |
| Trace | 某个记录器收集的事件数组 | 调用方保存在内存；用于回查顺序 |

`results-recorded` 要在 State 更新之后报告；它不会替循环保存结果。若只发通知而没有写回，下一次模型输入仍然缺少工具结果。

## 推荐分支与前置检查

从已经完成、检查并提交的第 8 篇本地版本创建：

```bash
git switch -c codex/chapter-09-run-events
```

已有分支时用 `git switch codex/chapter-09-run-events`。以下命令均在仓库根目录执行，不安装新依赖。

```bash
npm run typecheck
node src/examples/inspect-windowed-loop.ts
```

先确认旧版本仍能完成三轮场景。第 9 篇不替换第 8 篇的输入选择，也不删除现有示例。

::: info 本篇代码的验证范围
候选实现在独立工程中验证：分阶段类型检查、正常轨迹、重复启动、取消、迟到结果、观察者异常与副本保护，以及前几篇相关离线入口。本篇不新增单测编写任务，也不需要 API 密钥；没有把离线脚本验收写成真实模型调用。
:::

## 文件改动与学习阶段

先单独观察通知，再接到真实循环，最后增加运行实例。这里的“真实循环”是指 Runtime 真正在驱动步骤，决策器仍可使用固定脚本。

| 文件 | 变化 | 作用 |
|---|---|---|
| `src/runtime/events.ts` | 新增 | 定义报告、管理订阅、给每次运行编号 |
| `src/examples/inspect-events.ts` | 新增 | 先独立检查通知与取消订阅 |
| `src/runtime/agent-loop.ts` | 修改 | 在原有状态变化旁报告过程，统一报告正常退出 |
| `src/examples/trace-printer.ts` | 新增 | 把报告显示为中文日志 |
| `src/examples/inspect-trace.ts` | 新增 | 在原循环里观察两轮任务与完整轨迹 |
| `src/runtime/agent.ts` | 新增 | 管理启动、取消、忙碌标志与最终结果 |
| `src/examples/inspect-agent.ts` | 新增 | 正常使用运行实例，先不加故障装置 |
| `src/examples/inspect-agent-faults.ts` | 新增 | 最后检查重复启动、取消和错误场景 |

Runtime 文件会继续演进；examples 是组装与观察入口。状态、输入选择、工具批次和模型适配的其他文件都保留。本章没有修改 DeepSeek 的请求或解析协议。

## 阶段一：先让报告能被接收

### 1. 定义要报告的事实

新建 `src/runtime/events.ts`，先写入下面完整的导入与类型：

<<< ../snippets/09/src/runtime/events.ts#contracts

`EventPayload` 表示通知本身的内容；`RunEvent` 在内容上增加运行身份 `runId` 和顺序 `seq`。`&` 表示两部分字段都要有，而不是在两种形状里任选一种。

先看本章的正常任务如何使用它们：

| type | 本例发生时机 | 报告里的主要值 |
|---|---|---|
| `run-started` | 本次循环进入运行阶段 | 公共字段 runId、seq |
| `decision-started` | 已有 Context，准备调用决策器 | 第几次、输入消息数、输入字节数、有无摘要 |
| `decision-recorded` | 完整动作通过检查，已写入 State | tools 或 finish，相关调用 ID |
| `batch-started` | 准备把已记录请求交给批次执行入口 | source-1、tests-1 |
| `results-recorded` | 整批结果通过关联检查，已写回 State | 两个调用 ID，以及 ok/error |
| `run-ended` | 已得到本次运行的正常协议结果 | Outcome、最终决策数与消息数 |
| `run-crashed` | 未预料的内部异常将继续向调用方抛出 | 异常文本 |

这里“正常协议结果”包含 failed、cancelled、timed-out、预算耗尽和输入限制：程序认识这些出口，能返回 `RunResult`。`run-crashed` 则报告未归入这些出口的异常，不把它伪装成 completed。配置检查在运行开始之前失败时，不发运行事件，调用 Promise 会拒绝。

`batch-started` 的含义刻意限定为“准备进入执行批次”。它不能证明所有工具已经开始，更不能证明产生了外部副作用。通知之后立即取消，工具可能一个都没启动。并行工具先后完成也不会各自产生本章事件；本章观察的是整批确认与写回。

`EventListener` 是“接收一份通知的函数”的类型。它可以立即处理，也可以返回 `Promise<void>`。是否等待这个 Promise，由接下来的通知通道决定。

### 2. 同一份报告，让显示器和记录器都收到

现在有一份 `run-started` 报告，希望两处代码都收到：一处显示进度，另一处保存记录。调用方也需要在不再显示时移除自己的接收函数。

这就是接下来这个小模块解决的问题：**记住哪些函数想接收通知，发送时依次调用它们，并提供退出订阅的方法。** “订阅”只表示登记接收者，不会启动任务。

在 `src/runtime/events.ts` 类型定义之后，追加完整函数：

<<< ../snippets/09/src/runtime/events.ts#bus

先沿一次正常调用走。`subscribe(display)` 把显示函数保存到 `listeners`；`subscribe(record)` 再保存记录函数。之后 `emit(event)` 取出本次接收名单，先调用 display，再调用 record。两者拿到的是各自复制出来的报告。

::: info 以下摘录仅供对照
解释中的代码片段已包含在上方对应的完整实现中，**无需再次写入、追加或替换文件**。继续实现时，以标明“新增、追加、替换”的步骤为准。
:::

**讲解摘录 · 登记与取消订阅（无需写入文件）**

<<< ../snippets/09/src/runtime/events.ts#explain-subscribe

`subscribe` 返回的函数尚未执行。调用方先保存它，例如 `const unsubscribe = subscribe(display)`；以后执行 `unsubscribe()`，才会删除 display。返回函数能访问最初的 listeners 与 listener，这种“函数还记得创建时变量”的关系叫**闭包**。它让调用方不必自己持有整个集合。

这里 `Set` 用于保存不重复的函数。同一个函数对象登记两次，仍是一份订阅；重复调用取消订阅也不会报错。发送前用 `[...listeners]` 固定本次名单，所以在某个接收函数内部增删订阅，只影响下一次发送。本次已经进入名单的接收者仍会收到。

为什么每次传 `structuredClone(event)`？假设显示器误把 `callIds` 清空，记录器不能因此也收到空数组，循环内部的动作更不能被修改。只把外层对象展开一层，仍会共用内部数组；这里需要为每位接收者复制整份可复制数据。

#### 观察者报错，任务怎样处理

**讲解摘录 · 交出副本，并接住观察者错误（无需写入文件）**

<<< ../snippets/09/src/runtime/events.ts#explain-delivery

本篇选择：通知函数立即按订阅顺序调用，**不等待它们返回的异步工作**。某个显示回调抛错，不会导致工具任务失败；某个异步回调拒绝，也会被 `.catch` 接住，不留下未处理的 Promise 拒绝。空 catch 是有意隔离这个通知通道，不是所有错误都应吞掉。

因此，权限判断、完成验证、必须成功的磁盘保存不能放在这些观察者里。它们需要有返回结果、由运行流程等待的正式接口。异步观察者完成工作的先后也不保证与通知顺序相同；本章记录器同步 push，才会直接得到按 seq 排列的数组。

“不等待 Promise”不会让同步代码变成后台工作。回调若同步计算很久，仍会阻塞后面的步骤；本章观察者只做简单显示与收集。这个实现是本项目的通知策略，Pi 的等待策略不同，文末会明确比较。

### 3. 给同一次运行连续编号

假设已经收到两份报告，单凭 `seq=1` 与 `seq=2`，还不知道它们是否来自同一个任务。需要一个标识把这次运行的报告连起来；下次运行则换一个标识，编号重新从 1 开始。

在 `src/runtime/events.ts` 末尾追加：

<<< ../snippets/09/src/runtime/events.ts#reporter

调用 `createRunReporter(...)` 时，只创建一次 runId、一份通知通道和一个从 0 开始的计数。返回的函数记住这些变量。每调用这个返回函数一次，计数加一，再把本次内容与 runId、seq 合成一份 `RunEvent`。

`randomUUID()` 来自 Node 内置模块，这里用它生成运行身份，不安装额外包。[Node：randomUUID](https://nodejs.org/api/crypto.html#cryptorandomuuidoptions)

**报告器必须每次运行创建一份。** 若整个进程只共用一个，就会把不同任务放进同一个 runId。反过来，若每发一次通知都重新创建，又会失去一条轨迹内的连续编号。

这时整个 `events.ts` 已完成：通知通道负责登记和分发；报告器负责一次运行的身份与顺序。它没有保存 State，也没有保存 Trace 数组。后者由想记录过程的调用方自己决定。

### 4. 第一个可运行检查点

新建 `src/examples/inspect-events.ts`，写入完整代码：

先不运行 Agent，只检查通知通道：给同一通道登记记录、显示和故意出错三种接收者，手动发两份报告，观察取消显示订阅是否影响其他接收者。

**第 1 步：登记三个互不替代的接收者。** 在 `src/examples/inspect-events.ts` 中先写入以下内容：

<<< ../snippets/09/src/examples/inspect-events.ts#tutorial-part-1

trace 是入口自己持有的内存数组，显示只打印。故意抛错者是实验条件，用来检验隔离；它不属于正常业务要求。登记订阅不会自行发送通知。

**第 2 步：按顺序手动发送两份通知。** 在 `src/examples/inspect-events.ts` 末尾追加以下完整代码：

<<< ../snippets/09/src/examples/inspect-events.ts#tutorial-part-2

同一个 report 为这两份通知提供相同 runId 和连续 seq。第一次发送后取消显示，再发送第二次；只取消这一位订阅者，不清空 trace。

**第 3 步：核对通道行为。** 在 `src/examples/inspect-events.ts` 末尾追加以下完整代码：

<<< ../snippets/09/src/examples/inspect-events.ts#tutorial-part-3

trace 应有两项、编号为 1 -> 2，实时显示只有第一项。因为通知是手动发的，这还不能证明循环真的完成了任务，下一阶段才把发送位置接到实际运行。

```bash
npm run typecheck
node src/examples/inspect-events.ts
```

输出：

```text
实时通知（event）: 1 run-started
已保存通知（trace）: run-started -> run-ended
同一次运行（sameRun）: true
顺序编号（seq）: 1 -> 2
```

这个入口有三个接收者：trace.push 保存数据，console.log 显示数据，最后一个故意抛错。发完第一次报告后只取消显示订阅；因此第二份仍进入 trace，但不再打印为实时通知。故意抛错的接收者也没有阻断后面的代码。

这一步**没有运行 Agent Loop**。两份报告是入口手动发送的，所以它只能证明通知、编号和取消订阅可用，不能证明任务真的经历过开始和取消。接下来把发送位置接到循环内部，报告才对应真实运行事实。

## 阶段二：让循环报告实际过程

### 5. 先确定报告与状态更新的先后

把已有的两轮任务缩到消息变化上：

```text
初始化：              user                                  → 1 条
记录第一次 tools：    user, assistant                       → 2 条
写回两项读取：        user, assistant, tool, tool           → 4 条
记录第二次 finish：   user, assistant, tool, tool, assistant → 5 条
```

所以第 1 次 `decision-started` 报告输入 1 条消息，第 2 次报告输入 4 条；最终 `run-ended` 报告 2 次决策、5 条消息。这些值都应从实际变量取得，而不是写死在日志里。

特别注意两类通知：`decision-started`、`batch-started` 表示要开始某一步；`decision-recorded`、`results-recorded` 表示相应数据**已经写入**。把“收到临时值”和“确认写回”混成一类，会让取消时的日志产生误导。

### 6. 增加可选报告入口

修改 `src/runtime/agent-loop.ts`。保留第 8 篇原有导入，在顶部新增三项：

```ts
import { createRunReporter } from "./events.ts";
import type { EventListener } from "./events.ts";
import { measureContextBytes } from "./context-window.ts";
```

然后用下面类型完整替换原来的 `RunAgentOptions`：

<<< ../snippets/09/src/runtime/agent-loop.ts#options

新增 `onEvent` 是可选接收函数。旧入口不传它，仍能运行。输入字节数继续复用第 8 篇的测量：Context 转成 JSON 后的 UTF-8 字节数，**不是模型 token 数，也不包含适配器后来增加的全部协议内容**。

文件中的 `snapshot`、`failure`、`errorMessage` 三个原有辅助函数保留，不增加第二套相似工具。

### 7. 完整替换循环函数

下面仍是同一个 `runAgentLoop`，没有改成另一种框架。为了让替换位置明确、避免遗漏某个 return，**删除旧的整个 `runAgentLoop` 函数，再写入下面这个完整函数**。不要在文件末尾追加第二个同名函数。它较长，因为保留了前几篇已有的检查与停止分支；新增逻辑集中在报告器、统一退出函数和关键位置的 report。

<<< ../snippets/09/src/runtime/agent-loop.ts#loop

#### 先看一次正常调用怎样经过这些新增代码

下面从上方完整函数摘出关键位置，按一次正常任务往下走。**这些片段仅用于讲解，已包含在上方完整函数中，无需再次写入、追加或替换文件。**

**讲解摘录 · 创建本次状态与报告器（无需写入文件）**

<<< ../snippets/09/src/runtime/agent-loop.ts#explain-initialize

配置检查、批次执行器、输入构造器和运行控制器仍先准备好。这里的 State 初始只有用户任务，decisions 为 0。随后创建本次报告器；进入 try 后发第一份 run-started。

**讲解摘录 · 报告这次要问模型，再取得动作（无需写入文件）**

<<< ../snippets/09/src/runtime/agent-loop.ts#explain-decide

第一次 while 已经构造好 Context。进入 control.wait 的启动函数后，先报告第 1 次决策：decisions 还是 0，所以用 `state.decisions + 1`；输入只有原始任务，所以 inputMessages 为 1。随后检查是否停止，再调用 dependencies.decide。await 等到动作，复制后交给 action，继续原有的调用 ID 检查。

脚本此时提出两项读取请求。完整动作通过检查后，才走下面的记录语句：

**讲解摘录 · 先保存动作，再报告动作已记录（无需写入文件）**

<<< ../snippets/09/src/runtime/agent-loop.ts#explain-action

state 先变成新对象：decisions 从 0 变为 1，消息从一条 user 变为 user、assistant 两条。后面的 report 因而能报告“第 1 次动作已记录”，kind 是 tools，callIds 来自刚取得的两项调用。**先更新 state，再报告 decision-recorded。** 不能只发通知而不保存动作。

**讲解摘录 · 准备执行这一批读取（无需写入文件）**

<<< ../snippets/09/src/runtime/agent-loop.ts#explain-batch

这里的 calls 就是 source-1 与 tests-1 两项请求。report 发出批次准备通知，runBatch 仍按第 7 篇配置决定顺序或并行执行。await 接到整批结果后，results 按原请求顺序排列；后面的 check 确认这批结果还可以继续使用。此时它们仍是局部变量，还没进入 State。

**讲解摘录 · 先写回结果，再报告结果已记录（无需写入文件）**

<<< ../snippets/09/src/runtime/agent-loop.ts#explain-results

这次 state 更新保留原任务与计数，把 results 中两项分别包装为 tool 消息，再追加到历史。消息因此从 2 条变成 4 条。写回完成后才报告 results-recorded，调用 ID 与状态取自这两项实际结果，不是预设一份成功日志。

工具分支没有 return，因此回到 while。新 Context 从有 4 条消息的 State 构造，第二次 decision-started 便报告 4 条输入。脚本提出 finish，循环复用上面的动作记录语句，记录第 2 次动作；证据检查通过，调用内部的 finish，报告 completed，然后返回最终结果。

**使第二次决策知道源码与测试的，仍是 `state = ...` 写回和下一轮构造 Context；report 只把发生了什么告诉外部。**

#### 为什么把所有已知退出交给一个内部函数

**讲解摘录 · 统一报告并返回已知结果（无需写入文件）**

<<< ../snippets/09/src/runtime/agent-loop.ts#explain-finish

现在 finish 接收一个 Outcome，例如 `{ status: "completed", answer: ... }`，读取当时 state 的计数，发 `run-ended`，再返回 `{ state, outcome }`。

原来每个分支分别返回结果，现在统一从这里报告。输入限制、主动失败、验证拒绝、预算耗尽、取消和超时都如此。若遗漏其中一个出口，就可能出现“调用已经返回，记录器却一直以为还在运行”。

这个内部 finish 不是 Action 中的 `kind: "finish"`。Action 是决策方提出的完成请求；内部函数负责**报告并返回已经确定的退出结果**。完成请求仍须经过 validateFinish，才能形成 completed。名称相近，角色不同。

**讲解摘录 · 最外层 catch 内的停止与异常出口（无需写入文件）**

<<< ../snippets/09/src/runtime/agent-loop.ts#explain-stop

最外层 catch 保留原有停止原因优先的处理：已取消或超时就返回对应 Outcome。其他未预料异常先报告 `run-crashed` 再继续抛出，调用方应调查异常。配置错误发生在 run-started 之前，不会产生一条“开始后又结束”的轨迹。每次进入运行阶段后，正常出口的最后一份报告是 run-ended，未预料异常的最后一份是 run-crashed。

#### 为什么发完开始通知，还要再次 check

假设外部接到 `batch-started`，用户马上要求停止。接收者可以通过取消接口发出请求；它返回时，循环应该先发现停止，再决定是否调用工具。

**讲解摘录 · 通知之后，执行之前的停止检查（无需写入文件）**

<<< ../snippets/09/src/runtime/agent-loop.ts#explain-tool-gate

因此执行顺序是：`control.wait` 先检查 → 启动函数里 report → 再 `control.check()` → `runBatch(...)`。决策前也是一样。缺少通知后的检查，就可能在同步取消已经发生后仍启动依赖。记录动作后也检查一次，避免取消后继续验证或执行。

已经写回的事实不会被取消抹掉：若在 `results-recorded` 接收者里取消，State 保留两项结果；若在 `batch-started` 时取消，本章入口还没启动读取，State 只保留用户任务与请求动作。第 4 篇的等待保护仍阻止迟到结果恢复循环。

最终 run-ended 已经选定 Outcome，不再因为结束报告里的取消请求改写结果。它表示本次协议结果已确定；实例何时真正释放，要等后面外层 run 的 finally。

#### 并行完成顺序与本章轨迹顺序

工具可以先完成测试、后完成源码。本章不发“每个工具完成”的事件；它报告的是：整批关联已确认，并按原请求顺序写回。因此 `results-recorded.callIds` 稳定为 `source-1, tests-1`。

这份 Trace 能定位“停在决策还是批次”，但不能单凭它判断哪项工具耗时更久。若需要每工具耗时或实时进度，应在执行层增加对应事实报告，不能拿这份写回通知冒充每项实际完成时间。

这个文件仍是调度中心：组装输入、调用依赖、更新 State、决定出口。订阅集合与编号在 events.ts，工具调度在 tool-batch.ts，停止控制在 run-control.ts；循环只在自己知道事实发生的位置报告。

保存后先运行 `npm run typecheck`。此时旧示例没有订阅新通知，照常运行；接下来写一个接收入口，才会在终端看见新增事件。

### 8. 只管把报告显示清楚

已经有 `RunEvent` 数据。现在需要让它在终端里变成“第几次决策”“写回哪些调用”，而不是直接输出难读的对象。这是显示层的工作，不应把中文字符串拼接全部塞进循环。

新建 `src/examples/trace-printer.ts`，写入完整函数与导入：

<<< ../snippets/09/src/examples/trace-printer.ts

`switch` 根据 type 选择显示哪些字段。例如进入 `decision-started`，TypeScript 便知道 event 有 inputMessages；进入 `run-ended`，才读取 outcome。`break` 结束当前 case，避免继续输出下一种类型的日志。

这里没有状态保存或业务判断。`callIds.join(",")` 把调用 ID 显示在一行；finish 动作没有调用，空数组连接后是空字符串，因此显示“无”。如果以后改成网页进度条，只需增加另一位接收者，不必修改循环。

### 9. 在旧循环上观察完整轨迹

新建 `src/examples/inspect-trace.ts`，写入：

现在不再手动发通知，而是在原批次任务运行时收集真实报告。任务逻辑不变，本次只观察新增通知是否跟着实际步骤出现。

**第 1 步：准备原任务和空轨迹。** 在 `src/examples/inspect-trace.ts` 中先写入以下内容：

<<< ../snippets/09/src/examples/inspect-trace.ts#tutorial-part-1

注册工具、脚本与完成规则沿用第 7 篇。trace 初始为空，接下来只有收到通知时才会增加，不是由最终 State 自动生成。

**第 2 步：把记录与显示接到循环。** 在 `src/examples/inspect-trace.ts` 末尾追加以下完整代码：

<<< ../snippets/09/src/examples/inspect-trace.ts#tutorial-part-2

新增连接是 onEvent：同一份通知先放入 trace，再交给 printRunEvent 显示。这个回调没有执行工具或改写 State，运行步骤仍由原循环完成。

**第 3 步：检查报告顺序。** 在 `src/examples/inspect-trace.ts` 末尾追加以下完整代码：

<<< ../snippets/09/src/examples/inspect-trace.ts#tutorial-part-3

result 是运行结果，trace 是观察者收集的报告，两者来源不同。用最终退出原因对照轨迹末项，不能因为保存了某份通知就宣称工具结果已经写回。

如果换回第 5、6 篇的真实模型决策器，仍从相同的 decide 接口返回 Action，这些运行通知继续有效。模型正在输出的文字分片仍走适配器的进度回调；本章 decision-recorded 只报告完整动作通过检查并被记录之后的事实。这里先用脚本，让两次决策与轨迹能够稳定复现。

```bash
npm run typecheck
node src/examples/inspect-trace.ts
```

输出如下；原读取工具还会输出一行路径日志，保留它以区分执行器自己的显示与新增事件：

```text
事件（event）#1 run-started：运行开始
事件（event）#2 decision-started：第 1 次决策，输入消息=1，输入字节=94，有摘要=false
事件（event）#3 decision-recorded：动作=tools，调用=source-1,tests-1
事件（event）#4 batch-started：准备执行批次 source-1,tests-1
[执行工具 execute] read_source 文件路径（path）=src/sum.ts
事件（event）#5 results-recorded：已写回 source-1,tests-1，状态=ok,ok
事件（event）#6 decision-started：第 2 次决策，输入消息=4，输入字节=547，有摘要=false
事件（event）#7 decision-recorded：动作=finish，调用=无
事件（event）#8 run-ended：结果=completed，决策=2，消息=5
运行结果（outcome）: completed
轨迹顺序（trace）: run-started -> decision-started -> decision-recorded -> batch-started -> results-recorded -> decision-started -> decision-recorded -> run-ended
```

94 与 547 对应当前固定任务文字、固定源码和测试。改了文字或样本，字节数可以变化；1、4、5 条消息则对应本节走过的记录过程。这里没有配置裁剪，因此没有摘要。第 8 篇功能保留，旧的长日志入口仍可以单独运行。

## 阶段三：同一个实例，只允许一个任务在运行

### 10. 为什么有了函数，还需要一个对象

现在调用方可以连续写两次 `runAgentLoop(...)`。每次函数调用都会创建独立 State，这本身没有错；有两个独立任务时，当然可能需要两次运行。

问题出在界面想表达“这是同一个正在处理任务的助手”，用户却重复点击了发送。单靠一个函数，界面还得各自保存是否忙碌、取消控制器、订阅和最终结果。不同入口容易漏掉其中一项。

本节增加一个**运行实例**：应用创建的管理对象，负责记住当前是否有一次运行、怎样请求它停止、完成后保存什么结果。“重入”在这里指**上次还没结束，又在同一个对象上调用启动**。本篇直接拒绝，不自动排队；不同实例仍能独立运行。

这是引入 class 的具体理由：这些数据确实需要随对象跨方法调用保存。不是把原有每个函数都改成类，也不需要继承层次或先套设计模式。

### 11. 定义实例需要的配置

新建 `src/runtime/agent.ts`，先写：

<<< ../snippets/09/src/runtime/agent.ts#imports

构造对象时交给它依赖与额度，之后 `run(goal)` 只接本次任务文字。`run` 配置复用原有的超时、批次、输入选择选项。

`Omit<..., "signal" | "onEvent">` 表示从类型中去掉这两个配置。实例会创建自己的取消控制器，并把循环报告接到自己的订阅通道；不让调用方再同时塞入另一份信号或覆盖这条连接。它是 TypeScript 的配置约束，不是未知 JSON 的运行时校验。[TypeScript：Omit](https://www.typescriptlang.org/docs/handbook/utility-types.html#omittype-keys)

### 12. 保存实例数据，连接已有循环

在 `src/runtime/agent.ts` 末尾追加完整类：

<<< ../snippets/09/src/runtime/agent.ts#class

先辨认它保存的东西，再看调用过程：

| 字段 | 什么时候有值 | 具体意义 |
|---|---|---|
| dependencies、options | 创建实例时保存 | 用哪个决策器、执行器、完成规则，以及运行配置 |
| events | 创建实例时建立 | 保存这个对象的订阅者，不保存完整运行历史 |
| controller | 一次 run 开始后，finally 之前 | 当前运行的取消入口，同时表示实例正忙 |
| lastResult | 本次 run 得到结果后 | 这次完成或停止后的结果副本；再次启动前清空 |

`private` 表示这些字段不作为普通调用方的 TypeScript 接口公开。对外用 isRunning、result、subscribe、cancel、run；这里只封装实例管理，不把它当隔离恶意代码的沙盒。

#### 正常启动一次，怎样连到已有 Runtime

`new Agent(dependencies, options)` 只保存依赖和配置，还不调用模型。调用 `agent.run(goal)` 后，先看 isRunning。初次 controller 为空，可以启动；函数立即创建 controller 并保存，再清空上次结果。

**讲解摘录 · 连接原循环，保存并返回结果（无需写入文件）**

<<< ../snippets/09/src/runtime/agent.ts#explain-call

然后调用原 `runAgentLoop`。原有运行选项保留，但 signal 由本次 controller 提供，onEvent 接到实例的 events.emit。这里 events.emit 用闭包保存接收名单，不依赖 this，因此可以直接作为回调传递。循环每报告一次，实例已经登记的接收者就各收到一份副本。**实例不根据事件重建或修改 State。**

`await` 等待循环结果。循环成功返回或以 cancelled 等已知结果返回，局部 result 接住它；实例复制一份留在 lastResult，再把原结果返回给调用方。finally 清空 controller，isRunning 变为 false。

**讲解摘录 · run 方法最后的清理分支（无需写入文件）**

<<< ../snippets/09/src/runtime/agent.ts#explain-release

若配置错误使循环 Promise 拒绝，也会执行 finally。调用方拿到异常，实例不会永久卡在忙碌中；本次没有可用结果，result 属性保持 undefined。

#### 为什么忙碌标记必须在 await 之前保存

**讲解摘录 · 启动方法开头，先拒绝重复运行（无需写入文件）**

<<< ../snippets/09/src/runtime/agent.ts#explain-guard

同一段 JavaScript 会执行到第一个等待点才让出后续执行机会。如果先启动循环、等一会儿再记录 controller，第二次调用就可能看到“还没忙”，也进入循环。循环同步发出的 run-started 接收者甚至可能立即再次调用 run。

这里把 controller 写入放在调用循环之前。无论重复点击还是事件接收者里重复启动，第二次进入都会看到 isRunning=true，并得到拒绝的 Promise。它不会创建新 State、调用模型或发第二条开始通知。

`run` 是 async 函数，所以调用方用 `await` 和 try/catch 接这个错误。不要只调用它而忽略返回 Promise，否则拒绝可能没有人处理。

#### cancel 与结果副本分别解决什么

**讲解摘录 · 把停止请求交给本次控制器（无需写入文件）**

<<< ../snippets/09/src/runtime/agent.ts#explain-cancel

`cancel()` 调用本次 controller.abort。实例没有直接清空 State 或伪造最终结果；循环内部的运行控制器接到信号后，在等待或检查位置返回 cancelled。没有运行时 controller 为空，cancel 不做事情。工具已经产生的外部副作用仍不能靠 abort 回滚。

**讲解摘录 · 读取结束后的结果副本（无需写入文件）**

<<< ../snippets/09/src/runtime/agent.ts#explain-result

循环返回的 result 与实例保存的 lastResult 是不同对象；result getter 再复制一次，避免调用方通过 `agent.result.state.messages` 改掉实例留存记录。这里 isRunning 是运行管理状态，lastResult 是结束后快照；**正在运行时，完整 State 仍只在循环里更新，result 属性不是实时 State。**

同一个实例结束后可以再次 run，但当前每次都会创建全新的用户消息与历史。这是“重复使用管理对象”，不是沿用上一轮对话。会话续接和新输入队列留到后面实现。

这时 `agent.ts` 完成。真正控制流程的是 runAgentLoop；实例连接它的报告、掌握本次控制器、保存最终结果。将这些管理数据集中在对象里，是为了让界面调用方不用重复维护它们。

### 13. 先看没有故障装置的正常入口

新建 `src/examples/inspect-agent.ts`，写入完整代码：

这个入口只验证实例的正常生命周期：创建 Agent → 订阅 → 启动 → 查看忙碌 → 等待结束 → 查看结果。取消、重入和坏观察者都在后面的独立装置里，不混进这条路径。

**第 1 步：把原来的循环依赖交给实例。** 在 `src/examples/inspect-agent.ts` 中先写入以下内容：

<<< ../snippets/09/src/examples/inspect-agent.ts#tutorial-part-1

这里仍注册相同的两个工具，提供相同的脚本和证据规则。Agent 是新建的管理对象，此时没有运行任务；循环依赖没有被重新实现。

**第 2 步：先订阅，再启动但暂不等待。** 在 `src/examples/inspect-agent.ts` 末尾追加以下完整代码：

<<< ../snippets/09/src/examples/inspect-agent.ts#tutorial-part-2

pending 接住本次运行的 Promise，马上检查 isRunning。先不 await，才能在运行期间观察忙碌；这不是同时启动第二个任务。

**第 3 步：等待结束并核对结束快照。** 在 `src/examples/inspect-agent.ts` 末尾追加以下完整代码：

<<< ../snippets/09/src/examples/inspect-agent.ts#tutorial-part-3

await pending 后才能把实例当作本段运行已退出。unsubscribe 只移除显示接收者；result 是本次返回值，agent.result 是实例持有的结束副本。日志用于对照这两个时刻。

```bash
npm run typecheck
node src/examples/inspect-agent.ts
```

事件内容与上一阶段相同。开头在前两份通知之后会看见：

```text
实例忙碌（isRunning）: true
```

结尾是：

```text
运行结果（outcome）: completed
实例忙碌（isRunning）: false
保存结果（savedOutcome）: completed
```

`unsubscribe()` 只移除这位显示接收者，不撤销已经完成的运行，也不清空最终结果。若以后还要显示同一实例的下次运行，需要重新订阅；其他未取消的订阅会继续存在。

### 14. 把这些文件连起来

到这里再看本章新增名称的调用关系：

```text
inspect-agent.ts
  ├─ new Agent(已有的 decide / executeTool / validateFinish)
  ├─ agent.subscribe(printRunEvent)
  └─ agent.run(goal)
       ├─ 保存本次 controller，拒绝同一实例重入
       └─ runAgentLoop(..., { signal, onEvent: 实例的 events.emit })
            ├─ 仍按原流程构造 Context、决策、执行、写入 State
            └─ report(阶段报告)
                 └─ 本次报告器加上 runId 和 seq
                      └─ 实例通知通道
                           └─ printRunEvent(独立副本)

循环返回 RunResult → 实例保存副本 → 释放 controller → 调用方收到结果
```

实例和循环各有一份通道并不意味着有两条任务：内层报告器只给本次运行编号，外层实例通道把它送给对象上的订阅者。它们不各自再发一遍 run-started；正常轨迹仍是 8 份。

最后一条 run-ended 在循环返回之前发出。当它的接收者正在执行时，外层 run 还没走到 finally，isRunning 仍可能为 true，result 属性也还没写入。**需要启动下一次独立任务时，先 await 当前 run 返回。** 不在结束通知中直接启动下一次；输入排队会在第 10 篇明确设计。

## 阶段四：用轨迹判断到底在哪里停下

正常入口保留原样。另写一个故障入口，避免把模拟取消、抛错和正常使用混在一起。

### 15. 准备可控的故障入口

每次只选一种实验，不是让正常业务同时支持所有造错动作：

| 模式 | 刻意制造什么 | 主要观察什么 |
|---|---|---|
| reentry | 第一段尚未结束就再次 run | 第二次拒绝，第一次仍完成 |
| cancel | batch-started 时请求取消 | 工具未启动，不报告结果写回 |
| observer | 一位接收者修改自己的副本并异步失败 | 任务和其他记录者不受其破坏 |
| mismatch | 工具交回错误 callId | 不把错误关联写入 State |

本节是独立故障装置。先按表理解预期，再展开按三步创建文件；完整代码仍需创建，才能执行后面的命令。首次阅读不需要逐一追完其他模式的内部条件。

<details>
<summary>创建完整故障装置：准备实例 → 登记观察 → 启动与收尾</summary>

新建 `src/examples/inspect-agent-faults.ts`，先写下面这一步：

<<< ../snippets/09/src/examples/inspect-agent-faults.ts#setup

配置和场景与正常入口相同。唯一新增的执行包装是先等待 20 毫秒，方便观察忙碌期间的行为；delay 的 signal 继续使用循环传入的信号。这里没有新增工具业务实现。

`mode` 从命令行第二个参数取得，用来选择哪次实验。默认 normal；mismatch 时故意把结果的 callId 改错，检查错误关联不能进入历史。先定义完整实例，接下来的接收函数才能调用它的 cancel。

在文件末尾继续追加：

<<< ../snippets/09/src/examples/inspect-agent-faults.ts#observers

这一步有三种用途，逐个看：

- observer 模式先登记一位故障观察者。它破坏自己的报告副本，再返回拒绝的 Promise；用来验证后面的记录器与任务不会被它改坏。
- 正常记录器同步把报告放入 trace，显示器负责打印。两个取消订阅函数分别记住如何移除自己。
- 最后一位接收者仅在 cancel 模式下，于批次准备通知发生时调用 cancel；其他模式什么也不做。

最后追加运行部分：

<<< ../snippets/09/src/examples/inspect-agent-faults.ts#run

先启动一次任务并保存 pending。reentry 模式马上再启动第二次；try/catch 只接住第二次的拒绝，第一次 pending 仍在继续，随后单独等待它结束。

最后取消记录与显示的订阅，再打印已收集的编号和最终消息。这里“保存结果”从实例 getter 取得，“消息顺序”从第一次返回值取得，“轨迹条数”从入口自己的数组取得。三者来源不同，能互相核对，但不会自动替代彼此。

这个文件就是故障装置：设置模式 → 组装旧依赖与延时包装 → 登记观察者 → 启动并观察。它不属于 Runtime 核心，也不需要把这些 if 分支搬进业务入口。


</details>

### 16. 拒绝第二次启动，第一次仍正常完成

```bash
node src/examples/inspect-agent-faults.ts reentry
```

关键输出：

```text
实例忙碌（isRunning）: true
重复启动被拒绝（reentry）: Agent is already running
```

之后第一次任务仍 completed，轨迹 8 条，编号 1 到 8。没有第二个 run-started，也没有把“第二个任务”混进第一次的 State。它证明的是**同一对象的重复启动保护**；不是整个进程只能有一个任务。

### 17. 在执行前取消，不应该报告结果已写回

```bash
node src/examples/inspect-agent-faults.ts cancel
```

观察这条轨迹：

```text
#1 run-started
#2 decision-started
#3 decision-recorded
#4 batch-started
#5 run-ended → cancelled，决策 1，消息 2
```

上述是轨迹摘要，实际终端带中文字段。最终关键输出为：

```text
运行结果（outcome）: cancelled
实例忙碌（isRunning）: false
保存结果（savedOutcome）: cancelled
轨迹条数（events）: 5
顺序编号（seq）: 1 -> 2 -> 3 -> 4 -> 5
消息顺序（messages）: user -> assistant
```

在 batch-started 的回调里请求取消，返回循环后立刻 check，所以读取没有启动。assistant 中的请求已经记录，不能抹掉；工具结果还没出现，不能补造两条 tool，更不能发 results-recorded。

这与“工具运行一半再取消”不同。后者可能已有外部效果未知；本章只沿用之前的停止等待与迟到值保护，不声称能够撤销副作用。

### 18. 显示器坏了，不能破坏任务与其他记录器

```bash
node src/examples/inspect-agent-faults.ts observer
```

仍应 completed、8 份事件、编号 1 到 8，记录的调用身份保持 source-1 与 tests-1。故障观察者虽把自己的 seq 改成 -1，后面的记录器仍收到新副本。它异步抛出的错误被通知通道接住，也不会成为任务 Outcome。

这只能证明本篇选择的观察隔离策略。它不能证明观察日志永不丢失；如果记录器自己失败，任务仍可能成功。本章没有“日志必须持久保存才能继续”的保证。

### 19. 工具给错调用 ID，不能假报写回成功

```bash
node src/examples/inspect-agent-faults.ts mismatch
```

结果为 failed，source 为 execution；只有 5 份事件，最后是 run-ended。没有 results-recorded，最终仍只有 user 与 assistant 两条消息。

如果终端出现了读取路径日志，那仅说明执行器开始执行过；并不意味着它的返回值已经被 Runtime 接纳。批次执行器发现 callId 不匹配后拒绝整批，循环不能把未知归属的数据写入 State。这个场景正好说明“工具输出日志”和“运行确认写回事件”为什么要分开。

## 怎样沿轨迹调试，不靠猜测

先找到**最后一份可信报告**，再看下一步应该发生什么。不要一见 failed 就猜密钥问题，本章入口甚至不发网络请求。

| 看见的现象 | 先查哪里 | 暂停后看什么 |
|---|---|---|
| 一份事件也没有，run 拒绝 | 循环开头配置检查、调用方是否已订阅 | maxDecisions、timeoutMs，以及原异常 |
| 有 decision-started，迟迟没有 recorded | decide 调用与 run-control 等待边界 | 是否仍等待；是否已有停止信号 |
| decision-recorded 后停止 | 记录后的 check、动作分支 | action.kind，是否取消、主动 fail 或 finish |
| batch-started 后 failed，没有 results-recorded | tool-batch 返回或抛错处 | 原请求 ID、返回 callId、Outcome.source |
| results-recorded 后还出现重复读取 | 下一轮 Context 与脚本输入 | State 已有几条；Context 是否含本次工具结果 |
| 最终事件有了，回调里仍 isRunning=true | 外层实例 run 的 finally | 结束通知与实例释放的先后，不要删忙碌保护 |
| 记录器没收到，任务却完成 | subscribe 的时机和接收者本身 | 是否晚订阅、提前取消，或接收回调出错 |

可用 Node 内置调试入口，不增加依赖：

```bash
node --inspect-brk src/examples/inspect-agent.ts
```

用编辑器的 Node 附加调试功能连接，然后继续执行。在以下四处设断点，按一次正常任务观察：

1. `agent.ts` 的 `this.controller = controller`：此前为空，执行后 isRunning 为 true；还没有调用循环。
2. `agent-loop.ts` 写入 assistant 后的 report：第一次 decisions=1、messages.length=2，通知里的调用 ID 来自刚记录的动作。
3. `agent-loop.ts` 结果写回后的 report：messages.length=4；两项结果按请求顺序在 State 中，然后才报告已写回。
4. `agent.ts` 的 finally：循环结果已保存，清空 controller 后 isRunning=false；调用方 await 随后恢复。

不要把断点停顿时长当正常耗时。调试器暂停期间，现实时间仍在走，继续执行后可能触发超时。需要细看流程时，可临时把 inspect-agent.ts 的 timeoutMs 从 1000 改为 60000，观察结束后恢复 1000。[Node：调试器说明](https://nodejs.org/en/learn/getting-started/debugging)

### 一个小迁移：只显示结束，仍保存全部轨迹

只在 `inspect-agent-faults.ts` 的显示订阅处实验：把 `agent.subscribe(printRunEvent)` 改为一个接收函数，仅在 `event.type === "run-ended"` 时调用 printRunEvent；**不要改循环，也不要过滤记录器的 push。**

运行 normal 模式。应只显示一份最终事件日志，但 events 仍为 8，seq 仍为 1 到 8，消息仍为 5 条。其他入口自己的统计输出与旧工具的路径日志仍会出现。

这次迁移要区分“选择显示哪些报告”和“循环有没有生成报告”：显示层过滤，不能影响另一位接收者。实验完成恢复原显示订阅，再做最终检查。

## 再看 Pi：比较同一个问题

对照固定提交 `8efd314fa3d3232ce197d8d7a6a5660530b9d83e`，只读三个局部，不需要先看完整 Coding Agent。

首先看 [AgentEvent 类型](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/agent/src/types.ts#L474-L504)：它把运行、轮次、消息和工具过程分开报告。本篇先保留决策、批次与确认写回等较少类型；没有实现它的完整消息与工具事件粒度。

再看 [Agent 的 subscribe、prompt 与运行管理](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/agent/src/agent.ts)：订阅返回取消函数，prompt 在已有活动运行时拒绝，运行管理用 finally 完成清理。共同点是把调用方的观察与实例管理接到低层循环；本篇不复制它的完整会话结构。

最后看 [低层循环的事件输出](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/agent/src/agent-loop.ts#L95-L117)：循环从实际执行位置报告过程，而不是让界面猜进度。这也是本章把报告放在状态变化附近的依据。

**一个重要差别是订阅者的等待方式。** 该版本 Pi 明确等待订阅者，并将它们计入运行结束前的工作；本篇不等待异步观察者，且隔离其异常。因而本章策略不能用来承诺“所有观察者的保存工作都做完，run 才返回”。这是明确的项目取舍，不是 Pi 的等价实现。

另一个差别是状态：Pi 的 Agent 管理会话状态，本章 State 仍由一次循环独占，实例只保留结束结果。继续输入、暂停与持久化随后补齐。眼下先确认每条通知对应真实阶段，以及一个对象不同时启动两条运行。

## 完整最终文件

以下是本章新增或修改的 8 个文件，供完成分步实现后逐个核对。其余第 8 篇文件保留；没有需要补写的隐藏依赖。

### src/runtime/events.ts

<<< ../snippets/09/src/runtime/events.ts

### src/examples/inspect-events.ts

<<< ../snippets/09/src/examples/inspect-events.ts

### src/runtime/agent-loop.ts

<<< ../snippets/09/src/runtime/agent-loop.ts

### src/examples/trace-printer.ts

<<< ../snippets/09/src/examples/trace-printer.ts

### src/examples/inspect-trace.ts

<<< ../snippets/09/src/examples/inspect-trace.ts

### src/runtime/agent.ts

<<< ../snippets/09/src/runtime/agent.ts

### src/examples/inspect-agent.ts

<<< ../snippets/09/src/examples/inspect-agent.ts

### src/examples/inspect-agent-faults.ts

<<< ../snippets/09/src/examples/inspect-agent-faults.ts

## 最后检查与保存本章

恢复调试超时与显示过滤的实验改动，然后执行：

```bash
npm run check
node src/examples/inspect-events.ts
node src/examples/inspect-trace.ts
node src/examples/inspect-agent.ts
node src/examples/inspect-agent-faults.ts reentry
node src/examples/inspect-agent-faults.ts cancel
node src/examples/inspect-agent-faults.ts observer
node src/examples/inspect-agent-faults.ts mismatch
node src/examples/inspect-windowed-loop.ts
node src/examples/inspect-windowed-loop.ts small
node src/examples/inspect-batch-loop.ts parallel
node src/examples/inspect-stream.ts cut
DOCS_BASE=/ci/ npm run site:build
```

正常任务两轮完成、8 份报告；取消与关联错误不报告结果已写回；重复启动不产生第二次运行；观察者失败不篡改其他报告。第 8 篇输入限制、第 7 篇批次与第 6 篇断流仍按各章约定工作。这里的检查验证实现行为，不能替代对 State、通知与实例三者职责的理解。

完成上述检查后再复制以下命令。先核对分支和暂存范围；`src/` 是本章实现，`site/` 包含教程、参考代码、配图与导航。提交说明中的验证描述只在实际运行相应检查后使用。

```bash
git branch --show-current
git status --short
git add -- src/runtime/events.ts src/runtime/agent-loop.ts src/runtime/agent.ts src/examples/inspect-events.ts src/examples/trace-printer.ts src/examples/inspect-trace.ts src/examples/inspect-agent.ts src/examples/inspect-agent-faults.ts site/
git diff --cached --stat
git commit -F - <<'COMMIT'
第 09 篇：报告运行过程并管理运行实例

让调用方在任务结束前观察决策、工具批次和结果写回，并在同一运行实例上拒绝重复启动。

- 增加独立事件副本、运行身份、连续编号与取消订阅
- 在原循环的实际阶段报告过程，已知出口统一报告最终结果
- 增加实例启动、取消、忙碌状态与最终结果副本
- 提供正常观察和重复启动、取消、观察者故障、关联错误入口
- 同步课程正文、完整代码参考、配图与导航

验证：类型检查与现有环境检查、离线正常轨迹与故障场景、输入选择和批次及断流回归、网站构建。未执行真实模型调用。
COMMIT
git push -u origin codex/chapter-09-run-events
```
