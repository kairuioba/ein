# 工作台 v2 现状审计与测算

- 审计日期：2026-10-18（凌晨）
- 审计对象：`/Users/kairuiwang/ein-work/next`（feat/1.1.4 任务式工作台，本地 app 运行于 `127.0.0.1:8799`）
- 对照文档：`docs/collab/2026-10-17T17-38-workbench-ui.md`（下称「UI 文档」，推荐方案 A + 屏①②③ + 保留/删除清单 + 「只改一处就哇」+ 成功指标）；`docs/collab/2026-10-18-session-summary.md`（下称「落地总结」）
- 方法：只读源码 + 对运行中服务做只读 curl 实测；未修改任何代码，未写入任何 app 数据，未 git 提交。
- 快照说明：本审计以 `c715e7c` 的已提交代码为基准；审计期间工作区出现并行未提交改动（新增 `server/decision-stack.ts` 等，见 §7），`server/index.ts` 的行号已按 2026-10-18 02:0x 的当前工作区校正。
- 结论先说：**方案 A 的产品「骨架」已经存在**（任务=窗口、只读+fork、收件箱证据/打回、gate 裁决、StateDoc），**缺的是「入口收敛」**：没有首页、没有决策栈、没有按住批准、工作台/简报/侧栏/收件箱仍是并列的独立入口，而且存在**两套并行的「需要你」**。

---

## 1. 对照方案 A 逐项审计

方案 A 的定义与要求（UI 文档）：
- 定义：公司默认自己跑，App 只做一件事——把需要你的事排成一叠卡片，一次处理一张（`:29-40`）。
- 删除/降级：侧栏任务列表（`:149`）、独立收件箱（`:150`）、工作台/团队地图移出首页（`:151`）、任务窗口改单屏详情（`:152`）、简报页变首页状态句（`:153`）。
- 首页三屏线框：屏①「今日」`一句状态句 + 决策卡 + 按住批准`（`:65-92`）；屏②处理「需要你」`送回必须选原因`（`:94-122`）；屏③任务详情/复盘（`:124-139`）。
- 保留三样：gate 证据与送回计数（`:143-146`）、ReviewerPort 诚实签收句（`:145`）、snooze 语义（`:146`）。
- 成功指标：决策延迟、积压/烂尾、首次通过率（`:194-198`）。

### 1.1 总览判定表

