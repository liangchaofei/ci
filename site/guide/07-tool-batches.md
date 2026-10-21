---
title: 第 07 篇｜工具批次与有界并行
description: 一次决策可以提出多个独立读取；先预检，按配置调度，按调用身份归位结果，再由原循环整批写回。
---

# 第 07 篇：一次要读两份文件，怎样安排执行

前六篇已经能完成这样的过程：模型提出“读取源码”，Runtime 执行读取，把源码内容记下来，再交给模型继续判断。本篇仍然做同一个诊断任务，只是模型需要的材料多了一份。

用户现在要求：“看看 sum 的源码和已有测试，解释为什么空数组会报错，以及测试遗漏了什么。”模型可以在一次回复中提出两个请求：读取源码、读取测试。第 6 篇的实现只接收一个调用，遇到这种回复会拒绝。

本篇要让 Runtime 接住这两个请求，安排执行，把两份结果一起交给下一轮决策。先弄清这件事怎样发生，再看要改哪些文件。

## 先不看代码，走完一次任务

### 模型提出请求，还没有拿到文件

用户的任务开始时，State 中只有一条 user 消息，内容就是用户的要求。Runtime 从 State 构造 Context，调用 decide。本轮模型能看到要求，但还看不到两个文件的内容。

假设模型返回的意思是：

```text
我需要两份信息：
A：读取源码 src/sum.ts
B：读取测试 test/sum.test.ts
```

**这是请求，不是读取结果。** 真实模型通过接口返回请求，离线脚本通过固定对象返回请求；接下来的 Runtime 都要自己安排执行。不能因为模型提到了文件名，就认为它已经读过文件。

### Runtime 执行，再把结果记下来

这一条正常过程如下。先只关心两次读取都成功的情况：

```text
Runtime 收到 A、B 两个请求
       ↓
把“模型提出了 A、B”记为一条 assistant 消息
       ↓
安排两次读取，等待结果
       ↓
得到源码内容、测试内容
       ↓
把两份结果记为两条 tool 消息，写入 State
       ↓
从更新后的 State 构造 Context
       ↓
再次调用 decide
```

下一次模型输入中，就会包含这样的历史。下面是便于理解的文字展示，不是要追加到源码的消息对象：

```text
用户：解释空数组为什么报错，并看看测试遗漏了什么
模型：我要读取源码和测试
工具 A：这是源码……
工具 B：这是测试……
```

模型此时才有两份材料可以分析。在离线入口中，脚本检查这些材料后返回预设答案；在真实模型入口中，由模型生成本次答案。循环仍要调用应用提供的完成检查，不能仅凭“模型说完成了”就返回成功。

### 本篇扩大的是“执行工具”这一段

第 6 篇是“得到一个请求 → 执行一次 → 写回一份结果”。第 7 篇变成“得到一组请求 → 安排执行 → 写回对应的多份结果”。**执行之后仍然回到原循环，下一轮仍从最新 State 取得输入。**

先认识两个负责这段过程的文件：

| 文件 | 这次任务中做什么 |
|---|---|
| `tool-batch.ts` | 接收两个请求，调用已有执行器，等结果收齐后返回结果数组 |
| `agent-loop.ts` | 等待这个数组，把结果写入 State，然后开始下一轮决策 |

因此，批次执行器返回结果时，模型不会自动知道结果。还需要循环完成写回、重建 Context、再次调用 decide。后面修改循环时，我们会沿这条路径找到对应语句。

这一组由同一次决策提出的请求，称为**工具批次**。本篇先独立观察批次如何执行，再接入循环，最后让模型适配器能读写这种动作。读取仍返回固定数据，不读取真实磁盘，也不修改文件或运行测试。

顺序、并行、取消和流式响应，都会围绕这条过程逐步展开。完成后应能解释：两份读取谁来安排、结果由谁保存，以及模型下一轮为什么能看见它们。

## 推荐分支与前置版本

先完成并提交第 6 篇，再从该本地版本创建：

```bash
git switch -c codex/chapter-07-tool-batches
```

分支已存在时用 `git switch codex/chapter-07-tool-batches` 返回。所有命令都在仓库根目录执行，不新增依赖。先运行 `npm run typecheck` 和 `node src/examples/first-loop.ts` 确认基线。

::: info 验证范围
本篇参考实现在独立工程验证了类型、顺序与有界并行、结果乱序、取消与迟到、流式交错和模拟 HTTP 两轮反馈。离线入口输出可复现；真实 API 仍需本地有效密钥与账户，文中的模型轨迹是示意，不作为已联网验收的记录。
:::

## 先分清三个不同的顺序

### 多次调用为什么仍只算一次决策

假设模型一次提出：

```text
调用 0：source-1，read_source({ path: "src/sum.ts" })
调用 1：tests-1，read_tests({ path: "test/sum.test.ts" })
```

这里模型只回复了一次，所以这是 1 次决策。回复里包含两项读取请求，不会因此变成 2 次决策。循环记录这个有效动作时，decisions 从 0 加到 1；两份工具结果写回后，再问模型，才是第 2 次决策。

保留原有单调用形状，并新增批次动作：

```ts
// 数据形状示意，不需要现在追加到源码。
const action = {
  kind: "tools",
  calls: [
    { id: "source-1", name: "read_source", arguments: { path: "src/sum.ts" } },
    { id: "tests-1", name: "read_tests", arguments: { path: "test/sum.test.ts" } },
  ],
};
```

先看这份对象本身：kind 告诉循环“这是工具批次”，calls 保存两项请求。每项都有自己的 id、工具名称和参数。它只描述要做什么，创建这个对象不会启动读取。

这里的 kind:tools 是本项目给动作起的名字。DeepSeek 响应通过 assistant.tool_calls 表达请求，第三阶段才把接口数据转换成这份对象；接口的 tools 字段则是应用提供的工具说明清单。[DeepSeek：tool_calls 与调用参数](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/)

### 请求顺序、完成顺序、记录顺序

| 顺序 | 本例可能看到什么 | 本篇怎么处理 |
|---|---|---|
| 请求顺序 | source-1 → tests-1 | 由完整动作中的数组定义 |
| 完成顺序 | tests-1 → source-1 | 取决于执行，不能假定与请求相同 |
| 记录顺序 | source-1 → tests-1 | 本篇固定按请求顺序追加结果 |

为什么既有 ID，又有数组位置？source-1 回答“这是哪一次请求”，0 回答“它在本批中排第几项”。源码后返回，仍属于 source-1，也仍排第 0 项。我们既要核对结果带回的 callId，又要按原位置保存，不能只看谁先完成。

[![两项请求交给批次执行器，有限 worker 允许测试读取先完成，结果按原下标归位，原循环整批写入 State 后再决策](/diagrams/tool-batch-order.svg)](/diagrams/tool-batch-order.svg)

