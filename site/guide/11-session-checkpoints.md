---
title: 第 11 篇｜把运行结果存下来
description: 从关闭终端后还能检查任务进度出发，实现追加式会话日志、版本校验、检查点替换、保存失败处理与跨进程只读重建。
---

# 第 11 篇：把运行结果存下来

两份源码与测试已经读完，Agent 暂停等你确认。终端关掉以后，它还记得这些内容吗？第 10 篇的答案是：**不记得。** State、输入队列和暂停结果都只在这个进程的内存里。

本篇要让一件事真正发生：把一段运行的结果写进文件，退出程序后，再用另一个命令读回，看到之前的任务、读取内容、用户要求和退出原因。读回时不再调用模型，也不重读工具。

这次先解决“已经保存了什么，怎样可信地读回来”。下一篇再解决“根据这些数据，能不能安全继续执行”。两者要分开：文件里有一条读取请求，不代表它肯定没有执行过。

## 先把本篇放进整体运行里

### 先走一次具体任务

仍然排查 `sum([])` 报错：

1. 用户提出任务，模型替身请求读取源码与测试。
2. Runtime 执行两项读取，把结果写进 State。
3. 实例请求暂停，循环返回 4 条消息、1 次决策与 paused。
4. **新增：实例等待保存器把这份结果写入磁盘，再把暂停结果交给调用方。**
5. 程序退出。另一个命令打开保存目录，读出原有 State，并从它重新构造模型输入。

前 3 步已经实现。本篇插在循环返回之后、Agent.run 返回之前：

```text
循环完成本段步骤，返回 { state, outcome }
       ↓
【本篇新增】等待结果保存：追加日志 → 更新检查点
       ↓
实例保存结果副本，释放忙碌标记，调用方 await 结束

退出当前进程
       ↓
新的只读进程：读取并检查日志 → 重建 State 与 Context
```

[![循环返回结果后，实例等待日志追加与检查点更新；另一个只读进程从日志重建状态和输入，不调用模型或工具](/diagrams/session-persistence-flow.svg)](/diagrams/session-persistence-flow.svg)

点击可放大。写回 State 仍发生在原循环里，磁盘保存使用它的副本。没有在循环中加入文件读写，也没有把保存当成一位可以忽略失败的事件观察者。

### State、Trace、日志、检查点各是什么

| 内容 | 本例保存什么 | 进程退出后是否还在 |
|---|---|---|
| State | 任务、完整消息、累计决策次数 | 原本只在内存；本篇将结束时的副本存入日志 |
| 第 9 篇 Trace | 开始、决策、写回、结束等过程通知 | 入口自己的数组不会自动落盘 |
| 会话日志 journal.jsonl | 一段运行结束时的完整 RunResult，加上版本与身份 | 写入成功后可由新进程读取 |
| 检查点 checkpoint.json | 最近一条日志记录的完整副本 | 可供查看和后续优化；本篇读回仍核对日志 |

**持久化**就是让数据离开进程内存，保存到进程退出后还可读取的介质。本篇使用本机文件，不引入数据库。

**快照**是在某个时刻复制下来的一整份状态。这里每条日志都带完整结果，检查点则保存最后一条的副本。先采用这种重复但直观的格式，不要求读者一开始就按细小事件重放状态；后续可以优化体积，不能把它称为已经实现完整事件溯源系统。

**追加式日志**表示新记录写在末尾，前一条保留。JSONL 是“一行一个 JSON 对象”的文本格式。本项目约定：换行结束才算一条完整记录，源码里的换行会被 JSON 转义，不会把一份记录拆成多行。

### 这篇能保存什么，暂时保存不了什么

保存的是**本段循环已经返回的 RunResult**：paused、completed、failed、cancelled 等已知结果都可以记录。尚在队列、还没写进 State 的文字、取消控制器、函数、密钥配置和模型连接不在这份结果里。

本篇不是每个工具步骤都实时写盘。如果进程在工具执行途中直接崩溃，最后一份保存记录可能落后于内存中的工作。读回程序只能说“最后已保存到这里”，不能说“之后肯定什么都没做”。第 12 篇会继续补执行意图与未知副作用处理。

因此，这里实现的是**按运行段保存与只读重建**。不要把 paused 的磁盘记录直接塞进 resume，就宣称任何崩溃后都可以安全接着跑。

## 同一任务里有三种编号

暂停后在同一进程继续，上一章会创建新的 runId 和事件 seq；本篇还要用 sessionId 把多段保存放进同一目录：

| 编号 | 意义 | 暂停段 → 继续段 |
|---|---|---|
| sessionId | 本次保存容器的名字，例如 lesson11 | 名字保持相同 |
| runId | 一次活动运行段的身份 | 从原报告器取得，每段不同 |
| 日志 seq | 这是会话里保存的第几条结果 | 1 → 2 |
| 事件 seq | 本段报告器的第几份通知 | 各自重新从 1 开始 |
| State.decisions | 此任务已记录的模型动作数 | 1 → 2，继续时不清零 |

这些编号不能互相代替。日志第 2 条不代表“第二次工具调用”；事件 #1 也不意味着状态被重新初始化。

## 推荐分支与前置版本

从已完成并提交的第 10 篇本地版本创建：

```bash
git switch -c codex/chapter-11-session-checkpoints
```

分支已存在时用 `git switch codex/chapter-11-session-checkpoints`。命令都在仓库根目录执行，不新增依赖。

```bash
npm run typecheck
node src/examples/inspect-input-agent.ts pause
```

