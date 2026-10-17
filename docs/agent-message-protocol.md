# 异构多模型下的「收发逻辑」与派发逻辑（对标 Claude Code）

> 2026-10-17。老板明确：主要学 Claude Code 的**收发逻辑 + 派发逻辑**；我们和它最大的不同是——**每个子任务/子 Agent 用的是不同模型**（侦察用便宜模型、实现用强模型、验收用另一家模型）。
> 目标：吸收它的消息模型，做成我们自己的「异构模型统一信封」，而不是照搬它的单模型协作。

## 一、Claude Code 的收发逻辑（社区逆向 + 官方文档）

```
主 Agent ──(Task/Agent 工具调用：prompt)──▶ 子 Agent（独立上下文，通常同模型）
主 Agent ◀──(tool_result：最终报告)──────── 子 Agent（同步等待；多个调用可并行）
```

- **发**：一条自包含 prompt，子 Agent 看不到主对话历史；
- **收**：只收最终报告（final report），作为一条工具结果回到主上下文；
- **等待**：调用是同步的——主 Agent 在等待期间不继续决策；多个 Task 调用可并行，结果一起回来；
- **派发**：主 Agent 自己决定拆几个、什么时候发、是否并行；
- **上下文**：子 Agent 的过程噪音不回流，主上下文保持干净；
- **同构**：子 Agent 通常和主 Agent 同模型/同引擎，输出格式天然一致。

## 二、一念的不同：异构模型

| 维度 | Claude Code | 一念 Ein |
|---|---|---|
| 模型 | 基本同模型 | 每个子任务按任务难度/能力/价格选不同引擎和模型 |
| 主 Agent | 单进程内循环 | 总控（+部门负责人）跨会话调度 |
| 收 | tool_result 同步返回 | 异步 run：子任务后台跑，总控最后汇总 |
| 组织 | 无 | 部门、编制、预算、审批、验收人 |
| 失败处理 | 重试/换策略 | 换模型重试、加人、交给部门负责人 |

异构模型带来的真实问题：
1. 输出格式不一致（能不能稳定给结构化结果）；
2. 工具能力不一致（有的能写文件/跑命令，有的只能读）；
3. 成本/延迟差异大（便宜模型慢、贵模型贵）；
4. 上下文窗口差异（长上下文任务该派给谁）；
5. 失败模式不同（限流、超时、拒答、输出截断）。

## 三、我们的统一「信封」协议

### 3.1 发送信封（Send Envelope）

每个子任务发给执行者时，统一携带：

```json
{
  "envelope": "ein.agent.task/1",
  "taskId": "s3",
  "runId": "run-...",
  "role": { "key": "researcher", "title": "用户研究员", "templateVersion": 3 },
  "runner": { "instanceId": "workbuddy", "model": "minimax-m3", "effort": "medium" },
  "permissions": { "mode": "read-only", "tools": ["read", "search", "library"], "externalPublish": false },
  "context": {
    "charter": { "goal": "...", "successCriteria": "...", "nonGoals": "...", "constraints": "...", "deadline": "...", "budgetCny": 0 },
    "brief": "...",
    "acceptance": "...",
    "boundaries": "...",
    "deliverable": "...",
    "dependsOn": [{ "taskId": "s1", "handoff": { "..." : "..." } }]
  },
  "outputContract": "ein.agent.handoff/1",
  "limits": { "timeoutMs": 900000, "maxTokens": 0, "budgetCny": 0, "attempt": 1, "maxAttempts": 2 }
}
```

要点：
- **角色模板**决定提示词骨架与工具权限，模型只是执行者；
- **context 只带必要切片**（宪法 + 当前任务 + 直接依赖的 Handoff），不带全量历史；
- **limits** 让调度器能按模型差异做超时/预算/重试。

### 3.2 接收信封（Result Envelope）

```json
{
  "envelope": "ein.agent.handoff/1",
  "taskId": "s3",
  "status": "done | partial | blocked",
  "summary": "一句话交付了什么",
  "evidence": ["文件/链接/测试输出"],
  "artifacts": ["产物位置"],
  "decisions": [{ "what": "...", "why": "..." }],
  "assumptions": ["..."],
  "openQuestions": ["..."],
  "risks": [{ "risk": "...", "impact": "...", "next": "..." }],
  "nextStep": "接手的人第一步做什么",
  "acceptanceMet": true,
  "meta": {
    "instanceId": "workbuddy", "model": "minimax-m3", "effort": "medium",
    "tokens": 12345, "costCny": 0.42, "durationMs": 183000,
    "attempt": 1, "engineReportedUsage": true
  }
}
```

实现上不强制模型一定输出完美 JSON：解析器容忍缺失块，回退到纯文本（**已实现**，见下）；缺失 `handoff` 时不算失败，但验收/汇总会标注「无信封」。