点击图片可放大。执行器内部的结果数组属于本批局部数据；最下方循环的赋值才更新会话。图中省略普通失败与完成验证分支。

### 什么情况适合并行，什么情况应该分轮

**顺序执行**是等第一项结束再启动第二项；**并行执行**在本篇指允许多个异步操作同时进行或等待，不是把 JavaScript 循环变成多个 CPU 线程。

两份已知路径的独立读取可以并行。读取源码后，才能根据内容确定要编辑哪个位置，则编辑依赖读取结果，应该先把读取观察交给下一次决策；把这两个动作放入同一批后设为顺序，并不会自动把第一项输出填入第二项参数。

本篇由应用配置 parallelSafeTools，只将已确认相互独立、适合重叠执行的工具名称放进去。mode 为 parallel 且本批所有工具都在清单里，才启用有界并行；否则整批退回顺序。**这是本地调度声明，不是文件访问权限或沙盒，也不是模型给自己授予执行权的参数。** 真实工具具有副作用时，不能只看名称就草率标为安全。

本实现每批最多 8 项，最多同时执行几项由 concurrency 配置。8 是本教程选择的边界，不是 DeepSeek 的通用上限；次数、时间与未来的 token 预算仍分别管理。

## 文件变化与三个阶段

这次要把同一个批次接通三个位置：先让工具执行器能处理一组请求，再让原循环使用它，最后让模型接口能传进、传出多项调用。

对应新增 9 个文件、修改 5 个文件。下面的表用于找文件；实际实现按三个阶段走，每个阶段都能独立运行。

| 阶段 | 文件 | 变化与职责 |
|---|---|---|
| 1 | `src/examples/batch-fixture.ts` | 新增：两份请求与测试片段固定数据 |
| 1 | `src/examples/read-tests-tool.ts` | 新增：检查并返回固定测试片段 |
| 1 | `src/runtime/tool-batch.ts` | 新增：批次预检、顺序或有界并行调度 |
| 1 | `src/examples/inspect-tool-batch.ts` | 新增：先独立观察完成顺序与返回顺序 |
| 2 | `src/runtime/types.ts` | 修改 Action，保留单调用并新增批次 |
| 2 | `src/runtime/action-tools.ts` | 新增：统一取得调用、收集历史 ID |
| 2 | `src/runtime/agent-loop.ts` | 修改：预检动作、等待整批、统一写回 |
| 2 | `src/examples/batch-scenario.ts` | 新增：离线决策、应用提示词与两份证据检查 |
| 2 | `src/examples/inspect-batch-loop.ts` | 新增：观察整条循环的成功、失败与取消 |
| 3 | `src/adapters/deepseek/protocol.ts` | 修改：转换与解码多个工具调用 |
| 3 | `src/adapters/deepseek/decider.ts` | 修改：检查单次与批次的历史调用 ID |
| 3 | `src/adapters/deepseek/stream-protocol.ts` | 修改：按调用 index 分别积累草稿 |
| 3 | `src/examples/inspect-batch-stream.ts` | 新增：离线观察两个调用片段交错到达 |
| 3 | `src/examples/deepseek-batch-agent.ts` | 新增：真实模型的批次诊断入口 |

表中 examples 文件用来准备任务、组装依赖或观察输出；核心执行安排在 tool-batch.ts 中。原来的工具注册、参数检查、HTTP 和 SSE 字节读取都继续使用，不需要为第二次读取另写一套。

## 第一阶段：先让两次读取得到有序结果

先解决最小的问题：给程序两项确定的读取请求，能否分别执行，并把对应结果交回来？这一阶段只增加四个文件，直接调用批次执行器。暂时没有模型决策、State 写回或下一轮循环，避免同时排查几个位置。

### 1. 准备本例的第二份读取与两项请求

新建 `src/examples/batch-fixture.ts`，写入完整内容：

<<< ../snippets/07/src/examples/batch-fixture.ts

batchCalls 就是开头那份“我要读取 A、B”的具体数据：第 0 项读取源码，第 1 项读取测试。source-1、tests-1 标识这两次请求；read_source、read_tests 则决定要找哪种工具。工具返回时，要带回对应的请求 ID。

testsCode 保存的是一条已有测试的文本，只检查正数数组，没有空数组情况。它会作为读取结果交给模型分析。这里不需要创建 test/sum.test.ts，也不要求编写单测。源码路径继续复用旧 sourcePath。

导出这些常量只是准备数据，还没有启动读取。真实模型接入后可以生成自己的调用 ID；固定 ID 只方便离线观察，不是 Runtime 要求的名字。

### 2. 定义只读取测试片段的工具

新建 `src/examples/read-tests-tool.ts`，先写导入与参数类型：

```ts
import { defineTool } from "../runtime/tool.ts";
import type { ParseResult } from "../runtime/tool.ts";
import { testsPath, testsCode } from "./batch-fixture.ts";

type ReadTestsArgs = { path: string };
```

追加完整检查函数：

<<< ../snippets/07/src/examples/read-tests-tool.ts#parser

这个函数回答“收到的参数能不能交给工具执行”。拿 `{ path: "test/sum.test.ts" }` 来看：它是对象、路径正好匹配、也没有多余字段，因此返回检查通过的参数。换成别的路径就返回失败，不会进入后面的 execute。

input 来自调用请求，不能只凭 TypeScript 类型相信它。代码先排除 null、数组和其他类型，再检查 path 及额外字段；本例只允许固定路径，不是任意文件读取工具。

再追加完整工具定义：

<<< ../snippets/07/src/examples/read-tests-tool.ts#definition

这就得到第二种可注册的工具 readTestsTool。模型通过说明和 parameters 了解怎样请求它；实际调用 invoke 时，仍先执行 parse，检查通过才执行 execute，并返回 testsCode。

read-tests-tool.ts 管的是“一次测试片段读取”。它不负责安排源码读取，也不保存运行历史。稍后的批次模块会通过第 3 篇已有的 executeTool 找到它；对这个工具来说，一次调用与以前没有区别。

### 3. 先定义批次配置与整批预检

新建 `src/runtime/tool-batch.ts`，先写导入：

```ts
import type { Dependencies, ToolCall, ToolResult } from "./types.ts";
```

接着写以下常量与配置类型：

<<< ../snippets/07/src/runtime/tool-batch.ts#contracts

这三个配置回答不同的问题：mode 决定是否尝试并行；concurrency 决定最多同时处理几项，默认 2；parallelSafeTools 列出应用确认可以并行的工具名称。默认 mode 仍是 sequential。

例如本批有两项请求、上限为 2，就可能同时等待两次读取。即使模型一次提出 8 项，也不能同时启动超过上限的数量。安全清单由组装 Runtime 的应用提供，不是模型写在参数中的自我声明。

继续追加完整预检函数：

