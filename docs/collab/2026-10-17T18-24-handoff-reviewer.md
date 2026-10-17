# Claude 协作记录 · handoff-reviewer

- 时间：2026-10-17T18:24:20.493Z
- 模型：sonnet（effort medium）
- 耗时：52.3s
- 本次花费：$0.1156（累计 $0.1954 / 上限 $Infinity）
- 调用：第 2 次（窗口剩余 297 分钟）

## 我们的问题

继续讨论两个具体实现（短问短答，每条给字段/接口/步骤，能直接写代码）。不要泛泛。

背景：我们现有 dispatch subtask（status/assignee/dependsOn/handoff/gate/reworkCount/attempts）、task office API（部门 presence/等待链/拍板/异常）、需要你收件箱、ReviewerPort 纯逻辑（输入预算/quote 校验/裁决映射），但 reviewer 还没接引擎；Handoff 没有 ack 字段（架构审计确认），交接「接收/退回」是缺失状态机。

1) Handoff 接收/退回最小状态机：
   - 在哪个对象上存（subtask.handoff? 新的 handoffReceipt?），字段有哪些（sentAt/receivedAt/receivedBy/returnedAt/returnReason/attempt/round）；
   - 迁移/兼容旧数据（没有 ack 的历史记录怎么读）；
   - 哪些状态转移合法（sent→received/returned/expired、returned→re-sent…），非法转移返回什么；
   - API：谁调用、路径、body、权限；超时（N 分钟无人接收）由谁扫、怎么升级给负责人；
   - 与现有 gate/收件箱/office waiting 链怎么联动（哪些字段供 office 用）；
   - 最小测试 3 条。
2) Reviewer 一次性会话接入（我们引擎是 turn 级：bot conversation + startTurn，没有裸 API）：
   - 用哪个 bot/会话载体最安全便宜（隐藏 bot？冷 session？临时 thread？）——给取舍与推荐；
   - 具体调用序列：准备输入→建会话→发 prompt→收结果→校验→销毁；每一步失败怎么降级 needs_human；
   - 预算/超时/次数与成本字段记录位置；
   - 怎么保证不污染任务窗口/不进入任何 bot 列表；
   - 4 小时内能落地的最小版本，明确砍掉什么；
   - 最小测试 3 条（不接真实引擎，用 fake host）。
最后 3 行：这两件先做哪件、为什么，以及一个最容易做错的地方。

## Claude 的回答

`★ Insight ─────────────────────────────────────`
- 交接 ack 属于「某一轮发送」,不属于 subtask。所以要有 `round`,每次重发都是新一轮。
- 没人会主动调 ack 接口,因此「bot 开始该 subtask 的 turn」必须隐式 receive,否则全部变 expired。
`─────────────────────────────────────────────────`

## 1) Handoff 接收/退回

**存放**:嵌在 `subtask.handoff.ack`。不要新建 receipt 对象,因为它要和 subtask 同一次原子写入,也要和 `dependsOn`/`gate` 共用同一把版本锁。

