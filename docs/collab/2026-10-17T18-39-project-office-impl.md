# Claude 协作记录 · project-office-impl

- 时间：2026-10-17T18:39:41.786Z
- 模型：sonnet（effort medium）
- 耗时：31.2s
- 本次花费：$0.0873（累计 $0.3956 / 上限 $Infinity）
- 调用：第 4 次（窗口剩余 281 分钟）

## 我们的问题

第 2 轮讨论主题：项目内 AI 协同办公工作台的「实现计划」（不是设计愿景，要能按文件施工）。

现有代码（已读过的你可以引用）：src/components/Sidebar.tsx（任务列表）、ChatView.tsx（项目窗口 + ProjectPulse「此刻」条）、InboxPanel.tsx、brief/BriefPage.tsx、EvolutionCard.tsx、OwnerTimeCard.tsx；服务端已有 GET /api/task-folders、/api/task-folders/:id/office（departments/presence/waiting/decisions/activity/anomalies）、/api/task-folders/:id/state、/api/task-folders/:id/retro、/api/inbox、/api/decision-stack、/api/office/brief、/api/office/metrics/owner-time；任务窗口=对话，任务列表点击打开任务窗口；工作台/团队地图是旧页面。

请给：
1) 项目工作台 MVP 的 UI 结构：是新建一个 ProjectOfficePage（建议挂在哪，路由/入口怎么进），还是扩展现有 ChatView？给取舍和推荐。若新页面，列组件树（组件名、文件路径、props、数据来源接口），最多 8 个新文件。
2) 三块核心区域的实现顺序（团队/部门状态、此刻等待链、待拍板），每块：数据来自哪个接口字段、空态、加载态、错误态、手机断点行为；以及第一版可以砍掉哪些交互。
3) 与现有侧栏任务列表/窗口的关系：打开任务默认进聊天还是进工作台？怎么在两者间切换而不丢状态；旧任务（无 conversationId）如何处理。
4) 4 小时施工计划：按 30-60 分钟切片，每片产出、验证方式（tsc/vite/单测/DOM 自检），先做哪个能让老板最快看到「团队在协同」。
5) 需要服务端补充的字段/接口（最多 3 个），每个给最小 schema。
6) 最可能被老板吐槽的 3 个点，给文案/交互上的预防。
最后 3 行：如果只能做一个屏幕，做哪个、为什么。

## Claude 的回答

`★ Insight ─────────────────────────────────────`
这轮我没读新代码，下面按你列出的接口和组件做判断，没核对过的字段名我会标"待核对"。核心取舍是：任务窗口 = 对话，所以工作台应该是项目级的"另一个视图"，不要塞进 ChatView。
`─────────────────────────────────────────────────`

## 1) UI 结构：推荐新建 ProjectOfficePage，但和 ChatView 共用外壳

**取舍**
- **扩展 ChatView**：改动最小，但 ChatView 已经承担对话、ProjectPulse、输入框。再塞三块区域会让它的状态耦合变重，手机上也只剩半屏。
- **新页面**：职责清晰，可以单独轮询 `/office`，不影响聊天流。代价是要多一条路由，并处理好和聊天之间的切换。

**推荐**：新页面，作为项目的第二个 tab，不是新的顶层页面。
- 路由：`/p/:folderId`（工作台）和 `/p/:folderId/t/:taskId`（任务对话）。
- 入口：侧栏里项目（task-folder）标题可点击，进工作台。
- 项目窗口顶部加 `[协同 | 对话]` 分段控件。ProjectPulse 点击后跳到协同 tab。
- 旧的"工作台/团队地图"页面先不删，只在侧栏降级。

**组件树（6 个新文件）**
```
src/pages/office/ProjectOfficePage.tsx   props: folderId  数据: useProjectOffice
src/pages/office/useProjectOffice.ts     hook: 轮询 GET /api/task-folders/:id/office，5-10s，页面可见时才轮询；返回 {data,status,error,refresh}
src/pages/office/TeamStrip.tsx           props: departments, presence    ← office.departments/presence
src/pages/office/WaitChain.tsx           props: waiting, onOpenTask      ← office.waiting
src/pages/office/DecisionQueue.tsx       props: decisions, onOpen        ← office.decisions（可复用 /api/decision-stack 的卡片）
src/pages/office/ActivityFeed.tsx        props: activity, anomalies      ← office.activity/anomalies（可放第二批）
```
`ViewSwitch.tsx` 是第 7 个文件，放在 ChatView 和 ProjectOfficePage 的头部共用，只负责渲染分段控件。

## 2) 三块区域的实现顺序和细节

建议顺序：**先做待拍板，再做等待链，最后做团队状态**。待拍板对老板的价值最直接，数据也最接近现成的 InboxPanel。但"让老板看到团队在协同"这个目标要靠团队状态，所以第 4 节的切片会把团队状态提前。

