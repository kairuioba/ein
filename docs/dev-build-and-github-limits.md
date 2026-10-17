# GitHub 配额调研 + 我们的构建/发布策略

日期：2026-10-18。仓库已从 private 改为 **public**（`kairuioba/ein`），开发包改为**本地优先**。

## 为什么会出现「account payments failed」错误

GitHub Actions 对**私有仓库**按账号计划给免费额度，用完继续用就要绑支付方式/提高 spending limit；超了以后 GitHub 直接**不启动新 job**（不是构建失败，是根本不跑）。今晚为了验证反复触发 release 工作流，把私有仓库的免费分钟数用完，于是出现了该错误。

改成 **public 仓库**后：标准 GitHub-hosted runner 的 Actions 用量对 public 仓库是**免费**的（docs 原文：usage is **free** for self-hosted runners and for **public repositories** that use standard GitHub-hosted runners）。所以不会再因为分钟数扣费而停构建。

## 官方配额要点（来自 GitHub docs 仓库当前内容）

### Actions
- **Public 仓库**：标准 GitHub-hosted runner（含 Ubuntu / Windows / macOS 标准机器）用量免费。
- **Private 仓库**（免费账号）：每月 **2,000 分钟**、**500 MB artifact 存储**、**10 GB cache 存储**；超出按量计费。
- **并发**（Free 计划）：总并发 job **20**，其中 macOS 并发 **5**。
- 单 job 最长 **6 小时**；单 workflow run 最长 **35 天**；矩阵最多 256 jobs；workflow 文件 ≤500 KB。
- Artifact/缓存另有每分钟上传/下载速率限制（缓存上传 200/分钟等）。
- 参考：`content/billing/concepts/product-billing/github-actions.md`、`data/reusables/billing/actions-included-quotas.md`、`content/actions/reference/limits.md`（GitHub docs 仓库，2026-10 读取）。

### Releases（发布资产）
- 单个 release 最多 **1,000 个资产**；
- 每个文件必须 **< 2 GiB**；
- **没有总大小限制，也没有带宽限制**（docs 原文：There is no limit on the total size of a release, nor bandwidth usage）。
- 结论：上传安装包本身不产生存储/流量账单；但要避免频繁重传大文件（会消耗 Actions 产物上传/下载与时间，也可能触发滥用风控）。参考：`content/repositories/releasing-projects-on-github/about-releases.md`、`data/variables/releases.yml`、`data/variables/large_files.yml`。

## 我们的策略（按老板要求，立即生效）

1. **开发包本地优先**：
   - 日常 dev 验证一律本地构建（`pnpm build && pnpm build:server && pnpm build:updater && pnpm exec electron-builder --mac --publish never`，前置 native 资源用 `pnpm build:cloudflared / build:cua / build:speech / build:recorder / build:android-tools`）；
   - 构建产物留在 `release/`，安装到本机验证；
   - **不再自动上传 dev 包到 GitHub Releases**。需要上传时由老板明确说，或只在大版本/对外测试时上传。
2. **GitHub Actions 只用于**：
   - 代码验证（typecheck / i18n / lint / vitest / vite build）和正式版构建发布；
   - 不为“看一眼效果”反复触发 release 工作流。
3. **正式版发布前**：先本地全量测试 + 手装验证，再用 Actions 打正式 tag 并发布；发布后检查 feed 与安装包 hash。
4. **配额自查**：GitHub → Settings → Billing and plans 查看 Actions 用量；公开仓库正常情况下不需要付款方式。
5. **避免滥用**：同一改动最多一次远端构建；不要把大文件反复重传到 dev release；保留最近 2 个 dev 包资产即可（旧的可清理）。

## 重新启用远端 dev 上传的流程（等老板发话）

1. 本地构建并自测通过；
2. 确认 `git status` 干净、版本号正确；
3. 只上传当前版本 arm64/x64 的 dmg/zip/blockmap + latest-mac.yml（不要重传历史版本）；
4. 上传后校验 4 个安装包 URL 均 HTTP 200，且 feed 版本与产物一致；
5. 在 `docs/collab` 记录时间、版本、原因。
