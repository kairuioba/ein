# 工作台 v2 审计（项目内协同办公）

- 审计日期：2026-10-18（凌晨）
- **范围（重要更正）**：老板说的「工作台」= **一个项目里面的 AI 协同办公场景**，不是 app 首页/侧栏/决策栈。本文以「打开一个项目后能看到什么、缺什么」为主线；app 级改造审计压缩为 §5 背景。
- 对象：`/Users/kairuiwang/ein-work/next`，基准 commit `c8f28a1`（本地 app 运行于 `127.0.0.1:8799`）。对照设计：`docs/collab/2026-10-17T17-43-project-office.md`（下称「项目办公文档」）。
- 方法：只读源码 + 对运行中服务做只读 curl 实测；未修改任何代码、未写入 app 数据、未 git 提交；唯一写入文件是本文件。
- 结论先说：**服务端已经有"协同事实"的绝大部分数据（subtask 状态/依赖/Handoff/闸门、task-folder 的 departments/memberCount/progress、StateDoc、retro、按 taskId 分组的 inbox），但项目内的 UI 几乎不消费它们**。老板打开项目现在只能看到「一段对话 + 偶尔一张派单卡」；「谁在等谁、谁在评审、卡在哪、团队分工」都还不可见。真正的协同视图其实有一半已经做在**全局工作台页**里，但**从项目窗口进不去**。

---

## 0. 一句话结论

1. **项目内的"执行事实"齐了，投影几乎没有**：`TaskFolderView` 计算了 `progress/memberCount/departments/leadName`（`server/index.ts:2255-2272`、`shared/task-folders.ts:60-72`），但前端只有 `leadName` 被渲染（`TaskFolderList.tsx:91`），`progress/memberCount/departments` **零消费者**（grep `src/` 无命中）。
2. **项目内目前只有"对话"**：打开任务 = 打开某个 bot 的会话窗口；只有总控/主管会话、且 run 从该会话发起时，才会渲染派单卡（`ChatView.tsx:83, 655, 884-900`）。worker/lead 的会话、部门结构、评审状态、Handoff 内容都不在项目视图里。
3. **协同主屏其实已经存在，只是"不在项目里"**：全局工作台页已经支持"选一个任务 → 只看该 run 的成员"（`WorkbenchPage.tsx:41-101`），看人/看事 + 派单列表（`TreeDrawer.tsx:590` 的 `RunList`，含依赖与失败原因 `DispatchBoard.tsx:161-191`）。但任务窗口的「N running」按钮只是跳到全局工作台、**不带任务上下文**（`ChatHeader.tsx:109-113` → `store.tsx:555,812` 的 `showTeamMap` 无参数）。
4. **4 小时最值的三件事**：项目窗口顶部「此刻」协作条（等待链）+ 项目团队栏（固定状态词）+ 项目级「需要你/复盘」入口；三者都是对已有数据的**只读投影**，不需要新状态机（Handoff 的"接收/退回"状态机是后端新工作，见 §4.4）。

---

## 1. 项目内现有可见信息审计（打开一个任务后能看到什么）

### 1.1 进入项目的路径

- 侧栏「Tasks」列表 → 点一行 → 打开 `conversationId` 对应的会话窗口（`TaskFolderList.tsx:41-44`）；已完成任务折叠，hover 有「基于此新建」（`TaskFolderList.tsx:74-105, 128-140`）。
- 任务窗口 = 某 bot 的一个 task thread（`src/App.tsx:304-305` 渲染 `ChatView`；`ChatView.tsx:857` 取 `activeTask`）。窗口头是 bot 名/主 Bot 星标/「N running」/任务切换（`ChatHeader.tsx:96-130`），不是项目名/目标/进度。
- 已完成/取消的项目窗口变成只读条 + 「基于此新建」（`ChatView.tsx:1297-1301`、`1330-1375`），与服务端 `closedAt` 一致（`server/index.ts:2371-2383` 在 run done/canceled 时 `closeTask`）。

### 1.2 项目内实际能看到什么（逐项）

