---
title: 第 15 篇｜失败以后，哪些操作可以再试一次
description: 在原 Agent 的模型传输和只读工具内加入有界重试，区分暂时失败、永久失败与未知原因，控制退避、取消、权限复核与副作用风险。
---

# 第 15 篇：失败以后，哪些操作可以再试一次

Agent 读取演示源码时，模型服务刚好繁忙，返回 503；或者只读依赖临时断开。前几篇会把失败交回循环并结束。文件和任务本身没出错，这时允许依赖等一会儿、再试一次，可能就能继续诊断。

但不能把所有失败都这样处理。API Key 错了，多发几次不会自动变正确；写文件时连接断开，也不能认定还没写入。第 13 篇已经说明：没有结果，不等于没有副作用。第 14 篇的用户拒绝，更不能靠重新尝试绕过去。

本篇增加**有条件、有限次、可以取消的依赖重试**。仍用“读取 sum.ts，诊断空数组求和问题”的任务：模型请求先失败一次，读取也先失败一次，随后继续完成。重试只发生在失败的那一项依赖附近，已经成功的步骤不重跑。

## 从一次具体运行理解本篇的位置

### 一次决策，可以包含多次请求尝试

先把正常过程走完，暂时不记新文件名：

1. 原循环构造 Context，开始第 1 次决策。模型适配器发出 HTTP 请求，服务返回 503。
2. 适配器确认这是本项目允许再试的暂时失败，等待一小段时间，再发送**同一份请求体**。这次拿到完整读取动作 read-1，才把它交回循环。
3. 循环记录这一次 assistant 动作，工具请求通过第 14 篇的许可入口。只读依赖第一次临时失败，再次确认当前访问许可后重新读取。
4. 读取成功，原工具执行器返回一份 ToolResult。循环把这**一份最终观察**保存进 State。
5. 循环构造带源码结果的新 Context，开始第 2 次决策。这次模型请求正常返回诊断答案，完成规则检查证据后结束。

最终有 2 次决策、3 次模型 HTTP 请求、2 次只读依赖尝试；State 仍是 user → assistant → tool → assistant。第一次 HTTP 503 和第一次读取异常留在依赖内部，由本章回调报告，不被伪造成两条额外的 assistant 或 tool 消息。

```text
原循环第 1 次 decide
  → 模型请求：503 → 等待 → 再请求成功 → 返回一个读取动作
  → 许可检查 → 只读工具：临时失败 → 等待 → 再读成功
  → 原循环保存一条 tool 观察
原循环第 2 次 decide
  → 模型请求正常成功 → 核对完成证据 → 结束
```

本篇的“尝试”指调用同一个依赖一次，第一次调用也算尝试。maxAttempts 为 3 就是最多调用三次，只有后两次属于重试；它不等于 Agent 的 maxDecisions。

[![一次依赖失败后先检查原因、重复执行的安全性和次数，再决定停止或等待；取消和权限复核发生在下一次开始前](/diagrams/retry-decision.svg)](/diagrams/retry-decision.svg)

点击可放大。图描述单个依赖的内部过程，不是重新运行整个 Agent 的流程。

### 先分清失败发生在哪一层

| 现象 | 发生在哪 | 本篇怎样处理 |
|---|---|---|
| DeepSeek 返回 429、500、503 | 模型传输 | 允许在限定次数内等待后重试 |
| API Key 错误、余额不足、请求参数错误 | 模型请求配置 | 结束，请修正原因 |
| HTTP 成功，但 JSON 或动作不符合协议 | 模型响应解析 | 不自动重试，不执行半个动作 |
| 可信只读工具报告暂时不可用 | 工具执行体 | 应用明确允许重试才再次调用 |
| 工具未知、参数错误、许可拒绝 | 工具执行之前 | 不进入实际操作重试 |
| 模型提出 fail，或完成证据不足 | 任务判断 | 沿原循环退出，不重新启动任务 |
| 写入抛错，是否已经改变文件未知 | 可能产生副作用的执行 | 不自动重放，核查真实结果 |
| 外部取消或整段运行超时 | 原运行控制 | 停止等待，不开始下一次尝试 |

“暂时失败”表示当前有依据认为稍后可能成功；“永久失败”在本章表示保持请求与配置不变时，没有理由自动再发；“未知”表示信息不足，不猜测可以重试。**原因可能暂时，也不代表重复操作安全。** 写操作即使暂时失败，也可能已经完成一半。

