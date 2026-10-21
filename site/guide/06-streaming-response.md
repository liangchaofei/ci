---
title: 第 06 篇｜流式响应与完整动作
description: 从 UTF-8 字节和 SSE 事件开始，逐步组装模型文本与工具参数，只在响应完整且检查通过后交回 Action。
---

# 第 06 篇：边接收边显示，什么时候才能执行

第 5 篇已经能让 DeepSeek 决定读取源码、接收工具结果、再给出诊断。但每次请求都要等整份 JSON 返回后才能显示文字。回答较长时，终端会安静一段时间，随后一次性打印结果。

本篇改成**流式接收**：同一次请求的内容分多次到达，文字可以边收到边显示。仍然诊断 `src/sum.ts` 中 `sum([])` 的问题，读取工具继续返回固定源码；变化发生在模型适配器，不在业务任务里。

要解决的不只是“把字打印出来”。模型提出的工具参数也可能分段到达：先收到 `{"path":`，再收到 `"src/sum.ts"}`。本篇会实现字节解码、事件拆分、参数暂存和完整动作检查，观察三种结果：完整响应执行读取、断流不执行、接收途中取消不写入动作。

**显示进度与确认动作是两件事。** 片段可以显示，完整且合法的 Action 才能交给 Runtime。我们保留单轮单工具、非思考模式与原有完成规则；尚不实现多工具批次、通用事件订阅、用量记账或断线重连。

## 推荐分支与前置版本

从第 5 篇已验证并提交的本地版本创建：

```bash
git switch -c codex/chapter-06-streaming
```

若已存在，用 `git switch codex/chapter-06-streaming` 返回。下面命令均在仓库根目录执行，沿用原有 Node、TypeScript 与依赖，不安装模型 SDK 或 SSE 库。

先运行 `npm run typecheck` 与 `node src/examples/first-loop.ts` 确认基线。前两个阶段不需要密钥；最后联网运行仍使用第 5 篇的 `.env`，不要把密钥写进源码或教程示例。

::: info 验证范围
本篇候选实现在独立工程完成类型检查、SSE 分块观察、模拟 HTTP 两轮交互与故障验证。下文离线入口的输出可确定复现；真实模型响应标为流程示意，仍需使用本地有效配置运行。本篇没有以离线响应冒充真实 API 验收。
:::

## 先看“片段”和“动作”有什么区别

### 一次模型请求不等于一次网络读取

第 5 篇的顺序是：一次请求 → 一份完整 JSON → 一个 Action。

现在仍是一次请求、最后交回一个 Action，只是中间会收到很多片段。片段的到达次数不增加 decisions，也不会让循环多执行几轮。

先区分三层东西：

| 层次 | 实际拿到什么 | 为什么还不能直接交给循环 |
|---|---|---|
| 网络字节块 | `Uint8Array`，一小段字节 | 可能切在中文字符或一行 JSON 中间 |
| SSE data 事件 | 一段完整事件文本 | 通常只包含 delta，表示新增的一部分 |
| 完整模型动作 | tool 或 finish Action | 经过本次响应结束检查与最终解码，才可交回 |

SSE 是 Server-Sent Events 的缩写，本篇用它表示服务按文本事件格式连续发送内容。它没有规定“一次网络读取正好是一条事件”。DeepSeek 在流式模式使用 SSE，并用 `data: [DONE]` 标记结束。[DeepSeek：stream 与响应格式](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/)

下面是两条事件的**格式示意，不是新增实现代码**。两条之间的空行不能省略：

```text
data: {"choices":[{"index":0,"delta":{"content":"需要检查"},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{"content":" reduce。"},"finish_reason":null}]}

```

每条 data 文本都可以是合法 JSON，但其中的 content 只是新到的一段文字。delta 的意思就是“本次新增内容”。把每条事件误当成完整回复，会丢掉前面的内容或重复结束决策。

### 工具参数即使能解析，也不代表响应已经结束

一次读取可以按下面顺序到达：

| 到达时刻 | 新收到什么 | 本地暂存的参数文本 | 可以执行吗 |
|---|---|---|---|
| 1 | ID、名称与 `{"path":` | `{"path":` | 不可以，参数还不完整 |
| 2 | `"src/sum.ts"}` | `{"path":"src/sum.ts"}` | 仍不可以，响应尚未确认结束 |
| 3 | finish_reason 为 tool_calls | 同上 | 继续等待本接口的结束标志 |
| 4 | `[DONE]` | 同上 | 检查完整动作；合格后交回循环 |

finish_reason 说明这一段生成以什么原因结束；本适配器只接受第 5 篇支持的 tool_calls 与 stop。`[DONE]` 是本接口的流结束标志，不是 JSON，也不是工具调用 ID。

**同时确认结束原因与 `[DONE]` 是本项目的接收策略。** 网络直接关闭不代替完整结束；即使刚好收到了合法参数，也不能把断流当成正常工具请求。

### 暂存数据放在哪里

[![流式数据分层：网络字节经 SSE 解析为事件，模型适配器暂存文字与参数，结束检查后交回 Action，原循环再写入 State；进度只发给显示入口](/diagrams/streaming-commit-boundary.svg)](/diagrams/streaming-commit-boundary.svg)

点击图片可放大。实线是接收与返回，虚线是显示进度。工具执行与 State 写回仍由原循环安排，SSE 解析器不会直接执行工具。

