# Claude 协作记录 · phase4-pipeline

- 时间：2026-10-17T18:38:21.586Z
- 模型：sonnet（effort medium）
- 耗时：50.8s
- 本次花费：$0.1129（累计 $0.3083 / 上限 $Infinity）
- 调用：第 3 次（窗口剩余 283 分钟）

## 我们的问题

按老板要求：先连续讨论几轮，再集中写代码。第 1 轮主题：自我进化阶段4完整流水线 + 自动批准审计落库（要能直接写）。

背景：已有阶段3（失败模式→提案→老板决定）、evolution-guard（路径白名单/黑名单、diff≤5文件≤150行、保护文件sha256、canApply 审批规则）、attention-gate（push/inbox/auto/archive 规则）、owner-time 指标、SSE 消费、handoff ack 状态机（纯逻辑已接 dispatch 的隐式 receive/超时 sweep）。

请给：
1) 阶段4流水线状态机：从 accepted 提案到「可合并」的每一步（状态名、触发者、输入输出、失败分支），谁在什么时候创建 worktree/分支、谁跑测试、谁 review、谁批准合并；用文字时序图（8-12 步）。
2) 自动批准审计表：字段（至少覆盖 action_type/project/target/before/after/actor/rule_version/decided_at/reverted_at/rollback_ref/证据指针），存哪、保留多久、如何按 (action_type, project) 统计历史批准次数（attention-gate auto 规则需要）；被撤销后如何降级并留痕。
3) 审计/回滚的接口设计：路径、body、返回；谁可以调用（maintenance bot / owner）；幂等键。
4) 与现有代码接线的文件清单和顺序（最多 6 个文件），每步跑什么测试。
5) 4 小时可交付边界：必做/可砍，以及一个「绝不做」的红线。
最后 3 行：阶段4最容易失控的地方和一句话防线。

## Claude 的回答

`★ Insight ─────────────────────────────────────`
- 阶段4的核心不是"能自动改",而是**批准绑定到具体 head_sha**。任何新 commit 都会让之前的测试、review 和批准全部作废。
- 审计表用 append-only 事件(approved / reverted),信任等级由事件折叠得出,不做可变状态。这样"降级并留痕"是天然结果,不用另写逻辑。
`─────────────────────────────────────────────────`

以下基于你给的背景。我没读代码,字段名和路径是建议,接线前请对照 `evolution-guard` 和 `attention-gate` 的实际签名。

## 1) 阶段4流水线状态机

状态:`accepted → provisioning → implementing → guarding → testing → reviewing → merge_ready → merged`
终态:`aborted | rejected | expired`。每步失败分支都进终态或回 `implementing`,最多 2 次修复循环。

| 状态 | 触发者 | 输入 → 输出 | 失败分支 |
|---|---|---|---|
| provisioning | maintenance bot | 提案(含 base_sha)→ 建 worktree 和分支 `evo/<id>`,记录 base_sha | 建失败或 base 已漂移:`aborted` |
| implementing | implementer agent(在 worktree 内) | 提案 → 提交 commit | 超时或无 diff:`aborted` |
| guarding | 纯函数(evolution-guard) | diff 与 base 对比 → 路径白名单/黑名单、≤5 文件、≤150 行、保护文件 sha256 | 违规:**直接 `rejected`,不重试**(重试等于绕过) |
| testing | bot 执行**固定命令表** | head_sha → 退出码和日志指针 | 红:回 implementing(计 1 次);第 3 次红:`rejected` |
| reviewing | reviewer agent(与 implementer 不同会话,只读) | diff + 提案 → 结构化 verdict `pass/block` + 理由 | block:回 implementing(计 1 次) |
| merge_ready | 纯函数 | guard、tests、review 三项都绑定同一 head_sha,且 `canApply` 为真 | head_sha 变化:退回 guarding |
| merged | **仅老板点击**,bot 执行 | `approve-merge{head_sha}` → 复检 guard 和保护 sha 后 merge | 复检失败:`rejected` |

文字时序:
1. 老板在阶段3把提案标为 accepted,流水线记录 `proposal_id` 和 `base_sha`。
2. bot 建 worktree 和分支,状态进 provisioning。
3. implementer 在 worktree 内改,提交 commit。
4. guard 校验 diff。违规直接 rejected。
5. bot 按固定命令表跑测试(typecheck、vitest 等),命令不得来自提案。
6. reviewer 独立读 diff,只看 diff 和提案,不看 implementer 的推理。
7. 三项通过后写入 `merge_ready`,并推一条 attention-gate 事件(push 类)。
8. 老板在 UI 点"批准合并",带 `head_sha`。
9. bot 复检:head_sha 一致、保护文件 sha 不变、base 未漂移太多(否则要求 rebase 并回到 guarding)。
10. merge 后跑一次 post-merge 冒烟测试。失败就自动 `git revert` 并写 reverted 审计事件。
11. 清理 worktree,在 transcript 里落一条记录。

## 2) 自动批准审计表

**存储**:沿用 dispatch 现有的存储。如果现在是 JSONL,就用 `data/audit/approvals.jsonl` 追加写,启动时折叠进内存索引。数据量小,别为此引入数据库。