DeepSeek 官方列出了这些错误的含义：400/422 要修正参数，401 要检查密钥，402 要处理余额，500/503 可以短暂等待后再请求；429 需要控制请求节奏。本篇基于这些事实选择有限的重试策略，不把“所有 HTTP 错误”都归入同一类。[DeepSeek 错误码](https://api-docs.deepseek.com/quick_start/error_codes/)

### 为什么不重试整个 Agent 或整个工具批次

假设批次里读取源码已成功，第二项追加日志失败。重跑整个批次会再次读取，还可能再追加一行日志。重跑整个 Agent 还会重复之前的模型决策和其他工具。失败的范围越小，越容易说明会重复什么。

本篇因此选择两个插入点：**非流式模型 HTTP 调用内部**，以及**明确声明为只读的工具执行体内部**。循环仍只接收最终 Action 和 ToolResult；许可入口仍包在工具外层。写工具不加入只读重试包装器。

AWS 的实践也提醒，超时不能证明副作用没有发生，重复调用会增加下游负载；多层各自重试还会放大请求量。这里保持每项依赖只有一处重试，次数有限，调用方的整段超时继续有效。[AWS：超时、重试与退避](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/)

## 前置版本与文件地图

完成并提交第 14 篇后，从仓库根目录开始：

```bash
git status --short
git switch -c codex/chapter-14-safe-retries
npm run typecheck
```

分支已存在时使用 `git switch codex/chapter-14-safe-retries`。本章不新增依赖，不要求编写单测，也不需要 API Key。模型服务由本地 HTTP 替身代替，文件读取仍使用第 14 篇的真实副本与受限子进程。

| 文件 | 改动 | 在这次任务中的位置 |
|---|---|---|
| src/runtime/dependency-error.ts | 新增 | 可信依赖描述失败；普通异常按未知处理 |
| src/runtime/retry.ts | 新增 | 尝试、分类判断、等待、取消与次数限制 |
| src/runtime/retrying-read-tool.ts | 新增 | 把重试放进只读工具执行体，每次先核对访问许可 |
| src/adapters/deepseek/http.ts | 替换 | 根据真实 HTTP 状态分类，在非流式传输内重试 |
| src/adapters/deepseek/decider.ts | 局部修改 | 支持注入传输入口，标记非流式动作解析失败 |
| src/examples/inspect-retry.ts | 新增，独立入口 | 最早可运行的小实验：失败一次，再成功 |
| src/examples/retry-model-fixture.ts | 新增，被导入 | 离线 HTTP 替身：503 后返回固定读取动作与答案 |
| src/examples/retry-read-tool.ts | 新增，被导入 | 在受限副本中组装可重试的只读工具 |
| src/examples/retrying-diagnosis-agent.ts | 新增，独立入口 | 原 Agent 同时经过模型与只读工具重试 |
| src/examples/inspect-retry-faults.ts | 新增，独立入口 | 观察永久、未知、次数耗尽、写入、取消与撤权 |

共 8 个新增文件、2 个修改文件。agent-loop.ts、authorization.ts、ToolResult 和会话磁盘格式都保留。新的失败分类先供依赖内部决定重试；工具最终失败仍由原执行器转为 tool-error，不把分类对象偷偷加入旧日志协议。

按下面的小步骤写入。标为**“讲解摘录（无需写入文件）”**的短代码已经包含在完整实现中，只供对照，不要再次追加；章末提供全部最终文件。

## 阶段一：先实现一次依赖内部的重试

### 1. 用数据描述失败，别从文字猜测

新建 src/runtime/dependency-error.ts：

<<< ../snippets/14/src/runtime/dependency-error.ts#failure{ts}

Failure 回答两件不同的事：source 表示失败来源，例如 transport 是网络与 HTTP，model-protocol 是模型响应协议，tool 是工具内部；kind 表示本项目据现有证据作出的判断，例如 transient 是暂时失败。

一份具体值可以是 `{ source: "transport", kind: "transient", message: "DeepSeek HTTP 503" }`。它由看见响应状态的可信适配器创建，不由模型在 arguments 里声明。retryAfterMs 是服务要求至少等多久，后面处理 HTTP 时才会提供。

DependencyError 是携带这份数据的 Error。super 保存通常的错误消息，failure 保存结构化信息；复制再冻结，避免后续观察者改变这次分类。describeFailure 只认这个类的实例，返回副本。普通 Error 就算文字写着“503 timeout retryable”，也只得到 unknown。

这是一种项目内部约定，不是 JavaScript 自带的错误分类，也不是所有工具失败都能精确判断。它不保存 State；稍后由 retry 在 catch 中读取。

### 2. 定义一次依赖的尝试规则

新建 src/runtime/retry.ts，先写入：

<<< ../snippets/14/src/runtime/retry.ts#contracts{ts}

RetrySettings 是应用配置：最多尝试几次、等待范围、随机数来源、以及观察通知。RetryOptions 还要求 safety，表达**重复这个操作是否被应用明确允许**；read-only 用于本章的只读依赖，never 表示不要自动重复。

这个 safety 不从模型参数读取，TypeScript 也无法证明某个函数真的没有写操作；应用必须根据工具实现作出声明。模型请求在本章也使用 read-only，含义是“只生成候选动作，不在服务端自动执行本地工具”。重新生成可能产生额外计费、服务日志和不同答案，并不表示请求没有任何远端影响。

beforeAttempt 在每次尝试前运行，用于重新核对访问权限。onRetry 则在已决定等待后发通知，例如 `{ attempt: 1, nextAttempt: 2, delayMs: 10, failure: ... }`；通知既不授权，也不写历史。

继续在同一文件末尾追加配置检查：

<<< ../snippets/14/src/runtime/retry.ts#settings{ts}

本章允许 1 至 5 次尝试，每次等待上限不超过一分钟。这些是本项目的小范围配置，便于理解最坏调用数量；不是所有服务的行业标准。maxAttempts 为 1 时仍正常调用一次，但失败后不会重试。配置错误在操作启动前抛出。

### 3. 成功就返回，符合条件才再试

继续追加完整 retry 函数：

<<< ../snippets/14/src/runtime/retry.ts#retry{ts}

先沿一个具体调用走：maxAttempts 为 3，第一次读取抛出可信的 transient；第二次返回“读取成功”。attempt 从 1 开始，每次先检查取消和访问许可。operation 第一次抛错，进入 catch；允许重复、原因暂时、还有次数，才计算等待。等待结束后 for 进入第 2 次尝试，operation 返回值，函数立即 return，不再尝试第 3 次。

#### 一次尝试前，先核对许可

**讲解摘录（无需写入文件）：**

<<< ../snippets/14/src/runtime/retry.ts#start{ts}

signal 是原运行传进来的停止信号。beforeAttempt 不在操作的 try/catch 里：假如访问许可被撤销，即使检查函数碰巧抛出一个带 transient 的错误，也必须直接结束，不能把撤权当成“暂时不可用，再来几次”。

await 检查后再查 signal，避免核对期间取消了，仍开始 operation。成功返回后也检查一次，防止依赖忽略取消并迟到返回时继续使用结果。retry 自身不会抢占一个不返回的函数；在 Agent 内，原第 5 篇控制器仍负责停止外层等待，依赖也应配合 signal。

#### 决定是否有下一次

**讲解摘录（无需写入文件）：**

<<< ../snippets/14/src/runtime/retry.ts#decision{ts}

这里是三个独立条件：应用允许重复、失败可信且暂时、次数没有耗尽。任意一个不满足，就抛回本次错误。kind 仍为 transient 但次数已用完，也是正常的停止结果；“暂时”不是无限重试的承诺。

成功的业务返回值不会进入 catch。例如一个函数正常返回 `{ status: "error" }`，在 Promise 层面仍是成功返回；这个 retry 不会擅自扫描对象字段。后面把它放进工具执行体，正是为了在原执行器将异常变成 ToolResult **之前**判断。

#### 等待为什么要逐渐拉开

**讲解摘录（无需写入文件）：**

<<< ../snippets/14/src/runtime/retry.ts#backoff{ts}

baseDelayMs 为 20、maxDelayMs 为 100 时，第 1 次失败后的随机等待范围是 0 至不足 20ms，第 2 次是 0 至不足 40ms，以后上限最多 100ms。这叫退避：连续失败后给下游更多恢复时间。抖动就是在范围内随机选等待时间，减少许多调用同时重发。

本章的可复现实验固定 random 返回 0.5，因此实际为 10ms、20ms。生产默认 Math.random，不会每次相同。serverDelay 是服务要求的最少等待，用 Math.max 保证不比它短；若服务要求超过本次配置允许的最大等待，就结束并交回错误，不能擅自把要求缩短。

#### 等待本身也能取消

**讲解摘录（无需写入文件）：**

<<< ../snippets/14/src/runtime/retry.ts#wait{ts}

onRetry 只是报告“准备等待”，并不说明下一次已经启动。回调可以触发原取消接口，所以通知后还要检查信号；计时等待也接收 signal，中途取消会拒绝等待，函数直接退出，不会开始下一次 operation。这里使用 Node 的 Promise 定时器，其 AbortSignal 取消行为有明确文档依据。[Node 可取消的定时等待](https://nodejs.org/download/release/v22.18.0/docs/api/timers.html#cancelling-timers)

普通通知异常会被接住，避免日志界面故障改变执行策略；它若发出取消，信号检查仍然生效。最后的 Unreachable 出口只是使函数返回路径明确，合法配置下会在成功 return 或最后一次失败 throw 时结束。

retry.ts 最终只管理一项依赖的尝试。它取得 operation，交回该依赖的最终值或错误；是否形成 Action、ToolResult，以及何时写 State，仍由原调用链负责。

### 4. 第一个检查点：看见两次尝试与一个最终值

新建独立入口 src/examples/inspect-retry.ts：

<<< ../snippets/14/src/examples/inspect-retry.ts#probe{ts}

这是纯机制实验，不读取文件也不调用模型。operation 第 1 次抛出可信暂时失败，第 2 次正常返回；attempts 只在实际进入 operation 时增加，onRetry 的打印不会增加它。

```bash
npm run typecheck
node src/examples/inspect-retry.ts
```

预期：

```text
[读取尝试 attempt] 1
[准备重试] 第 2 次，等待 10ms
[读取尝试 attempt] 2
[最终值] 读取成功，实际尝试=2
```

临时将 safety 改为 never 再运行，会在第一次失败后结束。恢复 read-only 后继续。这个对比说明：暂时失败和重复安全必须同时成立。

## 阶段二：把模型 HTTP 的事实分类接进来

本阶段改变第 6 篇的非流式传输：原来任何 HTTP 失败都只抛一段文字，现在依据实际状态码分类，并在这一层有限重发。流式传输暂不加入自动重试；已经对外展示部分增量后怎样重发，需要另外定义界面与响应关联，不能直接重新拼到旧分片后面。

### 5. 替换 HTTP 文件的导入与配置

本次完整重建 src/adapters/deepseek/http.ts：先清空旧文件，写入以下导入与类型，然后按接下来的两步追加。

<<< ../snippets/14/src/adapters/deepseek/http.ts#imports{ts}

新文件相比上一章新增三件事：可注入 fetch 供离线验证；按服务事实构造 DependencyError；使用 retry 管理单份非流式请求。函数前三个参数保留，所以原真实调用入口不必修改。

### 6. 读取服务建议的最少等待

继续追加：

<<< ../snippets/14/src/adapters/deepseek/http.ts#header{ts}

Retry-After 是 HTTP 响应头，服务可以用秒数或日期表达建议等待。比如 "2" 转为 2,000ms；日期转为从现在到那个时刻的间隔，已过期则为 0。没有或无法解析时不提供建议，由本地退避决定。[HTTP Retry-After](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after)

这只是计算等待，不是允许重试。仍要先确认状态类别与操作安全；服务要求的等待太长，也不会无限挂在这里。

### 7. 固定这轮请求体，只重发传输

继续追加完整 requestDeepSeek：

<<< ../snippets/14/src/adapters/deepseek/http.ts#request{ts}

先走正常恢复：入口检查密钥，把本轮 body 编码一次；retry 第一次调用 send，收到 503，释放响应体后抛带分类的 DependencyError。等待后再调用 send，URL、请求体和当前 Context 仍对应同一轮决策。第二次 HTTP 成功，JSON 返回给模型适配器，最后才解码动作。

这里的 fetch 注入由可信应用提供，不来自模型。默认仍是标准 fetch 与 DeepSeek 官方地址；离线入口用本地函数代替，不把占位密钥发往网络。

**讲解摘录（无需写入文件）：**

<<< ../snippets/14/src/adapters/deepseek/http.ts#http-error{ts}

HTTP 429、500、503 被本项目归为 transient；400、401、402、422 归为 permanent；其他尚未明确处理的状态保守为 unknown。错误只记录状态与受控原因，不打印密钥、Authorization 头或整个请求体。

网络异常没有 HTTP 状态。这里仅在 Node fetch 的 cause.code 属于列出的连接故障时允许尝试重发；一个裸 TypeError 或包含 timeout 的文字都不够。原因识别列表是适配器的保守选择，不是所有网络错误的完整表。

HTTP 成功后的 JSON 读取失败可能是格式错误，也可能是响应中途断开，本篇归到 model-protocol/unknown，停止自动重试。有效 JSON 也不代表有效 Action，后面的适配器仍需校验。

默认最多 3 次尝试，等待基准 300ms、上限 3,000ms；不会重置 Agent 的总超时。Retry-After 超过上限就停止。生成请求可能已经在服务端计算和计费，本篇只保证不会因重发传输就执行两次本地工具；没有声称服务提供幂等请求或只收费一次。

http.ts 的调用链现在是：decider 提供本轮请求 → retry 可能多次调用 fetch → 最终返回一份未知 JSON → decider 解码。此文件不执行工具，也不追加模型消息。

### 8. 修改适配器的三个准确位置

在 src/adapters/deepseek/decider.ts 顶部新增导入，原导入全部保留：

```ts
import { DependencyError } from "../../runtime/dependency-error.ts";
```

在 DeepSeekOptions 中，紧邻 stream 配置新增：

```ts
request?: typeof requestDeepSeek;
```

再找到非流式的 else 分支，**只替换分支内部原来的两行**：从 const payload 到 action = decodeDeepSeekAction(payload)。else 的大括号、后面的历史调用身份检查与日志保留。写入：

<<< ../snippets/14/src/adapters/deepseek/decider.ts#nonstream{ts}

request 没提供时仍调用正式 requestDeepSeek；提供时则可接入同一个 HTTP 实现的离线配置。动作解析失败被标为 model-protocol/unknown，这段解析在 HTTP retry 外面，不会因为一份 JSON 字段不对就重新调用工具或重启 Agent。

相对上一章，这个文件只多了传输注入和非流式解析分类；构造模型消息、工具声明、流式分支、旧调用 ID 检查都保留。完整文件见章末。若 stream 为 true，新 request 配置不会替换流式传输，仍走原来的 SSE 路径。

## 阶段三：只读工具在哪一层重试

原工具执行器会把执行体异常整理为 tool-error 的 ToolResult。若在它外面加一个“所有错误都重试”的包装器，既容易吞掉结构化分类，也可能重复权限拒绝或写操作。

我们把重试放得更里面：工具参数先通过 parse，随后只读执行体内部尝试。无论内部试了几次，原执行器最终仍只返回一个带原 callId 的结果。

### 9. 为只读执行体提供包装入口

新建 src/runtime/retrying-read-tool.ts：

<<< ../snippets/14/src/runtime/retrying-read-tool.ts#tool{ts}

defineRetryingReadTool 接收原来同一种 ToolDefinition、重试设置和访问检查函数。它把 parse、名称、说明原样交给 defineTool，只替换 execute。调用方得到的仍是原 Tool，不需要改注册表或循环接口。

一次读取时，defineTool 先成功解析 args，这里保存一份 original。每次开始前，beforeAttempt 把副本交给 checkAccess；通过才调用 definition.execute，并且也给它一份新副本。这样前一次失败若修改了参数对象，不会让第二次请求偷偷变成不同路径。

checkAccess 不在 retry 的操作 catch 内，因此撤权和范围检查失败直接结束。只有 definition.execute 抛出可信 transient，才有下一次；未知普通异常、写工具、参数错误都不会因为这个文件而被自动重试。

这个包装器的名字与 safety 都是应用声明，不是运行时分析函数有没有偷偷写文件。只能为经过检查的只读实现选用。第 14 篇的 write_source 继续使用原 defineTool，**不迁移到这里**。

### 10. 接上当前工作区与访问检查

新建 src/examples/retry-read-tool.ts：

<<< ../snippets/14/src/examples/retry-read-tool.ts#tool{ts}

这个文件不是独立命令。它为已知的 root 建立 read_source，公开完整参数说明，让真实适配器也知道只能传 sum.ts。parse 成功后得到固定路径对象；execute 调用 read，默认是真实的 runFileProcess。

每一次 read 前，访问检查重新读取 getPolicy，确认 read_source 当前仍允许，再沿用第 14 篇的 inspect 检查固定目标与链接等约束。id: access-check-only 只供检查器接收完整 ToolCall 形状，不是模型的新请求，不进入许可入口的已用 ID 集合，也不写会话。

外层仍有第 14 篇的许可包装器。内层再检查，是因为第一次允许不代表等待重试期间权限不会变。这里允许文件内容在两次只读之间改变，最终使用重新读到的事实；没有写操作，也没有把旧版本当作覆盖依据。

可选 read 参数是故障实验的注入点：它替换真实读取依赖，不能替换外层许可和每次访问检查。稍后的主入口让第一次抛错，第二次仍调用原受限子进程，不另造模拟文件内容。

这个文件的实际连接是：入口建立只读 Tool → 原注册表查找 → parse → 重试包装器核对访问 → 读取依赖 → 原执行器关联 callId → 循环写回。

## 阶段四：把两处重试放进原 Agent

### 11. 准备可重复观察的模型服务替身

新建 src/examples/retry-model-fixture.ts：

<<< ../snippets/14/src/examples/retry-model-fixture.ts#fixture{ts}

createRetryModelFixture 每次创建一份独立计数。它导出的 send 形状与 fetch 相同：第一次返回真实的 Response 对象，状态 503；后面根据请求体最后一条消息返回固定工具调用或诊断答案。

它没有打开网络端口，也没有访问 DeepSeek。替换的是 HTTP 服务响应，所以 requestDeepSeek 的分类、等待、JSON 读取以及 decider 的真实解码仍会执行。它也不直接调用工具：工具调用只是一份待解码数据。

count 只供主入口显示实际调用次数，不是 Agent 的决策计数。响应中的固定答案不能分析任意源码，完成时还要沿原规则检查实际读取证据。

### 12. 建立同一副本上的只读工具

新建独立入口 src/examples/retrying-diagnosis-agent.ts，先写入导入：

<<< ../snippets/14/src/examples/retrying-diagnosis-agent.ts#imports{ts}

再追加准备过程：

<<< ../snippets/14/src/examples/retrying-diagnosis-agent.ts#prepare{ts}

root 仍由第 14 篇函数新建，不碰项目源码。getPolicy 只允许 read_source。settings 把等待设小、随机值固定，目的是让这次实验的 10ms 输出可复现；正式 HTTP 默认配置并没有改成 20ms。

传给 createRetryReadTool 的 read 回调才是本次故障装置：reads 第一次加到 1 后抛出可信 transient；第二次加到 2，真正调用受限子进程读取副本。reads 是依赖尝试次数，不能将它理解成模型决策次数，也不能理解成两次真实文件读取。访问检查器本身也会读取文件核对范围与版本；这里统计的是被包装的 read 依赖，不是所有文件系统读取次数。

### 13. 连接非流式模型、许可入口和完成规则

继续追加：

<<< ../snippets/14/src/examples/retrying-diagnosis-agent.ts#connect{ts}

先看模型这一端：createDeepSeekDecider 的 request 回调仍调用正式 requestDeepSeek，只把 fetch 换为 fixture.send，并提供短等待配置。因此模型 HTTP 第一次返回 503 时，是正式重试实现决定再发，不是替身直接跳到成功。

再看工具这一端：createAuthorizedExecutor 仍包住原 createToolExecutor。最外层许可通过后，原执行器取得可重试的只读 Tool；内部每次读取还会检查当前访问范围。这次没有写请求，所以 approve 若被调用就表示组装出错，回调会明确抛错。

validateFinish 要求固定诊断答案，并在 State 找到 read-1 的成功观察，content 必须等于原示例源码。模型替身不能只说一句答案就让任务完成。这条规则验证的是本场景读取证据，不是通用的代码正确性证明。

maxDecisions 为 2 依然足够。重试发生在一次 decide 或一次工具执行等待之内，不占额外模型决策；整段 10 秒超时照常覆盖请求、等待、读取与下一轮。

[![同一 Agent 的模型传输内重试 HTTP，只读工具执行体内重试读取；许可检查和 State 写回继续在原位置，最终为两次决策和一份工具观察](/diagrams/retry-layers.svg)](/diagrams/retry-layers.svg)

点击可放大。图中的两个 retry 是分别调用同一个通用函数，不是给一次 HTTP 同时套两层重试。批次调度、许可包装器和 Agent 都没有再包一层自动重试。

### 14. 运行并核对三个不同的次数

继续在同一文件末尾追加：

<<< ../snippets/14/src/examples/retrying-diagnosis-agent.ts#run{ts}

```bash
npm run typecheck
node src/examples/retrying-diagnosis-agent.ts
```

中间会看到“模拟模型 HTTP 请求 1 → 模型重试 → 请求 2”和“只读依赖尝试 1 → 读取重试 → 尝试 2”。末尾应为：

```text
[结束状态 outcome] completed
[决策次数 decisions] 2
[模型 HTTP 请求次数] 3
[只读依赖尝试次数] 2
[消息角色 messages] user -> assistant -> tool -> assistant
```

3 次 HTTP 里，前两次属于第 1 次 decide，最后一次属于第 2 次 decide。2 次只读依赖尝试属于同一个 read-1，没有产生 read-2，也没有复用模型历史中的第二个调用 ID。

第一次失败没有立即变成 ToolResult，第二次成功后才有一份最终结果。循环仍在原位置追加这份观察，下一轮 Context 才能含源码。onRetry 的中文日志不会替代这条状态更新，也没有自动保存成第 10 篇的运行事件或第 12 篇的会话日志。

## 阶段五：该停的时候，确定不会再来一次

### 15. 准备一个单项故障观察器

新建独立入口 src/examples/inspect-retry-faults.ts，先写入：

<<< ../snippets/14/src/examples/inspect-retry-faults.ts#imports{ts}

再追加完整实验函数：

<<< ../snippets/14/src/examples/inspect-retry-faults.ts#experiment{ts}

先看 exhausted：每次进入 operation 才增加 attempts，并总是抛暂时失败。允许三次，所以最后打印 3，然后把第 3 次错误交回；不会有第 4 次。permanent 和 unknown 则第一次就停止。unknown 故意把 503、timeout、retryable 都写进文字，证明文字不能伪造分类。

write 是另外一条反例：它在临时目录真的追加一行，再抛暂时失败，但 safety 为 never。最终只能有一次尝试、一行内容。错误发生在追加之后，所以既不能说“没有执行”，也不能让 transient 自动成为再次写入的理由。

cancel 在收到重试通知时取消；下一次还没开始。revoked 则允许第一次暂时失败，但在第 2 次的 beforeAttempt 撤权；第二次 operation 根本没被调用。这些是实验装置，不是正常业务配置，正常入口不包含写入故障。

### 16. 依次运行六条反向轨迹

继续追加入口：

<<< ../snippets/14/src/examples/inspect-retry-faults.ts#run{ts}

```bash
node src/examples/inspect-retry-faults.ts
```

| 标签 | 实际进入 operation 几次 | 为什么停止 |
|---|---|---|
| permanent | 1 | 相同请求没有自动再试的依据 |
| unknown | 1 | 只有文字，没有可信暂时分类 |
| exhausted | 3 | 尝试额度耗尽，错误仍可能是 transient |
| write | 1 | 不允许重复；真实文件已追加一行 |
| cancel | 1 | 下一次开始前取消 |
| revoked | 1 | 第 2 次访问复核失败，未进入操作 |

cancel 的打印可能显示分类 unknown，因为通用异常描述器不把取消伪装成 transient；判断停止要看取消信号。放进 Agent 后，原运行控制器仍会据 signal 选择 cancelled 或 timed-out，而不是根据这条日志的分类猜退出原因。

写入实验会打印临时目录，便于查看 effects.txt。它只用于观察已经发生的副作用，不会被后续 Agent 自动读取或重放。

## 调试时先确定正在看哪一层

```bash
node --inspect-brk src/examples/retrying-diagnosis-agent.ts
```

连接 Node 调试器后，按正常路径设置以下断点：

| 位置 | 重点观察 | 能说明什么 |
|---|---|---|
| http.ts 收到非成功响应 | response.status、failure.kind | 暂时分类来自实际 HTTP 状态 |
| retry.ts 的重试判断 | attempt、maxAttempts、safety | 这项依赖为何被允许或拒绝再次调用 |
| retry.ts 等待前 | notice.nextAttempt、delayMs、signal.aborted | 准备下一次，不表示已开始 |
| retry-read-tool.ts 的访问检查 | 当前 allowedTools、目标检查结果 | 等待后没有沿用旧访问许可 |
| 主入口的 read 回调 | reads 为 1 或 2 | 第一次是故障注入，第二次真实读副本 |
| 原 agent-loop.ts 保存结果处 | 只有一份 read-1 观察 | 内部尝试没有重复污染历史 |

若试了两次却没有任何 onRetry 日志，先看是否接入了正式 requestDeepSeek 或 defineRetryingReadTool。若 maxDecisions 不断增加，检查是否错误地在 decide 外层或整个 Agent 外面自行循环，而不是使用本章的局部调用。

若想验证真实模型，沿用第 6 篇的本地 .env 和非流式入口即可；原 requestDeepSeek 前三个参数保持兼容。**本章验收没有发出真实 API 请求**，不要把离线通过写成真实服务故障恢复已验证。流式入口继续按第 7 篇处理断流，不会自动重发已接收的流。

### 几个容易混淆的边界

- 重试安全不等于返回相同值。只读文件在两次读取间可能改变，本例采用最终读到的事实。
- 同一调用内部的尝试，不是给模型制造新的工具调用 ID；模型以后再次提出动作仍受原历史 ID 检查。
- 超时与取消不能撤销已经发生的外部改变。遇到写入不确定，保留第 13 篇的核查原则。
- 本章每项依赖最多 5 次，不代表整个任务总请求数已固定；多个决策会各自调用依赖。总资源与用量控制在后续单独处理。
- 单机重试不是服务端幂等。幂等需要重复调用不增加不希望的副作用，本章不提供写操作去重凭证，也不宣称传入 callId 就能去重。

## 对照 Pi：自动重试也是有范围的

Pi 固定版本的 AgentSession 会先判断是否属于可重试的 assistant 错误；上下文溢出排除在普通重试之外，交给另一种处理。准备重试时检查开关与次数，计算退避，并使用可取消等待。[Pi 自动重试的判断与等待](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/coding-agent/src/core/agent-session.ts#L3502)

本篇与它共同强调：不能见错就重复，次数与等待都有边界，取消能结束等待。位置则不同：Pi 这段在会话层处理 assistant 错误，本篇先在非流式 HTTP 与只读执行体内局部实现，避免改动已有消息历史语义；不能据此宣称复制了 Pi 的完整重试与会话恢复机制。

## 本篇验收与能力边界

```bash
npm run check
node src/examples/inspect-retry.ts
node src/examples/retrying-diagnosis-agent.ts
node src/examples/inspect-retry-faults.ts
node src/examples/inspect-authorization.ts
```

核对正常诊断的 2、3、2 次数与四条消息；六项故障次数符合表格；第 14 篇拒绝实验仍为执行 0。临时将小检查点改成 never 后，记得恢复 read-only；正常入口仍使用离线替身，不混入真实密钥或额外写入。

现在 Runtime 能对已确认可重复的暂时失败作有限恢复，同时不重启整个任务、不重复已完成步骤、不绕过许可。它还没有持久重试队列、跨进程重试协调、服务端幂等保证或流式重发协议。这里的严格停止是当前设计的一部分，遇到未知原因先调查，而不是扩大重试范围。

## 最终完整文件

前面的代码按顺序写完已经构成这些文件；这里仅供核对，不要再次追加。两个修改文件也给出完整最终内容。

<details>
<summary>src/runtime/dependency-error.ts</summary>

<<< ../snippets/14/src/runtime/dependency-error.ts{ts}

</details>

<details>
<summary>src/runtime/retry.ts</summary>

<<< ../snippets/14/src/runtime/retry.ts{ts}

</details>

<details>
<summary>src/runtime/retrying-read-tool.ts</summary>

<<< ../snippets/14/src/runtime/retrying-read-tool.ts{ts}

</details>

<details>
<summary>src/adapters/deepseek/http.ts</summary>

<<< ../snippets/14/src/adapters/deepseek/http.ts{ts}

</details>

<details>
<summary>src/adapters/deepseek/decider.ts</summary>

<<< ../snippets/14/src/adapters/deepseek/decider.ts{ts}

</details>

<details>
<summary>src/examples/inspect-retry.ts</summary>

<<< ../snippets/14/src/examples/inspect-retry.ts{ts}

</details>

<details>
<summary>src/examples/retry-model-fixture.ts</summary>

<<< ../snippets/14/src/examples/retry-model-fixture.ts{ts}

</details>

<details>
<summary>src/examples/retry-read-tool.ts</summary>

<<< ../snippets/14/src/examples/retry-read-tool.ts{ts}

</details>

<details>
<summary>src/examples/retrying-diagnosis-agent.ts</summary>

<<< ../snippets/14/src/examples/retrying-diagnosis-agent.ts{ts}

</details>

<details>
<summary>src/examples/inspect-retry-faults.ts</summary>

<<< ../snippets/14/src/examples/inspect-retry-faults.ts{ts}

</details>

## 保存本章

确认故障配置恢复、检查与运行输出符合实际，再执行：

```bash
git add \
  src/runtime/dependency-error.ts \
  src/runtime/retry.ts \
  src/runtime/retrying-read-tool.ts \
  src/adapters/deepseek/http.ts \
  src/adapters/deepseek/decider.ts \
  src/examples/inspect-retry.ts \
  src/examples/retry-model-fixture.ts \
  src/examples/retry-read-tool.ts \
  src/examples/retrying-diagnosis-agent.ts \
  src/examples/inspect-retry-faults.ts \
  site/ \
  AGENTS.md
git commit -F - <<'COMMIT'
第 15 篇：分类依赖失败并限制安全重试

增加可信失败描述、未知错误保守处理和有界可取消重试。
为非流式 DeepSeek 请求加入状态分类、退避与服务等待建议。
仅在只读工具执行体内重试，每次尝试前重新核对访问许可。
复用原 Agent、许可入口和状态写回，区分决策数与依赖尝试数。
补充分步教程、流程图、完整文件及停止与副作用故障实验。
COMMIT
git push -u origin codex/chapter-14-safe-retries
```

命令由本地执行，阅读网页不会自动提交或发布。不要把临时目录、.env 或密钥加入提交。
