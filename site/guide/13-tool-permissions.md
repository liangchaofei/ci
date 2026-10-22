---
title: 第 13 篇｜模型提出写入，谁来授予执行权
description: 从批准一次文件修改出发，在现有工具入口加入策略、人工批准、有效期和资源复核，并用权限受限的可信子进程执行固定文件操作。
---

# 第 13 篇：模型提出写入，谁来授予执行权

前几篇主要读取源码。现在让 Agent 给 sum 添加初始值 0，问题就变了：**模型知道怎样改，不代表它有权修改文件。** 即使人已经回答“允许”，等待期间文件被别人改过，也不能继续按旧内容覆盖。

本篇增加的是执行前的许可检查。完成后，同一个 Runtime 能读取演示副本、展示修改请求、等待批准，只在许可仍然有效时启动写入。拒绝、批准超时、文件变化或路径越界，都会得到错误观察，实际写入不会启动。

这里先用固定脚本扮演模型，避免把模型回答的不确定性和权限行为混在一起。**批准输入、文件读写和子进程都是真实的。** 不需要 API Key，不执行模型生成的任意程序。

## 先看一次任务怎样走完

任务是：“为演示副本的 sum 添加初始值 0。”运行时会新建一个只属于本次实验的目录，里面只有需要操作的 sum.ts。项目自己的 src/ 不作为修改对象。

1. 模型替身提出读取 sum.ts。应用规则允许读取，工具返回源码与内容版本。
2. 循环把读取结果保存进 State，再构造下一轮 Context。模型替身从结果取到版本，提出一次写请求，带上新内容和刚才看到的版本。
3. 执行入口先检查工具是否允许、目标是否属于这个工作区、文件是否仍为读到的版本，再展示请求。此时尚未启动写工具。
4. 用户输入 yes。执行入口重新检查规则、文件版本和批准有效期，通过后才启动一个受限子进程。
5. 子进程写入演示文件，读回内容核对，返回新版本。循环保存成功观察，下一轮才提出完成；完成规则核对写回证据。

若用户拒绝，第 4 步的写入不会发生。拒绝结果仍会进入 State，下一次决策能看到失败原因。本篇脚本据此结束失败；“拒绝一个工具请求”本身没有强迫所有应用都结束任务。

[![模型只提出请求，Runtime 在工具执行前检查应用策略、人工批准和当前文件，再把结果交回循环保存](/diagrams/tool-permission-flow.svg)](/diagrams/tool-permission-flow.svg)

点击图可放大。实线表示请求继续，虚线表示结果返回原循环。原来的 Agent、Context、循环和 State 写回位置不变。

### 三种判断不要混在一起

| 判断 | 当前场景里在问什么 | 谁决定 |
|---|---|---|
| 参数检查 | path 是否为 sum.ts，content 是否是受限长度的字符串 | 可信工具代码 |
| 授权与批准 | 当前规则是否允许这个工具；用户是否同意这次具体修改 | 应用规则与人工入口 |
| 进程权限限制 | 实际文件操作进程能通过 fs 访问哪些路径 | 启动子进程时设置的 Node 权限 |

授权就是决定一个操作是否被允许。策略是应用持有的规则，例如只提供 read_source 和 write_source；批准是用户对**一份具体写请求**的回答。模型参数里放一个 approved: true 不算批准，旧消息里写着“用户同意”也不算。

