# Claude 协作记录 · code-review-final

- 时间：2026-10-17T19:36:56.812Z
- 模型：sonnet（effort medium）
- 耗时：89.4s
- 本次花费：$0.3726（累计 $1.0600 / 上限 $Infinity）
- 调用：第 8 次（窗口剩余 224 分钟）

## 我们的问题

最后一轮：请做一次真实的代码评审（只读；先用 Read/Grep 读下面文件，再给结论；不要泛泛）。目标是 1.1.4 候选版发布前找 P0/P1。

仓库 /Users/kairuiwang/ein-work/next（分支 feat/1.1.4）。重点文件：
- server/handoff-ack.ts（ack 状态机/CAS/legacy 读）
- server/dispatch.ts（只评 handoff ack 接线：初始化 ack、隐式 receive、sweepHandoffs、needsYou handoff_stuck；不要评整个大文件）
- server/attention-gate.ts（push/inbox/auto/archive、排序、合并）
- server/approval-audit.ts（信任折叠/撤销/幂等）
- server/evolution-pipeline.ts（阶段4状态机）
- server/office-view.ts（presence/waiting/decisions/anomalies）
- server/index.ts（只评新增路由：/api/decision-stack、/api/task-folders/:id/office、/api/office/brief、/api/office/metrics/owner-time、/api/evolution*、/api/audit* 若有；以及 handoff sweep interval 的挂载）
- src/components/office/ProjectOfficePanel.tsx + src/lib/office.ts（面板与轮询）

输出格式（最多 10 条）：
1) 每条：【P0/P1/P2】一句话问题 + file:line + 触发条件 + 最小修法（≤2 行代码思路）。
2) 优先检查：重复执行/成本翻倍、状态机非法转移、终态回退、计时器竞态、错误被吞导致假绿、权限绕过、内存/重试风暴、手机端崩溃（undefined/空数组）。
3) 最后 3 行：如果只能修一条，修哪条；以及这版最大的「假绿」风险。
限制：只读，不改文件；不要跑真实派单；评审 10 分钟内完成。

## Claude 的回答

`★ Insight ─────────────────────────────────────`
这版有三条主线：ack 状态机本身是干净的纯函数，但「谁来驱动它」（sweeper、面板、pipeline 调用方）漏了一环。`attention-gate`、`approval-audit`、`evolution-pipeline` 在 `server/*.ts`（排除测试）里没有任何调用方，也没有 `/api/audit*` 或 pipeline 路由，所以现在是死代码。风险只在于发布说明把它们写成已上线。
`─────────────────────────────────────────────────`

只读评审，没有跑任何东西。结论按严重度排序，共 9 条。

1. **【P1】`handoff_stuck` 被老板处理后会无限复活，而且没有任何动作真正重发交接**
   - 位置：`server/dispatch.ts:1255-1267`（escalate 分支）、`server/handoff-ack.ts:94`、`server/index.ts:5742-5758`
   - 触发条件：ack 到了 `expired` 且 `nudgeCount>=1` 后，每 60s 的 sweep 都会重新产生 `escalate`。`escalatedAt` 被写了但 `sweepHandoffs` 从不读它。`inbox.add` 只在 item 未 resolve 时去重，所以老板点「通过」后 60s 内又冒出一张同样的卡。`/api/inbox/:id/resolve` 对 `handoff_stuck` 没有任何动作，`decision-stack.ts:71` 却写着「通过即由你介入，把交接重新发下去」。
   - 修法：`sweepHandoffs` 里 `else if (ack.nudgeCount >= maxNudges && !ack.escalatedAt)`。再给 `handoff_stuck` 的 approve 接一个重发或 `reopen` 动作，没有就把按钮文案改掉。

2. **【P1】面板在加载中或请求失败时显示绿色「一切正常」**
   - 位置：`src/components/office/ProjectOfficePanel.tsx:50-63`、`src/lib/office.ts:61-63`
   - 触发条件：`office===null`（首次加载、一次网络抖动、旧服务端 404）时，`waiting`、`decisions`、`anomalies` 都回退成 `[]`，`conclusion` 落到 `"Everything is under control right now"`。轮询失败还会 `setOffice(null)`，一次失败就清掉已有数据并翻回绿色。
   - 修法：`office` 为空时 `conclusion` 显示「加载中/连接异常」的灰色态。catch 里保留上一份数据（`setOffice(prev=>prev)`）并标记 `stale`。

3. **【P1】面板的批准/驳回不带 `attemptId`，绕过了 STALE_ATTEMPT 校验**
   - 位置：`ProjectOfficePanel.tsx:37-41,118`、`server/office-view.ts:56-63`、`server/index.ts:5732`
   - 触发条件：`OfficeDecision` 没有 `attemptId` 字段，`act()` 因此永远传 `undefined`，服务端只在传了才校验。老板看着旧卡，该子任务已经 rework 出新 attempt，点「通过」会放行新的、没看过的产物。
   - 修法：`OfficeDecision` 加 `attemptId`（来自 `item.attemptId`），`act` 里 `resolveInboxItem(..., attemptId)` 透传。

4. **【P1】sweeper 不看 run 状态，对已取消/失败/完成的 run 也会升级，且不会清理 sent ack**
   - 位置：`server/dispatch.ts:1232-1234`
   - 触发条件：run 被取消或失败后，下游永远不会启动，隐式 receive 也就不会发生。10 分钟后每个 `sent` 的 ack 都会触发 `handoff_stuck`，给老板发垃圾待办。
   - 修法：循环开头 `if (run.status !== "running" && run.status !== "synthesizing") continue;`。

