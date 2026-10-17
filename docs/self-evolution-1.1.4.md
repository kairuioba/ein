# 自我进化（阶段 3）：失败模式 → 改进提案闭环

更新于 2026-10-18，对应分支 `feat/1.1.4`。这份文档说清楚：这个版本落地了什么、
数据从哪来、老板怎么用、哪些还没做。

## 一、一句话

把「任务 → 结果 → 复盘 → **改进提案** → 老板拍板 →（下一阶段）修复/验证/发布」
里的「复盘 → 改进提案 → 拍板」这一段做成真的：从真实复盘与验收闸门数据里归并出
失败模式，生成中文可读的改进提案，老板勾批准/拒绝/缓办，结果落盘可追溯。
**本版不自动改代码、不发版。**

## 二、现状盘点

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 | 复盘硬事实：每次派单结束写 `~/.ein/dispatch-retros.ndjson`，`GET /api/dispatch/retros` 可读（耗时/重试/模型/状态/版本戳） | ✅ 已完成 |
| 2 | 验收闸门：结构化验收标准 + 确定性检查（结果、交接单、产物路径、占位符）+ 人工/独立评审；不通过退回重做，重试耗尽进「需要你」 | ✅ 已完成 |
| 3 | 失败模式归并 + 改进提案 + 老板拍板（本轮） | ✅ 本版落地（最小可用版） |
| 4 | 老板批准的提案 → 维护机器人开分支修复 → 测试/开发版/人工验收 → 转正 | ⏳ 下一阶段，见「阶段 4 计划」 |

## 三、本版做了什么

新增三个文件，只动 `server/index.ts` 的三条路由（不改已有路由）：

1. `server/evolution.ts`
   - `deriveSignals({ retros, runs, now })`：从复盘 + 派单事实归并失败模式，无数据返回 `[]`；
   - `proposeImprovements(signals)`：每个失败模式一条中文提案（为什么 / 建议怎么改 / 影响面 / 风险 / 证据）；
   - `EvolutionStore`：`~/.ein/evolution.json`，`append`（同失败模式已有未处理提案则跳过）/ `list` / `resolve`（accepted / rejected / deferred + 备注）。
2. `server/evolution.test.ts`：12 条测试（见第七节）。
3. `server/index.ts` 三条路由：
   - `GET /api/evolution` → `{ signals, proposals, open }`（信号实时派生 + 已存提案合并视图）；
   - `POST /api/evolution/generate` → 重新派生并幂等入库，返回 `{ signals, added, skipped, proposals }`；
   - `POST /api/evolution/:id/resolve` → body `{ status: accepted|rejected|deferred, note? }`；未知 id 404，非法 status 400。
4. 本文档。

不改 UI，其它模块（`server/dispatch.ts`、验收闸门、decision-stack、office-view）一行未动。

## 四、数据来源（只读）

| 来源 | 字段 | 用途 |
|---|---|---|
| 复盘 `dispatch-retros.ndjson`（阶段 1） | `status`、`counts`、每个子任务的 `status/attempts/ranWith.model/durationMs`、`durationMs`、`versions`（prompt/gate/模型目录版本戳） | 历史重试耗尽、超长任务、同角色换模型成败；版本戳供阶段 4 做「改进前后」归因 |
| 内存派单 `dispatcher.list()`（阶段 2 数据） | `subtask.gate`（`status: pass/fail/needs_human`、`deterministic` 检查、`reason`）、`subtask.handoff`（有无/是否补写）、`subtask.criteria`、`subtask.acceptance`、`subtask.reworkCount/reworkNote`、`subtask.attempts/error`、`subtask.startedAt`、`run.status/updatedAt` | 缺失验收标准、缺失交接单、产物缺失、反复退回、失败耗尽、停滞 |

注意：复盘记录本身没有 gate/handoff 字段，所以「验收类」信号以内存派单为准；
派单被历史裁剪（14 天/60 条）后，只剩复盘里能表达的模式（失败耗尽 / 超长 / 换模型）。

## 五、失败模式 → 提案（本版 7 种）

| pattern | 触发（硬事实） | 提案影响面 / 风险 |
|---|---|---|
| `missing_acceptance` | 子任务结束/失败却没有验收标准；或闸门 `needs_human` 且标准只能靠人判 | prompt / low |
| `missing_handoff` | 交付完成但没有结构化交接单（或员工回复里没有信封，系统补写的也算） | prompt / low |
| `artifact_missing` | 交接单声明了产物路径，但闸门的产物检查找不到 | code / low |
| `rework_loop` | `reworkCount >= 2`（被老板退回两次以上） | process / medium |
| `stalled` | 子任务或整单超过 2 小时没有任何活动；或复盘显示整单跑超 2 小时 | code / medium |
| `failed_exhausted` | 子任务用光重试次数仍失败（默认 2 次；复盘与内存派单都算） | process / medium |
| `model_mismatch` | 复盘里同一角色在 A 模型失败、换 B 模型后成功 | code / medium |

信号结构：`{ id: "signal-<pattern>", pattern, evidence[], count, lastSeenAt }`；
同一 `pattern` 的 `id` 稳定，提案幂等靠它。

## 六、闭环状态机（本版边界）