进程隔离在这里先落实为：实际文件操作由另一个进程完成，读写权限只给固定文件。**本篇不是运行不可信代码的安全沙箱。** 主进程与工具实现仍可信；没有网络隔离、容器、跨用户身份认证或跨进程资源锁。Node 官方也明确说明权限模型不能用于防御恶意代码，并提示符号链接等限制。因此本篇只操作应用新建的私人副本，同时拒绝链接目标。[Node 权限模型及限制](https://nodejs.org/download/release/v22.18.0/docs/api/permissions.html)

### 本章怎样与第 12 篇连接

第 12 篇问“旧进度有没有足够证据允许继续”；本篇问“现在这一次工具请求能不能执行”。恢复检查通过，也必须使用**当前**策略重新创建执行入口。批准不会从旧 State 或日志恢复。

为了集中观察权限，本章主入口不接保存器。接回第 12 篇时，可以在许可执行入口外使用恢复写入器的 wrap：先登记执行意图，再检查许可、执行工具。拒绝或写操作改变资源版本，仍会被第 12 篇保守地保留为不可自动恢复；本篇没有放宽那套判断。等待终端输入期间，Agent 仍在运行，不是第 10 篇的持久暂停点；进程退出后需要重新发起并批准。

## 前置版本、分支与文件地图

从已完成并提交的第 12 篇开始，在仓库根目录运行：

```bash
git status --short
git switch -c codex/chapter-13-tool-permissions
npm run typecheck
```

若分支已存在，使用 git switch codex/chapter-13-tool-permissions。运行环境沿用 Node >= 22.18.0；本章候选实现实际验证版本为 Node 25.9.0。不新增依赖，先不编写单测。

| 文件 | 变化 | 在刚才那次任务里做什么 |
|---|---|---|
| src/runtime/types.ts | 修改一处 | 增加权限拒绝的工具错误种类 |
| src/runtime/session-codec.ts | 修改一处 | 保存的错误观察读回时，也认可新种类 |
| src/runtime/authorization.ts | 新增 | 检查策略、等待批准、再次核对，最后调用原执行器 |
| src/examples/inspect-authorization.ts | 新增，独立入口 | 先用模拟执行计数看见拒绝不会执行 |
| src/examples/file-worker.ts | 新增，子进程入口 | 真正打开、读取或修改固定文件 |
| src/examples/file-process.ts | 新增，被工具导入 | 用固定命令和权限启动上一个入口，接住 JSON 返回值 |
| src/examples/permission-workspace.ts | 新增，被入口导入 | 新建副本，检查路径与版本，组装受限文件工具 |
| src/examples/permission-scenario.ts | 新增，被入口导入 | 模型替身与本例完成规则 |
| src/examples/approve-file-change.ts | 新增，独立入口 | 组装 Agent，向终端询问批准 |
| src/examples/inspect-permission-faults.ts | 新增，独立入口 | 在新副本中复现六种拒绝 |

只有 authorization.ts 是本章新增的通用 Runtime 模块。sum.ts 的路径、修改内容、终端界面以及文件操作实现属于应用场景，所以放在 examples；它们包含真实 I/O，不是全部都在“假装执行”。agent-loop.ts 不需要知道怎样打开文件或怎样询问用户。

下面按阶段实现。每一步的代码需要写入指定文件；标为**“讲解摘录（无需写入文件）”**的短片段已经包含在上方实现里，只供对照，不要重复追加。完整文件在章末统一核对。

## 阶段一：先让拒绝挡在执行之前

### 1. 给拒绝结果一个程序能识别的种类

修改 src/runtime/types.ts：只替换原来的 ToolErrorCode 声明，其余内容保留。

```ts
export type ToolErrorCode = "unknown-tool" | "invalid-arguments" | "tool-error" | "permission-denied";
```

再修改 src/runtime/session-codec.ts 的 parseToolResult：找到检查 result.code 的那一个数组，仅将其替换为：

```ts
["unknown-tool", "invalid-arguments", "tool-error", "permission-denied"]
```

第二段是表达式替换，不是在文件末尾追加一个数组。新错误仍带 callId，所以循环可以按原协议把它保存为 tool 消息。若只改类型，不改读回检查器，内存中合法的新观察会在以后读会话时被拒绝。

permission-denied 表示许可入口没有放行。更细的原因暂时放在 message，例如 approval-denied；本章不通过匹配这些文字安排自动重试，完整错误分类放到后续章节。

### 2. 明确执行入口接收哪些可信依赖

新建 src/runtime/authorization.ts，先写入：

<<< ../snippets/13/src/runtime/authorization.ts#contracts{ts}

先看四份数据的区别。ToolCall 来自模型，包含 id、name、arguments。ExecutionPolicy 来自应用，只有“当前版本和允许工具”；它不是模型输入中声明的权限。Operation 是应用检查工具请求后给出的描述，例如 `{ effect: "write", version: "原文件摘要", summary: "write sum.ts" }`。ApprovalRequest 把这些信息整理给人工界面看。

这里的 version 用内容摘要表示：同一段文本产生同一个 SHA-256 字符串，改动文本通常会得到不同值。本例借它判断读取之后文件有没有变化。摘要不证明作者身份，也不是授权凭证。

AuthorizationOptions 中，inspect 只检查与读取当前事实，不写文件；approve 等待外部回答；execute 才开始真实操作。getPolicy 每次返回当前应用规则，避免先保存一份规则后永远不再确认。类型并不能阻止应用把依赖接错，稍后会沿实际组装代码核对它们。

approve 接收的是请求副本，返回 `Promise<boolean>`：true 是同意，false 是拒绝。这个函数只能由可信应用提供。模型可以提出请求，不能提供这个回调，也不能改变它返回的结果。

### 3. 等待一份有期限的回答

继续在 src/runtime/authorization.ts 末尾追加完整函数：

<<< ../snippets/13/src/runtime/authorization.ts#approval{ts}

假设要批准 write-1，approvalMs 为 60,000。这个函数先记下从现在起一分钟的截止时刻，再复用第 4 篇的运行控制器等待回答。这里的控制器只管理**这一次批准等待**，不是整个 Agent 的两分钟运行限制。

**讲解摘录（无需写入文件）：**

<<< ../snippets/13/src/runtime/authorization.ts#wait-call{ts}

options.approve 收到请求副本和 approvalSignal。稍后的终端界面拿这个 signal 结束过期问题；若其他界面忽略 signal，control.wait 也会停止等待。正常输入 yes，approve 返回 true，control.check 确认时间仍有效，函数把 deadline 交回许可入口。它没有启动工具，也没有写 State。

Date.now() 生成供界面显示的 expiresAt；真正的间隔核对用 performance.now()。前者是日历时间，后者用于测量经过多久。本项目不把界面显示的时间当成可由调用方续期的授权。

拒绝时抛 approval-denied；等待耗尽则改为 approval-expired。用户取消仍由外层 signal 传入。finally 在任何出口释放监听和计时器。迟到的 true 没有继续执行的位置：这次等待已经结束，接下来也不会调用写工具。

为什么还要返回 deadline？因为用户回答之后，还需要读取文件确认版本。若这段检查又耗费了时间，许可入口必须在实际执行前再确认批准没有过期。有效期限制的是开始操作的时刻；操作已经开始后，批准到期不会自动撤销已经发生的写入。

### 4. 连接检查、回答与实际执行

继续在同一个文件末尾追加：

<<< ../snippets/13/src/runtime/authorization.ts#executor{ts}

先沿正常的 write-1 走。入口保存请求副本，把它排入当前工作区的队列；轮到它时确认没有取消，登记调用身份，读取当前规则。允许工具列表包含 write_source，才会调用 inspect 查看文件。

**讲解摘录（无需写入文件）：**

<<< ../snippets/13/src/runtime/authorization.ts#admission{ts}

policy 是这次取得的规则副本，operation 是这次查到的文件事实。inspect 既确认参数和路径，也确认请求带来的旧版本仍然匹配。到这一步，即使工具名称允许，文件也合法，**写入依然没有启动**。

operation.effect 为 write 才等待批准；read 则按本例规则自动通过人工步骤。它不是模型传来的 effect，决定读写类别的是可信检查器。返回的批准只留在这次函数调用中，没有存入 State，没有生成可以重复使用的 token。

**讲解摘录（无需写入文件）：**

<<< ../snippets/13/src/runtime/authorization.ts#recheck{ts}

用户等待期间可能改了应用规则，也可能亲自编辑了文件。这里重新读规则和文件；任一变化都拒绝。重新检查完成后，再核对取消和批准期限，全部通过后，才会在许可检查的 try/catch 之后调用 `return await options.execute(call, signal)`，把请求交给原工具执行器。inspect 和 execute 之间没有再次等待人回答的过程。

这份实现用 JSON.stringify 比较可信依赖产出的简单对象：字段和顺序必须稳定，顺序变化也会保守拒绝。它不是任意 JSON 的通用等价算法，更不是数字签名。检查器只返回 effect、version、summary，所以这里的比较范围明确。

#### 排队为什么也属于许可入口

**讲解摘录（无需写入文件）：**

<<< ../snippets/13/src/runtime/authorization.ts#queue{ts}

tail 是“之前的调用已经结束”的 Promise。新的 result 等 tail 后才进入 run；随后 tail 接住本次结果，不让一次失败把队列永久堵住。第一次 tail 已完成，所以第一项可以马上开始。

若同一实例同时收到两个写入，让它们各自基于旧内容批准，再一起落笔会很难解释。此处先串行处理这个工作区的全部调用，连批准等待也包含在内。第 7 篇的批次调度仍存在，但这个执行入口会进一步限制实际执行为一项。它是简单、可验证的起点；不是跨实例或跨进程锁。

副本在入队时创建。否则请求排队期间，调用方可能把 content 换掉，批准页面显示的就不再是最初那份请求。检查器和批准界面另外拿副本，所以它们修改参数也不能改掉待执行请求。

usedIds 在这个执行入口的内存中保存已接收的调用 ID，包括被拒绝的调用。相同 ID 再来会拒绝；新请求必须新 ID，并重新检查、重新批准。它不写入磁盘，也不宣称完成跨进程去重。

#### 拒绝怎么回到原循环

实际执行放在许可检查的 try/catch 之后：若执行依赖自身抛错，它仍沿原执行失败路径返回，不能改称“许可没有放行”。

许可入口把拒绝整理为 `{ callId, status: "error", code: "permission-denied", message }`。原循环保存 tool 观察，再次决策；它不因错误文字自行重试。取消时则重新抛出停止原因，让第 4 篇的循环出口返回 cancelled，避免把取消当成一次普通拒绝。

这个文件的完整调用链是：批次执行器调用返回的 executeTool → 请求副本排队 → run 检查和批准 → options.execute 返回 ToolResult → 原循环接住并写 State。文件本身没有任何 State 赋值，也不知道 sum.ts 的内容。

### 5. 第一个可运行检查点：拒绝后执行次数为 0

新建独立入口 src/examples/inspect-authorization.ts：

<<< ../snippets/13/src/examples/inspect-authorization.ts#probe{ts}

这个入口有意不读文件。inspect 返回固定的“写”描述，approve 固定拒绝，execute 里的计数只在真正调用执行依赖时增加。它要先把一件事看清：有请求、有可调用函数，也不意味着会执行。

运行：

```bash
npm run typecheck
node src/examples/inspect-authorization.ts
```

应看到 permission-denied、approval-denied，以及 `[执行次数] 0`。把 approve 的 false 临时改成 true 再运行，得到 ok 和 1；观察完恢复 false。本步骤的版本 demo-version 是模拟值，真实文件版本在下一阶段接入。

## 阶段二：把真正的文件操作放进受限子进程

批准已经可以挡住 execute，但我们仍需要限制获准后的文件操作范围。本例只给一项很窄的能力：读取或替换**新建演示目录里的 sum.ts**。不接受任意路径、不启动 shell、不运行模型提供的代码。

“子进程”就是父程序启动的另一个程序。本例主进程保留 Agent、批准界面与 State；子进程只处理一份文件请求，返回 JSON 后退出。仅设置 cwd 只是改变相对路径起点，不会限制可访问范围；实际读取和写入范围还要通过 Node 权限参数设置。

### 6. 子进程入口的公共准备

新建 src/examples/file-worker.ts，先写入：

<<< ../snippets/13/src/examples/file-worker.ts#imports{ts}

这个文件稍后由 Node 单独启动，**不会被主入口 import 执行**。它只导入内置模块，避免把 Agent、终端输入或主进程环境一起带过去。digest 为文件内容生成版本，与后面的父进程检查使用同一种算法。

### 7. 接收一份请求，返回一份事实

继续追加完整 main 函数：

<<< ../snippets/13/src/examples/file-worker.ts#worker{ts}

先走读取。父进程经标准输入送来 `{ kind: "read", path: "sum.ts" }`，main 收集文本后解析 JSON，确认固定路径和操作类别，再打开文件。读取结果带 content 和 version，经 console.log 输出 JSON。子进程里这次 console.log 是**通信数据**，不是给人看的进度日志，不能随手在标准输出加别的文字。

for await 等待标准输入一段段到达；父进程关闭输入后，循环结束。大小上限避免一直积累文本。本协议只接受本章可信父进程生成的 JSON，不把它当作处理任意恶意数据的通用服务。

打开时 O_RDONLY 只读，O_RDWR 可读写；O_NOFOLLOW 拒绝把目标文件当成符号链接跟随。文件还必须是普通文件、只有一个硬链接、大小不超过 16,384 字节。符号链接是指向别处的路径，硬链接是同一文件内容的另一个名字；本例都不把它们当作独立的私人副本。

#### 一次写入具体发生在哪里

**讲解摘录（无需写入文件）：**

<<< ../snippets/13/src/examples/file-worker.ts#write{ts}

write 请求还带 content 与 expectedVersion。main 先从已打开句柄读取旧文本，摘要不匹配就拒绝。匹配后才清空、写入、同步，再按位置 0 读回新字节，核对读回摘要与请求内容一致。返回的 version 代表这次读回的内容；主进程稍后把它作为成功观察保存。

这里显式传入位置 0，因为前面的读取已经移动了句柄当前位置。若直接在当前位置追加，就可能把新内容写到旧文本后面。Buffer 按 UTF-8 字节长度分配，避免把中文字符数误当字节数。

truncate、write、sync 不是一个原子事务。清空以后写入失败，文件可能只完成一部分；读回不匹配也会报错。**发生错误不能推断没有副作用，更不能自动重放。** 这与第 12 篇的未知执行原则一致。本章不实现任意编辑器或事务式文件系统。

### 8. 明确子进程怎样结束

在同一文件末尾追加：

<<< ../snippets/13/src/examples/file-worker.ts#launch{ts}

这个入口负责真正调用 main。成功时正常退出；失败时把原因写入标准错误，并以非零状态退出。父进程会据此拒绝本次操作，不会把错误文字解析为成功 JSON。

整个 file-worker.ts 的工作只有：标准输入 → 检查固定协议 → 文件句柄操作 → 标准输出 JSON。它不接触会话、不等待批准、不调用模型。

### 9. 父进程怎样启动它

新建 src/examples/file-process.ts：

<<< ../snippets/13/src/examples/file-process.ts#process{ts}

runFileProcess 接收真实目录 root、已整理好的 FileRequest 和停止信号。它返回 `Promise<unknown>`；Promise 完成代表子进程已经退出，且标准输出已被解析，不代表结果已经写入 State。

先看正常的写请求：args 先启用 --permission，只允许读 worker 脚本与目标文件，再因为 kind 是 write 增加该目标的写权限。读取请求没有写权限。模型无法通过 content 添加新的启动参数，content 走标准输入；可执行文件固定为当前 Node，脚本固定从 import.meta.url 相对定位。

execFile 直接启动可执行文件，shell: false 不经过 shell 解释。cwd 把 sum.ts 指向演示目录；env: {} 不继承父进程密钥或 NODE_OPTIONS。timeout 限制子进程持续时间，maxBuffer 限制输出积累，signal 用于停止子进程。[Node execFile 的参数与行为](https://nodejs.org/download/release/v22.18.0/docs/api/child_process.html#child_processexecfilefile-args-options-callback)

child.stdin.end 把这一份请求交给子进程，并告知输入结束。回调只在进程结束时处理结果：有 error 则 reject；否则解析 stdout 后 resolve。stdin 先关闭导致的流错误由监听接住，最终操作结论仍由进程回调给出。取消可能发生在写入之后，停止子进程也不会撤销已经写出的字节。

#### 这两份文件怎样配合

```text
工具执行体 await runFileProcess(root, request, signal)
  → execFile 启动固定 file-worker.ts
  → stdin 写入一份 JSON 并结束
  → main 读写固定 sum.ts
  ← stdout 一份 JSON，子进程退出
  ← execFile 回调解析，Promise 返回给工具
```

批准不在子进程里询问；子进程只在外层许可通过后启动。Node 权限限制也不是提示词约定，而是父进程实际传入的启动参数。主进程仍可读取文件做版本检查；这些限制只约束本例的文件操作子进程，没有把整个应用变成沙箱。

## 阶段三：把路径与版本检查接到原工具接口

### 10. 准备副本与共享数据

新建 src/examples/permission-workspace.ts，先写入：

<<< ../snippets/13/src/examples/permission-workspace.ts#imports{ts}

fixedSource 是这次预设修改：为 reduce 增加初始值 0。这里不讨论模型怎样发现修复；模型替身直接使用它。versionOf 与子进程的 digest 算法相同，负责比较同一份文件文本。

继续追加：

<<< ../snippets/13/src/examples/permission-workspace.ts#prepare{ts}

每次入口调用都新建不同的 .agent-data/permission-... 目录，写入原来的 sourceCode。mkdtemp 负责生成独立目录，realpath 返回真实绝对路径。目录位于已忽略的 .agent-data/，所以不会混进提交；保留它是为了结束后能查看真实内容。它并没有修改项目的 src/sum.ts。

### 11. 把模型参数整理成固定操作

继续追加：

<<< ../snippets/13/src/examples/permission-workspace.ts#parse{ts}

以 write-1 为例，模型参数是 `{ path: "sum.ts", content: fixedSource, expectedVersion: "64 位摘要" }`。parseRequest 确认路径后，把工具名 write_source 转为内部 kind: write，检查内容与版本，再交出只含实际操作字段的新对象。

为什么不是拿 path 拼接任意文件？本篇先提供“这个副本中的这一个文件”能力。../sum.ts、绝对路径和其他文件名都不等于 sum.ts，因此直接拒绝。以后要开放更多文件，应扩展可信工作区解析器，而不是直接删除这条检查。

额外的 approved、command 或 effect 参数没有被复制进 FileRequest，不能影响授权、操作类型或子进程命令。请求中的 expectedVersion 也不能单方面证明文件没变，稍后还会与真实读取结果比较。

### 12. 导出检查器与实际执行器

继续在同一文件末尾追加：

<<< ../snippets/13/src/examples/permission-workspace.ts#workspace{ts}

createPermissionTools(root) 为这个副本创建两个入口：inspect 给许可模块使用，execute 保留第 3 篇的 `(call, signal) → ToolResult` 接口。创建它们只是组装函数，尚未读写工具目标。

先沿 inspect 看正常请求：参数变成 FileRequest 后，检查真实目标是普通独立文件，读取文本，计算 version。写请求带来的 expectedVersion 必须匹配，然后返回 `{ effect: "write", version, summary: "write sum.ts" }`。这份 Operation 留在许可入口的局部变量中，用于批准和第二次比较，不自动加入 State。

**讲解摘录（无需写入文件）：**

<<< ../snippets/13/src/examples/permission-workspace.ts#scope{ts}

lstat 查看路径本身而不是跟随链接，realpath 复核实际目标，nlink 排除硬链接。本例 root 由刚才的新建目录提供；这些检查和串行队列不能阻止另一个恶意进程同时替换父目录。我们依赖私人工作区与可信操作代码，不能把“检查过路径”写成任意对抗环境下都没有竞争窗口。子进程还会对最终目标使用 O_NOFOLLOW，并在写之前再次核对内容。

再沿 execute 看：两个 defineTool 使用相同的参数整理函数，但传入各自固定 name。原注册表先按工具名查找，原工具入口再校验输入，执行体才调用 runFileProcess。许可前的 inspect 和工具自己的 parse 各检查一次，前者用于授予本次权限，后者继续维护工具契约；没有另建第二套 Agent Loop。

这里的 parameters 是最小内部声明，主线用固定模型替身。若接入第 5 篇真实模型，还需要为这两个新工具提供完整 JSON Schema、在适配器公开工具、解释返回值，并保持同一个许可入口；仅改 decide 不能自动完成这些应用组装。

这个文件最终连接的是：应用新建 root → inspect 向许可模块返回版本 → execute 经旧注册表调用固定子进程。文件本身不询问 yes，也不保存 State。

## 阶段四：同一个 Agent 完成一次人工批准写入

### 13. 模型替身先读，再请求写

新建 src/examples/permission-scenario.ts，先写入导入：

<<< ../snippets/13/src/examples/permission-scenario.ts#imports{ts}

再追加完整决策函数：

<<< ../snippets/13/src/examples/permission-scenario.ts#decide{ts}

这不是独立入口，只被后面的应用导入。第一次最后一条是 user，返回 read-1；读取结果被原循环保存后，下一次最后一条变成 tool。此时它从 value.version 取到文件版本，提出 write-1，新内容使用 fixedSource。

关键的数据传递是 `expectedVersion: value.version`。版本来自上一轮实际读取，没有重新猜一个值；许可入口据此防止覆盖已经变化的文件。脚本只检查协议需要的版本，修复内容也是预设的，不能分析任意源码。

写入拒绝时，last.result.status 是 error，脚本返回 fail。写入成功时，第三次决策提出 finish。**工具返回之后仍要经过 State 写回和下一轮决策**，子进程不会自己调用 decide，也不会直接决定整个任务成功。

### 14. 把“写成功”与“修复通过”分开

继续追加完成规则：

<<< ../snippets/13/src/examples/permission-scenario.ts#validate{ts}

这条规则检查固定答案，并在 State 找到 write-1 的成功观察，要求返回版本等于预期内容摘要。它接收的是循环已经保存的事实。若只看到模型说“已经写好了”，没有该观察，就不能 completed。

这里的证据只支持“受限子进程报告已写入并读回预期内容”。没有运行 sum 的测试，更没有证明任意修复正确，所以答案明确写“尚未运行修复测试”。这个文件的两部分分别供 Agent 的 decide 和 validateFinish 使用，不负责执行文件修改。

### 15. 终端显示请求，等待一份回答

新建独立入口 src/examples/approve-file-change.ts，先写入导入：

<<< ../snippets/13/src/examples/approve-file-change.ts#imports{ts}

再追加人工入口：

<<< ../snippets/13/src/examples/approve-file-change.ts#approve{ts}

request 中的调用 ID 让人知道批准哪一次操作，原版本说明准备覆盖哪份内容，拟写入内容让人看清修改。界面只把严格等于 yes 的回答转换为 true，其余回答都拒绝，不默认为同意。

terminal.question 返回等待输入的 Promise。approvalSignal 过期或取消时，等待会结束；finally 关闭本次界面。这个函数的返回值交回 waitForApproval，**不是直接调用工具**。界面拿到的也是副本，打印或修改它都不会改变待执行请求。

### 16. 最后组装同一个 Runtime

继续在同一文件末尾追加：

<<< ../snippets/13/src/examples/approve-file-change.ts#main{ts}

先创建 root，再为它创建 tools，随后把 tools.inspect、tools.execute 与 askApproval 接入 createAuthorizedExecutor。getPolicy 来自入口配置，允许两种工具；write_source 即使出现在列表里，仍要逐次询问人工。

Agent 的 executeTool 现在接许可执行器。原 Agent、runAgentLoop、批次结果关联、State 写回和完成核对全部复用。maxDecisions 为 3，对应读、写、完成；一分钟是本次批准期限，两分钟是整个 Agent 运行期限，子进程的五秒又是另一层执行限制。

[![原循环调用许可入口，许可入口询问终端并复核文件，再通过原工具执行器启动子进程；返回观察只由原循环写入 State](/diagrams/tool-permission-files.svg)](/diagrams/tool-permission-files.svg)

点击可放大。实线是调用，虚线是返回。主进程持有 State、规则与批准等待；子进程只持有单次 FileRequest，不持有模型 Context。

### 17. 运行正常流程，再运行拒绝流程

在仓库根目录运行：

```bash
npm run typecheck
node src/examples/approve-file-change.ts
```

程序先打印本次演示目录。出现拟写入内容后，输入 yes 并回车，应看到：

```text
[等待批准] 调用=write-1，操作=write sum.ts
[拟写入内容]
export const sum = (numbers: number[]) => numbers.reduce((a, b) => a + b, 0);
允许本次写入？输入 yes，其余回答拒绝：yes
[结束状态 outcome] completed
[决策次数 decisions] 3
```

原文件摘要也会打印，显示顺序以代码为准。打开输出目录里的 sum.ts，确认结尾确实增加了 `, 0`。目录每次不同，不要去看上一次的副本。

再运行同一命令，输入 no。这次仍有 3 次决策：读、提出写、根据拒绝提出 fail；最终 failed，详情含 approval-denied。打开这次的新副本，内容仍是原始版本。**决策次数不是写入次数，也不是批准次数。**

运行没有实时调用 DeepSeek。以后换成真实模型，待批准的请求仍要从这个执行入口经过；模型提示词里要求“先征得同意”，不能替代此处的控制流。

## 阶段五：看见没有执行的具体证据

### 18. 为六种拒绝准备独立实验

新建 src/examples/inspect-permission-faults.ts，先写入导入：

<<< ../snippets/13/src/examples/inspect-permission-faults.ts#imports{ts}

再追加单项实验函数：

<<< ../snippets/13/src/examples/inspect-permission-faults.ts#experiment{ts}

先理解 deny 这一项。它创建新副本，读取 before，配置 approve 返回 false。execute 外包一层计数，只有许可入口真的调用它，executions 才增加。运行请求后再读 after，同时打印拒绝观察和文件是否相同。

这个文件是**故障复现入口**，不是正常应用界面；这里的自动 true 仅供复现实验。changed 的 approve 会故意从外部修改文件，再返回同意，模拟人看批准页面期间文件被编辑。expired 则永远不回答，模拟一个不配合停止信号的界面。

reused 先拒绝一次，再用同一个 ID 发起第二次请求。入口记得这个 ID 已经处理，所以第二次仍拒绝，而不是重复展示一个可能混淆的批准。新 ID 是新请求，仍需新的完整批准。

继续追加入口：

<<< ../snippets/13/src/examples/inspect-permission-faults.ts#main{ts}

依次等待每项实验结束，输出不会混杂。每项使用独立副本，不需要恢复实验文件；这些文件也不作为后续运行的状态来源。

运行：

```bash
node src/examples/inspect-permission-faults.ts
```

| 标签 | 改变什么 | 应观察到什么 |
|---|---|---|
| deny | 用户不同意 | approval-denied；执行 0；文件相同 |
| expired | 批准界面不回答，30ms 后到期 | approval-expired；执行 0；文件相同 |
| changed | 等批准期间有外部编辑 | resource-changed；执行 0；文件不同 |
| policy | 当前不允许写工具 | policy-denied；执行 0；文件相同 |
| scope | 请求 ../sum.ts | scope-denied；执行 0；文件相同 |
| reused | 相同调用 ID 再次使用 | call-reused；执行 0；文件相同 |

changed 的“文件不同”是实验的外部编辑，不是 Agent 写入成功。判断有没有越过许可，应同时看执行次数和拒绝原因，不能只看文件是否变化。其余实验的批准期限为一秒，避免将正常的本地检查耗时混成过期。

### 19. 单独观察 Node 权限确实在限制读取

先保持仓库根目录，运行这个不授予文件读取的子进程：

```bash
node --permission --input-type=module -e 'import { readFileSync } from "node:fs"; try { readFileSync("package.json"); console.log("意外读到文件"); } catch (error) { console.log(error.code); }'
```

预期输出 ERR_ACCESS_DENIED。这个实验只尝试读取公开配置 package.json，不输出内容。它证明权限标志能限制一次 fs 读取，不证明 Node 能安全执行任意恶意程序，也不证明所有网络与系统资源已隔离。

本章实际 worker 的启动参数由应用固定，模型不能自行添加 --allow-fs-read=*、--env-file 或 shell。不要为了消除权限错误把授权范围改成星号；先确认是 worker 脚本路径还是目标文件路径没有正确授予。

## 怎样调试：沿请求走，不要先盯一屏日志

先运行：

```bash
node --inspect-brk src/examples/approve-file-change.ts
```

连接浏览器或编辑器的 Node 调试器后继续执行。按下面顺序设置断点，正常输入 yes 跑一次，再输入 no 跑一次。

| 断点 | 看哪个具体值 | 下一步应去哪里 |
|---|---|---|
| permissionDecide 返回 write-1 前 | expectedVersion 来自上次 tool 的 value.version | 原循环先记录 assistant 请求 |
| authorization.ts 调用 waitForApproval 前 | call 是 write-1，operation.effect 是 write | 终端显示这次修改 |
| askApproval 的 return | 回答 yes 才是 true | 返回许可入口，不直接执行工具 |
| authorization.ts 最后 options.execute 前 | 当前规则相同、文件未变、批准未过期、signal 未取消 | 原执行器 → 固定子进程 |
| runFileProcess 的回调 | stdout 是 JSON，错误进 stderr | ToolResult 返回给原循环 |
| agent-loop.ts 保存工具结果处 | write-1 成功观察被追加进 State.messages | 构造下一轮 Context |

no 路径应到不了 options.execute。若到了，先检查 Agent 是否错误地接入了 tools.execute，而不是许可包装后的 executeTool；绕过入口，检查再正确也没有用。

主进程调试器不会自动附着子进程。本例子进程也没有授予 inspector。先用主进程回调中的 stderr 定位 worker 失败，再检查权限、协议、版本与写回校验；不要把“为调试开放所有权限”留进正式实现。

### 常见现象分别指向哪一层

- 没出现批准界面就失败：先看 policy-denied、scope-denied 或 resource-changed，说明还没到询问步骤。
- 显示批准后很快失败：确认是否输入严格的 yes、是否超过批准期限、期间文件是否变化。
- 子进程提示权限拒绝：检查 file-process.ts 的固定 worker 与目标绝对路径，不改成全盘授权。
- 写工具失败但副本已有变化：可能在截断后失败或取消。停止继续写，检查实际内容；按第 12 篇原则，不把失败当作“尚未执行”。
- 文件成功修改但任务预算耗尽：检查是否仍允许第三次完成决策。写入事实不会因为预算耗尽而撤销。

本篇没有把批准对象放进 State。State 中保存的是模型请求与工具观察；策略、副本目录、队列、已用 ID 和当前批准等待都由应用或许可入口持有。它们不是模型能够改写的运行历史字段。

## 回头看 Pi：它在哪里拦下工具

Pi 固定版本中的 prepareToolCall 先准备并校验工具参数，再调用 beforeToolCall；返回 block 时产生错误工具结果，避免执行。钩子的 args 是已校验参数，且回调之后还有取消检查。[Pi 工具准备与执行前钩子](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/agent/src/agent-loop.ts#L660)

beforeToolCall 的类型说明中明确了 block 与 reason；它提供“执行前允许应用判断”的位置，不等于自动附带审批系统、路径隔离或沙箱。[Pi 钩子输入与拒绝结果](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/agent/src/types.ts#L54)

本项目把相同的前置判断做成 executeTool 外的一层。选择这一位置，是为了沿用已有循环与工具契约：请求进来，检查不通过就返回错误，通过才调用原执行器。固定文件检查和子进程仍由应用工具实现；不能因为 Pi 有一个钩子，就把实际隔离也归给那个钩子。

## 本篇能力与验收边界

现在多出来的能力是：请求已经产生，却仍能在真实操作之前被应用拒绝、等待人工批准，再因批准到期或资源变化而拒绝。获准的文件操作只在固定子进程里执行，结果继续由原循环保存。

本章尚未提供登录身份、审批数据库、持久批准等待、跨进程锁、恶意代码沙箱或自动测试修复。一个执行入口实例只覆盖自己的队列；换目录或换会话要新建入口。文件写入也没有事务或自动回滚。它是一项明确的执行控制能力，不代表已经完成生产安全平台。

完成实现后运行：

```bash
npm run check
node src/examples/inspect-authorization.ts
node src/examples/inspect-permission-faults.ts
node src/examples/approve-file-change.ts
```

最后一项分别输入 yes 和 no 运行两次。正常路径应写入本次副本、返回 completed；拒绝路径应保留原内容并给出拒绝观察；六项实验的执行次数都为 0。不要用一次成功运行替代对拒绝路径的检查。

## 最终完整文件

这里用于核对。前面按步骤写完就已经得到这些文件，不需要把它们再次追加进已有文件。types.ts 与 session-codec.ts 的完整版本也列出，便于检查单处替换没有误删其余内容。

<details>
<summary>src/runtime/authorization.ts</summary>

<<< ../snippets/13/src/runtime/authorization.ts{ts}

</details>

<details>
<summary>src/examples/file-worker.ts</summary>

<<< ../snippets/13/src/examples/file-worker.ts{ts}

</details>

<details>
<summary>src/examples/file-process.ts</summary>

<<< ../snippets/13/src/examples/file-process.ts{ts}

</details>

<details>
<summary>src/examples/permission-workspace.ts</summary>

<<< ../snippets/13/src/examples/permission-workspace.ts{ts}

</details>

<details>
<summary>src/examples/permission-scenario.ts</summary>

<<< ../snippets/13/src/examples/permission-scenario.ts{ts}

</details>

<details>
<summary>src/examples/approve-file-change.ts</summary>

<<< ../snippets/13/src/examples/approve-file-change.ts{ts}

</details>

<details>
<summary>src/runtime/types.ts</summary>

<<< ../snippets/13/src/runtime/types.ts{ts}

</details>

<details>
<summary>src/runtime/session-codec.ts</summary>

<<< ../snippets/13/src/runtime/session-codec.ts{ts}

</details>

<details>
<summary>src/examples/inspect-authorization.ts</summary>

<<< ../snippets/13/src/examples/inspect-authorization.ts{ts}

</details>

<details>
<summary>src/examples/inspect-permission-faults.ts</summary>

<<< ../snippets/13/src/examples/inspect-permission-faults.ts{ts}

</details>

## 保存本章

先恢复临时改动：检查点里的 approve 保持 false，正常入口仍由终端回答，故障实验不接入正常入口。确认 npm run check 和上面的手工验证符合实际，再执行：

```bash
git add \
  src/runtime/authorization.ts \
  src/examples/file-worker.ts \
  src/examples/file-process.ts \
  src/examples/permission-workspace.ts \
  src/examples/permission-scenario.ts \
  src/examples/approve-file-change.ts \
  src/runtime/types.ts \
  src/runtime/session-codec.ts \
  src/examples/inspect-authorization.ts \
  src/examples/inspect-permission-faults.ts \
  site/ \
  AGENTS.md
git commit -F - <<'COMMIT'
第 13 篇：在工具执行前检查权限并等待批准

增加当前工具策略、单次人工批准、批准期限和执行前资源复核。
在独立演示副本上，通过权限受限的可信子进程执行固定文件读写。
保留原 Agent 与循环的结果关联、状态写回和完成验证机制。
补充拒绝、过期、文件变化、路径越界与调用身份重复的运行实验。
更新教程中的文件职责、分步实现、流程图、完整文件和调试路径。
COMMIT
git push -u origin codex/chapter-13-tool-permissions
```

这些命令由本地执行，不会因为阅读网页而自动提交或发布。演示目录在已忽略的 .agent-data/，不加入本章提交。
