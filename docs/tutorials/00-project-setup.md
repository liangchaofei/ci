# 第 0 篇：明确 Agent 架构，让 TypeScript 项目可靠地跑起来

这一篇不会写 Agent。我们先解决一个看似枯燥、后面却很关键的问题：**当你写完一段 Agent 代码，怎样知道它真的能运行，而不只是编辑器没有画红线？**

如果没有稳定的测试入口，后面讲“工具结果怎样更新 State”“预算用完为什么停止”时，很容易变成看代码猜行为。所以先搭一个很小的项目：一个源码文件、一个测试文件、一次类型检查。它们跑通后，第 1 篇再加入真正的 Agent Loop。

本文展示第 0 篇的工程配置与代码。后续章节会逐步扩展源码，按本文复现时，应使用本篇列出的文件内容。

本篇代码分支：`chapter/00-project-setup`。在 GitHub 切换到该分支可以查看对应源码；后续章节使用各自的章节分支。复现时也可以使用章节 PR 中记录的提交 SHA，避免后续修改影响结果。

## 读完能做到什么

- 能说明 Agent Runtime 与 Coding Agent 的职责，以及企业约束在哪一层执行。
- 理解手动搭建工程、类与函数组合、依赖注入这些设计选择。
- 知道 Node.js 在这个项目里做什么，TypeScript 编译器又做什么。
- 能解释 `src/` 与 `test/` 的分工。
- 能在新机器上安装依赖，运行测试和类型检查。
- 能看懂一次故意失败的测试，并修到通过。

## 先明确我们要实现什么

最终目标是一个可复用的 Agent Runtime，以及基于它完成代码任务的 Coding Agent。Runtime 负责驱动任务：维护状态、请求决策、调度受控动作、接收执行结果、更新状态，并决定继续、暂停或结束。Coding Agent 则把“读代码、修改代码、验证修改”组织成具体应用。未来换成其他任务应用时，通用运行机制应能复用。

我们自己实现这些关键控制逻辑；模型 API、Git 等通用基础设施通过适配器接入。先用可预测的假模型验证运行机制，之后再接真实模型。知识检索（RAG）、外部能力协议（MCP）和多 Agent 协作，会在任务确实需要时加入。浏览器操作和语音 Agent 不在本项目范围内。

### 实现顺序：Runtime → 可复用框架 → Coding Agent

先实现 Runtime，验证一项任务的决策、执行、观察、状态更新与停止机制。再从已经验证的核心中提炼模型与工具契约、配置、组合入口和扩展接口，形成可复用框架。最后基于框架实现 Coding Agent 的代码读取、修改、测试与交付门禁。

框架包含 Runtime，不需要另写一套循环。前期可以用模拟代码任务说明场景，但完整 Coding Agent 在框架基础上实现。企业约束从 Runtime 起设计，相关能力接入时就落实。


### 系统分层与职责

下面是目标架构。本篇只建立工程环境，图中的 Agent 模块将在后续章节实现。

```text
调用入口（后续先提供本地命令入口）
    ↓ 提交目标、工作区与运行配置
Coding Agent 应用
    ↓ 组合任务规则、代码工具与验证标准
Agent Runtime
    ├── 运行实例：持有任务状态，管理开始、取消、暂停、恢复
    ├── Agent Loop：决策 → 动作 → 观察 → 更新 → 继续或结束
    ├── 模型接口 → 假模型 / 真实模型适配器
    ├── 受控工具执行入口 → 文件 / 命令 / 后续外部工具适配器
    └── 事件与检查点接口 → 运行记录 / 后续持久化适配器

企业约束贯穿运行与执行：身份与权限、任务隔离、预算、审计、验证门禁
```

“适配器”负责把外部系统的数据和调用方式转换成内部约定。Runtime 依赖我们定义的模型接口，不直接绑定某个厂商的 SDK；工具执行也通过明确入口完成。这样测试能注入假模型和假工具，生产接入可以替换外部实现，而无需重写循环。

