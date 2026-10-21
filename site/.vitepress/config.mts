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
          { text: "00 项目起点与 Runtime 架构", link: "/guide/00-project-foundation" },
          { text: "01 第一条反馈闭环", link: "/guide/01-feedback-loop" },
          { text: "02 消息、State 与 Context", link: "/guide/02-state-context" },
          { text: "03 工具契约与执行入口", link: "/guide/03-tool-execution" },
          { text: "04 停止、取消与时间边界", link: "/guide/04-run-control" },
          { text: "05 接入 DeepSeek 真实模型", link: "/guide/05-deepseek-model" },
          { text: "06 流式响应与完整动作", link: "/guide/06-streaming-response" },
          { text: "07 工具批次与有界并行", link: "/guide/07-tool-batches" },
          { text: "08 模型输入选择与预算", link: "/guide/08-context-window" },
          { text: "09 观察运行与管理实例", link: "/guide/09-run-events" },
          { text: "10 接收新输入与暂停继续", link: "/guide/10-input-pause" },
        ],
      },
    ],
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: "https://github.com/liangchaofei/ci" }],
    outline: { level: [2, 3], label: "本页目录" },
    docFooter: { prev: "上一篇", next: "下一篇" },
    footer: { message: "用可运行的证据理解 Agent Runtime", copyright: "课程源码与章节版本以本仓库为准" },
  },
});
