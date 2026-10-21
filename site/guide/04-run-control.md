---
title: 第 04 篇｜停止、取消与时间边界
description: 区分次数耗尽、运行超时和外部取消，控制异步等待，将取消信号传给工具，并阻止迟到结果进入状态。
---

# 第 04 篇：任务等不回来，怎样结束这次运行

仍然是诊断 `sum([])` 的任务。第 3 篇已经能找到 read_source、检查参数并取得源码。如果这次读取一直没有返回，循环就停在 await 上：即使 maxDecisions 还有余额，也无法开始下一次决策，更到不了次数耗尽的出口。

本篇让这次运行能因**等待超时**或**外部取消**而结束，并保留停止前已经确认的记录。你会先独立控制一个不返回的 Promise，再接回现有 Runtime，观察三种不同结果：次数耗尽、超时、取消。最关键的判断是：**运行已经退出以后，迟到的工具结果还能不能改变状态？**

本篇实现真正的等待与提交控制。模型仍由脚本模拟，文件读取仍返回固定源码；新增的挂起和迟到示例用于稳定重现等待问题。尚未实现真实模型、进程强制终止、文件修改回滚或崩溃恢复。读完后，应能沿“输入 → 决策 → 工具 → 结果 → 写回”的链找到停止发生的位置，而不只记住几个状态名称。

## 本篇推荐分支

从第 3 篇已验证并提交的本地版本创建：

```bash
git switch -c codex/chapter-04-run-control
```

推荐分支名为 `codex/chapter-04-run-control`；若已存在，用 `git switch codex/chapter-04-run-control` 返回。以下命令在仓库根目录执行，无需安装新依赖。开始前用 `npm run typecheck` 确认上一章基线。

## 这次具体增加了什么能力

先分清四个情况。它们都可能让任务没有完成，但程序应该留下不同的事实：

| 运行中发生什么 | 本项目的结果 | 状态应保留什么 |
|---|---|---|
| 取得一次工具结果，但没有额度再次决策 | budget-exhausted，次数耗尽 | 已记录的请求和工具结果 |
| 决策或工具迟迟不返回，运行时间用完 | timed-out，运行超时 | 截止前已确认的记录 |
| 调用方主动请求停止 | cancelled，外部取消 | 停止前已确认的记录 |
| 工具正常返回 error | 仍作为工具观察进入下一轮 | 带调用 ID 的失败结果 |

最后一种仍使用第 3 篇的规则。工具报告错误，不代表用户取消，也不能仅凭错误文字含有 timeout 就宣告 Runtime 超时。本篇用本次控制器实际记录的停止原因分类。

**次数上限控制“还允许开始几次决策”，时间上限控制“这次运行还允许持续多久”。** 一次决策都没结束时，次数计数仍是 0；它完全可能在此超时。

### 在整个 Runtime 中的位置

[![第 4 篇控制关系：外部取消或运行计时器触发内部取消信号；等待入口停止等待，循环在记录前核对状态，工具可收到同一个信号](/diagrams/run-control-boundaries.svg)](/diagrams/run-control-boundaries.svg)

点击图片可单独打开。上半部分表示停止信号从哪里来，下半部分表示每轮运行中的两个等待位置；完成验证与预算出口省略。

本篇把等待控制放在新模块 run-control.ts。循环调用它来等待决策与工具，执行入口继续负责查找和参数检查。停止原因不放进模型 Context，控制器也不放进 State；State 继续保存本次任务已经取得的消息。

### 停止等待，与停止外部操作

假设工具正在读取远程仓库，用户点击取消。这里有三件事：

1. Runtime 不再一直等待工具结果，可以返回 cancelled。
2. Runtime 向工具传递停止信号，工具若支持取消，可以停止自己的请求并释放资源。
3. 工具忽略信号、稍后才返回时，Runtime 也不再将结果写进已经退出的状态。

本篇会实现这三个位置的连接，但只有工具及底层 API 配合，第二件事才会真正停止外部操作。Promise 没有通用的“杀死执行”按钮；让等待提前结束，也不会撤销工具此前写过的文件。

## 文件变化与本章契约

| 文件（均在 src/ 下） | 变化 | 职责 |
|---|---|---|
| runtime/run-control.ts | 新增 | 每次运行的截止时间、外部取消、等待保护与资源清理 |
| runtime/types.ts | 修改 | 增加停止结果，决策与执行依赖接收 signal |
| runtime/tool.ts | 修改 | 让 signal 经过工具入口到达执行体 |
| runtime/tool-executor.ts | 修改 | 将本次 signal 继续传递给工具 |
| runtime/agent-loop.ts | 修改 | 接入等待保护、停止出口与提交前检查 |
| examples/inspect-wait.ts | 新增 | 在不接入循环时观察等待超时 |
| examples/inspect-run-control.ts | 新增 | 观察正常、次数耗尽、超时、取消及迟到结果 |
| examples/inspect-tools.ts | 修改一行 | 直接调用执行器时传入 signal |
| examples/inspect-context.ts | 修改一行 | 迁移上一章的直接执行调用 |

请求、消息、Context 构造、读取规则和完成证据不变。first-loop.ts 仍能按原来的三个参数调用运行入口；新增的第四个配置参数可选，未配置 timeoutMs 就不启用时间上限。

本项目本章的选择是：timeoutMs 表示**一次运行累计时间**，不是每个步骤各有一份新时间；第一次记录的停止原因保留。停止时不伪造成功或失败的工具结果。真实外部操作究竟执行到了哪里，以后接入恢复机制时还要进一步表达。

## 第一阶段：先控制一次等待

先完成这个阶段，再修改任何已有接口。它只新增两个文件，不影响第 3 篇入口。

### 1. 定义运行配置与停止结果

新建 `src/runtime/run-control.ts`，先写以下类型：