| # | 方案 A 要求 | 现状 | 判定 | 主要证据 |
|---|---|---|---|---|
| 1 | 侧栏任务列表删除/降级为「全部」tab，不是首页 | 侧栏顶部保留「Tasks」列表（进行中在上、已完成折叠、needs-you 角标、+ 新建、已完成行 hover「基于此新建」） | **冲突（功能符合、位置冲突）** | `src/components/Sidebar.tsx:2132-2138`、`src/components/TaskFolderList.tsx:27-143` |
| 2 | 独立收件箱并入首页卡片栈，「收件箱」概念消失 | 存在**独立「Needs you」面板**（`InboxPanel`，Dialog）+ 侧栏入口 + 简报页右侧另一套「需要你」；**两套数据源并存** | **冲突** | `InboxPanel.tsx:17-136`、`Sidebar.tsx:2058-2074, 2308-2314`、`BriefPage.tsx:483`、`Sidebar.tsx:1485-1488` |
| 3 | 任务窗口 = 单屏详情，不做多窗口 | 任务=对话窗口；完成/取消后窗口只读（`closedAt` 读条 + 「基于此新建」fork，幂等、不复制聊天、返回草稿） | **部分符合**（机制已落地，形态仍是多窗口聊天） | `ChatView.tsx:857, 1299-1301, 1320-1375`、`server/index.ts:7721-7723`、`shared/task-folders.ts:28-39`（`closedAt/forkedFromTaskId/forkRequestId`） |
| 4 | 工作台/团队地图移出首页，异常才露一行 | 工作台是独立页面（侧栏 Workbench + `team-map` 路由），首页（默认 chat）不受影响 | **部分符合（但方向相反：它是独立大页，没被降级为异常行）** | `src/App.tsx:285-286`、`Sidebar.tsx:2075-2087`、`TeamMapPage.tsx:1-8`、`workbench/WorkbenchPage.tsx`（756 行）、`workbench/model.ts`（264 行） |
| 5 | 简报页变成首页的一句状态句 + 每天 8:00 推送 | 简报是独立页（`BriefPage`，776 行：左摘要/时间线，右 needsYou + autoApproved + 花费），不是首页 | **冲突** | `src/App.tsx:277-278`、`BriefPage.tsx:1-30`、`Sidebar.tsx:2047-2056` |
| 6 | 首页决策栈 + 按住 0.6s 批准（「只改一处就哇」） | **不存在**：`AppView` 只有 chat/team-map/routines/skill-recorder/brief/library/settings/apps，无 home；默认视图是 chat | **缺失（冲突）** | `src/state/store.tsx:442-444`、`src/App.tsx:277-320`、`src/App.tsx:50, 304-305` |
| 7 | 保留：gate 证据 + 送回计数 | gate 证据存在（`evidence` 行），**送回计数只以文本形式拼进 `reason`**（"already sent back N of 3 times"），无结构化字段 | **部分符合** | `InboxPanel.tsx:91-97`、`server/dispatch.ts:1327-1338`、`shared/dispatch-types.ts:153-167`（无 reworkCount 字段） |
| 8 | 保留：诚实签收句 | 有：signoff 卡片文案写明"机器只查了形式与事实，内容由你判断" | **符合** | `InboxPanel.tsx:84-90`、`server/dispatch.ts:1717-1727` |
| 9 | 保留：snooze 语义（明早 8 点再看 + 后来事项重新顶起） | 只有「Later」= `markInboxSeen`（清红点、不解决）；**没有定时 snooze、没有"明早 8 点"** | **部分符合** | `InboxPanel.tsx:123-125`、`server/index.ts:5709-5713`、`server/inbox-store.ts:74-82` |
| 10 | 屏②「送回必须选原因」 | 有：reject 强制填写一句原因（前后端都校验），但**没有原因分类**（内容不对/风险太大/范围跑偏/我想改一下） | **部分符合** | `InboxPanel.tsx:98-114`、`server/index.ts:5718-5722` |
| 11 | 屏③复盘：时间线/送回原因分布/重开/复制为新任务 | 有 retro 接口与 `StateDoc`（事实+漂移），任务可"基于此新建"；**时间线/原因分布未在 UI 暴露** | **部分符合** | `server/index.ts:5865-5892`（`/retro`）、`server/state-doc.ts:25-105`、`TaskFolderList.tsx:93-102` |

### 1.2 逐项说明（含关键实现细节）

**① 侧栏任务列表 — 冲突。** 现状是"任务文件夹"两层结构：`TaskFolderList` 渲染进行中任务 + 已完成折叠区；每行有颜色点、标题、needs-you 角标、负责人名；已完成行 hover 出现「基于此新建」（`TaskFolderList.tsx:74-105`），点任务打开对应会话窗口（`:41-44`）。功能上它已经是 UI 文档里"全部 tab"的雏形，但物理位置正是方案 A 要删掉的侧栏最外层、且永远可见（非 icon 模式）。另：`+` 新建任务写入 `POST /api/tasks`（`server/index.ts:5760-5780`），一次事务建窗口 + 文件夹，跟 UI 文档"任务来自老板一句话"一致。

