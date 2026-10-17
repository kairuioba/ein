# 一念 Ein 公司层与派单架构深度分析（v1.1.2）

> 分析对象：`main` `38aa642`（v1.1.2），只读分析，2026-10-17。
> 分析方式：直接读源码 + 测试，不采信 `docs/` 的转述；每条结论标注 `file:line`。
> 范围：`server/org/*`、`server/dispatch.ts`、`server/dispatch-diagnose.ts`、`server/dispatch-api.ts`、`server/chief-of-staff.ts`、`shared/org-types.ts`、`shared/dispatch-types.ts`、`src/state/org-api.ts`、`src/components/workbench/*`、`src/components/chat/ResultCards.tsx`，以及它们在 `server/index.ts` 的接线。
> 文末第 8 节单列"文档与实现不一致/已过时"。

---

## 0. 结论摘要（TL;DR）

1. **"公司层"不是独立服务、也不是独立调度器。** 它是三样东西的薄组合：一个纯内存状态机 `Dispatcher`（派单）、一个只读投影 + 若干小型文件子系统 `OrgLayer`（简报/决议/收件箱/花费/资料库/审批过期/汇报节奏），以及前端轮询缓存（`server/dispatch.ts:382`、`server/org/layer.ts:55`、`src/state/org-api.ts:90`）。
2. **"总控拆单"是模型的一次工具调用，不是规划器。** 主 Bot 调 `submit_plan` 提交一张 DAG，harness 负责校验、选人、并行、依赖、重试、汇总（`server/drivers/agents-proxy.ts:270-306`、`server/dispatch.ts:193-272`、`server/dispatch.ts:1042-1086`）。拆单质量取决于模型与提示词（`server/chief-of-staff.ts:88-102`），代码里没有第二层规划算法。
3. **`org.json` 不是数据库，是给 UI 和 dispatch 各自读的配置快照，而且被两套解析器分别解释**：`server/org/config.ts:219-247`（zod，权威、可写）与 `server/dispatch.ts:331-361`（手写容错，只读、字段子集）。"谁是主 Bot"有 **三套不一致的解析**（见 §2.5），这是本次分析发现的最直接的一致性风险。
4. **公司规则大多是"建议/展示/诊断"，不是硬约束。** 真正的执行点只有五个：对外发布永远要 owner（`server/auto-approve.ts:107-113, 213-229`）、无人值守审批过期（`server/org/layer.ts:431-474`）、资料库隔离（`server/org/layer.ts:340-348, 409-415`）、部门"零应用"时不再挂载连接应用（`server/index.ts:2638-2643, 3505-3510`），以及 `chiefMay.addPeople/newSpecialist`（且后者只在派单路径生效）。决策权矩阵、项目组、编制、部门日预算、私有目录、span of control 在服务端都没有执行逻辑（逐项证据见 §2.4、§2.6）。
5. **单进程内存是唯一权威状态**：`watch`/`synthesisWatch`/`escalated`/`expiry`/`autoApproved`/`unattendedBots`/`askMessageByRequest` 都在进程内（`server/dispatch.ts:386-388`、`server/org/layer.ts:62-74`、`server/index.ts:1402`）。落盘的只有少量快照/日志文件（§1.3）。重启恢复是"猜"出来的，且恢复动作不产生任何公司事件（§3.9）。
6. **前端完全靠轮询驱动公司层视图**：`/api/dispatch/state`（工作台 2s、聊天 4s）、`/api/brief` 5s、`/api/org` 15s、`/api/org/events` 5s、`/api/library` 10s……（§5.6 表）。SSE 里虽然广播了 `dispatch.run`/`dispatch.routes`（`server/index.ts:2214-2218`），但 `src/` 全仓没有任何消费者；公司事件日志的 `onEvent` 监听器从未被注册（`server/org/events.ts:79-82`）。所谓"实时事件"实际是轮询差价。
7. **事件/简报、决议/审批、花费三条审计链基本自洽，但覆盖口径有截断**：事件内存只留 500 条、`changes` 只取 50 条、auto 审批每 bot 每 15 分钟才记一条事件（`server/org/events.ts:14`、`server/org/brief.ts:46-49`、`server/org/layer.ts:52-53, 239-243`），"自上次查看"在长离线/大量 auto 审批时会丢信息。
8. **文档对"哪些能力已生效"系统性乐观**：`docs/company-layer.md` 把决策权矩阵、预算线、编制写成规则，`docs/dev-edition-plan.md:29` 的 8 个设计缺口清单至少 1 条已被实现、2 条部分实现，但清单仍写"未改"；且文档基线 commit 落后 4 个提交（详见 §8）。

---

## 1. 系统全景

### 1.1 两个核心对象与启动顺序

| 对象 | 文件 | 构造点 | 职责 |
|---|---|---|---|
| `Dispatcher` | `server/dispatch.ts:382-1565` | `server/index.ts:2143` | 派单状态机：计划/DAG/选人/造人/并行/重试/汇总/加人/路由 |
| `OrgLayer` | `server/org/layer.ts:55-599` | `server/index.ts:4616` | 公司层门面：org 配置、事件、决议、收件箱、简报、花费、资料库、审批过期、汇报节奏 |
| `OrgEventLog` | `server/org/events.ts:18` | `server/index.ts:4612` | 公司事件 append-only 日志 + 内存窗口 |
| `useApi` 轮询缓存 | `src/state/org-api.ts:90-116` | 前端各页面 | 每 URL 一个请求、多组件共享、聚焦重取 |

启动顺序是理解若干行为的关键：

```
store 载入（bot 的 busy/activity 复位）        server/store.ts:633-638
→ dispatcher = new Dispatcher(...)             server/index.ts:2143
→ dispatcher.load()（重写内存里被中断的 run）   server/index.ts:2221 → server/dispatch.ts:404-444
→ 3s 后 dispatcher.resumeAll()                 server/index.ts:2222
→ orgLayer = new OrgLayer(...)                 server/index.ts:4616
    └─ 构造器里 runWatch.seed(host.runs())      server/org/layer.ts:86
→ !VITEST 时 orgLayer.startCadence()            server/index.ts:4645
→ HTTP listen 127.0.0.1                        server/index.ts:8534
```

`Dispatcher.broadcast` 在构造时闭包引用了 `orgLayer`（`server/index.ts:2214-2218`），调用发生在模块求值之后，因此不触 TDZ；但这决定了 **`load()` 的状态修正发生在 `OrgLayer` 和 `RunWatcher` 存在之前**，否则重启会重放一堆假事件——代价是这些修正永远不会产生事件（§3.9）。

### 1.2 进程拓扑

```
Electron 主进程 ──spawn──> harness server (127.0.0.1:PORT, server/index.ts:8534)
   │                          ├─ store（bot/群/transcript，独立子系统）
   │  SSE /api/events ────────┤    └─ 对话流、turn 生命周期（公司层只读）
   │                          ├─ Dispatcher（内存 run 状态机；写 dispatch-runs.json）
   │  轮询 /api/dispatch/* ───┤    └─ 派生子任务 turn（bot provider）→ 回调 onTurnSettled
   │  轮询 /api/brief 等 ─────┤
   │                          └─ OrgLayer（run-events / brief / inbox / decisions / usage）
   │                               ├─ 读 store 的 bot/group/messages（OrgHost 接口 layer.ts:25-49）
   │                               └─ 写 org.json / org-events.ndjson / org-decisions.json / ...
   └─ React 渲染（workbench/brief/chat cards 各自轮询）
```

注意：**公司层从不直接调用模型**。所有"动作"都通过三个接口进入既有 harness：`Dispatcher.startTurn`（`server/index.ts:2159-2185`）、`host.say/chip`（`server/index.ts:4623-4625`）、HTTP 路由（`server/org/api.ts`、`server/dispatch-api.ts`）。

### 1.3 持久化面

| 文件（DATA_DIR 下） | 写入者 | 形态/上限 | 读回用途 |
|---|---|---|---|
| `org.json` | `OrgConfigStore.patch`（`server/org/config.ts:383-385`，atomic 0600） | 单 JSON，字段级容错 | UI 公司设置、dispatch 规则快照 |
| `dispatch-runs.json` | `Dispatcher.saveRuns`（`server/dispatch.ts:446-459`） | 单 JSON 全量重写；`MAX_RUNS=60`、完成态留 14 天（`:368-369`） | 重启恢复、工作台 |
| `dispatch-routes.json` | `saveRoutes`（`:461-467`） | 单 JSON | 派发通道 |
| `org-events.ndjson` | `OrgEventLog.append`（`server/org/events.ts:52-77`） | 追加 + 2MB 轮转；内存窗口 500 条（`:12-14`） | 时间线、"自上次查看" |
| `org-decisions.json` | `OrgDecisionStore.save`（`server/org/decisions.ts:127-136`） | 单 JSON；最多 1000 条（`:17-18`） | 决议 #n、行动项 |
| `org-cadence.json` | `CadenceStore.set`（`server/org/cadence.ts:74-82`） | 单 JSON | 日报/进度是否已发 |
| `usage-ledger.ndjson` | `UsageLedger.record`（`server/org/usage.ts:80-106`） | 追加 + 4MB 轮转；内存 8 天（`:15-18`） | 今日/本周花费 |
| `library/<id>/meta.json` + `v<n>.md` | `LibraryStore.publish`（`server/org/library.ts:144-188`） | 每版一个文件，永不改写 | 资料库/提示词注入 |
| 决策日志（`server/decision-log.ts`） | `appendDecision` 包装（`server/index.ts:4650-4653`） | 追加 | 审批审计、autoApproved 列表 |

### 1.4 一次"公司任务"的完整数据流

```
用户 → 主 Bot 对话
  └─ 主 Bot 调 submit_plan（tool）                     agents-proxy.ts:270-306
      └─ POST /api/internal/dispatch/plan              dispatch-api.ts:135-156
          └─ Dispatcher.submitPlan                      dispatch.ts:590-744
              ├─ 校验 DAG / 名字 / assignee              dispatch.ts:193-246, 619-644
              ├─ 选人 / 预创建专员（planned: 占位）       dispatch.ts:626-699
              ├─ 计划整体通过后才真正 createBot + 路由    dispatch.ts:700-716
              └─ run.status = running|awaiting-approval  dispatch.ts:719-730
                  └─ queueMicrotask(pump)               dispatch.ts:742
                      └─ 逐个 startSubtask              dispatch.ts:1088-1130
                          ├─ createTask（独立会话）
                          ├─ startTurn(workerPrompt)    index.ts:2159-2185
                          └─ onTurnSettled 回调         dispatch.ts:886-957
                              ├─ 成功 → done + result
                              ├─ 失败 → pending 重试（maxAttempts）
                              └─ 全部 settled → synthesizing → 主 Bot 汇总 turn
                                  └─ finishRun → run.done     dispatch.ts:1218-1256
```

