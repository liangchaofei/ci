---
layout: home

hero:
  name: Agent Runtime 实战
  text: 从零搭起一条能解释、能调试的运行链
  tagline: 先看全局，再动手。每章只增加一项可验证能力：模型提出动作，Runtime 受控执行，观察进入下一轮，任务有证据地结束。
  actions:
    - theme: brand
      text: 从第 00 篇开始
      link: /guide/00-project-foundation
    - theme: alt
      text: 查看完整路线
      link: /roadmap

features:
  - title: 一条贯穿的代码修复场景
    details: 用“空数组求和出错”理解读取、决策、修改建议与验证。但课程实现的是通用 Runtime，不提前写 Coding Agent 应用。
  - title: 先拿到真实运行证据
    details: 每个正式章节都给出文件路径、完整代码、运行命令、预期轨迹、失败实验和断点位置。
  - title: 对照 Pi 的同一个问题
    details: 先理解本项目的实现，再看 Pi Agent Core 如何处理消息、工具、事件和生命周期。
---

<div class="course-status">
  <strong>目前可跟做：第 00 至 12 篇</strong>
  <p>第 05 篇接入 DeepSeek 官方 API；第 06 篇实现流式接收，先离线观察分片，再接入真实模型。第 07 篇让一次决策提出多个读取，按配置顺序或有界并行执行，并在确认后整批写回。第 08 篇保留完整历史，为下一轮选择消息与摘要，并明确输入装不下的出口。第 09 篇增加可订阅的运行报告、内存轨迹和拒绝重复启动的运行实例。第 10 篇加入补充要求、接续追问与暂停后的同进程续运行。第 11 篇将每段运行结果保存为会话日志与检查点，支持新进程只读重建。第 12 篇检查已保存暂停进度、资源与当前工具清单，跨进程继续，并阻止未知执行自动重放。联网步骤需要本地密钥，第 13 篇及之后目前只有路线图。</p>
</div>

## 最终要造出的东西

一个 Runtime 运行实例接收任务和模型输入，允许模型提出工具调用，检查后执行工具，将结果关联到原调用并写入会话，再继续决策。它能流式报告过程、限制预算、响应取消、暂停等待审批、保存检查点和恢复，并让异常有明确出口。

<div class="runtime-chain">
  <div><strong>任务</strong>目标、权限范围和成功标准</div>
  <div class="arrow">↓</div>
  <div><strong>Runtime</strong>组装 Context → 请求模型 → 处理响应</div>
  <div class="arrow">↓</div>
  <div><strong>执行入口</strong>校验工具、策略和预算 → 执行 → 取得 Observation</div>
  <div class="arrow">↓</div>
  <div><strong>会话与状态</strong>记录事实和事件 → 下一轮使用最新输入</div>
  <div class="arrow">↓</div>
  <div><strong>结果</strong>有证据地完成、失败、取消、暂停或耗尽预算</div>
</div>

本课程的最终验收和各章依赖见[完整路线](/roadmap)。
