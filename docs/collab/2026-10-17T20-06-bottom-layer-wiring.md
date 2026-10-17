# Claude 协作记录 · bottom-layer-wiring

- 时间：2026-10-17T20:06:06.867Z
- 模型：sonnet（effort medium）
- 耗时：52.5s
- 本次花费：$0.1666（累计 $1.2981 / 上限 $Infinity）
- 调用：第 10 次（窗口剩余 195 分钟）

## 我们的问题

最后一个小问题（短问短答，给可执行接线方案）：Claude 上一轮指出「审计、阶段4 pipeline、ReviewerPort 模型部分没有调用方」。请只设计「给底座接上第一个真实调用方」的最小方案，不重写已有代码。

已有：server/evolution.ts（提案+EvolutionStore，老板 resolve accepted/rejected/deferred）、server/evolution-pipeline.ts（纯状态机 transition，state accepted→…→merged）、server/approval-audit.ts（审计 append/fold/stats）、server/index.ts 现有 /api/evolution* 路由；提案字段 id/signal/title/area/risk/evidence/status；UI 草案要求仅老板可批准合并。

请给：
1) 最小接线点：提案 resolve 为 accepted 时，应该在哪里创建 pipeline run（哪个文件/函数、存哪、幂等键）？pipeline run 的字段与 EvolutionItem 如何关联？
2) 老板手动操作如何进审计：通过/打回/稍后/采纳各自应写一条什么事件（字段映射），写哪个 key 才能让 attention-gate 的「手动批准次数」统计正确？
3) 建议新增/修改的 API 与 UI 动作（最多 3 个），只做「可见状态」，不做自动改代码/开分支。
4) 测试：3 条最小测试（不接真实引擎/git）。
5) 30 分钟内能完成的最小切片；不能完成的明确写「下一版」。
最后 3 行：先接哪一个底座最值得、为什么；最容易接错的地方。

## Claude 的回答

`★ Insight ─────────────────────────────────────`
- `EvolutionStore.resolve` 对已处理的提案直接返回原项，所以路由层分不清「第一次采纳」和「重复请求」。接线必须靠幂等键，不能靠「是不是第一次」的判断。
- `foldAuditEvents` 只数 `event==="approved" && mode==="manual"`，并且按 `(actionType, project)` 分组。actionType 取得粗，低风险的批准就会给高风险动作攒信任。
- `reverted` 的含义是「撤销一次已生效的批准」，会清零计数并冷却 14 天。老板点「打回」不能写成 `reverted`。
`─────────────────────────────────────────────────`

我读了 `evolution.ts`、`evolution-pipeline.ts`、`approval-audit.ts` 和 `index.ts:5794` 的 resolve 路由，没读 `transition()` 的实现体（55 行之后）。下面按你的 5 点回答。

**1) 创建 pipeline run 的位置**
- 新增 `server/evolution-runs.ts`，里面放 `EvolutionRunStore`，落盘到 `~/.ein/evolution-runs.json`，用 `writeFileAtomic`，写法照抄 `EvolutionStore`。它提供 `ensureRun(item)` 和 `onAccepted(item, audit)`。
- 调用点是 `index.ts` 的 resolve 路由。`evolution.resolve()` 之后，只要 `resolved.status === "accepted"` 就调用 `onAccepted`。不要判断是不是第一次，每次都调，让幂等键去重。
- 幂等键用确定性的 run id：`evo-run:${proposalId}`。`ensureRun` 发现已有就直接返回。
- `PipelineRun` 加一个可选字段 `proposalId?: string`，只加字段，不改状态机。初始值是 `{id, proposalId, state:"accepted", baseSha:"", testFailures:0, reviewBlocks:0, implementRounds:0, updatedAt}`。`baseSha` 等 provision 事件再填。
- 关联是单向的：run 指向 proposal。proposal 不存 runId，因为 `EvolutionItem` 落盘是整文件覆盖，两边都存会产生双写不一致。

**2) 老板操作如何进审计**