<<< ../snippets/07/src/runtime/tool-batch.ts#validate

用 batchCalls 走一次：先确认确实有 1～8 项请求，再检查 source-1 的 ID、名称和参数对象，把 source-1 记进 seen；接着检查 tests-1。两个 ID 不重复，函数正常结束，后面才可以开始执行。

如果第二项也写成 source-1，seen 已经有它，函数就抛错。**此时第一项也还没有执行。** 这就是先检查完整批次的用途：避免已经做了一半，才发现请求根本无法区分。previousIds 用来放本次运行此前用过的 ID，接入循环时会提供；直接观察这批请求时可以为空。

这个检查不判断工具是否注册，也不判断 path 是否允许。那是原执行入口和各工具 parse 的工作，批次模块继续复用它们。

### 4. 增加有限数量的执行者

继续在 `tool-batch.ts` 末尾追加完整创建函数：

<<< ../snippets/07/src/runtime/tool-batch.ts#runner

#### 先看它接收什么、交回什么

已有 executeTool 一次只能执行一个请求。本函数接收这个执行能力，创建一个名为 runBatch 的函数；runBatch 才负责把一组请求分别交给 executeTool。

创建和执行是两个时刻：调用 createToolBatchRunner 时，只检查配置、保存安全清单；随后调用 `runBatch(batchCalls, signal)`，才开始检查和执行本批请求。完成后返回两项 ToolResult，顺序与 batchCalls 一致。

#### 用两次读取走一遍

假设 mode 为 parallel，两种工具都在安全清单，concurrency 为 2。函数复制请求，得到 requests；然后创建一个能放两项结果的 results 数组，nextIndex 从 0 开始。

worker 是函数内部负责“取一项、等待执行、存好结果”的异步函数，不是新建 CPU 线程。这里启动两个 worker：

```text
第一个 worker 取到 index 0，call 是 source-1
    → 调用 executeTool，等待源码内容

第二个 worker 取到 index 1，call 是 tests-1
    → 调用 executeTool，等待测试内容

测试先返回
    → 核对 callId 是 tests-1
    → 写入 results[1]

源码后返回
    → 核对 callId 是 source-1
    → 写入 results[0]

两个 worker 都结束
    → 返回 [源码结果, 测试结果]
```

关键就是 `results[index] = result`：保存到领取请求时的位置。若改用 push，测试先完成就会排在源码前面，“完成先后”便被误当成“请求顺序”。callId 检查则进一步确认，返回值确实属于这个位置上的请求。

这个 results 还是函数内部数组。**写入 results[1] 没有更新 State。** 第一阶段入口只打印它；第二阶段才由 agent-loop.ts 接住整个数组并写入历史。

#### 为什么有 worker，而不直接全部启动

设有 6 项请求，上限仍为 2。前两个 worker 各领取一项；某个 worker 完成后，再回来领取下一项。因此可以一直处理整批，但最多只有两项正在执行或等待。

nextIndex 表示下一项的位置。读取它并加一之间没有 await，所以当前这段 JavaScript 会先完成领取，再在等待工具时让出执行机会。另一个 worker 不会领取同一个下标。

Promise.all 等待的是这几个 worker 全部结束。若一开始就把 6 次 executeTool 全部调用，再把 Promise 交给 Promise.all，6 次操作已经启动，Promise.all 本身并不会替我们限制数量。[MDN：Promise.all 的等待与拒绝行为](https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Global_Objects/Promise/all)

若 mode 为 sequential，或者本批有工具不在安全清单，workerCount 就是 1。同一套领取与保存代码自然变成“等前一项结束，再做下一项”，不需要另写第二种执行器。

#### 再看失败：工具没读到，与结果认错请求

工具抛出普通异常时，catch 会造出带原 call.id 的 error 结果。例如测试读取失败，结果仍写明“tests-1 失败了”。另一份独立读取可以继续，后续决策也能知道哪项失败；这里不自动重试。

如果拿到的结果却带 wrong-id，就不知道它属于谁，不能当成 tests-1 的观察。代码把错误存入 fatal，阻止 worker 继续领取新项；等已启动的 worker 结束后抛错，不返回本批结果。fatal 在这里就是“本批已发现关联错误”的标记。

已经启动的工具未必能立即停下。若它一直不返回，接回 Runtime 后，要靠原时间或取消边界结束调用方的等待；这个函数不能强制终止任意 Promise。取消检查会让已取消的执行停止继续领取或接受结果。

#### 这个文件在整条过程中负责哪一段

调用方给出请求清单和单项执行器；validateToolBatch 先查身份与形状，runBatch 再安排执行，最后交回有序的结果数组。模型响应的解析、State 写回和下一轮决策都不在这里。

请求会先复制，单项执行器得到的也是副本。这样它修改自己的参数对象时，不会顺便改掉调度器保存的请求身份。

### 5. 第一次运行：完成先后变化，返回顺序不变

新建 `src/examples/inspect-tool-batch.ts`，写入完整入口：

<<< ../snippets/07/src/examples/inspect-tool-batch.ts

这个入口注册两种工具，创建原 executeTool，再用它创建 runBatch。包装函数只增加开始、完成日志，并在源码读取前等待 20 毫秒，让另一项能够先完成；延迟不是 Runtime 的固定策略。

先运行顺序模式：

```bash
npm run typecheck
node src/examples/inspect-tool-batch.ts sequential
```

应依次看到 source-1 开始、完成，再是 tests-1 开始、完成。最后输出：

```text
返回结果顺序（callIds）: source-1 -> tests-1
```

再运行：

```bash
node src/examples/inspect-tool-batch.ts parallel
```

应看到：

```text
开始调用（start）: source-1
开始调用（start）: tests-1
完成调用（end）: tests-1
[执行工具 execute] read_source 文件路径（path）=src/sum.ts
完成调用（end）: source-1
返回结果顺序（callIds）: source-1 -> tests-1
```

两次输出的结果顺序相同，开始与完成轨迹不同。本例不比较精确耗时，也不以一段 20 毫秒延迟证明生产性能提升。

inspect-tool-batch.ts 直接调用批次模块，用固定请求观察调度；这里还没有 State、决策次数或下一轮模型调用。下一阶段才把同一 runBatch 接到循环，不再另写一套调度。

## 第二阶段：把一批请求作为一次动作接回循环

现在已能把两个请求变成两份结果，但刚才是入口直接调用 runBatch，没有模型提出动作，也没有会话历史。接下来只补连接：让 decide 返回这两个请求，让原循环调用 runBatch，再把结果交给下一轮 decide。

### 6. 扩展 Action，保留已有单调用

在 `src/runtime/types.ts` 中，用下面整段替换 Action，其他类型保持不变：

<<< ../snippets/07/src/runtime/types.ts#actions

