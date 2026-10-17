# 2026-10-18 夜谈落地总结（Claude × Ein）

目标：与 Claude 讨论到 4:30，逐个细节讨论并落地。本文件是给下一次会话/老板的交接摘要。

## 已落地（分支 feat/1.1.4，全部推送）

### 任务式工作台
- 任务窗口 = 一个对话；新任务 `POST /api/tasks` 一次事务创建窗口 + 任务文件夹；
- 派单 run 自动挂到预建窗口的文件夹；
- 已完成/已取消任务的窗口只读（`closedAt`），发消息返回 `409 TASK_CLOSED + canFork`；
- 已完成窗口的输入框替换为只读条 + 「基于此新建」；
- 「基于此新建」`POST /api/tasks/:id/fork`：新窗口、引用源任务有界经验、`clientRequestId` 幂等、不复制聊天记录、返回可编辑草稿；
- 侧栏任务列表：进行中 / 已完成折叠、needs-you 角标、点击打开任务窗口；
- 新任务不把总控设为负责人（总控在任务之上，负责人由 run 的部门 lead 接任）。

### 验收闸门 v1
- 结构化 criteria（id/text/required/kind/check），旧 acceptance 单向映射；
- 确定性检查由代码跑：result / handoff / artifacts / placeholders；
- 代码聚合裁决 pass/fail/needs_human，模型自评不是裁决；
- 缺 handoff → needs_human（不是 fail）；synthetic handoff 永不 pass；缺 artifact → unverifiable；
- 打回 = `rework`：新 attempt + 老板原话进 worker prompt；上限 3 次；
- 通过 gate_failed = 记录 owner override；signoff approve 写 folder.acceptedAt。

### 需要你（收件箱）
- `GET /api/inbox`（按任务分组、signoff 置顶）/ `seen` / `resolve`（防重复执行、expectedAttemptId 防过期）；
- UI：侧栏入口 + 面板，一句人话 + 证据 + 通过，继续 / 打回，重做 / 稍后；
- signoff 会写明「还有 N 个子任务待你确认」。

### 上下文与长任务
- context share：≤3 源、≤1500 tokens、同部门、只来自 gate-clean 已完成任务、append-only 审计；
- worker prompt 只读围栏注入 + 审计（sourceTaskIds/tokens/textHash）；
- attempt 幂等：currentAttemptId/bootId、过期结果丢弃、重启恢复；
- StateDoc Tier 0：`GET /api/task-folders/:id/state` 代码生成事实 + 漂移标记；
- worker 默认 cwd = 各自 workspace（artifact 路径可解析）。

## 验证证据
- 本地全量：3504 passed / 19 skipped；typecheck / i18n / lint / vite build 全绿；
- dev.22 真机：任务侧栏、新建任务、fork 幂等、收件箱通过写 acceptedAt、真实派单 3 子任务约 150s 完成、409 保护；
- dev.26 真机：已完成窗口只读条 + 基于此新建点通；真实收件箱侧栏可见；
- 测试数据已清理，总控 autoApprove 已恢复关闭。

## 与 Claude 的关键共识
- LLM 只提供证据，代码是唯一裁决者；
- fail 只表示「验证过且不对」，「无法验证」必须是 needs_human；
- 收件箱合并由后端分组投影、前端渲染，角标由后端算；
- ReviewerPort 用独立一次性会话、无工具、严格 JSON、quote 校验、失败转 needs_human、每子任务最多 1 次；本版不做；
- 手机上「通过/打回」必须带宾语和后果，不做系统推送（局域网非安全上下文）。

## 下一版 backlog
1. ReviewerPort（独立一次性会话，只出证据）；
2. 补信封一次性重试（不守格式的模型）；
3. 收件箱同因合并的完整交互（一次「已知悉」处理多条）；
4. 任务负责人权限模型 + 跨部门派单边界；
5. StateDoc Tier 0 的窗口置顶卡片与对表 routine；
6. 长任务实测（老板本人跑一次跨天任务）。