**② 需要你收件箱 — 冲突，且有"两套需要你"。** 这是本次审计发现的最重要的结构问题：
- 侧栏「Needs you」入口 + 角标来自 **`useInbox()` → `GET /api/inbox`**（gate_failed / signoff / question / failed_exhausted；`InboxPanel.tsx:10-15`、`src/lib/inbox.ts:6-14,41-56`），面板本身是 Dialog，分组按任务、signoff 置顶（`server/index.ts:5679-5708`）。
- **简报页右侧的「需要你」来自 `/api/brief` 的 `brief.needsYou`**（公司层 org inbox：choice/approval/escalation；`BriefPage.tsx:483`、`shared/org-types.ts` 的 InboxItem），语义、动作（pick/approve/deny vs approve/reject/abandon）、计数都不同。
- Sidebar 同时使用两者：`const inbox = brief.needsYou; const approvalInbox = useInbox();`（`Sidebar.tsx:1485-1488`）——per-bot wants-you 标记用前者，Needs you 角标用后者。做首页决策栈时**必须先决定合并口径**，否则"清空 = 干净"是假的。

**③ 任务窗口/只读/fork — 部分符合。** 机制完整且做得对：
- run 完成/取消 → 服务端 `store.closeTask(window)` + 每个子任务会话关闭（`server/index.ts:2371-2383`），不是前端推断；
- 已完成窗口输入框替换为只读条 + 「基于此新建」（`ChatView.tsx:1297-1301`、`1320-1375`）；
- fork 有 `clientRequestId` 幂等（`TaskFolderList.tsx:60-72`、`TaskFolderList.tsx` 调用 `forkTask` → `src/lib/task-folders.ts:36-42`；服务端 `server/index.ts:5780-5803`），不复制聊天、返回可编辑 `draft`；
- 已关闭窗口发消息返回 409 `TASK_CLOSED + canFork`（`server/index.ts:7721-7723`）。
冲突点在 UI 文档要"单屏详情、不做多窗口"，现状仍是"每任务一个聊天窗口"（多窗口列表 + 切换）；这是产品取舍，不是实现缺陷。

**④ 工作台/团队地图 — 部分符合（但方向是"保留独立大页"）。** `TeamMapPage` 已是壳（`TeamMapPage.tsx:1-8`），实际渲染 `workbench/WorkbenchPage`（756 行）+ `model.ts`（264 行）+ PeopleView/Canvas/TreeDrawer/DispatchBoard；入口是侧栏 Workbench（`Sidebar.tsx:2075-2087`），路由 `state.activeView === "team-map"`（`App.tsx:285-286`）。它没有占首页（默认 chat），但也没有按 A 的"异常才露一行"降级；简报/工作台/任务列表三者仍是平行信息源。

**⑤ 简报页 — 冲突。** `BriefPage` 776 行 + `brief-model.ts` 106 行，左摘要/时间线、右 needsYou/autoApproved/spend/expired（`BriefPage.tsx:1-30`），数据全来自 `/api/brief` 等轮询。方案 A 要的"一句状态句 + 每日推送"素材其实都在（headline、departments、risks、spend、timeline），只是还没有被搬到首页，也没有推送（落地总结明确"本版不做手机推送，局域网非安全上下文"，`2026-10-18-session-summary.md:47`）。

**⑥ 首页决策栈/按住批准 — 缺失。** 无 home 路由、无首页组件、无 hold-to-approve（全仓无 hold/按住实现；`pointerdown` 只用于关闭菜单，如 `MacMenu.tsx:46`）。UI 文档 §5 的实现 5 步（`:186-191`）目前 0/5 落地。

**⑦ 保留项**：gate 证据有（`evidence` 最多展示 4 条，`InboxPanel.tsx:91-97`）；送回计数存在但未结构化 —— `server/dispatch.ts:1332-1336` 把 `subtask.reworkCount` 拼进中文 reason；`InboxItem`（`shared/dispatch-types.ts:153-167`）没有 `reworkCount/risk/gate` 字段。这对"风险 × 等待时长排序"是直接障碍（只能解析文案）。

**⑧ 成功指标可观测性（好消息）**：决策延迟**不需要新埋点**——`InboxItem.createdAt` 与 `resolution.at` 已在持久化记录里（`server/inbox-store.ts:98-105`），`/api/inbox` 返回 `items`（含 resolved 态也可查 `all`），可直接算 p50/p90；积压数 = `counts.needsYou`（`server/inbox-store.ts:64-72`）。首次通过率 = approve 次数 / 送回次数，现有 `resolution.action` 与 `reworkCount` 可算。