| 区域 | 数据字段 | 空态 | 加载态 | 错误态 | 手机 |
|---|---|---|---|---|---|
| 团队/部门状态 | `departments[]`、`presence[]`（待核对：部门 id、在线状态、当前任务） | "还没有成员在这个项目里工作" + 一个"发起任务"按钮 | 3 张骨架卡 | 条内提示"状态暂不可用，重试"，不挡其他区域 | 横向滚动 chip；点开是底部抽屉 |
| 此刻等待链 | `waiting[]`（待核对：谁在等谁、等什么、等了多久） | "此刻没有人在等人" | 2 行骨架 | 同上 | 竖排，每条一行，箭头改成"A → B"文字 |
| 待拍板 | `decisions[]` | "没有需要你拍板的事" | 骨架 | 同上 | 全宽卡片，主按钮固定在卡片底部 |

**错误态原则**：每块独立失败，别用一个全局 error 把整页遮住。`useProjectOffice` 返回整体结果，但组件按字段降级。

**第一版可以砍的**
- 部门卡展开详情、拖拽、成员筛选。
- 等待链的图形化连线，用列表加箭头文字就够。
- 待拍板的批量操作、"稍后提醒"。
- ActivityFeed 和 anomalies 整块，延后。
- WebSocket / SSE，先用轮询。

## 3) 与侧栏和任务窗口的关系

- **默认行为**：点任务列表里的任务，进对话（`/p/:id/t/:taskId`），保持现有习惯。点项目标题，进协同页。老板的第一次入口就是项目标题，不会被打断。
- **切换不丢状态**：把 ChatView 和 ProjectOfficePage 都挂在同一个 `ProjectShell` 布局下，用路由嵌套，不要卸载 ChatView。具体做法有两种：
  - 简单做法：两者都 `display:none` 切换，保持挂载。聊天输入草稿、滚动位置都保留。
  - 如果担心性能，就把草稿和滚动位置存到 `sessionStorage`，按 `taskId` 做 key。
- **旧任务（无 conversationId）**：对话 tab 显示"这个任务是旧版本创建的，没有对话记录"，但协同 tab 照常可用。侧栏仍列出这些任务，点击后落到协同 tab。不要让旧任务点进去是空白或报错。

## 4) 4 小时施工计划

| 切片 | 时长 | 产出 | 验证 |
|---|---|---|---|
| S1 | 40 分钟 | `useProjectOffice.ts` + 路由 + `ViewSwitch` + 空的 `ProjectOfficePage` 骨架。侧栏项目标题可跳转 | `tsc --noEmit`；vite 跑起来能进页面 |
| S2 | 50 分钟 | `TeamStrip`：部门卡 + presence 点。这是老板最快能看到"团队在协同"的一块 | 手工看真实数据；DOM 自检有 N 张卡 |
| S3 | 40 分钟 | `WaitChain`：A → B + 等待时长 | 单测：时长格式化函数；空态渲染 |
| S4 | 50 分钟 | `DecisionQueue`：复用 InboxPanel 的卡片和拍板动作 | 点击拍板后列表刷新；错误路径手测 |
| S5 | 40 分钟 | 手机断点 + 加载/错误/空态补齐 | 375px 宽度下看；断网模拟 |
| S6 | 20 分钟 | ProjectPulse 点击跳转，`tsc` + 单测全跑，收尾 | 全量检查 |

**先做 S2（团队状态）**。老板打开页面第一眼看到"谁在干什么"，就能感受到协同；等待链和待拍板是第二、第三眼。

## 5) 服务端最多补 3 项

1. **`departments[].current`**：当前在做什么。
   ```json
   {"deptId":"string","activeTaskId":"string|null","activeTaskTitle":"string|null","since":"ISO"}
   ```
   如果现有 presence 里已经有，就不用补，先核对。
2. **`waiting[]` 的显式依赖**：
   ```json
   {"id":"string","waiter":"deptId","blockedOn":"deptId|owner","reason":"string","since":"ISO","taskId":"string"}
   ```
3. **`GET /api/task-folders/:id/office` 的 `generatedAt` 和 `version`**：用于前端判断数据新鲜度，以及轮询时做 ETag 式短路，减少重渲染。

## 6) 老板最可能吐槽的 3 点和预防

1. **"这和对话有什么区别 / 我该看哪个"**：每块标题用动词短句，比如"现在谁在等谁"，不用"等待链"这种术语。页面顶部放一句话摘要："3 个部门在工作，1 件事等你拍板"。
2. **"数据是不是过期的"**：每块右上角显示"x 秒前更新"，加手动刷新。数据超过 60 秒没更新就变灰并提示。
3. **"全是空的，看不出在协同"**：空态不要写"暂无数据"，要说明原因和下一步，比如"还没有人在等人，这是好事"。如果整个项目没有活动，页面顶部直接给一个"发起第一个任务"的按钮。

## 最后 3 行

只做一个屏幕：**项目协同页里的团队状态条加此刻等待链**，合成一屏。
原因：它是唯一把"多个角色在并行、互相等待"这件事直接画出来的屏幕，对话和待拍板都只能间接体现。
待拍板已经有 InboxPanel，老板已经见过，没有新信息量。