同时，`host.broadcast(run)`（`server/index.ts:2214-2218`）触发 `orgLayer.onDispatchRun`，由 `RunWatcher.diff` 把状态迁移翻译成公司事件（`server/org/run-events.ts:70-166`），写 `org-events.ndjson`；前端再通过轮询把事件、简报、run 状态取走。

---

## 2. 公司数据模型：`org.json` 与"部门 = 侧边栏分组"

### 2.1 类型与默认值

设计约束写得很清楚：部门不是团队的副本，一个部门就是 `bot.section` 字符串，主管就是该分组的 `bot.chiefOfStaff`；`org.json` 只存字符串说不出来的东西（`shared/org-types.ts:5-25`）。

- `OrgDepartment`：`section/color/headcount?/budgetPerDay?/isolated?/allowedApps?/privateFolder?`（`shared/org-types.ts:10-25`）。
- `OrgProject`（矩阵项目组）：`id/name/leadBotId?/memberBotIds/until?`（`:27-36`）。
- `DecisionRight`：四级 `employee|lead|chief|owner`，`suggest` 为可提议级别，`locked` 不可被 bot 改（`:38-49`）。
- `OrgRules`：span、升级分钟、`chiefMay` 三项、公司日预算、对外发布锁定 true、无人值守过期分钟、汇报节奏（`:51-65`）。
- 默认值：`spanOfControl=5`、`escalateAfterMin=10`、`budgetPerDay=60`、`unattendedExpiryMin=10`、`reportCadence={everyHours:2,onDone:true,onIncident:true,dailyBriefAt:"18:00"}`（`:78-86`）。

### 2.2 读路径：存储配置与活 roster 合并

`OrgConfigStore.get(bots)`（`server/org/config.ts:311-323`）并不是返回文件，而是"存储配置 + 活 roster"合并后的视图：

1. `resolveChief`：配置的 chief 仍可见则用之，否则无 section 的 chiefOfStaff（`:260-267`）。
2. `mergeDepartments`：先按存储顺序，再按 `oldestFirst(bots)` 把每个可见 bot 的 section 追加进来；颜色缺省按位置取调色板，若已被占用则找第一个空位（`:269-290`）。
3. 其余字段深拷贝返回（`:314-322`）。

意义：**部门可以只是 `bot.section`，不需要先在设置里创建**；`org.json` 里的 `departments` 是"覆盖层"。副作用是 `config.departments` 的数量/顺序同时受 roster 影响，UI 与 dispatch 各自计算（见 §2.5）。

### 2.3 写路径：patch 校验、锁定行、原子写

- `PATCH /api/org` 接受五个字段的子集：`chiefBotId/departments/projects/rules/decisionRights`（`server/org/config.ts:99-105`）。
- 数组是**整体替换**，`rules` 是字段级合并（`:107-109`、`:155-165`）。
- `externalPublishNeedsOwner` 客户端可以回传但服务端永远强制 true（`:78-79`、`:161`）。
- 锁定行：`keepLocked` 保证锁定的决策权行任何 patch 都不能改/删，删了会插回原位（`:185-194`、`:237`）。
- `parseStoredOrg` 对损坏文件逐字段降级，而不是整份丢掉（`:219-247`）；`lenientRules` 一个坏字段只回退该字段（`:207-215`）。
- 写：`writeFileAtomic`，mode 0600，更新内存缓存（`:383-386`）。
- 校验失败抛 `OrgConfigError`（status 400，`:121-123`），由 `server/org/api.ts:102-105` 转成 HTTP。

### 2.4 字段 → 真实消费点矩阵（"写进 config" ≠ "生效"）

| 字段 | 服务端真实消费点 | 硬约束？ |
|---|---|---|
| `chiefBotId` | UI/简报/节奏判断、dispatch 跨部门（`server/org/layer.ts:479-487`、`server/dispatch.ts:498-501`） | 部分（见 §2.5 三套解析） |
| `departments[].section` | 一切按 section 分组的读模型（`config.ts:269-290`、`brief.ts:143-208`） | 是（字符串即分组） |
| `departments[].color` | 仅展示（`server/org/brief.ts:200`、`src/lib/org.ts:63`） | 否 |
| `headcount` | **仅前端警示**：`overHeadcount`（`src/components/settings/org-model.ts:125`）；`Dispatcher` 读进快照（`server/dispatch.ts:324, 356-357`）但仓库内无读者 | 否 |
| `budgetPerDay`（部门） | 仅"加人诊断"的预算余量（`server/dispatch.ts:1326-1334` → `server/dispatch-diagnose.ts:596-607`）与展示（`src/components/settings/OrgSection.tsx:390-391`） | 否（普通回合不检查） |
| `isolated` | 仅资料库：提示词过滤（`server/org/layer.ts:340-348`）与订阅拒绝（`:409-415`） | 仅资料库域 |
| `allowedApps` | 挂载 gate：空数组时完全不挂载连接应用（`server/index.ts:2638-2643`、`3505-3510`）；非空时只靠提示词收敛（`server/org/layer.ts:363-369`） | 一半（"零"是硬 gate，"部分"是提示词） |
| `privateFolder` | 仅设置页展示（`src/components/settings/OrgSection.tsx:380-383`）；无任何文件系统接线 | 否 |
| `rules.spanOfControl` | UI 分队（`src/components/settings/org-model.ts:199-210`）、新人小队规模（`server/dispatch-diagnose.ts:545-547`）、加人跨度（`server/dispatch.ts:1415`） | 否（不限制既有主管人数） |
| `rules.escalateAfterMin` | 升级规则（`server/org/layer.ts:503-552`）、简报风险（`server/org/brief.ts:83,121-135`）、收件箱（`server/org/inbox.ts:60-72`） | 是（只影响"上报"，不影响停止） |
| `rules.chiefMay.addPeople` | 仅 chief 发起的加人（`server/dispatch.ts:1386-1397`）；owner 加人不受限（`:1376-1378` 注释） | 是（限 chief） |
| `rules.chiefMay.newSpecialist` | 仅派单自动造人（`server/dispatch.ts:638-644`）；`create_bot` 工具与 `/api/internal/create-bot` **不受约束**（`server/index.ts:5259-5324`） | 一半 |
| `rules.switchModel` | 存储 + 设置页/审批提示展示（`src/components/settings/review-model.ts:141`）；**派单没有自动换模型执行点**（换模型只走 owner 的 `chooseModel`，`server/dispatch.ts:1165-1216`） | 否 |
| `rules.budgetPerDay`（公司） | 用量摘要展示（`server/org/usage.ts:139-145`）与加人诊断（`server/dispatch.ts:1333`） | 否 |
| `rules.unattendedExpiryMin` | 无人值守审批过期（`server/org/layer.ts:436-445`） | 是 |
| `rules.reportCadence` | 日报/进度（`server/org/cadence.ts:45-53` → `server/org/layer.ts:557-591`） | 是（定时器） |
| `decisionRights` | **仅存储与设置页矩阵**（`server/org/config.ts:36-45, 311-323`、`src/components/settings/OrgSection.tsx:201`）；服务端零消费 | 否 |
| `projects` | **仅存储与设置页**（`server/org/config.ts:142-147, 362-371`、`src/components/settings/OrgDialogs.tsx:345-367`）；无路由/队列/解散逻辑 | 否 |

结论：`org.json` 目前更像"公司层 UI 的状态 + 派单的几个参数"，而不是"公司治理的规则引擎"。

### 2.5 "谁是主 Bot"有三套解析（一致性缺陷）

| 解析器 | 位置 | 逻辑 |
|---|---|---|
| A. 配置视图 | `server/org/config.ts:260-267`（`resolveChief`） | 配置的主 Bot 可见 → 无 section 的 chiefOfStaff → 否则 undefined |
| B. 公司层 | `server/org/layer.ts:479-487`（`chief()`） | A 的前两步之后，再兜底"任意可见 chiefOfStaff" |
| C. 派单 | `server/dispatch.ts:498-501`（`isOrgChief`）+ `:359-360`（读原始文件） | 只认 `org.json` 里字面存在的 `chiefBotId`，无任何兜底 |

后果（可复现路径）：当 `org.json` 缺失/损坏/主 Bot 被删除，但工作区里存在无 section 的 chiefOfStaff 时——

- `GET /api/org` 与简报会把该 bot 视作主 Bot（A/B），`layer.tickCadence` 会把日报发给它（B）；
- `Dispatcher` 却认为"没有公司主 Bot"（C）：`team()` 不会扩到各部门主管、`chiefContext` 不返回 departments、`mayPlan` 恒 false（`server/dispatch.ts:511-528, 532-545, 547-553`），跨部门两级派单静默失效；
- 传给该 bot 的 system prompt 也按"某个 section 的总控"生成（`server/index.ts:2841-2842, 2877-2887`）。

这是一个"UI 说有总控、派单不认"的分裂，比字段未实现更危险，因为它没有报错、只表现为能力降级。

### 2.6 决策权矩阵与项目组：数据存在、运行时缺席

- `decisionRights` 的默认表与 UI 矩阵都在（`server/org/config.ts:36-45`、`src/components/settings/org-model.ts:26-74`、`OrgSection.tsx:201`），但**服务端没有任何执行点**（全仓 grep 仅 config/UI/test 命中）。`OrgDecision.decidedBy` 在创建时默认 `"owner"`（`server/org/decisions.ts:158`），而唯一的决议创建入口 `OrgLayer.onOptionsAnswered` 从不传 `decidedBy`（`server/org/layer.ts:298-306`）——所以**所有决议都是"老板拍的"**，"决策人"字段没有信息量。
- `OrgProject` 只在设置里可增删改（`src/components/settings/OrgDialogs.tsx:345-367`），`until` 到期无人解散，成员关系不进入派单候选队列（dispatch 只用 section/route，`server/dispatch.ts:511-528`）。
- 这两个特性在 `docs/company-layer.md:13,24` 被写成"公司规则/决议"的一部分，但实际是**设置页的展示型数据**。见 §8。