---

## 2. 实测（运行中服务）

### 2.1 环境与数据规模

- 服务：`127.0.0.1:8799`，审计时 app 运行中；审计时间 2026-10-18 01:40 左右。
- 数据规模（`GET /api/task-folders`、`/api/inbox`、`/api/dispatch/state` 响应解析）：

| 指标 | 值 |
|---|---|
| 任务文件夹 | **2**（1 done、1 canceled；两者都无 `conversationId`，是历史任务） |
| 收件箱条目 | **0**（`counts: {needsYou:0, unseen:0, byTask:{}}`，groups=0） |
| dispatch runs | **2**（1 done、1 canceled） |
| 派发路由 | 7 |
| `/api/task-folders` 响应体 | 1,199 bytes |
| `/api/inbox` 响应体 | 71 bytes |
| `/api/dispatch/state` 响应体 | **40,112 bytes** |
| `/api/task-folders/<id>/state` 响应体 | 586 bytes |

> 注意：当前是"刚清理完测试数据"的**空态**（落地总结 `:40` 说测试数据已清理），所以下面的延迟是**下限测量**，不代表有 5–50 张待办时的延迟；本轮按任务要求只读、不造数据，因此未做写入式压测。

### 2.2 单端点 5 次（p50/p95 用 nearest-rank：5 次样本 p95=最大值）

命令（实际执行）：

```bash
BASE=http://127.0.0.1:8799; TID=<task-folders 第一个 id>
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -w '%{http_code} %{time_total} %{size_download}\n' "$BASE/api/inbox"
done   # 其余端点同理
```

结果：

| 端点 | 次数/状态码 | 响应体 | min | p50 | p95(max) |
|---|---|---|---|---|---|
| `GET /api/task-folders` | 5 / 200 | 1,199 B | 0.86 ms | **0.94 ms** | 1.11 ms |
| `GET /api/inbox` | 5 / 200 | 71 B | 0.48 ms | **0.64 ms** | 0.72 ms |
| `GET /api/dispatch/state` | 5 / 200 | 40,112 B | 0.97 ms | **1.15 ms** | 1.19 ms |
| `GET /api/task-folders/<id>/state` | 5 / 200 | 586 B | 0.42 ms | **0.74 ms** | 1.19 ms |

### 2.3 10 并发 `GET /api/inbox`

命令：

```bash
start=$(python3 -c 'import time;print(time.time())')
for i in $(seq 1 10); do
  curl -s -o /dev/null -w '%{http_code} %{time_total}\n' "$BASE/api/inbox" >> /tmp/conc_t &
done; wait
echo "wall: $(python3 -c "import time;print(time.time()-$start)")"
```

结果：**10/10 HTTP 200，失败 0**；总墙钟 **0.033 s**；单请求 min/p50/max = **0.27 / 0.38 / 0.55 ms**。
（Node 单线程下基本就是排队开销；数据量为 0，只能说明"没有并发瓶颈信号"。）

### 2.4 实测解读（对 v2 有意义的结论）

