---
title: 第 18 篇｜把各模块连成同一个 Runtime
description: 用同一组装入口贯穿模型、权限、工具、状态、预算和保存恢复，复盘源码与实际边界，完成单机 Runtime 的系统验收。
---

# 第 18 篇：把各模块连成同一个 Runtime

前面已经能分别观察模型调用、工具反馈、权限拒绝、用量和恢复。但当一个任务出问题时，仍可能不知道该打开哪个文件：模型没有收到工具结果，是输入丢了，还是工具根本没执行？终端显示结束，磁盘是否也保存好了？

本篇把已有模块接到**同一个组装入口**，用“读取源码和测试片段，诊断空数组求和失败”的任务走完全过程。随后只改变运行条件，观察无证据完成、权限拒绝、额度不足、取消和跨进程接续。最后用同一张系统地图定位源码。

第 18 篇是本阶段的收尾。完成后，可以说已经实现了**本课程约定范围内的单机 Agent Runtime**：它能驱动模型与工具协作，并控制状态、停止、输入、权限、预算和保存恢复。这里的“完成”有明确范围：没有实现完整 Pi 产品、生产隔离平台或能够修复任意仓库的 Coding Agent。

本章仍不改写 `src/runtime/`。新增的 `src/application/` 负责把已有模块接起来；`src/examples/` 提供演示资源、离线服务和运行入口。第 17 篇的 `src/evaluation/` 继续是外部验证工具，应用平时运行 Agent 不依赖它。

## 先把这次任务说清楚

### 程序真的做什么，哪些仍是替身

任务是解释 `sum([])` 为什么失败。正常过程如下：

1. 应用准备一份私人工作区，里面有真实的 `sum.ts` 和 `sum.test.txt`。
2. Runtime 从用户任务构造 Context，模型适配器将它转为 HTTP 请求。
3. 离线服务第一次返回 503；正式 HTTP 适配器判断可重试，再发一次请求。
4. 服务提出读取源码、读取测试片段两项工具调用。
5. 原循环记下请求，权限入口检查当前许可和参数，保存器先记执行意图，工具才读取文件。
6. 循环收齐结果，按调用顺序写进 State。下一轮 Context 带上两份结果，再请求模型。
7. 服务给出预设诊断。完成规则核对诊断与两份已读证据，循环返回 completed。
8. Agent 等待会话保存完成，应用接住返回值，再保存整合报告、关闭保存器。

**模型回答是固定替身，文件读取、HTTP 协议解码、重试、权限检查、状态写回和磁盘保存都实际执行。** 读取测试片段不等于运行测试，本章也不修改源码。完成只表示“固定诊断有两份读取证据”，不表示“修复通过了测试”。

这次整合先使用非流式响应，让主线容易观察。第 7、17 篇的断流检查继续保留；不是把前面支持的流式功能删掉，也不宣称这一个命令覆盖所有机制。

### 为什么还要增加组装入口

以前每个演示入口自己创建 Agent、模型依赖、工具和保存器。一个文件能跑通，并不能保证另一个入口也装上了同样的门禁。

本篇增加 `createRuntimeSession`：调用方提供工作区工具、当前权限、完成规则、模型传输和预算，函数负责创建并连接这些对象，交回**原来的 Agent**。它不写第二个 while，不自己追加工具消息，也不把业务诊断塞进核心循环。

本章将一段可保存的 Agent 运行称为“会话组装”。一个组装对象用于一个任务及其暂停接续；开始另一项独立任务时创建新对象。本篇没有把它包装成通用 SDK。

| 层次 | 代码放在哪里 | 本次任务中负责什么 |
|---|---|---|
| Runtime 核心 | `src/runtime/` | 循环、状态、取消、输入、执行控制、预算、保存恢复协议 |
| 模型适配 | `src/adapters/deepseek/` | 内部消息与 HTTP 协议互转、重试、用量报告 |
| 应用组装 | 本篇 `src/application/runtime-session.ts` | 连接依赖，确定门禁先后，持有本实例的报告与关闭入口 |
| 任务与演示 | 本篇 `src/examples/` | 指定文件、诊断规则、离线响应，以及如何运行 |
| 外部验证 | `src/evaluation/` 和本篇检查入口 | 制造条件并检查实际行为，不代替业务循环 |

## 前置版本与文件地图

先完成并保存第 17 篇，再新建本篇分支。`git status` 有未保存内容时，先按第 17 篇末尾命令处理，避免把尚未完成的改动误认为第 18 篇起点。

```bash
git status --short
git switch -c codex/chapter-17-system-integration
npm run check
```

已有分支时用 `git switch codex/chapter-17-system-integration`。本章不新增依赖，不读取 `.env`，不需要 API Key。

