---
title: 第 00 篇｜项目起点与 Runtime 架构
description: 先看清要造出的系统，再建立能检查类型、运行行为和网页教程的 TypeScript 工程。
---

# 第 00 篇：先看清 Runtime，再把工程搭稳

本系列不要求已有 Agent 知识，但需要能阅读基础函数、对象和数组，并在终端运行命令。Agent（智能体）在这里是一种借助模型选择下一步、执行操作并根据结果继续推进目标的程序；Runtime（运行时）负责管理它的执行过程。模型接收信息并提出候选动作，工具则是程序提供的具体能力，例如读取文件的函数。下面用一个代码问题说明这些部分怎样合作。

## 读完这篇，你会得到什么

- **要解决的问题：** 将来模型提出“读取文件”时，谁安排执行、保存结果、判断能否结束？先分清这些责任，后续才能逐步实现。
- **要理解的知识：** 应用、Runtime、模型和工具怎样合作；为什么程序能运行，不等于类型正确或行为正确。
- **要动手完成的内容：** 搭建 Node.js + TypeScript 工程，运行检查，并通过故障实验区分类型检查失败与运行断言失败。
- **在整个项目中的位置：** 本篇建立工程起点与职责地图；下一篇才开始写智能体循环（Agent Loop），把决策与执行连接起来。

读完后，应能说明各部分管什么，并知道检查失败时先看哪里。本篇不实现模型调用或 Runtime 核心，也不要求预先建立一套类层次。

## 本篇推荐分支

推荐分支名：`codex/chapter-00-project-foundation`。

在准备好学习本系列的仓库中，从当前工程起点创建分支：

```bash
git switch -c codex/chapter-00-project-foundation
```

命令会以当前版本为起点创建并切换分支。完成本篇配置与验证后，将工程起点提交到该分支；第 01 篇从这份完成版本继续。

## 先从一件代码修复任务看全局

设想用户要求：“`sum(numbers)` 在空数组时抛错，请修复并确认测试通过。” 一个 Coding Agent 应用会提供代码任务的规则和工具，但底层 Runtime 要负责调度每一轮：

```text
用户目标：修复 sum([])
    ↓
应用提供：可访问工作区、读/改/测工具、完成标准
    ↓
Runtime 建立本次运行的独立状态
    ↓
从最新状态准备模型输入 → 模型提出下一步
    ↓
Runtime 检查权限、参数、预算 → 调用工具
    ↓
工具返回实际观察 → Runtime 关联调用并记录事实
    ↓
再用更新后的事实请求模型，或者验证后结束
```

第一次模型提出“读 `src/sum.ts`”只是一个**动作请求**。文件内容来自受控读取工具，是**观察**。Runtime 把观察写回状态，第二次决策才能知道源码使用了没有初始值的 `reduce()`。若忘了写回，模型得到的还是旧输入，可能不断重复读取。若模型直接回答“已经修好”，但没有修改记录和测试证据，Runtime 不能把它判为成功。

这就是本课程始终追踪的主干：**目标 → 决策 → 受控执行 → 观察 → 更新 → 再决策或结束**。以后每加一个模块，都要指出它改变了这条链的哪一段。

### Runtime、应用和模型各管什么

| 参与者 | 负责什么 | 不应越过的边界 |
|---|---|---|
| 应用 | 给目标、工具、权限范围和成功标准 | 不复制另一套循环 |
| Runtime | 管状态、模型调用、工具调度、事件、停止与恢复 | 不写死 `sum()` 的业务逻辑 |
| 模型 | 根据可见信息提出下一步和回复 | 提议不是执行授权，也不是成功证据 |
| 工具执行入口 | 校验并执行外部动作，返回事实 | 拒绝的动作不能到达实际执行器 |
| 会话存储 | 记录已经发生的事实和恢复依据 | 日志不能凭空证明未知副作用没有发生 |

用 Coding Agent 的场景举例，是为了让“读文件、改文件、跑测试”容易想象。本阶段实现的是**通用 Runtime**；将来换成工单处理或资料核查，Runtime 的循环和记录规则应仍然成立。

### “企业级架构”在第一天意味着什么

它不意味着先建几十个类。我们先确定不能轻易破坏的边界：每次运行独立状态；模型调用和工具调用可替换；所有外部副作用经过一个受控入口；退出原因明确；事件能解释过程；恢复时不能盲目重放未知写操作。具体权限、持久化和隔离会在相应章节实现并测试，不能因为架构图里写了这些词就宣称已具备。

