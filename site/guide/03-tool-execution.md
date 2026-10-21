---
title: 第 03 篇｜工具契约与执行入口
description: 从参数校验开始，建立工具注册表与统一执行入口，再将带调用身份的成功或失败结果交回原有 Runtime。
---

# 第 03 篇：请求一个工具，不等于可以直接执行

第 2 篇已经连起“最新状态 → 本轮输入 → 决策”。现在，脚本提出 `read_source` 请求，循环就调用场景提供的读取函数。但如果请求的工具根本没有注册，或者 `path` 变成了数字，应该由谁阻止它？

本篇补上**工具执行入口**：先按名称找到工具，再检查参数，最后才允许进入具体操作。你会先独立运行一个工具，看到合法参数能够进入读取体、错误参数被提前挡住；随后将它接回原有循环，观察成功和失败怎样成为下一轮输入。

要理解的核心关系是：**模型提出请求，应用提供工具，执行入口检查并调用，循环记录结果。** 本篇会实现工具定义、参数检查、注册表与统一结果包装。循环、State 和 Context 继续使用前两篇的代码。读取仍返回固定源码，决策仍由脚本模拟；真实文件读写、模型接口、审批、超时和取消尚未实现。

## 本篇推荐分支

从第 2 篇已验证并提交的本地版本创建，推荐分支名为 `codex/chapter-03-tool-execution`：

```bash
git switch -c codex/chapter-03-tool-execution
```

若分支已存在，用 `git switch codex/chapter-03-tool-execution` 返回。以下命令均在仓库根目录运行，不需要安装新依赖。开始前运行 `npm run typecheck`，确认第 2 篇没有遗留类型错误。

## 先看一次请求要经过哪里

继续诊断同一个问题：`sum([])` 为什么失败。脚本先提出以下请求，这是数据，还没有发生读取：

```json
{
  "id": "read-1",
  "name": "read_source",
  "arguments": { "path": "src/sum.ts" }
}
```

`name` 表示“要用哪种工具”，`id` 表示“这是哪一次调用”。同一个工具可以被调用很多次，每次结果需要回到对应请求。当前固定场景只调用一次，所以沿用 `read-1`；以后多次调用时还需要管理各次身份。

本篇让执行这份请求的过程变成下图。蓝色箭头沿正常路径向下，右侧显示被拒绝的请求怎样返回。绿色部分仍由循环负责：

[![工具执行流程：循环交出请求，注册表查名称，工具入口检查参数，通过后执行；结果由循环关联并写回状态](/diagrams/tool-execution-gate.svg)](/diagrams/tool-execution-gate.svg)

点击图片可单独打开查看。图中省略完成验证与次数预算；它们继续保留在循环中。具体读取体仍是模拟实现。

正常情况下，`read_source` 找到已注册的读取工具，`{ path: "src/sum.ts" }` 通过检查，读取体交回源码。执行入口再补上原请求的 `callId`，循环把结果保存为 tool 消息。下一轮 Context 才会包含它。

如果参数是 `{ path: 42 }`，名称仍然能找到工具，但参数检查失败，读取体不会被调用。执行入口交回带 `invalid-arguments` 的错误结果，循环同样记录它。脚本因此知道“没拿到可用源码”，而不是误以为读取成功。

### 为什么要从原函数中抽离

上一章的 `simulateReadSource` 把工具名判断、参数检查、模拟读取和结果包装放在一个函数里。只处理固定读取时容易理解；再增加搜索、写文件等工具，这个函数就需要知道所有工具的规则。

本篇按变化原因拆分：工具各自定义参数和操作；注册表只查名称；执行入口统一包装结果。循环仍只安排调用、核对调用身份并写回状态，不增加读取路径等场景知识。

这里的**契约**是模块之间约定的输入、输出和行为。例如“执行入口接收 ToolCall，返回带同一调用 ID 的 ToolResult”。类型帮助检查代码是否遵守约定，运行时的参数检查则负责核实本次实际收到的数据。

## 文件变化与数据归属

下面是本篇最终变化。第一阶段只写独立工具，第二阶段再接入原系统；不要一次性创建所有文件。

| 文件（均在 src/ 下） | 变化 | 职责 |
|---|---|---|
| runtime/tool.ts | 新增 | 连接参数检查与工具执行体 |
| runtime/tool-registry.ts | 新增 | 保存工具名称到入口的对应关系 |
| runtime/tool-executor.ts | 新增 | 查找工具、调用入口、包装带身份的结果 |
| runtime/types.ts | 修改 | 为工具失败增加明确错误代码 |
| runtime/agent-loop.ts | 修改 | 现有异常兜底补齐错误代码，其余流程不变 |
| examples/diagnosis-fixture.ts | 新增 | 集中保存本场景固定数据 |
| examples/read-source-tool.ts | 新增 | 定义读取参数规则与模拟读取体 |
| examples/diagnosis-scenario.ts | 修改 | 移除旧读取器，保留请求、决策与完成规则 |
| examples/inspect-tools.ts | 新增 | 先观察单工具，再观察完整执行入口 |
| examples/first-loop.ts | 修改 | 注册读取工具并接入原循环 |
| examples/inspect-context.ts | 修改 | 将上一章观察入口迁移到新执行器 |