| 模块 | 持有或处理什么 | 必须守住的边界 |
|---|---|---|
| 调用入口 | 用户请求与配置 | 不承担循环决策和工具执行逻辑 |
| Coding Agent | 代码任务规则、工作区与验收标准 | 不自行复制一套 Runtime |
| Runtime 运行实例 | 一项任务的 State、生命周期与运行依赖 | 不在多个任务之间共享可变任务状态 |
| Agent Loop | 每一轮的决策和执行顺序 | 模型提出动作后，仍需经过执行约束 |
| 模型适配器 | 模型请求、响应和协议转换 | 模型响应是建议，不是授权或成功证据 |
| 工具执行入口 | 参数校验、权限检查、超时与结果转换 | 拒绝的操作不能到达真实执行器 |
| 运行记录与检查点 | 发生的事件、恢复需要的状态 | 日志不等于可恢复检查点；恢复不能盲目重放写入 |

State 是任务当前事实，例如已经读到的文件版本、最近一次测试结果和剩余预算。Context 是本轮交给模型的信息视图，可能只包含 State 的一部分。Observation 是动作实际产生的结果，例如文件内容、执行失败或测试输出。模型看到什么与程序掌握什么必须区分，后续章节会具体设计这些数据。

### 用一次代码修复串起系统

设想用户要求：“修复某个函数的空数组处理，并确保测试通过。”以下是未来行为示例，第 0 篇不能运行它。

1. 入口接收目标和指定工作区。Coding Agent 建立验收标准：目标行为正确、相关测试通过、交付补丁与验证时的版本一致。
2. Runtime 创建独立任务状态，模型根据当前信息提出读取文件的动作。
3. 工具执行入口校验路径和权限，执行读取，把内容及文件版本作为 Observation 返回。
4. Runtime 更新 State，再请求决策。模型提出修改，执行入口在权限允许时应用补丁，记录新的工作区版本。
5. Agent 请求测试。测试结果连同对应补丁版本进入 State；失败时进入有界的修正流程。
6. 应用验收规则核对同一补丁的验证证据。条件满足后才允许成功结束，并交付修改说明。

反例：模型回复“已经修好了”，但是没有修改记录、测试失败，或者测试后文件又被改动。此时不能标为成功。另一个反例是读取路径逃出指定工作区：执行入口必须在读文件之前拒绝，并将拒绝结果返回 Runtime。企业约束要改变真实控制流，不能只放在提示词里。

### 从起点按企业级要求设计

企业级设计在这里意味着责任明确、行为可验证、外部能力可替换，以及异常有清楚的处理路线。完整生产能力还需要部署、安全与容量验证，不能由一张架构图证明。

| 约束 | 从第一版开始的设计要求 | 后续落地与验证 |
|---|---|---|
| 任务隔离 | 每次运行独立持有状态，不使用全局可变任务对象 | 验证两项任务不会读写对方的状态；真实文件和进程隔离在工具阶段实现 |
| 权限与审批 | 外部副作用必须经过受控执行入口 | 接入真实读写前落实路径与权限限制；未获批准的写入不能执行 |
| 预算与取消 | 循环必须有明确上限，并设计取消信号传递 | 在最小循环阶段限制轮数，逐步加入时间、调用成本和工具取消测试 |
| 结构化失败 | 区分成功、失败、拒绝与取消 | 错误结果不能伪装成成功；只对适合重试的失败重试 |
| 审计与恢复 | 设计可观察事件与独立检查点接口 | 先观察运行轨迹，再加入持久化、恢复及副作用重放限制 |
| 成功门禁 | 成功由实际证据和任务标准决定 | Coding Agent 验证测试结果属于当前补丁，不能使用过期证据 |

真实工具接入前使用模拟执行验证控制流；接入真实工具时，相关约束必须同时实现。后续治理章节会完善这些能力，前面的代码应遵守已经确定的边界。

### 手动搭建，还是用脚手架

本项目选择**手动搭建 Node.js + TypeScript 工程**，先使用一个包组织源码和测试。我们需要理解 Runtime 的控制机制，当前没有 Web 服务或前端需求，直接配置运行、类型检查和测试入口即可。脚手架是帮助生成初始目录与配置的工具，它本身不保证权限、隔离或可靠性。