先解决“模型怎样把两项请求交给循环”。以前 kind 为 tool 时只有 call；现在 kind 为 tools 时可以带 calls 数组。它仍是一份 Action，只是包含两项工作，所以记录时是一条 assistant 消息，决策次数也只加 1。

旧 tool 分支保留，前面的单调用入口不用重写。finish、fail 也保持原样。这里改变的是动作能够表达多少项请求；真正执行每一项时，仍使用原 Dependencies.executeTool。

### 7. 统一取得调用与历史 ID

新建 `src/runtime/action-tools.ts`，写入完整内容：

<<< ../snippets/07/src/runtime/action-tools.ts

循环接下来要把请求交给 runBatch，而 runBatch 总是需要数组。toolCallsOf 做的就是这点转换：旧 tool 动作变成 `[action.call]`；新 tools 动作直接取 action.calls；finish 或 fail 则没有工具请求，返回空数组。这样后面的执行代码不必分写“一个”和“多个”两条路径。

previousToolCallIds 则解决另一件事：新请求是否用了历史中的旧 ID。它从 assistant 消息取出此前请求，把 ID 汇成一个列表，交给 validateToolBatch。flatMap 表示把每条消息产生的小列表合成一个列表。再次读取同名工具可以，但必须是新调用身份。

这个文件只有两个读取辅助函数，不执行工具，也不保存消息。toolCallsOf 返回的数组没有额外复制；对数据副本的保护仍由循环和批次执行器完成。

### 8. 让循环等待整批，并一次写回

修改 `src/runtime/agent-loop.ts`。用下面整段替换顶部导入；snapshot、failure、errorMessage 三个辅助函数保留原样：

```ts
import { createToolBatchRunner, validateToolBatch } from "./tool-batch.ts";
import type { ToolBatchOptions } from "./tool-batch.ts";
import { toolCallsOf, previousToolCallIds } from "./action-tools.ts";
import { createRunControl } from "./run-control.ts";
import type { RunOptions } from "./run-control.ts";
import { buildDecisionContext } from "./context.ts";
import type {
  Action,
  Dependencies,
  Outcome,
  RunResult,
  State,
  ToolResult,
} from "./types.ts";
```

在辅助函数之后、runAgentLoop 之前新增配置类型：

<<< ../snippets/07/src/runtime/agent-loop.ts#options

RunAgentOptions 将原时间与取消配置同工具调度配置组合，旧调用方不提供 toolExecution 时仍按顺序执行。RunControl 只管停止，不需要因此增加工作队列字段。

再用下面完整函数替换旧 runAgentLoop；不要在文件中保留两个同名函数：

<<< ../snippets/07/src/runtime/agent-loop.ts#run

#### 先把新的调用接到旧循环上

创建函数开始时，新增 `const runBatch = createToolBatchRunner(...)`。它保存执行配置，准备好“一次执行一组”的函数，还没有读取文件。原 control 继续负责时间和取消，两者各做原来的事情。

然后沿离线例子的正常过程读 while：

1. 第一次 decide 收到只有 user 消息的 Context，返回含 source-1、tests-1 的 tools 动作。
2. toolCallsOf 取出两项请求，validateToolBatch 检查它们与历史 ID。通过后，循环记录一条 assistant 消息，decisions 变为 1。
3. 这次不是 fail，也不是 finish，继续到工具执行位置。
4. 循环通过 `control.wait((signal) => runBatch(calls, signal))` 等待两次读取，返回的数组由 results 接住。
5. control.check 确认仍可继续，然后下面的 state 赋值把两份结果追加为 tool 消息。
6. 本轮末尾没有 return，于是回到 while 条件。额度仍够，就从新 state 构造 Context，再调用 decide。

两份结果进入下一轮，靠的是第 5、6 步接在一起：**先保存，再重新构造输入，再次调用。** 不是 runBatch 返回后模型自动收到了数据，也不是执行器自己调用 decide。

#### 写回前后，消息到底变了什么

| 时刻 | decisions | State 中消息 |
|---|---:|---|
| 初始 | 0 | user |
| 两个请求检查通过，记下一份动作 | 1 | user → assistant |
| 测试返回，源码还在等 | 1 | 仍为 user → assistant |
| results 已接到整批结果，检查可继续并写回 | 1 | user → assistant → tool → tool |
| 下一次 decide 返回答案，记录 finish 动作 | 2 | user → assistant → tool → tool → assistant |

拿到数组之后，`results.map(...)` 为每份结果创建一条 tool 消息。新的 messages 把旧消息和这两条消息放在一起，再赋给 state。这条赋值才是会话真正发生变化的位置；`"tool" as const` 只是让类型检查保留精确的角色名称。

下一次 buildDecisionContext(state) 会复制到新增的 tool 消息。这解释了为什么只在控制台打印源码不够：控制台输出不是下一轮的输入，State 中保存的消息才是构造输入的来源。

#### 为什么只写回一次整批结果

本篇选择等本批结束后再一起保存。例如测试已读完、源码还在等时取消，runBatch 没有把可用的整批结果交给循环，后面的 state 赋值便不执行。返回状态保留这次 assistant 请求，但没有本批的两条 tool 消息；之前的历史仍保留。

这只规定内存里怎样记历史，不代表读取没发生，更不代表能撤销外部写入。若以后换成写文件工具，可能已经改过文件，却还没取得可确认的结果；恢复时要单独处理，不能直接盲目重放。本篇先用独立读取观察这条边界。

#### 失败时，停在刚才哪一步

若测试读取抛普通异常，runBatch 把它转换为带 tests-1 的 error 观察。它与源码结果一起返回，循环仍能写回两条 tool 消息；下一次 decide 根据失败信息判断怎么办。

若某份结果的 callId 错配，runBatch 抛错，循环在执行处的 catch 返回 execution 失败。流程到不了写回语句，也不会再问模型。取消或超时则先交给 control.outcome，沿第 4 篇的停止出口返回，不伪装成普通工具错误。

预检也有自己的时机：两个请求在记录动作前就检查，重复 ID 或空批次会停在那里，工具还没启动，decisions 也不会增加。

#### 两个文件怎样接起来

agent-loop.ts 拥有 State，并决定何时开始下一轮；tool-batch.ts 只把请求变成结果数组。因此调度细节增加了，整个系统仍只有原来这一条 Agent Loop。完成、失败、取消和 finally 清理都继续由循环安排。

### 9. 定义两份读取证据与本例决策

循环已经会执行批次。现在给它提供一个可预测的决策器：第一次提出两个读取请求，第二次根据已保存的结果回答。另一个完成检查要核对两份材料，避免只读到源码就接受答案。

新建 `src/examples/batch-scenario.ts`，先写顶部导入：