1. **当前所有端点都远低于"感知门槛"**（<1.2ms p50），**不是当前版本的性能问题**；v2 首页决策栈的延迟风险主要来自**轮询节奏与数据新鲜度**，不是服务端速度。
2. **唯一的"重"端点是 `/api/dispatch/state`：40,112 B / 2 个历史 run**（响应含每个 run 的完整 subtasks、brief、result 文本）。而 **Sidebar 常驻每 5s 拉它一次**（`Sidebar.tsx:1304`），即空转状态下约 **0.48 MB/分钟**；工作台打开时 2s（`workbench/model.ts:38`）、聊天页 chief 4s（`ChatView.tsx:117,884`）。run 越多/结果越长，这个数字线性涨——首页若要"即刻"，应消费 SSE 而不是加一路轮询（见 §3 风险 4）。
3. **`/api/inbox` 的组装成本随条目数线性**：每个 item 要 `taskFolders.byId(item.taskId)` 找文件夹（`server/index.ts:5679-5685`），上限 200 条（`server/inbox-store.ts:15`），当前空态无压力；等到"待办 50 张"时预计仍是亚毫秒级，无需优化。
4. **数据新鲜度是真实短板**：服务端已经广播 `inbox` / `task-folders` / `dispatch.run` SSE 帧（`server/index.ts:2371-2408, 5676-5722`），但**前端全仓没有任何消费者**（`src/state/store.tsx:2034-2130` 的 frame switch 只有 message/thread/bot/group/notify/routine/webhook；grep `"inbox"`/`"task-folders"`/`"dispatch.run"` 在 `src/` 无命中），所有相关 UI 都在 5s 轮询（`lib/inbox.ts:41`、`lib/task-folders.ts:9`、`Sidebar.tsx:1304`）。这意味着凌晨手机场景下，**首屏最多旧 5 秒**；对"5 秒清完"体验可接受，但做"哇"首页时值得顺手接上（成本很低）。

---

## 3. 「只改一处就哇」：首页决策栈 + 按住批准的成本与风险

目标（UI 文档 `:183-192`）：首页 = 一句状态句 + 一张决策卡 + 按住 0.6s 批准；数据全用现有 inbox；缺字段写死文案。

### 3.1 实施成本（文件级别）

**必须改（MVP，0.5–1 天）**

| 文件 | 改动 | 量级 |
|---|---|---|
| `src/App.tsx` | 新增首页渲染分支（建议 `activeView === "home"` 或"无选中会话时显示首页"），保留 chat 作为下钻 | ~30 行 |
| `src/state/store.tsx` | `AppView` 加 `"home"`（`:442`），默认视图/初始选中逻辑（`:50`、`:304-305`、`showPage`）相应调整 | ~20 行 |
| 新 `src/components/home/HomePage.tsx` | 状态句（用 `useTaskFolders` + `useDispatchState` + `useInbox` 组合，**无需新后端**）+ 决策卡栈 + 空态"今天没有事找你了" | 200–300 行 |
| 新 `src/components/home/HoldToApprove.tsx` | pointerdown/up + CSS 进度环（0.6s），松手回退；键盘/单击 fallback + aria | 80–120 行 |
| `src/components/Sidebar.tsx` | 新增「今日」入口（可先不动 Tasks/Needs you）；首页成为默认后徽标口径统一 | ~30 行 |
| `src/lib/inbox.ts` | 客户端排序 `priority(kind) desc, createdAt asc`（服务端排序更稳，见下） | ~15 行 |

**建议一起改（完整版，+0.5–1 天）**

| 文件 | 改动 |
|---|---|
| `shared/dispatch-types.ts:153-167` | `InboxItem` 增 `reworkCount?: number`、`gate?: {pass,fail,needsHuman}`、`risk?: "low"|"medium"|"high"`（现在只有文本 reason） |
| `server/dispatch.ts:1320-1340, 1715-1727` | `gate_failed` 传 `reworkCount: subtask.reworkCount`（已有字段）；`signoff` 传未验收数（已有 `unverified` 变量） |
| `server/index.ts:5676-5708` | `/api/inbox` 返回前按 `(risk, createdAt)` 排序，并在 payload 里附状态句所需计数（running 数、今日完成数）——或前端自己拼 |
| `src/components/InboxPanel.tsx` | 抽出卡片子组件供首页复用（现在卡片与 Dialog 耦合，`:78-128`） |
| `src/components/brief/BriefPage.tsx` | 不在本轮动；首页稳定后再决定是否把 Brief 降级 |

**结论**：不碰服务端、不碰 gate 语义、不动现有 InboxPanel 的话，**4 小时内可以做出一版"首页 + 状态句 + 卡片 + 一键批准/打回（按住作为增强）"**；按住批准本身不是难点（~100 行），难的是**批准动作的不可逆与证据呈现**（见风险）。