| 信息 | 项目窗口里是否可见 | 证据 |
|---|---|---|
| 项目标题/目标 | 仅以"当前会话标题/bot 名"形式间接出现；**没有项目名、目标、进度** | `ChatHeader.tsx:96-130`；`ChatView.tsx:857` |
| 项目状态/进度 | **不可见**（`TaskFolderView.progress` 没人渲染） | `shared/task-folders.ts:60-72`；grep `task.progress/memberCount` 在 `src/` 零命中 |
| 团队结构（部门/成员/负责人） | **不可见**（`departments/memberCount` 服务端已算，UI 只用 `leadName` 显示在侧栏行尾） | `server/index.ts:2244-2254, 2266-2268`；`TaskFolderList.tsx:91` |
| 派单子任务与状态 | 只有"总控/主管会话 + 该会话发起的 run"里有一张 `DispatchRunCard`（进度、参与人、小队、失败数、可打开子任务会话、模型推荐） | `ChatView.tsx:83, 655, 884-900`；`ResultCards.tsx:37-155, 162-231` |
| 子任务依赖（谁在等谁） | 派单卡里**不显示**（只在全局工作台 `DispatchBoard` 里显示"After …"） | `ResultCards.tsx:37-155` vs `DispatchBoard.tsx:169-171` |
| 每个子任务谁负责/在做什么 | 派单卡显示 assignee 名字列表；成员实时状态不可见 | `ResultCards.tsx:47-49` |
| Handoff 交接内容（decisions/risks/openQuestions/artifacts） | **完全不可见**（全仓无 `handoff` 消费） | `shared/dispatch-types.ts:98-121`；grep `handoff` 在 `src/` 仅出现于浏览器/委派无关代码 |
| 评审/闸门状态（pass/fail/needs_human、criteria 裁决、返工次数） | **只有 needs_human 进入 app 级收件箱**；项目内无逐子任务评审状态 | `shared/dispatch-types.ts:141-158`；`server/dispatch.ts:1327-1338`；grep `.gate` 在 `src/components` 零命中 |
| 阻塞原因 | 派单卡不显示；全局工作台 `DispatchBoard` 显示 `subtask.error` | `DispatchBoard.tsx:173` |
| 项目级「需要你」 | 收件箱是 app 级 Dialog，**不能按当前项目过滤**（服务端分组数据里有 `taskId`） | `InboxPanel.tsx:52, 66-79`；`server/index.ts:5679-5688` |
| 项目内 worker/lead 会话入口 | 只有派单卡的「Open」菜单（限总控会话）；或退出去侧栏找 bot | `ResultCards.tsx:112-143` |
| 复盘 | **不可见**（retro API 零 UI 消费者） | `server/index.ts:5865-5890`；`server/task-retro.ts`；grep `/retro` 在 `src/` 零命中 |
| StateDoc 事实/漂移 | **不可见**（`/state` 零 UI 消费者） | `server/index.ts:5856-5862`；`server/state-doc.ts:25-105` |
| 群聊/会议 | **不属于项目**：group 没有 `folderId`，任务只绑定 task thread | `server/index.ts:5775,5807`（只 `bindTaskFolder(window.threadId,…)`）；`server/store.ts:1519-1524` |
| 项目内「对全队说」/点名 | 只能在单个 bot 会话里说话；无项目级输入栏 | `ChatView.tsx:1297-1310`（Composer 属于当前 bot） |

### 1.3 数据面盘点（"事实已经存在"的证据）