| 新增文件 | 文件角色 | 调用或使用它的地方 |
|---|---|---|
| `src/examples/integrated-workspace.ts` | 真实只读工具与固定完成规则 | 场景组装提供给会话入口 |
| `src/examples/integrated-model.ts` | 可控的离线 HTTP 服务 | 模型适配器实际调用的 fetch 依赖 |
| `src/application/runtime-session.ts` | 共同组装入口 | 所有本章场景复用 |
| `src/examples/integrated-scenario.ts` | 配置不同实验条件 | 命令行与整合检查共用 |
| `src/examples/run-integrated-runtime.ts` | 独立命令行入口 | 运行某一模式、输出报告位置 |
| `src/examples/inspect-integrated-runtime.ts` | 验证入口 | 检查多种出口、重启和两个实例 |

共六个新增文件，没有必须替换的旧文件。下面每步给出连续可复制代码，函数内部按动作留空行和中文注释。**讲解摘录已经包含在完整实现中，无需再次写入文件。** 章末再收齐所有完整文件。

## 阶段一：准备任务资源，先确认读到的是真文件

### 1. 把工具契约连接到这次工作区

原来的工具对外使用逻辑路径 `src/sum.ts` 和 `test/sum.test.ts`。本次演示仍保留这些契约，但实际读取私人目录中的 `sum.ts` 和 `sum.test.txt`。路径映射由应用定义，Runtime 不应该知道测试片段存在哪个文件。

新建 `src/examples/integrated-workspace.ts`，先写入导入：

<<< ../snippets/17/src/examples/integrated-workspace.ts#imports{ts}

再追加完整的工作区绑定函数：

<<< ../snippets/17/src/examples/integrated-workspace.ts#workspace{ts}

`createIntegratedWorkspace` 返回四项能力：registry 给模型列出工具；execute 按原工具契约校验并执行；inspect 给权限入口做执行前检查；inspectEnvironment 给恢复模块读取当前工作区版本和许可。

沿正常源码读取走一次：权限入口收到 `source-1`，inspect 找到已注册工具，用原参数解析器检查逻辑路径，再取得当前工作区版本，交回“这是读取、资源版本是多少”。检查本身不调用工具的 invoke。资源检查会读取文件来计算版本，但不会产生给模型的 ToolResult，也不算完成规则中的读取证据。获准之后，execute 才以工具身份读取这个 root 下的 `sum.ts` 并交回结果。

工作区版本沿用第 13 篇两文件内容的散列；当前 allowedTools 每次从应用函数获取。恢复依据不能从模型输入或旧批准中取回来。这里检查的是可信私人目录中的两份演示资源；没有复用第 14 篇受限写入子进程，也没有新增对恶意代码的沙箱隔离。

### 2. 完成规则仍由应用提供

在同一文件末尾追加：

<<< ../snippets/17/src/examples/integrated-workspace.ts#validate{ts}

规则先确认候选答案等于固定诊断，再从 State 中找成功工具结果。源码观察必须是 `source-1` 且内容等于原源码；测试观察必须是 `tests-1` 且内容等于固定测试片段。两个条件都满足才接受。

它不自己读磁盘，也不修复文件。真正读到了什么，由工具结果提供；Runtime 在 finish 分支调用这个函数。若模型一开始就说出正确诊断，但 State 没有两份证据，仍应该失败。

### 3. 第一个运行检查：工作区与工具

此时还不需要创建 Agent。运行下面整段终端命令；它是一次检查脚本，**不追加到任何源文件**：

```bash
node --input-type=module <<'JS'
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { prepareWorkspace } from './src/examples/recovery-workspace.ts';
import { createIntegratedWorkspace } from './src/examples/integrated-workspace.ts';
import { batchCalls, testsCode } from './src/examples/batch-fixture.ts';
import { sourceCode } from './src/examples/diagnosis-fixture.ts';

await mkdir('.agent-data', { recursive: true });
const base = await mkdtemp(resolve('.agent-data/integration-probe-'));
const root = join(base, 'workspace');
await prepareWorkspace(root);
const workspace = createIntegratedWorkspace(root, () => ['read_source', 'read_tests']);
const expected = [sourceCode, testsCode];

for (const [index, call] of batchCalls.entries()) {
  const result = await workspace.execute(call, new AbortController().signal);
  if (result.status !== 'ok' || result.value !== expected[index]) throw new Error('读取结果不符');
  console.log(`[读取确认] ${call.id} → 与演示文件内容一致`);
}
console.log(`[私人工作区] ${root}`);
JS
```

预期确认 source-1 与 tests-1 都读取正确。这个检查直接调用 execute，是为了先确认资源绑定；它没有经过稍后才安装的权限、恢复意图与 Agent Loop，不能当作整合验收。

## 阶段二：先准备模型服务，再连接原 Runtime

### 4. 离线服务只决定返回什么

新建 `src/examples/integrated-model.ts`，写入导入：

<<< ../snippets/17/src/examples/integrated-model.ts#imports{ts}

继续追加完整服务替身：

<<< ../snippets/17/src/examples/integrated-model.ts#model{ts}