### 3.2 风险前 5（每条一句话 + 证据）

1. **两套「需要你」口径不合并，首页会"看起来清空"但其实还有另一套待办。** 首页若只聚合 `/api/inbox`，会漏掉简报页来自 `/api/brief` 的 choice/approval/escalation（`BriefPage.tsx:483`、`Sidebar.tsx:1485-1488`）——这正是"橡皮图章"之外的第二种危险：**误以为没你的事**。
2. **批准几乎不可逆，首页卡片必须写清"批准后会发生什么"。** signoff approve 会 `taskFolders.accept(taskId)` 写 `acceptedAt`，gate_failed approve 会 `dispatcher.acceptGate(...)`（`server/index.ts:5728-5737`）；目前面板只在 signoff 文案里解释，没有统一"后果行"，按住批准会让误批成本更高。
3. **「按住 0.6s」在桌面端是反模式且无障碍风险。** 全仓无 hold 先例（`pointerdown` 仅用于关菜单，如 `MacMenu.tsx:46`）；桌面鼠标长按不自然，键盘用户无法按住，触屏才有价值——必须做单击/键盘 fallback，否则是可用性倒退（方案 A 的"手机优先"前提在 UI 文档末尾也被反问过，`:200`）。
4. **首页加一路轮询会放大已经偏重的 `/api/dispatch/state` 流量，且首屏仍可能旧 5 秒。** Sidebar 已每 5s 拉 40KB（`Sidebar.tsx:1304`），服务端早已广播 `inbox`/`task-folders` 帧（`server/index.ts:2371-2408`）但前端不消费（`src/state/store.tsx:2034-2130` 无对应 case）；不做 SSE 的话"哇"的即时感打折。
5. **加首页要动全局导航状态，容易回归现有入口。** `AppView` 是枚举（`src/state/store.tsx:442`），App 的渲染分支、⌘1–9 选 bot、移动端抽屉关闭、`showPage` 都在依赖它（`App.tsx:277-320, 63-96, 139-141`）；另 `TaskFolderList` 和 `Needs you` 入口的可见性建立在"当前页"判断上，首页落地后要么去重、要么留两套入口。

> 备选（若老板只想要"哇"而不接受动导航）：**把决策栈做成 Brief 页顶部一张卡**（`BriefPage.tsx` 内插入 + 复用 `/api/inbox` 数据），改动面只有 2 个文件，但达不到"首页"的产品意图——不推荐作为终态，可作为 4 小时内的演示版。

---

## 4. 结论：只给 4 小时，最值得做的 3 个改动

按「收益 / 成本 / 风险」排序（收益=对方案 A 的推进，成本=人时，风险=回归与产品误判）：

### 第 1 名：首页决策栈 MVP（不接 SSE、不做按住）

- **做什么**：`AppView` 加 `home`；新 `HomePage`：一句状态句（在跑 N 个任务 / 今日完成 N / N 件事等你）+ 队首一张卡（kind 标签、标题、reason、证据 ≤4 行、批准/打回/稍后）+ 空态。数据全部来自现有三个轮询（`/api/inbox`、`/api/task-folders`、`/api/dispatch/state`），**零后端改动**；若采纳并行 WIP 的 `/api/decision-stack`（§7），直接渲染 `stack.statusLine/cards/running` 更省事。
- **为什么最值**：这是方案 A 屏① 的全部；UI 文档 §5 说"1–2 天"，但砍掉结构化字段与按住后，4 小时可交付，且复用现有 `resolveInboxItem/markInboxSeen`（`src/lib/inbox.ts:58-70`），动作语义不用重写。
- **收益 高 / 成本 中（~4h）/ 风险 中**：风险集中在导航状态（见 3.2-5），用"无选中会话时才显示首页"的最小侵入方案可以规避。

### 第 2 名：接通已有 SSE 帧，让收件箱/任务列表实时（替代 5s 轮询）