| API/字段 | 提供什么（项目内协同所需） | 今日 UI 消费者 |
|---|---|---|
| `GET /api/task-folders`（`server/index.ts:5747`）→ `TaskFolderView` | `status/progress/memberCount/departments[{section,people,leadName}]/leadName/conversationBotId`（`server/index.ts:2226-2275`、`shared/task-folders.ts:60-72`） | 只有侧栏任务行用 `title/leadName/status`（`TaskFolderList.tsx:74-105`） |
| `GET /api/task-folders/:id/state`（`server/index.ts:5856-5862`） | StateDoc：`facts.status/progress/subtasks[]/gates{pass,fail,needsHuman}/artifacts/inboxOpen/charter`、`drift[stalled/gates_waiting]`（`server/state-doc.ts:25-105`） | **无** |
| `GET /api/task-folders/:id/retro`（`server/index.ts:5865-5890`） | 复盘：`conversations[main/worker]`、`attempts[{status,attempts,model,startedAt,finishedAt,durationMs,error,handoff}]`、`artifacts`、`sharedFromTaskIds`（`server/task-retro.ts`） | **无** |
| `GET /api/dispatch/state`（`server/dispatch-api.ts:50`） | runs：`subtasks[{assigneeBotId,status,dependsOn,handoff,gate,error,threadId,ranWith,reworkCount,currentAttemptId}]`、`squads`、`report`（`shared/dispatch-types.ts:288-330`） | 工作台（全局）+ ChatView 派单卡；项目内只看得到卡片 |
| `GET /api/inbox`（`server/index.ts:5676-5723`） | 待办条目已有 `taskId`（按任务分组 `groups`），动作 approve/reject/abandon | app 级 InboxPanel；项目内无入口/过滤 |
| `GET /api/decision-stack`（新增，`server/index.ts:5658-5668`、`server/decision-stack.ts`） | 首页决策栈投影（statusLine/cards/running/counts；risk×wait 排序） | **未接前端**；且它只吃 `/api/inbox`，不含 org 层 needsYou |
| 运行审计 | `run.checkpoints[{at,note,nextStep,by}]`（`shared/dispatch-types.ts:88,295-296`）、`run.report`、`subtask.reworkNote/reworkCount` | **无 UI**（`src/` 无 checkpoint 消费） |

结论：**协同视图不是"没数据"，而是"没有投影"**；项目办公文档 `:29-31` 的"UI 应该是 dispatch subtask + Handoff + 闸门的投影，不是新增叙事数据"在代码层面完全成立。

---

## 2. 缺口清单（项目内老板看不到的协同关键信息）

按「老板在项目里最该知道什么」排序；每条给出数据在哪、缺什么 UI、代码证据。