这些文件持续组成同一个 Runtime；`examples/` 是组装与演示场景，`runtime/` 中的模块会继续演进。`context.ts` 本篇不修改。

| 数据 | 谁创建、谁持有 | 会不会写进 State |
|---|---|---|
| ToolCall 请求 | 决策方提出，循环记录为 assistant 消息 | 会 |
| Tool 工具对象 | 应用定义，注册表保存其名称和入口 | 不会，里面包含函数 |
| 注册表内部 Map | 创建注册表时建立，执行入口通过它查名称 | 不会，只在内存里供执行器使用 |
| 校验成功后的参数 | 工具的 parse 函数创建，invoke 交给执行体 | 不单独保存 |
| ToolOutput | 工具入口返回，不带调用 ID | 不直接保存 |
| ToolResult | 执行入口补上调用 ID 后返回 | 循环将它包装为 tool 消息后保存 |

源码文件用于定义代码，并不意味着数据被保存到文件中。这里的注册表、State、Context 和局部变量都在当前进程内存里，尚未做会话落盘。

## 第一阶段：先让一个工具检查参数

先完成这一阶段并运行，再进入注册与集成。此时上一章入口继续使用旧读取器，新工具还没有接入循环。

### 1. 定义工具接收什么、返回什么

新建 `src/runtime/tool.ts`，写入以下类型。下一步在同一文件末尾追加函数。

<<< ../snippets/03/src/runtime/tool.ts#contracts

先用本例的具体值理解：参数正确时，检查函数交回 `{ ok: true, value: { path: "src/sum.ts" } }`；参数错误时，交回 `{ ok: false, message: "path must be a non-empty string" }`。这两种形状由 `ParseResult` 描述。失败分支没有 value，调用方不能把它当成已确认的参数。