---

## 3. 派单引擎 `server/dispatch.ts`

### 3.1 状态机

`RunStatus = awaiting-approval | running | synthesizing | done | failed | canceled`，`SubtaskStatus = pending | running | done | failed | skipped | canceled`（`shared/dispatch-types.ts:72-73`）。

| 迁移 | 触发点 |
|---|---|
| 创建 run：`awaiting-approval` 或 `running` | `submitPlan`（`server/dispatch.ts:719-730`，取决于 `settings.requireApproval`） |
| `awaiting-approval → running` | `approve()`（`:799-807`），owner/UI 或 inbox 的 `runId` 入口 |
| `running → synthesizing` | 所有子任务 settled 且至少一个 done 且 `autoSynthesize`（`:1070-1076`） |
| `running → done/failed` | 同上但 `autoSynthesize=false` 或无 done（`:1074-1081`） |
| `synthesizing → done` | 主 Bot 汇总 turn settle（`:1247-1256`）；汇总 turn 起不来则 done 无报告（`:1237-1245`） |
| 任意活动态 → `canceled` | `cancel()`（`:809-834`），递归取消 child run |
| 子任务 `running → pending`（重试） | `onTurnSettled` 失败且未到 `maxAttempts`（`:944-947`） |
| `failed/canceled → pending` | `retry()`（`:837-866`）＋`reopen()`（`:871-882`） |
| 依赖失败 → `skipped` | `skipBlocked`（`:1631-1649`） |

### 3.2 计划校验（DAG）

`validatePlan`（`server/dispatch.ts:193-246`）是手写的归一化 + 校验，不依赖 zod：

- `goal` 必填、≤2000 字；`subtasks` 接受数组或 JSON 字符串；数量受 `settings.maxSubtasks` 限制（`:194-207`）。
- 子任务：`id` 归一化/去重/正则；`title`+`brief` 必填；`needs` 白名单（8 种 capability）；`depends_on`/`dependsOn` 兼容；`difficulty` 1–5；`assignee/bot_id` 可选（`:210-236`）。
- 未知依赖、自依赖、**环检测**（`findCycle`，`:248-272`）。
- `MAX_PLAN_SUBTASKS=30` 是全局上限（`shared/dispatch-types.ts:47`），`dispatchSettings` 把 `maxSubtasks` 钳到 `[1,30]`（`:60-61`）。

### 3.3 选人：三种路径，全部在 harness 里

`team(chiefId)`（`server/dispatch.ts:511-528`）决定可派对象：

1. 默认：同 section 的可见成员；
2. 显式路由：`dispatch-routes.json` 中 `enabled` 的任意部门 bot（`server/dispatch.ts:516-527`）；
3. 被 `enabled=false` 的显式路由会**从默认同 section 集合里移除**（`:521-526`）——也就是工作台"拔线"的语义。

选人优先级（`server/dispatch.ts:626-699`）：

| 情况 | 行为 |
|---|---|
| 计划指定了 `assignee` | 按 id/名字找；org chief 还可以写部门名（`findAssignee`，`:746-752`）；找不到 → 整份计划拒绝并回传可读错误（`:629-631`） |
| 没指定，有人匹配 | 角色相似度匹配（`roleSimilarity`，`:299-313`；`REUSE_THRESHOLD=0.34`，`:315`）；忙碌 −0.1、本计划已分配 −0.05/个（`:782-785`）；org chief 用"部门整体匹配度"（`departmentFit`，`:756-765`） |
| 没人匹配、`autoCreate` | 先在内存里造 `planned:` 占位专员（`PLANNED_PREFIX`，`:1690`），用推荐模型（`:654-670`）；**整份计划验证通过后才真正 `createBot` 并自动加一条显式路由**（`:700-716`） |
| 没人匹配、`autoCreate=false` | 拒绝计划（`:635-637`） |
| 造人受限（规则/上限） | 退化为"现有团队里最闲的人"（`leastLoaded`，`:790-795`） |

"先占位后落地"是为了避免被拒的计划留下一堆孤儿专员（注释 `:650-654`），是正确的设计；但**真正 `createBot` 之后、`saveRuns` 之前若抛异常，仍可能留下无主专员**（`:702-715` 无回滚/事务）——概率低，但值得注意。

### 3.4 执行：`pump` 的一段循环

`pump(runId)`（`server/dispatch.ts:1042-1086`）是整个派单的心跳，只在状态迁移时被调用（`queueMicrotask`、审批、settle、idle、重试、重启恢复），没有常驻 scheduler：

1. `skipBlocked(run)` 先把依赖失败/跳过的子任务标 skipped（`:1046-1047`）。
2. 并发上限 `cap = max(settings.maxConcurrent, run.maxConcurrent ?? 0)`（`:1048-1049`）；`run.maxConcurrent` 是中途加人后抬高的单 run 上限（`:1467`）。
3. 依次找 `pending` 且依赖全部 `done`、assignee 存在、bot 不忙、同一 bot 没有其他在跑子任务（`:1051-1066`）。
4. `startSubtask`：`createTask` 建独立会话 → 写 `watch` → `startTurn(workerPrompt)`；启动失败（同步或 setup 失败）也走 `onTurnSettled`，因此重试/依赖跳过规则统一（`:1088-1130`）。
5. 全部 settled：任一 done 且有 `autoSynthesize` → `synthesizing`；有 done 但关汇总 → done；无 done → failed（`:1070-1081`）。

`workerPrompt`（`:1577-1611`）给 worker 的是：全局 goal、自己的 brief、验收标准、依赖子任务的结果（截断 3000 字符，`RESULT_CONTEXT_CHARS`，`:366`）、小队入职包；并明确"自己做完、回复完整结果"。

### 3.5 尝试、重试与依赖跳过

`onTurnSettled(threadId, ok, reply, reason)`（`server/dispatch.ts:886-957`）是所有 worker/汇总 turn 的唯一汇合点：

- `reason === "rate_limited"` → 记录限流时间（`:899-902`、`noteRateLimit` `:969-971`，最多 20 条）。
- owner 主动停止（`interrupted/cancelled/canceled`）→ 子任务 `canceled`，永不自动重试（`isStopReason` `:377-380`、`stopSubtask` `:974-980`）。
- 有 child run（部门主管二次派单）→ 按 child 结果结算或等待（`:907-924`）。
- `ok && reply` → done，result 截断 6000 字符（`:932-940`）。
- 否则：未到 `settings.maxAttempts` 且 run 仍 running → 回 `pending` 触发重试；到上限 → failed（`:941-954`）。
- 汇总 turn 的 settle 走另一分支（`:886-891` → `onSynthesisSettled`）。

失败一定会触发 `pump`，而 `skipBlocked` 会把依赖链上再也跑不了的子任务标 skipped（`:1631-1649`），所以在 harness 层不会出现"一个失败把整条 DAG 卡死"。另有独立 watchdog 兜底卡死 turn：20 分钟无活动则 interrupt 并 `dispatcher.onTurnSettled(...,"stalled")`（`server/index.ts:1245-1267`）。

### 3.6 汇总回合

全部结束后 `startSynthesis`（`server/dispatch.ts:1218-1233`）在**主 Bot 的源会话里**发起一个 `continuation: true` 的 turn（不是新任务），prompt 列出每个子任务的结果/失败原因（`:1530-1553`），要求输出一份合并交付物，并明确"本 turn 不要再派单"。

- 主 Bot 忙 → 直接返回，等 `onBotIdle` 再触发（`:1224`）。
- 汇总 turn 起不来 → `onSynthesisFailed` 把 run 标 done、在源会话留一行"去工作台看结果"（`:1237-1245`）。
- 汇总成功 → `run.report`（截断 6000）＋ done（`:1247-1256`）。
- `autoSynthesize=false` → 跳过汇总直接 done（`:1070-1076`）。

设计要点：**report 是"锦上添花"，run 的完整性不依赖它**；但反过来，报告内容没有与子任务交付物做程序化核对（见 §7 R1 与 `docs/dev-edition-plan.md:28` 记录的真实观察）。

### 3.7 跨部门两级派单（公司层的核心增量）

这是公司层给 dispatch 增加的最重要能力，规则很窄：

- **只有"org chief 的顶层 run"里的"部门主管子任务"可以二次派单**：`mayPlan(run, subtask)` 要求 run 无 `parentRunId`、`isOrgChief(run.chiefBotId)`、assignee 是该部门主管（`server/dispatch.ts:547-553`）。
- 主管的 worker turn 挂的是 `dispatchOnly` 集成：`submit_plan + list_bots`，没有 delegate/ask/create 等（`server/index.ts:2859-2867`；提示词 `server/chief-of-staff.ts:74-76`）。
- 主管 `submit_plan` 时通过 `watch` 反查父 run/subtask，校验归属和 `mayPlan`，再创建 child run 并回写 `parentRunId/parentSubtaskId`（`server/dispatch.ts:597-618, 729-741`）。
- 父 run 的该子任务保持 `running`（container），直到 child run 结束；`finishRun` 反向结算父任务（`:1260-1270, 1272-1301`）：child done → 用 child.report 或 teamDigest 作为结果；child canceled → 父任务 canceled；child failed → 父任务 failed。
- 每个 chief（含主管）最多 2 个未完成 run（`MAX_ACTIVE_RUNS_PER_CHIEF=2`，`:368-371`、`:615-618`），防止主管无限套娃；主管的 worker 本身没有 agents 工具，第三层不存在（`MAX_COMMS_DEPTH=1`，`server/index.ts:329`）。
- 主 Bot 的提示词会额外给出 departments 清单（`server/chief-of-staff.ts:104-113`），`list_bots` 也会带部门表（`server/drivers/agents-proxy.ts:505-522`）。

### 3.8 中途加人（squads）

流程：owner 打开工作台"加人" → `POST /diagnose` → 看四个检查 → `POST /amend`。核心逻辑在 `server/dispatch-diagnose.ts`：

- **四个检查**（`diagnoseRun`，`server/dispatch-diagnose.ts:426-660`）：
  1. waiting：剩下的是否在等依赖/等 owner 审批（`approvals` 用 bot.activity === "waiting-on-you" 识别，`:438-457`）；
  2. parallel：未开始且依赖已满足的工作量（`:460-476`）；
  3. capability：返工率是否过高（`:479-505`，`REWORK_LIMIT=0.25`）；
  4. rateLimit：15 分钟内的限流次数（`:507-522`，`RATE_LIMIT_WINDOW_MS=15min`）。