| 数据 | 谁持有 | 什么时候保留为运行记录 |
|---|---|---|
| 半行文本、未结束 SSE 事件 | 本次读取函数 | 不作为会话消息保存 |
| 模型文本与参数草稿 draft | 本次 collectDeepSeekAction 调用 | 本身不加入 State |
| 进度通知 ModelProgress | 同步显示函数收到 | 只显示，不作为工具执行证据 |
| 完整 Action | 适配器返回后由循环接收 | 循环检查仍可继续后记录 assistant 消息 |
| 工具结果 | 执行器返回后由循环接收 | 身份检查后记录 tool 消息 |

取消或失败可能发生在文字已经显示以后；终端上的那些字仍是暂存输出，不能拿它证明这次决策已成功。完整会话记录与显示进度有不同用途。

## 文件变化与实现顺序

以下共新增 7 个文件，修改 1 个文件。`runtime/agent-loop.ts`、工具执行、Context 和 RunControl 全部复用，第 5 篇的非流式入口继续保留。

| 文件 | 操作 | 本章职责 |
|---|---|---|
| `src/adapters/sse.ts` | 新增 | 字节解码、完整行、SSE data 提取，与模型字段无关 |
| `src/examples/inspect-sse.ts` | 新增 | 无需密钥，观察跨字节与跨行读取 |
| `src/adapters/deepseek/stream-protocol.ts` | 新增 | 聚合 delta、显示进度、最终交回 Action |
| `src/examples/stream-fixture.ts` | 新增 | 提供可控的完整与断流人工响应 |
| `src/examples/inspect-stream.ts` | 新增 | 在同一个 Runtime 上观察完整、断流和取消 |
| `src/adapters/deepseek/stream-http.ts` | 新增 | 请求真实 SSE 响应并交出完整 data |
| `src/adapters/deepseek/decider.ts` | 修改 | 选择流式或非流式接收，统一返回 Action |
| `src/examples/deepseek-stream-agent.ts` | 新增 | 正常使用流式模型，边收到边显示文字 |

前两个观察入口帮助复现协议问题，不替代真实模型。它们调用的解析、聚合和 Runtime，正是最后联网入口复用的实现。

## 第一阶段：从碎字节读出完整 SSE 事件

本阶段只新增 sse.ts 和 inspect-sse.ts，不修改第 5 篇文件。先看读取能力，再引入模型响应的字段。

### 1. 逐步解码字节，读出完整行

新建 `src/adapters/sse.ts`，写入以下常量与完整辅助函数：

<<< ../snippets/06/src/adapters/sse.ts#lines

#### 先认清这个函数的输入与输出

body 是一个 ReadableStream，也就是可以陆续读取字节的对象；真实联网时来自 response.body。signal 是本次运行的停止信号。

函数名中的 `async function*` 表示异步生成器：普通 async 函数最后 return 一个结果，这个函数可以在等待过程中多次 yield 一行。调用方以后用 `for await...of` 逐次接收，不必先等全部行都到齐。yield 暂停在这一处，下一次取值才继续。[MDN：for await...of](https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Statements/for-await...of)

函数内部的几个对象各有一个用途：

| 名称 | 保存什么 |
|---|---|
| reader | 从 body 取得字节块的读取器 |
| decoder | 跨多次读取保留尚未解完的 UTF-8 字节 |
| line | 当前尚未遇到行结束符的文本 |
| afterCR | 上一个行结束符是否为 CR，供处理 CRLF 使用 |
| maxBufferedCharacters | 单行和后续单事件的暂存长度上限 |

#### 中文字符被切开时，怎样继续

假设“你”的几个 UTF-8 字节落在两个网络块里。第一次 reader.read 只取得前半，不能把它当成完整字符。`decoder.decode(value, { stream: true })` 会保留未完成字节，下一次仍交给同一个 decoder，才拼出“你”。done 为 true 时再调用没有参数的 decode，完成最后一次解码。

