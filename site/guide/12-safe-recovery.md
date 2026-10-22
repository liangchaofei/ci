---
title: 第 12 篇｜从保存的进度继续前，先核对执行事实
description: 从跨进程继续诊断出发，区分恢复状态与重放工具，记录执行意图，核对资源版本和当前工具授权，拒绝未知副作用的自动恢复。
---

# 第 12 篇：从保存的进度继续前，先核对执行事实

第 11 篇能把暂停结果保存下来，再用另一个进程读回。读回四条消息后，我们还不能直接继续：文件可能已经被别人改过，原来的工具授权可能失效，最后一次操作也可能已经执行、却没有来得及保存结果。

本篇先走一个正常任务：仍然诊断 sum([])，读取源码和测试后暂停、退出；另一个进程确认进度可信，再接入“请用中文说明”的要求。**新进程应直接利用已保存的两份读取结果回答，工具执行次数为 0。**

再走一个失败过程：工具确实写入了一次文件，进程却在返回结果前退出。新进程要指出有待核查的调用，停止自动恢复，不能因为没找到结果就再执行一次。

## 先沿一次任务找本篇的位置

### 从“读回”到“允许继续”，中间补什么

```text
进程 A：两项读取 → 结果写回 State → 暂停 → 保存 → 退出
                                               ↓
进程 B：读回记录 → 【本篇新增：核对恢复依据】
                         ├─ 不足：显示原因，停止，不启动 Agent
                         └─ 足够：新实例安装暂停状态 → 接收继续要求
                                    → 再次决策 → 完成，不重读已有材料
```

本篇的“恢复”是把**经过检查的暂停状态**安装进新实例，再明确调用 resume。它不是重新执行历史里的每条请求，也不是保存了某个 JavaScript Promise 后接着等待。旧进程的函数、控制器、队列和网络连接都不会回来。

[![暂停结果先通过日志、恢复标记、资源版本与当前工具清单的核对；通过后进入新实例与新保存目录，未确认执行则停止核查](/diagrams/safe-recovery-flow.svg)](/diagrams/safe-recovery-flow.svg)

点击可放大。旧会话始终只读；续运行写入新会话目录。原循环仍负责决策、执行和 State 写回，不在循环里加入文件系统逻辑。

### 为什么有暂停结果，还要防止重复执行

先想一个追加日志的工具：调用一次写一行。文件已经写完，但进程来不及把 ToolResult 保存下来，就退出了。此时“磁盘没有结果”与“操作没有发生”并不相同；直接重跑会写第二行。

副作用就是操作对外部世界的改变，例如写文件、提交代码或发送请求。本篇用临时目录中的一行文件内容观察它。**未知副作用**表示当前保存证据不足以确认外部操作的最终情况，不表示已经确认失败，更不表示可以自动重试。

AWS 对重试的说明也使用了相同风险：没有收到创建资源的响应时，资源仍可能已经创建，重复请求会产生额外资源。安全重试需要额外的协议保证，而不是只检查异常文字。[AWS Builders’ Library：重试与副作用](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/)

本篇选择保守处理：未知执行就阻止自动接续。不会实现“任何崩溃后都能自动跑完”，也不会凭 callId 就宣称工具具备幂等性；幂等需要工具或服务保证重复请求不增加副作用，后面讨论重试时再展开。

## 一份结束结果，加一份恢复标记

第 11 篇 journal.jsonl 和 checkpoint.json 保留。本篇每个新会话再增加 recovery.json，用来回答“这段运行有没有走到可以核对的结束位置”。

| 文件或对象 | 存什么 | 谁负责 |
|---|---|---|
| State | 当前任务的消息和累计决策数 | 循环写回 |
| journal.jsonl | 每段结束的完整结果 | 沿用第 11 篇保存器 |
| checkpoint.json | 最后一条结果的副本 | 沿用第 11 篇保存器 |
| recovery.json | 当前段标记、已登记调用、资源与授权、对应结果凭据 | 本篇恢复写入器 |
| 当前环境检查结果 | 现在的工作区身份、资源版本和允许工具 | 应用重新检查，不从旧日志授予 |

标记有两种 phase：

- **open**：本段尚未确认结束。可能还没启动工具，也可能工具已执行但结果未知。
- **sealed**：本段结果已保存，登记的调用都有成功观察，资源与授权没有改变；receipt 指向这份已保存结果。

它们是本项目的磁盘协议，不是模型 API 状态，也不替代 Outcome。即使有 paused 的日志，只要恢复标记仍是 open，本篇也不自动继续。

### 正常过程里，标记怎样变化

| 时刻 | 标记 | 调用清单 | 结果是否已保存 |
|---|---|---|---|
| 新会话建立 | open | 空 | 否 |
| 本段启动前 | open | 清空本段旧清单 | 尚未保存本段 |
| 第一次读取开始前 | open | source-1 | 否 |
| 第二次读取开始前 | open | source-1、tests-1 | 否 |
| 两份结果写回并暂停 | open | 两项保留 | 开始保存 |
| 保存成功并逐项核对 | sealed | 两项保留 | 是，receipt 绑定该结果 |

工具返回后**不立刻删除调用标记**。因为它返回了，不等于循环已经写回，更不等于结果已经落盘。只有段结果保存成功后，才能将这几件事对上。

## 本篇边界与前置版本

本章先自动接续“资源没变、工具清单没变、执行已确认”的 paused 状态。任何本段工具错误、资源修改、标记缺失、文件截断或凭据不匹配都阻止自动恢复。这可能比实际必须的限制更严格，但不会把不确定操作当作未执行。

工具错误即使可能发生在写入前，本篇也不尝试自动推断“没有副作用”；后续可以根据更具体的错误与工具契约放宽。正常成功的写操作若改变了资源版本，也不会在本章自动重新建立可恢复边界。

旧会话可以再次读回形成不同分支；本篇没有跨进程恢复租约，不能把一次门禁当作多个恢复者之间的全局去重。

当前允许工具清单是简单的应用配置，不是完整权限系统。本篇没有实现审批、用户身份认证、路径隔离、资源锁或外部服务查询补偿；这些不能靠一份本地标记替代。第 13 篇继续补执行权与隔离。

从完成并提交的第 11 篇创建本章分支：

```bash
git switch -c codex/chapter-12-safe-recovery
```

已有分支时使用 `git switch codex/chapter-12-safe-recovery`。命令均在仓库根目录执行，不新增依赖。先确认上一章正常：

```bash
npm run typecheck
node src/examples/inspect-input-agent.ts pause
```

第 11 篇旧会话仍可只读查看，但缺少 recovery.json，不能补写一个 sealed 就当作已经证明安全。本篇示例使用新会话名。

## 新增与修改的文件

| 文件 | 变化 | 本章承担什么 |
|---|---|---|
| src/runtime/recovery-types.ts | 新增 | 环境、标记、检查结论、写入器接口 |
| src/runtime/recovery-codec.ts | 新增 | 检查标记，比较环境，绑定已保存结果 |
| src/runtime/recovery-store.ts | 新增 | 段开始标记、执行前登记、结束确认 |
| src/runtime/recovery-reader.ts | 新增 | 只读恢复门禁，返回 ready 或 blocked |
| src/runtime/result-sink.ts | 修改 | 增加可选 begin 准备接口 |
| src/runtime/agent.ts | 修改 | 启动前等待 begin，增加安装暂停状态的方法 |
| src/examples/read-source-tool.ts | 修改 | 只导出已有参数检查函数 |
| src/examples/read-tests-tool.ts | 修改 | 只导出已有参数检查函数 |
| src/examples/recovery-workspace.ts | 新增 | 本章真实小文件、版本检查与读取组装 |
| src/examples/inspect-recovery-environment.ts | 新增 | 第一个可运行检查点：查看当前环境 |
| src/examples/save-recoverable-session.ts | 新增 | 读取后保存本章暂停状态 |
| src/examples/inspect-recovery.ts | 新增 | 只检查，不启动续运行 |
| src/examples/resume-session.ts | 新增 | 门禁通过后，创建新实例与新保存器 |
| src/examples/crash-after-write.ts | 新增 | 临时子进程中制造写完但未返回的退出 |
| src/examples/inspect-recovery-faults.ts | 新增 | 在独立临时目录观察六种阻止原因 |