**字段**:
- `id`,`idempotency_key`
- `event`:`approved | reverted`
- `action_type`,`project`,`target`
- `before_hash` / `after_hash`,以及小体积的 before/after 摘要
- `actor`:`owner | bot:<name>`
- `mode`:`manual | auto`
- `rule_version`
- `decided_at`
- `reverted_at`,`rollback_ref`(revert 事件里填,引用原 `id`)
- `evidence`:`[{kind, ref, sha256}]`,指向 transcript 行、测试日志、diff

**保留**:原始事件至少 365 天,不删。之后只能压缩为聚合行,且保留最近一次 revert 的时间。

**统计 `(action_type, project)`**:
- `manual_approved`:`mode=manual` 且未被 revert 的数量。
- `auto_approved`:`mode=auto` 且未被 revert 的数量。
- `reverted_count`,`last_revert_at`。

> **关键约束**:attention-gate 的 auto 资格只数 `manual_approved`,**自动批准不计入自己的资格**。否则 auto 会自我强化,信任无限膨胀。
>
> 建议规则:manual 不少于 3,且 `last_revert_at` 距今超过 14 天。

**撤销降级**:
- 写一条 `reverted` 事件,引用原 `id` 和 `rollback_ref`(即 revert commit)。
- 该 `(action_type, project)` 的 manual 计数从 `last_revert_at` 起重新累计,即归零。
- 触发 14 天冷却。
- 同一对象累计 2 次 revert 则锁定为 `ask_only`,只有老板显式解锁才恢复。
- 这些都由折叠推导,不存可变状态。

## 3) 接口设计

**鉴权**:`bot token` 与 `owner token` 分开。bot 只能写 approved 事件和降级方向的 reverted 事件,不能提升信任。

- `POST /api/audit/auto-approvals`(bot)
  - body:`{idempotency_key, action_type, project, target, before, after, rule_version, evidence[]}`
  - 返回:`{id, deduped, trust:{level, manual_approved, cooldown_until}}`
  - 幂等键:`sha256(action_type|project|target|after_hash|rule_version)`
- `POST /api/audit/auto-approvals/:id/revert`(owner,或 bot 在 post-check 失败时调用)
  - body:`{idempotency_key, reason, rollback_ref}`
  - 返回:`{id, reverted_at, trust_after}`
  - 重复调用返回已有事件(`deduped:true`),不报错。
- `GET /api/audit/approval-stats?action_type&project`
  - 返回 `{manual_approved, auto_approved, reverted_count, last_revert_at, eligible_for_auto}`
  - 供 attention-gate 调用,同进程内直接调函数即可,不必走 HTTP。
- `POST /api/evolution/pipeline/:id/approve-merge`(仅 owner)
  - body:`{head_sha}`
  - 返回:新状态
  - 幂等键:`(pipeline_id, head_sha)`
- bot 推进状态可共用 `POST /api/evolution/pipeline/:id/events`,body 为 `{event, idempotency_key, payload}`。

## 4) 接线顺序(6 个文件)

注意:工作区里 `server/index.ts`、`dispatch.ts` 等已有未提交改动。先提交或隔离这些改动,再动 `index.ts`。

1. `server/approval-audit.ts`(新)+ `approval-audit.test.ts`
   - 内容:append、折叠、stats、信任推导。
   - 测试:自动批准不计资格;revert 后归零;2 次 revert 后锁定;幂等键去重。
2. `server/evolution-pipeline.ts`(新)+ `evolution-pipeline.test.ts`
   - 内容:纯 `transition(state, event)`;git、测试、reviewer 以端口形式注入。
   - 测试:每个失败分支;head_sha 变化导致批准失效;第 3 次测试红进 rejected。
3. `server/attention-gate.ts`
   - 内容:auto 规则接入 `approval-stats`。
   - 测试:跑现有 gate 测试;补一条"冷却期内不得 auto"。
4. `server/index.ts`
   - 内容:挂 4 个路由和鉴权。
   - 测试:路由级冒烟,覆盖幂等重放、bot 越权被拒。

跑测试时,每步先跑本文件测试,再跑全量,保证 `dispatch.test.ts` 不回归。

## 5) 4 小时边界

**必做**:
- 状态机纯逻辑,带完整测试。
- 审计 append/折叠/统计。
- 路由和鉴权。
- gate 接入。
- worktree 创建和固定命令表测试(git CLI 直调)。
- merge 仅限老板点击。

**可砍**:
- 真实的 reviewer agent(先用 stub,返回"需人工审"并强制老板看 diff)。
- UI 面板。
- SSE 推送。
- 压缩聚合。
- post-merge 自动 revert(先只记录)。

**红线(绝不做)**:阶段4的产物不得在没有老板人工点击的情况下进入主分支或运行中的服务。同时,guard、audit、attention-gate、pipeline 这四个文件必须列入保护文件 sha256 清单,进化不能改自己的护栏。

`★ Insight ─────────────────────────────────────`
- 把 git、测试、reviewer 都做成注入端口,是为了让 4 小时内能先交付可测的纯逻辑,真实 agent 之后再换。
- implementer 和 reviewer 隔离会话,是为了避免"自己审自己"。
`─────────────────────────────────────────────────`

最容易失控的地方:自动批准的信任自我膨胀,以及进化改到自己的护栏文件。
一句话防线:auto 资格只数老板手动批准的次数,且护栏文件在 sha256 保护清单里,任何 head_sha 变化都会让批准作废。
建议先定一件事:审计是追加 JSONL 还是进现有数据库,这决定第 1 步的写法。