```
(真实派单跑完)
        │ 复盘硬事实 + 派单/闸门事实
        ▼
  deriveSignals() ──► 失败模式信号（实时、不落盘）
        │ proposeImprovements()
        ▼
  POST /api/evolution/generate
        │  EvolutionStore.append（同 signal 已有 open 提案 → skipped）
        ▼
  ┌────────────┐ 老板拍板（POST /:id/resolve）  ┌───────────┐
  │   open     │ ────────────────────────────► │ accepted  │──► 阶段 4：维护机器人开分支修复
  │  （提案）   │ ────────────────────────────► │ rejected  │    （本版到此为止，不自动执行）
  └────────────┘ ────────────────────────────► │ deferred  │
        ▲                                      └───────────┘
        └── 老板处理完后，同一失败模式再次出现可以重新生成新提案
```

- 状态只有四种：`open` → `accepted` / `rejected` / `deferred`；
- 第一次决定即最终（重复 `resolve` 幂等，不会覆盖）；
- 每次决定记录 `resolvedAt` 与备注 `note`，落盘可追溯；
- 提案本身带全部证据，老板可以自己核对「是不是偶发」。

## 七、测试

`vitest run server/evolution.test.ts`（12 条）：

1. 无数据 → 无信号、无提案；
2. gate `needs_human` → `missing_acceptance` / `missing_handoff`（含计数与证据）；
3. 闸门产物检查失败 → `artifact_missing`（证据带缺失路径）；
4. `reworkCount >= 2` → `rework_loop`，退 1 次不算模式；
5. 重试耗尽 → `failed_exhausted`（内存派单 + 复盘两处计数），首败不算；
6. 2 小时无活动 / 复盘超长 → `stalled`；
7. 同角色换模型才成功 → `model_mismatch`；同模型成败不报；
8. 提案文案：每信号一条、中文可读、无 attempt/criteria 等黑话、带证据/影响面/风险；
9. 存储：落盘 + 重新加载；
10. 幂等：同 signal 已有 open 提案不重复生成；
11. `resolve` 幂等 + 备注 + 未知 id 报错 + 处理后可再次提案；
12. 文件缺失/损坏时从空开始（不崩）。

`tsc -p tsconfig.server.json` 通过。

接口示例（`POST /api/evolution/generate` 返回的其中一条提案）：

```json
{
  "id": "evo-7f3c…",
  "signal": "missing_handoff",
  "title": "员工交付缺少结构化交接单",
  "why": "有 2 次交付只给了自然语言，没有交接单（小结/证据/产物/是否达标），验收和后续接手都缺依据。第一条证据：「官网改版」的「任务 copy」交付时没有写结构化交接单（小结/证据/产物/是否达标）",
  "suggestedChange": "在员工提示词与退回反馈里固定要求交接单信封；没写就提示补交。对能力较弱的模型仍保留人工验收，不静默通过。",
  "area": "prompt",
  "risk": "low",
  "evidence": ["…"],
  "status": "open"
}
```

## 八、护栏（本版怎么保证不失控）

- **只读输入**：信号/提案只读复盘与派单事实，不写任何业务数据；唯一写入是自己
  `~/.ein/evolution.json`；
- **不改代码、不发版**：提案只是文字；`accepted` 也只代表老板同意「下一阶段可以做」，
  真正的分支/测试/发布仍在阶段 4 的既有护栏里（测试硬门槛、只发 dev、发布前人工批准、
  `backup/v<版本>` 可回滚、预算上限）；
- **人保留决定权**：生成可以做，批准/拒绝/缓办只有老板能点；
- **幂等不打扰**：同一失败模式同时最多一条未处理提案，避免每次生成刷屏；
- **证据可核对**：每条提案带原始证据（哪个任务、哪个子任务、闸门原话），不做模型判断；
- **口径与状态文档一致**：停滞 2 小时与 `server/state-doc.ts` 同口径。

## 九、4 小时可交付边界

本版在时间盒内**只做后端最小闭环**：类型 + 派生 + 提案 + 存储 + 三条路由 + 文档 + 测试。
刻意不做：UI、自动修复、发版联动、指标库、定期任务。这样评审者可以在不启动 Electron、
不连模型的情况下用测试和接口验证全部逻辑。

## 十、阶段 4 计划（未做）

1. UI：工作台/简报加「自我进化」卡片，展示 open 提案与批准/拒绝按钮；
2. 定期生成：用 routine（如每周）自动跑 `POST /api/evolution/generate`，只发 dev；
3. 批准后联动维护机器人：开 `fix/<主题>` 分支、跑测试、发 dev、老板验收；
4. 指标前后对比：用复盘里的 `versions`（prompt/gate/模型目录）+ 成功率/返工率
   对比改进前后，无效即回滚；
5. 模型能力库：`model_mismatch` 累积到一定样本后，把「角色 × 模型 × 成功率」写进
   推荐器，并显示依据；
6. 审批/预算联动：如果提案涉及成本或对外行为，走既有审批与预算规则。

## 十一、未做清单（本版明确不做）

- 无 UI，无 SSE 订阅端（只广播 `kind: "evolution"`，前端下一版接）；
- 不自动生成分支/不改代码/不发版，不接 `gh`；
- 不存失败信号本身（每次实时派生；只持久化提案与决定）；
- 不做提案去重之外的排序/优先级学习，不做多设备同步；
- 跨派单的「同角色换模型」样本可能不足，信号会偏少而不是偏多（宁可漏，不乱报）；
- 派单被历史裁剪后，验收类信号会消失（复盘记录里没有 gate/handoff 字段）。