共 15 个 TypeScript 文件，11 个新增、4 个修改。agent-loop.ts、原日志格式和所有旧入口保留。示例里的模型仍是固定脚本；本篇新增的文件读取、保存、跨进程继续和退出实验是真实发生的，不调用模型 API。

runtime 目录中的模块不全由循环直接调用。恢复检查发生在创建运行实例之前，由启动入口调用；执行记录则在运行期间，接在实例和执行器上。下面每个文件先说明它接在哪一步，再实现内部代码。

按标明的步骤创建、追加或替换代码。解释里的“讲解摘录”已经包含在完整实现中，**无需再次写入、追加或替换文件**；章末提供全部完整文件。

## 阶段一：先知道“资源没变”指什么

### 1. 定义检查结果与磁盘记录

先约定几个模块之间交接的数据形状。读取器要交回“允许继续或阻止”的结果，写入器要接收“当前环境”，它们需要使用相同字段；这就是本文件在 Runtime 中的位置。

新建 `src/runtime/recovery-types.ts`：

<<< ../snippets/12/src/runtime/recovery-types.ts

RecoveryEnvironment 是应用检查的具体结果：workspaceId 表示哪份工作区，revision 表示依赖资源内容的版本，allowedTools 表示当前配置允许的工具名。三个值都要重新取得；不能读回旧清单就重新授予权限。

RecoveryBoundary 是要写入 recovery.json 的内容。intents 只保存调用 ID 与工具名，用于指出需要核查的操作，不保存一套可直接重放的参数队列。receipt 用 seq、runId 和 digest 绑定本段的完整结果；它不代表外部事务已经回滚或提交。

RecoveryDecision 用 status 区分两种结果：ready 才提供可安装结果；blocked 提供原因与可能的待核查清单。这样调用方不能在拒绝分支里直接取得一个“照样继续”的 result。

把本文件作为整体看，它只导出类型，供读取器、写入器和应用入口通过 import type 共用。它没有可调用的执行入口，定义 RecoveryEnvironment 不会检查工作区，定义 RecoveryDecision 也不会批准恢复；真正创建这些值的函数在后面。

### 2. 导出旧工具的参数检查

本章要让同样的两种读取真正访问隔离的演示文件，参数规则仍复用第 3、7 篇。

在 `src/examples/read-source-tool.ts` 中，仅将原函数声明行改为：

```ts
export function parseReadSourceArgs(input: unknown): ParseResult<ReadSourceArgs> {
```

在 `src/examples/read-tests-tool.ts` 中，仅将原函数声明行改为：

```ts
export function parseReadTestsArgs(input: unknown): ParseResult<ReadTestsArgs> {
```

这是给已有声明增加 export，**不追加第二份函数，不改函数体与导入**。这两个文件原来各自把“参数检查 + 模拟读取”组合成一个工具；本篇仍保留该工具，只让另一份组装文件也能复用参数检查。

接下来 recovery-workspace.ts 会把这两个 parse 函数交给 defineTool。循环请求读取时，统一执行器调用工具，工具才先 parse、后读取实际演示文件。增加 export 只是允许复用，没有在这里执行任何读取。

### 3. 准备当前任务使用的小工作区

本篇把两个逻辑路径映射到固定演示文件：

| 工具请求中的路径 | 本篇实际读取 |
|---|---|
| src/sum.ts | .agent-data/workspace12/sum.ts |
| test/sum.test.ts | .agent-data/workspace12/sum.test.txt |

这不是整个仓库的文件工具，也不会运行测试；第二份文件保存的是测试片段。固定映射让实验不会修改学习者的 Runtime 源码。

这份文件把“诊断任务具体读什么”接到通用 Runtime 上：准备两份小文件、取得它们现在的版本、创建能读它们的执行器。它是被其他入口导入的应用模块，不是需要单独运行的命令。

新建 `src/examples/recovery-workspace.ts`，先写导入：

<<< ../snippets/12/src/examples/recovery-workspace.ts#imports

在末尾追加完整准备函数：

<<< ../snippets/12/src/examples/recovery-workspace.ts#prepare

第一次创建目录与两份已知文件；wx 只在文件不存在时写入。文件已经存在就保留内容，因此稍后人为改文件不会被准备步骤悄悄覆盖。其他写入错误仍向外抛。

继续在末尾追加环境检查：

<<< ../snippets/12/src/examples/recovery-workspace.ts#inspect

realpath 得到实际工作区身份。两份文件的内容连同名称组成固定顺序数组，经 SHA-256 得到 revision；文件内容改变，摘要也会改变。本例摘要覆盖这两份任务材料，不覆盖任意隐藏文件、网络资源或运行配置。真实应用必须先界定需要核对哪些资源。

allowedTools 由应用此刻提供。它与文件摘要是两类条件：文件相同但授权变了，也不能沿用旧环境。这里返回副本，不把可修改的传入数组直接交出去。

最后追加读取入口：

<<< ../snippets/12/src/examples/recovery-workspace.ts#execute

defineTool 与注册执行器都沿用旧实现；本次只把工具执行体换成 readFile。原参数检查仍先核对工具约定的逻辑路径，通过后才读取固定映射文件，signal 继续传入文件读取。

现在把本文件的三个导出接回调用方。后面的保存与继续入口会这样使用它们：

| 导出 | 哪一步调用它 | 返回后谁继续 |
|---|---|---|
| prepareWorkspace(root) | 首次保存前准备演示材料 | 入口等待完成，再检查版本、创建实例 |
| inspectWorkspace(root) | 恢复前，以及写入器要求重查环境时 | 结果交给恢复检查或环境比较，决定能否继续 |
| createWorkspaceExecutor(root) | 创建 Agent 的依赖时 | 返回一个执行函数；经 store.wrap 包装后，才交给循环使用 |

这三个导出不会自动依次执行。例如只运行后面的环境探针，会准备与检查文件，但不会调用执行器。Runtime 保存的只是检查结果，不内置这些文件名；换一个任务时，应用替换这份资源适配，循环与恢复协议继续复用。模型脚本与证据规则仍只适用当前固定场景。

### 4. 第一个可运行检查点

现在只看当前资源，不启动 Agent。新建 `src/examples/inspect-recovery-environment.ts`：

<<< ../snippets/12/src/examples/inspect-recovery-environment.ts

```bash
npm run typecheck
node src/examples/inspect-recovery-environment.ts
```

会显示当前工作区绝对路径、资源摘要和 `read_source -> read_tests`。路径随电脑变化；摘要来自实际文件。连续运行而文件不变时摘要相同。

inspect-recovery-environment.ts 是独立命令入口：终端启动它，它调用刚完成的工作区模块，接住 environment 并显示后退出。没有其他 Runtime 文件等待它的返回值，也没有运行记录；它把“资源版本到底从哪里来”单独显露出来。

## 阶段二：让恢复依据可以检查

### 5. 比较环境并给结果生成凭据

这个模块会被恢复写入器和读取器共同使用：写入前确认自己生成的标记合法，读回后确认外部 JSON 能按本项目格式解释。把规则放在同一个文件，避免写入端接受一种格式，读取端却按另一种规则判断。