```ts
import type { Action, DecisionContext, Message, State, ToolCall } from "../runtime/types.ts";
import { toolCallsOf } from "../runtime/action-tools.ts";
import { sourcePath, sourceCode, diagnosis } from "./diagnosis-fixture.ts";
import { testsPath, testsCode, batchCalls } from "./batch-fixture.ts";
```

接着追加完整证据查找函数：

<<< ../snippets/07/src/examples/batch-scenario.ts#evidence

hasBothReads 要回答的是“历史中确实保存了这两份读取结果吗”。它从头查看 messages。遇到 assistant 消息，就把其中的请求按 ID 放入 requests；遇到成功的 tool 消息，就用 result.callId 找回那次请求。

例如碰到 tests-1 的结果，先找到对应 read_tests 请求，再核对请求路径和返回内容。都匹配，才在 verified 里记下“测试已读到”。源码也这样检查，最后要求两种材料都存在。requests 用于找请求，verified 用于记住已确认的材料；这两个集合都只是本次检查的局部变量。

为什么不直接取最后两条消息？因为模型也可能分两轮读取，或者历史里夹着其他消息。通过 ID 找回请求，不必猜结果的位置；这也能让真实模型分轮读取时继续使用同一完成规则。

继续追加提示词、完成规则与脚本决策：

<<< ../snippets/07/src/examples/batch-scenario.ts#application

先看 scriptedBatchDecide 的两次调用。第一次 Context 只有 user，函数返回含 batchCalls 的 tools 动作。这只是把读取请求交给循环，并未在函数里读取文件。循环执行并写回后再次调用它，hasBothReads 才能从 Context 的消息中找到两份材料，于是返回带预设 diagnosis 的 finish。缺少成功材料，就返回 fail。

这里故意用固定答案，方便只观察批次和反馈是否正确。它不能分析任意源码，换成真实模型时也不会继续用这份预设答案。

hasBatchEvidence 在循环收到 finish 后使用，要求答案非空且两份读取证据齐全；它不判断诊断文字本身是否正确。batchPrompt 则是下一阶段给真实模型的任务说明，当前脚本不会调用它。

因此，batch-scenario.ts 提供“这次任务怎样提出请求、怎样检查材料”的规则；安排执行和保存历史仍在 Runtime 中，没有在示例文件里另造一条循环。

### 10. 运行同一个 Runtime，比较正常与取消

新建 `src/examples/inspect-batch-loop.ts`，写入完整入口：

<<< ../snippets/07/src/examples/inspect-batch-loop.ts

这一入口不再直接调用 runBatch，而是调用 runAgentLoop。传入的 decide 是刚写的脚本，executeTool 继续使用注册表中的两种工具，validateFinish 使用两份材料的检查规则。这样开头的“请求 → 执行 → 写回 → 再决策”就完整接通了。

executeTool 外面的包装函数记录开始、完成，并让源码读取稍等 20 毫秒，方便观察测试先返回。mode 选择顺序或并行；fault 默认 none，稍后用来制造失败或取消。每次 executions 加一只表示启动了一次工具调用，不是增加一次模型决策。

运行：

```bash
npm run typecheck
node src/examples/inspect-batch-loop.ts parallel
```

tests-1 会先完成，末尾应为：

```text
运行结果（outcome）: completed
决策次数（decisions）: 2
工具启动次数（executions）: 2
消息顺序（messages）: user -> assistant -> tool -> tool -> assistant
结果关联（callIds）: source-1 -> tests-1
```

第一次决策产生两项请求，第二次决策给答案，所以是 2 次决策、2 次工具启动，不是 3 次决策。把命令中的 parallel 换成 sequential，正常结果与消息顺序不变，工具开始、完成顺序不同。

现在运行取消模式：

```bash
node src/examples/inspect-batch-loop.ts parallel cancel
```

cancel 在 tests-1 交回结果时触发外部取消，此时源码读取仍在等待。末尾应看到：

```text
运行结果（outcome）: cancelled
决策次数（decisions）: 1
工具启动次数（executions）: 2
消息顺序（messages）: user -> assistant
结果关联（callIds）:
```

这里两项都启动了，但还没走到循环更新 state 的语句。tests-1 返回后，包装函数触发 controller.abort，原停止机制让循环结束等待，所以看不到两条 tool 消息。assistant 中的请求已在执行前记录，仍然保留。取消来自外部控制器，不是脚本提出的 fail。

读这个入口时，把它看成一次调用安排：准备三项依赖、启动 Runtime、打印返回值。它自己不安排 worker，也不写会话。fault 分支只用于观察异常，后面的真实模型入口不会带上这些故障开关。

## 第三阶段：让模型协议表达同一批调用

前两个阶段已经证明：只要 decide 返回那份 tools 动作，原循环就能执行并反馈。现在替换的是“这份动作从哪里来”：让 DeepSeek 的真实响应也能转换成 tools，而不改刚才验证过的批次执行过程。

这里有两个方向都要接通：模型发来的多个请求要变成 Action，保存过的请求与结果也要在下一轮转换回接口消息。流式方式还多一件事：先把每项调用的参数分别拼完整，再交出 Action。

### 11. 转换历史中的多个调用

先看发送给模型的方向。第二轮 Context 已经有“一条含两项请求的 assistant 消息、两条 tool 结果”；旧转换函数只认识单项 call，不能把新历史正确发出去。

修改 `src/adapters/deepseek/protocol.ts`，将顶部导入区替换为：

```ts
import type { Action, DecisionContext, ToolCall } from "../../runtime/types.ts";
import { toolCallsOf } from "../../runtime/action-tools.ts";
import { maxToolCallsPerDecision, validateToolBatch } from "../../runtime/tool-batch.ts";
```

用下面整段替换原 DeepSeekMessage 类型与 buildDeepSeekMessages 函数；isRecord、record、nonEmptyText 三个辅助函数先保留：

<<< ../snippets/07/src/adapters/deepseek/protocol.ts#messages

沿第二轮 Context 走这个函数：先加入 system，随后保留 user。遇到 tools 动作时，toolCallsOf 取出两个请求，calls.map 把它们分别转成接口要求的调用对象，再一起放进**一条 assistant 消息的 tool_calls 数组**。请求参数在这里转成 JSON 字符串。

遇到两条 tool 消息，则各自转换一次，把 result.callId 放到 tool_call_id。这就是模型能把“源码结果”对应到“刚才源码请求”的依据。最后返回的接口输入为：

```text
system
user
assistant：tool_calls = [source-1, tests-1]
tool：tool_call_id = source-1，content 含源码结果
tool：tool_call_id = tests-1，content 含测试片段结果
```

这一轮有五条接口消息，而 State 当时有四条。多出来的 system 是适配器组装请求时加入的说明；这个函数返回新数组，不把 system 放回 State。

接着，用下面两个完整函数替换旧 decodeDeepSeekAction；新增 decodeToolCall 放在它前面，不保留旧同名解码函数：

