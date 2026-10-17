// 验收闸门 v1（确定性代理版）：不调用 LLM，先把「完成」从模型自述里拆出来。
//
// - 计划可以带结构化 criteria；旧计划的单条 acceptance 映射成一条 legacy 标准；
// - 确定性检查由代码做：Handoff 是否存在、产物路径是否存在、结果是否为空；
// - 没有 LLM reviewer 时，subjective 标准标记为 unverifiable，整单为
//   needs_human（进「需要你」收件箱），不静默通过；
// - Handoff 自评 acceptanceMet=false 直接 needs_human；
// - 未来加独立 reviewer 时，只替换 judgeCriteria，聚合规则不变。
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import type {
  AcceptanceCriterion,
  DispatchHandoff,
  DispatchSubtask,
  GateCheck,
  GateCriterionVerdict,
  SubtaskGate,
} from "../shared/dispatch-types.ts";

export interface GateInput {
  subtask: Pick<DispatchSubtask, "acceptance" | "criteria" | "handoff" | "result" | "currentAttemptId">;
  /** where relative artifact paths are resolved (the worker's working folder) */
  cwd?: string;
  now?: number;
}

/** Old plans: one free-form acceptance string becomes one legacy criterion. */
export function criteriaFor(subtask: GateInput["subtask"]): AcceptanceCriterion[] {
  if (subtask.criteria?.length) return subtask.criteria;
  const legacy = subtask.acceptance?.trim();
  return legacy ? [{ id: "legacy-1", text: legacy, required: true, kind: "subjective" }] : [];
}

function artifactCheck(handoff: DispatchHandoff | undefined, cwd: string | undefined): GateCheck {
  const artifacts = handoff?.artifacts ?? [];
  if (!artifacts.length) return { name: "artifacts", ok: true, detail: "no artifact paths declared" };
  if (!cwd) return { name: "artifacts", ok: false, unverifiable: true, detail: "cannot resolve artifact paths (no working folder)" };
  const missing = artifacts.filter((path) => {
    const full = isAbsolute(path) ? path : resolve(cwd, path);
    return !existsSync(full);
  });
  // text-only models often "declare" artifacts they never wrote; a missing
  // path is a human question, not a proven failure
  return missing.length
    ? { name: "artifacts", ok: false, unverifiable: true, detail: `missing: ${missing.slice(0, 3).join(", ")}` }
    : { name: "artifacts", ok: true, detail: `${artifacts.length} artifact(s) present` };
}

/** Deterministic checks: cheap, code-only, no model. */
export function deterministicChecks(subtask: GateInput["subtask"], cwd?: string): GateCheck[] {
  const checks: GateCheck[] = [];
  checks.push({
    name: "result",
    ok: Boolean(subtask.result?.trim()),
    detail: subtask.result?.trim() ? `${subtask.result.length} chars` : "empty result",
  });
  checks.push({
    name: "handoff",
    ok: Boolean(subtask.handoff?.summary?.trim()),
    // a weaker model may answer without the envelope: ask a human instead of
    // declaring the work failed
    unverifiable: !subtask.handoff?.summary?.trim(),
    detail: subtask.handoff ? `status ${subtask.handoff.status}` : "no structured handoff",
  });
  checks.push(artifactCheck(subtask.handoff, cwd));
  const badPlaceholders = /\b(TODO|FIXME|TBD)\b/.test(subtask.result ?? "");
  checks.push({ name: "placeholders", ok: !badPlaceholders, detail: badPlaceholders ? "TODO/FIXME left in the result" : "none" });
  return checks;
}

/** Aggregate the deterministic checks + (future) reviewer verdicts into one
 * gate result. The code decides; a model's own summary is never the verdict. */
export function evaluateGate(input: GateInput): SubtaskGate {
  const criteria = criteriaFor(input.subtask);
  if (!criteria.length) {
    return { status: "pass", criteria: [], deterministic: [], reason: "no acceptance criteria", at: input.now ?? Date.now(), provisional: true };
  }
  const deterministic = deterministicChecks(input.subtask, input.cwd);
  // a reply without the envelope is never a pass; it needs a human
  if (input.subtask.handoff?.synthetic) {
    return {
      status: "needs_human",
      criteria: criteria.map((criterion) => ({ id: criterion.id, status: "unverifiable" as const, evidence: "worker replied without the handoff envelope" })),
      deterministic,
      reason: "the worker did not use the handoff envelope",
      at: input.now ?? Date.now(),
      provisional: true,
    };
  }
  const failedChecks = deterministic.filter((check) => !check.ok);
  const hardFailures = failedChecks.filter((check) => !check.unverifiable);
  const handoff = input.subtask.handoff;
  const verdicts: GateCriterionVerdict[] = criteria.map((criterion) => {
    if (handoff?.acceptanceMet === false) {
      return { id: criterion.id, status: "unverifiable", evidence: "worker reported acceptance not met" };
    }
    if (criterion.kind === "deterministic") {
      const check = criterion.check ? deterministic.find((entry) => entry.name === criterion.check) : undefined;
      if (check) return { id: criterion.id, status: check.ok ? "pass" : "fail", evidence: check.detail };
      return { id: criterion.id, status: "unverifiable", evidence: "no deterministic check mapped" };
    }
    // subjective criteria need a reviewer; without one they are unverifiable
    return { id: criterion.id, status: "unverifiable", evidence: "no independent reviewer yet" };
  });
  if (failedChecks.length && !hardFailures.length) {
    return {
      status: "needs_human",
      criteria: verdicts,
      deterministic,
      reason: `cannot verify: ${failedChecks.map((check) => check.name).join(", ")}`,
      at: input.now ?? Date.now(),
      provisional: true,
    };
  }
  if (hardFailures.length) {
    return { status: "fail", criteria: verdicts, deterministic, reason: `deterministic: ${hardFailures.map((check) => check.name).join(", ")}`, at: input.now ?? Date.now(), provisional: true };
  }
  const required = criteria.filter((criterion) => criterion.required);
  const requiredVerdicts = verdicts.filter((verdict) => required.some((criterion) => criterion.id === verdict.id));
  const unknown = requiredVerdicts.filter((verdict) => verdict.status === "unverifiable");
  if (unknown.length) {
    return { status: "needs_human", criteria: verdicts, deterministic, reason: `${unknown.length} required criterion(ia) cannot be verified without a reviewer`, at: input.now ?? Date.now(), provisional: true };
  }
  const failed = requiredVerdicts.filter((verdict) => verdict.status === "fail");
  if (failed.length) {
    return { status: "fail", criteria: verdicts, deterministic, reason: `required criteria failed: ${failed.map((verdict) => verdict.id).join(", ")}`, at: input.now ?? Date.now(), provisional: true };
  }
  return { status: "pass", criteria: verdicts, deterministic, at: input.now ?? Date.now(), provisional: true };
}