这个文件收到 HTTP 请求，交回 HTTP Response。第一次返回 503，之后检查输入中是否已经有 tool 消息：没有就提出两项读取，有就提出固定诊断。

它没有自己重试。`attempts` 每进入一次 send 才增加；第二次请求能出现，是正式 HTTP 适配器处理 503 的结果。两次成功响应各报告 20 个输入 token、10 个输出 token，所以正常全程累计 60 个已报告 token；503 那次没有用量，另外记一次未报告请求。

`earlyFinish` 专门用于负例：开启后，即使没收到工具结果也提出诊断。判定能否完成的权力仍在应用规则和 Runtime，不在这个替身里。

这里判断“出现 tool 消息”的逻辑只是实验脚本，不能分析任意源码；以后换真实服务，保留的是协议适配和循环机制。

### 5. 组装入口接收什么

新建 `src/application/runtime-session.ts`，先写入导入：

<<< ../snippets/17/src/application/runtime-session.ts#imports{ts}

追加配置与观察类型：

<<< ../snippets/17/src/application/runtime-session.ts#contracts{ts}

`WorkspaceBindings` 是应用交来的资源能力，组装函数不读取 `sum.ts`。`RuntimeSessionOptions` 再给出当前策略、批准函数、完成规则、模型传输、预算，以及新会话该保存在哪里。`recoverFrom` 可选：有值才尝试读取旧暂停点。

`RequestObservation` 保存一次实际模型传输的定位数据：属于哪个 runId、是本实例第几次传输、发出了哪些消息。它不保存请求头、API Key 或完整响应。消息正文仍可能含任务与文件内容，因此报告只写本地已忽略的实验目录。

### 6. 给实际模型请求挂上运行身份

继续在同一文件末尾追加完整辅助函数：

<<< ../snippets/17/src/application/runtime-session.ts#model{ts}

当适配器真正准备传输时，它调用这个包装函数。函数读取当前运行身份，解析 HTTP body，复制 messages，记一份观察，再交给原 send。

正常任务有三次传输，却只有两次决策：第一次 503，第二次得到 tools，第三次得到 finish。这里的 number 按实际传输编号，不把重试藏起来。预算不足时传输依赖不会被调用，所以也不会虚增一条请求观察。

这些数据保存在组装闭包中，不属于 State。模型不会收到“自己的预算、报告器和运行实例”；它收到的仍是 Context 经协议适配后的消息。

### 7. 把模型、执行门禁与保存连接起来

在同一文件末尾追加完整工厂函数：

<<< ../snippets/17/src/application/runtime-session.ts#create{ts}

先沿创建后的正常任务看：函数创建本实例自己的预算、事件数组和传输数组；模型适配器拿到同一个预算与传输观察器。检查当前环境后，创建新保存器，再把权限、意图保存和实际执行接好。最后构造原 Agent，安装事件观察，交回实例和关闭入口。

此时还没有发模型请求。网络或离线传输要等外部调用 `agent.run`，循环报告 run-started 后才发生，因此观察器能取得对应 runId。

#### 门禁为什么按这个顺序接

**讲解摘录（无需写入文件）：**

```ts
const executeTool = createAuthorizedExecutor({
  getPolicy: options.getPolicy,
  inspect: workspace.inspect,
  approve: options.approve,
  approvalMs: 1_000,
  execute: store.wrap(workspace.execute),
});
```

一次工具请求先进入授权器。当前策略允许、参数与资源检查通过、需要的批准仍有效，授权器才调用它的 execute；这个 execute 已被 store.wrap 包装，先把意图存盘，再进入真实工具。

因此调用顺序是：

```text
原循环调度工具
  → 当前权限与资源检查
  → 必要时批准、再次核对
  → 保存“即将执行”的身份
  → 原工具执行入口
  → 参数校验、实际读取
  → 结果返回原循环
```

若把保存器包在整个授权器外面，一次被拒绝、尚未执行的请求也可能被记成待核查执行。本章选择先授权再留执行意图，既保留拒绝观察，也让意图清单更贴近实际执行边界。

“先存意图”不能让读写操作获得事务保证。存完后仍可能崩溃；这种情况下记录只说明可能执行，需要检查，而不能证明一定发生或一定没发生。

#### 保存完成与事件结束不是同一时刻

**讲解摘录（无需写入文件）：**

```ts
const agentOptions: AgentOptions = {
  maxDecisions: 5,
  resultSink: store,
  run: {
    timeoutMs: 5_000,
    context: { maxBytes: options.maxContextBytes ?? 32_000 },
  },
};
```

循环先报告 run-ended，然后返回结果；Agent 接住结果后等待 resultSink.save，保存成功才让 agent.run 返回。最终应用再执行 close。因此“监听到结束事件”不能代替“已等到运行 Promise 完成”。

`maxDecisions` 限制取得动作次数，timeoutMs 限制本段等待时间，maxBytes 限制本项目 Context 的 JSON 字节数。它们不是 HTTP 请求次数，也不是服务端 token 窗口。组装只是把不同控制项放在一起，没有把它们合成一个模糊预算。