新建 `src/runtime/recovery-codec.ts`，先写导入：

<<< ../snippets/12/src/runtime/recovery-codec.ts#imports

再在末尾追加下面完整函数：

<<< ../snippets/12/src/runtime/recovery-codec.ts#environment

先看一个正常环境：两个非空身份字段，加上两项工具名。parseEnvironment 检查字段后复制工具名、排序；清单顺序不同不会造成误判，重复名称则拒绝。sameEnvironment 比较的是两份规范化后的具体值。

这里再次使用第 11 篇 JSON 数据检查。TypeScript 类型不检查磁盘内容，object 和 text 在运行时确认字段，asserts 只是让类型检查器知道检查之后的字符串关系。

recordDigest 将已验证的 SessionRecord 序列化后生成摘要。下面读取器会用它核对 receipt 对应的是否正是最后这条日志，避免把旧段的许可标记配给新段。它是本地一致性检查，没有签名与密钥，不能抵御能同时改写记录和摘要的攻击者。

### 6. 检查整份恢复标记

继续在同一文件末尾追加：

<<< ../snippets/12/src/runtime/recovery-codec.ts#boundary

正常输入中 version=1，phase 为 open 或 sealed，sessionId 与目录对应，intents 不重复。open 的 receipt 必须为 null；sealed 则必须有合法的 seq、runId 和 64 位十六进制摘要。

map 每次检查一项调用身份，把结果放入新数组。ids 防止同一份标记重复列出同一调用。最后的阶段与凭据检查防止“写着 sealed 却没有绑定结果”的矛盾数据被接受。

到这里 recovery-codec.ts 已完整。它在两条调用路径中使用：

- 写入器把待保存对象交给 parseRecoveryBoundary，取得检查后的对象，再序列化到文件；段结果确认时调用 recordDigest 绑定日志。
- 读取器先读文件、JSON.parse，再把未知值交给同一个 parseRecoveryBoundary，取得可检查 phase、intents 与 receipt 的对象。随后用 recordDigest 与 sameEnvironment 核对日志和当前环境。

因此，本文件的返回值是检查后的数据或比较结果，接住它们的仍是写入器、读取器；它不会自己读盘、写盘或启动任务。旧 State 的格式继续由第 11 篇 parseSessionRecord 检查。

### 7. 只读门禁：给结论，不启动任务

在写入之前，先确定读取端只会接受什么。一次成功恢复必须拿到：sealed 标记、完整最新日志、匹配检查点、匹配凭据、paused 结果和相同当前环境。

本文件处于**恢复命令已经启动，但 Agent 尚未创建**的位置。后面的 resume-session.ts 会交给它旧会话位置与刚检查的当前环境，等待一个 decision：ready 才继续组装实例，blocked 就只显示原因并退出。

新建 `src/runtime/recovery-reader.ts`：

<<< ../snippets/12/src/runtime/recovery-reader.ts

正常路径先检查标记，再用原 loadSession 读日志。receipt 的序号、运行 ID 与摘要都要匹配 latest；最后核对退出状态与当前环境，才交出 ready。

open 时提前返回 blocked，保留 intents。即使进程在第一次工具中退出、日志还是空的，也能给出 write-1 这样的核查线索，而不是先因“没有 latest”丢掉开始证据。open 且清单为空也不代表安全，只表示没有已确认的完整结束段。

第 11 篇只读查看可降级使用完整日志、报告检查点落后；本篇自动接续有意更严格，要求检查点匹配。不在这里修复尾部、重写检查点或补凭据，因为修复与允许执行不能混成一个无条件动作。

解析失败或缺少文件时返回 blocked。状态输入、环境输入无效也不会启动工具；异常不被改成某个默认 ready。

把整份文件放回正常例子：它从 lesson12 目录读到 sealed 标记与四条消息的暂停结果，核对后把 `{ status: "ready", result, environment }` 交回调用入口。入口接住后，才选择创建新实例并安装 result。只读检查命令 inspect-recovery.ts 也调用这个文件，但拿到结论后只显示、不继续。

这说明“检查通过”和“开始运行”在两个文件中发生。读取器提供判断和数据，不直接调用 Agent、decide 或 executeTool，也不修改旧会话。

## 阶段三：开始之前留痕，结束之后再确认

现在实现 recovery-store.ts，把运行步骤与磁盘记录接起来。第 11 篇的保存器仍负责 journal.jsonl 和 checkpoint.json；本文件在它外面管理 recovery.json，记录本段是否开始、哪些调用已经获准进入执行、段结果是否足以确认。

先只跟首次保存的正常例子：Agent 读取源码和测试，然后暂停。调用和返回顺序如下：

```text
应用创建写入器
→ Agent 等 begin：先写 open，才启动循环
→ 循环调用包装后的 executeTool：先登记 source-1，再真正读取
→ 同样登记并读取 tests-1
→ 两份 ToolResult 回循环，循环写 State，再以 paused 退出
→ Agent 等 save：先保存整个 RunResult，再把标记改成 sealed
→ 运行结果回到应用入口
```

本文件会在这条链上被多次调用，不是从第一行一路自动执行到最后。应用将同一个写入器接到两处：Agent 的 resultSink，以及交给循环的 executeTool 包装。下面分别实现这几个进入位置。

### 8. 创建持有同一份写入状态的对象

新建 `src/runtime/recovery-store.ts`，先写导入：

<<< ../snippets/12/src/runtime/recovery-store.ts#imports

再追加类的开头、字段与完整构造函数：

<<< ../snippets/12/src/runtime/recovery-store.ts#setup

这一块打开了 RecoveryWriter 类，后面的完整方法继续写在类里面。**此时不要另加结束类的右花括号**；第 12 步的 close 代码包含它。整份文件完成后再运行类型检查，避免把尚未结束的类当成最终语法错误。

#### 先认清这个对象里保存的东西

这里没有模型消息列表，循环的 State 不存放在这些字段里。它们保存的是一份会话目录对应的记录工作：

| 字段 | 在本例中装什么 | 为什么要一直留在对象中 |
|---|---|---|
| directory、path | 会话目录与其中 recovery.json 的路径 | begin、工具登记、save 都要操作同一个标记文件 |
| store | 第 11 篇创建的 SessionStore 对象 | 后面用它保存完整结果与关闭日志；它不是一段 JSON |
| inspectEnvironment | 随时重新检查当前环境的函数 | 当前资源或授权可能变，不能只保存第一次检查的值 |
| boundary | 本段的阶段、环境、调用清单与凭据 | 构造时是待写初值；之后只有 persist 成功才替换 |
| tail | 当前写入队列的结束 Promise | 下一份标记修改必须等前一份结束 |
| sequence | 这个新目录已经保存了几段结果 | 分配日志序号，不是模型决策次数 |
| active | 当前段是否已开始且还未完成结果保存 | 阻止没开始就登记、重复 begin 等错误调用 |
| poisoned | 排队工作是否曾异常退出 | 一旦不能确认写入情况，拒绝继续掩盖现场 |
| closed、closing | 是否停止接收新工作，以及关闭操作的 Promise | “不再接收”与“已经关好”是两个时刻 |

class 让这些值属于同一个写入器实例，this 表示当前对象。private 字段通过类的方法管理；implements RecoveryStore 只检查这份类是否提供了接口要求的方法，不会替我们执行保存。

#### 构造函数还没有开始运行任务

例如后面的工厂把原保存器、sessionId=lesson12、刚检查的环境与 inspect 函数传进 constructor。构造函数把它们存起来，拼出 recovery.json 的路径，并建立初始 boundary：phase=open、intents 为空、receipt=null。