| # | 缺口（项目内看不到） | 数据其实在哪 | 4h 内可做的 UI | 证据 |
|---|---|---|---|---|
| G1 | **谁在等谁 / 等多久**（等待链） | `subtask.dependsOn` + 依赖项 `status`/`finishedAt`/`startedAt`；`run.updatedAt` | 「此刻」一行 + 可展开等待链：`X → 等 Y（已 N 分钟）` | `shared/dispatch-types.ts:176-177, 288-330`；`server/dispatch.ts:1631-1649`（依赖失败 skip 规则） |
| G2 | **部门间交接物与交接状态** | `subtask.handoff{status,summary,evidence,artifacts,decisions,assumptions,openQuestions,risks,nextStep,acceptanceMet}` | 协作流里每行展示"交付了什么/未决问题"摘要；点开看全文 | `shared/dispatch-types.ts:98-121`、`:193`；retro 已带 handoff（`server/task-retro.ts:90-102`） |
| G3 | **交接是否被接收/退回（ack）** | **不存在**：`DispatchHandoff` 无 `ackedAt/ackBy/rejectReason`（grep 零命中） | 4h 内不做；这是服务端状态机新增（项目办公文档反问问对了） | `shared/dispatch-types.ts:98-121`；`server/dispatch.ts` 无 ack 逻辑 |
| G4 | **成员当前在做什么（presence）** | `bot.activity/busy`（全局）+ `subtask.status/assigneeBotId`（项目内） | 项目团队栏：按子任务推导固定状态词「工作中/等待/评审中/受阻/空闲」；**不能用全局 `bot.activity`**（bot 跨项目复用，run 结束会 `releaseBot` 回池） | `server/dispatch.ts:166, 575, 1730`（releaseBot）；`server/index.ts:2309` |
| G5 | **评审状态（谁在评、评到哪一步）** | `subtask.gate{status,criteria[],deterministic[],reason,provisional}`、`criteria[]`、`reworkCount` | 项目内逐子任务显示"待评审/通过/打回 N 次"；仅 needs_human 现在进收件箱 | `shared/dispatch-types.ts:141-158, 169-215`；`server/dispatch.ts:1327-1338`；grep `.gate` 在 `src/components` 零命中 |
| G6 | **阻塞原因/异常** | `subtask.error`、`status=skipped`、`gate.reason`、StateDoc `drift[stalled]` | 异常区：一行一条 + 「看原因」展开到子任务/会话 | `DispatchBoard.tsx:173`（现在只在全局工作台）；`server/state-doc.ts:64-79` |
| G7 | **项目进度/是否停滞** | `TaskFolderView.progress`（服务端已算）、StateDoc `facts.progress` + `drift` | 顶部进度条 + 「停滞」徽标 | `server/index.ts:2255-2261`；`server/state-doc.ts:28, 64-70`；零 UI 消费者 |
| G8 | **项目团队/部门结构** | `TaskFolderView.departments[{section,people,leadName}]`、`memberCount` | 团队栏（部门 → 成员头像+状态点），手机折叠 | `server/index.ts:2244-2254, 2266-2268`；零 UI 消费者 |
| G9 | **worker/lead 会话入口** | `subtask.threadId`、retro `conversations[]` | 点子任务行直接打开该成员会话（现只有总控派单卡的 Open 菜单） | `shared/dispatch-types.ts`（`subtask.threadId`）；`ResultCards.tsx:112-143`；`server/task-retro.ts:57-76` |
| G10 | **项目级「需要你」** | `/api/inbox` 已带 `taskId` 且按任务分组 | 侧栏 Inbox 面板按当前项目过滤 + 项目窗口「待你 N」入口 | `server/index.ts:5676-5688`；`InboxPanel.tsx:66-79`（app 级） |
| G11 | **复盘/项目历史** | `/api/task-folders/:id/retro`、`run.checkpoints` | 项目「复盘」tab（读取即可；旧任务 retro 的 main conversation 可能缺失，见 §3） | `server/index.ts:5865-5890`；`server/task-retro.ts`；`shared/dispatch-types.ts:88, 295-296` |
| G12 | **"你不在时"摘要** | 无独立 ProjectEvent 日志；可近似用 checkpoints + inbox 的 `createdAt/resolvedAt` + events | 4h 内不做精确版；先显示"你不在时完成 N / 卡住 M / 待你 K"（从 run/inbox 推导） | `server/inbox-store.ts:64-72`；`shared/dispatch-types.ts:88, 295-296`；无 `ProjectEvent` 类型 |
| G13 | **群聊/会议室与项目的关系** | 不存在关联：group 无 `folderId`，只有 task thread 绑定 folder | 4h 内不做（需要建"项目房间"模型） | `server/index.ts:5775, 5807`；`server/store.ts:1519-1524`（只绑 task thread） |

补充（项目办公文档 §5 的"要新增字段"逐条核对）：
- `blockedOn`/`waitingSince`/`priority`/`reviewRound`/`authorIds`/`reviewerId`：**均不存在**于 `DispatchSubtask`（`shared/dispatch-types.ts:169-215` 只有 `dependsOn/reviewer?（计划期字段）/reworkCount/gate/…`）。4h 内用现有字段**近似**：等待对象 = `dependsOn` 中未 done 的项；等待时长 = `now - max(依赖项 finishedAt/startedAt, run.updatedAt)`（没有逐子任务 `updatedAt`，精度到"分钟"够用）。
- `presence`：可由 subtask 状态推导（G4），不需要存。
- `Handoff.ackedAt/ackBy/rejectReason`：确认**没有**，要做需要新状态机 + 路由 + UI，不在 4h 范围。
- `ProjectEvent`：确认**没有**；`run.checkpoints` 只是 owner/supervisor 的可选备注（`shared/dispatch-types.ts:88-95`），不是自动事件流。

---

## 3. 实测（运行中服务 127.0.0.1:8799）

### 3.1 数据规模

| 指标 | 值 |
|---|---|
| 任务文件夹（项目） | **2**（1 done、1 canceled；均为历史任务，`conversationId=null`） |
| 项目成员（众数） | **4**（`memberCount=4`，来自 run 的 assignees） |
| 项目部门字段 | **[]**（测试 bot 均无 `section`，所以 `departments` 为空；真实部门场景下服务端会填） |
| dispatch runs | **2**；被测项目 run 有 **4** 个子任务（全部 done、attempts=1、耗时 13.8s/62.4s/39.6s/62.4s） |
| 子任务 gate / handoff / artifact | **0 / 0 / 0**（旧计划没有闸门与信封——数据是历史遗留，不能据此证明新流程的可见性） |
| bots | 13（visible 10） |
| 收件箱条目 | **0**（`counts.needsYou=0`） |