#### 恢复与关闭分别负责什么

有 recoverFrom 时先用当前环境检查旧证据，blocked 就抛错；只有 ready 才安装旧暂停状态。新保存器使用新 sessionId，不能覆盖旧目录。创建失败后关闭已创建的保存器。

返回的 report 每次复制内部数组与预算快照，外部修改副本不会污染留存数据。close 则释放保存器：活动运行时拒绝关闭，调用方应先 cancel 或等待，再等待运行 Promise，最后 close。它不是“强制终止所有外部副作用”的接口。

[![同一 Agent 使用 Context 与模型适配，工具经过权限、执行意图和实际执行后回到 State；运行结果再由 Agent 等待保存](/diagrams/integrated-runtime-chain.svg)](/diagrams/integrated-runtime-chain.svg)

点击放大。实线表示本次调用或返回，回到 State 的箭头表示循环真正写回结果。事件观察和传输观察收集副本，不承担状态更新。

完成本阶段可以运行 `npm run typecheck`。下面接上场景与命令，不需要修改任何旧 Runtime 文件。

## 阶段三：一个入口，切换运行条件

### 8. 明确允许的演示模式

新建 `src/examples/integrated-scenario.ts`，先写导入：

<<< ../snippets/17/src/examples/integrated-scenario.ts#imports{ts}

再追加模式清单与检查函数：

<<< ../snippets/17/src/examples/integrated-scenario.ts#modes{ts}

模式只是本章命令行选择的实验条件，不是 Runtime 新增的状态。比如 denied 不是一种 Outcome；它导致一次权限拒绝，最终怎样结束还要沿原循环走。

### 9. 用相同组装入口准备每次运行

继续追加完整的准备函数：

<<< ../snippets/17/src/examples/integrated-scenario.ts#prepare{ts}

先创建或保留同一工作区的两份文件，再创建本次策略与服务替身，然后调用刚写的 createRuntimeSession。normal 与失败模式在这里分岔的是配置：额度、Context 上限、当前许可或服务响应，组装过程没有换。

registry 仍告诉模型有两个工具。denied 只把当前许可缩到 read_source，所以即使模型知道 read_tests，也没有执行授权。这是在区分“能描述某个能力”与“这次可以使用它”。

pause 与 cancel 是控制实验：在结果写回后请求暂停，或在批次开始通知中请求取消。观察者没有自己写 paused/cancelled，也没有从数组删除工具结果；原循环收到控制请求后决定怎样退出。

### 10. 运行后先等保存，再关闭

继续追加完整运行函数：

<<< ../snippets/17/src/examples/integrated-scenario.ts#run{ts}

prepare 只组装。runIntegratedScenario 才启动或接续：resume 调 agent.resume，其余调 agent.run。await 返回后取得最终 State、Outcome 和本实例报告，finally 关闭保存器。

这里的返回值是交给外部命令使用的数据，尚未写成整合报告文件。会话日志已经由 Agent 等待保存；完整 report 文件则由下一步 CLI 明确写入。两次写入不能因为都叫“保存”就混为一谈。

### 11. 增加短命令行入口

新建 `src/examples/run-integrated-runtime.ts`，先写导入：

<<< ../snippets/17/src/examples/run-integrated-runtime.ts#imports{ts}

再追加完整运行部分：

<<< ../snippets/17/src/examples/run-integrated-runtime.ts#run{ts}

不传模式就跑 normal；resume 必须给出先前 pause 打印的目录。其他模式默认创建新实验目录，避免复用上次副本。传目录时也不要给正式项目路径，这个参数只用于本章创建的实验目录。

CLI 调用共用运行函数，取得 report 后用 wx 创建模式对应报告，不覆盖已有文件。它打印的是已经发生的事件、最终退出、实际传输次数和用量。固定模型说“完成”并不会直接决定这些日志。

```bash
npm run typecheck
node src/examples/run-integrated-runtime.ts normal
```

正常输出中应看到：

```text
[任务结果 outcome] completed
[已记录决策 decisions] 2
[模型传输 requests] 3，服务实际调用=3
[已报告 token] 60，未报告请求=1
[实验目录] .../.agent-data/integration-...
[完整报告] .../normal-report.json
```

省略号表示机器上的真实路径不同，不是源代码或完整终端输出。事件应依次为：

```text
run-started
→ decision-started
→ decision-recorded
→ batch-started
→ results-recorded
→ decision-started
→ decision-recorded
→ run-ended
```

`decision-started` 只有两次，传输却三次，是因为 HTTP 重试发生在第一次决策内部。若这两个计数被写成相等，后续排查预算问题会看错。

## 现在沿一份报告走完整条链

### 第一次请求为什么没有源码

打开刚输出的 normal-report.json。它由三类数据拼成：