**此时 boundary 还只是内存对象。** constructor 没有调用 replaceTextFile，也没启动模型或工具。下一节的 initialize 才会写出第一份标记。

environment 是一次检查得到的具体值；inspect 是以后可以再次调用的函数。保存二者是为了既知道“预期是什么”，又能问“现在是什么”。新目录的 sequence 从 0 开始；以后安装旧任务时，State.decisions 可以已经是 1，二者不会自动同步。

### 9. 先准备写标记与排队的方法

在构造函数之后、类内部追加以下三个完整方法：

<<< ../snippets/12/src/runtime/recovery-store.ts#helpers

#### initialize 与 persist：对象什么时候真的变成文件

工厂建立对象后会显式调用 initialize。它把构造时的 boundary 交给 persist，等待第一份 open 写入。定义 initialize 方法并不会自动调用它。

**讲解摘录 · persist 的三个连续动作（无需写入文件）**

<<< ../snippets/12/src/runtime/recovery-store.ts#explain-persist

next 是这次想保存的新标记；checked 是按本章格式检查后得到的对象。先把 checked 序列化成文字，再等待 replaceTextFile 写入 recovery.json。成功后，才让 this.boundary 指向 checked，作为下一次修改的基础。

这里是替换整个标记文件，不是向 JSONL 日志追加一条。末尾加换行只是文本格式；日志追加仍由内部的原 store 负责。若文件替换抛错，最后的赋值不会执行，内存不能假装新标记已经保存。

#### enqueue：为什么不能直接同时改同一个文件

假设两项工具都准备登记：源码调用想把清单从空改为 `[source-1]`，测试调用也从空构造 `[tests-1]`。若同时替换文件，最后可能只剩其中一项。排队的目的，是让第二次修改看到第一次已经保存的 boundary，再追加自己的身份。

先分清三个对象：

| 名称 | 是什么 | 在哪里结束 |
|---|---|---|
| work | “轮到我时要做什么”的函数 | 调用 work() 才开始这次工作 |
| operation | 本次排队操作的 Promise | 等前项结束、检查通过、work 执行结束后成功或失败 |
| this.tail | 后续操作与 close 等待的队列末端 | 本次操作成功或失败都处理完后结束 |

`this.tail.then(async () => { ... })` 把新工作接到旧末端之后。传入的是函数，不是已经开始的写盘 Promise。轮到它时，先看 poisoned；没有故障才调用并等待 work()。

work 内任何异常都会设置 poisoned 再抛出，包括文件写入失败，也包括段状态或授权检查失败。本篇采取保守策略：这一个写入器停止接收后续实际工作，先检查现场，不自动重试。

**讲解摘录 · 两个 Promise 各自交给谁（无需写入文件）**

<<< ../snippets/12/src/runtime/recovery-store.ts#explain-tail

operation 原样交回调用者，所以 begin 或 save 的调用方仍能收到异常。tail 的两个空处理函数只把“前一项已经结束”转换成可等待的队列末端；它没有把 operation 的失败改成成功。下一项即使排上队，仍会被 poisoned 拒绝，不会继续写盘。