> 说明：当前是清理后的空态；没有新式任务（带 conversationId、闸门、Handoff 的 run）可读。按任务约束只读、未造数据，所以下面延迟是**下限测量**，且 G2/G5 的展示效果无法在本次实测里肉眼验证，只能从类型/路由确认。

### 3.2 单端点 5 次（nearest-rank：p95=max）

命令：

```bash
BASE=http://127.0.0.1:8799
TID=4c9db9fb-5269-410d-945e-e06bda78e660   # /api/task-folders 的第一个任务
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -w '%{http_code} %{time_total} %{size_download}\n' \
    "$BASE/api/task-folders/$TID/state"      # 五个端点各跑一遍
done
```

| 端点 | 响应体 | p50 | p95(max) |
|---|---|---|---|
| `GET /api/task-folders` | 1,199 B | **1.01 ms** | 1.07 ms |
| `GET /api/task-folders/:id/state`（StateDoc） | 586 B | **0.65 ms** | 0.82 ms |
| `GET /api/task-folders/:id/retro`（复盘） | 3,009 B | **0.72 ms** | 1.55 ms |
| `GET /api/dispatch/state` | **40,112 B** | **0.96 ms** | 1.19 ms |
| `GET /api/inbox` | 71 B | **0.50 ms** | 0.60 ms |

StateDoc 实测内容（586 B）：`facts.status=done, progress 4/4, gates 0/0/0, artifacts [], inboxOpen 0, drift []`；retro 实测：4 个 worker 会话、4 条 attempt（含 durationMs）、0 artifacts，**main conversation 缺失**（旧任务 `conversationId=null` 导致 `buildTaskRetro` 加不进主会话，`server/task-retro.ts:70-76`）。

### 3.3 10 并发 `GET /api/inbox`

```bash
start=$(python3 -c 'import time;print(time.time())')
for i in $(seq 1 10); do curl -s -o /dev/null -w '%{http_code} %{time_total}\n' "$BASE/api/inbox" & done; wait
```

结果：**10/10 HTTP 200，失败 0**；墙钟 **0.058 s**；单请求 min/p50/max = **0.24 / 0.35 / 0.76 ms**。

### 3.4 实测解读

1. 所有端点在当前数据量下都是**亚毫秒到 2ms**，服务端不是项目内协同的瓶颈。
2. **唯一重端点是 `/api/dispatch/state`（40 KB / 2 个历史 run）**：它返回全部 run 的完整 subtasks（含 brief/result 文本）。项目内视图如果直接复用它会拖上全公司历史；4h 实现时应按 `folder.runId` 过滤（或新增 `GET /api/task-folders/:id/dispatch` 投影），否则手机端会拉不需要的数据。
3. StateDoc 与 retro 都很小（<3 KB）、很快；**项目内"此刻/复盘"完全不需要新后端**。

---

## 4. 结论：只给 4 小时，项目内协同最值得做的 3 个改动

每项按「收益 / 成本 / 风险」，并给一句话说明。

### 第 1 名（最值）：项目窗口顶部「此刻」协作条 + 等待链

- **一句话**：在任务窗口顶部加一行 `此刻：小林 写完文案 → 等 阿哲 评审（已 6 分钟）`，点开是竖向等待链。
- **做什么**：新组件 `ProjectPulse`（放 `ChatView` 顶部、`ChatHeader` 下）；用当前任务的 `folder.runId` 找 run（`/api/task-folders` 已带 `runId`），从 `subtasks[].dependsOn` + 未完成依赖推导"谁在等谁"，用依赖项 `startedAt/finishedAt` 与 `run.updatedAt` 近似等待时长；>15 分钟标红并给「催一下」（发一条消息给被等的人，复用现有 send）。
- **数据/复用**：`/api/task-folders`（runId）+ `/api/dispatch/state`（过滤到本 run）；不改后端；`ResultCards/DispatchBoard` 已有依赖与 error 的渲染范式可抄（`DispatchBoard.tsx:161-191`）。
- **收益 高 / 成本 中（2–3h）/ 风险 低-中**：风险是"等待时长是近似值"（无逐子任务 updatedAt，`shared/dispatch-types.ts` 只有 `startedAt/finishedAt`），文案要写"约"；以及必须坚持项目办公文档的防线——**状态只从 subtask/handoff/gate 事实推导，不读 bot 自述**（`:189-193`）。