| 字段 | 来源与保存者 | 这次能看到什么 |
|---|---|---|
| result.state / outcome | 原循环更新，Agent 等待保存后返回 | 5 条消息、2 次决策、completed |
| trace | 组装入口订阅原实例事件 | 同一个 runId 下的 8 个阶段 |
| requests | 实际传输依赖收到的消息副本 | 3 次请求，重试也占一项 |
| budget | 本实例原预算对象的快照 | requests=3、knownTokens=60、unreportedRequests=1 |
| httpCalls | 独立服务替身的计数 | 实际进入服务 3 次 |

第一次传输的 messages 只有 system 与 user，因为工具还没有执行。503 后重试仍发送同样输入；原 State 没有多一条 assistant，也没有 tool 结果。

第二次传输得到两项读取请求。循环先记录一条 assistant 动作，decisions 变为 1，再执行并写回两条 tool。因此下一轮准备输入时，State 是：

```text
user：诊断任务
assistant：source-1、tests-1 两项读取
 tool：source-1 的真实源码
 tool：tests-1 的真实测试片段
```

第三次传输的 HTTP 消息为 system、user、assistant、tool、tool。服务这时才提出诊断。循环记录 finish，decisions 变为 2；应用规则核对通过，State 最后是 5 条消息。

### 谁真正让模型知道上次的结果

仍是原 `agent-loop.ts` 将 results 追加为 tool 消息，下一轮 `context.ts` 从新的 State 构造 Context，`protocol.ts` 把 tool 观察转换成服务协议消息。

**requests 数组只是把这次输入留下来供人检查，不能替代 State 的写回。** 删除观察器只能让报告少证据；漏掉循环写回则会改变任务本身，两者性质不同。

### 哪些数据会跨进程存在

正常目录大致如下，由程序创建，不手工写这些文件：

```text
integration-.../
  workspace/
    sum.ts
    sum.test.txt
  normal/
    journal.jsonl
    checkpoint.json
    recovery.json
  normal-report.json
```

journal/checkpoint 保存原会话结果，recovery 保存恢复边界；normal-report 是本次命令额外写出的整合观察。报告不是恢复的信任来源，恢复器不会因报告写着 completed 就接受状态。

[![State、Context、报告和磁盘会话各有归属；新进程检查会话与当前环境后恢复，旧报告和旧批准不会变成新授权](/diagrams/integrated-runtime-data.svg)](/diagrams/integrated-runtime-data.svg)

点击放大。关闭进程会丢掉内存中的预算对象、事件订阅、输入队列和未保存报告。已落盘的会话也不等于保存了上述所有对象。

## 阶段四：只改条件，观察原控制流在哪停下

### 12. 无证据完成与当前权限拒绝

分别运行，默认会创建不同实验目录：

```bash
node src/examples/run-integrated-runtime.ts early-finish
node src/examples/run-integrated-runtime.ts denied
```

early-finish：服务在读文件之前直接给固定诊断。Runtime 已记录 finish，但完成规则找不到两份成功观察，最终 failed，source 为 validation，State 没有 tool 消息。

denied：source-1 获准执行；tests-1 因当前许可缺失返回 permission-denied，错误观察也写回 State，进入下一次模型输入。即使服务再给相同诊断，应用也不能接受缺少成功测试读取证据的答案，所以最终 failed。

这两项都可能是 failed，但发生位置不同。先看历史中有没有 tool、其中 status/code 是什么，再看 outcome.source；不能只搜索终端有没有“失败”。

### 13. 三种“还不能继续”并不等价

```bash
node src/examples/run-integrated-runtime.ts request-limit
node src/examples/run-integrated-runtime.ts context-limit
node src/examples/run-integrated-runtime.ts cancel
```

| 模式 | 具体触发点 | 预期结果 | 已发生什么 |
|---|---|---|---|
| request-limit | 只给 1 次请求额度，第一次刚好 503 | resource-limit / model-requests | 一次传输，无有效决策与工具结果 |
| context-limit | JSON 字节上限为 1 | context-limit | 模型尚未调用，传输为 0 |
| cancel | batch-started 通知中请求取消 | cancelled | 工具请求动作已记录，工具尚未执行 |

request-limit 不是“模型重试了三次才失败”，第二次传输在开始前就被门禁阻止。context-limit 也不是服务商拒绝，它发生在本地构造 Context 时。cancel 的动作记录不被抹掉，但停止检查阻止后面的实际执行。

本命令按原流程返回任务 Outcome，所以预期失败场景运行完也可以是进程退出码 0。下一阶段的检查命令才在行为不符合期望时抛错、返回非零；这与第 17 篇“任务失败不等于评估失败”一致。

### 14. 暂停后，换一个 Node 进程继续

先运行：

```bash
node src/examples/run-integrated-runtime.ts pause
```

预期 paused，decisions=1，两项读取结果已保存，模型传输为 2。复制输出的完整实验目录，再运行下面命令，替换引号里的路径：

```bash
node src/examples/run-integrated-runtime.ts resume '这里替换为 pause 打印的实验目录'
```