<<< ../snippets/04/src/runtime/run-control.ts#contracts

本节只定义三类数据，还不会启动计时器或读取文件：

| 类型 | 当前场景中的对象 | 交给谁使用 |
|---|---|---|
| RunOptions | `{ timeoutMs: 30 }`，或带外部 signal 的配置 | 调用方交给本次运行 |
| StopOutcome | `{ status: "timed-out" }` 或 `{ status: "cancelled" }` | 循环用来说明为何停止 |
| RunControl | 包含 wait、check、outcome、dispose 的对象 | 循环用来管理这次运行 |

RunOptions 字段后的问号表示允许不配置。timeoutMs 的单位是毫秒；本章使用 30 方便观察模拟，不是实际模型请求的生产建议。

配置中的 signal 来自 AbortController。**controller 持有取消权，signal 供接收者观察取消。** 调用 controller.abort() 后，signal.aborted 变为 true，并通知监听者；把 signal 交给工具，不会同时把 controller 交出去。[Node.js：AbortController 与 AbortSignal](https://nodejs.org/api/globals.html#class-abortcontroller)

RunControl 的四项操作接下来才实现：wait 负责一次等待，check 判断当前能否继续，outcome 读取停止原因，dispose 清理资源。本节的类型声明只是约定，并没有创建这些函数。

### 2. 等待依赖或接收停止通知

继续在 `src/runtime/run-control.ts` 末尾追加完整辅助函数：

<<< ../snippets/04/src/runtime/run-control.ts#wait

#### 这个函数负责哪件事

waitForResult 接收“启动一次工作的方法”，返回一个可供调用方等待的 Promise。工作可能是请求决策，也可能是执行读取。**工作返回时，调用方取得结果；工作尚未返回但运行被取消时，调用方也能结束等待。**

先借用第 3 篇的读取说明参数。本节还没有调用它；实际的第一次运行在第 4 步。

| 参数 | 读取场景中表示什么 |
|---|---|
| start | 启动一次 executeTool 调用的函数；接收 signal，返回工具结果的 Promise |
| signal | 本次等待需要观察的停止信号 |
| check | 检查是否还能继续的函数；正常时返回，已经停止时抛错 |

T 表示成功结果的类型：等待读取时是 ToolResult，等待决策时是 Action。它让函数既能处理工具结果，也能处理决策动作，不把自己的返回类型写死成源码字符串。

#### 先辨认两份 Promise

代码中有两份主要的 Promise：

| 在哪里取得 | 代表什么 | 由什么结束 |
|---|---|---|
| `start(signal)` 的返回值 | 具体工作什么时候完成 | 工具或决策实现交出结果、报告失败 |
| `return new Promise<T>(...)` 创建的对象 | 调用方什么时候结束这次等待 | 工作结果，或本次停止通知 |

resolve 和 reject 是第二份 Promise 创建时提供的函数。这里用 resolve 交出结果，用 reject 使等待以失败结束。新建第二份 Promise，是为了让等待能够响应停止通知，而不必一直绑在底层工作的完成时间上。

#### 读取正常返回时，代码怎样运行

假设这次读取最终返回 `{ callId: "read-1", status: "ok", value: 源码 }`，按以下顺序看代码：

1. 开头的 check 确认本次还可继续。
2. addEventListener 登记 onAbort。这里只是约定“以后收到 abort 时调用它”，不会立刻执行 onAbort。
3. `start(signal)` 启动读取，取得工作本身的 Promise；then 登记成功和失败时分别执行的函数。登记回调不会在这里同步等待源码。
4. waitForResult 返回刚创建的等待 Promise。调用方可以 await 它；此时暂停的是调用方后续代码，读取仍在进行。
5. 读取成功后，成功回调的 value 接到那份 ToolResult。cleanup 移除本次监听，check 再确认可以继续，resolve(value) 将结果交给等待方。

因此 value 是工具交回的数据，resolve 是让调用方取得数据的函数，二者不是同一个对象。若本次等待的是决策，流程相同，value 换成一个 Action。then 的回调会在相应 Promise 的结果确定后异步运行。[MDN：then 的处理函数](https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Global_Objects/Promise/then)

#### 读取尚未完成时取消，会走哪里

此时读取的 Promise 尚未结束，但 signal 收到 abort。onAbort 被调用：先移除监听，再 reject(signal.reason)。调用方正在 await 的等待 Promise 因此失败，会进入自己的 catch；它不需要等读取交出源码。

如果读取稍后才成功，先前登记的成功回调仍可能运行。它仍会清理并检查，但不能让已经失败的等待 Promise 重新变为成功，调用方不会再收到一份成功结果。这里没有终止读取本身。[MDN：Promise 的状态与首次解决](https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Global_Objects/Promise/Promise)

#### 为什么还保留这些检查与异常分支

理解上面两条路径后，再看几处写法的作用：

- **传入 start 函数。** start 进入 waitForResult 后才被调用，所以可以先检查、再启动工作。如果直接传已调用函数的返回值，工作在检查之前就已开始。
- **成功回调再次 check。** 开始时允许执行，不代表结果回来时仍允许使用；取消或截止时间可能在中间发生。
- **then 的失败回调。** 工作自身失败时，也要结束等待；即使失败发生在取消之后，仍有处理函数接住它，不会重新进入循环。
- **外层 try/catch。** start 也可能在交回 Promise 之前就同步抛错，这条路径需要清理并 reject。成功回调内的 try/catch 则处理再次 check 抛出的中断。
- **各出口 cleanup。** once 只保证监听触发后移除；正常读取成功时没有触发 abort，也需要主动移除。cleanup 虽然写在 onAbort 前面，但它真正运行时 onAbort 已完成初始化。

本函数始终没有 State 参数，只能决定是否把结果交回。怎样禁止迟到结果写入状态，要在第 9 步结合循环的统一写回位置来看。

### 3. 合并外部取消与本次截止时间

在 `src/runtime/run-control.ts` 末尾追加完整创建函数：

<<< ../snippets/04/src/runtime/run-control.ts#create

#### 返回的 control 和内部变量分别是什么

上一步的辅助函数需要 signal 和 check。本函数创建它们，并把“等待、检查、读取原因、清理”四项操作组装为一个 RunControl 返回。

以 `createRunControl({ timeoutMs: 30 })` 为例，先辨认本次调用持有的对象：

| 名称 | 创建后保存什么 | 作用 |
|---|---|---|
| externalSignal | 未提供时为 undefined | 接收调用方的取消请求 |
| controller | 本次新建的内部 AbortController | 将超时或取消通知给当前等待和依赖 |
| deadline | 创建时的计时值再加 30 | 判断本次累计时间是否用完 |
| stopped | 初始为 undefined | 保存已经确认的停止原因 |
| timer | 本次 setTimeout 的返回值 | 清理时用来撤销计时器 |

返回的 control 对象中没有这些数据字段，只有四个函数。函数仍引用本次创建的内部变量，因此后续调用 control.check() 能读取同一份 stopped。第 9 步才会将这份 control 接入循环。

#### 一次没有停止的正常使用

创建时先检查 timeoutMs 的范围，再建立内部 controller、deadline 和计时器。返回对象的 wait 会把 start、内部 signal 和本次 check 交给上一步的 waitForResult；这是两个函数之间的连接位置。

每次 check 都调用 outcome。时间尚未用完且没有取消时，outcome 得到 undefined，check 正常返回，工作可以开始或结果可以继续使用。正常任务结束后，调用方执行 dispose，清掉计时器与外部监听。

创建 control 本身不发起决策、不执行工具，也不写入 State。只有后续调用 wait，才会执行传入的 start。

#### 外部取消怎样变成本次停止

假设调用方创建了自己的 controller，并将它的 signal 放进 options。这里将它命名为 externalSignal，以区别于本函数新建的内部信号。

调用方 abort → 外部 signal 通知 cancel → cancel 调用 stop，传入 `{ status: "cancelled" }` → stop 保存 stopped，并触发内部 controller.abort。上一步的等待函数收到的是内部信号，于是结束等待。

如果外部 signal 在创建前就已取消，代码直接调用 cancel，不再等待另一次通知。若 stopped 已有值，stop 立即返回；后来的事件不能覆盖已经记录的原因。

#### 时间用完怎样变成本次停止

计时器触发时，直接用 `{ status: "timed-out" }` 调用同一个 stop。后面的内部通知与外部取消共用一条路径，区别在于 stopped 保存的 status。

这解释了为什么要有内部 controller：即使调用方从未取消，本次时间用完也需要通知工作停止。只监听 externalSignal 无法完成这件事。deadline 在创建时只计算一次，因此多次 wait 共用整次运行的时间，不会每步重新获得 30 毫秒。

#### check、outcome 与 signal.reason 各做什么

outcome 返回停止原因；check 遇到这个原因就抛错，让当前代码离开。signal.reason 保存的是用于中断的 Error，文字为 `"Run stopped"`。**取消与超时的分类来自 stopped，不来自错误文字。** 循环如何接住这个中断，会在第 9 步展示。

stop(outcome) 的参数名也叫 outcome，但它接收的是一个停止结果对象；外面的 outcome() 则是读取状态的函数。判断含义时看它所在的位置与是否被调用，不能只看名字。

#### 时间精度、配置与清理的边界

计时器只能在运行环境有机会处理回调时触发，不能抢占同步代码。因此 outcome 还会比较当前计时值和 deadline：即使某段同步计算拖过截止时间，到了下一次检查也能发现。若代码一直同步死循环，本模块仍无法立即中断它，也不保证精确在第 30 毫秒结束。[Node.js：计时器调度](https://nodejs.org/api/timers.html#settimeoutcallback-delay-args)

配置仅接受 1 至 2147483647 的整数，超范围抛 RangeError，避免 Node 将不合范围的 delay 调整为很短的等待。这个错误发生在工作启动之前，属于错误配置。[Node.js：setTimeout 的 delay 范围](https://nodejs.org/api/timers.html#settimeoutcallback-delay-args)

dispose 只清除本模块建立的计时器和外部监听。它不回滚文件，也无法替忽略 signal 的工具关闭所有底层资源。第 9 步会用 finally 保证各个退出路径都执行它。

#### run-control.ts 写完后，把这些函数串起来

这个文件提供的是“一次运行的停止控制”，公开入口 createRunControl 接收 RunOptions，返回 control；并不接收目标、消息或 State。创建时保存截止时间、停止原因，连接外部取消；真正等待工作时，再通过返回的 wait 调用内部 waitForResult。

```text
调用方创建 control
  → wait(start)：检查能否开始，等待工作结果或停止通知
  → check / outcome：核对当前是否停止、取得停止原因
  → dispose：运行结束后清理本次计时器与外部监听
```

内部 stop 记录原因并发出信号，outcome 同时补做截止时间核对，check 将停止变成控制流异常；它们共同支撑 wait，而不是分别运行四个任务。下一阶段循环会使用这份对象决定能否继续保存结果。谁改写 State、返回 RunResult，仍由循环负责。

### 4. 第一次运行：决策一直不返回

新建 `src/examples/inspect-wait.ts`，写入完整入口：

<<< ../snippets/04/src/examples/inspect-wait.ts

运行：

```bash
npm run typecheck
node src/examples/inspect-wait.ts
```

预期输出：

```text
等待位置（stage）: 模拟决策一直不返回
停止原因（outcome）: timed-out
```

这次 start 是 `() => new Promise<never>(() => {})`。wait 调用它以后，得到一份一直没有结果的工作 Promise：内部函数没有调用 resolve 或 reject，所以它保持等待。never 描述本例没有正常返回值的类型，不是让程序挂起的指令。

30 毫秒的计时器仍在工作。它记录 timed-out，触发内部 abort，上一步的等待 Promise 因此失败。catch 读取停止原因并打印，finally 清理资源。这里没有 Context 或 State，也没有真实模型请求；先单独验证“工作不返回时，等待仍能结束”。

## 第二阶段：接回决策、工具与循环

这一阶段涉及多个接口，完成所有迁移后再做整项目类型检查。途中尚未传入 signal 的旧调用可能报参数数量错误，按位置补齐即可，不要将新参数删除来绕过迁移。

### 5. 更新运行结果与依赖接口

修改 `src/runtime/types.ts`，在文件顶部新增：

```ts
import type { StopOutcome } from "./run-control.ts";
```

用下面代码替换原 Outcome 和 RunResult 两个定义，其他类型保留：

<<< ../snippets/04/src/runtime/types.ts#outcomes

原先 RunResult 同时带最终 state 与 outcome，这个关系不变。例如取消时返回的形状是 `{ state: 停止前的记录, outcome: { status: "cancelled" } }`。新增 StopOutcome 只扩展退出原因，不清空消息，也不创建一条假的工具结果。

再用下面代码**替换整个 Dependencies 定义**：

<<< ../snippets/04/src/runtime/types.ts#dependencies

decide 接收本轮 Context 和本次 signal，正常返回 Action；executeTool 接收 ToolCall 和同一个 signal，正常返回 ToolResult。信号是函数参数，不会追加成模型消息。以后适配真实模型时，适配器可把它交给支持取消的网络 API。

validateFinish 仍然同步接收状态副本与答案、返回 boolean。本章没有把完成检查改成另一项异步等待；循环会在它返回后检查是否仍可继续。

scriptedDecide 可以继续只声明 context：当前脚本立即返回，不使用额外的 signal 实参。接口允许传入信号，并不等于每个实现都会响应它。需要持续请求外部服务的实现，应接收并向底层传递 signal。

### 6. 让取消信号走到工具体

修改 `src/runtime/tool.ts`。保留 ParseResult、ToolOutput，用下面两个类型替换原 Tool 和 ToolDefinition：

<<< ../snippets/04/src/runtime/tool.ts#callable

接着用下面完整函数替换原 defineTool：

<<< ../snippets/04/src/runtime/tool.ts#define

用读取参数 `{ path: "src/sum.ts" }` 看正常过程：invoke 先检查 signal，参数解析得到 parsed.value，再检查一次 signal，最后调用 `definition.execute(parsed.value, signal)`。本次正常读取仍返回固定 sourceCode，invoke 把它包装为成功输出。

这里两次检查分别位于“进入工具入口”和“准备开始具体操作”之前。throwIfAborted 在未取消时不做任何事，已取消时抛 signal.reason。如果检查函数期间触发了取消，第二次检查会阻止后面的 execute。[Node.js：throwIfAborted](https://nodejs.org/api/globals.html#abortsignalthrowifaborted)

execute 的第二个参数使具体工具也能收到信号，但检查不会自动终止已经开始的操作。read-source-tool.ts 的执行体返回固定字符串，没有持续请求可取消，所以仍可只声明 args；后续真实工具需要把 signal 继续交给支持取消的 API。

### 7. 执行入口继续传递信号

用下面完整文件替换 `src/runtime/tool-executor.ts`：

<<< ../snippets/04/src/runtime/tool-executor.ts

正常调用现在带两个实参：`executeTool(call, signal)`。call 仍表示读取请求，signal 表示这次运行的停止通知。执行器先检查信号，再按 call.name 查到工具，调用 `tool.invoke(call.arguments, signal)`，最后将输出包装成带原 callId 的 ToolResult。

如果在进入时已经取消，开头的 throwIfAborted 会抛错，不查找或启动工具。如果调用工具以后才响应取消并抛错，try 内的 catch 仍可能将它包装为 tool-error。下一步循环会先核对本次控制器是否停止，再决定能否把它当作普通观察。

所以本文件的新增职责是传递同一份 signal，没有变成停止原因的最终裁判。注册表仍只持有工具名称和入口，不保存每次运行的信号，也无需修改。

#### 传递 signal 后，工具文件的职责没有交换

tool.ts 仍定义 invoke 的共同检查顺序，现在把 signal 继续交给 execute；tool-executor.ts 仍按名称查找并包装 ToolResult，现在也把同一个 signal 传到 invoke。二者只是让停止通知经过已有调用链到达操作，不各自创建一份 Runtime 或停止计时器。

因此调用链如下，工具结果仍沿原路返回，再由循环判断此时能否写回：

```text
循环 → executeTool(call, signal)
  → invoke(arguments, signal) → execute(已确认参数, signal)
```

### 8. 迁移两个直接执行入口

`src/examples/inspect-tools.ts` 中，将原来的 `const result = await executeTool(item.call);` 替换为：

```ts
const result = await executeTool(item.call, new AbortController().signal);
```

`src/examples/inspect-context.ts` 中，将原来的 `const result = await executeTool(call);` 替换为：

```ts
const result = await executeTool(call, new AbortController().signal);
```

两个入口都直接调用 executeTool，所以现在各自提供一个新建、尚未取消的 signal。结果仍由本地 result 接住；inspect-tools 只打印它，inspect-context 则手动写入演示状态。

这里没有调用 abort，也没有创建 RunControl，因此没有新增取消演示或时间上限。它们只是适配新的执行器参数。正式运行的统一信号在下一步由循环提供。

### 9. 给循环增加等待与停止边界

在 `src/runtime/agent-loop.ts` 顶部、原导入之前新增：

```ts
import { createRunControl } from "./run-control.ts";
import type { RunOptions } from "./run-control.ts";
```

保留其余导入、snapshot、failure、errorMessage。用下面**整个函数**替换原 runAgentLoop，不是追加第二个同名函数。循环主体大部分沿用上一章，连续展示是为了保留 try/catch/finally 与函数的完整结构；先沿正常读取路径定位新增等待，再看停止分支。

<<< ../snippets/04/src/runtime/agent-loop.ts#run

#### 先定位三个对象

这个函数依然负责安排决策、执行、记录与退出。新增 control 管理等待，state 保存本次事实，最终返回值仍是 `{ state, outcome }`。

| 对象 | 从哪里来 | 在函数中保存什么 |
|---|---|---|
| control | 本次 createRunControl(options) | 等待、检查、读取停止原因和清理的方法 |
| state | 函数内部初始化，之后逐步更新 | goal、消息与决策次数 |
| action / result | 分别接住决策与工具返回值的副本 | 尚待分支处理或写回的数据 |

control 不替循环更新 state；wait 成功交回一个值，也不表示那一刻已经追加消息。

#### 正常完成一次读取

以三次额度、没有取消的原诊断为例，从 try 内的 while 开始读：

1. 循环先 check，然后从 state 构造 Context。调用 control.wait 时传入启动 decide 的函数，内部才真正执行 `dependencies.decide(context, signal)`。
2. 第一次动作是 tool。wait 成功后复制到 action，再检查一次；随后才把 action 记录为 assistant 消息，decisions 从 0 变为 1。
3. 工具分支用另一处 control.wait 发起 executeTool。读取成功后，result 接到带 read-1 的源码结果副本；check 通过，再核对 callId，最后追加 tool 消息。
4. 下一轮从更新后的 state 构造输入。脚本返回 finish，循环先记录动作，再验证答案，验证后 check，确认仍可继续才返回 completed。
5. 返回给调用方前，finally 先执行 dispose，移除本次计时器与监听。

正常路径仍是四条消息、两次决策。新增等待控制没有改变“结果写回后，再准备下一轮输入”的顺序。

#### 等待工具时取消

取消前，循环已记录 tool 动作，因此 state 中有 user、assistant。执行依赖尚未交回结果，当前停在第二处 control.wait。

内部 abort 使 wait 失败，进入紧邻工具调用的 catch。这里先看 control.outcome：若本次确已取消，就继续抛出，不创建 tool-error 观察。外层 catch 再读取停止结果，返回 `{ state, outcome: { status: "cancelled" } }`，finally 同样清理。

这个路径没有执行后面的 callId 核对与 tool 消息追加。即使底层工具稍后返回，也不会让这次已失败的等待重新交付结果；工具也没有拿到内部 state 的可变引用。**等待提前结束与循环集中写回这两项边界共同阻止迟到结果进入记录。**

#### 普通异常与取消为什么不能混在一起

若工具只是报告一次普通异常，而 control 没有停止，内部 catch 保持旧行为：构造带调用 ID 的 error 观察，让后续决策处理。如果删除 `if (control.outcome()) throw error;`，取消也会走这条普通错误路径，错误地追加 tool 消息。

反过来，也不能把每个异常都当作取消。外层 catch 只在控制器确有停止原因时返回它，没有原因就继续抛出。决定分类的是 control 的记录，不是 Error.name 或 message。

#### 为什么等待之后还检查

等待入口负责及时结束挂起的等待；循环中的 check 负责决定此刻能否记录动作、工具结果或完成结论。复制结果和同步完成检查也可能耗时，因此不能只依靠工作开始前的一次检查。

validateFinish 仍是同步函数，运行期间不能被计时器抢占；它返回后再核对截止时间。次数用完的出口也先 check：若这个边界已观察到停止，返回停止原因，否则才返回 budget-exhausted。这是本项目在当前边界采用的优先规则，不代表能还原外部事件的绝对先后。

finally 则保证成功、失败、超时和取消都执行同一份清理；放在某一个完成分支中会漏掉其他出口。

现在可以运行 `npm run typecheck`，再运行原有的三个入口：

```bash
node src/examples/first-loop.ts
node src/examples/inspect-tools.ts
node src/examples/inspect-context.ts
```

预期行为与第 3 篇一致：主任务 completed，两次决策；工具检查入口仍区分四种请求；Context 观察仍显示读取后多出 tool 消息。原主入口没有提供第四个参数，所以本次正常运行没有额外的时间上限。

### agent-loop.ts 与 run-control.ts 现在怎样合作

这次 runAgentLoop 创建一份 control 后，决策等待与工具等待都交给 control.wait；结果回来、准备记录时再 check。control 负责“还能不能继续”，循环负责“继续时记录什么”。

正常完成时，循环按原规则记录动作、验证答案并交回 RunResult；停止时，外层 catch 取得 control.outcome，连同停止前的 State 返回；无论从哪条路径退出，finally 都调用 dispose。控制器及其计时信息不成为 State 字段，也不会出现在模型 Context 中。

## 第三阶段：在同一个 Runtime 上观察退出位置

接下来新增一个观察入口，复用原来的诊断依赖。为了先跑正常路径，再观察停止，我们分两步构造同一个文件，最后保留一份完整入口。

### 10. 先观察正常与次数耗尽

新建 `src/examples/inspect-run-control.ts`，先写导入：

<<< ../snippets/04/src/examples/inspect-run-control.ts#imports

接着追加依赖组装和显示函数：

<<< ../snippets/04/src/examples/inspect-run-control.ts#shared

dependencies 是本例交给 Runtime 的能力集合：脚本决策、注册后的读取执行入口和完成规则都复用上一章。show 接收运行结束后的 RunResult，只打印它；它不会替循环决定状态或退出原因。goal 仍是同一份诊断任务。

再追加以下完整分支，作为本阶段的可运行结尾：

```ts
const mode = process.argv[2] ?? "normal";
if (mode === "normal" || mode === "budget") {
  show(await runAgentLoop(goal, dependencies, mode === "budget" ? 1 : 3));
} else if (mode === "timeout") {
  const hanging: Dependencies = {
    ...dependencies,
    decide: () => new Promise<never>(() => {}),
  };
  show(await runAgentLoop(goal, hanging, 3, { timeoutMs: 30 }));
} else if (mode === "cancel-before") {
  const controller = new AbortController();
  controller.abort();
  show(await runAgentLoop(goal, dependencies, 3, { signal: controller.signal }));
} else {
  throw new Error(`Unknown mode: ${mode}`);
}
```

process.argv[2] 是文件名后的第一个命令参数。比如命令末尾写 timeout，mode 就为 `"timeout"`；没有传入时使用 normal。各分支只改变一次运行的配置或依赖：

| 模式 | 传给同一个 runAgentLoop 的变化 | 要观察什么 |
|---|---|---|
| normal | 原依赖，额度 3 | 原来的读取与诊断仍完成 |
| budget | 原依赖，额度改为 1 | 有工具结果，但不能开始第二次决策 |
| timeout | 只将 decide 改为不返回，配置 30 毫秒 | 第一份动作尚未取得时如何停止 |
| cancel-before | 调用前先 abort，将 signal 放进第四个参数 | 依赖开始前能否拦住 |

timeout 使用对象展开保留原来的执行器与验证器，只覆盖 decide；不是另写一个 Runtime。cancel-before 中先调用 abort，后调用运行入口，所以它专门验证预先取消。

先运行：

```bash
npm run typecheck
node src/examples/inspect-run-control.ts normal
node src/examples/inspect-run-control.ts budget
node src/examples/inspect-run-control.ts timeout
node src/examples/inspect-run-control.ts cancel-before
```

normal 完成两次决策，消息为四条。其他三个模式的完整输出分别为：

**budget：工具结果已取得，只是没有额度再次决策。**

```text
[决策 decide] 消息角色（roles）=user
[执行工具 execute] read_source 文件路径（path）=src/sum.ts
运行结果（outcome）: budget-exhausted
决策次数（decisions）: 1
消息顺序（messages）: user -> assistant -> tool
```

这与超时不同：已有源码记录必须保留，不能因为工具成功就自动宣告整个任务完成。

**timeout：第一份决策结果尚未取得。**

```text
运行结果（outcome）: timed-out
决策次数（decisions）: 0
消息顺序（messages）: user
```

仍是 0 次决策，因为计数统计已取得并记录的动作，不是尝试发起的次数。模型替身一直挂起，尚无 assistant 或 tool 消息可保存。

**cancel-before：调用之前已经取消。**

```text
运行结果（outcome）: cancelled
决策次数（decisions）: 0
消息顺序（messages）: user
```

同样只有 user，但原因是外部取消。没有决策和执行日志，依赖没有启动。控制器初始化后，循环的第一次 check 就结束本次运行。

### 11. 再观察工具已开始、结果还没回来时取消

保留刚才的导入、dependencies、show 与 goal。将 `const mode = ...` 起至文件末尾的整个分支替换为下面连续代码。本步骤只扩展同一个观察入口，不修改 Runtime。

```ts
const mode = process.argv[2] ?? "normal";
if (mode === "normal" || mode === "budget") {
  show(await runAgentLoop(goal, dependencies, mode === "budget" ? 1 : 3));
} else if (mode === "timeout") {
  const hanging: Dependencies = {
    ...dependencies,
    decide: () => new Promise<never>(() => {}),
  };
  show(await runAgentLoop(goal, hanging, 3, { timeoutMs: 30 }));
} else if (mode === "cancel-before") {
  const controller = new AbortController();
  controller.abort();
  show(await runAgentLoop(goal, dependencies, 3, { signal: controller.signal }));
} else if (mode === "cancel-execution") {
  const controller = new AbortController();
  let deliver: ((result: ToolResult) => void) | undefined;
  let executionSignal: AbortSignal | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const delayed: Dependencies = {
    ...dependencies,
    executeTool: (_call, signal) => new Promise<ToolResult>((resolve) => {
      deliver = resolve;
      executionSignal = signal;
      console.log("等待位置（stage）: 工具已开始，但还没有结果");
      markStarted?.();
    }),
  };

  const running = runAgentLoop(goal, delayed, 3, { signal: controller.signal });

  // 等到工具确实开始，再取消，才能稳定观察执行中的停止行为。
  await started;
  controller.abort();

  const result = await running;
  show(result);
  console.log(`工具收到取消（aborted）: ${executionSignal?.aborted}`);

  // 故意模拟不配合取消的工具，运行退出以后才交出结果。
  deliver?.({ callId: sourceCallId, status: "ok", value: sourceCode });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  console.log(`迟到后消息数（messagesAfterLateResult）: ${result.state.messages.length}`);
} else {
  throw new Error(`Unknown mode: ${mode}`);
}
```

#### 本例要控制的三个时刻

前四个模式不变。cancel-execution 需要依次做到：确认工具已经开始 → 请求取消并取得 RunResult → 再交出迟到工具结果。为了精确控制这三个时刻，入口暂时替换 executeTool，循环和控制模块都不改。

先辨认这里的三个 Promise，避免把“开始通知”误认为“工具完成”：

| 名称或位置 | 表示什么 | 谁使它结束 |
|---|---|---|
| started | 工具是否已进入执行函数 | markStarted 发出开始通知 |
| executeTool 返回的 Promise | 工具结果何时准备好 | deliver 交出迟到 ToolResult |
| running | 整次 runAgentLoop 何时退出 | Runtime 返回最终 state 与 outcome |

markStarted 保存 started 创建时提供的 resolve；deliver 保存工具 Promise 创建时提供的 resolve。二者都是以后可以调用的函数，分别只控制各自那份 Promise。executionSignal 则保存工具实际收到的信号，供稍后显示。

#### 从启动到取消，逐步发生什么

1. `runAgentLoop(...)` 启动运行，返回的 Promise 存到 running。入口没有立即 await running，因此仍能继续安排取消。
2. `await started` 让入口暂停，等循环完成第一次决策并调用 delayed.executeTool。
3. 工具函数保存 deliver 和 executionSignal，打印开始日志，再调用 markStarted。开始通知完成，但工具结果的 Promise 仍没有结果。
4. 入口从 await started 恢复，调用 controller.abort，然后 await running。Runtime 的等待响应停止，交回 cancelled 的 RunResult；由本地 result 接住，show 打印。
5. 入口再调用 deliver，才让底层工具 Promise 交出源码。短计时器给迟到回调一次运行机会，随后检查 result.state 的消息数。

`?.()` 表示变量确实保存了函数时才调用。它没有把状态写入 Runtime；这些变量和通知只属于当前观察入口。

#### 为什么要先等开始通知

如果启动后立即 abort，可能发生的是决策期间取消，还没进入工具执行函数。await started 保证本例取消时工具已经开始，从而验证工具等待位置。故意把 deliver 放在 Runtime 返回之后，则是为了制造“不配合取消、结果迟到”的情况。

运行：

```bash
npm run typecheck
node src/examples/inspect-run-control.ts cancel-execution
```

预期输出：

```text
[决策 decide] 消息角色（roles）=user
等待位置（stage）: 工具已开始，但还没有结果
运行结果（outcome）: cancelled
决策次数（decisions）: 1
消息顺序（messages）: user -> assistant
工具收到取消（aborted）: true
迟到后消息数（messagesAfterLateResult）: 2
```

取消时已有一次读取动作，所以 decisions 是 1，State 含 user 与 assistant。但工具结果尚未取得，不能追加 tool 消息。`aborted: true` 表示工具收到停止信号；这个示例故意不响应它，稍后仍由 deliver 提交源码。

迟到结果返回后，消息数仍为 2。循环早已返回 cancelled，没有再次执行状态写回，也没有第二次 decide。末尾的短计时器只给迟到 Promise 的处理路径一次运行机会，不属于 Runtime 的超时机制。

这里验证的是“迟到结果不进入本次运行状态”。它没有证明外部工具没有继续操作，更没有证明此前修改的文件恢复了。正常返回的 State 也未被深度冻结；调用方自己修改返回对象不在这项保护范围内。

### 两个观察文件各自用来证明什么

inspect-wait.ts 只创建控制对象并等待一个不返回的工作，用来单独检查等待能够超时；它没有会话状态。inspect-run-control.ts 则调用同一个 runAgentLoop，show 只负责打印，mode 选择正常、耗尽、超时或取消；cancel-execution 分支用 started 与 deliver 控制开始和迟到时刻。

前者把问题缩小到 run-control.ts，后者检查它与循环接通后的状态边界。用于安排人工时刻的 Promise 属于观察入口，不需要复制到正式 Runtime 或普通业务入口里。

## 怎样调试：先找停止发生在哪一段

启动调试器时可以把模式放在文件名后面：

```bash
node --inspect-brk src/examples/inspect-run-control.ts cancel-execution
```

用第 3 篇的 Node 附加调试方法连接。调试 timeout 模式时，单步耗时本身可能超过 30 毫秒，可临时把它提高到 30000 再观察；实验后恢复为 30。不要在断点等待了几十秒后，将超时误判成工具代码出错。

| 可见症状 | 沿链先检查哪里 | 具体变量或边界 |
|---|---|---|
| 还有次数，但一直等着 | 当前在等 decide 还是 executeTool；是否配置时间或外部取消 | options、control.wait、deadline |
| 调用了 abort 却没有退出 | 外部 signal 是否传给了第四个参数；等待是否经过 control.wait | externalSignal、stopped、onAbort |
| Runtime 退出，工具还在运行 | 信号是否传到具体工具，底层操作是否支持取消 | executionSignal.aborted、execute 的 signal |
| cancelled 后仍出现 tool 消息 | 是否绕过统一写回、是否直接共享内部 State | await 之后的 check 与 State 赋值 |
| 普通异常被误报超时 | 是否靠错误文字分类，而非本次控制状态 | control.outcome 与原 error |

cancel-execution 模式建议按下列位置观察：先停在 delayed.executeTool，看到请求已被记录；再停在 controller.abort，看到外部取消；然后进入 stop、onAbort 和循环外层 catch；最后看到 cancelled 返回。迟到 deliver 之后，不能再走到循环中的 tool 消息追加。

终端 Ctrl+C 通常会终止整个进程，本章没有把操作系统信号接成 controller.abort，也没有图形取消按钮。这里用调用方手动调用 abort 精确观察取消语义，后续应用可以把同一动作连接到界面。

## 可逆故障实验

一次只做一项，完成后恢复，再提交本章代码。

### 等待工具超时，状态停在哪里

在 `src/examples/inspect-run-control.ts` 的 timeout 分支中，将 hanging 对象暂时改成下面完整对象：

```ts
const hanging: Dependencies = {
  ...dependencies,
  executeTool: () => new Promise<never>(() => {}),
};
```

保留下面带 timeoutMs 的调用，运行：

```bash
node src/examples/inspect-run-control.ts timeout
```

现在决策正常提出读取请求，挂起的是工具，输出应为：

```text
[决策 decide] 消息角色（roles）=user
运行结果（outcome）: timed-out
决策次数（decisions）: 1
消息顺序（messages）: user -> assistant
```

没有执行日志，因为替换的是完整执行依赖，不是注册工具内部读取体。State 保留已记录请求，但没有虚构工具观察。恢复 hanging.decide 的原版本。

### 错误文字不能冒充停止原因

仍在 timeout 分支中，暂时将 hanging 改成：

```ts
const hanging: Dependencies = {
  ...dependencies,
  async decide() { throw new Error("Run stopped"); },
};
```

运行同一命令，通常会在 30 毫秒前立刻失败，输出 failed、0 次决策、user。为排除慢机器实际用完时间的干扰，这个实验可将该分支 timeoutMs 暂时改为 30000。

原因是依赖抛错时 control 未记录停止，循环仍走原 decision 失败。文字与内部中断相同，不会自行变成 timed-out 或 cancelled。恢复 hanging.decide 为永不返回的 Promise，并恢复 timeoutMs 为 30。

### 不要在循环的普通工具 catch 中吞掉取消

观察第 9 步执行 catch 的首句 `if (control.outcome()) throw error;`。如果删除它，取消会先被包装成 tool-error，可能追加一条不该出现的 tool 消息，再到下一边界退出。可以在临时实验中删这一句，运行 cancel-execution 对比消息数；随后立即恢复。

这个实验的目的不是让所有异常都向外抛，而是确认**先识别本次停止，再处理普通工具错误**的顺序。正文最终版本保留这句，正常工具异常仍按上一章进入下一轮观察。

## 对照 Pi：取消权与信号传递

固定参考提交仍为 `8efd314fa3d3232ce197d8d7a6a5660530b9d83e`。Pi 的 [Agent.abort](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/agent/src/agent.ts#L322) 操作当前运行的控制器；[工具准备阶段](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/agent/src/agent-loop.ts#L708) 会检查信号，[executePreparedToolCall](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/agent/src/agent-loop.ts#L768) 将 signal 交给具体工具。

对照时只追踪取消权由谁持有、信号怎样到达工具、哪里决定不再继续。本章的 RunControl、累计 timeoutMs 和迟到结果提交规则是本项目设计，并非逐行复刻 Pi；不能从 Pi 使用 AbortSignal 推断它会强制终止任意不配合的工具。

## 完整最终文件

以下是本篇全部新增或修改文件。未列出的文件保持第 3 篇版本，尤其不要重新修改诊断常量、读取参数规则或 Context 构造。两个观察入口的阶段版本最终收敛为下面同一套代码。

### src/runtime/run-control.ts

<<< ../snippets/04/src/runtime/run-control.ts

### src/runtime/types.ts

<<< ../snippets/04/src/runtime/types.ts

### src/runtime/tool.ts

<<< ../snippets/04/src/runtime/tool.ts

### src/runtime/tool-executor.ts

<<< ../snippets/04/src/runtime/tool-executor.ts

### src/runtime/agent-loop.ts

<<< ../snippets/04/src/runtime/agent-loop.ts

### src/examples/inspect-wait.ts

<<< ../snippets/04/src/examples/inspect-wait.ts

### src/examples/inspect-run-control.ts

<<< ../snippets/04/src/examples/inspect-run-control.ts

### src/examples/inspect-tools.ts

<<< ../snippets/04/src/examples/inspect-tools.ts

### src/examples/inspect-context.ts

<<< ../snippets/04/src/examples/inspect-context.ts

## 本篇验收与提交

恢复故障实验及调试用的时间修改后，运行：

```bash
npm run typecheck
node src/examples/inspect-wait.ts
node src/examples/inspect-run-control.ts normal
node src/examples/inspect-run-control.ts budget
node src/examples/inspect-run-control.ts timeout
node src/examples/inspect-run-control.ts cancel-before
node src/examples/inspect-run-control.ts cancel-execution
node src/examples/first-loop.ts
node src/examples/inspect-tools.ts
node src/examples/inspect-context.ts
```

应能区分 completed、budget-exhausted、timed-out、cancelled；预先取消不调用依赖，工具等待时取消保留已记录请求，迟到结果不追加消息。原有诊断、工具参数检查和 Context 观察保持有效。检查配置错误时应抛 RangeError，而不是返回 timed-out。

本章让最小 Runtime 能受控地等待与退出，尚不具备生产部署所需的完整隔离与恢复能力。下一篇会将 scriptedDecide 所在的决策依赖换成真实模型适配，让模型根据消息和工具结果提出下一步；这套等待、取消与状态提交规则继续使用。

确认检查已实际运行、实验已恢复，核对分支与文件范围：

```bash
git branch --show-current
git status --short
git diff --stat
```

下面只暂存本章九个源码文件。git add 选择待提交内容，commit 保存本地版本，push 将本章分支发送到已配置的 origin：

提交同时包含本章源码和 `site/` 网站更新；推送章节分支后，还需将 Pull Request 合并到 main，Actions 才会发布网页。

```bash
git add -- src/runtime/run-control.ts src/runtime/types.ts src/runtime/tool.ts src/runtime/tool-executor.ts src/runtime/agent-loop.ts src/examples/inspect-wait.ts src/examples/inspect-run-control.ts src/examples/inspect-tools.ts src/examples/inspect-context.ts site/
git diff --cached --stat
git commit -F - <<'COMMIT'
第 04 篇：增加运行超时与外部取消控制

让运行在决策或工具持续等待时能够退出，并保留停止前已确认的记录。

- 新增每次运行独立的时间、取消与等待控制模块
- 将停止信号经执行入口传递至具体工具
- 在循环提交动作、工具结果和完成结果前检查停止状态
- 区分次数耗尽、超时、取消和普通工具失败
- 增加挂起、预先取消和迟到结果的观察入口

验证：类型检查与全部观察入口运行通过；原有工具和上下文行为保持有效；故障实验及临时时间修改已恢复。
COMMIT
git push -u origin codex/chapter-04-run-control
```

仅在上述验证与你实际结果相符时使用提交正文。网页内容可另行提交，无需混入本章实现提交。