Pi 的 [Agent Core 说明](https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/agent/README.md)将有状态 Agent、低层循环、工具执行和事件分开描述。我们借鉴这类职责划分；本章只建立工程环境，下一篇真正有了循环后再对照 Pi 的局部源码。当前链接固定到提交 `8efd314`，避免上游更新改变阅读对象。

## 本篇实际文件与顺序

从空目录复现时，先有配置，再有测试。这里列的是**实现工程**相关文件；网页站点不参与 Runtime 源码运行。

```text
agent-runtime-lab/
├── package.json                 npm 命令和开发依赖
├── package-lock.json            npm 生成的精确依赖树
├── tsconfig.json                类型检查规则
├── .gitignore                   不提交依赖与生成物
├── src/runtime/                 下一篇开始写 Runtime 核心
└── test/
    └── environment.test.ts      确认 TypeScript 测试与取消信号可运行
```

`src/runtime/` 现在是空目录。仓库使用 `.gitkeep` 保存它；这不是 Runtime 代码。**不要先创建 `Agent` 类或引入现成 Agent 框架。** 先让下一篇的具体问题决定接口。

## 第一步：确认运行环境

在项目根目录运行：

```bash
node --version
npm --version
```

本项目要求 Node.js **22.18.0 或更新版本**。Node 在这个版本范围内可以直接运行本教程使用的可移除类型语法；它执行 `.ts` 文件时不会替你判断类型关系，所以仍需 TypeScript 编译器。具体支持范围见 [Node.js 官方 TypeScript 文档](https://nodejs.org/api/typescript.html)。版本低于要求时先升级环境，不要通过混用另一个运行器掩盖问题。

## 第二步：理解并核对工程配置

项目中的 `package.json` 完整内容是：

```json
{
  "name": "agent-runtime-lab",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22.18.0"
  },
  "scripts": {
    "test": "node --test test/*.test.ts",
    "typecheck": "tsc --noEmit",
    "check": "npm run typecheck && npm test",
    "site:dev": "vitepress dev site",
    "site:build": "vitepress build site",
    "site:preview": "vitepress preview site"
  },
  "devDependencies": {
    "@types/node": "22.20.5",
    "typescript": "7.0.2",
    "vitepress": "2.0.0-alpha.20"
  }
}
```

`private` 防止误发到 npm。`type: module` 让源码用 `import` / `export`。`node --test test/*.test.ts` 使用 Node 自带测试器，并只运行项目根目录的测试；网页里的参考代码不会提前算作已经实现。`tsc --noEmit` 只检查类型、不生成 JavaScript；`check` 用 `&&` 串起两者，因此类型检查失败时测试不会开始。`site:*` 只服务教程网站，不参与 Runtime 执行。固定依赖版本是为了让教程命令与验证环境一致；锁文件由 npm 生成，不手写。

`tsconfig.json` 完整内容是：

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

`NodeNext` 让 TypeScript 按 Node 模块规则理解导入；以后本地导入会写完整 `.ts` 扩展名。`strict` 帮助提前发现接口不匹配。`erasableSyntaxOnly` 限制使用 Node 原生类型移除无法处理的语法。`include` 只检查要运行的源码与测试，网页的构建由 `site:build` 单独负责。

## 第三步：运行一条与 Runtime 有关的环境测试

`test/environment.test.ts` 的完整内容是：

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

test("Node runs TypeScript tests and exposes cancellation signals", () => {
  const controller = new AbortController();
  controller.abort();
  const cancelled: boolean = controller.signal.aborted;
  assert.equal(cancelled, true);
});
```

`AbortController` 以后会向模型和工具传递取消请求。本篇只证明 Node 环境能创建它、发出取消并读到 `signal.aborted`；**它没有证明 Runtime 已经能取消挂起操作**。`cancelled: boolean` 留下一处真实的 TypeScript 类型标注，让类型检查和运行测试在故障实验里有不同表现。

如果从仓库检出项目，锁文件已经存在，安装依赖使用：

```bash
npm ci --ignore-scripts
```

如果手动从空目录创建配置和测试，第一次安装使用 `npm install --ignore-scripts` 生成 `package-lock.json`，之后其他机器再使用 `npm ci --ignore-scripts`。`--ignore-scripts` 避免安装时执行依赖提供的脚本；本篇依赖不需要这些脚本来验证工程。

现在运行：

```bash
npm run check
```

预期是先出现 `typecheck` 阶段且没有 TypeScript 错误，再出现 `test` 阶段，最后统计 **1 个测试通过、0 个失败**。耗时与 npm 输出细节因机器而异，不必逐字相同。若只见类型错误、完全没有测试输出，应先调查类型检查，而不是改测试断言。

### 回看这些文件怎样组成工程检查

package.json 保存“用什么命令检查”，tsconfig.json 保存“按什么类型规则检查”，environment.test.ts 保存“运行后要确认什么行为”。三者通过下面的命令链连接，不会仅因文件存在就自动执行：

```text
npm run check
  → 读取 package.json 中的 check 脚本
  → tsc 按 tsconfig.json 检查 src/ 与 test/
  → 类型检查通过后，Node 运行 environment.test.ts 中的断言
```

这套工程检查返回命令成功或失败，尚未创建任务 State，也没有 Agent Loop。后续新增源码时沿用这个起点；不要把“取消信号环境测试通过”理解成已经实现运行取消。

## 第四步：亲手区分两类失败

这两个实验每次只改一处，观察后立即恢复。不要在真实仓库中留下故意错误。

**实验 A：类型关系错误，但运行断言仍成立。** 暂时把测试中的 `const cancelled: boolean` 改成 `const cancelled: number`。分别运行：

```bash
npm run typecheck
npm test
```

第一条应报告“boolean 不能赋给 number”一类错误；第二条仍可通过，因为 Node 运行时去掉类型标注，`cancelled` 实际仍是 `true`。恢复 `boolean`。

**实验 B：类型正确，但行为断言失败。** 暂时把 `assert.equal(cancelled, true)` 改成 `assert.equal(cancelled, false)`。`npm run typecheck` 应通过，`npm test` 应失败，并显示实际值与期望值的差异。恢复 `true`。

从下一篇开始，一处错误可能是“工具没有执行”，也可能是“执行了但结果没有进入下一轮”。先判断故障发生在哪个检查阶段，能避免靠改期望值掩盖问题。

## 调试与本篇验收

排查顺序是：先确认在仓库根目录、Node 版本满足下限、依赖已安装；再单独运行 `npm run typecheck` 和 `npm test`。类型错误看文件与行号，断言错误看 actual/expected。需要单步观察时运行：

```bash
node --inspect-brk --test --test-concurrency=1 test/environment.test.ts
```

调试器附加后，在 `assert.equal` 一行设断点，观察 `controller.signal.aborted` 和 `cancelled` 都是 `true`。`--inspect-brk` 会等你连接并继续；等待时不产生测试结果是正常的。调试结束后停止进程，再运行完整检查。

本篇完成的工程证据是 `npm run check` 通过，以及两个故障实验都能产生预期的不同失败。这个证据只说明工程地基可靠。下一篇才会定义任务状态、模型替身、工具观察和反馈循环，让第二次决策真正看到第一次执行的结果。

## 保存本篇版本并推送到 GitHub

恢复故障实验中的临时改动，在仓库根目录检查工程、网页构建和 Git 状态：

```bash
npm run check
npm run site:build
git branch --show-current
git status --short
git remote -v
```

当前分支应是 `codex/chapter-00-project-foundation`，`origin` 应指向自己的 GitHub 仓库。第 00 篇保存整个工程起点，包含工程配置、环境检查和仓库已有的课程网页；若是在旧仓库上开始，旧实现的删除也属于这次起点变更。确认状态列表都是准备保存的工程改动后，复制执行：

```bash
git add -A -- .
git commit -F - <<'COMMIT'
第 00 篇：初始化智能体运行时工程

建立系列实现的工程起点，为后续逐步编写运行时核心做准备。

- 配置 Node.js、TypeScript、类型检查和环境检查命令
- 准备课程网页与手动发布流程
- 保留空白运行时目录，核心实现从第 01 篇开始

验证：npm run check 与 npm run site:build 通过。
COMMIT
git push -u origin codex/chapter-00-project-foundation
```

`git add -A -- .` 把当前目录中的新增、修改和删除放入暂存区，也就是本次准备提交的文件集合。`git commit` 将它们保存为本地版本。提交信息第一行是简短标题，空行之后是详细正文，说明目的、具体改动与验证；验证记录应与自己的实际运行结果一致。

`-F -` 让 Git 从标准输入读取提交信息，`<<'COMMIT'` 到独占一行的 `COMMIT` 之间就是多行正文。复制时保留这两个标记，结束标记不要缩进。`git push` 再把分支推送到 GitHub；`-u` 建立本地与远程分支的关联，以后在同一分支继续提交后可以直接用 `git push`。

若使用了其他分支名，相应修改 push 命令最后的名字。推送分支只保存仓库内容，不会触发本项目需要手动运行的网站发布流程。