### 3.3 跨模型归一化

- **提示词适配**：不同引擎在提示词末尾重复一次输出契约（同一段英文，减少方言差异）；
- **解析容错**：取最后一个 json 代码块；允许裸对象；字段缺失用默认值；超长截断；
- **校验**：status/summary 必备，缺失则回退纯文本；`acceptanceMet` 只是自评，最终由 reviewer 判；
- **类型归一**：`decisions/risks` 允许对象或字符串，解析时统一；
- **失败修复**：可选「补信封」重试（只让模型补 JSON，不重做任务），节省成本。

## 四、异构派发逻辑（Dispatch）

### 4.1 路由：先能力，后成本，再负载

1. **硬能力过滤**：上下文长度、视觉、中文、代码、工具权限（role 模板要求只读的，不能派给会乱写文件的）；
2. **成本分档**：侦察/草稿/格式化 → 便宜模型；关键实现/验收 → 强模型；
3. **引擎负载/限流**：同一引擎的并发上限、限流记忆（已有 `rateLimitedAt`）、跨引擎分摊，避免全挤在一家；
4. **本地/云端**：隐私/数据独立时可以指定本地或隔离环境。

### 4.2 失败与回退矩阵

| 失败 | 动作 |
|---|---|
| 限流 429 | 同任务换引擎/模型重试，保留原信封与依赖 Handoff |
| 超时 | 缩短任务或换更快模型；记录耗时 |
| 输出无法解析 | 先「补信封」重试一次，再回退纯文本 |
| 验收不过 | 换更强模型重试；仍不过 → 升级给部门负责人/总控 |
| 成本超预算 | 暂停并上报，不静默继续 |

### 4.3 扇出/扇入（Fan-out / Fan-in）

- 扇出：就绪子任务并行；同一任务内不同部门/不同模型可同时跑；
- 扇入：只收 **Result Envelope**，总控汇总不读整个过程；
- 验收：reviewer 按 acceptance 判，pass 才进最终交付；
- 同模型盲区：reviewer 尽量用**不同模型/不同引擎**（便宜但独立），降低「同一个模型看不出自己错」的风险。

### 4.4 两种等待模式

| 模式 | 用途 | 现状 |
|---|---|---|
| 异步计划（fire-and-forget） | 长任务、跨小时/天：总控派完就结束回合，结果回来再汇总 | ✅ 已实现 |
| 等待（await） | 紧凑循环：总控需要某个子结果才能决定下一步 | 🚧 设计：给 run 增加「await 指定子任务」能力，超时可退化为异步 |

## 五、一念的落地情况

| 能力 | 状态 |
|---|---|
| 每个子任务独立模型/引擎 + 强度 | ✅ 已有（推荐器） |
| 子任务独立上下文（独立会话） | ✅ 已有 |
| Result Envelope（Handoff）字段与解析 | ✅ **本次实现**：worker 提示词要求输出 fenced json；`server/agent-handoff.ts` 容错解析；存 `subtask.handoff`；总控汇总优先读信封 |
| 依赖结果只传 Handoff | ✅ 汇总已改；依赖注入仍会带结果，后续统一成信封 |
| 角色模板 + 工具权限 | 🚧 下一步 P0 |
| 回退矩阵/跨引擎重试 | 🚧 部分（retry/rate-limit 已有） |
| await 模式 | 🚧 设计完成 |
| 验收闸门 | 🚧 P1 |
| 异构模型成本/延迟记录 | 🚧 部分（ranWith/usage/复盘已有，信封 meta 待补） |

## 六、下一步（1.1.4 → 1.1.5）

1. **角色模板库**（P0）：`role` → 提示词骨架 + 工具权限 + 默认模型档位；
2. **按角色工具权限**（P0）：只读/读写/命令/发布四档，派单员工按模板继承；
3. **信封 meta**（P1）：把 tokens/cost/duration/model 写进 handoff meta，复盘可读；
4. **验收闸门**（P1）：reviewer（不同模型）按 acceptance 判 pass/fail；
5. **await 模式**（P2）：给紧凑任务用；
6. **跨引擎回退矩阵**（P2）：失败/限流时自动换模型，保留信封与依赖。

## 七、来源

- Claude Code 子 Agent 文档：https://code.claude.com/docs/en/agent-sdk/subagents
- 社区逆向分析：https://wavespeed.ai/blog/zh-TW/posts/claude-code-architecture-leaked-source-deep-dive/ 、https://developer.cloud.tencent.cn/article/2648801 、https://cloud.tencent.com.cn/developer/article/2701698
- 抖音原视频（本机网络打不开）：https://v.douyin.com/4lNT_no8ci8/
