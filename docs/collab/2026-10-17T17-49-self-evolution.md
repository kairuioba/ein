# Claude 协作记录 · self-evolution

- 时间：2026-10-17T17:49:13.336Z
- 模型：sonnet（effort medium）
- 耗时：53.0s
- 本次花费：$0.1121（累计 $2.0372 / 上限 $Infinity）
- 调用：第 17 次（窗口剩余 171 分钟）
- ⚠️ 检测到额度/限流信号，已按约定停止

## 我们的问题

金主追加需求：软件自我进化（self-evolution）必须落地，已经要求每件软件相关的事都讨论出具体方案。请给可落地的设计（不是泛泛而谈）。

已有基础：docs/self-improvement-loop.md（四层：复盘→经验库→改进→护栏）；阶段1 复盘（dispatch 结束写硬事实 + GET /api/dispatch/retros）已实现；阶段2 验收闸门（criteria/gate/rework/needs_human）已实现；ReviewerPort 非模型部分（有界输入/quote 校验/裁决映射）已实现；StateDoc Tier0（代码事实+漂移）已实现。现在正在实现阶段3 最小版：server/evolution.ts 从 retros+run.subtasks 抽信号（missing_acceptance / missing_handoff / artifact_missing / rework_loop / stalled / failed_exhausted / model_mismatch）→ 中文改进提案 → ~/.ein/evolution.json → GET /api/evolution / generate / resolve；老板 accepted/rejected/deferred。不会自动改代码/发版。

请回答（每条要具体、能指导落地）：
1. 阶段3 的信号与提案质量校验：怎么避免「偶发当规律」？最少样本量、去重/合并规则、证据展示、置信度或分级；哪些信号值得做，哪些先不做。
2. 提案的「可执行性」：proposal 应该包含哪些字段才能直接变成一次改动/实验（例：改动目标文件? prompt patch? plan template? 评估指标? 回滚方式?），不要只写「要改进 X」。
3. 闭环的验证与回滚：如何定义「改进前后指标」并用现有数据自动算（retros/gate/耗时/花费/重做率），样本不足时怎么标注；何时自动回滚（dev 渠道/backup 标签）。
4. UI 放哪：公司级/简报页/项目内工作台/侧栏？给老板看到的文案与操作（批准/拒绝/稍后/看证据），手机优先。
5. 阶段4（维护机器人自动开分支修）的最小安全闭环：谁触发、范围限制、测试门槛、审批点、如何防止自改自批；4 小时内能落多少。
6. 提醒：金主还说任何软件相关都可以讨论并优化——请顺带指出我们当前架构里「最值得下一轮自我进化系统先改」的一件事（基于你对我们实现的了解）。
最后 3 行：自我进化最容易被误解/做歪成什么，以及一句话防线。

## Claude 的回答

`★ Insight ─────────────────────────────────────`
我没有读代码,下面的结论只基于你描述的实现。
自我进化的难点不是生成提案,而是区分规律和噪声,并能证明改进有效。所以我把"版本戳"和"样本门槛"放在最前面。
`─────────────────────────────────────────────────`

## 1. 信号与提案质量

**分组键**:`(signal, scope, target)`。scope 取 project/role/model 之一,target 取具体的模板或 prompt。不要全局聚合,否则 A 项目的坏习惯会冲淡 B 项目。

**样本门槛(三档)**
- n=2:只记为观察,不出提案,只在证据里累计。
- n≥3 且来自 ≥2 个不同 dispatch、≥2 个不同日历日:出提案,置信度"低"。
- n≥5,或最近 20 次同 scope 派单中占比 ≥30% 且明显高于该 scope 的历史基线:置信度"高"。

**先排除噪声**:老板手动取消、dev/测试派单、网络/429/限流这类基础设施错误,都不算工作流规律。stalled 还要剔除机器休眠造成的超时。

**去重与合并**
- 指纹 = hash(signal|scope|target)。已有 open 提案时只追加证据并更新计数,不新建。
- rejected 提案冷却 14 天,只有计数翻倍才重新出现。
- accepted 的提案不再重复生成,转入效果观察。
- deferred 提案 7 天后重现,或计数翻倍时重现。
- missing_acceptance 和 missing_handoff 若同属一个 planner,合并成一条"规划模板"提案。

**证据展示**:最多 3 条,每条为 `dispatchId + 一句硬事实 + 时间`,并链到 retro。因果解释单独标"假设",不和事实混在一起。

**信号取舍**

| 信号 | 建议 | 原因 |
|---|---|---|
| missing_acceptance、missing_handoff、artifact_missing、failed_exhausted | 现在做 | 都是确定性事实,归因清楚 |
| rework_loop | 现在做,但只计数和聚类 gate 原因 | 根因难判断,先不写"为什么" |
| stalled | 延后 | 阈值依赖环境,噪声大 |
| model_mismatch | 先不做 | 任务难度会混淆结论,至少需要每个 model×任务类型 ≥10 个样本 |

## 2. 提案字段(可直接变成改动或实验)

