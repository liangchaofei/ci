---
title: 第 02 篇｜从运行状态准备本轮输入
description: 区分 State 与 Context，独立实现输入构造模块，让每次决策收到最新消息，而不是整份运行状态。
---

# 第 02 篇：程序保存什么，决策方看到什么

第 1 篇已经能完成一次模拟诊断：提出读取请求，执行读取，保存源码，再提出答案。本篇继续使用这些代码，不重写循环，也不接入真实模型。

## 读完这篇，你会得到什么

- **要解决的问题：** 程序保存了工具结果，为什么本轮决策仍可能收到旧信息？怎样避免把运行管理字段也整份传过去？
- **要理解的知识：** 程序持有的运行状态（State）与本轮决策输入（Context）有什么区别；复制数据、选择字段和准备最新输入分别解决什么问题。
- **要动手完成的内容：** 新建 context.ts 准备消息输入，先观察读取前后的两份 Context，再将它接回原有循环。
- **在整个 Runtime 中的位置：** 本篇补上“状态更新之后、请求决策之前”的输入准备步骤，为后续真实模型适配建立边界。

完成后，应能分别定位“结果没保存”和“结果保存了但没有用于本轮输入”这两类错误。本篇仍使用第 1 篇的模拟诊断，不接入真实模型，也暂不做消息裁剪与摘要。

需要回看第 1 篇时，先找工具结果追加到 state.messages 和下一次调用 decide 的两处位置；本篇的新模块连接这两处。正文会解释所需知识，外部链接供查证。

## 本篇推荐分支

推荐分支名：`codex/chapter-02-state-context`。从第 1 篇已验证并提交的本地版本创建：

```bash
git switch -c codex/chapter-02-state-context
```

若分支已存在，用 `git switch codex/chapter-02-state-context` 返回。网页修改可以另行提交，本章实现依赖的是第 1 篇的四个源码文件。下面命令都在仓库根目录执行。

## 先把 Runtime 放回整条运行链

用户提出“找出空数组求和为什么失败”，模型不会因为应用收到了这句话，就自动读到磁盘、记住工具结果、维护次数限制。需要程序把这些步骤接起来。本系列把组织这段运行过程的程序称为 Runtime。

先看当前几个模块怎样协作。绿色框是 Runtime 持有的职责，右侧函数由场景提供，底部灰色条列的是后续能力：

[![第 2 篇当前架构：应用传入目标和依赖，Runtime 持有状态并准备输入，场景函数提供具体能力](/diagrams/runtime-responsibilities.svg)](/diagrams/runtime-responsibilities.svg)

点击图片可单独打开查看。

模型负责依据收到的信息提出下一步；工具负责实际读取、查询等操作；Runtime 负责把它们按明确规则组织起来。第 1 篇的脚本暂时代替模型，读取函数也返回固定源码，但调用、记录与退出已经由真实代码完成。

完整 Runtime 的其他部分以后会接入这条链：

| 部分 | 负责的问题 | 当前进度 |
|---|---|---|
| 循环与运行状态 | 谁安排下一步，执行结果保存在哪里，何时结束 | 第 1 篇已实现最小版本 |
| 输入准备 | 从当前状态取哪些信息交给本轮决策 | 本篇实现 |
| 模型适配 | 怎样把内部数据变成模型接口请求 | 后续接入真实模型 |
| 工具执行入口 | 怎样找到工具、检查参数并关联结果 | 目前是一个模拟读取函数，后续扩展 |
| 运行控制 | 等待太久或用户取消时怎样退出 | 后续实现 |
| 事件与会话存储 | 怎样观察过程，进程结束后怎样恢复 | 后续实现 |

这些部分不是几套独立 Agent。它们围绕同一次任务协作，后续章节会逐步接入。现在不用背完整架构，先抓住这一条关系：**Runtime 保存最新记录，再用这些记录准备下一轮输入。**

## 为什么不继续把 State 整个传过去

第 1 篇调用 decide 时传入状态副本。这样可以演示反馈，但这个参数同时包含了两类信息：

| State 中的信息 | 谁需要它 | 本篇怎样处理 |
|---|---|---|
| 用户目标 | 决策方需要知道要解决什么 | 保留在第一条 user 消息中 |
| 之前提出的动作 | 决策方需要知道已经请求过什么 | 保留在 assistant 消息中 |
| 工具结果 | 决策方需要知道实际取得什么 | 保留在 tool 消息中 |
| decisions | Runtime 用它检查还能否继续决策 | 不放进本轮输入的顶层字段 |