<<< ../snippets/07/src/adapters/deepseek/protocol.ts#decode

再看收到响应的方向。假设服务返回两个 tool_calls：主函数先确认响应表示工具请求，再对每项调用 decodeToolCall。这个辅助函数取出 ID 和名称，把参数 JSON 字符串解析成对象，交回一份 ToolCall。

两项都解析成功、整批身份检查通过，主函数才返回含两项 calls 的 tools 动作。若第二项参数损坏，就在这里抛错，不会偷偷拿第一项交给 Runtime 执行。只有一项时仍返回旧 tool 动作，保留原入口的行为。

choices 表示回复候选，tool_calls 表示一份回复里的请求清单。这次只增加请求数量，仍只接收一个候选回复。

至此 protocol.ts 的两个方向对应上了：buildDeepSeekMessages 把历史变成模型输入，decodeDeepSeekAction 把模型响应变成循环能处理的动作。两者都不执行工具、不修改 State；工具的路径规则仍在 invoke 调用的 parse 中检查。

### 12. 让真实 decide 检查整批历史身份

在 `src/adapters/deepseek/decider.ts` 顶部新增以下两个导入，保留其他导入和 DeepSeekOptions：

```ts
import { toolCallsOf, previousToolCallIds } from "../../runtime/action-tools.ts";
import { validateToolBatch } from "../../runtime/tool-batch.ts";
```

用下面完整函数替换旧 createDeepSeekDecider：

<<< ../snippets/07/src/adapters/deepseek/decider.ts#factory

创建适配器时，仍先从注册表准备工具说明；循环真正调用返回的 decide 函数时，才从 Context 组装请求并访问模型。非流式响应交给 decodeDeepSeekAction；流式响应等 collectDeepSeekAction 拼完整后交回动作。两个方向最后都由 action 接住。

新增检查位于 return action 之前：取出本次所有调用，再从 Context 找到旧 ID，一起交给 validateToolBatch。例如新响应又用了以前的 source-1，就拒绝这次动作。模型可以再读同一路径，但那是一次新请求，必须有新 ID。

为什么循环里也检查一次？因为 Runtime 也可能接收离线脚本或其他适配器，不能把自己的保证建立在“调用方一定用了 DeepSeek”上。适配器在接收数据时检查，循环在记录和执行前也检查。

这里没有安排并行。动作返回给循环之后，循环才按应用的 toolExecution 配置调用 runBatch；parallelSafeTools 不发给模型。本篇也没有增加 parallel_tool_calls 请求字段。

### 13. 为流式响应按 index 保留多份草稿

一次回复里有两个请求，不代表它们的参数按整份先后到达。可能先来“测试参数的前半段”，再来“源码参数的前半段”，然后才各自补齐后半段。第 6 篇只保存一份 call 草稿，现在必须先辨认片段属于哪一项。

接口片段中的 index 就用来标记它在当前回复里的位置：0 属于第一项，1 属于第二项。本例中 0 是源码，1 是测试。**这是参数接收顺序的问题，与后面工具谁先执行完是两件事。**

修改 `src/adapters/deepseek/stream-protocol.ts`，顶部保留原两个导入，再新增：

```ts
import { maxToolCallsPerDecision } from "../../runtime/tool-batch.ts";
```

先用下面整段替换 ModelProgress、ProgressListener、StreamDraft 与 record、metadata 的区域，到原 metadata 函数结束为止；不要重复保留旧声明：

<<< ../snippets/07/src/adapters/deepseek/stream-protocol.ts#draft

原来 draft 里只有一个 call，现在用 Map 为每个 index 保存一份草稿。可以把它理解成“按位置编号找草稿”：calls.get(0) 找源码，calls.get(1) 找测试；两者各有自己的 ID、名称和参数文本。

显示进度也带上 index，便于观察正在补哪一项。record 的对象检查和 metadata 的身份检查继续使用；metadata 允许后续片段确认同一 ID 或名称，但不允许拼到一半换成另一项调用。这些数据都只属于本次响应的暂存内容，没有进入 State。

接着删除旧 appendToolDelta，用下面完整函数替换；名称改为复数 appendToolDeltas：

<<< ../snippets/07/src/adapters/deepseek/stream-protocol.ts#tool

拿测试片段先到的情况看：读取 index=1 后，calls.get(1) 还不存在，就创建空草稿；把本片的 ID、名称和参数片段填入，再用 calls.set(1, call) 保存。下一次源码片段 index=0 到达，就单独创建另一份草稿。

后续测试片段再来时，get(1) 已能找到上一次的对象，`call.arguments += part` 只补它的参数。源码草稿不会被改到，因此不会把两份半截 JSON 拼进同一个字符串。

函数遍历本事件中的每个片段，所以一次事件可以带多项，也可以是空数组。索引只允许 0～7；身份通过 metadata 核对，参数片段必须是字符串。最后返回 progress 供显示，既不解析半份参数，也不启动工具。

再用下面完整函数替换 appendChunk：

<<< ../snippets/07/src/adapters/deepseek/stream-protocol.ts#chunk

appendChunk 仍负责处理一条完整事件。它检查响应结构后，把普通文字加到 draft.content；若带工具片段，就调用刚才的 appendToolDeltas，更新对应草稿并取得显示通知。

以前只有一份参数，现在 argumentsSize 要把所有草稿的参数长度加起来，再与文字一起检查总暂存大小。最后保存可能出现的 finish_reason，通知外部显示进度。即使某份参数此时已经完整，它仍不返回 Action，也不执行工具。

接着用下面完整函数替换 completeDraft：

<<< ../snippets/07/src/adapters/deepseek/stream-protocol.ts#complete

如果测试片段先来，Map 里可能先插入 1，再插入 0。completeDraft 取出这两项，按 index 排成 0、1，恢复本次回复中的调用顺序；同时要求没有缺项。只收到了 1 却没有 0，就抛错，不能把测试悄悄当成第一项。

然后把每份草稿转成完整 tool_calls，交给 decodeDeepSeekAction。它会解析所有参数、核对 ID 与结束原因，最后返回一个 tools 动作。拼接完不等于检查通过，第二项 JSON 错误或两个 ID 相同，仍会失败。

index 的作用到这里结束。之后执行和保存结果，靠的是请求 ID 与结果 callId 对应，而不是用流式片段的位置猜结果属于谁。

最后，在 collectDeepSeekAction 中找到原草稿初始化语句，仅替换为：

```ts
const draft: StreamDraft = { content: "", calls: new Map() };
```

collect 的其他流程保留：普通事件只组装，收到 `[DONE]` 才完成最终解码，断流不能交回动作。不要因为支持两个草稿，就让第一项参数完整时先执行。

#### stream-protocol.ts 写完后，一次响应怎样走完