5. **【P1】nudge 是空转：`expired` 之后没有重新计时，下一个 tick 就升级**
   - 位置：`server/dispatch.ts:1239-1243`、`server/handoff-ack.ts:90,94`
   - 触发条件：expire 只改 `state` 和 `nudgeCount`，没有重置 `expiresAt`，也没有真正提醒下游。因此 `expired` 之后约 60s 就会 escalate，实际等待时间是 10 分钟加一个 tick，「催一次再升级」名不副实。
   - 修法：expire 时设 `ack.expiresAt = now + ttl`，并在这里触发一次真正的 nudge（给下游发消息或 `activity`）。

6. **【P1】`office-view` 会把没有 ack 的历史 handoff 当成「未接收」，旧项目显示红色长时间阻塞**
   - 位置：`server/office-view.ts:207-214`（直接读 `dependency.handoff?.ack`，没走 `readAck`）
   - 触发条件：1.1.3 及以前的数据里，done 的依赖带 handoff 但没有 ack，同时下游仍是 `pending`（比如被别的依赖挡住）。这时 `ack` 为 `undefined`，不是 `received`，会被渲染成 `handoff_unreceived`，`since` 回退到 `lastActivityOf`，`minutes` 很大，面板标红。
   - 修法：先 `const r = readAck(dependency)`，`r?.implied || r?.legacy` 时跳过。

7. **【P1】approval-audit：日志加载一行坏就丢掉其余事件，torn write 还会拼坏下一行**
   - 位置：`server/approval-audit.ts:99-110`（`try` 包住整个 for 循环）、`:125`
   - 触发条件：崩溃留下半行 JSON，`JSON.parse` 抛错，循环中断，后面的 `reverted` 事件被丢，信任度回升。下一次 `appendFileSync` 又接在没有换行的半行后面，把新事件也写坏。
   - 修法：`try/catch` 放进每行里，坏行跳过并计数。`append` 前如果文件不以 `\n` 结尾就补一个。
   - 同文件：`:121` 的 `{id, decidedAt, ...input}` 在 input 显式带 `decidedAt: undefined` 时会覆盖默认值，改成先 spread 再放默认。`:125` 持久化失败只 `console.error`，却返回成功，撤销事件可能丢。
   - 另外 `revertedCount=reverts.length`（`:68`）是按 `(actionType, project)` 分组，不是按对象。同一对象重复撤销会被计两次而误锁定 ask_only。

8. **【P1】pipeline：`guarding` 是死胡同，而且 `ok:false` 的结果里携带了状态变更**
   - 位置：`server/evolution-pipeline.ts:94,96`、`:67`、`:46-50`
   - 触发条件：head sha 变了或某项证据缺失时，`approve_merge` 返回 `ok:false` 且 `run.state="guarding"`。但 `guard_pass` 只允许从 `implementing` 进入，`implement` 也不允许从 `guarding` 进入，所以只能 `abort` 或 `expire`，「重跑 guard 和测试」这条路径走不通。另外 `rejected`、`guarding` 这类转移是 `ok:false` 加新 state，调用方如果按 `if(!ok) return` 就会丢掉状态变更，run 还停在 `merge_ready`。
   - 修法：`guard_pass` 同时接受 `guarding`；`implement` 的白名单加 `guarding`。再让 `fail()` 带一个 `persist` 标志，或把拒绝类转移改成 `ok:true` 加 `reason`。

9. **【P1】attention-gate：自动批准不看 `risk`，也没有每日 3 次推送的配额**
   - 位置：`server/attention-gate.ts:54-59,48`
   - 触发条件：`autoEligible` 不检查 `card.risk`。可逆、internal、有 5 次历史批准的 `critical` 卡会被判成 `auto`。文件头和函数注释写「每天 ≤3 次推送，耗尽后只有 critical 能推」，代码里没有任何计数。阈值 `approvals>=5` 也和 `approval-audit.ts:45` 的 `AUTO_MANUAL_MIN=3` 不一致。
   - 修法：`autoEligible` 加 `RISK_ORDER[card.risk] <= 1`，阈值统一引用常量。配额放到调用方（`pushedToday`），或把注释删掉。

次要（P2，不占名额）：
- `ProjectOfficePanel.tsx:170` 的 `key={anomaly.subtaskId}` 会重复，一个子任务可同时产出 failed、needs_human、rework，改成 `${subtaskId}-${kind}`。
- `GET /api/evolution`（`index.ts:5776-5788`）在 GET 里写盘，轮询或预取会触发写入。
- `evolution.resolve` 对已处理的提案返回 200 和旧状态，客户端会误以为新决定生效了。
- `sweepHandoffs` 里 `if (changed)` 用的是累计值，会连带 `touch` 后面没变化的 run。

**如果只能修一条**：#1 加 #4。`escalatedAt` 守卫加 run 状态过滤，加起来只需要约 3 行，能挡住每个活跃用户都会碰到的待办刷屏。#2 紧随其后，改动也很小。

**最大的假绿风险**：#2，加载或失败时面板显示绿色「一切正常」。同类的还有 #1：老板点通过后，系统看起来处理了，实际交接没有重发，60s 后又冒出来。

**发版口径提醒**：`attention-gate`、`approval-audit`、`evolution-pipeline` 目前只有测试在用，发布说明里不要写成已启用，至少不要写成会自动批准。