### 第 2 名：项目团队栏（部门 + 成员 + 固定状态词）

- **一句话**：项目内左侧/顶部一行团队栏：`内容部 小林●工作中 小琳○空闲 · 评审部 阿哲●评审中`，手机可折叠。
- **做什么**：新组件 `ProjectTeamStrip`；数据用 `TaskFolderView.departments/memberCount`（服务端已算、零 UI 消费者）+ 本 run 的 subtask 状态推导 presence（工作中/等待/评审中/受阻/空闲）。**不要用 `bot.activity`**：bot 跨项目复用、run 结束会 `releaseBot`（`server/dispatch.ts:1730`），全局 activity 在项目内没有意义。
- **收益 高 / 成本 低-中（1–2h）/ 风险 低**：纯展示；"空闲"的定义要用"当前项目内没有未完成子任务"，不要用全局状态（项目办公文档反问 1 的答案在代码里：跨项目复用确实存在）。

### 第 3 名：项目级「需要你」+ 复盘入口

- **一句话**：把 app 级收件箱按当前项目过滤出「待你 N」，并在项目里给一个「复盘」入口读 retro。
- **做什么**：`InboxPanel` 增加 `taskId` 过滤参数（服务端已按 taskId 分组，`server/index.ts:5679-5688`；客户端 `src/lib/inbox.ts` 已有数据）→ 项目窗口显示「待你 N」按钮；`/api/task-folders/:id/retro`（已实现、3 KB、<1ms）渲染一个只读复盘抽屉（会话列表 + attempts 时间线 + handoff 摘要）。
- **收益 中高 / 成本 低（1h）/ 风险 低**：数据与接口都已存在；注意旧任务的 retro 可能没有 main conversation（`conversationId=null`），UI 要做"仅 worker 会话"降级。

### 4.4 4 小时内明确不要做

- **Handoff「接收/退回补件」状态机**：`DispatchHandoff` 没有 `ackedAt/ackBy/rejectReason`（`shared/dispatch-types.ts:98-121` 无这些字段，grep 零命中），要做需要改 dispatch 状态机 + 路由 + prompt + 测试，工作量大于 4h；这也是项目办公文档 `:185` 自己反问的第 2 点，答案在代码里是"没有"。
- **ProjectEvent 日志 / "你不在时"精确摘要**：不存在该类型；4h 内先用 checkpoints + inbox 时间戳近似（G12）。
- **把群聊/会议室接进项目**：group 无 `folderId`，是数据模型改动（G13）。
- **评审权限硬校验（reviewerId ∉ authorIds）**：`DispatchSubtask.reviewer` 只是计划期字段，`SubtaskGate` 是代码裁决（`shared/dispatch-types.ts:141-158, 169-215`）；做"不能自评"的权限层是后端工作。

---

## 5. 背景：app 级改造审计（原侧栏/决策栈范围，压缩保留）

> 本范围是老板更正前的理解；如果之后回到 app 级改造，这部分可直接用。完整判定表见本文件的上一版（已被 commit `c8f28a1` 收录），这里只留结论。

