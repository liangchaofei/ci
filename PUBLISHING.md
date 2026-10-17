# 课程网站发布准备

网站源码在 `site/`，静态构建命令是 `npm run site:build`。仓库的 [Pages 工作流](.github/workflows/pages.yml)仅支持手动触发（`workflow_dispatch`）；推送分支不会自动发布。

本地验证 GitHub Pages 子路径：

```bash
DOCS_BASE=/ci/ npm run site:build
```

部署前，在仓库的 **Settings → Pages** 中把构建来源设为 **GitHub Actions**，再从 Actions 页手动运行 **Publish course website**。它会把静态文件发布到该仓库的 Pages 地址。仓库名若不再是 `ci`，先同时修改工作流里的 `DOCS_BASE`；项目站点的路径前缀应与仓库名一致。

当前仅准备构建与手动部署流程，没有提交、推送或发布网站。正式公开前再检查课程内容、链接和仓库可见性。