新命令创建新 Agent，从 pause 会话检查并安装已保存状态，追加新的用户要求，再请求模型。服务输入中已经包含两条 tool 结果，所以新段直接提出 finish，不再执行读取批次。旧 pause 日志不变，新结果写入 resume 目录，最终 completed。

#### 暂停、批准与预算到底恢复了什么

这里恢复的是确认过的暂停 State。当前工具、策略、传输和预算都是新进程重新创建的。resume 会再遇到这份新服务替身的第一次 503，所以新段有 2 次模型传输；不能把这 2 次误看成重复执行了 2 个工具。

**本项目尚未持久化模型预算账本。** pause 与 resume 的模型请求分别受新建预算控制；旧报告可用于人工核对，不是跨重启总额门禁。若业务要求“这项任务跨重启最多花固定金额”，还需要持久账本、保留额度与并发一致性设计，当前实现不能声称具备这一保证。

审批也没有随 State 恢复；本场景全是只读操作。第 14 篇写入的批准等待是同进程的一次授权，第 11 篇 pause 是循环安全边界暂停，二者不能合称为已经实现“等待批准时随意重启继续”。

#### 可逆故障：改变资源后能否继续

再创建一次新的 pause 实验，记下目录。在它的 workspace/sum.ts 末尾加一行注释，保存；对该目录运行 resume。

应在创建新续运行之前报 `Recovery blocked: Workspace revision or current tool grant changed`，旧 pause/journal.jsonl 不被改写。实验完成后丢弃这份私人目录，后续正常验证重新创建 pause；不修改正式项目源码，不把旧边界文件手工改成可恢复。

## 阶段五：留下能重复运行的整合检查

### 15. 检查同一组装入口的六种出口

新建 `src/examples/inspect-integrated-runtime.ts`，先写导入：

<<< ../snippets/17/src/examples/inspect-integrated-runtime.ts#imports{ts}

再追加第一组完整检查：

<<< ../snippets/17/src/examples/inspect-integrated-runtime.ts#exits{ts}

expected 列出条件与应出现的任务结果，但实际结果仍由 runIntegratedScenario 运行原 Runtime 得到。检查前保存完整报告，失败时仍能查第一处差异。

正常场景同时核对独立调用数、用量和下一次输入的两项调用身份；拒绝场景核对具体 permission-denied 观察；其他几项应没有工具观察。共同检查还确认预算没有遗留活动凭条，实际请求能通过 runId 对上事件。

本文件使用断言自动拒绝不符合预期的行为，**用途就是测试**；仍沿用命令行检查，不新增单测框架。写完这一部分即可运行：

```bash
node src/examples/inspect-integrated-runtime.ts
```

应有六条“整合检查通过”。下面在同一文件继续追加，最终命令会包含后两项检查，不需要另建一套工程。

### 16. 检查真实进程接续，不借旧内存

继续在同一文件末尾追加：

<<< ../snippets/17/src/examples/inspect-integrated-runtime.ts#recovery{ts}

runNode 启动 pause 命令，等待退出，再启动 resume 命令。检查读取新进程的报告，确认 completed、没有 batch-started，并比较旧日志原文。

没有新的批次通知说明新段没有重新进入工具批次，但这项检查仍不能证明所有恢复场景都安全。未知写入、损坏会话与过期资源仍由第 13、17 篇的对应检查覆盖。

### 17. 同一进程创建两个实例

继续追加最后一组：

<<< ../snippets/17/src/examples/inspect-integrated-runtime.ts#isolation{ts}

本组故意用 Promise.all 同时运行两份组装。两边分别有自己的 root、保存目录、预算、报告数组和 Agent；即使工具调用都叫 source-1，也只在各自任务历史里使用，不需要全系统共享一张 ID 集合。

检查分别保留“任务 A”和“任务 B”的目标、不同运行身份及各自三次请求；再把返回的 a.state.messages 清空，确认两边实例留存结果均未受影响。调用方修改返回对象不应该成为修改内部 State 的通道。

这证明当前实现的实例数据边界，不等于操作系统租户隔离。两个可信实例仍在同一进程中，不能拿来执行彼此不信任的代码。

```bash
npm run check
node src/examples/inspect-integrated-runtime.ts
node src/examples/run-runtime-evaluations.ts
```

前一个运行命令应有六种出口、跨进程接续、两个实例共八条整合确认；后一个是第 17 篇原十项回归。它们覆盖的条件不同，不能只保留“正常一次 completed”。

## 调试时，从第一次偏离预期的地方查起

### 一个具体症状：第三次请求没带测试结果

先看 normal-report.json 的 result.state。没有 tests-1 时，继续看第二次传输返回的动作是否提出它、State 的 assistant 动作是否记录它；若提出过而 tool 观察是 error，检查 code/message 以及授权器到执行入口。

若 State 已有 tests-1 成功观察，却没有出现在最后一次 requests.messages 中，则调查 Context 选择和协议转换，不应先修改读取工具或把完成规则放宽。