- 任一项否决就返回 `add-wont-help` + 人话原因（`:526-534`）。
- 通过后按"部门主管的活不能被外人接"排除（`keep`，`:536-538`），再按 span/房间容量限制人数（`:543-547`），用观察到的子任务耗时做 makespan 模拟（`planSquad`，`:312-420`；队规模按 `GAIN_SHARE=0.9` 选，`:566`），估算成本并把"今天该预算线已花"计入（`:582-600`），超预算先缩小队（`:603-607`）。
- `amend`（`server/dispatch.ts:1379-1487`）：
  - `by:"chief"`：校验是本 run 的 chief、`chiefMay.addPeople`、重新诊断、预算内（`:1386-1397`）；
  - `by:"owner"`：跳过诊断/预算，只受"最多还剩几个待开始任务"与 workspace bot 上限约束（`:1376-1378` 注释，`:1455-1465`）；
  - 建人：模型用推荐器（回退到 chief 的模型），**加入被接手子任务所在部门**，并自动 `setRoute(chief, newBot)`（`:1412-1437`）；
  - 按 span 分组为 Squad B/C…，只移动 `pending` 子任务，记录 `etaBefore/etaAfter`（`:1438-1465`）；
  - 抬高 `run.maxConcurrent`（`:1467`），发 `people.added` 事件（`:1473-1481`）；
  - 30 分钟后 `checkReviews` 比较加入前后速度（`:1489-1510`，`REVIEW_AFTER_MS=30min`、`MIN_REVIEW_WINDOW_MS=5min`）；工作台轮询 `/api/dispatch/state` 时顺带触发（`server/dispatch-api.ts:49-58`）。
  - 小队随 run 结束解散（`dissolveSquads`，`:1653-1658`）；**没有撤回接口**（路由表 `server/dispatch-api.ts:26-29`）。

### 3.9 重启恢复：能自愈，但"无事件、丢报告"

`Dispatcher.load()`（`server/dispatch.ts:404-444`）在启动时修正在途状态：

1. `synthesizing && synthesisStarted` → 直接 `done`，`finishedAt` 补当前时间，`dissolveSquads`（`:420-426`）——**正在写的汇总报告被丢弃**，也没有 `run.done` 事件。
2. 子任务 `running`：
   - 若 `childRunId` 指向的 child run **仍未完成** → 保持等待（`:433-434`）；
   - child 已完成 → `settleFromChild(..., quiet=true)`（`:435-437`）；
   - 否则回 `pending`，`error = "Interrupted by a restart"`，保留 attempts（`:439-441`）。
3. `saveRuns()` 落盘；3 秒后 `resumeAll()` 对 `running/synthesizing` 的 run 重新 pump（`server/index.ts:2222`、`server/dispatch.ts:984-989`）。

关键时序缺陷：`load()` 在 `OrgLayer` 构造（`server/index.ts:4616`）和 `RunWatcher.seed`（`server/org/layer.ts:86`）之前执行。因此"running → pending"和"synthesizing → done"这两类状态修正**不会经过 `onDispatchRun → RunWatcher.diff`**，公司时间线上看不到 `run.done`；`org-events.ndjson` 里也永远没有这次完成。这与 `docs/dev-edition-plan.md:29` 的缺口清单一致（该清单说"未改"，核对结论见 §8.2）。

### 3.10 预算与规则在派单中的位置

- `Dispatcher` 自己读一份 `org.json` 快照（`OrgSnapshot`，`server/dispatch.ts:319-361`；mtime 缓存 `:484-495`）：只含 `chiefBotId/rules/spanOfControl/budgetPerDay/chiefMay.*` 与部门的 `budgetPerDay/headcount`。`isolated/allowedApps/reportCadence/unattendedExpiryMin/decisionRights/projects` 一概不读。
- 预算只出现在"加人"路径：部门有日预算用部门线，否则用公司线（`server/dispatch.ts:1326-1334`）；"今天已花"由 `OrgLayer.spentToday` 从用量账本按 section 汇总（`server/org/layer.ts:155-160`），再与"这单剩余工作预计成本"比较（`server/dispatch-diagnose.ts:596-607`）。普通 turn、造人、派单本身都不检查预算。
- `chiefMay.newSpecialist` 只在自动造人分支（`server/dispatch.ts:640-644`）；`chiefMay.addPeople` 只在 chief 加人（`:1388-1390`）。

### 3.11 运行上限与额度表

| 常量 | 值 | 位置 |
|---|---|---|
| 每个 chief 并行 run | 2 | `server/dispatch.ts:371` |
| 保留 run 数 / 完成态保留 | 60 / 14 天 | `server/dispatch.ts:368-369` |
| 计划子任务上限（全局/默认设置） | 30 / 8 | `shared/dispatch-types.ts:47`、`:33-44`、`:60-61` |
| 并发子任务（设置/单 run 可抬高/诊断上限） | 1–8 / ≤16 | `shared/dispatch-types.ts:60`、`server/dispatch-diagnose.ts:38` |
| 每 run 新造专员 | 0–10（默认 4） | `shared/dispatch-types.ts:62` |
| 每子任务尝试 | 1–3（默认 2） | `shared/dispatch-types.ts:65` |
| workspace bot 上限 | 100 | `server/index.ts:330` |
| 子任务结果保留 / 上下文注入 / 示例 | 6000 / 3000 / 1500 字符 | `server/dispatch.ts:365-367` |
| 限流记忆 | 20 条 | `server/dispatch.ts:372` |

---

## 4. 公司层模块 `server/org/*`

### 4.1 `OrgLayer` 的宿主接口

`OrgHost`（`server/org/layer.ts:25-49`）全部由 `server/index.ts:4617-4642` 提供：bot/group/message 读、卡片 patch、对话 chip、run 列表、decision 日志、live request 判定、deny 能力、`say`（日报直接作为 bot 文本消息）。

这体现了整体架构取向：**公司层是一个"只读 store + 少量写回动作"的投影层**，不拥有对话/回合/权限，任何需要"真实动作"的地方都回调 harness（`deny`、`say`、`chip`）。缺点是投影层为了算"简报/收件箱"必须把消息全量扫一遍（见 §7 R4）。

### 4.2 事件（`events.ts` + `run-events.ts` + `approval-events.ts`）

- 事件种类见 `shared/org-types.ts:92-125`（15 种）；其中 `meeting` 只有类型声明、全仓无任何 emit（grep `"meeting"` 只命中类型定义），是预留/死类型。
- `OrgEventLog`：append-only NDJSON、2MB 轮转、内存 500 条、`since(since)` 线性过滤（`server/org/events.ts:32-77`）。**`onEvent` 监听器从未被任何代码注册**（`server/org/events.ts:79-82`；全仓 grep 只有定义），所以事件没有推送链路。
- `RunWatcher` 把 dispatch 的整 run 广播差分成事件（`server/org/run-events.ts:58-166`）：
  - run 首次 running（或从 awaiting-approval 开始）→ `run.started`；本 run 的自动造人 → `people.added`（`:81-114`）；
  - 子任务 failed → `subtask.failed`；回 pending → `subtask.retry`；done → `report`（`:116-148`）；
  - run → done/failed → `run.done`/`run.failed`（`:150-162`）。
  - 启动时 `seed(runs)` 只记快照不产生事件（`server/org/layer.ts:86`），所以重启不重放历史（代价见 §3.9）。
  - 中途加人的 squad 由 `Dispatcher.amend` 自己发 `people.added`（`server/dispatch.ts:1473-1481`），`RunWatcher` 用 `!subtask.squad` 排除二次通告（`server/org/run-events.ts:46-48`）。
- `approval-events.ts` 把决策日志行翻成公司事件（`server/org/approval-events.ts:46-83`）：`approval.requested/auto/resolved/expired`；`question` 类不产生事件（`row.source === "question"` 返回 null，`:57-58`）。auto 审批事件有 15 分钟/ bot 的节流（`server/org/layer.ts:52-53, 239-243`），但 autoApproved 列表仍逐条累积（`:244-250`）。

### 4.3 决议（`decisions.ts` + `layer.onOptionsAnswered`）

- 触发点：owner 在 options 卡片上作答（HTTP `POST /api/bots/:id/messages/:messageId/answer` → `server/index.ts:7226`），以及 provider 侧 answer 行为（`server/index.ts:1170`）。
- 判定：卡片必须有 options、不是 approval、不是 onboarding quiz、没有已关联 decisionId（`isDecisionCard`，`server/org/inbox.ts:98-103`；`layer.onOptionsAnswered` `:287`）。
- 生成：`OrgDecisionStore.create` 从 1 递增、不可复用、持久化（`server/org/decisions.ts:109-168`）；标题/选项都截断 200，options ≤12（`:153-163`）。
- 依据（basis）：`basisFromTexts` 从最近对话文本中识别资料库文档名/链接（`library:<id>?v=3`、`/library/`、标题），最多 8 条（`server/org/decisions.ts:34-76`）；对话 scoped：群聊取最近 30 条、单聊 8 条（`server/org/layer.ts:295-297`）。
- 行动项：`linkRun` 在 run 开始后 30 分钟内、同会话（或同群）的最近决议上挂 action items（`server/org/decisions.ts:20, 178-200`）；`syncRun` 跟随子任务状态（`:202-222`），中途加人也会追加（`:210-219`）。
- 事件：`decision` + `decisionId`（`server/org/layer.ts:310-320`）；`onDispatchRun` 会把 decisionId 贴到该 run 产生的所有事件上（`:270-273`）。

值得注意：**决议只有 owner 作答一种来源**，没有"主 Bot 自己拍板"的路径（`decidedBy` 永远 owner），这与产品文案"四级决策权"不一致（§2.6）。

### 4.4 收件箱（`inbox.ts`）

`collectInbox`（`server/org/inbox.ts:105-189`）从对话现场实时收集三类：

