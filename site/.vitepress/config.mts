import { defineConfig } from "vitepress";

export default defineConfig({
  lang: "zh-CN",
  title: "Agent Runtime 实战",
  description: "从零实现可观察、可恢复、受控执行的 Agent Runtime",
  base: process.env.DOCS_BASE ?? "/",
  cleanUrls: true,
  markdown: {
    snippet: { stripRegionMarkers: "all" },
  },
  head: [["meta", { name: "theme-color", content: "#172f27" }]],
  themeConfig: {
    logo: "/logo.svg",
    nav: [
      { text: "课程首页", link: "/" },
      { text: "完整路线", link: "/roadmap" },
      { text: "开始动手", link: "/guide/00-project-foundation" },
    ],
    sidebar: [
      { text: "先看全局", items: [{ text: "课程路线与验收", link: "/roadmap" }] },
      {
        text: "第一阶段 · 运行核心",
        items: [
          { text: "01 项目起点与 Runtime 架构", link: "/guide/00-project-foundation" },
          { text: "02 第一条反馈闭环", link: "/guide/01-feedback-loop" },
          { text: "03 消息、State 与 Context", link: "/guide/02-state-context" },
          { text: "04 工具契约与执行入口", link: "/guide/03-tool-execution" },
          { text: "05 停止、取消与时间边界", link: "/guide/04-run-control" },
          { text: "06 接入 DeepSeek 真实模型", link: "/guide/05-deepseek-model" },
          { text: "07 流式响应与完整动作", link: "/guide/06-streaming-response" },
          { text: "08 工具批次与有界并行", link: "/guide/07-tool-batches" },
          { text: "09 模型输入选择与预算", link: "/guide/08-context-window" },
          { text: "10 观察运行与管理实例", link: "/guide/09-run-events" },
          { text: "11 接收新输入与暂停继续", link: "/guide/10-input-pause" },
          { text: "12 会话日志与检查点", link: "/guide/11-session-checkpoints" },
          { text: "13 恢复与未知副作用", link: "/guide/12-safe-recovery" },
          { text: "14 权限、审批与执行隔离", link: "/guide/13-tool-permissions" },
          { text: "15 错误分类与安全重试", link: "/guide/14-safe-retries" },
          { text: "16 用量记账与资源预算", link: "/guide/15-resource-budgets" },
          { text: "17 完整场景与故障评估", link: "/guide/16-runtime-evaluations" },
          { text: "18 系统整合与源码复盘", link: "/guide/17-system-integration" },
        ],
      },
    ],
    search: { provider: "local" },
    outline: { level: [2, 3], label: "本页目录" },
    docFooter: { prev: "上一篇", next: "下一篇" },
    footer: { message: "用可运行的证据理解 Agent Runtime", copyright: "课程源码与章节版本以本仓库为准" },
  },
});