这条排查路线上，State 说明程序留存了什么，requests 说明实际传给模型什么，trace 说明经过哪个阶段。三者互相核对，单看日志关键词无法替代。

### 怎样在原 Runtime 上停住

先用正常模式，在独立调试进程运行：

```bash
node --inspect-brk src/examples/run-integrated-runtime.ts normal
```

按顺序设置断点，不要求一次停遍所有辅助函数：

| 断点位置 | 此时检查什么 | 正常值或关系 |
|---|---|---|
| `agent-loop.ts` 构造 Context 后 | context.messages 与 state.messages | 首轮只有用户消息，第二轮包含两条 tool |
| `runtime-session.ts` 的 observeTransport | runId、requests.length、body.messages | 重试增加传输序号，runId 保持本段一致 |
| `authorization.ts` 调用 options.execute 前 | policy、operation、call.id | 读取获准，版本检查仍一致 |
| `recovery-store.ts` 的 wrap 实际执行前 | boundary.intents、signal | 意图已保存，停止检查未触发 |
| `agent-loop.ts` 追加 results 后 | state.messages、decisions | 加两条 tool，决策仍为 1 |
| `integrated-workspace.ts` 完成规则 | answer、observations | 两项身份与内容匹配 |
| `agent.ts` await resultSink.save 后 | result 与 lastResult | 保存已完成，调用即将返回 |

inspect-brk 会等调试器；连接后先继续执行。断点停留也会消耗运行中的五秒时限，长时间逐步调试可在候选实验中临时调大组装函数内的 timeoutMs，结束后恢复 5_000，再完整运行。不要把调试暂停造成的超时直接当成 Runtime 缺陷。

保存失败时 Agent 的 Promise 会拒绝，并不等于已有外部动作被撤销；旧记录也不应被当成最新成功结果。处理应沿 ResultSaveError 与恢复检查走，不能因为屏幕已经显示 run-ended 就跳过调查。

## 对照 Pi：比较职责，不按文件名逐个照抄

先能解释自己的正常轨迹，再打开固定提交 `8efd314` 对应的局部源码。下面是三个小范围阅读点，外链不是本章跟做前提。