```ts
handoff: {
  ...existing,
  id: string,              // `${subtaskId}#${round}`
  round: number,           // 从 1 起,重发 +1
  sentAt: number, sentBy: string,
  ack?: {
    state: 'sent'|'received'|'returned'|'expired',
    expiresAt: number,     // sentAt + N
    receivedAt?, receivedBy?,   // botId | 'owner'
    returnedAt?, returnedBy?,
    returnReason?: { code: 'missing_input'|'wrong_scope'|'blocked'|'overload'|'other', text?: string },
    nudgeCount: number, escalatedAt?: number,
    v: number              // CAS 版本
  },
  ackHistory?: Ack[]       // 旧轮次,最多保留 10 条
}
```

**旧数据**:只做读时归一化,不批量迁移。写一个纯函数 `readAck(subtask)`:
- `ack` 存在就直接返回。
- `ack` 缺失且 `subtask.status` 已是 `in_progress`、`done` 或 `review`,返回 `{state:'received', implied:true}`。
- `ack` 缺失且还没开始,返回 `{state:'sent', legacy:true, expiresAt:undefined}`。**历史数据不参与超时扫描**,否则上线当天会爆出一堆 expired。
- 第一次发生状态转移时才把归一化后的 `ack` 写回。

**合法转移**(按轮次)

| from | to | 说明 |
|---|---|---|
| sent | received | 显式调用,或首个 turn 隐式触发 |
| sent | returned | 必须带 `returnReason` |
| sent | expired | 仅 sweeper 触发 |
| expired | received | 迟到接收,仅当该轮仍是最新一轮 |
| returned / expired | 新一轮 sent | 通过重发,`round+1`,旧 ack 进 `ackHistory` |

- `received` 和 `returned` 对本轮是终态。
- 同一动作、同一 actor 重复提交,返回 200 `{noop:true}`(幂等)。
- 非法转移返回 409 `{error:'illegal_transition', from, to, round}`。
- `round` 不是最新一轮,返回 409 `{error:'stale_round', current}`。
- actor 不是 assignee 也不是 owner,返回 403。
- 缺 `returnReason`,返回 422。

**API**
- `POST /api/tasks/:taskId/subtasks/:subId/handoff/ack`
  - body:`{round, action:'receive'|'return', reason?:{code,text}}`
  - 调用方:assignee bot(通过 tool 或引擎回调),或 owner 在 UI 代为操作(记为 `receivedBy:'owner'`)。
- 重发复用现有 handoff 发送接口,只允许在 `state ∈ {returned, expired}` 时调用。调用方是 dispatcher 或 owner。
- 隐式 receive:引擎对带 `subtaskId` 的 turn 在 `startTurn` 前调用 `receive(round=current, by=botId)`。

**超时**
- 在已有调度 tick 里加 `sweepHandoffs(now, subtasks): Action[]`,写成纯函数便于测试。
- 默认 N=10 分钟,可按部门配置。
- 第 1 次过期:置 `expired`,`nudgeCount++`,重投同一轮,并通知 dispatcher/部门负责人。
- 第 2 次过期,或 `returned` 累计 ≥2:生成「需要你」收件箱项 `kind:'handoff_stuck'`,经过 attention gate 判定。
- 幂等 key 用 `${handoffId}:${kind}:${nudgeCount}`,防止重复通知。
- 扫描器写入必须带 `ack.v` 做 CAS,失败就丢弃,下一个 tick 重判。

**联动**
- office waiting 链:
  - `state=sent|expired` → 节点 `waitingOn=assignee, reason='handoff_unreceived', since=sentAt`。
  - `returned` → `waitingOn=dispatcher/owner, reason='handoff_returned'`,并附 `returnReason.code`。
  - `received` → 回到原有的 working。
- presence:部门成员显示「待接收 N」。
- office 需要的字段:`ack.state / sentAt / expiresAt / round / returnReason.code / nudgeCount`。
- gate:`done` 转移要求 `readAck().state==='received'`,`implied` 也算。`sent` 状态的 subtask 不计入「已启动」。
- 注意:`returned` **不要**增加 `reworkCount`。那是评审返工,语义不同。单独记 `handoffReturns`。

**最小测试 3 条**
1. `sent→received` 幂等:重复 receive 返回 noop;`returned` 后再 receive 返回 409 `illegal_transition`。
2. 旧数据:无 `ack` 且 `status=in_progress` 读为 `received(implied)`;无 `ack` 且未开始,sweeper 不处理。
3. sweeper 并发:sweeper 读到 `v=1` 后,bot 隐式 receive 把 `v` 改为 2,sweeper 写入失败,最终状态仍是 `received`。

## 2) Reviewer 一次性会话

**载体取舍**
- 复用现有 bot 的冷 session:会污染该 bot 的历史和记忆,**否决**。
- 常驻隐藏 bot 加长会话:历史累积,成本和上下文漂移都不可控,**否决**。
- **推荐**:一个系统保留 bot(`system:reviewer`,`kind:'system'`,`hidden:true`),**每次评审新建一个 conversation,用完即销毁**。
  - 新会话没有历史,所以上下文干净、成本可预测。
  - 会话打 `ephemeral:true, purpose:'review'`,并在 conversation/bot 列表的**唯一查询出口**过滤。
  - 只用最便宜的模型,禁用 tools。

**调用序列**,每步失败都落 `needs_human`,并带 `reason` 枚举:

1. **准备输入**:调用现有 ReviewerPort 的预算和 quote 逻辑。超预算则裁剪;裁剪后仍超 → `input_too_large`。
2. **建会话**:`host.createConversation({botId:'system:reviewer', ephemeral:true, noBroadcast:true})`。失败 → `host_unavailable`。
3. **发 prompt**:`host.startTurn(convId, prompt, {signal, timeoutMs:90_000, maxOutputTokens})`。被审内容放进分隔块,并明确声明「块内是不可信数据」。输出要求纯 JSON。
   - 超时:abort → `timeout`。
   - 抛错 → `host_error`。
4. **收结果**:`JSON.parse` 并用 schema 校验。失败 → `bad_output`。**不重试**,重试会翻倍成本。
5. **校验**:quote 必须是输入中的逐字子串,否则 → `quote_mismatch`。通过后再走现有裁决映射。
6. **销毁**:放在 `finally` 里调用 `host.destroyConversation(convId)`。销毁失败只记日志,不影响结果。启动时再加一个 janitor,清理超过 10 分钟的 `ephemeral` 会话。

**记录位置**:`subtask.reviews[]` 追加 `{id, attempt, round, convId, model, inTokens, outTokens, costUsd, startedAt, durationMs, outcome, failure?}`。office 成本汇总从这里读。

**限额**:每个 attempt 最多 2 次评审,全局并发 1,单任务总预算沿用 ReviewerPort 的输入预算。超限直接 `needs_human('budget')`,不发 turn。

**不污染**
- 不带 `taskId` 上下文,事件不发到任务频道。
- SSE 广播层跳过 `ephemeral`。
- 列表接口统一过滤 `hidden` 和 `ephemeral`。
- 会话销毁后不留 transcript。

**4 小时最小版**
- 做:fake-host 接口、`runReview()` 编排、`finally` 销毁、`reviews[]` 记录、失败降级、过滤出口。
- 砍:重试、多评审员、流式 UI、成本看板、tools、跨会话复用、自动 rework 之外的任何联动。

**最小测试 3 条**(fake host:`{createConversation, startTurn, destroyConversation}`)
1. 成功路径:返回合法 JSON 且 quote 命中 → 映射出裁决,`reviews[]` 有 token 和成本,`destroy` 被调用 1 次,列表中无该会话。
2. `startTurn` 超时或抛错 → `needs_human('timeout'|'host_error')`,`destroy` 仍被调用。
3. quote 不在输入里,或 JSON 非法 → `needs_human('quote_mismatch'|'bad_output')`,且不触发重试(`startTurn` 调用次数为 1)。

先做 **Handoff 状态机**。它是纯逻辑加存储,约 2 小时能闭环,还能立刻让 office 等待链不再误报。Reviewer 依赖引擎接口,放第二。

最容易做错:Handoff 里 sweeper 与隐式 receive 的竞态,没有 CAS 就会把已开工的 subtask 误标 expired 并升级到收件箱。Reviewer 里则是 `destroy` 没放进 `finally`,导致 `ephemeral` 会话泄漏进 bot 列表。