`Args` 是“这个工具检查通过后，参数是什么类型”的占位名称。读取工具会用 `{ path: string }` 替换它。`ToolDefinition<Args>` 中 parse 交出的 value 和 execute 接收的 args 使用同一个类型，避免二者各说各话。这是泛型在这里的用途，不必先记住抽象定义。[TypeScript：泛型函数连接输入与输出类型](https://www.typescriptlang.org/docs/handbook/2/functions.html#generic-functions)

`ToolDefinition` 是定义工具所需的三项配置：名称、参数检查函数、具体执行函数。注册表最终只需要一个统一入口，所以 `Tool` 只公开 name 和 invoke；各工具内部参数类型可以不同，外部都从 invoke 进入。

invoke 接收 `unknown`：调用者可以交入数据，但工具不能未经判断就按字符串读取 path。与 `any` 不同，unknown 要求先确认数据的形状，才能使用其中字段。TypeScript 类型声明不会在程序运行时自动替你检查数据，本阶段接下来会写真实的检查语句。

`ToolOutput` 是工具内部的返回值：成功带 value，参数失败带错误代码和说明。此时工具只知道参数，不需要负责 `read-1` 这样的调用身份。第二阶段的执行入口会添加它。`Tool`、`ToolOutput` 这些类型也不会自己创建对象；实际对象由下面的函数产生。

### 2. 确保检查成功后才执行

在 `src/runtime/tool.ts` 的类型定义后追加完整函数：

<<< ../snippets/03/src/runtime/tool.ts#define

之后调用 `readSourceTool.invoke({ path: "src/sum.ts" })` 时，先运行定义中的 parse。拿到 `ok: true` 后，`parsed.value` 已经是读取工具要求的参数，再传给 execute。await 等待执行完成，最终把源码包装成 `{ status: "ok", value: 源码 }` 返回。

这个顺序由 defineTool 统一安排。工具作者提供检查规则和操作，调用者不必先记得手工检查一次、再调用另一个读取函数。不同工具复用同一入口顺序。

如果 parse 返回 `ok: false`，函数当场 return 错误对象，后面的 execute 根本不会运行。**检查后返回失败，与执行后报告失败，是两个时刻。** 写文件等操作一旦开始可能已经产生影响，所以后续接入真实工具时，检查的位置尤其关键。

这里没有 catch。检查函数意外抛错或执行体抛错，都会使 invoke 返回的 Promise 失败；第二阶段统一执行入口会将这类异常包装为工具错误。参数被规则拒绝则是正常返回的错误对象，二者走的路径不同。

#### tool.ts：定义工具的统一调用方式

这个文件把“工具作者的配置”变成“调用方可以使用的 Tool”。创建时，defineTool 接收 name、parse、execute，返回带 invoke 的对象；调用时，invoke 才执行 parse，检查成功后将 parsed.value 交给 execute，再把输出包装为 ToolOutput。

```text
工具作者：defineTool({ name, parse, execute }) → Tool
调用方：Tool.invoke(原始参数) → parse → 合格才 execute → ToolOutput
```

parse 与 execute 的具体业务由工具作者提供，本文件只安排共同顺序；它不查工具名称、不添加调用 ID，也不写 State。后面的统一执行入口会在它外面补这几项职责中的查找与身份包装。

### 3. 把固定场景数据集中放好

新建 `src/examples/diagnosis-fixture.ts`，写入完整内容：

<<< ../snippets/03/src/examples/diagnosis-fixture.ts

这四个值来自上一章的固定诊断。现在读取工具和场景判断会分开，二者需要引用同一份路径、源码和答案，因此先建立共享位置。fixture 在这里指**固定演示数据**；它不是配置中心，也不是 Runtime 自带的业务知识。

第一阶段暂时保留旧场景文件中的常量；第二阶段会删除它们并改为导入本文件。最终只保留这一份定义。`runtime/` 中的通用模块不会导入它。

### 4. 编写读取参数的检查规则

新建 `src/examples/read-source-tool.ts`，先写导入：

```ts
import { defineTool } from "../runtime/tool.ts";
import type { ParseResult } from "../runtime/tool.ts";
import { sourceCode, sourcePath } from "./diagnosis-fixture.ts";
```

紧接着追加类型和完整函数：

<<< ../snippets/03/src/examples/read-source-tool.ts#parser

先沿正常输入走一遍。`{ path: "src/sum.ts" }` 是非 null、非数组的对象；它有非空字符串 path，没有其他字段，而且 path 等于本例允许的 sourcePath。最后返回一个新的 `{ path: input.path }`，供读取体使用，而不是直接把原始 input 塞过去。

每一层判断都解决一个具体问题：

| 检查位置 | 拦下的例子 | 原因 |
|---|---|---|
| 对象形状 | null、数组、数字 | 这些都不是本工具约定的参数对象 |
| path 存在且为非空字符串 | `{}`、`{ path: 42 }`、`{ path: " " }` | 读取体需要有意义的字符串路径 |
| 没有额外字段 | `{ path: "src/sum.ts", force: true }` | 本工具未定义 force，不能默默接受并让调用者误以为它生效 |
| 等于演示路径 | `{ path: "src/other.ts" }` | 模拟读取只认识固定源码，不能对任何路径都返回同一段内容 |

`typeof null` 的结果也是 `"object"`，数组也是对象，因此第一层要分别排除它们。通过后，`"path" in input` 确认字段存在，`typeof input.path === "string"` 才允许后续使用 trim。条件通过短路求值从左到右检查，未确认字符串前不会调用 trim。[TypeScript：通过判断收窄类型](https://www.typescriptlang.org/docs/handbook/2/narrowing.html)

`Object.keys(input).some(...)` 检查字段名中是否存在任何非 path 的项；存在就拒绝。最后一层则核对字符串的具体值，所以“path 是字符串”与“这个路径在本例允许范围”是两件事。

这份解析器接受的是普通请求数据，明确构造新的已确认参数。不使用 `as ReadSourceArgs` 强行让类型检查器相信它正确。固定路径限制只是本场景的规则；它没有实现操作系统隔离、真实路径解析或完整的文件访问权限。

### 5. 组装可调用的读取工具

在 `src/examples/read-source-tool.ts` 末尾追加：

<<< ../snippets/03/src/examples/read-source-tool.ts#definition

`defineTool<ReadSourceArgs>` 把“检查成功后的参数是 `{ path: string }`”这件事同时告诉 parse 和 execute。创建 readSourceTool 时只是保存函数，没有执行读取；真正调用 invoke 才会进入上一步的检查流程。

`async execute(args)` 是具体读取体。它只在检查通过后运行，因此这里可以直接使用 args.path。日志放在执行体内部，便于观察请求是否到达了实际操作位置；返回的仍是固定 sourceCode，并没有调用文件系统。

到这里，read-source-tool.ts 已经组成一个完整工具：parseReadSourceArgs 规定什么参数可以读取，readSourceTool 用 defineTool 把检查器与模拟 execute 连起来，对外只导出这个 Tool 对象。调用方交入原始参数，invoke 最后交回源码或参数失败；本文件既不生成调用 ID，也不保存会话。

它与 tool.ts 的区别是：tool.ts 安排所有工具共用的调用顺序，当前文件提供 read_source 的具体规则与操作。以后替换真实读取，应修改这里的执行体，并保持描述、检查和实际能力一致，而不是在循环中新增路径判断。

### 6. 第一次运行：合法参数与数字路径

新建 `src/examples/inspect-tools.ts`，写入本阶段的完整入口。第二阶段会替换此文件，不另留一套实现。

<<< ../snippets/03/checkpoints/01-invoke.ts

运行：

```bash
npm run typecheck
node src/examples/inspect-tools.ts
```

输出应为：

```text
检查场景（case）: 合法参数
[执行工具 execute] read_source 文件路径（path）=src/sum.ts
工具状态（status）: ok
检查场景（case）: 路径类型错误
工具状态（status）: error
错误代码（code）: invalid-arguments
错误说明（message）: path must be a non-empty string
```

第一份参数经 parse 后进入读取体，再返回 ok。第二份参数中的 path 是数字，检查返回失败；输出中只有一次执行日志，数字路径没有进入本工具的执行体。

入口中的 valid、invalid 分别接住两次 invoke 返回的 ToolOutput。它们只用于打印，没有写入 State，也没有触发下一轮决策。此时你已验证最重要的局部机制：**收到参数以后，程序能够先判断，再决定是否执行。**

## 第二阶段：按名称找到工具，再接回循环

现在 invoke 已经能保护单个工具，但调用方还直接持有 readSourceTool。Runtime 收到的是工具名称和参数，需要按名称选择入口，并统一给结果加上调用身份。本阶段完成这条连接。

以下步骤涉及接口迁移。先完成全部修改，再运行整项目类型检查；中间保存了一半时出现导入或缺字段错误，要继续核对迁移步骤，而不是删掉检查。

### 7. 给工具失败增加可识别的代码

在 `src/runtime/types.ts` 中，用下面整段**替换原 ToolResult 定义**，将 ToolErrorCode 放在它前面。其他类型保留。

<<< ../snippets/03/src/runtime/types.ts#tool_result

本项目用三个固定值区分工具失败：unknown-tool 表示找不到工具，invalid-arguments 表示参数未通过规则，tool-error 表示检查或执行过程中出现了异常。这是本教程的内部协议，不是模型服务要求的统一标准。

例如数字路径的最终结果会是：

```json
{
  "callId": "read-1",
  "status": "error",
  "code": "invalid-arguments",
  "message": "path must be a non-empty string"
}
```

code 给程序稳定的分类，message 提供具体说明。之后不能通过判断错误文字中是否含某个词来推测种类。成功分支保持原样；判断 `result.status === "error"` 后才能读取 code 和 message。

ToolOutput 与 ToolResult 也有明确区别：前者是工具入口内部返回值，后者带 callId，可以交给循环关联和记录。本阶段会在二者之间补上包装。

### 8. 建立工具名称索引

新建 `src/runtime/tool-registry.ts`，先写以下导入：

```ts
import type { Tool } from "./tool.ts";
```

然后追加注册表的公开接口：

<<< ../snippets/03/src/runtime/tool-registry.ts#interface

**注册表**就是一张“名称对应哪个工具入口”的表。`get("read_source")` 要么取得 Tool，要么得到 undefined；names 用于显示已经注册哪些名称。它保存可调用的程序能力，与 State 中记录“先前发生了什么”的消息不是同一类数据。

在同一文件末尾追加完整创建函数：

<<< ../snippets/03/src/runtime/tool-registry.ts#create

应用调用 `createToolRegistry([readSourceTool])` 后，函数内部创建 byName，并把 `read_source` 对应的名称和 invoke 存进去。返回对象中的 get 继续使用这张 Map；创建函数返回后，Map 仍被这些函数引用，因此后续还能查找。这种让函数保留外层局部变量的关系称为闭包。

byName 没有被直接交给外部。调用者可以查工具或取得名称列表，不能通过这个接口调用 Map.set 随意注册新工具。names 每次产生一个新数组，修改返回数组不会改变索引。这里限制的是公开操作，不宣称对象被深度冻结。

重复注册 `read_source` 时直接抛错。如果静默覆盖，实际执行哪个入口就取决于配置排列顺序，错误很难发现。空名称也拒绝；其他名称按原值精确匹配，不自动改大小写或去掉两端空格。

注册发生在任务开始前，所以重复名称属于应用配置错误，不包装成某次模型调用的工具失败。修复方式是检查注册清单。它与运行中收到未知工具请求的处理位置不同。

#### tool-registry.ts：持有工具清单，不执行请求

文件中的 ToolRegistry 描述查找接口，createToolRegistry 根据应用交来的 Tool 列表建立名称索引，返回 get 与 names。创建函数结束后，两个返回函数继续引用内部 Map，因此清单仍能用于后续请求。

本例的关系是“应用注册 readSourceTool → get("read_source") 取得 Tool”。查到对象不代表调用过 invoke；注册表也不会接收 State 或把工具定义放进会话。下一步执行器负责使用这张表，按收到的 ToolCall 调用具体入口。

### 9. 实现统一执行入口

新建 `src/runtime/tool-executor.ts`，写入完整文件：

<<< ../snippets/03/src/runtime/tool-executor.ts

先看创建和调用这两个时刻：`createToolExecutor(registry)` 只返回一个函数；随后 `executeTool(call)` 才根据这次 call 查工具并执行。返回函数保留 registry，因而每次调用不必再传整张表。

用本例走正常路径：

1. `registry.get(call.name)` 用 read_source 查到 Tool。
2. `tool.invoke(call.arguments)` 把 `{ path: "src/sum.ts" }` 交给已写好的检查入口。
3. invoke 完成检查和读取，交回 `{ status: "ok", value: 源码 }`，由 output 接住。
4. `{ ...output, callId: call.id }` 创建带原请求身份的新结果，返回给调用方。

::: info 以下摘录仅供对照
解释中的代码片段已包含在上方对应的完整实现中，**无需再次写入、追加或替换文件**。继续实现时，以标明“新增、追加、替换”的步骤为准。
:::

**讲解摘录 · 把工具输出带上本次请求身份（无需写入文件）**

<<< ../snippets/03/src/runtime/tool-executor.ts#explain-output

执行器内的 output 是 ToolOutput，循环内接住返回值的 result 才是 ToolResult。return 只把对象交回去，**此函数没有 State，也不会自己追加消息**。

失败有三个位置。查不到名称时，在调用 invoke 前返回 unknown-tool。检查返回拒绝时，invoke 正常交回 invalid-arguments，执行器为它补上 callId。检查函数或执行体抛出异常时，才进入 catch，返回 tool-error。catch 用 Error.message 或 String(error) 取得说明，不把任意抛出值都假定为 Error。

callId 始终取自原请求，工具体不用自己生成它。循环原有的对应关系检查仍保留：executeTool 是外部依赖，不能因为本入口正确包装，就删掉循环边界的核对。

本入口现在接收项目内部的 ToolCall；它没有检查来自网络的整份未知 JSON 是否真是 ToolCall。以后接入模型时，会在适配边界处理动作形状。此处补的是工具参数运行时检查，不能用 TypeScript 声明代替外部数据校验。

#### tool-executor.ts：将模型请求接到本地工具

本文件的 createToolExecutor 接收注册表，返回可交给循环的 executeTool 函数。真正调用时，ToolCall 经过“按 name 查找 → invoke 检查与操作 → ToolOutput 补上原 call.id”，最后形成 ToolResult。

它连接了前面两个文件：注册表决定名称对应哪个 Tool，tool.ts 保证 invoke 内先检查后执行；执行器负责把结果关联回这次请求。三个模块都没有保存会话，ToolResult 返回后仍要由 agent-loop.ts 核对并追加 tool 消息。

### 10. 迁移原场景与循环的错误兜底

这一小节需要同时迁移数据定义、旧读取器和导入。**只添加新导入，旧声明仍在时，会出现重名冲突。** 按下面顺序完成整个文件的修改；中间状态暂不单独运行类型检查。

**10.1 删除原文件顶部、createReadSourceCall 之前的两个常量定义：**

```ts
const sourcePath = "src/sum.ts";
const sourceCallId = "read-1";
```

只删除这两项定义，保留后面的 createReadSourceCall 函数。函数仍使用相同名称，但接下来会从 diagnosis-fixture.ts 导入这些值。

**10.2 在 createReadSourceCall 与 scriptedDecide 之间，删除下面整个旧读取区块：**

```ts
// 固定字符串代替磁盘内容，先把运行过程变成可重复观察的过程。
const sourceCode =
  "export const sum = (numbers: number[]) => numbers.reduce((a, b) => a + b);";

/** 模拟单个读取工具；只接受本例支持的名称和路径。 */
export async function simulateReadSource(call: ToolCall): Promise<ToolResult> {
  console.log(`[执行工具 execute] ${call.name} 文件路径（path）=${String(call.arguments.path)}`);

  // 模拟执行也只接受约定的请求，不能对任意输入返回成功。
  if (call.name !== "read_source") {
    return { callId: call.id, status: "error", message: "Unsupported tool" };
  }

  if (call.arguments.path !== sourcePath) {
    return { callId: call.id, status: "error", message: "Source path is not allowed" };
  }

  return { callId: call.id, status: "ok", value: sourceCode };
}
```

这里要连同 sourceCode 定义和整个 simulateReadSource 函数一起删除。模拟读取已经移到 read-source-tool.ts，调用身份和错误包装交给 tool-executor.ts；保留旧读取器会使两套入口并存，也会继续引用本文件不再需要的 ToolResult 类型。

**10.3 删除 scriptedDecide 前的旧答案常量：**

```ts
const diagnosis = "sum([]) fails because reduce has no initial value";
```

这一项与文件顶部两个常量不相邻，容易漏掉。只删除定义，保留 scriptedDecide 和 hasDiagnosisEvidence 中对 diagnosis 的使用；它们会引用共享文件导出的同一个答案。

**10.4 将文件顶部的导入区替换为：**

<<< ../snippets/03/src/examples/diagnosis-scenario.ts#imports

现在 sourcePath、sourceCallId、sourceCode、diagnosis 都从 diagnosis-fixture.ts 取得，当前文件不再定义同名 const。导入一个名称与在当前文件声明同名 const 会发生冲突；它们即使保存相同字符串，也不是可以同时保留的两种写法。

如果已经先加了导入，出现 `Import declaration conflicts with local declaration`，回看 10.1 至 10.3，删除对应的旧定义即可。若出现 `Cannot find name 'ToolResult'`，检查 10.2 的旧 simulateReadSource 是否仍然保留，不要为旧函数重新添加导入。

**10.5 更新 scriptedDecide 的 user 分支注释。** 用下面完整分支替换原来的同一分支，功能不变，只让注释对应新的执行入口：

```ts
if (lastMessage?.role === "user") {
  // 这里只提出请求，注册查找与参数检查由执行入口安排。
  return { kind: "tool", call: createReadSourceCall() };
}
```

至此，这个文件保留两个导入和三个导出函数：createReadSourceCall、scriptedDecide、hasDiagnosisEvidence。它仍负责提出请求、依据观察提出答案和核对固定证据，不再负责实际读取。除上面明确更新的注释外，三个函数的逻辑保持原样；章末完整文件与这些修改对应。

接着补齐循环的错误兜底，并完成第 11、12 步的调用方迁移，再检查整项目。因为 simulateReadSource 已删除，尚未迁移的调用方会暂时报出导出名称不存在。

再修改 `src/runtime/agent-loop.ts`：找到调用 dependencies.executeTool 的 try/catch，**只替换 catch 中给 result 赋值的那条语句**：

```ts
result = {
  callId: action.call.id,
  status: "error",
  code: "tool-error",
  message: errorMessage(error),
};
```

这处增加 code 以满足新的 ToolResult。正常使用本章执行器时，工具异常已在入口变成错误结果；循环仍保留兜底，因为应用也可能传入另一个 executeTool 实现。其余调用身份核对、tool 消息追加、次数与退出规则都不改。

### 11. 注册工具，并交给原有循环

将 `src/examples/first-loop.ts` 的导入区替换为：

<<< ../snippets/03/src/examples/first-loop.ts#imports

将导入之后的运行部分替换为以下完整代码：

<<< ../snippets/03/src/examples/first-loop.ts#run

入口先创建注册表，再由它创建 executeTool，最后把该函数装入 Dependencies。原来传入 simulateReadSource 的位置，现在传入统一执行入口。循环的依赖签名不变，所以它不用知道工具列表，也不用理解 path。

`registry.names()` 用于显示应用当前提供了 read_source；这并没有把工具定义自动发送给模型。目前脚本自己知道工具名称，后续真实模型适配还要准备模型可见的工具说明。

末尾新增的 for 循环从最终 state.messages 中挑出 tool 消息，打印工具观察。这里看到的已是循环保存后的记录，不是执行器里尚未写回的临时返回值；成功时打印源码，错误时打印 code 和 message。最终答案与整次任务状态仍由 result.outcome 提供。

### 12. 更新上一章的观察入口

simulateReadSource 已移除，`src/examples/inspect-context.ts` 也不能继续导入它。将其顶部导入区替换为：

<<< ../snippets/03/src/examples/inspect-context.ts#imports

找到 `const call = createReadSourceCall();` 及其下一条旧读取调用，用以下三行替换：

```ts
const call = createReadSourceCall();
const executeTool = createToolExecutor(createToolRegistry([readSourceTool]));
const result = await executeTool(call);
```

后面的 state 赋值与显示代码保留。这里为手动观察入口创建同样的注册表和执行器，避免旧例子因接口迁移而失效。它仍是手动追加状态的演示，正式运行时由 agent-loop.ts 写回。

### 13. 用名称、错误参数检查统一入口

将 `src/examples/inspect-tools.ts` **整个替换**为以下最终版本：

<<< ../snippets/03/src/examples/inspect-tools.ts

四份 ToolCall 分别检查正常调用、未注册名称、数字路径和额外字段。它们各有不同 id，但相同工具可以复用同一名称。`Record<string, unknown>` 允许参数值暂时是未知类型，因此 `{ path: 42 }` 能通过 TypeScript 检查；是否符合读取规则，要由运行时 parse 判断。

for 循环每次把 item.call 交给同一 executeTool，等待后打印对应结果。`result.status === "error"` 后才访问错误专有字段。这里仍然只观察执行入口，不构造 State；下一节再观察整条反馈链。

完成本阶段所有文件修改后运行：

```bash
npm run typecheck
node src/examples/inspect-tools.ts
```

完整预期输出：

```text
已注册工具（tools）: read_source
检查场景（case）: 合法请求
[执行工具 execute] read_source 文件路径（path）=src/sum.ts
调用编号（callId）: probe-1
工具状态（status）: ok
检查场景（case）: 未知工具
调用编号（callId）: probe-2
工具状态（status）: error
错误代码（code）: unknown-tool
错误说明（message）: Unknown tool: remove_file
检查场景（case）: 路径类型错误
调用编号（callId）: probe-3
工具状态（status）: error
错误代码（code）: invalid-arguments
错误说明（message）: path must be a non-empty string
检查场景（case）: 多余参数
调用编号（callId）: probe-4
工具状态（status）: error
错误代码（code）: invalid-arguments
错误说明（message）: Unexpected argument
```

每次结果的 callId 都与对应请求一致。执行体只打印一次：未知工具在查找时返回，两个参数错误在检查时返回，它们都没有进入本例读取体。

### 迁移完成后，场景与入口各剩下什么职责

diagnosis-scenario.ts 现在只提供请求创建、脚本决策与固定完成规则；实际读取已移到 read-source-tool.ts，共享常量由 diagnosis-fixture.ts 提供。它不再导出 simulateReadSource。

first-loop.ts 则把 readSourceTool 注册，创建 executeTool，再与 scriptedDecide、hasDiagnosisEvidence 一起交给循环。inspect-tools.ts 直接调用同一执行器观察各类请求，不管理 State；inspect-context.ts 继续手动记录一次结果来比较输入。正式调度始终只有 agent-loop.ts 那一份，不会因为观察入口变多而出现多份核心。

## 接回 Runtime 后，一轮怎样走完

运行主入口，再运行上一章的观察入口确认迁移：

```bash
node src/examples/first-loop.ts
node src/examples/inspect-context.ts
```

主入口输出应为：

```text
已注册工具（tools）: read_source
[决策 decide] 消息角色（roles）=user
[执行工具 execute] read_source 文件路径（path）=src/sum.ts
[决策 decide] 消息角色（roles）=user -> assistant -> tool
运行结果（outcome）: completed
决策次数（decisions）: 2
消息顺序（messages）: user -> assistant -> tool -> assistant
最终答案（answer）: sum([]) fails because reduce has no initial value
工具观察（toolResult）: {"status":"ok","value":"export const sum = (numbers: number[]) => numbers.reduce((a, b) => a + b);","callId":"read-1"}
```

第一次 decide 仍只看到 user。提出读取动作后，循环先记录 assistant 消息，再调用新 executeTool。名称查找、参数检查、读取和结果包装都在这一次调用内部完成，返回后循环核对 callId 并追加 tool 消息。

所以第二次决策前，状态有三条消息，Context 由最新状态重新构造。脚本取得源码，提出 finish；循环记录这次动作，再交给原有完成规则核对。因此最终四条消息、两次决策。新增工具模块没有改变这条反馈顺序。

上一章观察入口仍应显示读取前只有 user，写回后为 `user -> assistant -> tool`，旧 Context 消息数仍为 1，状态决策数为 1。它调用了新的读取执行入口，但 Context 的构造与副本关系保持不变。

## 调试：分别停在检查前、执行前、写回前

可以直接让 Node 等待调试器：

```bash
node --inspect-brk src/examples/first-loop.ts
```

命令会暂停等待连接；用 VS Code 的“附加到 Node 进程”连接，或在 Chrome 的 `chrome://inspect` 找到该进程并检查。继续运行前，在下表位置设置断点；调试结束后关闭进程即可，源码无需为此修改。Node 的 inspect-brk 会在开始执行用户代码前暂停。[Node.js：调试说明](https://nodejs.org/en/learn/getting-started/debugging)

| 停在哪里 | 看什么具体值 | 要确认的问题 |
|---|---|---|
| tool-executor.ts：`registry.get(call.name)` | call.name 为 read_source，call.id 为 read-1 | 请求是否找到正确入口 |
| tool.ts：parse 返回后 | parsed 为 ok:true，value.path 为 src/sum.ts | 执行体接收的是检查产物 |
| read-source-tool.ts：执行日志处 | args.path 为字符串 | 此时已进入具体操作 |
| tool-executor.ts：返回包装结果处 | output 没有 callId，call.id 为 read-1 | 调用身份在哪里加入 |
| agent-loop.ts：校验 result.callId 处 | result 已有源码，state 还只有 user 与 assistant | 返回与保存之间有一步 |
| agent-loop.ts：写回后、下一轮输入准备处 | state.messages 有 tool，新 context 也会包含它 | 观察是否进入下一轮 |

调试时不用先看全部变量。先沿同一份 read-1 请求找到路径，再看结果在哪里被接住、在哪里写回。执行入口内部没有 state 变量是职责边界的结果：它返回事实，由循环决定如何记录。

## 故障实验：失败停在哪一层

一次只做一个实验，完成后恢复原代码，再做下一个。保持主入口的 maxDecisions 为 3。

### 实验一：数字路径怎样进入下一轮

在 `src/examples/diagnosis-scenario.ts` 的 createReadSourceCall 中，将参数改为：

```ts
arguments: { path: 42 },
```

运行类型检查和主入口：

```bash
npm run typecheck
node src/examples/first-loop.ts
```

类型检查仍能通过；运行输出为：

```text
已注册工具（tools）: read_source
[决策 decide] 消息角色（roles）=user
[决策 decide] 消息角色（roles）=user -> assistant -> tool
运行结果（outcome）: failed
决策次数（decisions）: 2
消息顺序（messages）: user -> assistant -> tool -> assistant
失败信息（failure）: decision: No usable source observation
工具观察（toolResult）: {"status":"error","code":"invalid-arguments","message":"path must be a non-empty string","callId":"read-1"}
```

没有读取执行日志，但出现了第二次 decide：工具参数被拒绝，错误结果经执行器返回，循环照样写回。脚本检查到最后的 tool 结果不是成功源码，返回 fail 动作，循环因此退出。

这里的 `invalid-arguments` 描述**这次工具调用为何失败**；`outcome.source` 为 decision，描述**整次运行最终在哪个分支退出**。二者不矛盾。新执行器返回工具错误时没有立即结束整个循环，下一轮仍有机会处理它；本例脚本选择失败，尚未实现自动纠错或重试。

恢复为 `arguments: { path: sourcePath }`。

### 实验二：检查通过，但执行体抛错

在 `src/examples/read-source-tool.ts` 的 execute 中保留日志，将 `return sourceCode;` 暂时替换为：

```ts
throw new Error("Simulated read failure");
```

运行 `node src/examples/first-loop.ts`。这次会打印读取执行日志，因为参数已通过并进入执行体；最终仍为 failed、两次决策，工具观察为：

```json
{
  "callId": "read-1",
  "status": "error",
  "code": "tool-error",
  "message": "Simulated read failure"
}
```

异常从 execute 经过 invoke 向外传播，被 tool-executor.ts 的 catch 接住。循环收到的是正常返回的错误对象，随后记录并再次决策。这与检查返回 invalid-arguments 的路径不同。

恢复 `return sourceCode;`。真实写入工具即使最终报错，也可能已经修改了一部分文件；当前包装不会撤销副作用，不能把“返回 error”理解成“什么都没发生”。

### 实验三：重复名称是启动配置错误

在 `src/examples/first-loop.ts` 中暂时将注册语句改为：

```ts
const registry = createToolRegistry([readSourceTool, readSourceTool]);
```

运行 `node src/examples/first-loop.ts`，应抛出 `Error: Duplicate tool: read_source`，进程以错误退出。这发生在进入 runAgentLoop 之前，没有任何决策日志，也没有本次运行的 ToolResult。

它不能伪装成模型请求失败，因为错误来自应用提供的注册清单。恢复为只注册一次，再运行主入口确认 completed。

## 对照 Pi：同样把准备与执行分开

本节只看固定提交 `8efd314fa3d3232ce197d8d7a6a5660530b9d83e` 的局部源码，不要求阅读整个 Pi。

Pi 的 [prepareToolCall](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/agent/src/agent-loop.ts#L660) 先按名称找工具，再校验参数；找不到工具或校验失败会准备错误结果。其 [executePreparedToolCall](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/agent/src/agent-loop.ts#L768) 使用已准备的参数进入工具体，并处理执行异常。[createToolResultMessage](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/agent/src/agent-loop.ts#L871) 将结果关联到原工具调用 ID。

对照本章，先找“查名称”“校验参数”“调用执行体”“关联身份”四个位置。共同点是检查先于实际操作，并使结果能回到对应请求。本章的泛型工厂、Map 注册表、手写解析器和三个错误代码是自己的设计；Pi 还处理钩子、并发与过程更新等问题，本篇没有实现那些能力。

## 一个小迁移：工具名称与调用身份分开看

只在 `src/examples/inspect-tools.ts` 中，把第一份合法请求的 id 从 probe-1 改为 probe-101，名称和参数保持原样，然后运行该入口。它仍应执行 read_source，结果 callId 则变成 probe-101。

这里改变的是某次调用的身份，无需重新定义或注册工具。观察后恢复 probe-1。不要修改场景里的固定 read-1；场景的完成证据当前也引用它，改变那里就不再是同一个小实验。

## 完整最终文件

以下汇总本篇新增或修改的文件，供逐份核对。第一阶段 inspect-tools.ts 的临时入口已被最终版本替换；context.ts 保持第 2 篇实现。没有新增单测。

### src/runtime/tool.ts

<<< ../snippets/03/src/runtime/tool.ts

### src/runtime/tool-registry.ts

<<< ../snippets/03/src/runtime/tool-registry.ts

### src/runtime/tool-executor.ts

<<< ../snippets/03/src/runtime/tool-executor.ts

### src/runtime/types.ts

<<< ../snippets/03/src/runtime/types.ts

### src/runtime/agent-loop.ts

<<< ../snippets/03/src/runtime/agent-loop.ts

### src/examples/diagnosis-fixture.ts

<<< ../snippets/03/src/examples/diagnosis-fixture.ts

### src/examples/read-source-tool.ts

<<< ../snippets/03/src/examples/read-source-tool.ts

### src/examples/diagnosis-scenario.ts

<<< ../snippets/03/src/examples/diagnosis-scenario.ts

### src/examples/inspect-tools.ts

<<< ../snippets/03/src/examples/inspect-tools.ts

### src/examples/first-loop.ts

<<< ../snippets/03/src/examples/first-loop.ts

### src/examples/inspect-context.ts

<<< ../snippets/03/src/examples/inspect-context.ts

## 验收与保存本章

恢复所有实验修改后运行：

```bash
npm run typecheck
node src/examples/inspect-tools.ts
node src/examples/first-loop.ts
node src/examples/inspect-context.ts
```

应看到：合法工具执行成功；未知工具、数字路径和多余参数被拒绝；主任务 completed、两次决策、四条消息；上一章 Context 观察仍成立。还能沿代码指出“实际操作前的检查”“调用身份包装”“循环写回”分别在哪个文件，说明错误观察为何仍会进入下一轮。

当前得到的是可扩展的最小工具执行链，尚无真实模型工具声明、真实文件访问、权限审批、超时取消或副作用回滚。下一篇将在现有等待位置补运行控制，不把这些逻辑塞进读取工具。

确认位于本章分支并核对改动：

```bash
git branch --show-current
git diff --stat
git status --short
```

下面仅暂存本章源码。git add 将文件放入待提交区，commit 保存本地版本，push 将该分支发送到已配置的 origin。若改动范围符合预期，且上面的检查已实际运行通过，再复制提交命令：

提交同时包含本章源码和 `site/` 网站更新；推送章节分支后，还需将 Pull Request 合并到 main，Actions 才会发布网页。

```bash
git add -- src/runtime/tool.ts src/runtime/tool-registry.ts src/runtime/tool-executor.ts src/runtime/types.ts src/runtime/agent-loop.ts src/examples/diagnosis-fixture.ts src/examples/read-source-tool.ts src/examples/diagnosis-scenario.ts src/examples/inspect-tools.ts src/examples/first-loop.ts src/examples/inspect-context.ts site/
git diff --cached --stat
git commit -F - <<'COMMIT'
第 03 篇：建立工具契约与统一执行入口

将工具参数检查、具体执行和按名称查找分开，避免在循环中积累场景逻辑。

- 新增工具定义、参数解析、注册表与执行器
- 统一包装调用身份与工具错误代码
- 迁移固定诊断场景及已有运行入口
- 保留循环对调用结果的关联检查和状态写回

验证：类型检查通过；工具检查入口区分合法请求与拒绝；主任务完成；上下文观察入口运行正常。故障实验已恢复。
COMMIT
git push -u origin codex/chapter-03-tool-execution
```

提交命令中的验证说明以你实际运行结果为准；尚有错误时先修复，不要把失败状态记录为通过。网页文件可以另行提交，不需要混入章节实现提交。
