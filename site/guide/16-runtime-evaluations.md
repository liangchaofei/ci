---
title: 第 17 篇｜让完整场景证明 Runtime 守住了什么
description: 从正常诊断的可核对证据出发，构建离线回归场景、判定规则与独立子进程运行器，验证断流、拒绝、迟到结果、乱序、预算与跨进程恢复。
---

# 第 17 篇：让完整场景证明 Runtime 守住了什么

第 16 篇正常任务能完成，账本也有数值，但这还不能说明各项机制组合后一直正确。比如结果已经保存在 State，却没被放进下一轮模型输入；或者用户拒绝写入后，程序因另一个错误退出，最后文件碰巧没变。只看 completed 或几行日志，都可能漏掉问题。

本篇建立一组**能重复运行、能自动判断、能留下证据的完整场景**。先沿正常诊断验证反馈闭环，再主动制造断流、权限拒绝、取消后的迟到返回、并行乱序、资源不足和恢复不确定性。

这里不增加 Agent Loop 功能。`src/evaluation/` 是验证 Runtime 的代码，从用途上说属于测试：它启动原 Agent、制造指定条件、检查实际结果。应用正常运行 Agent 时不需要导入它。与只检查某个函数的单元测试不同，本篇主要运行跨模块的完整场景，沿用命令行与证据文件，不引入单测框架或新的 `*.test.ts` 文件。

## 先看一个场景，怎样才能算通过

### 不是“打印成功”，而是核对三种证据

继续运行那条正常任务：第一次模型 HTTP 返回 503，重试后提出读取，工具返回源码，下一轮带着这份源码得到诊断。

我们希望核对：

1. **任务记录**：结束为 completed，接受两次决策，只有一个 read-1 工具观察。
2. **实际调用与数据**：服务替身确实被调用三次；下一次模型请求里确实有 read-1 的源码结果；用量和未知报告与第 16 篇相符。
3. **事件顺序**：先取得并记录动作，再启动工具，结果保存后才开始下一次决策；结束事件与返回的 Outcome 一致。

若只查第一项，“模型输入漏掉源码”的错误仍可能通过。若只查日志文字，甚至可能有人把错误打印成“完成”。所以本篇从实际返回值、传入依赖的数据和真实文件提取证据，再与**运行前定义的期望**比较。