| kind | 来源 | 关键规则 |
|---|---|---|
| choice | 未作答的 options 卡片 | provider 提问需 `isLiveRequest`（进程内仍挂着），否则不列（`:114`）；有 durable 标记的 ask_bot/delegate_bot 例外（`:81-87`） |
| approval | options 卡片中的审批（requestId+tool/routine/skill）或 `awaiting-approval` 的 dispatch plan | plan 卡片带 `runId` 供前端走 approve 接口（`:153-166`） |
| escalation | bot.activity === "waiting-on-you" 且没有卡可答；或"卡到完全没人能解"的 stuck bot | stuck 等级计算（`:46-75`） |

`escalationLadder`（`:33-42`）给出升级路径：本部门主管 → 主 Bot → owner（去重、跳过自己）。注意它只是在"上报"意义上的队列，**并不改变任何执行**。

### 4.5 简报（`layer.brief` → `brief.ts`）

`OrgLayer.brief(since)`（`server/org/layer.ts:173-223`）每次请求实时计算，不落盘：

- 输入：org、bots、groups、runs、`inbox()`、`events.since(min(since, dayStart))`、autoApproved（进程内缓存，`layer.ts:162-171`）、usage、会话状态函数。
- 部门面板（`server/org/brief.ts:138-208`）：按部门聚合**叶子子任务**（主管二次派单的 container 不算，`:85-90`）；无派单工作时退回"今天 owner 发起的对话是否已被回复"（`:151-162`）；health 由 failed/dead → red，waiting/blocked/retry/stuck → yellow（`:166-177`）；status 一句话按优先级选（`:179-193`）。
- 花费：`usage()` → `summarizeUsage`（`server/org/usage.ts:114-153`）。
- 变更/时间线：`changes` = `events.at > since` 的最后 50 条倒序；`timeline` = 今天事件最多 200 条（`server/org/brief.ts:216-221`）。
- autoApproved：今天、最多 50 条、`autoApprovedTotal` 是全量计数（`:223, 232-234`）；expired 来自 `approval.expired` 事件（`:219-223`）。

简报计算量 = 一次 `inbox()` 全消息扫描 + 一次 events 过滤 + usage 过滤 + 部门聚合，**5 秒轮询一次**（§5.6），这是当前公司层最热的读路径。

### 4.6 花费账本（`usage.ts`）

- 每个 settle 的 turn 一行 NDJSON：`{at,botId,costUsd,input,output,cachedInput?}`（`server/org/usage.ts:20-28`）；无价引擎 `costUsd=null`，tokens 仍计（`:133`）。
- 记录点在 `turn.completed`（`server/index.ts:1820-1824`）：bot 或群聊发言者。
- 轮转 4MB → `.1`，内存保留 8 天（`:15-18, 53-76`）。
- 汇总：USD→CNY 默认 7.2（`:18`）；`weekPercent = weekCost/(budgetPerDay*7)`（`:145`）；`byBot` 只含今日（`:130-137`）。

### 4.7 无人值守审批过期（`expiry.ts` + `layer.sweepExpired`）

- 触发条件：`request.opened` 时的 turn 是 unattended（`server/index.ts:1576, 1684-1695`）；unattended 的来源是 webhook turn、或"继承"的派发 turn（`server/index.ts:2486-2487`；派发在 `:2168` 继承 planner 的窗口）。
- 记录：`OrgLayer.trackUnattended` 启动 15s 级定时器（`server/org/layer.ts:421-428`）。
- 到期：`sweepExpired` 对每条过期项再次读卡片确认仍未作答 → `host.deny(...)` → 卡片标 `answered:"expired", dismissed:true` → 对话 chip → 决策日志 `decision:"expired"`（`:431-474`）。
- 边界：`deny` 失败（请求已随 turn 消失）→ 直接跳过，不记为过期（`:448`）——即"过期事件"只覆盖真正被 deny 的那些。
- TTL：`isUnattended` 的窗口是 30 分钟，busy bot 不过期、每次读刷新（`server/index.ts:1402-1422`）。

### 4.8 汇报节奏与升级（`cadence.ts` + `layer.tickCadence/tickEscalations`）

- 60s 定时器（`server/org/layer.ts:490-497`），仅非 VITEST 启动（`server/index.ts:4645`）。
- `cadenceDue`（`server/org/cadence.ts:45-53`）：日报"当天到点且当天没发过"；进度"有活动 run 且距最后一份报告 ≥ everyHours"。
- 日报由主 Bot 在自己会话里 `say` 一条（`layer.ts:573-580`）；进度只发 chip + 事件（`:581-586`）。
- 升级：`tickEscalations`（`:503-552`）每分钟检查所有 `working/busy` bot，以 `workThreads`（含它正在主持的群）最后消息时间为"进展"；每 `escalateAfterMin` 上升一级，在上级会话留 chip + 发 `escalation` 事件；恢复进展则重置（`:547`）。同一阶梯不会重复报（`escalated` map）。

### 4.9 资料库（`library.ts`）

- 目录结构：`library/<id>/meta.json` + `v<n>.md`（`server/org/library.ts:19-23`）；文本上限 200KB（`:21`）、单 turn 注入上限 8KB（`:23`）。
- 发布：owner 或文档 owner bot 才能发新版本（`:155-158`）；版本号单调；先写文本再写 meta（`:181-185`，注释解释了顺序原因）。
- 订阅与注入：`promptFor` 取"订阅且可读"的最新版，按更新时间、预算截断，并记录 `inUse` 版本（`:205-246`）。
- 隔离：`OrgLayer.libraryPrompt` 传 `readable`，把隔离部门文档从别部门 bot 的提示词里剔除（`server/org/layer.ts:340-348`）；owner 直接订阅隔离文档也被 403（`:409-415`）。
- 索引：`summary` 缺省取正文第一行（`:73-80`）；`published` 事件带 docId/version（`server/org/layer.ts:388-402`）。

### 4.10 HTTP 面与鉴权

- 公司 API：`GET/PATCH /api/org`、`GET /api/org/events`、`GET /api/org/decisions`、`GET /api/brief`、`GET /api/usage/summary`、`GET/POST /api/library`、`GET /api/library/:id`、`POST /api/library/:id/subscribe`（`server/org/api.ts:6-17, 44-106`）。
- 派单 API：`GET /api/dispatch/state`、`PUT/DELETE /api/dispatch/routes`、`POST /api/dispatch/runs/:id/{approve,cancel,diagnose,amend}`、`PATCH .../subtasks/:sid`、`POST .../subtasks/:sid/retry`（`server/dispatch-api.ts:49-133`）；内部：`/api/internal/dispatch/{plan,amend,team}`（`:135-211`）。
- 鉴权模型：公网面只绑 `127.0.0.1`（`server/index.ts:8534`）+ loopback 校验（`:4812-4837`）；`/api/internal/*` 额外要求每次启动随机生成的 Bearer token（`server/index.ts:316-322, 4868-4869`），派单内部接口再从 `fromBotId/fromThreadId` 校验发送者身份与线程归属（`server/dispatch-api.ts:135-146`）。
- 也就是说：**owner 身份没有 token，靠"只在本机回环"**。这对单机桌面 app 是合理取舍，但任何把该端口暴露给局域网/代理的改动都会让 `PATCH /api/org`、`approve/amend` 变成无认证写接口——应作为不变量写进文档。

---

## 5. 前端：工作台与派发卡片的数据流

### 5.1 轮询缓存层 `src/state/org-api.ts`

- `useApi(url, fallback, intervalMs)`：每个 URL 一个 `Entry`（data/error/loadedAt/subscribers/timer/inflight），请求合并、卸载时按最短间隔重排、窗口 hidden 时跳过、`focus` 时全部重取（`src/state/org-api.ts:19-116, 77-81`）。
- 写后刷新：`refreshApi(prefix)`（`:84-88`）；`saveOrg` 后同时刷 `/api/org` 与 `/api/brief`（`:145-150`）。
- `getLastSeen/markSeen` 存在 `localStorage["omb.lastSeen"]`，是"自上次查看"的唯一持久化（`:153-171`）；离开工作台/简报页时标记已读（`WorkbenchPage.tsx:50-51`、`BriefPage.tsx:55-56`）。
- 端点 hook：`useOrg` 15s、`useBrief` 5s、`useOrgEvents` 5s、`useDecisions` 10s、`useUsageSummary` 15s、`useLibrary` 10s（`:140-212`）；`useBrief` 把 since 按分钟取整以便共享请求（`:191-195`）。
- **未使用 SSE**：公司数据没有推送消费；`/api/dispatch/state` 的广播帧 `dispatch.run/routes` 在 `src/` 全仓无消费者（grep 命中仅 server/shared）。

### 5.2 工作台模型 `src/components/workbench/model.ts`

`useWorkbenchModel()`（`:124-269`）把 6 个来源合成一个只读模型：

1. store：bots/groups（SSE 实时）；
2. `useDispatchState()`：`/api/dispatch/state` 2s（`:38-63`），包含 runs/routes/settings/teamMap snapshot；
3. `useOrg`：15s；`chiefBot` 解析主 Bot（`src/lib/org.ts:28-35`）；
4. `useBrief(lastSeen)`：5s，提供 inbox/risks/部门统计/时间线；
5. `useUsageSummary` / `useLibrary` / `useDecisions`：展示用；
6. 本地计算：`rooms`（部门→主队/小队）、`states`（每人姿态）、`stats`（部门数字）、`activeRun/title/deadline`。

其中 `rooms` 的拼装（`:146-191`）值得注意：它先按 section 建房间，再把"中途加人产生的小队"（来自 run.squads）作为子房间；否则按 `spanOfControl` 把超编成员切组（`group()`，`:150-167`）。所以**"编制/小队"在 UI 是展示出来的**，与 §2.4 的"服务端不强制"形成对照。

### 5.3 看人 / 看事 / 抽屉

- `peopleStates`（`src/lib/workbench.ts:228-402`）把 bot + 子任务 + 收件箱 + risks 变成 12 种姿态：stuck / waiting / failed / disagree / leading / working / blocked / queued / delivered / done / idle 等；优先级顺序在函数里逐条 if，**同一信息在 UI 有唯一解释**（如 `escalation` 先于 `asking`）。
- `departmentStats`（`:434-473`）优先用 brief 的部门数字，缺失时从 runs 推导；`headcount()`（`:407-417`）给"today"卡计数。
- 看事视图 `WorkbenchCanvas` 用 `layoutTree` 的持久 slot map（`src/lib/workbench.ts:678-797`）保持节点不跳动；`buildWires` 从 routes + runs + delegation snapshot 推出"谁向谁派活"的线（`:957-1013`）。
- `DispatchBoard.RunList`（`src/components/workbench/DispatchBoard.tsx:69-202`）是**派单总览**：只渲染顶层 run（`top = runs.filter(!parentRunId)`，`:75`），每个 run 显示进度/状态/子任务/推荐模型，动作有 Start/Cancel/重试/打开子任务会话/一键采用推荐（`:97-107, 177-191`）。主管的 child run 只在父任务行里以"Team plan done/total"呈现（`:161-173`）。
- `AddPeopleDialog`（`src/components/workbench/AddPeopleDialog.tsx:48-189`）完整复刻诊断→建议→加人的交互：打开即 diagnose（`:69-89`），显示四个检查与"为什么不行"、预算/ETA/沟通线、入职包（`:214-378`），确认后 `amendRun` 并刷新 dispatch state（`:91-108`）。