因此 decoder 必须在 while 外创建。如果每次读到块就新建 decoder，跨块字符就无法继续。本例的 fatal:true 会拒绝无效 UTF-8，不用替代字符悄悄接受损坏输入。[MDN：decode 的 stream 选项](https://developer.mozilla.org/en-US/docs/Web/API/TextDecoder/decode)

#### 完整行什么时候交出去

先走最简单的 `data: 你\n`：解出的字符依次追加到 line，遇到 LF，也就是 `\n`，才 yield 当前 line。调用方取得的是 `data: 你`，不包含换行符。随后 line 清空，开始下一行。

CRLF 用 `\r\n` 表示。遇到 CR 时已经结束一行，随后那个 LF 不能再算第二次结束，否则普通换行会变成空行。afterCR 就记录这件事：前一个是 CR、当前是 LF 时跳过；当前不是 LF 时按正常字符处理。单独 CR 和单独 LF 也能结束一行。

注意“行结束”和“事件结束”还不同。这个函数只 yield 行；下一步才用空行识别 SSE 事件边界。

#### 取消与清理发生在哪里

一次 reader.read 可能需要等待。onAbort 登记后，取消时调用 reader.cancel，让这次读取结束；紧随读取之后的 throwIfAborted 再把停止原因交给调用方，不把取消后的 done 当作正常数据。

无论读取完成、抛错，还是外面提前不再取数据，finally 都移除监听、取消未使用的读取并释放 reader 的锁。清理失败不覆盖原来的错误。本函数没有恢复连接或重新发请求。[MDN：reader.cancel](https://developer.mozilla.org/en-US/docs/Web/API/ReadableStreamDefaultReader/cancel)

maxBufferedCharacters 限制的是字符串暂存长度，防止一直没有换行时无限积累；它不是本次模型的 token、费用或整体内存预算。最后没换行的半行不会 yield，不能在网络关闭时自己补出一行。

### 2. 用空行组合 SSE data

继续在 `src/adapters/sse.ts` 末尾追加完整函数：

<<< ../snippets/06/src/adapters/sse.ts#data

#### 用三行输入走完一次事件

假设 readLines 依次交来：

```text
第 1 行：data: 你
第 2 行：data: 好
第 3 行：空行
```

第一行取出 field 为 data，value 为“你”，放入 data 数组。第二行同样追加“好”。第三行的 line 是空字符串，才执行 `yield data.join("\n")`，交给外面一条 `"你\n好"`，随后清空 data 与 size。

这里有两个同名但不同作用域的 data：函数内部的数组暂存事件的各行，外面 for await 接住的是 yield 出来的字符串。它们不是 State，也不是工具参数。

切分字段时，colon 保存第一个冒号的位置；slice 提取名称和值。规范允许冒号后有一个空格，因此只去掉第一个空格，保留后续原有内容。以冒号开头的是注释行，可作心跳，本例跳过。

多个 data 行用换行连接，遇空行提交；未以空行结束的尾部事件丢弃。CR、LF、CRLF 都由上一函数统一处理。[WHATWG：SSE 事件解释规则](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation)

本函数只提取 data，不实现浏览器 EventSource 的自动重连、id 与 retry。它也不认识 choices 或 `[DONE]`：这些是下一层模型协议处理的内容，普通 data 文本原样交出。

#### sse.ts 写完后，两层读取怎样合作

这个文件只有 readSseData 对外公开；readLines 是内部辅助生成器。调用方提供字节流和 signal，再通过 for await 逐条接收完整 data 字符串。内部先由 readLines 处理 UTF-8 与行边界，再由 readSseData 累积 data 行并以空行结束事件。

```text
body 字节流 → readLines：完整行
  → readSseData：完整 data 字符串 → 调用方逐条接收
```

两层各持有自己的缓冲并在这次读取结束后清理，不保存消息。文件不理解模型 JSON、调用 ID 或 `[DONE]`；下一层需要自己决定事件内容意味着什么。这样同一读取器才能同时服务离线观察与真实 HTTP 响应。

### 3. 第一次运行：把中文和换行故意切碎

新建 `src/examples/inspect-sse.ts`，写入完整内容：

<<< ../snippets/06/src/examples/inspect-sse.ts

TextEncoder 将字符串变成 UTF-8 字节。新建的 ReadableStream 中，start 接到的是流的控制对象，它的 enqueue 把字节放进流，close 表示不再提供更多字节。这里的 controller 属于流，不是 AbortController；它不能取消整个 Runtime。

for 每次只放两个字节，所以“你”“好”和 CRLF 都可能跨块。外面的 for await 逐次等待完整 data，只打印 JSON.stringify 后的文本，以便看清中间的 `\n`。

运行：

```bash
npm run typecheck
node src/examples/inspect-sse.ts
```

应得到：

```text
完整事件（data）: "你\n好"
完整事件（data）: "[DONE]"
```

网络块比这两条事件多，但输出只有两条；中文也没有损坏。最后的 `[DONE]` 仍只是字符串，SSE 解析器没有把它转换为动作或宣告任务完成。

## 第二阶段：暂存模型片段，最后才交回 Action

现在已经能取得完整 data 文本。接下来解释其中的模型 JSON，并在一次决策内部拼接。仍不需要密钥，也不修改循环。

### 4. 定义进度、草稿与小检查函数

新建 `src/adapters/deepseek/stream-protocol.ts`，先写导入：

```ts
import type { Action } from "../../runtime/types.ts";
import { decodeDeepSeekAction } from "./protocol.ts";
```

接着写入以下完整类型与辅助函数：

<<< ../snippets/06/src/adapters/deepseek/stream-protocol.ts#draft

#### 进度通知和草稿不是同一个对象

ModelProgress 是传给显示函数的一条通知，比如 `{ type: "text-delta", delta: "需要检查" }`。它只有新增字符串，不包含可供外部修改的 draft 引用。ProgressListener 是接收这条通知的函数类型，本章要求它同步执行，用来打印或更新显示。

StreamDraft 是本次决策在内部使用的可变对象。下面是**某一时刻的草稿示意，不是要追加的实现**：

```ts
const draft = {
  content: "先查看源码。",
  call: { id: "call_stream", name: "read_source", arguments: '{"path":' },
};
```

call.arguments 暂时是字符串，不是第 5 篇 Action 中的参数对象；finishReason 也还没取得。这个对象不能发给执行器，不会因为显示文字就进入 State。

record 检查当前值确实是非 null、非数组的对象，然后才允许按键读取。类型断言写在检查之后，只确认对象这一层，没有假装所有字段都已合格。

metadata 用来接收调用 ID 和名称：没提供就沿用以前的值，首次提供就保存，后面重复相同值允许，但换成另一 ID 或名称则拒绝。本适配器按这些字段为完整身份值处理，不尝试拼接身份字段；真正要逐片相加的是 arguments 文本。这是本章针对当前单调用协议的选择，不是所有模型接口的统一规则。

### 5. 拼接一条工具请求的参数文本

继续在 `stream-protocol.ts` 末尾追加：

<<< ../snippets/06/src/adapters/deepseek/stream-protocol.ts#tool

先看输入 value，它来自 `delta.tool_calls`，是本次新增的调用片段数组。本章只处理单调用，因此空数组表示没有新增内容；一项就继续；超过一项或 index 不是 0 就拒绝。index 标记本次响应中的调用位置，与用于关联工具结果的 ID 不是一回事。

正常第一次会收到类似：

```json
[{"index":0,"id":"call_stream","type":"function","function":{"name":"read_source","arguments":"{\"path\":"}}]
```

逐步执行：

1. delta 取出数组第一项，fn 取其中的 function 对象。
2. draft.call 尚不存在，先准备 id、name、arguments 均为空的 call。
3. metadata 保存 call_stream 与 read_source；part 接住 `{"path":` 字符串。
4. `call.arguments += part` 追加参数文本，`draft.call = call` 保存到本次草稿。
5. return part 只把这次新增文本交回上层，方便发进度通知。

第二次片段通常不再带 ID 和名称，只带 `"src/sum.ts"}`。metadata 保留原值，arguments 追加后变成完整文本：

```text
第一次：{"path":
第二次：{"path":"src/sum.ts"}
```

这里没有 JSON.parse，也没有工具调用。即使第二次已经能解析，还要继续等结束检查。我们只接收明确的 function 类型；未知类型、非法片段和中途更换身份都不能悄悄执行。

### 6. 检查一个模型事件，更新一次草稿

继续追加完整函数：

<<< ../snippets/06/src/adapters/deepseek/stream-protocol.ts#chunk

appendChunk 每次接收一份已解析的 SSE data JSON，而不是 reader.read 返回的字节。先确认 choices 恰有一个候选、choice.index 为 0，再取得 delta。这一层尚未检查完整回复，只检查这个片段能否参与组装。

#### 用三个事件观察 draft 的变化

假设依次输入文字事件、第一次参数事件和第二次参数事件：

| 事件 | 走到的代码 | 更新后 draft 的重点 |
|---|---|---|
| content 为“先查看源码。” | `draft.content += text` | content 有这句话，call 仍不存在 |
| tool_calls 带 ID、名称、第一片参数 | appendToolDelta | call 保存身份，arguments 为半份文本 |
| tool_calls 只带第二片参数 | 再次 appendToolDelta | arguments 文本完整，尚无 finishReason |

text 是本次新增文字；argumentsPart 是刚才函数交回的本次新增参数。二者在草稿更新后交给 onProgress，显示方因此可以知道到达了什么，但拿不到整个可变草稿。

末尾 `onProgress?.(...)` 表示提供监听函数时才调用。同步监听函数若抛错，本次决策会失败；不要在这里写工具执行、State 修改或未等待的异步操作。本章只有一个直接回调，不是第 9 篇将实现的通用事件系统。

#### finish_reason 与其他检查为什么放这里

收到带 finish_reason 的事件时，先处理同一个事件内的最后增量，再保存结束原因。这样不会丢掉“最后一段文字与结束原因在同一事件”的内容。

finishReason 已经出现后，不再接受新模型数据；接下来应是本接口的 `[DONE]`。当前 DeepSeek 文档把用量附在最后内容块，本章不启用其他服务那种单独空 choices 用量尾块，也不将这一适配器当成任意 OpenAI 兼容接口的通用实现。

非空 reasoning_content 拒绝，保持第 5 篇的非思考约定。content 必须是字符串或缺省/null；草稿文本与参数合计还有长度保护。后者防止无限拼接，不代替未来的 token 与费用预算。

### 7. 草稿完整后，复用原来的最终解码

继续追加：

<<< ../snippets/06/src/adapters/deepseek/stream-protocol.ts#complete

本函数接收 StreamDraft，返回 Action。它先要求有 finishReason，再把草稿组装成第 5 篇解码器已经认识的响应形状。

以读取为例：draft.call.arguments 仍是完整 JSON 字符串；放入 function.arguments 后，decodeDeepSeekAction 才会解析它，检查调用数量、身份、名称、参数对象及结束原因，再交回 tool Action。ID、名称一直缺失、参数损坏或 finish_reason 为 length 都不能因为拼接结束就绕过原检查。

若没有 call，则 tool_calls 为空数组；非空 content 与 stop 才能转换为 finish。这个返回值依旧不是 completed，仍需原循环调用应用完成规则。

复用最终解码可以让流式与非流式方式遵守同一份 Action 契约，而不在两处维护不同的参数规则。但 completeDraft 自己不知道是否收到 `[DONE]`，这一时机由下面的收集函数控制。

### 8. 一边显示进度，一边等待最终结束

继续追加完整收集函数：

<<< ../snippets/06/src/adapters/deepseek/stream-protocol.ts#collect

#### 从输入到返回走一次

参数 events 是一个可异步逐条取得字符串的来源，下一步会把 readSseData 的结果交给它。signal 继续观察运行停止，onProgress 可选。

每次调用先创建一份新的 draft，不同决策不共享它。随后 for await 取事件：

1. 普通事件文本先 JSON.parse，payload 接到解析值。
2. appendChunk 更新本次草稿；如果有增量，显示回调可能在这里运行。
3. 再检查一次 signal，避免回调刚好发出取消通知后继续处理。
4. 收到 `[DONE]` 时不做 JSON.parse，而是调用 completeDraft，确认完整 Action，再检查仍可继续并 return。

因此 progress 会在 Promise 最终返回前出现。循环仍等待这个 Promise，直到有完整 Action 或发生失败，不需要为了流式显示重写 runAgentLoop。

#### 两种“结束”不能混用

| 发生什么 | 本函数怎样处理 |
|---|---|
| `[DONE]` 到达，但没有 finish_reason | completeDraft 拒绝 |
| finish_reason 到达，随后网络关闭，没收到 `[DONE]` | 遍历结束，抛 Stream ended before [DONE] |
| 参数看似完整，随后断流 | 同样拒绝，不交回 tool Action |
| 完整结束、最终检查通过 | return 一个 Action |

JSON.parse 失败时报告 Invalid stream event JSON，说明损坏的是整条事件文本；最终解码的 Invalid tool arguments JSON 则表示参数拼接文本不合法，两者不能混为一个位置。

return 会结束外层 for await，触发来源生成器的清理；readSseData 再结束 readLines，后者在 finally 关闭读取。我们没有在清理中自动重连：对请求做重试会涉及重复生成、身份与副作用，留给后续错误策略。

#### stream-protocol.ts：把一次模型流还原成一个 Action

这个分五步追加的文件到这里已经完整。对外的 collectDeepSeekAction 接收 events、signal 和可选显示回调，返回 `Promise<Action>`；ModelProgress 与 ProgressListener 只描述进度接口。其余类型与函数支持本次接收过程，不独立持有会话。

```text
collectDeepSeekAction 为本次请求创建 draft
  → 每条 JSON 事件由 appendChunk 检查并更新
      → 工具片段交 appendToolDelta 拼接参数文本
      → 有新增内容时通知 onProgress
  → [DONE] 到达，completeDraft 调用原最终解码器
  → 检查通过，Action 返回给调用方
```

record 与 metadata 帮助检查局部值、保持身份一致。正常接收期间，draft 中的字符串可以不断变化，但只有最后的 Action 能交给循环。断流、取消或检查失败会使等待失败，不自动把已经显示的文字补进 State。

后面的模型适配器负责调用这个入口；本文件不直接读网络、不调用工具、不更新运行记录。SSE 读取与模型组装被分开，因此换字节来源不必重写这套完整动作判断。

### 9. 提供完整与断流的人工响应

新建 `src/examples/stream-fixture.ts`，写入完整内容：

<<< ../snippets/06/src/examples/stream-fixture.ts

createToolStream 是可重复观察的响应替身，不是新模型接口。它创建三份 delta：文字、第一片工具参数、第二片工具参数。frames 将每份 delta 包装为本章已经认识的 choices 结构。

complete 为 true 时，再补一个带 tool_calls 结束原因的事件与 `[DONE]`；为 false 时直接关闭。**两种情况下参数文本都已经完整，差别只在响应是否正常结束。** 这样才能验证“参数完整仍不足以执行”，而不只是验证 JSON 解析错误。

frames 的类型为 unknown[]，因为这里是在构造外部响应样本，最后还要经过本章的实际检查。wire 是带 `data:` 与空行的事件文本，TextEncoder 转为字节；每 7 字节切一次后放入流，故意不对齐事件、JSON 或中文。

start 中 enqueue 与 close 是准备人工字节，不代表读取文件，也不代表调用 DeepSeek。每次调用 createToolStream 都得到新的流，不重复消费同一份 reader。

### 10. 接回 Runtime，观察执行前的区别

新建 `src/examples/inspect-stream.ts`，写入完整内容：

<<< ../snippets/06/src/examples/inspect-stream.ts

这个入口只替换 decide 的数据来源：人工流 → SSE 解析 → 同一个 collectDeepSeekAction。执行器、读取工具和循环都复用正式实现。命令参数 mode 选择完整、断流或取消；未知值直接拒绝。

executions 只在 executeTool 真被调用时加一，不根据日志推测。controller 是外部 AbortController，signal 交给本次运行。cancel 模式在收到第一片工具参数的同步回调里主动取消，时间点固定，不依赖一个可能快慢不同的 setTimeout。

#### 先看完整响应

```bash
npm run typecheck
node src/examples/inspect-stream.ts complete
```

输出应为：

```text
暂存进度（text-delta）: "先查看源码。"
暂存进度（tool-arguments-delta）: "{\"path\":"
暂存进度（tool-arguments-delta）: "\"src/sum.ts\"}"
[执行工具 execute] read_source 文件路径（path）=src/sum.ts
运行结果（outcome）: budget-exhausted
工具执行次数（executions）: 1
已记录决策（decisions）: 1
消息顺序（messages）: user -> assistant -> tool
```

这个入口把 maxDecisions 故意设为 1，只观察一次流式工具请求能否接入原循环。因此正常结果是 budget-exhausted：一次决策与读取已完成，但没有额度再请求诊断答案。不是读取失败，也不是流式接收失败。

进度日志有三条，decisions 仍只为 1，因为只交回了一次完整 Action。最终两条新增消息分别是请求与工具结果，不是每个片段各记一条。

#### 再看参数完整却断流

```bash
node src/examples/inspect-stream.ts cut
```

仍可看到三条暂存进度，但不会出现执行工具日志。末尾应为：

```text
运行结果（outcome）: failed
工具执行次数（executions）: 0
已记录决策（decisions）: 0
消息顺序（messages）: user
失败原因（reason）: Stream ended before [DONE]
```

此时 arguments 草稿已经是合法 JSON，但 collect 没有正常返回 Action。原循环把异常归为 decision 失败，未增加 decisions，未记录 assistant 请求，也没有执行工具。已经显示的文字不会被补成成功历史。

#### 最后看收到参数时主动取消

```bash
node src/examples/inspect-stream.ts cancel
```

第一片参数进度会触发 controller.abort；末尾应为：

```text
运行结果（outcome）: cancelled
工具执行次数（executions）: 0
已记录决策（decisions）: 0
消息顺序（messages）: user
```

停止原因来自第 4 篇的 RunControl，而不是识别某个错误字符串。聚合函数和读取器使用同一 signal，不再交回成功动作。本例取消发生在工具执行前，不证明已开始的外部写操作能够回滚。

### 回看两个离线文件的配合

stream-fixture.ts 只提供 createToolStream，按参数创建一份人工字节流；inspect-stream.ts 是运行入口，根据 mode 选择是否提供结束部分，并把读取、聚合接到原 Runtime。执行计数属于这个入口的观察变量，不是新增的 State 字段。

调用关系是“inspect-stream → 人工流 → sse.ts → stream-protocol.ts → Action → 原循环”。最后真实联网时，只替换人工流的来源；这些故障安排不复制到普通模型入口中。

## 第三阶段：让真实 DeepSeek 请求使用这条接收路径

前面的工具响应是人工准备的，下面把来源换成真实 HTTP。SSE 解析、聚合、最终解码与 Runtime 不再写第二套。

### 11. 请求并读取真实 SSE 响应

新建 `src/adapters/deepseek/stream-http.ts`，写入完整内容：

<<< ../snippets/06/src/adapters/deepseek/stream-http.ts

这个函数也是异步生成器。调用 requestDeepSeekEvents 只取得一个可迭代来源，开始 for await 取值时函数体才实际运行；不要把“创建 events 变量”当成已经收到模型结果。

正常路径先核对 signal、密钥，再用 POST 发请求。`{ ...body, stream: true }` 在本函数中明确启用流式；Accept 表明期望事件流，Content-Type 表明发出的请求体仍是 JSON。这两个请求头描述的方向不同。

response 是 HTTP 响应对象；状态成功后还要检查 content-type 与 body。因为现在需要 SSE，不能把一份成功返回的普通 JSON 当成流解析。检查失败时取消未使用响应体并抛错。

最后的 `yield* readSseData(...)` 表示把解析器陆续交出的 data 继续交给本函数调用方。这里没有 response.json，不会先攒完整个响应；每条 data 到达后就可以进入聚合函数。

信号同时交给 fetch 和 SSE 读取：前者通知实际网络请求，后者保护读取和清理。HTTP 401 等错误依旧发生在动作形成之前；本函数没有自动重试、工具执行或 State 写回。

#### stream-http.ts：提供事件来源，何时结束由上层决定

文件公开 requestDeepSeekEvents，接收请求配置与 signal，返回可异步读取 data 的来源。函数内部连接 fetch 与 readSseData；外面的 collectDeepSeekAction 逐条取值时，这条读取链才被消费。

它对上交出的是事件字符串，不是 Action。聚合方得到结束标志、发生错误或取消后不再继续取值，生成器清理才沿读取链释放资源。正常流式工具执行的判定不在这个文件里，不能在 yield 某条参数片段时提前调用工具。

### 12. 在原 decide 工厂中增加可选流式方式

修改 `src/adapters/deepseek/decider.ts`。先用下面整段替换顶部导入，删除旧导入区，避免重复：

```ts
import type { Action, Dependencies } from "../../runtime/types.ts";
import type { ToolRegistry } from "../../runtime/tool-registry.ts";
import { requestDeepSeek } from "./http.ts";
import { requestDeepSeekEvents } from "./stream-http.ts";
import { collectDeepSeekAction } from "./stream-protocol.ts";
import type { ProgressListener } from "./stream-protocol.ts";
import { buildDeepSeekMessages, decodeDeepSeekAction } from "./protocol.ts";
```

用下面完整类型替换 DeepSeekOptions：

<<< ../snippets/06/src/adapters/deepseek/decider.ts#options

stream 与 onProgress 都可选。第 5 篇原入口不传 stream，仍走非流式方式；新的入口传 true，才启用本章路径。回调只用于流式进度，不是让循环依赖一种新返回类型。

再用下面完整函数替换 createDeepSeekDecider，其他文件里的 Dependencies 保持不变：

<<< ../snippets/06/src/adapters/deepseek/decider.ts#factory

#### 两种路径在哪里分开，在哪里汇合

创建时提取工具清单的逻辑沿用第 5 篇。每轮运行时，先从 context 构造 messages，再准备共同请求体 body，随后分支：

```text
options.stream 为 true
  requestDeepSeekEvents → events（可逐条取 data 的来源）
  collectDeepSeekAction → 等待增量、显示进度、确认结束 → Action

未启用 stream
  requestDeepSeek → 等待完整 JSON → payload
  decodeDeepSeekAction(payload) → Action

两条路径汇合
  检查本次调用 ID 是否与历史重复
  → 记录动作类型日志
  → return action 给原循环
```

let action 声明的是本轮最终动作，不是草稿。流式分支里只有 collect 正常返回才给它赋值；断流或取消会抛错，后面的日志与 return 都不会当作成功继续。

body 不包含循环、executeTool 或 State。这里选择的只是如何取得同一份 Action，不是增加另一套运行调度。原来的名称查找、参数检查、工具执行与完成规则仍然有效。

onProgress 是应用提供的同步显示函数。即使文字已经打印，ID 去重或其他最终检查仍可能拒绝这份动作；因此正常入口会把最终结果与暂存显示分开表达。

完成迁移后运行：

```bash
npm run typecheck
node src/examples/first-loop.ts
```

这两条检查不需要模型密钥。真实非流式入口也保留，后面可以与新入口分别运行对照。

#### decider.ts 增加流式后，公开责任保持一致

这个文件仍负责创建 Dependencies.decide：接收本轮 Context，最后交回一个 Action。本章在其中增加“流式收集”与“整份 JSON 解码”的选择，两条路径最后都回到同一调用 ID 检查与 return。

因此 Runtime 使用它的方式没有变化。网络读取由 stream-http.ts 提供，草稿与最终解码由 stream-protocol.ts 处理，进度交给应用；decider.ts 只把这些模块接成一次决策，不会因为选择 stream 就变成第二个循环或 State 的拥有者。

### 13. 运行真实流式诊断

新建 `src/examples/deepseek-stream-agent.ts`，写入完整内容：

<<< ../snippets/06/src/examples/deepseek-stream-agent.ts

与第 5 篇入口对照，只增加了流式配置和显示回调：stream:true 选择新路径；text-delta 到达时用 process.stdout.write 追加文字，不为每片内容额外换行。工具参数增量没有在正常入口打印，避免把协议观察混进用户回答。

其余仍按“读配置 → 注册工具 → 创建 decide → 运行原循环 → 显示最终结果”的顺序。读取工具、诊断提示词、hasReadEvidence 都复用上一章，没有把固定诊断答案喂给真实模型。

在根目录确认 `.env` 已配置后运行：

```bash
node --env-file=.env src/examples/deepseek-stream-agent.ts
```

普通 `node src/examples/deepseek-stream-agent.ts` 不会自动加载 `.env`。若提示密钥缺失，先确认命令与配置，不要为了继续运行把密钥硬编码到源码。

**下面是典型两轮流程示意，不是承诺模型每次按固定轮数或措辞输出：**

```text
[请求模型 model] 消息角色（roles）=system -> user
……收到的文字逐步显示……
[模型动作 action] tool
[执行工具 execute] read_source 文件路径（path）=src/sum.ts
[请求模型 model] 消息角色（roles）=system -> user -> assistant -> tool
……诊断文字逐步显示……
[模型动作 action] finish
运行结果（outcome）: completed
决策次数（decisions）: 2
消息顺序（messages）: user -> assistant -> tool -> assistant
最终答案（answer）: ……本次完整答案……
```

工具请求前可能没有文字，或文字和动作日志紧接在同一行，这是显示方式，不表示消息记录混在一起。结束后再次输出最终答案，是为了区分暂存输出与已接受结果，可能与之前看到的文字重复。

把 deepseek-stream-agent.ts 作为整体看，它仍是正常使用入口：读配置、创建工具与决策器、运行、显示结果。onProgress 只把新增文字打印出来，运行结束后再显示正式 RunResult；前者可能在失败前已经出现，后者才说明本次运行的状态。它没有人工断流开关，也没有把控制草稿的逻辑搬进应用入口。

### 完整响应怎样进入下一次请求

现在从用户任务重新走一次，特别注意谁写 State：

| 时刻 | 草稿 | State 消息 | 工具能否开始 |
|---|---|---|---|
| 第一轮刚发请求 | 空 | user | 不能 |
| 收到文字和参数片段 | 本次 collect 的局部对象不断更新 | 仍为 user | 不能 |
| 收到正常结束并通过解码、去重 | 生成一个 tool Action | 原循环记录 user → assistant | 由循环安排执行 |
| 读取成功并写回 | 本次草稿不再参与执行 | user → assistant → tool | 已完成本次读取 |
| 第二轮发请求 | 新的一份草稿 | 仍有前三条消息 | 按新模型动作决定 |
| 第二轮完整答案通过完成规则 | 返回 finish | user → assistant → tool → assistant | 本次运行结束 |

第二轮仍由 buildDecisionContext 从最新 State 复制消息，再由 buildDeepSeekMessages 转换。因此源码结果能进入下一次真实请求。流式改变的是一轮模型响应的接收方式，不改变工具结果反馈的主线。

显示回调不能自己追加 assistant 消息。否则第一次收到“需要检查”就写入一次、接着又为工具片段写一次，会把一次响应拆成没有完整调用关系的会话，破坏下一次请求的历史。

## 怎样调试：先判断数据停在哪一层

从离线 complete 入口开始调试，不必先排查网络：

```bash
node --inspect-brk src/examples/inspect-stream.ts complete
```

在 Chrome 的 `chrome://inspect` 连接该 Node 进程。入口有 1000 毫秒运行上限，长时间停在断点会使累计截止时间经过；需要逐步观察时可临时改大，调试后恢复。不要把断点造成的超时误当成 SSE 错误。

| 现象 | 第一个观察位置 | 检查什么 |
|---|---|---|
| 中文损坏或 JSON 无故断开 | readLines 的 decode 后 | 是否复用 decoder，stream 选项是否开启 |
| 每个字节块都变成一条事件 | readSseData 的 yield 处 | 是否真的遇到空行，data 是否先收集完整 |
| 有事件但没有进度 | collect 的 JSON.parse、appendChunk | choices、delta、content 的具体形状 |
| 参数中只有后一半 | appendToolDelta 的 += 之后 | 是追加还是覆盖，call 是否每次被重建 |
| 参数完整但工具没执行 | completeDraft 与 collect 的结束分支 | finishReason、[DONE]、最终解码是否都通过 |
| 断流反而执行了工具 | collect 返回处与循环写回处 | 是否把 EOF 或合法 JSON 当成了正常结束 |
| 显示文字却没有 assistant 记录 | decide 是否正常返回 | 本次可能失败或取消，不能仅按显示推断成功 |
| 下一轮模型不知道源码 | agent-loop 的结果写回、messages 构造 | 是否含对应调用 ID 与实际工具结果 |

第一次只沿一个 call_stream 追踪：工具片段里的 id → draft.call.id → 完整 action.call.id → result.callId → 下一次 tool_call_id。再看 arguments 是什么时候从字符串变成对象，不要同时展开全部 HTTP 字段。

真实联网入口的调试命令为：

```bash
node --env-file=.env --inspect-brk src/examples/deepseek-stream-agent.ts
```

遇 HTTP、账户或网络错误时仍先检查第 5 篇链路；只有已经取得合法 SSE 响应后，才进入本章字节、事件和草稿的排查。

## 可逆故障实验

complete、cut、cancel 是固定观察模式，运行它们不需要改源文件。下面再临时改变一个条件，检查是否理解了两次结束确认。

### 已收到 finish_reason，但没收到 [DONE]

在 `src/examples/stream-fixture.ts` 中，临时把 wire 最后的这一行：

```ts
(complete ? "data: [DONE]\r\n\r\n" : "");
```

替换为：

```ts
"";
```

运行 `node src/examples/inspect-stream.ts complete`。这次 finish_reason 存在、参数也完整，但仍应 failed，executions 与 decisions 均为 0，State 只有 user。说明我们检查的不只是参数和生成结束原因。

把原行恢复后，complete 应再次执行一次读取并返回 budget-exhausted。恢复后再运行 typecheck；不要把故障版本作为本章最终实现提交。

### 迁移一个小需求：把第二片参数再切成两片

只修改 stream-fixture.ts：将 arguments 为 `"src/sum.ts"}` 的那条 delta 改成两条，分别发送 `"src/` 与 `sum.ts"}`。保持原 ID、结束原因和 `[DONE]`，不要修改聚合函数。

运行 complete，预期参数进度多一条，但完整 Action、executions 为 1、decisions 为 1、最终消息角色均不变。如果必须修改 Runtime 才能通过，说明它仍错误依赖固定片数。观察完成后恢复章末版本，供下一章继续。

## 对照 Pi：暂存进度与最终消息怎样区分

固定提交 `8efd314fa3d3232ce197d8d7a6a5660530b9d83e` 的 [openai-completions.ts](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/ai/src/api/openai-completions.ts#L655) 中，工具参数片段追加到 partialArgs，并发出 toolcall_delta。它还可以为显示解析部分 JSON；不能因此推断部分参数已经执行。

同文件的 [finishBlock](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/ai/src/api/openai-completions.ts#L432) 会完成参数并清除流式暂存字段；结束处检查生成结束原因后才发 done。本章暂不解析半份 JSON，只通知原始字符串片段，最后复用原完整响应解码。

对照的共同问题是：哪些只是进度，哪些可以成为最终消息。Pi 的事件类型、提供商兼容分支与工具批次比这里更多；本章的严格 `[DONE]` 要求、单调用限制和回调类型是自己的设计，不宣称 Pi 使用相同接收策略。

## 完整最终文件

这里只汇总本章新增或修改的 8 个文件。其余第 5 篇实现保留，不要删除原非流式入口或修改循环。

### src/adapters/sse.ts

<<< ../snippets/06/src/adapters/sse.ts

### src/examples/inspect-sse.ts

<<< ../snippets/06/src/examples/inspect-sse.ts

### src/adapters/deepseek/stream-protocol.ts

<<< ../snippets/06/src/adapters/deepseek/stream-protocol.ts

### src/examples/stream-fixture.ts

<<< ../snippets/06/src/examples/stream-fixture.ts

### src/examples/inspect-stream.ts

<<< ../snippets/06/src/examples/inspect-stream.ts

### src/adapters/deepseek/stream-http.ts

<<< ../snippets/06/src/adapters/deepseek/stream-http.ts

### src/adapters/deepseek/decider.ts

<<< ../snippets/06/src/adapters/deepseek/decider.ts

### src/examples/deepseek-stream-agent.ts

<<< ../snippets/06/src/examples/deepseek-stream-agent.ts

## 验收与提交

本章应能解释并观察四件事：分片边界不损坏中文与事件；显示进度不增加决策计数；完整且合法的响应才允许工具启动；断流和取消不把草稿写入 State。原非流式入口也应继续可用。

恢复故障实验与迁移练习后，在本章分支运行：

```bash
npm run typecheck
node src/examples/inspect-sse.ts
node src/examples/inspect-stream.ts complete
node src/examples/inspect-stream.ts cut
node src/examples/inspect-stream.ts cancel
node src/examples/first-loop.ts
node --env-file=.env src/examples/deepseek-agent.ts
node --env-file=.env src/examples/deepseek-stream-agent.ts
git branch --show-current
git status --short
git diff --stat
```

前六条运行检查不需密钥；两条真实模型入口需要有效配置。确认联网行为与消息反馈正常后，才使用下面包含真实接口验证描述的提交信息；尚未联网通过时，修改描述以符合实际。

只暂存本章 8 个源码文件，不要把 .env 放入暂存区。git add 选择要提交的改动，git commit 保存本地版本，git push 将这个分支推到 GitHub；不会由这些命令自动合并 main。

提交同时包含本章源码和 `site/` 网站更新；推送章节分支后，还需将 Pull Request 合并到 main，Actions 才会发布网页。

```bash
git add -- src/adapters/sse.ts src/examples/inspect-sse.ts src/adapters/deepseek/stream-protocol.ts src/examples/stream-fixture.ts src/examples/inspect-stream.ts src/adapters/deepseek/stream-http.ts src/adapters/deepseek/decider.ts src/examples/deepseek-stream-agent.ts site/
git diff --cached --stat
git commit -F - <<'COMMIT'
第 06 篇：接入流式响应并保护完整动作边界

在原有 DeepSeek 适配器中增加可选流式接收，进度只用于显示，完整动作仍交给同一个 Runtime 执行与记录。

- 新增 UTF-8 分块解码与 SSE data 读取
- 暂存文本和工具参数，确认结束后复用最终动作检查
- 保留非流式入口，增加真实流式诊断入口
- 增加完整、断流和取消的离线观察

验证：类型检查、离线入口与故障实验通过；真实流式及非流式模型调用通过。未提交密钥配置。
COMMIT
git push -u origin codex/chapter-06-streaming
```

下一篇才扩展一个响应中的多个工具调用，届时会处理不同调用的索引、身份与完成顺序。本篇先把单调用的“暂存 → 确认 → 执行”边界建立清楚。