现在不会一次性创建所有规划目录，也不会引入完整 Agent 框架来代替核心实现。每个模块在对应章节有真实职责时才建立。以后如果确实需要多个独立发布的包，再考虑拆包；现阶段通过代码依赖方向守住层次。

### 面向对象怎样用，参考 Pi 的哪些部分

采用**类、函数和接口组合**，主要使用组合与依赖注入。

- 类适合管理运行实例：同一项任务的状态、订阅者和取消控制属于一个生命周期，封装在对象中便于管理。
- 函数适合表达循环步骤与状态更新：显式接收输入与依赖，返回结果或发出事件，便于构造测试。循环函数仍可能执行异步动作，不应把它误认为全部是纯函数。
- 接口定义模型、工具、事件记录和检查点的契约；依赖注入就是由调用方把具体实现传入，例如测试传入假模型，实际运行传入真实模型。
- 优先组合这些能力，避免让不同任务应用通过多层继承绑定在一起。一个简单函数能承担的职责，不需要仅为套用设计模式而创建类。

Pi 的 [`agent.ts`](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent.ts) 用 `Agent` 类包装状态与生命周期；[`agent-loop.ts`](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts) 提供底层循环函数；[`types.ts`](https://github.com/earendil-works/pi/blob/main/packages/agent/src/types.ts) 定义状态、事件和工具契约。我们参考这种责任分离，再根据本项目的权限、验证与恢复要求确定接口。Pi 是设计参考，首阶段不是运行依赖；本项目也不宣称完整复制其能力。

### 本篇的实现范围

本篇包含工程配置、一个导出项目名称的源码文件和对应测试，用于验证运行与类型检查入口。下一篇实现假模型驱动的最小闭环，通过运行轨迹验证决策、动作、观察与状态更新之间的关系。

## 1. 本篇的实际文件

在仓库根目录 `ci/` 下，本篇会用到这些文件：

```text
ci/
├── package.json
├── package-lock.json
├── tsconfig.json
├── .gitignore
├── src/
│   └── project-info.ts
└── test/
    └── project-setup.test.ts
```

`src/` 放要运行的项目代码；`test/` 放验证行为的测试。`package-lock.json` 是 npm 根据依赖生成的锁文件，不需要手写，但应该与 `package.json` 一起保存，确保别人安装到同一组依赖。

## 2. 确认 Node.js

在仓库根目录执行：

```bash
node --version
npm --version
```

本项目要求 Node.js **22.18.0 或更新版本**。原因不是追新：这一版起，Node 默认能去掉 `.ts` 文件里的类型标注并执行它。我们因此可以先用 Node 自带的测试器，不额外安装一个测试框架。本文编写时验证环境是 Node.js 25.9.0；你看到的补丁版本号可以不同，只要满足下限即可。Node 的这种运行方式只会移除类型，**不会替你检查类型是否写对**，因此还要单独运行 TypeScript 编译器。相关限制见 [Node.js TypeScript 文档](https://nodejs.org/download/release/v22.23.3/docs/api/typescript.html)。

如果 `node --version` 显示更早的版本，先升级 Node。不要为了绕过环境问题而在后续代码里混用多种运行器。

## 3. 写项目配置

在根目录创建 `package.json`：

```json
{
  "name": "ci-agent-harness",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22.18.0"
  },
  "scripts": {
    "test": "node --test",
    "typecheck": "tsc --noEmit",
    "check": "npm run typecheck && npm test"
  },
  "devDependencies": {
    "@types/node": "22.20.5",
    "typescript": "7.0.2"
  }
}
```

几个字段值得停一下：

- `private: true` 防止把这个学习项目意外发布到 npm。
- `type: module` 让 `.ts` 文件采用 `import` / `export` 风格。之后导入本地文件时会写明 `.ts` 扩展名，这是 Node 直接运行 TypeScript 时的要求。
- `test` 使用 Node 自带测试器；`typecheck` 检查类型但不生成 JavaScript；`check` 把两项串起来，任何一步失败，整条命令就失败。
- `devDependencies` 只在开发时使用。`typescript` 负责检查类型，`@types/node` 给编辑器和编译器提供 Node API 的类型说明。没有添加模型 SDK 或 Agent 框架，保持第 0 篇的目标单纯。

接着创建 `tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

这里不是让 TypeScript 帮我们“编译后再运行”。`noEmit: true` 表示只检查、不产出文件。`NodeNext` 使 TypeScript 按 Node 的模块规则理解导入；`allowImportingTsExtensions` 允许写 `./file.ts`；`erasableSyntaxOnly` 提醒我们不要使用 Node 的轻量类型移除无法运行的语法，例如需要转换的 `enum`。`strict` 则让潜在的类型问题尽量早暴露。`include` 限定只检查源码和测试，不把文档或依赖目录混进来。

创建 `.gitignore`：

```gitignore
node_modules/
dist/
coverage/
.env
.env.*
!.env.example
```

依赖可以用锁文件重新安装，所以不提交 `node_modules/`。`.env` 往往包含密钥，默认不应进仓库；未来若需要说明环境变量，可以放不含真实密钥的 `.env.example`。

## 4. 先写一个会失败的测试

创建 `test/project-setup.test.ts`：

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { projectName } from "../src/project-info.ts";

test("Node can import and test our TypeScript source", () => {
  // 用真实的类型标注，验证 Node 能直接运行 .ts 测试文件。
  const actual: string = projectName;
  assert.equal(actual, "CI Agent Harness");
});
```

如果从空目录搭建，这里暂时**不要**创建 `src/project-info.ts`。如果使用本仓库已有脚手架，该文件已经存在，可以直接验证通过路径；不要为复现此步骤删除现有文件，故障练习见文末。先运行：

```bash
node --test test/project-setup.test.ts
```

源码文件尚不存在时，测试应失败，并包含 `ERR_MODULE_NOT_FOUND` 或“找不到 `src/project-info.ts`”的提示。这是刻意制造的失败：测试明确要求一个源码文件，而那个文件还不存在。它证明测试确实会在缺少实现时报警。如果使用已有脚手架，则应看到测试通过。

测试里用了 `node:test` 定义用例，用 `node:assert/strict` 比较实际值和期望值。本地导入写成 `../src/project-info.ts`，把扩展名写全；Node 不会自动猜测你要导入哪个 `.ts` 文件。`actual: string` 则确保测试文件本身包含真实的 TypeScript 类型语法。那条注释解释的是本篇测试的**意图**，不是复述下一行代码。

## 5. 再补最小源码

创建 `src/project-info.ts`：

```ts
export const projectName = "CI Agent Harness";
```

这个文件只是让我们验证跨文件导入和测试入口。它不是 Agent 的 State，也不是未来框架的配置模块；后面不会为了迁就这个示例去设计 Runtime。

现在安装依赖：

```bash
npm install --ignore-scripts
```

安装会生成 `package-lock.json`。之后从已经保存了锁文件的仓库重新开始时，使用下面的命令更合适：

```bash
npm ci --ignore-scripts
```

`npm ci` 会按锁文件重建依赖，适合其他读者或 CI 环境。这里加 `--ignore-scripts`，因为本篇所需的两个开发依赖不需要安装脚本；减少不必要的安装时副作用。

运行完整检查：

```bash
npm run check
```

这条命令先运行 `tsc --noEmit`，再运行 `node --test`。本篇应该看到类型检查成功、测试 `Node can import and test our TypeScript source` 通过，并且最终统计为 **1 个测试通过、0 个失败**。运行时长和输出格式可能因 Node 版本不同而不同，不必逐字一致。

## 6. 两种检查不能互相替代

容易产生一个误会：测试通过了，是不是就不需要类型检查？不是。

- Node 运行 `.ts` 时会移除类型标注，但不判断 `string`、`number` 是否写对。
- `tsc --noEmit` 能发现类型问题，但不会替你执行测试断言。
- 所以 `npm run check` 同时做两件事：类型层面能否成立，运行时行为是否符合预期。

后面 Agent 会有更多状态和工具结果类型。类型检查能防止一部分数据契约错误；测试则要验证“超时后不能假装成功”“权限拒绝后不能继续写文件”这类真实行为。两个都需要。

## 7. 自己检查一次故障

可以暂时把 `src/project-info.ts` 里的名字改成别的值，再运行 `npm test`。类型检查仍可能通过，但断言会失败：类型正确不等于行为正确。把名字改回 `CI Agent Harness`，重新运行 `npm run check`，确认回到 1 个测试通过。

若遇到不同的报错，先按下面的顺序排查：

| 现象 | 优先检查 |
|---|---|
| Node 不认识 `.ts` 文件 | `node --version` 是否达到 22.18.0 |
| `ERR_MODULE_NOT_FOUND` | 文件是否存在，导入路径和 `.ts` 扩展名是否正确 |
| 找不到 `tsc` 或 Node 类型 | 是否在仓库根目录运行过 `npm install --ignore-scripts` |
| `tsc` 报类型错误，但测试可以运行 | 先读类型错误所在文件和行；Node 执行不等于类型通过 |
| 测试断言失败 | 看 `actual` 与期望值差在哪里，别急着改期望值掩盖错误 |

## 8. 本篇结束的位置

到这里我们只验证了项目地基：Node 能执行 TypeScript 文件，TypeScript 编译器能检查类型，测试能识别缺少实现或行为错误。**本篇不包含模型调用、工具、State 或 Agent Loop。** 下一篇将实现假模型驱动的最小 Agent 闭环。假模型的结果可预测，便于测试循环行为；循环验证后再接真实模型。

对应的 Pi 参考暂时只有方向，不要求现在阅读源码：Pi 的 [Agent Core](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md)把运行循环和上层 Coding Agent 分开。第 1 篇实现我们自己的循环后，再挑它的一个局部函数对照。

## 9. 调试与验证

本节用于独立验证工程环境。故障练习是按顺序进行的可选实验，每次只改一处，完成后恢复原值；它们不是 Agent 核心实现。

### 运行并定位失败

在终端进入自己的 `ci` 项目目录，再执行完整检查：

```bash
npm run check
```

正常情况下，先完成类型检查，再看到 1 个测试通过、0 个失败。若完整检查失败，分开运行以定位问题：

```bash
npm run typecheck
npm test
```

类型检查报错看文件、行号与类型关系；测试报错看断言位置、实际值（actual）与期望值（expected）。`check` 使用 `&&` 串联，类型检查失败时不会继续运行测试，因此没有测试输出不等于测试器坏了。

### 用断点查看真实值

如果使用支持 Node 调试的编辑器，可以通过检查器调试单个测试：

```bash
node --inspect-brk --test --test-concurrency=1 test/project-setup.test.ts
```

将编辑器的 Node 调试器附加到命令输出提示的检查器端口，在测试文件的 `assert.equal` 行设置断点，再继续执行。命令使用 `--inspect-brk`，会等待调试器连接并继续；等待期间没有测试结果是正常的。断点处查看 `projectName` 和 `actual`，两者都应为 `CI Agent Harness`，再单步执行断言。没有调试器时，先使用断言输出完成本篇验证即可。调试结束后停止该进程，日常检查仍使用 `npm run check`。

### 故障一：类型正确，行为错误

临时将 `src/project-info.ts` 的字符串改为 `Wrong Name`。运行 `npm run typecheck` 应通过；运行 `npm test` 应失败，断言显示实际名称与期望名称不同。检查导出值和断言，不要通过修改期望值掩盖错误。恢复原字符串，再运行完整检查。

### 故障二：能执行，类型不成立

在 `test/project-setup.test.ts` 中，仅将 `const actual: string = projectName;` 的类型标注 `string` 临时改为 `number`，其余内容不变。运行 `npm test` 应仍通过：Node 移除类型标注后，实际值依然是正确字符串。运行 `npm run typecheck` 应失败：字符串不能赋给声明为数字的变量。恢复 `string`，重新运行 `npm run check`。

这两个实验分别证明测试与类型检查在验证不同问题。后续 Agent 中，“工具参数类型成立”和“工具执行结果满足任务要求”也需要分别检查。

### 验证完成的标准

恢复故障实验中的修改后，运行 `npm run check`，类型检查通过，测试统计为 1 项通过、0 项失败。

如果检查失败，先根据输出判断问题发生在文件导入、类型检查还是测试断言，再定位对应文件和行号。