### 5.4 聊天里的派发卡片

- `ChatView` 对主 Bot / 任意 chief 每 4s 轮询 `/api/dispatch/state`（`src/components/ChatView.tsx:113, 872-876`），用 `runsForThread(runs, bot.threadId)` 取本会话产生的 run，再用 `slotByTime` 按时间插进 transcript（`src/components/chat/chat-model.ts:152-173`）。
- `DispatchRunCard`（`src/components/chat/ResultCards.tsx:37-155`）：goal、状态 pill、进度、参与人、小队、失败数、Start/Cancel、打开子任务会话；底部 `RunModels`（`:162-231`）列出每个子任务的模型/强度推荐，可"采用"或"全部采用"（`applyAllRecommendations`，`src/components/dispatch/SubtaskModel.tsx`）。
- `DecisionCard`（`ResultCards.tsx:233-284`）：会议决议回到群里定位消息。
- 这两类卡片的数据都来自**轮询快照 + 本地槽位计算**，没有增量帧；因此聊天滚动中的卡片位置由 `runsKey` 保证不抖动（`chat-model.ts:208-214`）。

### 5.5 写入路径

| 前端动作 | 请求 | 刷新 |
|---|---|---|
| 学习/修改组织设置 | `PATCH /api/org`（`saveOrg`，`org-api.ts:144-150`） | `/api/org` + `/api/brief` |
| 开始/取消/重试 | `POST /api/dispatch/runs/:id/{approve,cancel}`、`.../retry`（`WorkbenchPage.tsx:96-98`；`ResultCards.tsx:54-64`） | 随后 `refresh()` dispatch state |
| 采纳模型推荐 | `PATCH /api/dispatch/runs/:id/subtasks/:sid`（`SubtaskModel.tsx`） | dispatch state |
| 加人 | `diagnose` + `amend`（`org-api.ts:236-244`） | `/api/brief` + dispatch state |
| 资料库发布/订阅 | `POST /api/library`、`/subscribe`（`org-api.ts:214-233`） | `/api/library` |
| 回答卡片 | 走既有聊天 answer 接口（`OptionCard`/`ChatView`），服务端触发 `onOptionsAnswered`（`server/index.ts:7226`） | 轮询自然收敛 |

### 5.6 轮询节奏总表

| 端点 | 周期 | 消费方 |
|---|---|---|
| `/api/events`（SSE） | 实时 | store（对话/turn），**不含公司层** |
| `/api/dispatch/state` | 2000ms | 工作台 `useDispatchState`（`model.ts:38`） |
| `/api/dispatch/state` | 4000ms | 聊天页 chief 轮询（`ChatView.tsx:113`） |
| `/api/brief` | 5000ms | 工作台、简报页（`org-api.ts:194`） |
| `/api/org/events` | 5000ms | 需要"新事件"的页面（`org-api.ts:199`） |
| `/api/org` | 15000ms | 工作台/设置/聊天（`:141`） |
| `/api/org/decisions` | 10000ms | 工作台/聊天（`:203`） |
| `/api/usage/summary` | 15000ms | 工作台/简报/设置（`:207`） |
| `/api/library` | 10000ms | 工作台/资料库/⌘K（`:211`） |

同一 URL 的并发请求会被 `entries` 合并（`org-api.ts:44-62`），但**不同 URL 之间没有服务端缓存/ETag**：`/api/brief` 5s 一次的代价是每次全量扫消息 + 事件 + usage（§4.5、§7 R4）。

---

## 6. 端到端时序

### 6.1 主 Bot 跨部门拆单

1. 用户向主 Bot 提多步需求；主 Bot 的 system prompt 由 `chiefOfStaffSystemPrompt` 生成，带 departments 清单与"AUTOMATIC DISPATCH"指令（`server/chief-of-staff.ts:88-113`），工具仅在 `chiefOfStaff||isOrgChief` 且 dispatch enabled 时挂载（`server/index.ts:2841-2858`）。
2. 主 Bot 调 `submit_plan`（`agents-proxy.ts:637-655`）→ `/api/internal/dispatch/plan`（`dispatch-api.ts:135-156`）→ `submitPlan`（`dispatch.ts:590-744`）。校验/选人失败会以 200 + 可读错误回到模型，让它改计划（`dispatch-api.ts:149-152`）。
3. 计划被接受：主 Bot 收到 assignments 回执（`dispatch-api.ts:222-234`），提示词要求"用几行告诉用户计划，然后结束回合"（`chief-of-staff.ts:99`）。
4. 子任务 worker 在独立会话运行；结果经 `onTurnSettled` 回到 run。
5. 若某子任务 assignee 是部门主管且是主 Bot 顶层 run：worker prompt 指示它 `submit_plan` 给本部门（`dispatch.ts:1605-1607`）；child run 完成后主管的汇总报告作为父任务结果（`dispatch.ts:1272-1301`）。
6. 全部 settled → 主 Bot 汇总 turn（`dispatch.ts:1218-1233, 1530-1553`）→ `run.report` + done。前端在 2–5s 内通过轮询看到状态与卡片更新。

### 6.2 中途加人

见 §3.8；关键点：**诊断先行、只动未开始、预算在 chief 路径是硬检查、owner 路径可越过预算但越不过"没有可接的活"**。

### 6.3 审批、无人值守与过期

1. provider `request.opened` → 计算 `unattended`（`index.ts:1576`）→ 若 auto 规则可答则代答并写决策日志（`:1583-1625`）。
2. 否则推送 options 卡片；若 unattended，`trackUnattended`（`:1684-1695`）→ 15s 粒度扫描 → 到期 deny + 标记 expired + 决策日志（`layer.ts:431-474`）。
3. 卡片进入收件箱（`inbox.ts:110-151`）与简报 `needsYou`；前端作答走后端既有 answer 路由。
4. 对外发布在 `autoVerdict` 里永远返回 `external-publish` 且无 grant（`auto-approve.ts:189-229`），是唯一"任何模式都不能自动批"的类别。

### 6.4 重启恢复

见 §3.9；一句话：**run 能继续跑，但"重启期间完成的汇总报告"会丢，且这次完成不会出现在公司时间线/事件日志里**。

---

## 7. 架构风险与改进建议（按收益/成本排序）

收益/成本均为 1–5 的粗略估计；成本含改动面、回归风险与测试成本。"收益/成本"排序，括号内为估计值。

| # | 风险 | 收益 | 成本 | 收益/成本 | 建议动作 |
|---|---|---|---|---|---|
| R10 | `pump` 等关键回调没有异常边界，单次异常可击穿事件循环 | 3 | 1 | 3.0 | 给 `pump/onTurnSettled/checkReviews/amend` 加 try/catch + `run.failed` 兜底 |
| R2 | `org.json` 双解析 + 三套"主 Bot"解析 | 5 | 2 | 2.5 | 抽出唯一 `OrgSnapshotProvider`，dispatch 只吃 host 注入 |
| R6 | 内存态是唯一权威、无单实例保护 | 4 | 2 | 2.0 | dataDir 单实例锁 + 启动重建/告警 |
| R1 | 规则"承诺 vs 执行"缺口（decisionRights/编制/预算/create_bot） | 5 | 3 | 1.67 | 先补 create 路径（newSpecialist+headcount），再做预算/决策权审计 |
| R7 | 预算与花费计量口径不统一 | 3 | 2 | 1.5 | 统一汇率配置、标注估算、加 turn 前预算检查（可先 dry-run） |
| R9 | 二级计划（child run）在派单看板不可见、审批路径绕 | 3 | 2 | 1.5 | 看板里嵌套展示 child run + 就地 Approve |
| R3 | 重启恢复无事件、汇总报告丢失 | 4 | 3 | 1.33 | 启动时合成事件 + 汇总 turn 结果持久化 |
| R4 | 事件/简报靠全量轮询、无缓存/增量 | 4 | 3 | 1.33 | SSE 推 `brief.changed`；brief 2–5s TTL 缓存；events 增量游标 |
| R5 | 单文件全量快照 + 同步 IO，随 run 变大线性变慢 | 3 | 3 | 1.0 | 拆 per-run 文件/结果外置、写入 debounce |
| R8 | 事件窗口/变更条数截断，"自上次查看"会漏 | 3 | 3 | 1.0 | 事件保留期上调 + 服务端游标分页 |

### R10. 关键回调没有异常边界（低成本、高性价比）

`Dispatcher.pump` 由 `queueMicrotask(() => this.pump(run.id))` 触发（`server/dispatch.ts:742, 805, 864, 915, 928, 956, 1008, 1030, 1083`），函数体内没有任何 try/catch；`host.bot/createTask/startTurn` 等宿主方法的异常会直接在微任务里抛出。`server/index.ts` 没有注册 `process.on("uncaughtException"/"unhandledRejection")`（全文件 grep 无命中）。同类风险也存在于 `checkReviews`（由 HTTP handler 直接调用，`server/dispatch-api.ts:51`）与 `amend`。建议：

1. 在 `pump`/`onTurnSettled`/`onSynthesisSettled`/`amend`/`checkReviews` 外层统一 try/catch，异常时把当前 run/subtask 标 failed 并发 `run.failed`/`subtask.failed` 事件（保持"UI 一定看得到失败"的产品承诺）；
2. 增加进程级兜底记录（即使是 Electron 主进程重启，也让用户看到"服务异常退出"而不是黑屏）。

### R2. 两套 `org.json` 解析 + 三套 chief 解析（低成本、最高确定性收益）

证据见 §2.5、§3.10。具体分歧：