| 本项目已经解决的问题 | Pi 对应阅读点 | 比较时注意什么 |
|---|---|---|
| 拒绝同一实例并发重入，管理运行结束 | [agent.ts：runWithLifecycle 与 finishRun](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/agent/src/agent.ts#L479) | Pi 持有 activeRun 并在生命周期结束后清理；本项目由 Agent 的活动控制器与 finally 管理 |
| 内部历史变成模型输入 | [agent-loop.ts：streamAssistantResponse](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/agent/src/agent-loop.ts#L354) | Pi 先 transformContext 再 convertToLlm；本项目先构造 DecisionContext，再做 DeepSeek 协议转换 |
| 工具执行前允许拒绝，执行顺序与记录顺序分别定义 | [types.ts：ToolExecutionMode、beforeToolCall](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/agent/src/types.ts#L36) | Pi 定义执行前钩子与并行记录语义；本项目有显式授权包装和第 8 篇批次执行器 |

有些原则相通，协议与保证却不相同。例如该版本 Pi 的事件处理会等待监听者；本项目事件总线不等待异步观察者。因此不能把 Pi 的监听器用法直接当成本项目的权限或持久化机制；本项目仍用明确的执行门禁和 resultSink。

Pi 的流式临时消息管理也不同于本项目“完整动作才写回”的教学协议。这不是哪个文件缺个同名方法，而是需要分别追踪状态更新和失败语义。对照的目标是能判断本项目取舍，不是证明已经实现全部 Pi 能力。

## Runtime 实现完了吗

### 已经完成的课程核心

| 能力 | 主要源码位置 | 用什么证据检查 |
|---|---|---|
| 决策、工具反馈、完成核对 | agent-loop、types、context | 本章 normal 与 early-finish |
| 工具契约、关联、批次与乱序 | tool、tool-executor、tool-batch | 第 4、8 篇与第 17 篇 parallel-order |
| 真实模型协议与完整流式动作 | adapters/deepseek | 第 6、7 篇及第 17 篇 stream-cut |
| 次数、时间、取消、迟到值 | run-control、agent-loop | 第 5 篇、第 17 篇 late-cancel 与本章 cancel |
| 输入选择、摘要和限制 | context-window、context-exchanges | 第 9 篇与本章 context-limit |
| 实例、观察与追加输入 | agent、events、input-queue | 第 10、11 篇与本章实例独立检查 |
| 日志、快照、保守恢复 | session-*、recovery-*、result-sink | 第 12、13、17 篇及本章进程接续 |
| 执行授权与演示隔离 | authorization、受限文件子进程 | 第 14 篇与第 17 篇拒绝/越界 |
| 安全局部重试与资源账本 | retry、dependency-error、model-budget、usage-ledger | 第 15、16、17 篇及本章请求计数 |

这些模块已经组成一套可运行、可解释、能验证明确边界的单机 Runtime。换一个任务，应替换工作区能力、模型配置与完成规则，继续使用相同核心循环；不用为“诊断”“检索”“审批”各写一个新的 while。

### 不能由课程验收推出的能力

- **不是完整 Coding Agent**：没有任意仓库编辑、构建测试执行与可靠补丁验证；固定诊断不能代表模型能修复未知项目。
- **不是通用模型框架**：当前适配器只支持已实现的 DeepSeek 协议子集，工具 schema 与消息形式也有范围。真实服务调用沿第 6、7 篇验证，本章没有联网验证当前模型服务。
- **不是生产沙箱**：私人目录、可信子进程与参数检查不提供容器/虚拟机、网络隔离、租户凭据保护和恶意代码安全保证。
- **不是任意状态恢复**：只接续检查通过的暂停结果，未知执行要阻止并调查；等待中的批准、输入队列和活跃 Promise 不会跨进程还原。
- **不是跨重启硬费用上限**：预算当前在内存中；未报告 usage 单独记账，估算单位不等于最终账单，也不会事先预知一次响应实际消耗。
- **不是全量可观测平台**：本地报告关联本段事件、模型输入和累计用量，没有每请求完整用量明细、跨进程分布式追踪或生产审计服务。

Context 目前按内部 JSON 字节选择输入，额外系统提示与工具说明不在这个测量中；摘要和完成证据如何保留，需要任务方继续设计。不能把 maxBytes 当成“服务商一定能装下且所有业务证据都不会丢”的保证。

所以本阶段结束的是已声明的实现范围，不是给所有企业场景盖章。后续若继续提升，应根据具体需求选择模型覆盖、耐久预算、更强隔离、恢复语义或真实任务评估；不需要为凑“高级功能”先加多 Agent、MCP 或 RAG。

## 本篇验收与整体复盘

```bash
npm run check
node src/examples/run-integrated-runtime.ts normal
node src/examples/inspect-integrated-runtime.ts
node src/examples/run-runtime-evaluations.ts
npm run site:build
```

另外完成一次新的 pause → 修改私人文件 → resume 被拒绝的实验，再用新目录重跑正常接续。报告、会话与旧源码都保留真实状态；不要修改期望值来让故障“通过”。

最后暂时不看代码，用自己的话走一遍“用户任务 → 模型请求 → 工具许可 → 意图保存 → 实际执行 → 状态反馈 → 完成验证 → 保存返回”。若某个箭头说不出调用方和返回值接到哪里，回到该段断点观察。命令通过证明这次行为符合检查，不证明已经掌握所有设计。

## 最终完整文件

以下仅用于核对，前面步骤已写过的内容不要再次追加。

<details>
<summary>examples/integrated-workspace.ts：完整文件</summary>

<<< ../snippets/17/src/examples/integrated-workspace.ts{ts}

</details>

<details>
<summary>examples/integrated-model.ts：完整文件</summary>

<<< ../snippets/17/src/examples/integrated-model.ts{ts}

</details>

<details>
<summary>application/runtime-session.ts：完整文件</summary>

<<< ../snippets/17/src/application/runtime-session.ts{ts}

</details>

<details>
<summary>examples/integrated-scenario.ts：完整文件</summary>

<<< ../snippets/17/src/examples/integrated-scenario.ts{ts}

</details>

<details>
<summary>examples/run-integrated-runtime.ts：完整文件</summary>

<<< ../snippets/17/src/examples/run-integrated-runtime.ts{ts}

</details>

<details>
<summary>examples/inspect-integrated-runtime.ts：完整文件</summary>

<<< ../snippets/17/src/examples/inspect-integrated-runtime.ts{ts}

</details>

## 保存本篇

确认故障实验只发生在私人目录，代码中的临时调试改动已恢复，并实际执行上面的验收命令后，再运行：

```bash
git status --short
git add src/application/runtime-session.ts \
  src/examples/integrated-workspace.ts \
  src/examples/integrated-model.ts \
  src/examples/integrated-scenario.ts \
  src/examples/run-integrated-runtime.ts \
  src/examples/inspect-integrated-runtime.ts \
  site/ AGENTS.md

git commit -F - <<'COMMIT'
第 18 篇：整合单机会话入口并复盘 Runtime 能力边界

连接模型传输、当前权限、执行意图、工具与结果保存，沿用原 Agent 循环。
用正常诊断、无证据完成、拒绝、额度不足和取消检查同一运行链。
验证跨进程接续和同进程双实例的数据独立，保留实际报告用于调试。
补充分步教程、系统图、Pi 局部对照和实现范围说明。

已运行工程检查、整合场景、第 17 篇回归与网站构建。
COMMIT

git push -u origin codex/chapter-17-system-integration
```

commit 保存到本地，push 上传本篇分支。命令由你执行；提交正文中的验证说明须与自己实际运行结果一致。