先确认旧的“同进程暂停继续”仍正常。随后新增磁盘能力，不替换第 10 篇的输入队列。

::: info 验证范围
本篇候选代码在独立工程验证了文本往返、结构与版本拒绝、保存排队、关闭、跨进程读回、截断末尾、检查点落后、真实文件替换失败，以及保存期间的实例忙碌与输入关闭行为。未新增单测教学任务，未读取密钥或调用真实模型；本章实际新增的是文件读写机制，模型与读取工具继续使用可重复的替身。
:::

## 新增与修改的文件

先从能看到文件的最小步骤开始，再补日志、检查和实例集成。

| 文件 | 变化 | 本篇的作用 |
|---|---|---|
| `.gitignore` | 增加一行 | 排除运行生成的 .agent-data 目录 |
| `src/runtime/session-types.ts` | 新增 | 定义文件记录与读回结果 |
| `src/runtime/atomic-text-file.ts` | 新增 | 临时文件写完后替换目标文件 |
| `src/examples/inspect-checkpoint.ts` | 新增 | 先实际写出并读回一份已知记录 |
| `src/runtime/result-sink.ts` | 新增 | 定义实例必须等待的保存接口与保存错误 |
| `src/runtime/json-data.ts` | 新增 | 拒绝 JSON 无法完整表达的值 |
| `src/runtime/session-codec.ts` | 新增 | 校验版本、记录、消息与调用关系 |
| `src/runtime/session-store.ts` | 新增 | 单写入者、顺序追加、同步与检查点更新 |
| `src/runtime/session-reader.ts` | 新增 | 只读扫描日志，核对检查点 |
| `src/runtime/agent.ts` | 修改 | 循环返回后等待保存，再发布结果副本 |
| `src/examples/save-session.ts` | 新增 | 在原诊断任务上实际保存运行段 |
| `src/examples/inspect-session.ts` | 新增 | 新进程读回已有记录，重建全量输入 |
| `src/examples/inspect-session-faults.ts` | 新增 | 在自建临时目录中演示五类文件故障 |

共 12 个 TypeScript 文件，其中 11 个新增、1 个修改；另改忽略规则。原来的 agent-loop.ts、模型适配器与工具执行器不需要修改。讲解摘录仅供对照，已包含在对应完整代码中，**无需再次写入、追加或替换文件**。

## 阶段一：先真的写一个文件，再读回来

### 1. 排除运行生成的数据

确保 `.gitignore` 中有以下一行；已有时不要重复添加：

```gitignore
.agent-data/
```

这是程序运行时的本地数据，不是 Runtime 源码。教程与参考实现仍在 site/，不受这条规则影响。忽略规则不会删除文件，也不会替你清除已经被 Git 跟踪的旧数据。

### 2. 定义一条记录的形状

新建 `src/runtime/session-types.ts`：

<<< ../snippets/11/src/runtime/session-types.ts

SessionRecord 外面这一层回答四个问题：这是什么格式版本、属于哪个保存容器、是第几条、来自哪段运行。里面的 result 仍是之前的 `{ state, outcome }`。

version=1 是**本项目自己的文件格式版本**，不是模型版本、Node 版本或章节编号。以后改消息结构时，读取器需要知道应该按哪套规则解释，不能把新旧格式直接混着猜。

LoadedSession 是读回程序的返回值：records 保存所有完整记录，latest 指向最后一条；ignoredTail 表示有未结束的末尾；checkpointStatus 说明检查点与日志是否一致。先知道这些是稍后读取器的结果，不要求此时就实现读取。

### 3. 为什么不直接覆盖检查点

假设旧文件已经保存 seq=1，现在要写 seq=2。直接在旧文件上覆盖，写到一半失败，就可能留下半份新 JSON，同时丢掉原来的完整内容。

本篇先写同目录中的临时文件，写完并关闭后，再改名替换目标。新建 `src/runtime/atomic-text-file.ts`：

<<< ../snippets/11/src/runtime/atomic-text-file.ts

正常过程是 open 临时文件 → writeFile 写入全部文字 → sync 请求同步 → close 关闭 → rename 替换。`wx` 表示只创建新文件，临时文件名还包含随机标识，不覆盖同名已有文件。

内层 finally 确保即使写入失败也关闭文件；外层 catch 只清理这次创建的临时文件，再把原错误抛回调用方。不能为了清理失败而隐藏真正的保存故障。

这个函数只处理**文本替换**，不认识 State，不判断 JSON 格式，也不创建父目录。后面的会话保存器会先校验记录，再把序列化文字交给它。