- **做什么**：在 `src/state/store.tsx` 的 frame switch（`:2034-2130`）外挂 3 个 kind：`inbox`（更新 InboxStore 快照/触发 refresh）、`task-folders`（刷新任务列表）、`dispatch.run`（刷新 runs）；把 `lib/inbox.ts`、`lib/task-folders.ts`、`Sidebar.tsx:1304` 的定时器降级为兜底（30–60s 或 focus 时）。
- **为什么第二**：服务端**已经广播**（`server/index.ts:2371-2408, 5676-5722`），前端只差消费；这是"零服务端改动"的体验提升，并把 `/api/dispatch/state` 的常驻 40KB 轮询换成"有变化才算"。
- **收益 中高 / 成本 低（~1–2h）/ 风险 低**：需要确认 SSE 帧的 payload 形状（`inbox` 帧带 items/counts、`task-folders` 帧带 tasks，`server/index.ts` 已满足），并保留轮询兜底。

### 第 3 名：统一「需要你」投影（前端 adapter 先行）

- **做什么**：先做前端合并层：`useInbox()` 的 items + `useBrief().needsYou`（org 层 choice/approval/escalation）映射成同一 `DecisionCard` 模型（kind→动作：approve/reject/abandon vs answer/approve/deny），统一排序、统一计数徽标；后端聚合路由可作为第二期。UI 上先把侧栏「Needs you」与简报页「需要你」的徽标口径改成同一个数。
- **为什么第三**：不做它，第 1 名交付的"清空=干净"是假的；但两套 item 的动作语义不同（一个走 `/api/inbox/:id/resolve`，一个走审批 API），一次性合并风险高于前两项，所以放在 4 小时窗口的最后，做 adapter 而不是改数据模型。
- **收益 高 / 成本 中（~1–1.5h 的前端映射 + 文案）/ 风险 中**：风险是动作错配导致误操作，映射表必须显式白名单、未知 kind 只读。

### 不建议在 4 小时内做

- **按住 0.6s 批准**：不是 4 小时的关键路径（没有它首页仍成立），且牵涉桌面/键盘 fallback 与误批风险（3.2-2、3.2-3），建议放到有一整天时连同"批准后会发生什么/可撤销"一起做。
- **删侧栏任务列表 / 删简报页 / 改工作台为异常行**：属于方案 A 的"删除阶段"，需要老板先拍板（UI 文档 `:151` 自己标注了"最需要老板拍板的取舍"），4 小时内不应动，否则会同时动摇现有导航与习惯。
- **复盘时间线/原因分布 UI**：`/api/task-folders/:id/retro` 与 `StateDoc` 已有数据（`server/index.ts:5865-5892`、`server/state-doc.ts:25-105`），可等首页稳定后直接做屏③。

---

## 5. 附：本次实测命令与原始数字

```bash
# 0) 探活 + 数据规模
BASE=http://127.0.0.1:8799
curl -s "$BASE/api/task-folders" -o /tmp/tf.json
curl -s "$BASE/api/inbox"       -o /tmp/inbox.json
curl -s "$BASE/api/dispatch/state" -o /tmp/ds.json
# → tasks=2（done/canceled）、inbox items=0（counts 全 0）、runs=2（done/canceled）、routes=7

# 1) 单端点 5 次（每次 -w 输出 code/time/size），结果见 §2.2
TID=$(python3 -c "import json;print(json.load(open('/tmp/tf.json'))['tasks'][0]['id'])")
for ep in /api/task-folders /api/inbox /api/dispatch/state "/api/task-folders/$TID/state"; do
  for i in 1 2 3 4 5; do
    curl -s -o /dev/null -w "$ep %{http_code} %{time_total} %{size_download}\n" "$BASE$ep"
  done
done

# 2) 10 并发 /api/inbox（结果见 §2.3）
start=$(python3 -c 'import time;print(time.time())')
for i in $(seq 1 10); do curl -s -o /dev/null -w '%{http_code} %{time_total}\n' "$BASE/api/inbox" & done
wait; echo "wall: $(python3 -c "import time;print(time.time()-$start)")"
```