| 操作 | 审计写入 | 说明 |
|---|---|---|
| 采纳（resolve accepted） | 写 `approved` / `manual` | `actionType = evolution.accept:${area}:${risk}`，`target = proposalId`，`actor = "owner"`，`project = "ein-self"`，`idempotencyKey = evo:accept:${proposalId}`，`evidence = item.evidence.slice(0,5)` |
| 通过（approve_merge） | 写 `approved` / `manual` | `actionType = evolution.merge:${area}`，`target = runId`，`afterHash = headSha`，`idempotencyKey = evo:merge:${runId}:${headSha}`。只有 `transition` 返回 `ok` 才写 |
| 打回（rejected，或 merge_ready 阶段 abort） | 不写 | 提案被拒不是撤销；run 阶段的打回走 `transition` 的 `abort{reason:"owner_rejected"}` |
| 稍后（deferred） | 不写 | 没有批准，也没有撤销 |

- 只有 `approved + mode:"manual"` 会让「手动批准次数」+1。
- `reverted` 只留给「已合并后被老板回滚」，这一版不写。
- `mode` 必须由服务端写死为 `manual`，不能读请求体。

**3) API / UI（3 个）**
1. 改 `POST /api/evolution/:id/resolve`：accepted 时调 `onAccepted`，响应里多返回 `run`。
2. 新增 `GET /api/evolution/runs`，返回 `[{run, headline: pipelineHeadline(run), trust: audit.stats(actionType, project)}]`。
3. 新增 `POST /api/evolution/runs/:id/owner`，body 为 `{action:"approve_merge"|"abort"}`，必须走 `transition`。
   - `by:"owner"` 由服务端按现有老板鉴权决定，不读 body。具体用哪个鉴权守卫，我没在 `index.ts` 里确认，请你核对。
   - 这条路由是否放进第一版见第 5 点。

UI 只加两处：已采纳提案卡片上显示 `pipelineHeadline` 徽标（如「已受理 · 等待实现」），以及老板的「批准合并」按钮，非 `merge_ready` 时置灰。没有 git 和引擎时，不要显示「已合并」，文案用「已批准待合并」。

**4) 三条最小测试（内存或临时 dataDir，不接引擎/git）**
1. accepted 连续 resolve 两次，只有 1 个 run（id 为 `evo-run:pid`，state 为 `accepted`），也只有 1 条审计事件，`manualApproved === 1`。
2. rejected 和 deferred 都不产生 run，也不产生审计，`stats.manualApproved === 0`。
3. 对 `state=accepted` 的 run 发 `approve_merge`，`transition` 返回 `ok:false`，没有审计。把 run 构造成 `merge_ready` 且 `headSha` 匹配后再发，写入 1 条 `evolution.merge:*` 的 manual 事件，重放不会重复写。

**5) 30 分钟切片与下一版**
- 本版做：`evolution-runs.ts`、`PipelineRun` 加 `proposalId` 字段、resolve 钩子、`GET /runs`、徽标、上面 3 条测试。
- 下一版做：
  - `POST /runs/:id/owner` 和按钮的真实联动
  - provision / 引擎 / `ReviewerPort` 的实现
  - git 合并
  - 过期（`expire`）定时器
  - 历史已采纳提案的回填
  - 基于信任的自动批准
- `POST /runs/:id/owner` 如果时间紧可以整条推到下一版，因为此时没有任何路径能走到 `merge_ready`。

**最后 3 行**
- 先接审计，挂在「采纳」这个已有的人工动作上。`AUTO_MANUAL_MIN=3` 要靠累计，早接一天就多一天数据；而没有引擎的 pipeline run 目前只是个标签。
- 最容易接错：把打回或稍后写成 `reverted`，或写成 `approved`，这会让信任计数和 14 天冷却都算错。
- 其次是幂等键漏掉 `headSha`，或 `actionType` 不带 `area:risk`，前者会让重复请求算多次，后者会让低风险的批准给高风险动作攒信任。