从外部看，入口仍是 collectDeepSeekAction：它接收事件，每条事件交给 appendChunk；其中的工具片段再由 appendToolDeltas 分别保存。收到 `[DONE]` 时，才调用 completeDraft 还原顺序、检查完整动作并返回。

回到整条运行过程：这份 Action 返回给 decide，再返回给 agent-loop.ts。循环记录请求之后，才会调用 runBatch。**参数正在流入，不等于工具正在执行。** SSE 字节读取沿用第 6 篇，多调用草稿只改变响应怎样组装。

### 14. 离线观察调用片段交错到达

新建 `src/examples/inspect-batch-stream.ts`，写入完整内容：

<<< ../snippets/07/src/examples/inspect-batch-stream.ts

events 用 async function* 一次交出一条人工事件，供 collectDeepSeekAction 的 for await 接收。这里直接提供完整 data 文本，不再模拟第 6 篇的 SSE 字节分割。前两条先交出测试、源码各自的身份和半份参数，后两条再补齐，最后交出结束原因和 `[DONE]`。

入口等待 collect 返回完整 Action 后，才用 toolCallsOf 取出请求并打印。片段日志来自 onProgress；完整调用日志来自最后返回的动作，它们代表两个不同的时刻。

运行：

```bash
npm run typecheck
node src/examples/inspect-batch-stream.ts
```

参数进度按 1、0、1、0 出现，最后应为：

```text
动作类型（kind）: tools
完整调用（call）: source-1 -> {"path":"src/sum.ts"}
完整调用（call）: tests-1 -> {"path":"test/sum.test.ts"}
```

这个入口只观察草稿与最终动作，没有调用工具或修改 State。它证明交错分片不会混合参数，并不证明真实模型必定一次生成两个调用。

### 15. 用正常入口接入真实模型

新建 `src/examples/deepseek-batch-agent.ts`，写入完整内容：

<<< ../snippets/07/src/examples/deepseek-batch-agent.ts

这里把刚才的离线决策器换成真实 decide。入口先读本地模型配置，创建含两种读取工具的 registry；再调用 createDeepSeekDecider，准备模型调用所需的说明和工具清单。到 runAgentLoop 调用 decide 时，才发出网络请求。

交给循环的三项依赖仍然一样：decide 负责请求动作，createToolExecutor(registry) 负责执行每一项，hasBatchEvidence 检查两份材料。toolExecution 配置则交给 Runtime，让它按上限 2 安排并行，不由模型决定。

最终 result 是整个运行的返回值，下面的日志从中读退出原因、决策次数和消息历史。onProgress 只在接收响应期间显示文字，不保存历史。这个入口没有人工延迟、故障开关，也不会把 diagnosis 当成模型答案；运行核心仍是前面那套。

配置好 `.env` 后分别运行：

```bash
node --env-file=.env src/examples/deepseek-batch-agent.ts
node --env-file=.env src/examples/deepseek-batch-agent.ts stream
```

第一条使用完整 JSON，第二条使用流式接收。**典型批次轨迹如下，属于示意，不保证每次轮数或措辞一致：**

```text
[请求模型 model] 消息角色（roles）=system -> user
[模型动作 action] tools
……两项本地读取执行……
[请求模型 model] 消息角色（roles）=system -> user -> assistant -> tool -> tool
[模型动作 action] finish
运行结果（outcome）: completed
决策次数（decisions）: 2
消息顺序（messages）: user -> assistant -> tool -> tool -> assistant
最终答案（answer）: ……模型本次的诊断和建议……
```

模型也可能分两轮分别读取，此时每次是旧 tool 动作，总决策数相应增加，不因此判为错误。本例完成规则要求两份真实运行证据与非空答案，没有自动评估答案语义；应手工核对是否说明 reduce 缺少初始值，以及固定测试片段只有非空数组情况。

旧 `first-loop.ts` 与第 5、6 篇单调用入口保留作对照。新任务应使用 batch-scenario 的证据规则，不能把旧的“单个请求后紧邻一条结果”的场景假设当成通用批次规则。

## 调试：从一个 ID 与一个数组位置开始

先调试离线入口，避免同时排查网络与调度：

```bash
node --inspect-brk src/examples/inspect-batch-loop.ts parallel
```

在 Chrome 的 `chrome://inspect` 连接进程。断点暂停会消耗配置中的累计运行时间；本例 1000 毫秒仅供快速离线运行，长时间调试可临时调大，之后恢复。

第一次跟踪只用正常模式：在循环取得 action 后看两个请求；接着进入 runBatch，看哪一项返回到 results 的哪个位置；再回到循环的 state 赋值，最后看下一次 decide 的 context.messages 是否包含两份内容。先连通这条路，再分别运行取消、错配等模式。

| 观察位置 | 要看什么 | 能判断什么 |
|---|---|---|
| validateToolBatch 返回前 | calls 与 seen | 是否在启动前拦住重复 ID |
| worker 领取请求后 | index、nextIndex、call.id | 两个 worker 是否领取不同位置 |
| executeTool 返回后 | result.callId 与原 call.id | 是否属于本次请求 |
| results[index] 赋值后 | results 的原下标 | 先完成的 tests-1 是否仍放第 1 项 |
| 循环 state 写回前后 | messages 与 decisions | 是否整批追加、只计一次工具动作 |
| 第二轮 buildDeepSeekMessages 后 | tool_calls 与两条 tool 消息 | 请求和结果是否全部进入下一次输入 |
| 流式 completeDraft 中 | entries 的 index 与每份参数 | 到达顺序是否已还原、是否存在缺口 |

不要同时把所有日志当成会话。`开始调用` 说明进入包装执行函数，`完成调用` 说明该观察函数拿到了返回值，最后 State 中的 tool 消息才表示循环接受并记录了结果。

若模型仍不知道某份文件，先看该工具结果是否写回，再看第二次请求是否包含匹配的 tool_call_id。若结果数组顺序正确但 ID 不匹配，仍是错误；排序不能修复身份。

## 故障实验与恢复

### 一项工具抛错：观察进入下一轮

```bash
node src/examples/inspect-batch-loop.ts parallel error
```

read_tests 抛出模拟异常，本项被包装为带 tests-1 的 tool-error，源码结果仍可记录。脚本随后发现证据不全而提出 fail，预期 failed，decisions 为 2，消息仍有两条 tool，失败来源为 decision。

这里的 decision 是脚本最终拒绝完成的来源，不表示最初故障发生在模型服务。不要只看最后的 source 就忽略前面的工具观察。

### 结果冒用身份：不把本批结果写入 State

```bash
node src/examples/inspect-batch-loop.ts parallel mismatch
```

预期 failed，失败来源为 execution，decisions 为 1，消息只有 user → assistant，没有本批 tool 记录。已经启动的另一项可能仍结束，但错配结果使整批无法被接受；不能把 wrong-id 改成原 ID 后假装正确，也没有自动回滚外部操作。