```
id, fingerprint, status(open|accepted|applied|observing|verified|reverted|rejected|deferred)
signal, scope{project,role,model}, confidence, stats{n,distinct,window,rate,baseline}
evidence[{dispatchId,fact,ts}]
hypothesis        # 明确标"假设"
change{
  kind: prompt_patch | plan_template | gate_config | timeout_config | routing_config | code_task
  target: 文件路径或配置 key
  patch: before/after 文本或 unified diff   # code_task 可为空,只给 description
  blast_radius: 影响哪些角色/项目
}
metric{name, formula, baseline, target, window:"后续10次或7天", min_samples}
guardrails[]      # 不许恶化的指标:failed_exhausted 率、单次花费
rollback{type: restore_backup|revert_commit, ref}
appliedAt, appliedVersion, resolvedBy, resolvedAt, rejectReason?
```

约束:`kind` 用枚举,不用自由文本。系统只能自动落地 prompt_patch、plan_template 和 config 三类,code_task 只能进阶段 4。accepted 不等于 applied,必须有独立状态,因为"采纳"和"真正生效"之间的时间差会毁掉前后对比。

## 3. 验证与回滚

**指标(全部可由 retros 算出)**
- gate 一次通过率
- 单 dispatch 的平均重做次数
- needs_human 率
- 缺验收标准率
- failed_exhausted 率
- 耗时 p50
- 单 dispatch 花费

**前后对比**
- 窗口:applied 之前的 N 个 dispatch 对比之后的 N 个,限同 scope,N 默认 8。
- 样本不足时显示"观察中 3/8",不给结论。
- 判定:相对变化 >20% 且绝对变化 ≥2 个事件才算改善或恶化,否则算"持平"。
- 同一 scope 同时只允许一个实验,避免混淆。
- 每次实验记录 model id,模型升级时对比标"可能受模型变更影响"。

**回滚**
- 落地前备份到 `~/.ein/backups/<id>/`,代码类改动打 git tag `evo/<id>-pre`。
- 触发条件:after 样本 ≥8,且目标指标恶化超过阈值,或任一 guardrail 恶化。
- dev 渠道且提案带 `autoRollback` 标记时自动回滚。
- 生产渠道只推送"建议回滚"并提供一键回滚,不自动执行。

## 4. UI

**位置**
- 简报页只放一张卡,仅在 pending>0 时出现,显示最高优先的一条和"共 N 条"。
- 完整列表放在从该卡进入的二级页面,不新增侧栏项。
- 项目工作台的 pulse 区只显示该项目 scope 的提案。

**文案示例**:"最近 9 次派单里有 4 次没写验收标准 → 建议在规划模板加一条必填项。"下面一行小字写"置信度:中 · 3 项目 · 看证据"。

**操作**:采纳 / 不采纳 / 稍后 / 看证据。
- "不采纳"附带可选的一键原因标签(不适用、已知、代价太高),标签用于冷却判断。
- 采纳后卡片状态依次变为"已采纳,待实施" → "观察中 3/8" → "有效 / 无效 / 样本不足"。

**手机优先**:单列,按钮高度 ≥44px,证据默认折叠,展开后只列 3 条。

## 5. 阶段 4 最小安全闭环

**触发**:只能由老板对一条 accepted 且 kind=code_task 的提案点"交给维护机器人"。不允许由信号自动触发。

**范围限制**
- 白名单路径:prompts/、templates/、docs/、指定配置文件。
- 黑名单:gate/reviewer/权限/鉴权/密钥、依赖和 CI 配置,以及白名单、黑名单文件本身。
- 单次 diff ≤150 行、≤5 个文件。
- 只在独立 worktree 的 `evo/<id>` 分支上操作,不推送,不发版。

**测试门槛**:typecheck + 现有测试全绿 + 至少一条覆盖该行为的新测试 + 程序化的 diff 范围检查。范围检查必须由代码判断,不能由模型判断。

**防自改自批**
- 提出者、实现者、审查者、批准者四方分离,批准者只能是老板。
- 机器人没有合并权限。
- 白名单、黑名单和 gate 代码做 hash 校验,哈希变化即拒绝。
- 审查用 ReviewerPort,换另一个会话或模型,且只作参考,不构成批准。

**4 小时能落的**
1. 触发 endpoint,加 worktree 和分支创建(约 1h)。
2. diff 范围检查器(约 45min)。
3. 测试 runner 门槛(约 45min)。
4. 结果卡,显示 diff 摘要和测试结果,带"合并 / 丢弃"按钮(约 1h)。
5. 只开放 prompt/template/doc 三类。

自动 reviewer 和 code_task 全类型放到下一轮。

## 6. 最值得先改的一件事

**给每次 dispatch 的 retro 加配置版本戳**,包括 prompt/plan 模板的 hash、gate 配置版本和 model id。

没有这个戳,前后对比无法归因,回滚也没有可靠的对象,第 3 条整套机制都会失效。成本很小:dispatch 结束写 retro 时多写三个字段。同时把 prompt 和模板从代码里抽成带版本的数据文件,这样提案的 patch 才有落点。

---
**最容易做歪成**:一个会自己生成大量"建议"的报告器,老板看一眼就麻木地全点"稍后"。
**更糟的情形**:系统悄悄改自己的 prompt 和 gate,却无法证明变好了。
**防线**:每条改动必须带"证据 + 指标 + 回滚",并由老板批准,三项缺一不能落地。