sync 请求把文件数据同步到存储设备，实际保证依赖系统与设备；同目录改名替换也不是“日志与检查点两份文件一起提交”的事务。本篇不会据此承诺断电时最新两份文件永远一致。[Node 22.18：FileHandle.sync 与文件操作](https://nodejs.org/download/release/v22.18.0/docs/api/fs.html#filehandlesync)

### 4. 第一个可运行检查点

新建 `src/examples/inspect-checkpoint.ts`：

<<< ../snippets/11/src/examples/inspect-checkpoint.ts

这份 record 是入口自己创建的已知数据，只有一条用户消息，还没读取任何源码。它用来检查文件往返，不冒充真实诊断的暂停进度。

```bash
npm run typecheck
node src/examples/inspect-checkpoint.ts
```

输出文件位置为 `.agent-data/checkpoint-probe.json`，后面会显示一行完整 JSON：

```text
检查点文件（file）: .agent-data/checkpoint-probe.json
磁盘文本（text）: {"version":1,"sessionId":"probe","seq":1,"runId":"probe-run","result":{"state":{"goal":"诊断空数组报错","messages":[{"role":"user","content":"诊断空数组报错"}],"decisions":0},"outcome":{"status":"paused"}}}
```

这里有三个不同的值：record 是内存对象，JSON.stringify(record) 是文字，readFile 返回的 text 是重新从磁盘取得的文字。定义 SessionRecord 类型不会自动写文件，调用替换函数才会实际执行读写。

可以再次运行这个探针，它只替换自己的 checkpoint-probe.json。它还没有会话日志，不是后面可用 inspect-session 读取的正式会话目录。我们也还没有把外部 JSON 断言成可信 State，下一阶段补这个检查。

## 阶段二：先约定什么数据可以保存和读回

### 5. 保存要有单独的、必须等待的接口

第 9 篇事件观察者的错误会被隔离，异步工作也不被等待。若把写盘放在普通 subscribe 回调里，run 可能已经返回，文件还没写完；观察者报错时，调用方也未必知道。

新建 `src/runtime/result-sink.ts`：

<<< ../snippets/11/src/runtime/result-sink.ts

ResultSink 是一个保存能力接口：交给它本段 runId 与结果，必须等待 save 的 Promise。这里没有导入文件系统，所以 Agent 可以依赖它，却不需要知道文件路径或数据库细节。

ResultSaveError 用来区分“运行步骤返回了结果，但保存失败”。cause 保留底层错误供调试；不能因为之前看见过 completed 事件，就把这个失败隐藏掉。稍后实例会在保存处包装这个错误。

### 6. JSON 不能保存任意 JavaScript 值

当前两份工具结果都是字符串，可以保存。但 ToolResult.value 的类型是 unknown，今后某个工具可能交回 undefined、Date、函数或循环对象。JSON.stringify 可能忽略字段、把值改成另一种形状，或直接失败。

目标是保存已确认的数据，而不是在转换时悄悄改变它。新建 `src/runtime/json-data.ts`：

<<< ../snippets/11/src/runtime/json-data.ts

先看普通结果：字符串、布尔值、null、普通有限数字可以直接接受；对象和数组继续检查内部项。数组逐项访问，所以空洞与 undefined 不会被悄悄变成 null；额外属性也拒绝。

ancestors 保存**当前递归路径上的对象**。向下一层前加入，返回时在 finally 删除。如果沿路径又遇到同一对象，说明存在循环引用；如果两个不同字段共用同一普通对象，但不是循环，可以分别检查并保存。

原型、Symbol 键、访问器和隐藏属性的检查，是为了限定这套磁盘格式只接收明确的普通 JSON 数据。它不会尝试把日期、集合、函数自动转换成某个新的业务协议。工具确实需要这些内容时，应先显式转成约定的数据格式。

这一步检查的是“能否无歧义地表示”，还没检查“它是不是合法的运行记录”。例如 `{ version: 99 }` 完全能表示为 JSON，却不是本章认识的会话格式。

### 7. 校验字段前，先准备几个小函数

新建 `src/runtime/session-codec.ts`，先写导入：

<<< ../snippets/11/src/runtime/session-codec.ts#imports

再在同一文件末尾追加：

<<< ../snippets/11/src/runtime/session-codec.ts#primitives

object 确认当前值是非空、非数组对象，才允许读取字段。text 检查字符串；`asserts value is string` 告诉 TypeScript 这个检查成功后值可以按字符串使用，真正的保证来自函数内的 typeof。

checkCall 用它们检查 id、name、arguments，并拒绝空身份。这里只核对保存下来的请求形状，不调用工具，也不认为名称正确就代表已经执行过。

### 8. 分别检查动作与消息

继续追加两个完整函数：

<<< ../snippets/11/src/runtime/session-codec.ts#messages

checkAction 根据 kind 选择字段：tool 看 call，tools 看 calls，finish 看 answer，fail 看 reason。checkMessage 根据 role 选择内容：user 看文字，assistant 交给动作检查，tool 则检查结果身份与成功/失败字段。

例如工具失败结果需要 code 与 message；未知 code 不能靠一句“它看起来像错误”接受。数组也不能冒充状态字符串。所有这些字段来自磁盘时都是未知数据，类型文件不会替它们校验。

成功工具结果的 value 可以是任意**已经通过 JSON 数据检查的值**。这里不重新解释源码或验证诊断结论，那仍是应用完成规则的职责。

### 9. 形状对了，还要核对请求与结果关系

有一种数据看上去字段齐全：请求 ID 是 source-1，结果却写成 another。单纯检查字符串与对象仍会放过它。

继续追加：

<<< ../snippets/11/src/runtime/session-codec.ts#history

seen 记住历史里用过的请求 ID，防止复用；pending 记住当前批次还欠哪些结果。读到请求时先调用原 validateToolBatch，再把每项 ID 放进去。读到 tool，必须能从 pending 删除对应 ID，才算接住这次结果。

**讲解摘录 · 结果只属于当前仍等待的请求（无需写入文件）**

<<< ../snippets/11/src/runtime/session-codec.ts#explain-match

这段与上方函数相同，只用于对照。删除失败意味着没有对应请求或重复交回了结果，不是文件删除失败。pending 没清空时又读到 user 或 assistant，说明历史中途跳过结果，直接拒绝。

末尾 pending 未清空则返回 true，而不是一律抛错。因为取消或执行失败的结果可能确实保存了“已提出请求、结果还未知”的事实；它应该能被查看。**能够记录未知结果，不等于可以自动重跑它。** 后面的结果检查会禁止把这种状态标成 completed 或 paused。

### 10. 核对状态、退出原因和外层版本

继续追加：

<<< ../snippets/11/src/runtime/session-codec.ts#result

checkOutcome 覆盖当前 Runtime 的已知出口，检查各自必需字段。checkResult 检查原始任务、消息列表、累计决策数，再核对前面检查过的调用关系。

第一条必须是原始 user，内容与 state.goal 相同；assistant 条数必须等于 decisions。暂停或完成若还欠工具结果，就不是本系列允许的完整边界，因此拒绝。取消状态可以保留未知批次，读取程序稍后只显示它，不自动构造下一次执行。

`state as State` 出现在形状检查之后，只为让内部关系检查函数使用类型。它本身没有验证效果，不能删掉前面的检查后只留下这个断言。

最后在文件末尾追加：

<<< ../snippets/11/src/runtime/session-codec.ts#record

sessionId 限定为 1～64 位字母、数字、下划线或连字符，避免把 `../` 当作会话名字绕到其他目录。runId 是本段运行提供的非空身份，序号从 1 开始。

parseSessionRecord 是整个检查入口：先确认 JSON 数据，再查版本、身份与结果。写入前和读回后共用它。未知版本直接拒绝，不猜测如何解释；未来要支持旧格式，必须提供明确迁移。

encodeSessionRecord 在检查成功后才序列化。这个文件因此有两个方向：内存记录经检查变成文字；磁盘文字先 JSON.parse，再经 parseSessionRecord 成为本项目认识的记录。通过这些检查也不代表文件经过防篡改认证，或证明某份模型答案语义正确。

保存后运行 `npm run typecheck`。接下来才让正式保存器按这份协议写日志。

## 阶段三：追加日志，再更新检查点

### 11. 创建只属于一个写入者的会话目录

本篇不让两个进程同时写同一会话，也不在旧日志尾部直接尝试恢复追加。先采用明确规则：**新会话目录只创建一次，已有目录就拒绝创建；旧会话只读查看。** 第 12 篇再讨论重新打开时的检查与执行安全。

新建 `src/runtime/session-store.ts`，先写导入与公开类型：

```ts
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import type { RunResult } from "./types.ts";
import type { ResultSink } from "./result-sink.ts";
import type { SessionRecord } from "./session-types.ts";
import { checkSessionId, encodeSessionRecord } from "./session-codec.ts";
import { replaceTextFile } from "./atomic-text-file.ts";
import { assertJsonData } from "./json-data.ts";

export type SessionStore = ResultSink & {
  directory: string;
  close: () => Promise<void>;
};
```

它提供 save、close 和保存目录；不是可任意操作内部文件句柄的对象。再在末尾追加完整函数：

<<< ../snippets/11/src/runtime/session-store.ts#store

创建 base 时允许父目录已经存在，创建会话子目录时不允许存在。日志用 ax 创建，只追加新文件。第二次用相同 sessionId 创建会话时，会在已有目录处失败，不会覆盖先前的诊断结果。

#### 一次保存实际经过哪些步骤

**讲解摘录 · save 内部的写入顺序（无需写入文件）**

<<< ../snippets/11/src/runtime/session-store.ts#commit

先给本次记录分配 sequence+1，并把完整结果快照放进去。encode 检查通过，序列化后追加换行；随后 appendFile 写到日志末尾，sync 请求同步，再更新内存里的 sequence，最后替换 checkpoint.json。

本章把 journal.jsonl 当作读取依据。因此两步之间出错时，新进程可能看见日志已经有第 2 条，检查点还停在第 1 条；它不能让旧检查点盖掉新日志。两份文件并不组成一个不可分割的提交。

保存器先用 assertJsonData 检查原值，再用 structuredClone 创建 snapshot，之后才进入等待队列。检查必须放在复制前：复制可能读取 getter 或舍弃隐藏属性，不能先改变了数据再宣布原值可保存。调用方之后修改自己拿到的 result，不会改变已经排队的这份待写结果。文件记录不是直接持有循环 State 的可变引用。

#### 为什么保存也需要排队

同一个保存器可能在前一次还没写完时又收到一次 save。两个序号分配和两次替换若交错，检查点就可能倒退。tail 是一条 Promise 链：每个 operation 接在前一个操作之后执行。

**讲解摘录 · 保存队列的收尾（无需写入文件）**

<<< ../snippets/11/src/runtime/session-store.ts#chain

operation 是本次保存的成功或失败，原样返回给调用方。tail 则只负责让下一项有一个已处理的等待起点，所以接住失败；它不意味着本次失败被假装成功。

真正写入或替换一旦失败，poisoned 会阻止后续操作。因为日志可能已经写了一部分，不能不检查就自动重试，或者继续追加把现场掩盖掉。JSON 格式不合法也不会被写进日志。

close 先禁止新保存，再等待已接受的队列结束，最后关闭句柄。多次 close 共用同一个关闭 Promise，不会在首次关闭还没结束时假装已经关好。

这个模块只认识 RunResult 与文件协议，不知道怎样请求模型、调度工具或追加消息。Node 文件写入需要等待前一个操作结束，本篇的 Promise 链将这个顺序显式表达出来。[Node：文件写入的并发说明](https://nodejs.org/download/release/v22.18.0/docs/api/fs.html#filehandlewritefiledata-options)

## 阶段四：另一个进程应该信哪份文件

### 12. 先扫描完整日志行

新建 `src/runtime/session-reader.ts`，先写导入：

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CheckpointStatus, LoadedSession, SessionRecord } from "./session-types.ts";
import { checkSessionId, encodeSessionRecord, parseSessionRecord } from "./session-codec.ts";
```

再追加完整函数：

<<< ../snippets/11/src/runtime/session-reader.ts#journal

先看正常文本：`记录1\n记录2\n`。每个完整行先 JSON.parse，再检查格式；sessionId 必须与目录要求一致，seq 必须正好是已接受条数加一。不允许跳号、重复序号或混进另一个会话。

再看中途停止：`记录1\n半份记录2`。最后没有换行的部分不作为完整记录，返回 records 只有第 1 条，并标记 ignoredTail=true。这不是悄悄修复文件，也不允许随后直接往半条后面拼接新记录。

如果中间或结尾**已带换行的一整行**是坏 JSON、错误版本或不匹配序号，就直接拒绝。不能跳过它再拿旧结果假装整个文件完好。完整行与未完成尾部的处理有意不同。

### 13. 检查点只能与日志核对

在同一文件末尾追加：

<<< ../snippets/11/src/runtime/session-reader.ts#checkpoint

检查点也先解码、解析与校验。与最后日志记录一致返回 matches；能读但内容不同返回 stale；文件不存在返回 missing；读不到或结构不合法返回 invalid。

这里可以降级使用日志，因为检查点只是副本。日志本身损坏则不能照搬这种处理：前一个函数会拒绝，不能依赖某个看似更新的检查点把坏日志遮过去。本篇读取器不主动重写检查点，保留原现场供排查。

### 14. 加载完整会话，但不启动它

继续在文件末尾追加：

<<< ../snippets/11/src/runtime/session-reader.ts#load

首先按字节找最后一个换行，再只解码完整前缀。原因是异常中止可能恰好截在一个中文字节中间；末尾半个 UTF-8 字符不应该使前面完整的日志也无法读取。完整前缀自身不是合法 UTF-8，则仍拒绝。

decodeJournal 得到 records；latest 取最后一条。最后再核对检查点，返回数据与状态。这里没有 new Agent，没有 executeTool，也没有 resume；加载成功只表示可以检查这些已保存数据。

本文件完成了“文件字节 → 完整记录 → 本项目类型 → 最后已保存结果”的读取链。它不提供旧会话追加写入，不声称最后记录就是进程退出前最后发生的事，也没有自动执行恢复步骤。

## 阶段五：让实例等待保存，不依靠显示日志

### 15. 完整替换 Agent 文件

用下面完整文件替换 `src/runtime/agent.ts`。第 10 篇的输入、暂停与重入方法保留，只新增保存配置、取得 runId，以及等待保存：

<<< ../snippets/11/src/runtime/agent.ts

#### 与第 10 篇相比，具体改了哪里

这次完整替换，是为了让“循环已经返回结果”之后，多一步“等结果保存成功”。需要关注下面五处变化，其他方法沿用第 10 篇：

| 位置 | 本篇改动 | 实现什么、为什么放在这里 |
|---|---|---|
| 文件顶部导入 | 增加 ResultSink 与 ResultSaveError | 前者约定如何保存，后者向调用方报告保存失败。Agent 依赖保存接口，不直接操作文件。 |
| AgentOptions | 增加可选的 `resultSink?: ResultSink` | 由创建实例的入口决定是否保存、使用哪个保存器。不传时，旧入口仍按原流程运行。 |
| start 内的局部变量与 onEvent | 新增 runId，在收到 run-started 时取得 `event.runId` | 给保存结果带上它所属运行段的身份。每次 start 单独记录，暂停后继续也会取得新身份；不能另造一个编号冒充循环的 runId。 |
| runAgentLoop 返回之后 | 新增 `await this.options.resultSink.save(...)` | 此时才有本段完整结果；必须等保存完成，才能继续发布给调用方。交给保存器的是副本。 |
| 新增保存代码的 catch | 把保存异常包装为 ResultSaveError 后抛出 | 让调用方知道“循环有结果，但保存失败”。抛错会跳过后面的 lastResult 赋值与正常 return，仍经过原 finally 释放实例。 |

`this.lastResult = structuredClone(result)` 和 return 原本就有，本篇没有重新实现它们，而是在它们前面加入等待。因此，**有保存器时，发布结果的时机变成保存成功之后**。

输入队列、steer、followUp、pause、run、resume 与拒绝重复启动的检查仍沿用上一章。真正的文件写入在 session-store.ts，循环内部仍负责更新 State。下面先看新增等待怎样改变一次调用，再解释结束通知与保存完成的先后关系。

**讲解摘录 · start 中，先保存再发布结果（无需写入文件）**

<<< ../snippets/11/src/runtime/agent.ts#save

正常时，loop 的 result 接到暂停或完成结果；配置了保存器便等待 save。成功之后才复制到 lastResult，并走原来的 return。此时 agent.result 才有这份已保存结果，调用方 await 也随后结束。

保存抛错时包装为 ResultSaveError，不填写 lastResult，不返回一个“已成功保存”的结果。finally 仍会释放实例，isRunning 不会永久为 true。即使错误原因是检查点替换失败，也不能推断日志没有写入；必须只读检查，后面有实验。

### 为什么 run-ended 之后还可能报保存失败

第 9 篇 run-ended 表示**循环已经选定结果**，一直不等于实例完全空闲。本篇在它后面增加必须等待的保存，所以时间线是：

```text
循环报告 run-ended
→ 循环返回 RunResult
→ 实例 await resultSink.save
→ 成功：设置 lastResult，释放实例，调用方拿到结果
→ 失败：抛 ResultSaveError，释放实例，调用方拿到错误
```

保存期间实例仍忙碌，不能重复 run；输入接收已经随 run-ended 关闭。异步写盘没有被包装成普通事件观察者，所以失败不会被显示通道吞掉。

循环的超时控制已随本段循环释放，不控制后续磁盘等待。结果确定后再调用 cancel 也不会撤回已有结果或使文件替换变成原子回滚。本篇只等待保存协议完成，不把它描述成可取消的文件事务。

如果暂停后还有待处理队列，这些尚未进入 State 的内容仍只在内存。后续排队成功也不等于已写盘；本篇没有保存完整实例、函数或输入队列。对必须保存的用户输入，需要在其被接入历史或后续独立输入日志中明确记录。

## 阶段六：保存真实 Runtime 的暂停结果，再退出读取

### 16. 在原场景上接入保存器

新建 `src/examples/save-session.ts`：

<<< ../snippets/11/src/examples/save-session.ts

创建 store 先独占一个新目录，再把它作为 resultSink 交给 Agent。脚本、工具与完成规则全部复用第 10 篇；results-recorded 后只请求一次暂停。

first 接到的是**保存完成后**返回的暂停结果，因此下一行可以写“已保存结果”。如果命令带 finish，还在同一个进程里显式 resume，再追加一条新段结果。finally 无论正常还是异常都关闭保存器。

保存器不负责 Agent 的模型依赖，Agent 也不自己拼文件路径。对外组合关系是：入口同时知道“用哪套 Runtime 依赖”和“把结果放哪里”，循环只知道任务步骤。

### 17. 写一个只读入口

新建 `src/examples/inspect-session.ts`：

<<< ../snippets/11/src/examples/inspect-session.ts

这个文件只加载数据与显示，不导入 Agent 或场景脚本。最后对已知完整的 paused、completed 状态调用原 buildDecisionContext，重新构造全量输入副本。

这里重建的不是一份旧 Context 缓存：磁盘保存的是 State，Context 从它重新生成。以后真正调用模型时仍要应用当时的输入预算、工具清单和模型配置；本篇没把这些配置或密钥当作会话状态保存。

对于取消后可能欠工具结果的状态，入口只显示记录，不把它直接当作可以发给模型的完整输入。

### 18. 第一个进程保存，第二个进程读回

选择一个尚不存在的会话名，运行：

```bash
npm run typecheck
node src/examples/save-session.ts lesson11
```

前面仍是第 10 篇读取过程，关键结尾为：

```text
事件（event）#6 run-ended：结果=paused，决策=1，消息=4
已保存结果（savedOutcome）: paused
会话目录（directory）: .agent-data/lesson11
```

此时命令已退出，原 Agent 对象、controller 和 State 变量都不存在。再运行一个新命令：

```bash
node src/examples/inspect-session.ts lesson11
```

输出：

```text
日志记录数（records）: 1
忽略未写完末尾（ignoredTail）: false
检查点状态（checkpoint）: matches
最后已保存编号（seq）: 1
最后已保存结果（outcome）: paused
累计决策（decisions）: 1
消息顺序（messages）: user -> assistant -> tool -> tool
可重建全量输入消息（contextMessages）: 4
```

没有第二次读取日志，也没有调用模型。四条消息来自磁盘中的结果，不是重新运行脚本造出来的。paused 只说明最后一段按暂停结束；这个入口没有把它自动继续。

会话名已经存在时不要覆盖目录。如果要重新演示创建过程，换一个新名字，例如 lesson11-again，再用相同名字运行读取命令。

### 19. 在同一进程保存两段，再读最后一份

前一个例子已经退出进程。本篇不重开它写入；另取一个新名字，演示**同一保存器生命周期内**的暂停与继续：

```bash
node src/examples/save-session.ts lesson11-finished .agent-data finish
node src/examples/inspect-session.ts lesson11-finished
```

最后读回应有：

```text
日志记录数（records）: 2
忽略未写完末尾（ignoredTail）: false
检查点状态（checkpoint）: matches
最后已保存编号（seq）: 2
最后已保存结果（outcome）: completed
累计决策（decisions）: 2
消息顺序（messages）: user -> assistant -> tool -> tool -> user -> assistant
可重建全量输入消息（contextMessages）: 6
```

第一条日志的 4 条消息仍保留；第二条自己带完整的 6 条消息，不是只保存多出来的两条。检查点只放第二条。读取 latest 不需要对两份快照再追加拼接，否则会把原用户和工具记录重复一遍。

当前每段都保存完整结果，直观但会重复旧内容，文件会随段数增长。它还不是大规模会话存储优化，后面再按需要设计增量、索引和资源限制。

## 故障时，怎样知道能信到哪里

正常保存清楚以后，再写故障装置。它会自己创建系统临时目录，结束后删除自己的目录，不修改刚才正式保存的 lesson11 会话。

### 20. 准备独立故障入口

新建 `src/examples/inspect-session-faults.ts`：

<<< ../snippets/11/src/examples/inspect-session-faults.ts

mode 决定要验证哪条边界。普通文件实验先保存一条已知、只有 user 的 paused 样本；这个样本验证文件协议，不代表真实完成过读取。随后只在临时目录里增加末尾、破坏完整行、修改版本或回退检查点。

save-error 则走实际 Agent 保存流程：固定脚本给出一份答案，完成规则接受，但检查点路径被预先放了一份同名目录，导致替换失败。这里的完成规则刻意只服务固定故障装置，不复用为通用诊断验收。

两个 try/catch 分别观察保存调用是否失败、读回调用是否拒绝。finally 先 close，再移除自建临时目录；清理不影响正式会话。这些分支只属于观察入口，不搬进 Runtime 核心。

### 末尾半条记录：保留前面的完整记录，并明确标记

```bash
node src/examples/inspect-session-faults.ts tail
```

```text
最后已保存编号（seq）: 1
忽略未写完末尾（ignoredTail）: true
检查点状态（checkpoint）: matches
```

这不是“自动修好并继续”。读取器只接受前缀，告诉调用方后面还有残留；文件未被改写。真正重新打开写入前，必须先制定尾部与执行状态处理策略。

### 完整行损坏或版本不认识：拒绝，不跳过

```bash
node src/examples/inspect-session-faults.ts corrupt
node src/examples/inspect-session-faults.ts version
```

两次均应输出：

```text
拒绝损坏或不支持的日志（rejected）: true
```

corrupt 是新增带换行的错误 JSON；version 是把完整记录版本改成 99。不能把它们都当作没写完的尾巴，退回旧数据后假装整个日志有效。

### 检查点落后：以日志最后一条为准

```bash
node src/examples/inspect-session-faults.ts stale
```

```text
最后已保存编号（seq）: 2
忽略未写完末尾（ignoredTail）: false
检查点状态（checkpoint）: stale
```

日志有两条，检查点只保存第一条。读回仍返回 seq=2，并指出副本落后；没有让旧检查点把状态倒回去。

### 日志可能写完了，但检查点保存失败

```bash
node src/examples/inspect-session-faults.ts save-error
```

```text
保存失败已报告（saveError）: true
实例未发布成功结果（resultMissing）: true
最后已保存编号（seq）: 1
忽略未写完末尾（ignoredTail）: false
检查点状态（checkpoint）: invalid
```

先看两个事实：Agent.run 拒绝，没有发布成功保存的 result；只读加载却在日志里找到一条完整记录。两者不矛盾，因为追加日志已经完成，失败发生在后面的检查点替换。

因此，保存报错后不能直接推断“没有写入，重跑就行”。保存器也会拒绝后续保存，等待检查。下一篇会把这种“已知事实和未知执行”进一步用于恢复决策。

## 如何调试：从文件到变量，再到等待顺序

| 症状 | 先查的位置 | 应观察什么 |
|---|---|---|
| 看见 run-ended，却没有“已保存结果” | Agent.start 的 await save | 是仍在等待，还是已抛 ResultSaveError |
| 创建时报 EEXIST | 会话目录创建 | 是否重复使用旧名字；不要直接覆盖 |
| 日志有数据，检查点旧或缺失 | journal 与 checkpointStatus | 最后完整日志的 seq 与检查点 seq |
| 读回消息数与原结果不同 | 编码前检查与 JSON 字段 | 是否原本含 undefined、特殊对象，或文件被改动 |
| 有源码请求，却没有源码结果 | checkHistory 的 pending | 保存的是取消后的未知批次，不能自动重跑 |
| 读取只能拿到旧段 | ignoredTail 与最后完整换行 | 后一条是未完成尾部，还是完整行损坏 |

可以附加调试器：

```bash
node --inspect-brk src/examples/save-session.ts lesson11-debug
```

使用尚不存在的名字，再设四个断点：

1. Agent.start 的 resultSink.save 前：result 已有 4 条消息，lastResult 仍为空；循环结果与实例发布是两个时刻。
2. session-store.ts 的 appendFile 前：snapshot 是保存器副本，seq 是本次会话保存编号，不是事件 seq。
3. 日志 sync 后、replaceTextFile 前：日志可能已经比检查点新；这正是 stale 的来源。
4. session-reader.ts 的 latest：新进程已从文字校验成数据，此处仍没有启动任何工具。

### 一个小迁移：同时提交两份保存请求

用两份同时提交的保存请求观察队列顺序。下面的终端命令创建自己的临时会话并清理，不改源码：

```bash
node --input-type=module <<'JS'
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionStore } from './src/runtime/session-store.ts';
import { loadSession } from './src/runtime/session-reader.ts';
const base = await mkdtemp(join(tmpdir(), 'session-order-'));
const store = await createSessionStore(base, 'order');
const result = { state: { goal: 'g', messages: [{ role: 'user', content: 'g' }], decisions: 0 }, outcome: { status: 'paused' } };
try {
  await Promise.all([store.save('run-a', result), store.save('run-b', result)]);
  await store.close();
  const loaded = await loadSession(base, 'order');
  console.log(`日志顺序（seq）: ${loaded.records.map((record) => record.seq).join(' -> ')}`);
  console.log(`检查点状态（checkpoint）: ${loaded.checkpointStatus}`);
} finally {
  await store.close();
  await rm(base, { recursive: true, force: true });
}
JS
```

应输出 seq 为 `1 -> 2`、checkpoint 为 matches。两次调用同时提交，但真正文件写入由 tail 串行执行；Promise.all 只是等待两份请求，不替文件系统安排顺序。这次无需恢复源码。

## 再看 Pi 的会话保存

对照固定提交 `8efd314fa3d3232ce197d8d7a6a5660530b9d83e` 中的 [SessionManager](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/coding-agent/src/core/session-manager.ts)。这段位于 Pi Coding Agent 的会话层，不是低层 Agent Loop；对照它的位置本身，也能帮助理解为什么本篇不在循环里直接导入 fs。

先看文件中的版本与记录类型，再看 `_persist` 的 JSONL 写入，最后看 `buildSessionContext` 如何从会话记录构建模型可见消息。共同点是：保存结构化记录、按文件格式解释、从持久记录重新得到输入，而不是把终端日志当会话。[Pi：版本、记录与保存实现](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/coding-agent/src/core/session-manager.ts#L1090-L1112)

差异也要保留：Pi 有带父子身份的追加记录与分支结构，本篇是一段一个完整 RunResult；本篇的检查点副本、单次创建写入者、坏尾部策略和 ResultSink 等待接口都是自己的实现。尚未覆盖 Pi 的完整日志模型，不能仅因都使用 JSONL 就认为能力已经等价。

## 完整最终文件

以下为本篇全部新增或修改文件。其他第 10 篇文件保留，尤其 agent-loop.ts 无需改动。

### .gitignore

<<< ../snippets/11/.gitignore

### src/runtime/session-types.ts

<<< ../snippets/11/src/runtime/session-types.ts

### src/runtime/atomic-text-file.ts

<<< ../snippets/11/src/runtime/atomic-text-file.ts

### src/examples/inspect-checkpoint.ts

<<< ../snippets/11/src/examples/inspect-checkpoint.ts

### src/runtime/result-sink.ts

<<< ../snippets/11/src/runtime/result-sink.ts

### src/runtime/json-data.ts

<<< ../snippets/11/src/runtime/json-data.ts

### src/runtime/session-codec.ts

<<< ../snippets/11/src/runtime/session-codec.ts

### src/runtime/session-store.ts

<<< ../snippets/11/src/runtime/session-store.ts

### src/runtime/session-reader.ts

<<< ../snippets/11/src/runtime/session-reader.ts

### src/runtime/agent.ts

<<< ../snippets/11/src/runtime/agent.ts

### src/examples/save-session.ts

<<< ../snippets/11/src/examples/save-session.ts

### src/examples/inspect-session.ts

<<< ../snippets/11/src/examples/inspect-session.ts

### src/examples/inspect-session-faults.ts

<<< ../snippets/11/src/examples/inspect-session-faults.ts

## 最后检查与保存本章

使用尚不存在的会话名；重复运行时换一个新名字，不覆盖旧日志：

```bash
npm run check
node src/examples/inspect-checkpoint.ts
node src/examples/save-session.ts lesson11-check
node src/examples/inspect-session.ts lesson11-check
node src/examples/save-session.ts lesson11-finish-check .agent-data finish
node src/examples/inspect-session.ts lesson11-finish-check
node src/examples/inspect-session-faults.ts tail
node src/examples/inspect-session-faults.ts corrupt
node src/examples/inspect-session-faults.ts version
node src/examples/inspect-session-faults.ts stale
node src/examples/inspect-session-faults.ts save-error
node src/examples/inspect-input-agent.ts pause
node src/examples/inspect-input-agent.ts follow-up
node src/examples/inspect-agent-faults.ts reentry
node src/examples/inspect-windowed-loop.ts small
node src/examples/inspect-stream.ts cut
DOCS_BASE=/ci/ npm run site:build
git check-ignore .agent-data/lesson11-check/journal.jsonl
```

应确认：新的只读进程能取得已保存状态；日志与检查点区别明确；未完成尾部被标记，完整损坏记录被拒绝；保存失败向调用方报告；旧暂停、输入、重入、输入限制与断流入口仍工作。检查的是这些行为，没有执行真实模型调用，也没有实现崩溃后的自动续跑。

确认分支为 codex/chapter-11-session-checkpoints、检查通过且改动范围正确后，再使用下面命令。运行数据不提交，网站与代码参考一并保存在 site/。

```bash
git branch --show-current
git status --short
git add -- .gitignore src/runtime/session-types.ts src/runtime/atomic-text-file.ts src/examples/inspect-checkpoint.ts src/runtime/result-sink.ts src/runtime/json-data.ts src/runtime/session-codec.ts src/runtime/session-store.ts src/runtime/session-reader.ts src/runtime/agent.ts src/examples/save-session.ts src/examples/inspect-session.ts src/examples/inspect-session-faults.ts site/
git diff --cached --stat
git commit -F - <<'COMMIT'
第 11 篇：保存会话日志与检查点并只读重建

把一段运行结束时的完整结果保存到磁盘，退出进程后仍可核对任务历史与重建模型输入。

- 增加版本化记录、JSON 数据与状态关联校验
- 串行追加会话日志，同步后替换最新检查点
- 实例等待必须完成的保存，保存失败向调用方报告
- 只读加载完整记录，标记未完成尾部并核对检查点
- 增加文件往返、跨进程读取与损坏及写入失败观察入口
- 排除本地运行数据，同步课程正文、代码参考与配图

验证：类型与现有环境检查、离线文件保存和跨进程读回、截断与版本拒绝、检查点落后与保存失败、旧章节相关回归、网站构建。未执行真实模型调用或崩溃后自动续跑。
COMMIT
git push -u origin codex/chapter-11-session-checkpoints
```