这些内置模式不改文件，恢复普通模式只需不传第三个参数。

### 重复调用 ID 必须在工具启动前失败

在 `src/examples/batch-fixture.ts` 中，临时把 tests-1 的 id 改为 source-1，保留工具名称与参数，然后运行：

```bash
node src/examples/inspect-tool-batch.ts parallel
```

应抛出 Duplicate tool call id in run，且没有任何“开始调用”日志。修复后将第二项 id 恢复为 tests-1，再运行原命令验证两项执行正常。仅改变工具名称不能修复重复的调用身份。

### 一个小迁移：允许并行，但把并发上限改为 1

只改 `src/examples/inspect-tool-batch.ts` 中的 concurrency，从 2 改为 1，保留 mode 为 parallel 与安全清单。预期工具开始、完成顺序退为串行，返回顺序与 ID 不变；不需要改 worker、工具或 Runtime。

观察后恢复为 2。若把某个工具从安全清单移除，本批也会按顺序执行；它仍可由正常注册与参数检查执行，这个清单不是“允许调用哪些工具”的权限清单。

## 对照 Pi：执行策略与结果顺序分别定义

固定提交 `8efd314fa3d3232ce197d8d7a6a5660530b9d83e` 的 [executeToolCalls](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/agent/src/agent-loop.ts#L508) 会检查配置与工具执行模式，再选择顺序或并行路径。某项要求顺序时会走顺序路径，可与本章“本地决定是否并行”对照；具体配置方式不同。

其 [executeToolCallsParallel](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/agent/src/agent-loop.ts#L586) 在整理结果时等待对应项，再按原顺序生成工具结果消息；完成事件与结果消息的时序并非同一概念。本章用固定数量 worker 和按下标归位表达这个区别。

Pi 还包含调用准备、结束处理、事件与终止策略。本章的每批 8 项、安全名称清单、worker 数量限制和取消时不追加本批任何结果，都是自己的明确选择，不能说成 Pi 完全相同的实现。先看边界、数据流和异常处理，再决定是否采用某种写法。

## 完整最终文件

以下只汇总本章新增或修改的 14 个文件；其他第 6 篇源码保留。每个文件的职责已经在完成处说明，此处供实现后核对，不替代前面的步骤。

### src/examples/batch-fixture.ts

<<< ../snippets/07/src/examples/batch-fixture.ts

### src/examples/read-tests-tool.ts

<<< ../snippets/07/src/examples/read-tests-tool.ts

### src/runtime/tool-batch.ts

<<< ../snippets/07/src/runtime/tool-batch.ts

### src/examples/inspect-tool-batch.ts

<<< ../snippets/07/src/examples/inspect-tool-batch.ts

### src/runtime/types.ts

<<< ../snippets/07/src/runtime/types.ts

### src/runtime/action-tools.ts

<<< ../snippets/07/src/runtime/action-tools.ts

### src/runtime/agent-loop.ts

<<< ../snippets/07/src/runtime/agent-loop.ts

### src/examples/batch-scenario.ts

<<< ../snippets/07/src/examples/batch-scenario.ts

### src/examples/inspect-batch-loop.ts

<<< ../snippets/07/src/examples/inspect-batch-loop.ts

### src/adapters/deepseek/protocol.ts

<<< ../snippets/07/src/adapters/deepseek/protocol.ts

### src/adapters/deepseek/decider.ts

<<< ../snippets/07/src/adapters/deepseek/decider.ts

### src/adapters/deepseek/stream-protocol.ts

<<< ../snippets/07/src/adapters/deepseek/stream-protocol.ts

### src/examples/inspect-batch-stream.ts

<<< ../snippets/07/src/examples/inspect-batch-stream.ts

### src/examples/deepseek-batch-agent.ts

<<< ../snippets/07/src/examples/deepseek-batch-agent.ts

## 验收与提交

恢复 ID 与 concurrency 的故障修改后，运行下面检查。离线部分应分别观察顺序、乱序完成、整批写回、取消与错配拒绝；流式入口应还原交错参数而不提前执行。

```bash
npm run typecheck
node src/examples/inspect-tool-batch.ts sequential
node src/examples/inspect-tool-batch.ts parallel
node src/examples/inspect-batch-loop.ts parallel
node src/examples/inspect-batch-loop.ts parallel error
node src/examples/inspect-batch-loop.ts parallel mismatch
node src/examples/inspect-batch-loop.ts parallel cancel
node src/examples/inspect-batch-stream.ts
node src/examples/first-loop.ts
node src/examples/inspect-stream.ts cut
```

配置有效密钥后，再运行真实模型入口与原单调用入口：

```bash
node --env-file=.env src/examples/deepseek-batch-agent.ts
node --env-file=.env src/examples/deepseek-batch-agent.ts stream
node --env-file=.env src/examples/deepseek-stream-agent.ts
git branch --show-current
git status --short
git diff --stat
```

确认实际联网结果与历史反馈正常后，再使用下面包含真实验证描述的提交信息；未完成联网时按实际情况修改正文，不把离线模拟写成真实服务通过。只暂存本章源码，不包含 .env：

提交同时包含本章源码和 `site/` 网站更新；推送章节分支后，还需将 Pull Request 合并到 main，Actions 才会发布网页。

```bash
git add -- src/examples/batch-fixture.ts src/examples/read-tests-tool.ts src/runtime/tool-batch.ts src/examples/inspect-tool-batch.ts src/runtime/types.ts src/runtime/action-tools.ts src/runtime/agent-loop.ts src/examples/batch-scenario.ts src/examples/inspect-batch-loop.ts src/adapters/deepseek/protocol.ts src/adapters/deepseek/decider.ts src/adapters/deepseek/stream-protocol.ts src/examples/inspect-batch-stream.ts src/examples/deepseek-batch-agent.ts site/
git diff --cached --stat
git commit -F - <<'COMMIT'
第 07 篇：增加工具批次与有界并行执行

在同一 Runtime 中接收多个工具请求，按应用配置选择顺序或并行，结果按身份与原请求位置关联，确认后整批写回。

- 保留单工具动作，增加批次动作与统一调用读取
- 新增批次预检、有限 worker 和安全调度声明
- 扩展普通与流式模型协议，分开组装交错调用参数
- 增加两份读取证据与批次诊断入口
- 验证普通工具失败、身份错配、取消与缺失结果边界

验证：类型检查、离线入口与故障实验通过；真实批次的非流式、流式及原单调用入口通过。未提交密钥配置。
COMMIT
git push -u origin codex/chapter-07-tool-batches
```

本篇限制单次动作大小与执行中的并发数量，下一篇才处理长会话的输入选择与上下文预算。它们解决不同问题，不能用“并发较少”代替模型输入长度管理。