- 侧栏任务列表：**冲突**（方案 A 要删/降级，现状侧栏最外层保留；`Sidebar.tsx:2132-2138`、`TaskFolderList.tsx`）。
- 独立收件箱：**冲突 + 两套并存**（`/api/inbox` 的 gate/signoff vs `/api/brief` 的 org needsYou；`Sidebar.tsx:1485-1488`、`BriefPage.tsx:483`）。
- 任务窗口/只读/fork：**部分符合**（机制完整；`ChatView.tsx:1297-1301, 1330-1375`）。
- 工作台团队地图：**部分符合**（独立页，未降级为异常行；`App.tsx:285-286`、`WorkbenchPage`）。
- 简报页：**冲突**（独立页；`App.tsx:277-278`、`BriefPage.tsx`）。
- 首页决策栈+按住批准：**已部分落地（未接前端）**：`c8f28a1` 已提交 `server/decision-stack.ts` + `GET /api/decision-stack`（`server/index.ts:5658-5668`），前端尚无 HomePage。
- 若回到 app 级：4h 排序仍是「首页决策栈 MVP → 接 SSE 帧替代 5s 轮询 → 前端合并两套 needsYou」。

---

## 6. 并行状态说明

- 本审计文件的前一版已被提交进 `c8f28a1`（commit message: "home decision stack projection, audit, project-office design"），同一提交还包含 `server/decision-stack.ts`、测试、`GET /api/decision-stack` 与 `docs/collab/2026-10-17T17-43-project-office.md`（项目办公设计）。
- 本版为范围更正后的重写（项目内协同主线），行号以 `c8f28a1` 工作区为准；工作区另有一个未跟踪的 `docs/workbench-v2-spec.md`（工作台 v2 规格，非本审计产出）。

---

## 7. 附：命令与原始数字

```bash
BASE=http://127.0.0.1:8799
TID=4c9db9fb-5269-410d-945e-e06bda78e660

# 数据规模
curl -s "$BASE/api/task-folders"      # tasks=2（done/canceled，conversationId=null）
curl -s "$BASE/api/inbox"             # items=0, counts 全 0
curl -s "$BASE/api/dispatch/state"    # runs=2（done/canceled）；项目 run subtasks=4
curl -s "$BASE/api/bots"              # bots=13（visible 10）

# 单端点 ×5（-w 输出 code/time/size）
for ep in /api/task-folders "/api/task-folders/$TID/state" "/api/task-folders/$TID/retro" \
          /api/dispatch/state /api/inbox; do
  for i in 1 2 3 4 5; do curl -s -o /dev/null -w "$ep %{http_code} %{time_total} %{size_download}\n" "$BASE$ep"; done
done

# 10 并发 /api/inbox
start=$(python3 -c 'import time;print(time.time())')
for i in $(seq 1 10); do curl -s -o /dev/null -w '%{http_code} %{time_total}\n' "$BASE/api/inbox" & done; wait
```

原始摘要：
- `/api/task-folders`：200×5，1,199 B，p50 1.01 / p95 1.07 ms
- `/api/task-folders/:id/state`：200×5，586 B，p50 0.65 / p95 0.82 ms
- `/api/task-folders/:id/retro`：200×5，3,009 B，p50 0.72 / p95 1.55 ms
- `/api/dispatch/state`：200×5，40,112 B，p50 0.96 / p95 1.19 ms
- `/api/inbox`：200×5，71 B，p50 0.50 / p95 0.60 ms
- 10 并发 `/api/inbox`：10×200，失败 0，墙钟 0.058 s，单请求 0.24/0.35/0.76 ms（min/p50/max）
- 项目数据：members=4、departments=[]（测试 bot 无 section）、subtasks=4（全 done，attempts=1，13.8s/62.4s/39.6s/62.4s）、gate=0、handoff=0、artifact=0、inbox=0
- 限制：空态 + 历史数据（无新式 gate/handoff 的 run、旧任务无 conversationId），延迟是下限；未写入测试数据。

---

## 8. 一页纸给老板

- 你打开一个项目，现在看到的是一段对话；**团队在互相等什么、谁在评审、卡在哪，都看不到**。
- 这些信息**不是没有**——子任务、依赖、Handoff、闸门、部门/成员、复盘，服务端都存着；缺的是把它们投影到项目里。
- 4 小时内最值：**先在项目顶上放一行「此刻」（谁在等谁，等了多久）**，再放一条**团队栏（部门+成员+状态词）**，最后把**「需要你」和「复盘」按项目过滤**。三件都是只读投影，不改后端状态机。
- 最容易失败的地方是「状态不可信」：所有状态只从子任务/交接/闸门的事实推导，绝不读 bot 自己说的"我在忙"。