原始摘要：
- `/api/task-folders`：200×5，min 0.86 / p50 0.94 / p95 1.11 ms，1,199 B
- `/api/inbox`：200×5，min 0.48 / p50 0.64 / p95 0.72 ms，71 B
- `/api/dispatch/state`：200×5，min 0.97 / p50 1.15 / p95 1.19 ms，**40,112 B**
- `/api/task-folders/<id>/state`：200×5，min 0.42 / p50 0.74 / p95 1.19 ms，586 B
- 10 并发 `/api/inbox`：10×200，失败 0，墙钟 0.033 s，单请求 0.27/0.38/0.55 ms（min/p50/max）

> 测量限制：数据为空态，结论只说明"服务端不是瓶颈"；v2 上线前若要看有 20–50 条待办的真实表现，需要允许写入测试数据后复测（本轮按"只读"约束未做）。

---

---

## 6. 一页纸给老板

- 你想要的"凌晨手机 5 秒清完"所需的一切**零件**其实都做好了：任务=窗口、完成只读、基于此新建、gate 证据、打回原因、诚实签收句、复盘事实（StateDoc）。
- 缺的只有**入口**：现在要清一件事，得先知道点侧栏哪个入口（Tasks？Needs you？Brief？Workbench？），而且「Needs you」其实有**两套**。
- 4 小时内最值得：**做一个首页，把一句状态句和一张最该处理的卡放上去**（复用现有数据与接口），顺手把已有的 SSE 帧接上让它是实时的，再把两套「需要你」在前端合成一个口径。
- 按住批准很好看，但会放大误批风险，等"批准后会怎样/能否撤回"讲清楚再加。

---

## 7. 审计期间发现的并行未提交改动（不计入上述判定）

审计进行中工作区出现以下**未提交**改动（`git status` 可见；疑似并行 teammate 正在落地 v2）：

| 文件 | 状态 | 内容（已读代码确认） |
|---|---|---|
| `server/index.ts` | modified（+18 行） | 新增 `GET /api/decision-stack`：把 `inbox.list("open")`、`dispatcher.list()`、`taskFolders.list()` 交给纯函数 `buildDecisionStack`；投影失败时返回 `emptyDecisionStack()` 而不是 500（当前 `:5652-5668` 区域） |
| `server/decision-stack.ts` | new（220 行） | 纯函数投影：`DecisionCard{risk, waitedMs, irreversible, approveEffect, actions}`、`DecisionRunning{stalled}`、`statusLine`、`counts`；按「风险 → 等待时长 → id」排序；risk 由 kind + 证据断链/送回次数推导；`STALL_MS=30min` |
| `server/decision-stack.test.ts` | new（157 行） | 6 个用例：风险+等待排序、signoff 置顶与后果文案、证据断链/送回升级风险、30 分钟停滞、空栈、已处理条目不出现 |
| `docs/workbench-v2-spec.md` | new（432 行） | 工作台 v2 规格（值班长模式 + 手机三屏），标注"设计定稿，待老板拍板 3 个取舍" |

对本审计的影响：
- §3/§4 里「首页决策栈」的**后端投影部分已经在等工作区里**（未提交、未接入前端）。若这批改动被采纳，4 小时 MVP 的剩余工作主要是前端：`HomePage` + 路由 + 卡片渲染 + 按住/单击策略（约 2–4h），而不是 3.1 表里的"零后端"。
- 该投影只覆盖 `/api/inbox`（gate/signoff/question/failed_exhausted），**不包含** `/api/brief` 的 org 层 needsYou（choice/approval/escalation）——§1.2② 的"两套需要你"问题依然存在，且新首页会继承这个缺口。
- 新 route 的返回形状（`stack.statusLine/cards/running/counts`）正好可直接驱动 UI 文档屏①；`DecisionCard.approveEffect` 已包含"批准后会发生什么"的文案，风险 4（误批）可缓解。按住确认尚未实现（`irreversible` 字段已预留）。
