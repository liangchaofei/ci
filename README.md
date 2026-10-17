# Agent Runtime Lab

从零实现一个可观察、可恢复、受控执行工具的 Agent Runtime。项目只实现 Runtime；Coding Agent 用作说明运行机制的场景，不在本阶段作为应用开发。

课程网页源码位于 [`site/`](site/index.md)。新系列从空白 Runtime 开始，旧实现保留在原来的 Git 分支中。学习者按教程逐章写入 `src/`；项目配置和网站脚手架已准备好。

## 本地开始

要求 Node.js 22.18.0 或更新版本。在仓库根目录执行：

```bash
npm ci --ignore-scripts
npm run check
npm run site:dev
```

`check` 先做类型检查，再运行测试。`site:dev` 输出本地网页地址。网页发布到 GitHub Pages 前，先运行 `npm run site:build` 验证静态构建。

课程路线与最终验收见 [课程路线](site/roadmap.md)。尚未编写的章节只列在路线图中，不作为可跟做教程。