- 字段集不同：`server/org/config.ts:219-247` 容错全部字段；`server/dispatch.ts:331-361` 只读 `chiefBotId/rules.spanOfControl/budgetPerDay/chiefMay/departments.{budgetPerDay,headcount}`，`isolated/allowedApps/reportCadence/unattendedExpiryMin/decisionRights/projects` 丢失；
- 默认值不同：dispatch 对 `spanOfControl<2` 回退默认（`dispatch.ts:341`），config 的 zod 是 `min(1)`（`config.ts:72`）；
- chief 解析不同（§2.5）：A/B/C 三处，C 无兜底。
- 缓存不同：config 是进程内缓存（首读/写后更新，`config.ts:294-303`），dispatch 按 mtime 重读（`dispatch.ts:484-495`）。外部修改 `org.json`（维护脚本、手改）会出现"UI/派单短暂不一致"。

建议：把 `OrgSnapshot` 收进 `OrgLayer`（或独立 `OrgConfigService`），`Dispatcher` 不再摸文件，改为构造时注入 `org(): OrgSnapshot` 并从 host 拿变更通知；`resolveChief` 只保留一处（建议用 B 的兜底并让 dispatch 复用同一个 resolved id）。这一改动同时消灭"mtime 双读"和"三套 chief"。

### R6. 内存态权威 + 无单实例保护（低成本）

进程内权威状态清单：

- `Dispatcher.watch/synthesisWatch`（`server/dispatch.ts:386-388`）：worker turn ↔ 子任务、汇总 turn ↔ run 的映射，丢失 = 该 turn 的结果无人接收；
- `OrgLayer.escalated/autoApproved/lastAutoEvent`（`server/org/layer.ts:66-74`）；
- `ApprovalExpiry.pending`（`server/org/expiry.ts:25`）；
- `unattendedBots`（`server/index.ts:1402`）、`askMessageByRequest`（`server/index.ts:1116`）；
- `store` 的 bot bus/对话流。

单实例目前只靠端口绑定（`server/index.ts:8534`）间接保证；若未来出现"两个 harness 指向同一 DATA_DIR"（例如 Electron 双开、开发版与正式版共用目录、维护脚本直接跑 server），`dispatch-runs.json`/`org-events.ndjson` 会被两个进程互相覆盖/交错。建议在 `DATA_DIR` 加 pid lock（启动时独占文件，失败则报可读错误），并让 `Dispatcher.load` 检测"磁盘 updatedAt 比内存新"时拒绝启动而不是静默覆盖。

### R1. 规则"承诺 vs 执行"缺口（高收益、需要产品确认）

| 缺口 | 证据 | 建议 |
|---|---|---|
| `create_bot` 不受 `chiefMay.newSpecialist` 约束 | `server/index.ts:5259-5324` 只查 `chiefOfStaff`、workspace 上限、重名；规则检查只在 dispatch 造人（`server/dispatch.ts:638-644`） | 在 `/api/internal/create-bot` 增加 org 规则检查（org chief 或任何 chief 都受 `newSpecialist` 约束） |
| 编制从不校验 | `headcount` 仅 UI 警示（`src/components/settings/org-model.ts:125`），服务端无读者（§2.4） | 建人路径统一检查"目标 section 人数 < headcount"；owner 可越过，bot 不可 |
| 决策权矩阵不生效 | `decisionRights` 服务端零消费（§2.6） | 先做"审计模式"：把实际决定（approval/auto/expiry）映射到矩阵并记录"本应由谁决定"；确认语义后再接执行 |
| 预算线不拦普通花费 | `budgetPerDay` 只在加人诊断与展示（§3.10） | 至少在主 Bot 汇总/新建 run 前做一次预估检查；完整做法是 turn 启动前的 dry-run 预算提示 |
| `privateFolder` 只是标签 | `shared/org-types.ts:24` 注释已写明"shown only"；`server` 无消费 | 文档/设置页明确"仅展示"，或接工作目录映射 |
| `projects` 无运行时 | `shared/org-types.ts:27-36`、`server/org/config.ts` 仅存取 | 要么接"矩阵项目组"的派发/汇报语义，要么从产品/类型中降级为"标记" |

### R7. 预算与花费计量口径（中收益、低成本起步）

- 无价引擎只累计 tokens、成本计 0（`server/org/usage.ts:128-138`），`unpricedTokens` 有了但简报不展示（`shared/org-types.ts:180-181` 有字段，暂无 UI 消费）。
- USD→CNY 双源：`server/org/usage.ts:18` 默认 7.2、`server/dispatch-diagnose.ts:33` 常量 7.2、而 harness 配置里另有 `cfg.usage.usdToCny`（`server/index.ts:4628` 注入 `host.usdToCny`）。只有 usage 摘要用了配置值，加人诊断固定 7.2——汇率变更后两处数字会漂移。
- `weekPercent` 的语义是"本周花费 / (日预算×7)"（`server/org/usage.ts:145`），不是"周预算"——文档/UI 若按"周预算"解读会误导。
- 建议：`USD_TO_CNY` 统一从 host 注入（diagnose 也走 `spentToday/usdToCny`）；`UsageSummary` 增加 `estimated: true` 或 `unpricedShare`；UI 明确"预算线是提示不是闸门"。

### R9. 二级计划在派单总览不可见（中收益、低成本）

- `DispatchBoard` 只渲染顶层 run（`DispatchBoard.tsx:75`）；child run 的 `awaiting-approval` 状态不会出现在这个列表里。
- 目前仍两条路可达：工作台顶部的"plan waiting"横幅取所有 run（`WorkbenchPage.tsx:213-259`），简报收件箱也列出所有 awaiting-approval run（`server/org/inbox.ts:153-166`）；但一个部门主管的 child plan 在"派单总览"里看不到 Start/Cancel，操作心智不一致。
- 建议：`RunList` 递归渲染 child run（缩进 + "部门计划"标签），或在父任务行直接给 Approve/Cancel；同时 `sidebar-rows.runningWorkCount` 已明确不计 child（`src/lib/sidebar-rows.ts:24-35`），UI 文案应说明"部门计划计入父 run"。

### R3. 重启恢复"无事件、丢报告"（中高收益、中成本）

见 §3.9。建议：

1. `Dispatcher.load` 把"强制完成/回退 pending"的结果以 `org.event` 形式落一条合成事件（或在启动后由 `OrgLayer` 扫一遍 run 状态差异并补 `run.done`/`subtask.retry`）；
2. `synthesizing` 阶段的报告可以在每个子任务 settle 后就把"可汇总上下文"持久化（现有 `subtask.result` 已在 run JSON 里，足够重放），重启后允许主 Bot 重新汇总一次，而不是直接 done；
3. 至少把"报告丢失原因"写进事件 detail，避免用户以为完成。

### R4. 事件/简报的轮询与全量扫描（中高收益、中成本）

- `/api/brief` 每次调用执行 `inbox()`（扫描所有 bot/群的所有会话消息，`server/org/inbox.ts:110-151`）+ `buildBrief` + `usage` 过滤，5s 一次（§5.6）。当对话/message 量增长时，这是 O(全部消息) 的固定开销。
- 已有 SSE 基础设施与 `OrgEventLog.onEvent`（`server/org/events.ts:79-82`）却没接：事件可以走 `broadcast({kind:"org.event", event})`，前端只需在收到时刷新 brief/events；配合 2–5s TTL 缓存即可把 5s 全量扫描降到"有变化才算"。
- `/api/org/events` 的 `since` 也只是对 500 条内存窗口线性过滤；若改为"按 seq/id 增量 + 服务端游标"，可同时解决 R8。

### R5. 单文件全量快照 + 同步 IO（中收益、中成本）

`touch(run)` → `saveRuns()`：全量序列化所有 run（含每个子任务最多 6000 字符 result、最多 30 子任务、最多 60 run）→ `writeFileAtomic`，每次子任务状态变化都写（`server/dispatch.ts:1555-1559, 446-459`）。长计划 + 大结果时会明显放大写放大与内存拷贝，且 `writeFileAtomic` 是同步路径，发生在事件循环上。建议：结果外置到 task/transcript 或按 run 分文件；`touch` 合并写（例如 100–300ms debounce + 关闭前 flush）；对 `subtask.result` 使用引用而非内联。

### R8. 事件窗口/变更条数截断（中收益、中成本）

- 事件内存窗口 500 条（`server/org/events.ts:14`），`since(since)` 只能看到最近 500 条；简报 `changes` 只取最近 50 条（`server/org/brief.ts:46, 217`），`timeline` 200 条（`:47`）。
- auto 审批事件按 bot 15 分钟节流（`server/org/layer.ts:52-53`），但 autoApproved 列表不节流（`:244-250`）——两条审计链粒度不同，用户对"今天替你批了 300 次"看到的是列表计数，而时间线可能只有几条。
- "自上次查看"依赖 `localStorage` 的 lastSeen（`src/state/org-api.ts:153-171`）；长时间不打开、或换设备后，`changes` 会不完整。建议事件保留按天滚存（不只是 500 条）、`changes` 改为服务端分页、在前端显示"更早的变更已折叠"。

---

## 8. 文档与实现不一致 / 已过时（专节）

### 8.1 `docs/company-layer.md`