Anthropic 的 Agent 评估说明也区分了任务、一次运行、判定器和环境最终结果：Agent 说“做完了”，与环境中实际完成是两回事。本篇借用这种区分，先评估 Runtime 的确定性行为，不给模型通用能力打分。[Anthropic：Agent 评估的组成](https://www.anthropic.com/research/demystifying-evals-for-ai-agents)

### 一次评估怎样走完

```text
先定义：输入、故障触发点、实际要提取什么、期望值是什么
  → 运行原 Agent
  → 收集 RunResult、事件摘要、调用计数或文件事实
  → 判定器逐项比较实际值与期望
  → 保存 evidence.json 与 verdict.json
  → 全量运行器汇总；任一场景不满足就返回非零退出码
```

场景是“一次任务加上特定运行条件”。故障注入是让某个依赖按指定方式失败，例如少发 [DONE]，或让读取结果晚于取消返回；**不是直接改最终 Outcome 来假装故障已经处理正确**。

判定器是检查证据的代码。本章使用明确的数据比较，不请另一个模型评价“看起来做得不错”。即使任务按预期返回 failed，场景也可以通过：断流本来就应该拒绝执行工具。

[![场景在隔离目录运行原 Runtime，证据由判定器与预先定义的期望比较，任务失败与评估失败分开表达](/diagrams/evaluation-evidence-flow.svg)](/diagrams/evaluation-evidence-flow.svg)

点击可放大。左侧是待检查的系统，右侧是观察与判定；判定器不会向 Runtime 写入一条“通过”消息。

### 本章场景清单

| ID | 故意改变什么 | 必须守住的行为 |
|---|---|---|
| normal | 第一次模型请求返回 503 | 恢复后完成；源码确实进入下一次模型输入 |
| request-limit | 只允许两次模型请求 | 第三次传输未启动，已有读取事实仍保留 |
| stream-cut | 工具参数完整，但流没有 [DONE] | 不接受动作，不调用工具，已报告用量仍保留 |
| write-denied | 人工回答拒绝 | 有明确拒绝观察，写执行体未启动，文件不变 |
| path-escape | 写请求指向私人工作区外 | 范围检查拒绝，实际执行体未启动 |
| late-cancel | 工具忽略停止，取消后才返回 | 结果和事件不因迟到值被改写 |
| parallel-order | 第二个工具先返回 | 完成顺序可变，保存的身份、值与请求顺序正确 |
| recovery | 保存暂停点后换进程继续 | 旧证据保留，新进程工具调用为零，旧日志不变 |
| unknown-write | 写完外部文件，未交回结果就退出 | 证明已有一次效果；恢复阻止自动重放 |
| stale-recovery | 暂停后资源发生变化 | 阻止使用旧证据接续，不改旧日志 |

十项场景的模型响应都是固定替身，部分工具返回也由实验控制。正常、权限和恢复场景的文件 I/O 真实发生；跨进程保存、退出与续运行也是真实的。这里验证协议与工程边界，不是验证模型能否修复任意代码，也不是生产压力测试。

## 前置版本与文件地图

完成并提交第 16 篇后，在仓库根目录运行：

```bash
git status --short
git switch -c codex/chapter-16-runtime-evaluations
npm run typecheck
```

已有分支时使用 `git switch codex/chapter-16-runtime-evaluations`。不新增依赖，不需要 API Key，不调用真实模型。

| 文件 | 变化 | 在运行链里做什么 |
|---|---|---|
| src/examples/budget-scenario.ts | 局部修改 | 保存实际传给离线模型依赖的请求体副本 |
| src/evaluation/contracts.ts | 新增 | 场景、证据、条件与判定结果的类型 |
| src/evaluation/evidence.ts | 新增 | 采集事件摘要、共用规则、读回证据检查 |
| src/evaluation/grader.ts | 新增 | 逐项比较实际值与期望，出错也判失败 |
| src/evaluation/cases/normal.ts | 新增 | 正常反馈闭环与请求额度两项场景 |
| src/examples/inspect-runtime-evaluation.ts | 新增，独立命令 | 最早运行一项真实场景并判定 |
| src/evaluation/cases/stream.ts | 新增 | 少发结束标志，检查不执行 |
| src/evaluation/cases/permissions.ts | 新增 | 人工拒绝与路径越界，检查执行体和文件 |
| src/evaluation/deferred.ts | 新增 | 手工决定依赖返回时刻 |
| src/evaluation/cases/concurrency.ts | 新增 | 取消后返回、并行乱序两项场景 |
| src/evaluation/process.ts | 新增 | 启动固定 Node 子进程并保留异常输出 |
| src/evaluation/recovery-leg.ts | 新增，子进程入口 | 分别保存或接续第 13 篇的会话 |
| src/evaluation/cases/recovery.ts | 新增 | 跨进程接续、未知写入与资源变化三项场景 |
| src/evaluation/cases/index.ts | 新增 | 汇总已知场景清单 |
| src/evaluation/case-worker.ts | 新增，子进程入口 | 只运行选中的一项并保存证据 |
| src/evaluation/runner.ts | 新增 | 每项独立运行，收集、判定与汇总 |
| src/examples/run-runtime-evaluations.ts | 新增，独立命令 | 选择单项或全量运行，设置退出码 |

共 16 个新增文件、1 个修改文件；阶段四另检查第 13 篇可选故障装置，缺失时给出完整补齐代码。新目录中的代码服务于评估，不是 Agent 的生产执行路径；runtime/ 内的循环、控制、权限、资源与保存代码都保留。

先把一项正常场景跑通，再加入故障与全量运行器。标为**“讲解摘录（无需写入文件）”**的代码已经包含在上方完整实现里，不要重复追加；章末收齐最终文件。

## 阶段一：先让正常任务有一个可核对的结论

### 1. 分清证据与期望

新建 src/evaluation/contracts.ts：

<<< ../snippets/16/src/evaluation/contracts.ts#contracts{ts}

Evidence 的 result 是原 Runtime 的 RunResult；trace 是事件摘要；facts 是场景额外采集的数据，例如调用次数、输入或文件是否变化。写后崩溃的子进程没有正常 RunResult，因此允许 result 为 null，不虚构一个 completed 或 cancelled。

Criterion 包含实际值提取函数 actual 与固定 expected。比如 actual 从账本取 requests，expected 是运行前写下的数字 3。EvaluationCase 将运行函数和这些规则放在同一个声明里，但判定器只在运行结束后读取证据。

CheckResult 是一项条件的判定；Verdict 是整个场景的判定。它们与 Runtime 的 Outcome 分开。例如 Outcome 为 failed，正好符合断流规则时，Verdict.passed 仍为 true。

这里只定义数据，不执行任务或写 State。Evidence 中的 facts 是 unknown 字段，提取失败或形状不对都不能默认为通过。

### 2. 收集真实实例的事件摘要

新建 src/evaluation/evidence.ts，先写入导入：

<<< ../snippets/16/src/evaluation/evidence.ts#imports{ts}

继续追加观察与共用规则：

<<< ../snippets/16/src/evaluation/evidence.ts#observe{ts}

observe 订阅已创建的 Agent，返回将逐步填充的数组。运行前调用它，才能从 run-started 开始记录。订阅回调复制 runId、seq、type，结束时再保存 outcomeStatus；它没有修改状态，也没有决定权限。

这份 trace 是**事件摘要**，不是完整的模型请求与响应记录。完整任务消息仍在 result.state；额外输入与文件事实放到 facts。

runCriteria 返回四项跨正常运行共用的规则：序号从 1 连续、只有一个 runId、只报告一次结束、最后报告与返回结果一致。actual 读取事实，expected 是固定值。`...runCriteria()` 稍后把这些规则加入各个场景，不会在这里启动 Agent。

本步骤先不写读回解析器，它会在全量运行器开始读子进程文件之前追加。

### 3. 每项比较失败，都必须留在结论里

新建 src/evaluation/grader.ts：

<<< ../snippets/16/src/evaluation/grader.ts#grader{ts}

grade 接收一份场景定义和一次实际证据，逐项得到实际值，做严格的深比较。数字 3 不等于字符串 "3"；数组和对象则按内容与结构比较，而不是要求引用相同。这些行为来自 Node 的 isDeepStrictEqual。[Node 深严格比较](https://nodejs.org/download/release/v22.18.0/docs/api/util.html#utilisdeepstrictequalval1-val2)

**讲解摘录（无需写入文件）：**

<<< ../snippets/16/src/evaluation/grader.ts#compare{ts}

以“请求次数期望 3”为例：actual 得到数字 3，就保存 expected 3、actual 3、passed true；得到 2 就是 false。拿不到字段时保存可见的 `<missing>`，但比较用的仍是原始 undefined，不把它偷偷变成 0。

每个提取函数收到独立副本，避免第一项检查改掉 facts，影响下一项。提取或解析抛错，也会记录失败与原因；零条规则直接抛错，不能靠“没有失败项”获得通过。

最后 checks.every 要求所有条件通过。这个文件不知道如何发模型请求，只负责从证据得出可审查的结果；规则本身是否覆盖了真正风险，仍需要作者检查。

### 4. 正常场景要看实际模型输入，先补观察点

修改 src/examples/budget-scenario.ts，不改变原 Agent、预算和工具组装。

找到 `const fixture = createBudgetModelFixture();`，在其后追加：

<<< ../snippets/16/src/examples/budget-scenario.ts#capture{ts}

再将同一函数中 `http: { fetch: fixture.send, ... }` 的 fetch 值替换为 send，其余预算与重试配置保留。最后，将返回语句替换为：

```ts
return { agent, budget, fixture, requestBodies };
```

send 记录的不是“准备发送”的猜测，而是正式 HTTP 适配器实际传给传输依赖的 body。它解析 JSON、确认对象、保存副本，然后调用原 fixture.send，所以响应与重试过程不变。只保存 body，不保存 Authorization 头。

requestBodies 由本次场景组装创建，依赖每被调用一次就追加一次。它不属于 State，也不会反过来修改 Context。旧入口只取 agent、budget，仍可继续运行；本章多取这份观察数据。

### 5. 定义正常场景与运行前固定的标准

新建 src/evaluation/cases/normal.ts：

<<< ../snippets/16/src/evaluation/cases/normal.ts#normal{ts}

先沿 run 走：复用第 16 篇的组装对象 → 订阅事件 → 调用 agent.run → 接住真实结果 → 保存账本副本、服务替身计数、最后一份模型消息和实际工具观察身份。这里没有把 expected 填进 facts，也没有自己写一个 completed。

criteria 分别核对结果、账本、真实依赖调用与事件阶段。requests 来自门禁，httpCalls 来自服务替身；两处都检查，是为了发现“账本少计了，但依赖实际多发了”的错误。

**讲解摘录（无需写入文件）：**

<<< ../snippets/16/src/evaluation/cases/normal.ts#feedback{ts}

最后一次模型请求应含 role 为 tool、身份为 read-1 的消息，其 content 是第 6 篇协议序列化的 ToolResult。解析后 value.content 必须等于这次副本源码。这样才能证明“源码结果不仅保存了，还实际进入下一次模型请求”。字段缺失、JSON 无效或内容不符，都不能通过。

本例固定八个事件阶段顺序，属于这条正常任务的协议检查，不要求所有 Agent 任务都长这样。common rules 再检查身份、序号和结束一致性。

### 6. 第一个可运行检查点：执行一项，再查看判定

新建独立入口 src/examples/inspect-runtime-evaluation.ts：

<<< ../snippets/16/src/examples/inspect-runtime-evaluation.ts#run{ts}

这个命令只运行 normal。创建独立目录并切换本进程工作目录后，第 16 篇副本函数创建的数据也归入这里；不会改变调用它的终端工作目录。grade 只在原任务返回后执行，不影响任务过程。

```bash
npm run typecheck
node src/examples/inspect-runtime-evaluation.ts
```

应看到各项“通过”，以及本次证据目录。打开 evidence.json，确认它来自实际运行；再打开 verdict.json，对照每条 expected 与 actual。目录每次不同，不要查看旧一轮产物。

若有条件失败，命令以 1 结束；成功以 0 结束。此时还没有完整场景子进程运行器，先把“运行 → 收证据 → 判定”这条最小过程走通。

## 阶段二：让失败路径也有明确标准

### 7. 请求额度不足，应该保留什么

继续在 src/evaluation/cases/normal.ts 末尾追加：

<<< ../snippets/16/src/evaluation/cases/normal.ts#budget{ts}

这次只将 maxRequests 改为 2，运行原组装。前两次模型尝试用完名额，读取结果仍写入 State；下一次模型传输启动前返回 resource-limit。

规则同时检查资源类别、门禁计数、实际服务替身调用数以及保留的工具结果。只查 resource-limit 文字，不能证明没有第三次调用；只查请求数，也不能证明原读取结果没被清掉。

这个文件现在导出两份场景定义，先前的单项命令仍只运行 normal。全量运行器稍后再将两者列入清单。

### 8. 流里参数已经完整，也不能提前执行

新建 src/evaluation/cases/stream.ts：

<<< ../snippets/16/src/evaluation/cases/stream.ts#stream{ts}

故障位于 HTTP 替身：发出一份内容事件，其中工具参数和结束原因都完整，但不发送 [DONE]。原 SSE 读取、动作收集、用量账本与 Agent 都照常执行。

工具执行依赖外有 executions 计数。若 Runtime 错把工具参数完整当成流已正常结束，它就会增加计数；正确行为是 EOF 后返回决策失败，已记录决策仍为 0、执行仍为 0。

判定还核对原因确实是缺少 [DONE]，以及已报告 20 token 没有被抹去。这样不会把“分片本来就写错，早早解析失败”误当成断流保护通过。

此场景的工具返回值是实验替身，没有真实文件操作；它检查“执行入口有没有被触发”。真实文件事实由正常、权限与恢复场景覆盖。

### 9. 拒绝与越界，共用同一份真实副本

新建 src/evaluation/cases/permissions.ts，先写入导入：

<<< ../snippets/16/src/evaluation/cases/permissions.ts#imports{ts}

再追加完整运行函数：

<<< ../snippets/16/src/evaluation/cases/permissions.ts#run{ts}

先看 escape 为 false：复用第 14 篇脚本，先读、再提出写；approve 固定回答 false。executed 只在许可入口真正调用执行依赖时追加工具名，所以应该只有 read_source。前后两次读取真实文件，再比较是否变化。

escape 为 true 时，实验脚本直接提出路径越界的写请求。relative(root, outside) 计算通向实际旁侧文件的相对路径，避免请求指向一个不存在、根本不会被改到的位置。第 14 篇检查器只允许 sum.ts，因此应在执行前拒绝。

返回的 facts 包括真实执行依赖的调用名单、文件前后比较和工具错误。错误的 reason 取本项目当前消息中冒号前的类别，只用于回归定位；不会拿它安排 Runtime 重试。

继续追加两份场景声明：

<<< ../snippets/16/src/evaluation/cases/permissions.ts#cases{ts}

write-denied 必须观察到 approval-denied；path-escape 必须观察到 scope-denied。两项再共同检查任务结束、原文件与旁侧文件不变。**停止了还不够，必须在我们准备验证的那个保护点停止。**

fileCriteria 复用相同文件条件，两个 run 通过 escape 参数选择实验输入；不是重写第二套权限实现。模块最终仍由评估运行器调用，文件本身不会在 import 时运行任务。

## 阶段三：主动决定返回顺序，不靠睡眠碰运气

### 10. 给实验一只明确的“返回开关”

新建 src/evaluation/deferred.ts：

<<< ../snippets/16/src/evaluation/deferred.ts#deferred{ts}

deferred 创建一份 Promise，但暂时不交回结果。实验拿 promise 给依赖等待，之后由 resolve 指定具体值。比如“两个读取都已开始”以后，才允许测试返回；收到它已返回的确认以后，才允许源码返回。

`resolve!` 是 TypeScript 的确定赋值声明：Promise 构造器同步调用初始化函数，所以函数返回前 resolve 已被设置。它不表示忽略运行错误，也不会把 Promise 自动完成。

nextTurn 用 setImmediate 等一轮事件循环，让已安排的 Promise 回调有机会执行。它不是拿一个任意的 30ms 推测谁先结束；真正的先后仍由本章的开关与确认 Promise 决定。

### 11. 取消之后，再故意送回结果

新建 src/evaluation/cases/concurrency.ts，先写入导入：

<<< ../snippets/16/src/evaluation/cases/concurrency.ts#imports{ts}

继续追加取消场景：

<<< ../snippets/16/src/evaluation/cases/concurrency.ts#cancel{ts}

这个执行依赖有意忽略 signal，开始时通知 started，然后一直等 late.promise。run 先启动原 Agent；收到 started 后才发取消，避免在工具还没开始时就取消而测不到迟到路径。

**讲解摘录（无需写入文件）：**

<<< ../snippets/16/src/evaluation/cases/concurrency.ts#late-return{ts}

await pending 得到已取消的结果后，先保存实例结果与事件摘要的文本快照；再放开 late，让依赖真实返回一个成功 ToolResult。等它确认返回，再等一轮回调，最后比较结果与事件是否仍与取消时相同。

仅检查 outcome 为 cancelled 不够：如果迟到值又补进了 State，任务表面仍可能写 cancelled。这里同时检查实例结果不变、没有新增 tool 观察，也没有结束后的补发事件。

这个场景没有模拟写操作，不宣称取消能回滚外部副作用；它验证的是第 5 篇的等待与状态保护。

### 12. 第二个先结束，记录仍按请求对应

继续在同一文件末尾追加并行场景：

<<< ../snippets/16/src/evaluation/cases/concurrency.ts#parallel{ts}

脚本先提出 source-1 与 tests-1。两个执行依赖都开始后，bothStarted 才完成，证明它们确实同时在等待；peak 也必须为 2，避免“其实串行了，顺序自然正确”的假通过。

**讲解摘录（无需写入文件）：**

<<< ../snippets/16/src/evaluation/cases/concurrency.ts#release-order{ts}

先放开 tests，收到它的返回确认后再放开 source，因此 completed 必须是 tests-1、source-1。原第 8 篇批次执行器收齐后，State 的 tool 消息应仍是 source-1 配 source、tests-1 配 tests。

判定把身份和值一起比较：只查 ID 顺序，可能漏掉值写错位置。这个模块的两个场景都控制依赖返回时刻，生产代码没有读取这些开关，也没有新增一套并发调度。

## 阶段四：进程真的退出以后，再检查恢复依据

### 13. 用固定 Node 子进程运行破坏性实验

新建 src/evaluation/process.ts：

<<< ../snippets/16/src/evaluation/process.ts#process{ts}

runNode 接收已知脚本路径、参数、工作目录与预期退出码，直接用当前 Node 执行，不经过 shell。env 为空，避免将父进程环境中的密钥带入离线实验。

每次子调用最多 10 秒，每路输出限制为 1,000,000 字节。意外退出、超时或输出上限触发，都应拒绝这次调用；错误对象保留 stdout 与 stderr，便于最后写入调试文件。[Node execFile 的时间与输出限制](https://nodejs.org/download/release/v22.18.0/docs/api/child_process.html#child_processexecfilefile-args-options-callback)

默认预期退出为 0。稍后的写后崩溃实验明确预期 23，只有确实以该值退出才继续核对文件；不能把“任何异常退出”都算造出了正确故障。

这是可信场景代码的运行工具。独立进程与 cwd 提供内存、工作目录上的分离，不是恶意代码沙箱，也不保证终止一棵任意的后代进程树。场景只运行仓库里已知脚本。

### 14. 保存与续运行必须处在两个进程

新建子进程入口 src/evaluation/recovery-leg.ts，先写入导入：

<<< ../snippets/16/src/evaluation/recovery-leg.ts#imports{ts}

再追加运行部分：

<<< ../snippets/16/src/evaluation/recovery-leg.ts#run{ts}

这份入口从第 13 篇迁移已有组装，不新增恢复协议。save 模式创建 saved 会话，读取两项材料后请求暂停；resume 模式先 inspectRecovery，通过才创建新保存器、安装暂停状态，再接收已有的 steerText。

计数包在实际 execute 外面：原工具真正被调用才 executions 加一。每个进程写自己的 save-evidence.json 或 resume-evidence.json，里面是实际 result、事件摘要与计数，而不是打印一行“应该执行 0 次”。finally 沿用原保存器关闭。

这个文件有顶层运行代码，所以不会在评估父进程 import 执行；下一步只取得其绝对路径，通过 runNode 启动两次。

### 15. 读回 JSON 后，先检查它真是证据

回到 src/evaluation/evidence.ts，在 runCriteria 之后追加：

<<< ../snippets/16/src/evaluation/evidence.ts#decode{ts}

JSON.parse 只产生未知数据。readEvidence 先核对对象与 trace 形状，再复用原 session-codec 检查非空 RunResult。临时的 sessionId 等字段只借用已有结果解析器，不创建会话或修改磁盘。

facts 仍是待各项规则提取的未知字段；缺字段导致实际值缺失或提取报错，就判失败，不会默认成功。result 为 null 是协议明确允许的崩溃证据形态，不是忽略一个错误的 RunResult。

### 16. 核对跨进程接续，旧证据是否保留

新建 src/evaluation/cases/recovery.ts，先写入导入：

<<< ../snippets/16/src/evaluation/cases/recovery.ts#imports{ts}

再追加正常接续场景：

<<< ../snippets/16/src/evaluation/cases/recovery.ts#resume{ts}

run 先启动 save 进程，读回证据，保存旧 journal 原文；该进程退出后才启动 resume 进程。最后读第二份证据，并比较旧日志原文和历史消息前缀。

期望是旧进程 paused、实际执行 2 项工具；新进程 completed、实际执行 0 项；原消息前缀与旧日志均保留。第二份 trace 只属于新进程这一段运行，所以共用事件规则仍要求一个 runId，不把两段序号强行拼成一段。

保存与接续两份证据均通过 readEvidence 检查后，再进入比较。完成本阶段可先运行 `npm run typecheck`，全量运行入口会在下一阶段接上。

### 17. 写入发生了，进程却没交回结果

本项复用第 13 篇可选故障实验中的 `src/examples/crash-after-write.ts`。先确认文件存在：

```bash
test -f src/examples/crash-after-write.ts
```

命令没有输出且成功即可。若文件缺失，先按下面完整代码新建；已有文件且与下面一致则保留。这是旧实验装置的补齐，不修改 Runtime 恢复机制。

<details>
<summary>缺失时补齐：src/examples/crash-after-write.ts</summary>

<<< ../snippets/16/src/examples/crash-after-write.ts{ts}

</details>

入口收到父进程传来的私人目录，创建原 Agent 与 RecoveryStore。实际执行体只允许 append_mark：向 effect.log 追加一行并同步到磁盘，随后以 23 退出；它故意不交回 ToolResult，也不走正常保存结束。恢复检查因此必须面对“效果已发生，但结果未知”，不能当成未执行。

现在继续在 src/evaluation/cases/recovery.ts 追加未知写入场景：

<<< ../snippets/16/src/evaluation/cases/recovery.ts#crash{ts}

这里启动第 13 篇已经存在的 crash-after-write.ts：它先在本场景目录追加一行并同步，再以 23 退出，来不及返回 ToolResult。之后只调用恢复检查器。

证据必须同时包括：真实文件有一行，退出码为 23，恢复结果 blocked，待核查调用为 write-1，检查后文件没有变成两行。只查 blocked，不能证明我们真的造出了写后未知的情况；只查一行，又不能证明恢复会阻止盲目接续。

result 为 null、trace 为空，是因为这次故障进程没有正常返回结果。它不套用“必须有 run-ended”的正常结束规则，而是使用明确的退出与磁盘证据。

### 18. 已保存的资源后来改变了

继续在同一文件末尾追加：

<<< ../snippets/16/src/evaluation/cases/recovery.ts#stale{ts}

先用同一个 save 入口得到合法暂停点，再改真实工作区的 sum.ts，最后用当前环境调用 inspectRecovery。期望被阻止的原因确实是资源或工具授权改变，旧 journal 保持原文。

这项检查不尝试“给旧证据改个新版本”来让它通过。它检查第 13 篇恢复前置条件，既不授予新权限，也不声明已经实现任意崩溃的自动修复。

## 阶段五：一项一个进程，汇总成可重复运行的套件

### 19. 汇总已有场景，工作进程只选择其中一项

新建 src/evaluation/cases/index.ts：

<<< ../snippets/16/src/evaluation/cases/index.ts#cases{ts}

这里只导入声明并组成清单，导入时不会启动任务。ID 固定在代码中，命令行不接受一段模型提供的脚本来执行。

新建子进程入口 src/evaluation/case-worker.ts：

<<< ../snippets/16/src/evaluation/case-worker.ts#worker{ts}

父运行器传入 ID 与新目录。worker 找到已知定义，调用其 run，完成后只写 evidence.json。它不作“全部通过”的判断；判定标准仍由父运行器应用到读回证据上。

wx 避免覆盖已经存在的证据文件。每次新建目录，也避免 worker 失败后误读上次遗留的成功产物。业务依赖的打印仍走标准输出，证据用文件传递，不从一屏日志里猜 JSON 起点。

### 20. 逐项收集和判定，错误也必须计入汇总

新建 src/evaluation/runner.ts，先写入导入：

<<< ../snippets/16/src/evaluation/runner.ts#imports{ts}

继续追加完整运行器：

<<< ../snippets/16/src/evaluation/runner.ts#runner{ts}

runEvaluations 先拒绝空清单与重复 ID，再创建本次总目录。每个 ID 得到一个子目录，并作为 worker 的 cwd；这让原副本函数也把文件写进该场景自己的 .agent-data 中。

**讲解摘录（无需写入文件）：**

<<< ../snippets/16/src/evaluation/runner.ts#collect{ts}

worker 正常退出后，先保存输出，再读取 evidence.json、检查形状、应用预先定义的 criteria。grade 产生 verdict，父运行器不根据子进程有没有打印“完成”打分。

子进程异常、证据缺失、JSON 无效等会进入 catch，形成 passed: false 和 error。若是 ChildRunError，也把捕获的输出保存下来。**运行器出错不等于场景预期的任务 failed**：前者没有足够证据完成判定，后者可以被规则明确验证。

一项失败后仍继续其他项，让 report.json 给出整套结果；最后要求所有 Verdict.passed 为 true。全量场景按顺序运行，只有 parallel-order 内部故意制造并发，避免共享实验条件造成干扰。

这个文件的完整调用链是：CLI 给清单 → runner 建目录 → runNode 启动 case-worker → 场景运行原 Runtime → evidence.json 返回父进程 → grade → verdict/report 文件。它没有变成模型依赖，也没有导入到 agent-loop.ts。

[![父运行器逐项启动工作进程，场景文件运行原 Agent 并收集证据；父进程读回证据判定，恢复场景内部另启保存与接续进程](/diagrams/evaluation-processes.svg)](/diagrams/evaluation-processes.svg)

点击可放大。图里的多次 Node 启动是评估装置；原 Agent Runtime 的业务执行链没有换成这个运行器。

### 21. 独立命令负责选择与退出码

新建 src/examples/run-runtime-evaluations.ts：

<<< ../snippets/16/src/examples/run-runtime-evaluations.ts#run{ts}

不传 ID 就跑全部；传 normal 只跑该项；未知 ID 直接报错，不能跑了零项还打印全部通过。最后的 process.exitCode 只决定命令成功或失败，不改变原任务 Outcome。

```bash
npm run typecheck
node src/examples/run-runtime-evaluations.ts normal
node src/examples/run-runtime-evaluations.ts
```

全量预期有十项“通过”，最后“全部通过”。在终端复制本次输出目录，查看以下结构：

```text
report.json
normal/
  evidence.json
  verdict.json
  stdout.log
  stderr.log
stream-cut/
  ...
recovery/
  evidence.json
  save-evidence.json
  resume-evidence.json
  saved/
  resumed/
  ...
```

这是运行产物示意，不需要手工创建。正常证据目录位于已忽略的 .agent-data/，不会自动加入 Git。失败时可能没有 evidence.json，这本身就是运行器记录 error 的原因；先看 verdict 和输出日志。

## 阶段六：确认判定器真的会说“不通过”

### 22. 故意写错一项期望，再恢复

在 src/evaluation/cases/normal.ts 找到名称为“服务替身实际调用为三次”的规则，**仅将它的 expected 从 3 临时改为 2**。其他规则、实际运行代码和计数都不改。

```bash
node src/examples/run-runtime-evaluations.ts normal
echo $?
```

应看到“存在失败”，退出码为 1。打开这次 normal/verdict.json，找到类似记录：

```json
{
  "name": "服务替身实际调用为三次",
  "expected": 2,
  "actual": 3,
  "passed": false
}
```

这是观察示例，不追加到源文件。原 Agent 仍可能 completed，但评估发现它不符合当前规则；报告能指出实际值与期望差在哪，而不是只显示一个红色失败。

随后把 expected 恢复为 3，再运行单项与全量，确认通过。这一步检查的是评估装置能否发现不一致，不是证明“改期望就修好了 Runtime”。真实问题出现时，应先核对原需求、证据与实现，不能一律把规则改成当前输出。

### 23. 再做一次独立推理

先不改代码，判断两种情况应在哪项失败：

- 若 State 有 read-1，但最后一次模型输入不含 tool 消息，哪条规则应拦住？
- 若两个工具保存顺序正确，但它们从未同时等待，哪条规则能发现退回了串行？

然后到 normal 的输入规则与 parallel-order 的 peak 规则核对。能找到证据来源、期望与对应控制位置，比只记住“全部通过”更有用。

## 调试顺序：先分清运行失败还是规则不符

单项快速调试可以直接运行：

```bash
node --inspect-brk src/examples/inspect-runtime-evaluation.ts
```

它在当前进程只跑 normal，适合观察 grader 与实际证据。全量运行器会另启 worker，父进程调试器不会自动附着；需要调某个故障场景时，先使用单项命令与已保存证据定位，不为了显示日志改 Runtime 控制流。

| 看到什么 | 先检查什么 |
|---|---|
| verdict 有 error、checks 为空 | 子进程退出、超时、stdout/stderr、证据文件是否生成 |
| checks 中实际值为 `<missing>` | 证据采集是否漏字段、规则是否取错位置 |
| Outcome failed，但场景通过 | 是否正好符合该故障的预期，例如断流不执行 |
| Outcome completed，但场景失败 | 哪条数据、身份、计数或事件条件不符 |
| 恢复场景失败 | 分别看 save/resume 证据与旧日志，不从最终一句话倒推 |
| 并行场景挂起 | 检查两个依赖是否都启动、释放开关是否到达；工作进程超时只是防止整套一直挂住 |

十秒子调用上限是本地评估的保护阈值，不是 Runtime 的服务时限或性能承诺。环境过慢、子进程无法启动都可能造成运行器失败，应保留证据调查；不能用一条“超时失败”就断言某项 Agent 协议一定实现错误。

评估文件仍是可信代码。独立进程不能防御它读取任意文件、访问网络或启动其他程序；本章固定离线依赖与临时副本，也没有给运行器赋予自动提交、推送或生产操作权限。

## 对照 Pi：固定替身用来控制工程条件

Pi 固定版本的 Agent Core 测试会注入模型响应流和工具实现，收集事件与最终消息后检查；其中也检查并行工具是否在第一个尚未结束时启动第二个。目的在于控制条件、检查循环行为，而非依赖一次真实模型随机回答。[Pi 循环与并行行为验证](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/agent/test/agent-loop.test.ts#L967)

本章沿用相同的工程思路，形式保持为命令行场景与 JSON 证据。它不是 Pi 的测试框架移植，也没有因为固定替身全通过就证明真实模型任务成功率。

真实模型会随输入、采样和服务状态变化。以后若评估“能否修复多种项目”，还要准备有代表性的任务、独立环境结果、重复运行与失败分析；本章十项确定性回归只覆盖声明的边界，不覆盖所有上下文裁剪、工具类型或平台故障。

## 本篇验收

```bash
npm run check
node src/examples/inspect-runtime-evaluation.ts
node src/examples/run-runtime-evaluations.ts
```

确认单项能留下实际证据，全量十项通过；再按阶段六验证错误期望会得到非零退出码，恢复后通过。源码、参数和规则恢复为章末版本再保存。

本章交付的是一套可以反复检查现有 Runtime 的场景，不是再加一组互不关联的演示。正常反馈、权限、取消、并发、预算和恢复，都由原来的实现执行；判定依据与产物位置明确，可以在以后改代码时重新运行。

## 最终完整文件

前面的步骤写完已经构成这些文件。此处仅供核对，不要再次追加；唯一修改的 budget-scenario.ts 也提供完整版本。

<details>
<summary>src/examples/budget-scenario.ts</summary>

<<< ../snippets/16/src/examples/budget-scenario.ts{ts}

</details>

<details>
<summary>src/evaluation/contracts.ts</summary>

<<< ../snippets/16/src/evaluation/contracts.ts{ts}

</details>

<details>
<summary>src/evaluation/evidence.ts</summary>

<<< ../snippets/16/src/evaluation/evidence.ts{ts}

</details>

<details>
<summary>src/evaluation/grader.ts</summary>

<<< ../snippets/16/src/evaluation/grader.ts{ts}

</details>

<details>
<summary>src/evaluation/cases/normal.ts</summary>

<<< ../snippets/16/src/evaluation/cases/normal.ts{ts}

</details>

<details>
<summary>src/examples/inspect-runtime-evaluation.ts</summary>

<<< ../snippets/16/src/examples/inspect-runtime-evaluation.ts{ts}

</details>

<details>
<summary>src/evaluation/deferred.ts</summary>

<<< ../snippets/16/src/evaluation/deferred.ts{ts}

</details>

<details>
<summary>src/evaluation/cases/stream.ts</summary>

<<< ../snippets/16/src/evaluation/cases/stream.ts{ts}

</details>

<details>
<summary>src/evaluation/cases/permissions.ts</summary>

<<< ../snippets/16/src/evaluation/cases/permissions.ts{ts}

</details>

<details>
<summary>src/evaluation/cases/concurrency.ts</summary>

<<< ../snippets/16/src/evaluation/cases/concurrency.ts{ts}

</details>

<details>
<summary>src/evaluation/process.ts</summary>

<<< ../snippets/16/src/evaluation/process.ts{ts}

</details>

<details>
<summary>src/evaluation/recovery-leg.ts</summary>

<<< ../snippets/16/src/evaluation/recovery-leg.ts{ts}

</details>

<details>
<summary>src/evaluation/cases/recovery.ts</summary>

<<< ../snippets/16/src/evaluation/cases/recovery.ts{ts}

</details>

<details>
<summary>src/evaluation/cases/index.ts</summary>

<<< ../snippets/16/src/evaluation/cases/index.ts{ts}

</details>

<details>
<summary>src/evaluation/case-worker.ts</summary>

<<< ../snippets/16/src/evaluation/case-worker.ts{ts}

</details>

<details>
<summary>src/evaluation/runner.ts</summary>

<<< ../snippets/16/src/evaluation/runner.ts{ts}

</details>

<details>
<summary>src/examples/run-runtime-evaluations.ts</summary>

<<< ../snippets/16/src/examples/run-runtime-evaluations.ts{ts}

</details>

## 保存本章

恢复临时改错的 expected，确认检查与运行结果符合实际，再执行：

```bash
git add src/evaluation/ src/examples/crash-after-write.ts \
  src/examples/budget-scenario.ts \
  src/examples/inspect-runtime-evaluation.ts \
  src/examples/run-runtime-evaluations.ts \
  site/ AGENTS.md TUTORIAL-WRITING.md
git commit -F - <<'COMMIT'
第 17 篇：用完整场景评估运行边界并保留证据

为正常反馈、预算、断流、拒绝、取消与并发定义可核对的标准。
增加跨进程恢复、资源变化和写后未知副作用的独立场景。
按场景运行子进程，保存证据、逐项判定与汇总报告。
规则不符或运行器出错均返回失败，不修改原 Runtime 控制流。
补充分步实现、流程图、失败定位与判定器反向验证。
COMMIT
git push -u origin codex/chapter-16-runtime-evaluations
```

命令由本地执行，阅读网页不会自动提交或发布。运行产物保留在已忽略目录，不与源码一起提交。
