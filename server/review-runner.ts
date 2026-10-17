// ReviewRunner：把 ReviewerPort 的纯逻辑接到引擎的「一轮会话」上。
//
// ReviewerPort（server/reviewer-port.ts）只负责两头：可校验的输入
// （criteria 永不截断、evidence 有预算和 nonce 围栏）与可拒绝的输出
// （quote 逐字校验、失败降级 unclear）。这里补中间那段：
//
//   evidence 组装 → prepareReviewInput → ReviewHost.startTurn（90s 上限）
//   → 严格解析 JSON → validateFindings → verdictsFromFindings
//
// 两条硬规则：
//   1. 失败一律降级，绝不抛异常、绝不重试。调用方（gate）永远拿到一个按
//      criteria 顺序排列的完整 verdicts 列表；失败时全部 unverifiable。
//   2. 真实模型只提供证据，代码是唯一裁决者。解析、quote 校验、映射都不
//      信任模型的自述；编造 quote 会被降级成 unclear 并计入 dropped。
//
// ReviewHost 是唯一需要注入的引擎口（真实实现由 Lead 在 server/index.ts
// 接线：隐藏的 system bot + 临时会话；测试注入 FakeReviewHost）。这个文件
// 不碰 registry/bus/index.ts，也不读磁盘（artifacts 由调用方读好传入）。
import type {
  AcceptanceCriterion,
  DispatchHandoff,
  GateCriterionVerdict,
} from "../shared/dispatch-types.ts";
import {
  prepareReviewInput,
  validateFindings,
  verdictsFromFindings,
  type ReviewerEvidence,
  type ReviewerFinding,
} from "./reviewer-port.ts";
import type { ReviewLedger } from "./review-ledger.ts";

/** 评审一轮的硬上限。host 自己也要收这个值；runner 再跑一个同长度看门狗，
 * 防止一个卡死的 host 把 gate 永久挂住。 */
export const REVIEW_TIMEOUT_MS = 90_000;

/** host.startTurn 的默认评审员身份：一个 hidden/system bot，每次评审用临时
 * 会话（真实接线由 Lead 提供）。 */
export const REVIEWER_BOT_ID = "system:reviewer";

/** 单轮 prompt 的字符上限。criteria 永不截断：如果 criteria 本身放不下，
 * 直接 input_too_large，而不是让模型去评一份被截过的标准。 */
export const MAX_PROMPT_CHARS = 32_000;

/** 引擎口：跑一轮评审会话并拿回文本。真实实现必须遵守 timeoutMs（到点
 * 中断并返回 ok:false）；runner 的看门狗是兜底。tokensIn/tokensOut/costUsd/
 * model 是可选记账字段，真实接线从 turn 的 usage 里填。 */
export interface ReviewHostResult {
  ok: boolean;
  reply: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  model?: string;
}

export interface ReviewHost {
  startTurn(input: { botId: string; prompt: string; timeoutMs: number }): Promise<ReviewHostResult>;
}

/** 评审的失败分类。全部是可降级的结果，不是异常。 */
export type ReviewFailure = "timeout" | "bad_json" | "host_error" | "quote_mismatch" | "input_too_large";

/** 评审记录里能带上的定位/成本元信息（都由调用方提供；runner 不知道
 * run/subtask 的存在）。 */
export interface ReviewMeta {
  runId?: string;
  subtaskId?: string;
  attemptId?: string;
  model?: string;
}

export interface RunReviewInput {
  /** 要逐条判断的验收标准；永不截断，逐字进 prompt。 */
  criteria: AcceptanceCriterion[];
  /** worker 的结果正文，作为第一块证据。 */
  result: string;
  /** 结构化 handoff：summary/evidence/artifacts/decisions/… 渲染成一块证据。 */
  handoff?: DispatchHandoff;
  /** 调用方已经解析出的产物路径（只作为出处列给评审员；runner 不读磁盘）。
   * 产物内容请放进 evidence 块。 */
  arts?: readonly string[];
  /** 调用方已经读好/限流过的额外证据块（例如产物摘录）。 */
  evidence?: readonly ReviewerEvidence[];
  /** 引擎口（真实实现由 Lead 接线；测试注入 fake）。 */
  host: ReviewHost;
  /** 评审员 bot 身份，缺省 system:reviewer。 */
  botId?: string;
  /** 覆盖 90s 上限（测试用；真实调用不要传）。 */
  timeoutMs?: number;
  /** 可注入的时间戳，写进 ledger 的 at（测试用）。 */
  now?: number;
  /** 可选的落盘账本；写失败绝不影响评审结果。 */
  ledger?: ReviewLedger;
  meta?: ReviewMeta;
}

