// Approvals → company events. Every authorization decision the harness takes
// is already written to the decision log (server/decision-log.ts) at the
// exact moment it is known; the org layer sees each row as it is appended and
// turns the ones the owner cares about into events:
//
//   card-shown (not a plain question)  → approval.requested
//   auto-approved                      → approval.auto
//   user-approved / user-denied        → approval.resolved
//   expired                            → approval.expired
//
// Reviewer shadow verdicts and bare questions are not company news.
import type { DecisionRow } from "../decision-log.ts";
import { t } from "../../shared/i18n.ts";
import type { OrgEvent } from "../../shared/org-types.ts";
import type { AutoApprovedRow } from "./brief.ts";
import type { OrgEventInput } from "./run-events.ts";
import { firstLine } from "./util.ts";

export type DecisionRowInput = Omit<DecisionRow, "at"> & { at?: string };

export interface ApprovalEventContext {
  botName?: string;
  section?: string;
  groupId?: string;
}

/** What the bot wanted, in one short line. */
export function actionOf(row: Pick<DecisionRow, "summary" | "tool">): string {
  return firstLine(row.summary, 60) || firstLine(row.tool, 60) || t("an action");
}

/** The rule that approved something for the owner, in their language. */
export function ruleLabel(row: Pick<DecisionRow, "source" | "rule">): string {
  switch (row.source) {
    case "always-allow":
      return t("Always allowed: {key}", { key: row.rule ?? "" });
    case "auto-mode":
      return t("Auto mode is on for this bot");
    case "auto-review":
      return row.rule ? t("The reviewer approved it: {reason}", { reason: firstLine(row.rule, 80) }) : t("The reviewer approved it");
    default:
      return row.rule ? firstLine(row.rule, 80) : row.source;
  }
}

export function approvalEventFor(row: DecisionRowInput, ctx: ApprovalEventContext): OrgEventInput | null {
  const name = ctx.botName ?? row.botName ?? "?";
  const action = actionOf(row);
  const base: Partial<OrgEvent> = {
    ...(row.botId ? { botId: row.botId } : {}),
    ...(ctx.section ? { section: ctx.section } : {}),
    threadId: row.threadId,
    ...(ctx.groupId ? { groupId: ctx.groupId } : {}),
    detail: action,
  };
  switch (row.decision) {
    case "card-shown":
      if (row.source === "question") return null;
      return {
        ...base,
        kind: "approval.requested",
        title: row.source === "external-publish"
          ? t("{name} wants to publish outside — needs your approval: {action}", { name, action })
          : t("{name} is waiting for your approval: {action}", { name, action }),
        severity: "warn",
      };
    case "auto-approved":
      return { ...base, kind: "approval.auto", title: t("Approved for {name} by rule: {action}", { name, action }), severity: "info" };
    case "user-approved":
      return { ...base, kind: "approval.resolved", title: t("You approved {name}: {action}", { name, action }), severity: "info" };
    case "user-denied":
      return { ...base, kind: "approval.resolved", title: t("You denied {name}: {action}", { name, action }), severity: "info" };
    case "expired":
      return {
        ...base,
        kind: "approval.expired",
        title: t("Expired unanswered while unattended — {name}: {action}", { name, action }),
        severity: "warn",
      };
    default:
      return null;
  }
}

/** An auto-approval as the brief lists it ("approved for you by a rule"). */
export function autoApprovedRow(row: DecisionRowInput & { at: string }): AutoApprovedRow | null {
  if (row.decision !== "auto-approved") return null;
  const at = Date.parse(row.at);
  if (!Number.isFinite(at)) return null;
  return {
    id: row.requestId ?? `${row.threadId}:${at}`,
    title: actionOf(row),
    botId: row.botId ?? "",
    at,
    rule: ruleLabel(row),
  };
}