如果决策器直接读取 decisions，它就和循环内部计数耦合了。以后循环新增运行编号、等待状态或其他管理字段，也容易被整份带过去。为避免这种依赖，本篇建立一个独立的输入类型，并明确选择交出的字段。

在本项目中，**State（运行状态）**是 Runtime 持有的本次运行信息；**Context（上下文）**是为本轮决策准备的信息。后者不是另一份永久状态，也不会自动跟随 State 更新。

Anthropic 对上下文的讨论关注模型本次生成时可用的信息，并强调在多轮过程中持续准备这些信息。本篇先实现其中很小的一步：明确构造消息输入；还不做长会话裁剪、摘要或用量计算。[来源：Anthropic《Effective context engineering for AI agents》](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

这里的 DecisionContext 是本教程内部类型，当前只含消息。它还不是某家模型 API 的请求对象，消息中的 Action、ToolResult 也暂时保留内部形状。真实模型接入时，再增加相应协议转换。

## 先认出数据，再看它怎样流动

[![State 与 Context 数据流：消息复制为本轮输入，决策返回动作，循环记录动作与工具结果，Context 本身不写回 State](/diagrams/state-context-ownership.svg)](/diagrams/state-context-ownership.svg)

点击图片可单独打开查看。

先看箭头：蓝线将输入交给决策方并带回动作，绿线由循环把动作或工具结果记入状态。下一轮再次走上方的消息复制箭头；没有“把 Context 保存回 State”的步骤。图中工具路径只在动作是 tool 时进入，完成和失败出口见前一篇。

下面是这次诊断中从代码实际构造出的数据快照，只用于看清对象，不是要追加到文件的实现代码。

**第一次决策前，Runtime 持有的 state 是：**

```json
{
  "goal": "Diagnose why sum([]) fails",
  "messages": [
    {
      "role": "user",
      "content": "Diagnose why sum([]) fails"
    }
  ],
  "decisions": 0
}
```

这里的 goal 是本次目标，messages 是已经记录的交流，decisions 是循环计数。此时还没有工具结果。

**从它构造出的 context 是：**

```json
{
  "messages": [
    {
      "role": "user",
      "content": "Diagnose why sum([]) fails"
    }
  ]
}
```

context 是一个只有 messages 的普通对象，不是文件路径、聊天界面或模型的某种隐藏记忆。目标文字仍在 user 消息中，所以没有顶层 goal 字段不等于模型失去目标。

### 同一个概念在代码里有几种名字

| 名称 | 它是什么 | 在本章起什么作用 |
|---|---|---|
| DecisionContext | 类型定义 | 约定输入应有什么形状，不会自己创建或保存数据 |
| buildDecisionContext | 函数 | 从给定 State 复制消息并返回输入对象 |
| context | 循环中的局部变量 | 指向这一次返回的输入对象，随后传给 decide |
| context.ts | 源码文件 | 保存上述函数的代码，不是用来存放会话数据的文件 |

firstContext、secondContext 也是变量名，观察入口用它们保留两次构造结果来比较。它们不是要写进 State 的两个字段。

### 哪些数据保存，哪些只供这次调用使用

| 数据 | 谁创建或取得 | 谁保存、怎样继续使用 |
|---|---|---|
| state | 集成运行时由 runAgentLoop 初始化；观察入口中手动初始化 | 循环更新它，结束时通过 RunResult 交回入口 |
| context | buildDecisionContext 从当前 state 生成 | 本轮交给 decide；下一轮从最新 state 重新构造，不写入 State |
| action | decide 返回 | 循环先取得它，再包装为 assistant 消息追加到 state.messages |
| 工具 result | executeTool 返回 | 循环确认调用身份后，包装为 tool 消息追加到 state.messages |
| outcome | 循环在退出时生成 | 与最终 state 并列返回，入口据此显示退出原因 |

这里的“保存”先指保存在运行中的 JavaScript 对象里，不是已经落盘。会话文件和进程重启后的恢复还没有实现。

因此，本篇不是 State → Context → 再把 Context 塞回 State。它走的是：**从 State 准备输入 → decide 返回动作 → 记录动作 → 必要时执行工具并记录结果 → 再从新 State 准备输入。**

## 本章会改哪些文件

| 文件 | 操作 | 为什么需要 |
|---|---|---|
| `src/runtime/types.ts` | 新增 DecisionContext，修改 decide 参数类型 | 分开运行状态和决策输入 |
| `src/runtime/context.ts` | 新建 | 独立负责从状态准备输入 |
| `src/examples/inspect-context.ts` | 新建 | 先观察读取前后输入怎样改变 |
| `src/examples/diagnosis-scenario.ts` | 修改导入和 scriptedDecide | 决策器只使用 Context |
| `src/runtime/agent-loop.ts` | 新增导入，修改决策调用处 | 每轮从最新 State 构造 Context |
| `src/examples/first-loop.ts` | 保留第 1 篇最终版本 | 继续作为集成入口，不需要重写 |

context.ts 不发请求、不执行工具、不更新运行状态，只准备输入。输入规则有自己的变化原因，因此单独成模块；循环调用它即可，不需要逐渐把所有处理都写进 agent-loop.ts。

本篇分两阶段。先单独观察 Context，得到一个可运行结果；再修改决策接口，把它接回原有循环。暂不新增单测或依赖。

## 阶段 1：先看到两份不同的 Context

### 1.1 定义本轮决策输入

在 `src/runtime/types.ts` 的 State 类型之后、Outcome 类型之前，追加：

<<< @/snippets/02/src/runtime/types.ts#context{ts:line-numbers} [src/runtime/types.ts · 新增类型]

它只有 messages。目标并没有丢失，因为第 1 篇已经把目标放进首条 user 消息；此前的请求与源码也分别在 assistant、tool 消息里。

本篇复用已有 Message 类型，是因为消息内容暂时没有转换，只需要把 State 的控制字段与输入分开。以后要改变消息格式时，再在明确的边界转换，不必现在复制一套内容相同的消息类型。

两处 readonly 分别约束 messages 属性重新赋值和数组的直接增删，帮助类型检查发现误操作；嵌套消息对象并不会因此深度冻结。数据独立性要由下一步复制保证。[来源：TypeScript 的 readonly 属性与数组](https://www.typescriptlang.org/docs/handbook/2/objects.html#readonly-properties)

此时先保留原有 Dependencies，尚不修改 decide。这样新增输入模块时，原来的入口仍然能检查和运行。

### 1.2 新建输入准备模块

创建 `src/runtime/context.ts`，写入下面的完整模块：

<<< @/snippets/02/src/runtime/context.ts{ts:line-numbers} [src/runtime/context.ts]

调用方传入最新 state，函数只取 state.messages，复制后装进新的对象。返回对象的顶层只有 messages，decisions 仍留在 Runtime；goal 字段不再重复交出，但目标文字仍在用户消息里。

这里有两个不同动作：明确写出 messages，是选择交出哪些字段；structuredClone 则使消息副本不与 State 共享嵌套对象。只复制整份 State 不能减少字段，只挑出原消息引用又不能保护留存数据。

本章消息包含字符串、数组和普通对象，可以这样复制。[Node.js 的 structuredClone 文档](https://nodejs.org/download/release/v22.18.0/docs/api/globals.html#structuredclonevalue-options)说明了这个 API。若以后状态中出现函数或资源句柄，不能假定整份数据都能复制。

这个 return 只是把新对象交回调用处。调用处要用变量接住它，再作为参数传给 decide；这里没有给 state 增加 context 字段，也没有改写 state.messages。工具结果仍须由循环先写回，之后调用本函数，才能进入下一份输入。

### 1.3 写一个只观察输入的入口

创建 `src/examples/inspect-context.ts`，先写导入和展示函数：

<<< @/snippets/02/src/examples/inspect-context.ts#imports{ts:line-numbers} [src/examples/inspect-context.ts · 导入]

<<< @/snippets/02/src/examples/inspect-context.ts#display{ts:line-numbers} [src/examples/inspect-context.ts · 展示函数]

showContext 只负责打印：当前观察时刻、输入对象有哪些顶层字段、消息按什么顺序排列。若最后一条是成功工具结果，再打印源码，便于确认不只是有 tool 这个角色，也确实带着内容。

Object.keys 读取对象实际存在的顶层字段，join 将字段名称连成文字。下面故障实验会利用它检查：类型声明之外，运行中究竟传出了哪些数据。

在同一文件末尾追加初始化代码：

<<< @/snippets/02/src/examples/inspect-context.ts#initial{ts:line-numbers} [src/examples/inspect-context.ts · 读取前]

此时 State 只有目标和 0 次决策，构造出的 firstContext 只有一条 user 消息。保存它，是为了稍后对比“旧输入”和“更新后重新准备的输入”。

继续在文件末尾追加：

<<< @/snippets/02/src/examples/inspect-context.ts#feedback{ts:line-numbers} [src/examples/inspect-context.ts · 读取后]

这里复用第 1 篇的请求创建和模拟读取。工具返回后，手动将请求与结果按先后顺序放入 State，记为一次决策，再构造 secondContext。这段代码只用来观察数据变化，不是另写一套 Runtime。

执行完成后，同一条反馈在两处以不同用途存在：state.messages 保存运行记录，secondContext.messages 是为本次查看复制的消息。第二份 Context 的具体内容是：

```json
{
  "messages": [
    {
      "role": "user",
      "content": "Diagnose why sum([]) fails"
    },
    {
      "role": "assistant",
      "action": {
        "kind": "tool",
        "call": {
          "id": "read-1",
          "name": "read_source",
          "arguments": {
            "path": "src/sum.ts"
          }
        }
      }
    },
    {
      "role": "tool",
      "result": {
        "callId": "read-1",
        "status": "ok",
        "value": "export const sum = (numbers: number[]) => numbers.reduce((a, b) => a + b);"
      }
    }
  ]
}
```

第二、三条分别是读取请求和执行结果：assistant.action.call 说明请求了什么，tool.result.value 才是实际返回的源码。它们不能互相替代。

firstContext 仍只有最初那条消息。state 赋新值不会通知或自动修改已经复制出来的对象；只有重新调用 buildDecisionContext，才产生上面这份含源码的新输入。

现在已有完整可运行入口：

```bash
npm run typecheck
node src/examples/inspect-context.ts
```

预期输出：

```text
观察时刻（stage）: 读取前
上下文字段（keys）: messages
消息顺序（messages）: user
[执行工具 execute] read_source 文件路径（path）=src/sum.ts
观察时刻（stage）: 读取并写回后
上下文字段（keys）: messages
消息顺序（messages）: user -> assistant -> tool
读取源码（source）: export const sum = (numbers: number[]) => numbers.reduce((a, b) => a + b);
旧上下文消息数（oldMessages）: 1
状态中的决策次数（decisions）: 1
```

两次 keys 都只有 messages；源码只出现在第二次准备的输入里。最后一行说明 State 仍保留控制计数，倒数第二行说明旧 Context 没有被后续更新悄悄改动。

## 阶段 2：把输入准备接回原来的循环

接下来是一次接口迁移：Dependencies、脚本决策器和循环调用处要一起更新。完成这三处前，类型检查可能指出参数不匹配；先按顺序修改，最后统一检查。执行器、完成规则和工具结果写回逻辑都保留。

### 2.1 改变 decide 的输入约定

在 `src/runtime/types.ts` 中，将原有 Dependencies 类型整段替换为：

<<< @/snippets/02/src/runtime/types.ts#dependencies{ts:line-numbers} [src/runtime/types.ts · 替换 Dependencies]

改动集中在 decide：以前接收 State，现在接收 DecisionContext。循环仍持有 State，只是决策方不再依赖它的全部字段。

executeTool 继续接收请求；validateFinish 继续接收状态与候选答案。完成规则由应用核对留存证据，不必为了和决策器参数相同而一并修改。不同职责可以拥有不同输入。

### 2.2 让脚本只读取 Context

将 `src/examples/diagnosis-scenario.ts` 顶部类型导入替换为：

<<< @/snippets/02/src/examples/diagnosis-scenario.ts#imports{ts:line-numbers} [src/examples/diagnosis-scenario.ts · 替换导入]

DecisionContext 是决策器的新参数类型；State 仍供文件末尾的完成规则使用，因此保留。

找到从 `const diagnosis = ...` 开始、到 scriptedDecide 函数结束的整段，将这段常量与函数一起替换为下面的代码。请求创建、执行器和完成规则保持原样：

<<< @/snippets/02/src/examples/diagnosis-scenario.ts#decision{ts:line-numbers} [src/examples/diagnosis-scenario.ts · 替换决策部分]

第一次 context.messages 仍只有 user，因此请求读取；第二次含成功的源码结果，因此提出 finish。分支依据与第 1 篇相同，变化的是信息入口：不再从整份 State 取消息，而从本轮 Context 取消息。

日志去掉了原先通过 state.decisions 计算的序号。脚本不该为了打印序号继续索要 Runtime 控制字段；当前通过消息角色观察输入即可，最终次数仍由集成入口从返回状态中打印。以后统一事件与轨迹会提供更合适的运行标识。

这次改动没有让脚本变聪明，固定源码比较和预设答案仍然存在。我们检查的是输入边界和反馈是否保持正确。

### 2.3 在每次调用前构造输入

在 `src/runtime/agent-loop.ts` 顶部现有导入之前新增：

```ts
import { buildDecisionContext } from "./context.ts";
```

循环从独立模块导入准备函数，不在文件里再写一遍消息选择逻辑。

在 runAgentLoop 的 while 内，找到从 `let action: Action` 开始、到记录 assistant 消息之前的决策 try/catch，将这一段替换为：

```ts
let action: Action;
try {
  // 每轮都重新构造，才能包含上一轮刚写回的工具结果。
  const context = buildDecisionContext(state);
  action = structuredClone(await dependencies.decide(context));
} catch (error) {
  return { state, outcome: failure(errorMessage(error), "decision") };
}
```

先看本例的正常路径。第一次循环用初始 State 构造 Context，交给脚本，拿到读取请求。工具执行、写回后，循环再次来到这里，**用更新后的 state 重新构造**，于是第二次输入含有源码。

这里的数据流对应两条具体语句：`const context = buildDecisionContext(state)` 只给局部变量赋值；`dependencies.decide(context)` 只把这个对象作为函数参数传入。它们都没有写 state。

真正更新状态的地方仍在下方：决策返回后追加 assistant 消息，工具返回后追加 tool 消息。Context 不需要再存进 State，因为它能从已有消息重新生成；本篇没有新增 `state.context`。

关键是构造位置在 while 内、decide 之前。若只在进入循环前准备一次，State 虽然更新，后面的决策仍只拿到旧输入。第 1 篇解决“结果有没有保存”，本篇进一步保证“保存后的结果有没有用于本次输入”。

buildDecisionContext 已经复制消息，所以这里不再把整份 snapshot(state) 传给 decide。返回动作仍复制后再留存，防止外部函数后续修改同一对象。完成规则处的 snapshot(state) 保留，那是另一条状态访问路径。

本项目暂将输入准备、决策调用和返回动作复制都归在 decision 阶段。任一操作在这个 try 中抛错，会返回该阶段失败；不要因此认定错误一定来自模型服务。

### 2.4 继续运行第 1 篇的集成入口

`src/examples/first-loop.ts` 的函数组装方式不变，不用修改。runAgentLoop 仍接收目标、依赖和次数上限，内部调用决策方时才使用新 Context。

```bash
npm run typecheck
node src/examples/first-loop.ts
```

预期输出：

```text
[决策 decide] 消息角色（roles）=user
[执行工具 execute] read_source 文件路径（path）=src/sum.ts
[决策 decide] 消息角色（roles）=user -> assistant -> tool
运行结果（outcome）: completed
决策次数（decisions）: 2
消息顺序（messages）: user -> assistant -> tool -> assistant
最终答案（answer）: sum([]) fails because reduce has no initial value
```

外部结果仍是两次决策后完成，说明接口迁移保留了反馈行为。新增职责没有改变请求、执行与写回的先后顺序，只在调用前明确准备了输入。

## 怎样调试这条新边界

用集成入口启动调试器：

```bash
node --inspect-brk=127.0.0.1:9229 src/examples/first-loop.ts
```

按第 1 篇的方法在 Chrome 的 `chrome://inspect` 连接 Node 进程。以下断点先按正常路径观察，不用同时追踪全部异常分支。

| 断点 | 观察什么 | 本例应看到什么 |
|---|---|---|
| buildDecisionContext 的 return | state.messages、state.decisions | 第一次一条消息和 0，第二次三条消息和 1 |
| 循环中的 decide 调用行 | context 与 state | context 顶层只有 messages，state 仍有 goal 和 decisions |
| scriptedDecide 的 lastMessage 赋值之后 | context.messages 的最后一条 | 第一次 user，第二次带源码的 tool |
| 调用完成规则之前 | state.messages | 已有第四条 finish 对应的 assistant 消息 |

第二次 decide 收到三条消息，而完成规则看到四条，原因是 finish 在决策返回后才被记录。不要把这两个时刻的输入混为一份。

也可以先调试 inspect-context.ts，在 secondContext 构造完成后同时展开 firstContext、secondContext 和 state。旧输入仍是一条消息，最新状态与新输入都有三条，这是判断是否错误复用旧 Context 的直接方法。调试入口与操作方法参考 [Node.js 官方调试说明](https://nodejs.org/en/learn/getting-started/debugging)。

## 两个故障实验

每次只改一处，观察后恢复。实验都针对本章边界，不新增单测。

### 实验一：类型变窄，是否就自动少传字段

在 `src/runtime/context.ts` 中，把唯一的 return 临时替换为：

```ts
return structuredClone(state);
```

运行：

```bash
npm run typecheck
node src/examples/inspect-context.ts
```

本篇这份代码的类型检查仍会通过，但两处字段日志变为：

```text
上下文字段（keys）: goal, messages, decisions
```

为什么返回类型写了 DecisionContext，实际还有其他字段？TypeScript 允许拥有所需结构的对象被用于这个位置；类型检查不会在运行时删除额外属性。整份 State 本来就有 messages，因此能满足这里的结构要求。[来源：TypeScript 的结构类型兼容规则](https://www.typescriptlang.org/docs/handbook/type-compatibility.html)

要控制实际交出的顶层字段，必须构造只含 messages 的新对象。这不是靠换个类型名完成的。

恢复：

```ts
return { messages: structuredClone(state.messages) };
```

重新运行观察入口，确认 keys 回到 messages。本例只选择顶层字段，没有清洗消息内容；若消息里已经写入敏感文字或不应提供的信息，它们仍会被带入，不能将此函数当成完整安全过滤器。

### 实验二：State 更新了，为什么决策还在重复读取

在 `src/runtime/agent-loop.ts` 中，紧接 state 初始化之后、while 之前，临时增加：

```ts
const cachedContext = buildDecisionContext(state);
```

再把 while 内原来的 `const context = buildDecisionContext(state);` 替换为：

```ts
const context = cachedContext;
```

运行集成入口，会看到脚本连续三次只收到 user，并重复请求读取。末尾结果为：

```text
运行结果（outcome）: budget-exhausted
决策次数（decisions）: 3
消息顺序（messages）: user -> assistant -> tool -> assistant -> tool -> assistant -> tool
```

循环确实保存了每次执行结果，所以最终 State 有七条消息；但 cachedContext 始终来自初始 State，决策方一直没有得到后来的源码。增加次数只会重复这个错误，不会让旧副本自行更新。

先删除 while 前新增的 cachedContext，再把循环内恢复为每轮调用 buildDecisionContext(state)。重新检查并运行，应该回到两次决策后 completed。本章仍是固定调用身份的模拟场景；故障中重复读取不是多调用身份生成方案。

## 换一个目标，检查职责是否分清

在 `src/examples/inspect-context.ts` 中，临时把 goal 改成“解释为什么空数组求和会抛错”。在第一次 showContext 之前加一行日志：

```ts
console.log(`目标消息（user）: ${firstContext.messages[0]?.role === "user" ? firstContext.messages[0].content : "未找到"}`);
```

运行后，中文目标应出现在 user 消息中，而 Context 顶层仍只有 messages。不要为支持这个目标修改 context.ts；它处理通用消息，不认识 sum 的业务含义。观察后移除这行日志，恢复原目标，再回到章末基准版本。

## 对照 Pi：调用模型前准备输入

固定提交 `8efd314` 的 Pi Agent Core 在 streamAssistantResponse 中先取得当前消息，可选地运行 transformContext，再用 convertToLlm 转为模型可理解的消息，之后才发起模型调用。[来源：Pi 的输入准备位置](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/agent/src/agent-loop.ts#L350)

只看这两个问题：输入转换在每次请求前的什么位置？它读的是当前消息还是初始化时的一份旧消息？再对照本篇 while 内 buildDecisionContext 的位置。

Pi 的类型说明还要求将内部消息转换为模型兼容格式，不可转换的界面通知等消息应被过滤。本章尚未加入这些内部消息，也没有实现模型协议转换，只建立“从当前状态准备本轮输入”的边界。[来源：Pi 的 convertToLlm 与 transformContext 约定](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/agent/src/types.ts#L178)

不要把名称一一套用：Pi 的 AgentContext 还参与它自己的运行组织，并不等于本篇仅含消息的 DecisionContext。我们比较的是调用位置和责任划分，类型名称与最小字段由本项目选择。

## 本篇完成后，系统多了什么

沿本章的数据表与两个快照，可以找到每次输入的来源和消息写回的位置。Context 是可重新构造的输入；State 是继续推进任务所需的运行记录，两者在本实现中没有相互嵌套。

现在分别能定位两类问题：State 里根本没有工具结果，调查执行后的写回；State 已有结果但 Context 没有，调查输入构造的位置和字段选择。后续工具注册、模型适配、事件与存储都会沿各自职责加入这条运行链，不需要每次从零重写循环。

本篇没有新增模型能力，也没有完成摘要、裁剪或权限隔离。下一篇会处理另一条边界：决策方提出工具请求后，程序怎样找到对应工具、检查输入，再进入执行。

## 完整文件：用于核对

下面五个文件是本章新增或修改后的最终内容；与正文小步骤来自同一份参考实现。first-loop.ts 沿用第 1 篇最终版本。不要把阶段 1 的旧 Dependencies 或旧 scriptedDecide 混入最终版本。

### `src/runtime/types.ts`

<<< @/snippets/02/src/runtime/types.ts{ts:line-numbers} [src/runtime/types.ts]

### `src/runtime/context.ts`

<<< @/snippets/02/src/runtime/context.ts{ts:line-numbers} [src/runtime/context.ts]

### `src/runtime/agent-loop.ts`

<<< @/snippets/02/src/runtime/agent-loop.ts{ts:line-numbers} [src/runtime/agent-loop.ts]

### `src/examples/diagnosis-scenario.ts`

<<< @/snippets/02/src/examples/diagnosis-scenario.ts{ts:line-numbers} [src/examples/diagnosis-scenario.ts]

### `src/examples/inspect-context.ts`

<<< @/snippets/02/src/examples/inspect-context.ts{ts:line-numbers} [src/examples/inspect-context.ts]

## 保存本篇版本并推送

先恢复故障实验与迁移练习，再检查：

```bash
npm run typecheck
node src/examples/inspect-context.ts
node src/examples/first-loop.ts
git branch --show-current
git status --short
git diff --cached --stat
```

观察入口应只交出 messages，集成入口应在两次决策后 completed。当前分支应是 codex/chapter-02-state-context；确认暂存区没有之前遗留的其他内容。已有环境检查仍可用 `npm run check` 运行，但它不是本篇行为验证的替代。

以下命令只暂存本章五个源码文件。中文提交说明中的验证描述，应与你实际完成的检查一致：

```bash
git add src/runtime/types.ts src/runtime/context.ts src/runtime/agent-loop.ts src/examples/diagnosis-scenario.ts src/examples/inspect-context.ts
git commit -F - <<'COMMIT'
第 02 篇：分离运行状态与决策上下文

在每次决策前从最新状态构造输入，
保留目标、动作和工具结果，将控制计数留在运行时。

- 新增决策上下文类型与独立的输入构造模块
- 调整脚本决策器和循环调用处，按轮准备消息副本
- 增加上下文观察入口，展示读取前后的信息变化

验证：类型检查与两个入口运行通过；复现整份状态传出和旧上下文复用故障。
COMMIT
git push -u origin codex/chapter-02-state-context
```

git add 选择这次要保存的改动，git commit 生成本地版本，git push 首次上传并关联该分支。保留独占一行的 COMMIT 结束标记；网页改动按文档变更另行提交。遇到推送连接错误，先调查 Git 连接，不能靠重新写 Runtime 代码解决。

## 知识依据

本章核对于 2026 年 10 月 17 日。正文已在相关位置给出出处：Anthropic 的文章用于解释上下文准备，Pi 固定版本用于比较模型调用边界，TypeScript 与 Node.js 官方文档用于核对类型和复制机制。State、DecisionContext 的命名、字段和异常策略属于本教程设计，不代表所有 Runtime 的统一接口。