| # | 文档位置 | 文档说法 | 实际实现 | 判定/建议 |
|---|---|---|---|---|
| 1 | `docs/company-layer.md:13` | 决议"带依据、**决策人**和由它派生的行动项" | `decidedBy` 创建时恒为 `"owner"`（`server/org/decisions.ts:158`；`layer.onOptionsAnswered` 不传，`server/org/layer.ts:298-306`）。basis/行动项是真的（`decisions.ts:34-76, 178-222`） | 决策人字段当前是常量；"谁拍板"矩阵只存在于设置页 |
| 2 | `docs/company-layer.md:19-24` | 规则清单包含"预算线内总控可以直接""谁拍板：四级矩阵" | 公司/部门预算不是花费闸门（只在加人诊断 `server/dispatch.ts:1326-1334`、`dispatch-diagnose.ts:596-607` 与展示）；`decisionRights` 服务端零消费（§2.6） | 文档把"设置项/提示"写成"规则"，需标注 enforcement 范围 |
| 3 | `docs/company-layer.md:22` | 主 Bot 新建专员可在设置里关掉 | `chiefMay.newSpecialist` 只约束派单自动造人（`server/dispatch.ts:638-644`）；`create_bot` 工具（`server/index.ts:5259-5324`）不受约束 | 与 `dev-edition-plan.md:29` 缺口 #1 同源；文档未提这一边界 |
| 4 | `docs/company-layer.md:10` | 部门存"私有资料"（privateFolder） | 仅存储+设置页展示（`server/org/config.ts:60`、`OrgSection.tsx:380-383`），无任何目录/文件系统接线；类型注释自己写了 "shown only"（`shared/org-types.ts:24`） | 文档用词过重，应写"私有目录标签（仅展示）" |
| 5 | `docs/company-layer.md:41` | "index.ts 里只有一行一行的挂钩" | `orgLayer` 宿主对象在 `server/index.ts:4617-4638`（约 22 行），`dispatchApiDeps` 另约 16 行（`:4655-4670`） | 方向正确，但"一行一行"明显夸张；建议改"集中在一处成块的宿主适配" |
| 6 | `docs/company-layer.md:44` | 接口清单 | 漏了 `GET /api/dispatch/state`、`PUT/DELETE /api/dispatch/routes`（前端工作台/看板依赖，`src/components/workbench/model.ts:43`、`WorkbenchPage.tsx:102-107`）；也漏了 `PATCH .../subtasks/:sid`（文档上方 `:31` 提到但清单未列，`server/dispatch-api.ts:26-29`） | 清单不完整 |
| 7 | `docs/company-layer.md:48` | "可用应用：一个都不允许时不挂载；只允许部分时靠提示词约束" | 与实现一致：`server/index.ts:2638-2643`、`:3505-3510` 的 `?.length !== 0` gate；提示词在 `server/org/layer.ts:363-369` | ✅ 一致；但"部分允许"时实际挂载的是全部连接应用，靠提示词收敛，文档已如实写 |
| 8 | `docs/company-layer.md:49` | "隔离区只管资料库；跨部门问话还不会自动脱敏" | 一致：只有 `libraryPrompt`/`subscribe` 的隔离（`server/org/layer.ts:340-348, 409-415`）；`ask_bot` 跨部门回答原文返回（`server/drivers/agents-proxy.ts:528-560` 路径无脱敏）；但类型注释 `shared/org-types.ts:19` 写"can only ask and get redacted answers"，与实现矛盾 | 类型注释超前于实现，建议改注释或记为 future |
| 9 | `docs/company-layer.md:50` | "加人之后不能撤回小组；小组随任务结束解散" | 一致：无 withdraw 路由（`server/dispatch-api.ts:26-29`），`dissolveSquads` 在 `finishRun` 时解散（`server/dispatch.ts:1653-1658`） | ✅ 一致 |
| 10 | `docs/company-layer.md:46` | "还没做的"未提"编制/预算/决策权未执行" | 实际还有 §2.4 里那些"有字段无执行"的项 | 建议把"advisory vs enforced"补进文档 |

### 8.2 `docs/dev-edition-plan.md`

**基线过时**：文档头部写"对应 main `fe45a94`"（`:3`），但：

- 当前 main 是 `38aa642`，`fe45a94` 之后还有 `221ea69`（本文档）、`a58f3e7`（开发版/维护岗实现）、`f64ee6b`（手册/规则）、`c7dd561`、`7101943`、`38aa642` 等提交；
- 文档 §二.1 把"维护岗"称作**已实现**并引用 `server/maintenance.ts`、`docs/使用手册-1.1.2.md`、`docs/GitHub-版本与备份规则.md`，但 `git ls-tree fe45a94` 里没有 `server/maintenance.ts`，这些文档也是之后才加的。**拿旧 commit 对照该文档会找不到它描述的代码**。

**§二.6 的 8 个设计缺口逐条核对（当前 `38aa642`）**：

| # | 文档说法（`docs/dev-edition-plan.md:29`） | 当前实现核对 | 结论 |
|---|---|---|---|
| 1 | `create_bot` 不受「新增专员」规则约束 | `/api/internal/create-bot` 只查发送者是否 chiefOfStaff、workspace 上限、重名（`server/index.ts:5259-5324`）；`chiefMay.newSpecialist` 只在 `Dispatcher.submitPlan`（`server/dispatch.ts:638-644`） | **仍成立，未修** |
| 2 | 部门编制从不校验 | `headcount` 只有设置页警示（`src/components/settings/org-model.ts:125`）；`Dispatcher` 读入快照但无读者（`server/dispatch.ts:324, 356-357`） | **仍成立，未修** |
| 3 | 部门隔离只到资料库 | 一致（§8.1 第 8 条） | **仍成立** |
| 4 | 工作台「加人」进不了部门计划 | `AddPeopleDialog` 只用 `model.activeRun`（顶层，`src/lib/workbench.ts:73-75`；`model.ts:237`）；`amend` 用 `keep=mayPlan` 把主管子任务排除，唯一待办是部门工作时返回"ask a lead..."（`server/dispatch.ts:1401-1409`） | **仍成立** |
| 5 | 会议室决议不关联计划 | `onDispatchRun` 的 `linkRun` 判定包含"同会话"和"同群"（`server/org/layer.ts:265-273`）；`linkRun` 30 分钟窗口 + action items（`server/org/decisions.ts:20, 178-200`），`syncRun` 跟随状态（`:202-222`） | **已实现（文档过时）**；注意窗口 30 分钟、且只关联"决议之后启动"的 run |
| 6 | 重启时收尾的单没有「已完成」事件 | `dispatcher.load()` 在 `OrgLayer`/`RunWatcher.seed` 之前执行（`server/index.ts:2221` vs `:4616`；`server/org/layer.ts:86`），`synthesizing→done` 不广播（`server/dispatch.ts:420-426`） | **仍成立，未修** |
| 7 | 无人值守状态可能残留 | bot 的 `activity/busy` 在启动时复位（`server/store.ts:633-638`），这一点已缓解；但 `unattendedBots`/`ApprovalExpiry`/`askMessageByRequest` 都是进程内状态（`server/index.ts:1402`、`server/org/expiry.ts:25`），重启后旧卡片既不会过期也不会出现在收件箱（`isLiveRequest` 依赖进程内 map，`server/index.ts:4632-4634`） | **部分修复；残留仍在**（无事件、无清理） |
| 8 | 兜底计数与简报口径不同 | `brief.ts` 已显式跳过"主管容器子任务"并注释对齐 `src/lib/workbench.ts isLeafSubtask`（`server/org/brief.ts:85-90` vs `src/lib/workbench.ts:79`），但两者不完全等价：brief 仅当 child run 在视图内才跳过（`inView.has`），workbench 是无条件跳过；部门外工作 brief 单列（`brief.ts:209-214`），workbench 的 `departmentStats` 只统计部门内（`src/lib/workbench.ts:434-473`） | **大体对齐，边界仍有差异** |

**§一"11 个逻辑漏洞已修"**：与代码一致——`load()` 保留在途 run、`reopen()` 清理旧报告标记、`settleFromChild` 防止旧报告提前收尾、`chiefMay` 检查、`dissolveSquads` 重启解散、加人 `keep` 部门计划、预算计入今日全局花费（`server/dispatch.ts:404-444, 871-882, 1260-1301, 640-644, 1653-1658, 1401, 1326-1334`）。

**§二.5（真实派单模拟）**：文档记录的观察——"总控说『各项数字和上架资料都已按你的选择更新』，但它自己只写了三处"——在当前实现里没有程序化防线：`synthesisPrompt` 只要求"合并结果、说明失败/待决"，没有"逐项引用子任务交付物"的硬性要求（`server/dispatch.ts:1530-1553`）。这是"提示词治理"的典型案例（见 R1 建议的审计模式）。

### 8.3 类型注释 / 契约超前于实现

- `shared/org-types.ts:19` 隔离区注释 "can only ask and get redacted answers" —— 无脱敏实现（§8.1 #8）。
- `shared/org-types.ts:15` 编制注释 "how many bots it may have (lead included)" —— 无服务端校验（§8.2 #2）。
- `shared/org-types.ts:16-18` 预算线注释 "CNY per day" —— 不构成花费闸门（§8.1 #2）。
- `shared/org-types.ts:24` `privateFolder` 注释 "(shown only)" —— 这条是准确的，但 `docs/company-layer.md:10` 写成"私有资料"，两处口径不一致。
- `shared/org-types.ts:134` 的 `decidedBy`、`:142` 的 `actionItems` 语义 —— `decidedBy` 恒 owner，`runId` 只对同会话 30 分钟内的 run 生效。

---

## 9. 测试覆盖与证据等级

- `server/dispatch.test.ts`：115 个 `it`，含重启恢复（"running work goes back to pending and resumes"，`:650`）、主管子任务跨重启等待（`:1193`）、重启后小队解散（`:1426`），覆盖 §3.5/§3.9 的主干。
- `server/dispatch-diagnose.test.ts`：17 个 `it`，覆盖四个检查、预算、跨度、makespan（如 `:262` 断言加人不超过 span、`:303` 能力问题应指向模型而非人数）。
- `server/org/*.test.ts`：共约 119 个 `it`（config 16、layer 22、brief 11、decisions 12、inbox 9、library 11、run-events 8、usage 7、approval-events 6、api 4、cadence 4、org-wiring 7、expiry 2）。
- `server/org/org-wiring.test.ts` 是"公司层↔harness 接线"的集成测试（349 行），覆盖真实 server 的启动/落盘/接口面。
- 空缺（本次未找到对应测试）：§2.5 的三套 chief 解析一致性、"重启导致的 run 完成产生公司事件"（dispatch 测试覆盖恢复本身，但未断言事件）、决策权矩阵的"未生效"审计、`pump` 异常路径、`/api/brief` 的性能/规模边界。建议这些成为 R2/R3/R10 的回归测试。

---

## 10. 附：读代码时的三条经验

1. **把 `Dispatcher` 当"状态机 + 少量文件"，把 `OrgLayer` 当"只读投影 + 边缘写回"**：遇到任何"公司层行为"先分清它是在状态机里（真正生效）还是在投影/提示词里（展示或建议）。
2. **所有"公司规则"先在 §2.4 矩阵里查执行点**，再决定是否相信文档/类型注释。
3. **重启、审批、加人、跨部门这四件事是系统最脆弱的四个切面**：它们同时依赖内存映射、文件快照与异步 turn 回调；改动其中一个，必须同时看 §3.9、§4.7、§3.8、§3.7 四个小节。