export interface ReviewResult {
  ok: boolean;
  /** 永远与 criteria 等长、同序；失败时全部 unverifiable。 */
  verdicts: GateCriterionVerdict[];
  /** 被逐字校验拒绝的 finding（已降级为 unclear）。 */
  dropped: Array<{ criterionId: string; reason: string }>;
  failure?: ReviewFailure;
  /** tokensIn + tokensOut（host 没报就没有）。 */
  tokens?: number;
  costUsd?: number;
}

/** 可注入（host）的评审执行器：做成显式类型，Lead 接线时只依赖这个形状。 */
export type ReviewRunner = (input: RunReviewInput) => Promise<ReviewResult>;

type HostOutcome =
  | { kind: "ok"; result: ReviewHostResult }
  | { kind: "timeout" }
  | { kind: "error" };

/** 调一轮 host，带看门狗。host 的迟到回复/迟到拒绝会被 Promise.race 吞掉，
 * 不产生未处理拒绝。 */
async function invokeHost(host: ReviewHost, request: { botId: string; prompt: string; timeoutMs: number }): Promise<HostOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const watchdog = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), request.timeoutMs);
    });
    const raced = await Promise.race([host.startTurn(request), watchdog]);
    if (raced === "timeout") return { kind: "timeout" };
    return { kind: "ok", result: raced };
  } catch {
    return { kind: "error" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── evidence 组装 ──────────────────────────────────────────────────────

function handoffText(handoff: DispatchHandoff): string {
  const lines: string[] = [`status: ${handoff.status}`, `summary: ${handoff.summary}`];
  const list = (label: string, values: readonly string[] | undefined) => {
    if (!values?.length) return;
    lines.push(`${label}:`);
    for (const value of values) lines.push(`- ${value}`);
  };
  list("worker evidence", handoff.evidence);
  list("artifacts", handoff.artifacts);
  if (handoff.decisions?.length) {
    lines.push("decisions:");
    for (const decision of handoff.decisions) lines.push(`- ${decision.what}${decision.why ? ` (why: ${decision.why})` : ""}`);
  }
  list("assumptions", handoff.assumptions);
  list("open questions", handoff.openQuestions);
  if (handoff.risks?.length) {
    lines.push("risks:");
    for (const risk of handoff.risks) {
      lines.push(`- ${risk.risk}${risk.impact ? ` (impact: ${risk.impact})` : ""}${risk.next ? ` (next: ${risk.next})` : ""}`);
    }
  }
  if (handoff.nextStep) lines.push(`next step: ${handoff.nextStep}`);
  if (typeof handoff.acceptanceMet === "boolean") lines.push(`worker self-assessment: acceptanceMet=${handoff.acceptanceMet}`);
  return lines.join("\n");
}

/** 顺序即预算优先级：result → handoff → 调用方证据 → 产物路径。 */
export function reviewEvidence(input: Pick<RunReviewInput, "result" | "handoff" | "arts" | "evidence">): ReviewerEvidence[] {
  const blocks: ReviewerEvidence[] = [];
  if (input.result.trim()) blocks.push({ id: "result", text: input.result });
  if (input.handoff) blocks.push({ id: "handoff", text: handoffText(input.handoff) });
  for (const entry of input.evidence ?? []) {
    if (entry.text.trim()) blocks.push({ id: entry.id, text: entry.text });
  }
  if (input.arts?.length) {
    blocks.push({ id: "artifact-paths", text: `artifacts declared by the worker:\n${input.arts.join("\n")}` });
  }
  return blocks;
}

// ── 严格解析 ───────────────────────────────────────────────────────────

/** 严格 JSON：整段 reply 必须直接解析成 {"findings":[…]}；代码围栏、前后
 * 解说、缺字段、未知 verdict 一律 bad_json（不重试，重试只会翻倍成本）。 */
export function parseReviewerReply(reply: string): ReviewerFinding[] | null {
  const trimmed = reply.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const findings = (parsed as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) return null;
  const accepted: ReviewerFinding[] = [];
  for (const raw of findings) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const row = raw as Record<string, unknown>;
    const criterionId = typeof row.criterionId === "string" ? row.criterionId.trim() : "";
    if (!criterionId) return null;
    const verdict = row.verdict;
    if (verdict !== "supported" && verdict !== "unsupported" && verdict !== "unclear") return null;
    if (row.quote !== undefined && typeof row.quote !== "string") return null;
    if (row.reason !== undefined && typeof row.reason !== "string") return null;
    accepted.push({
      criterionId,
      verdict,
      ...(typeof row.quote === "string" ? { quote: row.quote } : {}),
      ...(typeof row.reason === "string" ? { reason: row.reason } : {}),
    });
  }
  return accepted;
}

// ── 一轮评审 ───────────────────────────────────────────────────────────

function accounting(hostResult: ReviewHostResult | undefined): { tokens?: number; costUsd?: number } {
  if (!hostResult) return {};
  const hasIn = typeof hostResult.tokensIn === "number" && Number.isFinite(hostResult.tokensIn);
  const hasOut = typeof hostResult.tokensOut === "number" && Number.isFinite(hostResult.tokensOut);
  const hasCost = typeof hostResult.costUsd === "number" && Number.isFinite(hostResult.costUsd);
  return {
    ...(hasIn || hasOut ? { tokens: (hostResult.tokensIn ?? 0) + (hostResult.tokensOut ?? 0) } : {}),
    ...(hasCost ? { costUsd: hostResult.costUsd } : {}),
  };
}

/** 跑一轮独立评审。永不抛异常、永不重试；失败返回 ok:false + failure。 */
export const runReview: ReviewRunner = async (input) => {
  const criteria = input.criteria ?? [];
  const startedAt = input.now ?? Date.now();
  const startedReal = Date.now();
  const timeoutMs = input.timeoutMs ?? REVIEW_TIMEOUT_MS;
  const failureVerdicts = () => verdictsFromFindings(criteria, []);
  let hostResult: ReviewHostResult | undefined;

  /** 单一出口：先记 ledger（失败只吞掉），再返回结果。 */
  const finish = (result: ReviewResult): ReviewResult => {
    if (!input.ledger) return result;
    try {
      const model = input.meta?.model ?? hostResult?.model;
      input.ledger.append({
        ...(input.meta?.runId ? { runId: input.meta.runId } : {}),
        ...(input.meta?.subtaskId ? { subtaskId: input.meta.subtaskId } : {}),
        ...(input.meta?.attemptId ? { attemptId: input.meta.attemptId } : {}),
        ...(model ? { model } : {}),
        ...(typeof hostResult?.tokensIn === "number" ? { tokensIn: hostResult.tokensIn } : {}),
        ...(typeof hostResult?.tokensOut === "number" ? { tokensOut: hostResult.tokensOut } : {}),
        ...(typeof hostResult?.costUsd === "number" ? { costUsd: hostResult.costUsd } : {}),
        durationMs: Math.max(0, Date.now() - startedReal),
        outcome: result.ok ? "ok" : "degraded",
        failure: result.failure ?? null,
        quoteDropped: result.dropped.length,
        at: startedAt,
      });
    } catch {
      // 账本写不进去（磁盘满/只读）不能改变评审结论。
    }
    return result;
  };

  const degrade = (failure: ReviewFailure): ReviewResult =>
    finish({ ok: false, verdicts: failureVerdicts(), dropped: [], failure, ...accounting(hostResult) });

  // 没有标准就没有可评审的东西：不发 turn（省一次模型调用）。
  if (!criteria.length) return { ok: true, verdicts: [], dropped: [] };

  const prepared = prepareReviewInput({ criteria, evidence: reviewEvidence(input) });
  if (prepared.prompt.length > MAX_PROMPT_CHARS) return degrade("input_too_large");

  // 一轮，仅一轮。host 卡住时看门狗到点返回 timeout；迟到的回复被丢弃。
  const outcome = await invokeHost(input.host, {
    botId: input.botId ?? REVIEWER_BOT_ID,
    prompt: prepared.prompt,
    timeoutMs,
  });
  if (outcome.kind === "timeout") return degrade("timeout");
  if (outcome.kind === "error") return degrade("host_error");
  hostResult = outcome.result;
  if (!hostResult.ok || typeof hostResult.reply !== "string") return degrade("host_error");

  const findings = parseReviewerReply(hostResult.reply);
  if (!findings) return degrade("bad_json");

  const { accepted, dropped } = validateFindings(findings, prepared.evidence);
  // 编造/长度越界的 quote 已被降级为 unclear；整轮标记 quote_mismatch 让
  // 调用方知道「这次评审不可信」，仍保留可用的裁决映射。
  const failure: ReviewFailure | undefined = dropped.length ? "quote_mismatch" : undefined;
  return finish({
    ok: !failure,
    verdicts: verdictsFromFindings(criteria, accepted),
    dropped,
    ...(failure ? { failure } : {}),
    ...accounting(hostResult),
  });
};