这里排队的是标记与结果保存。实际工具执行不放在这条队列里，后面的 wrap 会显示这个区别。Node 的异步文件操作不会自动为同一文件排好并发修改顺序，因此必须明确这些等待关系。[Node 22.18：文件系统 Promise API 的并发说明](https://nodejs.org/download/release/v22.18.0/docs/api/fs.html#promises-api)

### 10. 段开始：先使旧许可标记失效

begin 的调用方是稍后修改的 Agent.start：实例必须等本方法成功，才调用 runAgentLoop。继续在类内部追加：

<<< ../snippets/12/src/runtime/recovery-store.ts#begin

先走第一次启动。初值 active=false、sequence=0、phase=open，所以两项段状态检查都通过。接着调用 inspectEnvironment，取得现在的资源与授权，再与 boundary 中的预期环境比较。

**讲解摘录 · 最后才承认本段已开始（无需写入文件）**

<<< ../snippets/12/src/runtime/recovery-store.ts#explain-begin

persist 写一份 open，清空本段 intents，移除 receipt。等文件写好，active 才变为 true；排队工作结束后，begin 的 Promise 成功返回，Agent 才能继续启动循环。这不是给模型发消息，也没有增加 decisions。

为什么新目录已经有 open，还要在 begin 写一次？因为同一写入器也可能在暂停后继续。上一段留下的 sealed 只确认上一段，新段开始前必须撤掉那份旧确认，否则中途退出时，读取器可能仍把旧标记当作当前进度的许可。

#### 两个检查分别防止什么

- active=true：上一段还在进行，不能再次开始。
- sequence>0 且 phase 不是 sealed：已经保存过段结果，但执行或环境没能确认，不能开启新段，把待核查清单覆盖掉。

首次创建的 open 不是上述第二种情况，因为 sequence 仍是 0。上一段已确认 sealed 时则可以进入新段，先改回 open，再开始新工作。**phase 说的是磁盘恢复依据，active 说的是写入器是否处于一个活动段，两者用途不同。**

如果门禁检查之后、begin 之前资源改变，sameEnvironment 会抛出错误，下面的 persist 和循环都不会执行。它缩小了检查与启动之间的空隙，但不是资源锁；检查完成后仍可能有其他进程修改文件。

### 11. 工具入口：先登记，再允许执行

这一节有两个时刻：应用组装时调用 wrap，循环执行请求时才调用它返回的函数。继续在类内部追加完整方法：

<<< ../snippets/12/src/runtime/recovery-store.ts#wrap

#### 第一层调用只产生一个新的执行函数

**讲解摘录 · wrap 接收函数，再返回函数（无需写入文件）**

<<< ../snippets/12/src/runtime/recovery-store.ts#explain-wrap

`Dependencies["executeTool"]` 是从类型里取出执行器的函数类型，不是一次执行。传进来的 execute 是已有执行器，保留在返回函数能访问的位置。应用写 `store.wrap(execute)` 时，只得到新的 async 函数，没有请求 call，因此还不会登记或读取文件。

以后循环调用这个新函数，call 才是本次请求，signal 才是本次运行信号。假设 call.id=source-1、call.name=read_source，intent 就只取出这两项身份；工具参数仍随 call 留给实际执行器。

#### 第二层调用先排队登记，再交给实际工具

这次队列中的 work 依次做四件事：确认 active，重新检查当前工作区与工具许可，拒绝重复 id，最后 persist 新调用清单。

第一次登记时，清单从空变为 `[source-1]`；下一项 tests-1 轮到时，从已经保存的新 boundary 追加成 `[source-1, tests-1]`。它不是各自拿空数组去覆盖文件。

这里检查的是工作区身份和本次工具名是否仍允许；没有在这个条件里比较整份 revision。段开始与段结束还会做完整环境比较，参数合法性则继续交给原执行器与工具 parse。这几个位置检查的对象不同。

**讲解摘录 · 等登记完成以后，才进入真正执行（无需写入文件）**

<<< ../snippets/12/src/runtime/recovery-store.ts#explain-dispatch

await enqueue 成功后，才到这两行。若登记失败，await 抛错，execute 不会被调用。登记期间若收到取消，第二次 throwIfAborted 会停止这里；此时留下一个开始标记，但可能还没实际执行，所以标记只能解释为“需要核查”，不能解释为“必然做过”。

`return execute(call, signal)` 把实际执行器的 Promise 结果交给外层 async 函数等待，最终 ToolResult 回到循环。**这里没有把 ToolResult 写入 State，也没有删除 intent。** 循环随后负责写回；整个段结果落盘后，save 才能确认这些调用。

实际 execute 位于 enqueue 外面。如果批次配置允许并行，第一项登记完成后可以开始执行，另一项继续排队登记再执行；标记顺序被控制，工具等待不因此强制串行。本章默认保存入口仍按原配置执行，不能把这个能力说明当成它一定发生了并行。

### 12. 段结束：结果落盘后再核对每项观察

循环退出后，Agent 把本段 runId 和完整 RunResult 交给 save。以首次正常暂停为例：result.state 有 user、assistant、两条成功 tool，共四条消息；result.outcome 是 paused。继续在类内部追加：

<<< ../snippets/12/src/runtime/recovery-store.ts#save

#### 先固定这次要保存的数据，再让原保存器工作

assertJsonData 在复制前拒绝无法按协议保存的值，structuredClone 在排队前形成 snapshot。调用方后来修改原 result，也不会改变本次待写内容。这里保存的是副本，不是循环的实时 State。

**讲解摘录 · 先保存完整段结果（无需写入文件）**

<<< ../snippets/12/src/runtime/recovery-store.ts#explain-log

`this.store` 是内部的第 11 篇保存器。它先写 journal.jsonl，再更新 checkpoint.json；这次 await 成功后，才将本目录 sequence 从 0 加到 1，并把 active 改为 false，表示本段结果保存步骤已经完成。

此时仍不一定 sealed。结果保存下来了，与所有开始过的调用都已确认，是两件事。active=false 也不保证外部工具都已停止；取消后仍运行的工具，需要通过下面的确认检查保留不确定性。

#### 用已保存的成功观察，逐项核对登记清单

**讲解摘录 · intents 与成功 callId 对照（无需写入文件）**

<<< ../snippets/12/src/runtime/recovery-store.ts#explain-confirm

flatMap 检查每条消息：成功的 tool 返回一项 callId，其他消息返回空数组；拼平后再构成 Set。因此本例 confirmed 含 source-1、tests-1，而不是四个消息角色名。

every 逐项问：boundary.intents 中的这个 id，是否在成功观察集合里？两项都有才继续。若只确认 source-1，tests-1 缺结果或是 error，就执行 return，后面的 sealed 写入被跳过。

这个 return 结束的是排队工作，save 的 Promise 正常完成：结果已经保存，但恢复标记保持 open。它不会自动生成缺失结果，也不会把工具错误改成成功。下一次恢复检查仍阻止继续，同一写入器的下一次 begin 也会被第 10 步的检查拒绝。

如果续运行没有新工具请求，begin 已把本段 intents 清空；空数组调用 every 的结果为 true，意思是本段没有待确认调用，并非漏查。旧 State 中已有的工具结果仍保留；调用 ID 的跨历史查重继续由循环负责。

#### 最后再核对环境，并绑定这份结果

成功观察齐全后，再调用 inspectEnvironment。若资源版本或工具清单改变，直接保留 open；即使工具自报成功，也不在本章自动接受已经变化的资源环境。

**讲解摘录 · sealed 必须对应刚保存的具体日志（无需写入文件）**

<<< ../snippets/12/src/runtime/recovery-store.ts#explain-seal

record 按原日志协议组装：seq 是本目录的保存编号，runId 是 Agent 从本段事件取得的身份，result 是同一份 snapshot。recordDigest 据此生成摘要，再随 seq、runId 写入 receipt。恢复读取器才能核对“这个 sealed 指的正是最后一条日志”。

persist 成功之后，磁盘和内存 boundary 才都变成 sealed；save 结束，Agent 随后发布 lastResult 并把 RunResult 交回应用。这个方法不返回另一份模型答案，也不负责更新消息。

几种失败位置要分清：原 store.save 抛错时，后续计数与核对不执行；最终标记写入抛错时，日志可能已保存，但确认失败，Agent 会报告保存异常；缺成功观察或环境不一致时，不抛写入异常，而是保留 open 供后续核查。本篇不会把这些情况统称为“什么都没写”。

#### 关闭写入器，只等待记录工作，不撤销工具

最后在类内部追加完整 close。**此代码最后一个花括号结束 RecoveryWriter 类，不再额外补一个：**

<<< ../snippets/12/src/runtime/recovery-store.ts#close

第一次调用先设 closed=true，使后续 enqueue 立即拒绝；再把“等 tail 结束、调用原 store.close”这项 Promise 存到 closing，并返回它。以后调用 close 仍返回同一份 closing，所以不会在首次关闭尚未完成时就假装关好。

tail 已处理队列中的拒绝，因此某次登记失败后仍能走关闭。它等待的是此前已接受的记录工作，不是所有底层工具 Promise；已经开始的外部副作用也不会因关闭句柄而撤销。

### 13. 工厂只负责创建并初始化

现在已离开类，在文件末尾追加工厂函数：

<<< ../snippets/12/src/runtime/recovery-store.ts#create

应用会调用 `await createRecoveryStore(base, sessionId, inspect, expected)`。expected 是刚确认的环境值，inspect 是以后可重新取得当前环境的函数。工厂先检查 expected，再创建原 SessionStore；这里已经有新目录和日志句柄。

随后 new RecoveryWriter 只建立内存字段；`await writer.initialize()` 才写出第一份 open。等它成功，工厂返回 writer，应用才能把这个对象用作 resultSink，并调用它的 wrap 组装执行器。因此，**取得对象时，初始标记已经写好；运行段仍未开始，active 还是 false。**

initialize 若抛错，catch 关闭已创建的原日志，再把错误交回应用。目录保留供检查，不悄悄删除现场或重试。外部拿到 RecoveryStore 接口，不需要直接操作内部原 SessionStore。

#### 整份文件怎样进入同一个任务

返回的 store 不是一份日志内容，而是持有同一份写入状态的对象。正常任务会从不同位置进入它：

| 调用位置 | 进入本文件的哪项能力 | 成功后回到哪里 |
|---|---|---|
| 应用入口 await createRecoveryStore(...) | 创建目录和初始 open | 得到 store，继续组装实例 |
| Agent.start 的 await resultSink.begin() | 核对当前环境，写段开始 open | Agent 才调用 runAgentLoop |
| 循环调用已经包装的 executeTool | wrap 返回的函数先登记调用，再调用实际执行器 | ToolResult 回到循环，由循环写 State |
| Agent 等循环返回后 await resultSink.save(...) | 保存完整结果，再核对并封闭边界 | Agent 发布 lastResult，运行 Promise 才返回 |
| 应用入口的 finally | close 等队列并关闭底层句柄 | 当前入口完成收尾 |

沿首次暂停回看字段：构造时 active=false、sequence=0；begin 后 active=true；两项工具登记期间 phase 一直 open；段结果保存后 active=false、sequence=1；成功观察和环境都通过后才 sealed。State 里的消息由循环逐步增长，写入器始终只保存结束副本和自己的记录状态。

## 阶段四：让实例安装状态，并等开始准备

### 14. 扩展必须等待的保存接口

这个文件仍是 Agent 与保存实现之间的接口。Agent 只需要知道“开始前要等什么、结束后把结果交给谁”，不应为不同保存器直接导入文件系统。

完整替换 `src/runtime/result-sink.ts`：

<<< ../snippets/12/src/runtime/result-sink.ts

与第 11 篇相比，只增加可选 begin。原 SessionStore 没有它，旧入口照常工作；RecoveryStore 提供它，实例必须等待。save 的失败处理和 ResultSaveError 保留。

ResultSink 只是约定，不是另一个写入器。应用把实际 store 放进 AgentOptions.resultSink，Agent 再调用该对象的方法；真正的方法体在 recovery-store.ts 或原 session-store.ts。接口文件本身不会创建目录或保存数据。

### 15. 完整替换 Agent 文件

Agent 是应用直接操作的运行实例：接收 run、pause、resume 等请求，持有当前活动控制器和结束快照，再调用原循环完成任务。本篇在它上面接入“新进程安装暂停状态”和“启动前等待磁盘准备”，而不是把这些责任塞进循环。

用下面完整代码替换 `src/runtime/agent.ts`：

<<< ../snippets/12/src/runtime/agent.ts

先看具体变化，不必重新追读所有旧方法：

| 位置 | 改了什么 | 为什么 |
|---|---|---|
| 顶部导入 | 复用 createRunState | 安装状态时复制并核对历史完整边界 |
| restore 方法 | 新增只安装暂停结果的入口 | 让新实例拥有已检查的结束快照，不立即执行 |
| start 的 try 内、调用循环前 | 可选地 await resultSink.begin | 旧标记失效与环境再检查成功后，才发起模型或工具 |
| 其他输入、暂停、取消、结果保存 | 沿用第 10、11 篇 | 不把恢复逻辑重新塞进循环 |

**讲解摘录 · 先安装暂停状态（无需写入文件）**

<<< ../snippets/12/src/runtime/agent.ts#restore

只有全新且空闲的实例允许安装，防止覆盖正在执行或已保存的另一任务。paused 之外的结果拒绝；createRunState 继续检查目标、计数和完整工具交互，再保存副本。

restore 是状态安装方法，不是文件恢复门禁。应用必须先用 inspectRecovery 检查磁盘和当前环境；不能把未验证 JSON 强行断言成 RunResult，就绕过检查。方法成功后仅变成可 resume 的暂停实例，没有调用 decide。

**讲解摘录 · 循环前必须完成的准备（无需写入文件）**

<<< ../snippets/12/src/runtime/agent.ts#begin

start 先按旧逻辑占用实例，再进入 try。配置有 begin 才等待；没有则保留旧时序。begin 失败时循环尚未调用，不会发 run-started，finally 仍释放实例。此时错误原样抛出，不包装成“循环结束但保存失败”。

循环结束后的 save 与 lastResult 发布顺序仍和第 11 篇相同。循环本身的 timeout 不覆盖外面的 begin 与 save 文件等待；本篇没有新增磁盘超时控制。

将 Agent 作为整份文件看，外部恢复入口先调用 restore 安装暂停快照，再调用 resume 提交继续要求。resume 进入 start，start 先等保存器 begin，再调用循环；循环返回完整结果后，start 再等 save，最后把结果交回外部入口。运行期间的实时 State 仍由循环持有，实例只管理进入、退出和结束副本。

保存这些文件后运行 `npm run typecheck`。下一阶段把这些调用真正接进命令入口，不先阅读故障装置。

## 阶段五：保存、检查，再从另一个进程继续

### 16. 第一个入口只负责读完后暂停

仍是原任务和固定模型脚本。本次两项工具真正从刚创建的小工作区读内容。正常过程：创建保存器 → 用 wrap 连接执行器 → 创建 Agent → 读完两项后请求暂停 → 等待保存 → 关闭。

新建 `src/examples/save-recoverable-session.ts`，先写准备部分：

<<< ../snippets/12/src/examples/save-recoverable-session.ts#setup

默认 sessionId 为 lesson12，工作区位于 base/workspace12。inspect 是每次重新检查环境的函数，`await inspect()` 是建立本次预期环境的那份具体值；两者用途不同。

继续在末尾追加完整 try/finally：

<<< ../snippets/12/src/examples/save-recoverable-session.ts#run

本篇有两处必须一起接入：**resultSink:store 负责段开始与段结束；store.wrap(...) 负责工具执行前登记。** 忘记包装执行器，工具就绕开意图记录，不能声称本协议完整生效。普通回调和工具约定都来自可信应用代码，不能把任意外部代码当作受控工具。

results-recorded 发生时两项结果已进入 State，订阅者只请求暂停，不自己写盘。Agent.run 返回后，result 是已经保存的暂停结果；finally 关闭保存器。

```bash
node src/examples/save-recoverable-session.ts lesson12
```

应看到：

```text
已保存暂停（outcome）: paused
已保存消息（messages）: 4
可检查会话（sessionId）: lesson12
```

整份 save-recoverable-session.ts 是本次任务的启动器。终端运行它，它选择任务依赖、连接保存器与实际读取，再调用 Agent.run；result 接住运行返回值，显示后退出。没有其他模块会自动调用这个入口，它也没有实现另一套调度算法。

使用尚不存在的会话名。重复实验时换新名字，不删除已有会话来绕过检查。

### 17. 先只检查这份进度

新建 `src/examples/inspect-recovery.ts`：

<<< ../snippets/12/src/examples/inspect-recovery.ts

这个短入口只取得当前环境并调用门禁，不能执行任务。运行：

```bash
node src/examples/inspect-recovery.ts lesson12
```

```text
恢复检查（status）: ready
已确认消息（messages）: 4
```

inspect-recovery.ts 是给人查看结论的命令：调用工作区模块取得 current，再调用恢复读取器取得 decision，显示后退出。它和接下来的续运行命令复用同一个检查，不是“先执行这条命令，就给后续程序留下了一份永久许可”。

ready 只表示本次检查条件通过，不是批准任意工具请求。真正续运行仍要重新取得当前环境，配置模型、执行器、完成规则与本段预算。

### 18. 新进程创建新实例，继续同一个任务

新建 `src/examples/resume-session.ts`，先写检查部分：

<<< ../snippets/12/src/examples/resume-session.ts#inspect

sourceId 指旧会话，targetId 指新的保存目录。这里故意不调用 prepareWorkspace，以免“恢复前准备”改变待检查资源。先取得真实当前环境，再检查；尚未创建 Agent。

继续在末尾追加完整分支：

<<< ../snippets/12/src/examples/resume-session.ts#resume

blocked 分支只显示原因与待核查身份，不创建新保存器，不调用模型或工具。没有清单也可能不安全，例如文件无法读取、凭据不匹配或活动段还没登记工具。

ready 分支中，先创建新的保存目录，expected 使用刚确认的 environment；begin 会在真正运行前再取得当前值。原会话不会追加新记录。

**讲解摘录 · 安装状态与开始续运行是两次明确调用（无需写入文件）**

<<< ../snippets/12/src/examples/resume-session.ts#install

创建 Agent 后，restore 把旧暂停结果装入实例；resume(steerText) 才追加明确的用户继续要求并启动新段。旧两条 tool 仍在历史里，脚本因此直接返回中文诊断，不再次提出读取。

executions 的包装只是观察真正进入本地执行器的次数，store.wrap 才是执行前登记。本次应为 0；如果大于 0，应先看新动作是否重复提出读取，不要改显示值来掩盖它。

```bash
node src/examples/resume-session.ts lesson12 lesson12-resumed
```

```text
恢复检查（status）: ready
续运行结果（outcome）: completed
累计决策（decisions）: 2
消息顺序（messages）: user -> assistant -> tool -> tool -> user -> assistant
本进程工具执行（executions）: 0
```

现在旧日志仍有一条 paused；新目录的第一条结果是 completed，但 State.decisions 是 2。新目录保存编号从 1 开始，累计任务历史与决策数没有清零。

把 resume-session.ts 作为整体看，它连接本章两侧：前半调用恢复读取器取得旧事实与检查结论；后半在允许分支创建新保存器和新实例，调用 restore、resume，最后显示运行结果并关闭保存器。检查器不负责启动，Agent 不负责找磁盘文件，由这个应用入口把两者接起来。

这一过程恢复了旧的事实，没有重放旧工具。恢复后的 Context 仍由原循环从最新 State 重建；不是从磁盘恢复了一份旧模型请求缓存。

## 把文件放回刚才的一次运行

现在这些文件都已实现，可以把具体调用连起来看。先用这张图找到入口、实例、循环和磁盘模块的位置：

[![恢复入口把当前环境交给读取器，读取器返回结论；允许后进入 Agent 与原循环，Agent 在循环前后分别等待恢复写入器](/diagrams/recovery-file-connections.svg)](/diagrams/recovery-file-connections.svg)

点击放大。实线表示调用，蓝色虚线表示返回；图省略了其他辅助导入和本例没有发生的新工具执行。右侧从 Agent 连到保存器的线表示：**begin 与 save 由实例等待，不是循环直接写磁盘。**

读图时先走左侧“当前环境 → 恢复检查 → decision 回到入口”；只有 ready 才向右进入实例。再沿“实例 → 循环 → RunResult 回到实例”看运行，最后确认结果经过保存器才交回入口。

<details>
<summary>展开文字版调用链，对照具体函数与返回值（无需写入源码）</summary>

**恢复前的检查链：**

```text
终端启动 resume-session.ts
  → recovery-workspace.ts：inspectWorkspace(root)
      返回当前环境，入口把它交给检查器
  → recovery-reader.ts：inspectRecovery(base, sourceId, current)
      读 recovery.json；用 recovery-codec.ts 检查格式与比较条件
      用原 session-reader.ts 加载已保存结果
      返回 decision 给 resume-session.ts
  → blocked：入口显示后退出
  → ready：入口取得四条消息的暂停 result，创建新保存器与 Agent
```

**恢复后的运行链：**

```text
resume-session.ts 调用 agent.restore(result)，再调用 agent.resume(steerText)
  → agent.ts：start 等 recovery-store.ts 的 begin 完成
  → agent-loop.ts：从恢复的 State 与新要求构造本轮 Context，调用 decide
      本例已有两份结果，脚本直接提出 finish，没有新的工具调用
  → 循环返回带六条消息的 RunResult 给 Agent
  → agent.ts：等 recovery-store.ts 的 save 完成
      内部调用原 session-store.ts 写日志与检查点，再核对恢复标记
  → Agent 返回结果，resume-session.ts 显示 completed 并 close
```

若新段提出工具请求，路径才会进入 `store.wrap(...)` 返回的函数，登记后再走 recovery-workspace.ts 创建的执行器；本例没有该请求，因此工具计数是 0。**创建了执行器，不代表这次必然执行工具。**

</details>

由此可以按用途阅读：想追“为什么不允许恢复”看 recovery-reader.ts；想追“执行前有没有留下标记”看 recovery-store.ts；想追“新实例怎样继续”看 agent.ts 与原循环；想换一份任务材料，改应用资源适配和场景，而不是改恢复协议。

## 故障实验：先理解停止原因，再读装置

先跑通前面的正常过程。这一节只在自己创建的系统临时目录操作，不破坏正式 lesson12 会话。每次命令只制造一种故障。

| 模式 | 改变什么 | 应看到什么 |
|---|---|---|
| changed | 保存后修改源码文件 | 资源版本不同，blocked |
| revoked | 当前只允许 read_source | 工具清单不同，blocked |
| tail | 日志末尾增加半份 JSON | 不完整，blocked |
| receipt | 将标记摘要改错 | 与最后结果不匹配，blocked |
| old | 移除本章新增标记 | 旧结果可读，但恢复依据不足 |
| crash | 子进程写一行后立即退出 | 已有一次副作用，待核查 write-1，blocked |

### 19. 创建写入后退出的子进程装置

这个文件**不作为正常入口运行**。后面的父入口会把它放进临时目录，并检查预定退出码 23。

<details>
<summary>src/examples/crash-after-write.ts：完整故障装置</summary>

新建 `src/examples/crash-after-write.ts`，写入：

<<< ../snippets/12/src/examples/crash-after-write.ts

</details>

crash-after-write.ts 是被父实验入口启动的子进程，不是正常 Runtime 模块。父入口传入临时目录，它组装同一个 Agent 和 RecoveryStore，只把执行体替换成“写完立刻退出”的装置。

按一条时间线理解即可：Agent 等 begin → wrap 写下 write-1 → 执行体追加一行并 sync → process.exit(23) → 没有 ToolResult 返回，也没有本段 save。这里是受控的突然退出实验，不等同于测试了所有操作系统崩溃与断电情况。

固定工具只接受 append_mark 与空参数。它写 effect.log，而不是修改 Runtime 源码；写入确实发生，缺的只是可交回并保存的结果。

### 20. 创建临时实验入口

<details>
<summary>src/examples/inspect-recovery-faults.ts：选择一种故障并只读检查</summary>

新建 `src/examples/inspect-recovery-faults.ts`，写入：

<<< ../snippets/12/src/examples/inspect-recovery-faults.ts

</details>

要运行以下命令，需要先展开并创建两份完整文件。装置复用正式保存入口的子进程，不另写一套 Runtime。runExample 只检查子进程是否按预期退出；父入口最后仍调用本章同一个 inspectRecovery。

inspect-recovery-faults.ts 则是这个实验的父命令：先选择一种故障，启动正式保存入口或写后退出子进程，再取得当前环境，调用同一个 inspectRecovery，接住 decision 并打印。它测的是核心模块在造错之后的反应，没有为实验单独实现一套恢复判断。

finally 仅删除 mkdtemp 创建的目录，正式 .agent-data 会话保留。造错代码不应复制到正常工具或 Runtime 里面。

先比较两个恢复前置条件：

```bash
node src/examples/inspect-recovery-faults.ts changed
node src/examples/inspect-recovery-faults.ts revoked
```

两次都输出 status 为 blocked，原因是 `Workspace revision or current tool grant changed`。前者不能继续使用旧源码证据，后者不能继续使用旧授权。这里合并一种原因文字，但实验制造的条件不同。

再看记录一致性：

```bash
node src/examples/inspect-recovery-faults.ts tail
node src/examples/inspect-recovery-faults.ts receipt
node src/examples/inspect-recovery-faults.ts old
```

三次都为 blocked，分别指出日志不完整、凭据不匹配、缺少恢复文件。old 的具体路径和系统错误文字随环境变化，不要求逐字相同。检查函数不会自己修复或继续执行。

最后看本篇最重要的反例：

```bash
node src/examples/inspect-recovery-faults.ts crash
```

```text
实际写入次数（effects）: 1
恢复检查（status）: blocked
停止原因（reason）: Segment has no sealed result; inspect possible effects
待核查调用（intents）: write-1
```

下面按先后顺序对比首次保存进程与故障子进程，找出差别出现的位置。这是两次独立实验，不是同一次任务先正常结束又崩溃：

[![正常进程在工具结果写回并落盘后标记 sealed；故障进程写完外部文件却在返回结果前退出，保持 open，下一进程阻止恢复](/diagrams/recovery-save-versus-crash.svg)](/diagrams/recovery-save-versus-crash.svg)

点击放大，从上往下看。两边都先登记意图；右边在外部写入之后退出，缺少左边的“ToolResult → State → 已保存结果 → sealed”。这就是为什么一个执行开始标记不能被当成成功结果。

结果缺失，但写入次数已经是 1。门禁没有把写入再运行一次。它只知道“登记过这个调用，没走到可以核对的段结束”，需要应用检查实际文件、外部资源或服务查询结果，再决定如何处理。

effect.log 不在两份诊断材料的摘要中，这次仍因未确认意图而停止。资源版本比较不能替代执行记录，两者要分别检查。

不要手工把 phase 改成 sealed，不要删标记假装是新任务，也不要把错误 ToolResult 改成 ok 来通过检查。本章提供的是阻止不安全自动恢复的机制，没有实现人工核查后的补偿、重建边界或服务幂等协议。

## 怎样调试恢复，而不是只看最终状态

| 症状 | 从哪里开始 | 要观察什么 |
|---|---|---|
| 文件能读，却 blocked | inspectRecovery | phase、最新日志、receipt 哪一项先不匹配 |
| 刚检查 ready，启动仍失败 | RecoveryWriter.begin | expected 与重新取得的 current 是否不同 |
| 工具没有启动 | RecoveryWriter.wrap | 许可、persist 或 signal 检查是否先失败 |
| 工具返回后仍是 open | RecoveryWriter.save | 是否有错误/缺失结果，环境是否改变 |
| 恢复后又读取材料 | 新段的 Action 与 Context | 原 State 是否安装，脚本是否使用已有证据 |
| 看到结果但保存失败 | Agent.start 的 save | 日志可能写完，最终标记是否仍 open |

用新的目标会话名启动调试，避免重复目录：

```bash
node --inspect-brk src/examples/resume-session.ts lesson12 lesson12-debug
```

第一次只跟正常路径设四个断点：

1. inspectRecovery 返回 ready 前：result 的四条消息来自旧日志；current 来自本次环境检查。
2. Agent.restore 之后：lastResult 是复制的暂停结果，控制器还没启动。
3. RecoveryWriter.begin 完成后：新目录标记为 open；旧目录不改。
4. 新段 decide 取得 Context 时：五条消息，最后一条为继续要求；已有源码与测试结果仍在。

本例不为调试设置很短的循环 timeout。begin 与 save 在循环时间边界之外，长时间磁盘等待的独立控制属于后续资源限制，不在本章假装已经覆盖。

### 一个小迁移：拒绝继续，不能启动执行器

只在 `src/examples/resume-session.ts` 中，临时将 inspect 函数改为返回 `inspectWorkspace(root, ["read_source"])`，其他代码保持不变。用先前保存的 lesson12 检查，目标目录取一个尚未存在的新名字。

应输出 blocked，不出现“续运行结果”，也不创建目标会话目录。授权在创建实例前就被拒绝，不能仅在执行器里报错后宣称恢复门禁生效。实验后恢复原 inspect 函数，再按正常命令验证。

## 再看 Pi：安装历史与继续是两个动作

阅读固定提交 `8efd314fa3d3232ce197d8d7a6a5660530b9d83e` 的 [SessionManager.buildSessionContext](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/coding-agent/src/core/session-manager.ts#L537-L545)：它从会话投影构造模型可用消息。再看 [Agent.continue](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/agent/src/agent.ts#L361-L388)：继续前检查活动运行与最后消息角色，再进入低层继续入口。

这里对照的是“从保存记录得到输入”和“什么时候能启动继续”的职责区别。Pi 的会话投影、消息模型与继续条件不同于本系列 paused → restore → resume；本篇的 recovery.json、资源摘要、工具清单比较和保守阻止规则是项目自己的协议，不能把这几处 Pi 源码当作它们已具备同样语义的证据。

## 完整最终文件

下面是本篇 15 个新增或修改文件，便于核对。其余第 11 篇源码保留；分步完成后应与这里完全一致。故障装置也包含在内，但不参与正常运行主线。

### src/runtime/recovery-types.ts

<<< ../snippets/12/src/runtime/recovery-types.ts

### src/runtime/recovery-codec.ts

<<< ../snippets/12/src/runtime/recovery-codec.ts

### src/runtime/recovery-store.ts

<<< ../snippets/12/src/runtime/recovery-store.ts

### src/runtime/recovery-reader.ts

<<< ../snippets/12/src/runtime/recovery-reader.ts

### src/runtime/result-sink.ts

<<< ../snippets/12/src/runtime/result-sink.ts

### src/runtime/agent.ts

<<< ../snippets/12/src/runtime/agent.ts

### src/examples/read-source-tool.ts

<<< ../snippets/12/src/examples/read-source-tool.ts

### src/examples/read-tests-tool.ts

<<< ../snippets/12/src/examples/read-tests-tool.ts

### src/examples/recovery-workspace.ts

<<< ../snippets/12/src/examples/recovery-workspace.ts

### src/examples/inspect-recovery-environment.ts

<<< ../snippets/12/src/examples/inspect-recovery-environment.ts

### src/examples/save-recoverable-session.ts

<<< ../snippets/12/src/examples/save-recoverable-session.ts

### src/examples/inspect-recovery.ts

<<< ../snippets/12/src/examples/inspect-recovery.ts

### src/examples/resume-session.ts

<<< ../snippets/12/src/examples/resume-session.ts

### src/examples/crash-after-write.ts

<<< ../snippets/12/src/examples/crash-after-write.ts

### src/examples/inspect-recovery-faults.ts

<<< ../snippets/12/src/examples/inspect-recovery-faults.ts

## 最后检查与保存本章

使用尚不存在的会话名。先恢复小迁移中对 inspect 的临时修改，再运行：

```bash
npm run check
node src/examples/inspect-recovery-environment.ts
node src/examples/save-recoverable-session.ts lesson12-check
node src/examples/inspect-recovery.ts lesson12-check
node src/examples/resume-session.ts lesson12-check lesson12-check-resumed
node src/examples/inspect-recovery-faults.ts changed
node src/examples/inspect-recovery-faults.ts revoked
node src/examples/inspect-recovery-faults.ts tail
node src/examples/inspect-recovery-faults.ts receipt
node src/examples/inspect-recovery-faults.ts old
node src/examples/inspect-recovery-faults.ts crash
node src/examples/inspect-input-agent.ts pause
node src/examples/inspect-agent-faults.ts cancel
node src/examples/inspect-stream.ts cut
DOCS_BASE=/ci/ npm run site:build
```

确认正常恢复保留历史与累计决策、没有再次执行读取；资源或授权变化会阻止继续；写后退出能留下待核查身份。也要保留旧的暂停、取消和断流行为。

作者在独立工程复现了分步迁移、类型与现有环境检查、正常跨进程继续、六类故障、写入顺序、并行标记、恢复状态副本、开始前资源变化与旧入口回归。没有读取密钥或调用真实模型，没有验证断电持久性，也没有声称实现任意工具的恰好一次执行。

确认当前分支与改动范围后，再手动保存：

```bash
git branch --show-current
git status --short
git add -- src/runtime/recovery-types.ts src/runtime/recovery-codec.ts src/runtime/recovery-store.ts src/runtime/recovery-reader.ts src/runtime/result-sink.ts src/runtime/agent.ts src/examples/read-source-tool.ts src/examples/read-tests-tool.ts src/examples/recovery-workspace.ts src/examples/inspect-recovery-environment.ts src/examples/save-recoverable-session.ts src/examples/inspect-recovery.ts src/examples/resume-session.ts src/examples/crash-after-write.ts src/examples/inspect-recovery-faults.ts site/
git diff --cached --stat
git commit -F - <<'COMMIT'
第 12 篇：核对恢复依据并阻止未知操作自动重放

让新进程在检查已保存暂停结果、资源版本与当前工具授权后继续同一个任务。

- 增加版本化恢复标记与结果凭据，区分活动段和已确认段
- 执行前保存调用身份，段结果落盘后再核对成功观察
- 增加实例状态安装与必须等待的段开始准备
- 旧会话只读，续运行写入新目录，保留累计任务历史
- 增加真实小文件读取、跨进程继续及隔离的写后退出实验
- 同步分步教程、完整代码、流程图与网站导航

验证：类型与现有环境检查、离线跨进程继续且不重读、资源与授权变化、记录不一致及写后退出拒绝、相关旧入口和网站构建。未调用真实模型，未实现通用幂等、补偿或完整权限隔离。
COMMIT
git push -u origin codex/chapter-12-safe-recovery
```
