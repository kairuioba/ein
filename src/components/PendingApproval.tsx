// Pending approval. The card in the transcript (ApprovalCard) is where an
// approval is answered; while one is open the composer stays locked, and
// when that card is scrolled out of sight the composer shows a compact
// strip (chat/ApprovalStrip) so a waiting bot is still impossible to miss.
//
// Faithful details worth keeping: one at a time with an "n of N" counter,
// the detail printed raw in a monospace block that is NEVER truncated
// (it scrolls instead), and the buttons ordered least-destructive-last so
// the primary action sits under your thumb.
import { memo } from "react";
import { useStore, type Action, type Bot, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { SkillRequestPreview } from "@/components/SkillRequestPreview";
import { t } from "@/lib/i18n";
import { reviewedSkillSha256 } from "../../shared/skill-request";

interface ApprovalLabels {
  [tool: string]: string;
}

export interface Pending {
  message: Message;
  requestId: string;
  tool: string;
  /** the narrow grant "always allow" writes, computed server-side */
  allowKey?: string;
  detail: string;
  held?: string;
}

/** The persisted payload is the authoritative marker. Tool names are
 * provider-authored display strings and can collide with ours. */
export function isRoutineApproval(pending: Pending): boolean {
  return Boolean(pending.message.card?.routineRequest);
}

export function isSkillApproval(pending: Pending): boolean {
  return Boolean(pending.message.card?.skillRequest);
}

/** Open approvals on a thread, oldest first — answered/dismissed drop out. */
export function pendingApprovals(messages: Message[]): Pending[] {
  return messages
    .filter((m) => m.kind === "options" && m.card?.requestId && m.card.tool && !m.card.answered && !m.card.dismissed)
    .map((m) => ({
      message: m,
      requestId: m.card!.requestId!,
      tool: m.card!.tool!,
      allowKey: m.card!.allowKey,
      detail: m.card!.subtitle,
      held: m.card!.held,
    }));
}

/** Routine cards can carry every instruction the user asked for (up to
 * 20,000 characters). Calls should announce the concise, visible title and
 * let the user review those details on screen instead of reading them all. */
export function spokenApprovalPrompt(pending: Pending, requester: string): string {
  const isRoutineRequest = isRoutineApproval(pending);
  const isSkillRequest = isSkillApproval(pending);
  if (isSkillRequest) {
    const title = pending.message.card?.title.trim() || t("Enable this skill?");
    return t("{name} asks: {title}{stop} Review the skill on screen. Should I enable it?", {
      name: requester,
      title,
      stop: /[.!?。！？]$/.test(title) ? "" : ".",
    });
  }
  if (!isRoutineRequest) {
    return t("{name} wants to {tool}. {detail}. Should I allow it?", {
      name: requester,
      tool: pending.tool,
      detail: pending.detail,
    });
  }
  const title = pending.message.card?.title.trim() || t("Confirm this routine?");
  return t("{name} asks: {title}{stop} Review the schedule and instructions on screen. Should I confirm it?", {
    name: requester,
    title,
    stop: /[.!?。！？]$/.test(title) ? "" : ".",
  });
}

/** What kind of approval this is, in a few words. */
export function approvalLabel(pending: Pending): string {
  if (isSkillApproval(pending)) {
    return t("Enable this learned skill");
  }
  if (isRoutineApproval(pending)) {
    return pending.message.card?.routineRequest?.operation.action === "create"
      ? t("Confirm this routine")
      : t("Confirm this routine change");
  }
  const nice: ApprovalLabels = {
    Bash: t("Command approval requested"),
    shell: t("Command approval requested"),
    Read: t("File-read approval requested"),
    Write: t("File-change approval requested"),
    Edit: t("File-change approval requested"),
    edit: t("File-change approval requested"),
  };
  return nice[pending.tool] ?? t("Approval requested");
}

export const PendingApprovalPanel = memo(function PendingApprovalPanel({
  pending,
  count,
  index,
}: {
  pending: Pending;
  count: number;
  index: number;
}) {
  return (
    <div
      role="region"
      aria-label={isSkillApproval(pending) ? t("Pending skill confirmation") : isRoutineApproval(pending) ? t("Pending routine confirmation") : t("Pending approval")}
      className="rounded-t-2xl border-b border-hairline/50 bg-control/40 px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-2" aria-live="polite">
        <span className="text-[11px] uppercase tracking-[0.18em] text-ink-secondary">{t("Pending approval")}</span>
        {count > 1 && (
          <span className="rounded-full bg-control px-1.5 py-0.5 text-[11px] tabular-nums text-ink-secondary">
            {t("{index} of {count}", { index: index + 1, count })}
          </span>
        )}
        <span className="text-[13px] text-ink">{approvalLabel(pending)}</span>
        <span className="font-mono text-[11px] text-ink-secondary">
          {isSkillApproval(pending)
            ? "stage_skill"
            : isRoutineApproval(pending)
            ? pending.message.card?.routineRequest?.operation.action === "create"
              ? "schedule_routine"
              : "manage_routine"
            : pending.tool}
        </span>
      </div>
      {/* never truncated — long commands wrap and scroll */}
      <pre
        tabIndex={0}
        aria-label={isSkillApproval(pending) ? t("Skill details to review") : isRoutineApproval(pending) ? t("Routine details to review") : t("Approval details to review")}
        className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink"
      >
        {pending.detail}
      </pre>
      {pending.message.card?.skillRequest && (
        <SkillRequestPreview request={pending.message.card.skillRequest} />
      )}
      {pending.held && <div className="mt-2 text-[12px] text-warning">{pending.held}</div>}
    </div>
  );
});

/** The one way an approval is answered, shared by the transcript card, the
 * composer strip and the old panel: the same request, the reviewed skill
 * hash on allow, and "always allow" remembered against whoever asked. */
export function approvalDecision(
  pending: Pick<Pending, "requestId" | "allowKey" | "message">,
  threadId: string,
  behavior: "allow" | "deny",
  options: { always?: boolean; bot?: Pick<Bot, "id">; onError?: (message: string) => void } = {},
): Extract<Action, { type: "decideRequest" }> {
  const reviewedSha256 = pending.message.card?.skillRequest
    ? reviewedSkillSha256(pending.message.card.skillRequest)
    : undefined;
  return {
    type: "decideRequest",
    threadId,
    requestId: pending.requestId,
    behavior,
    message: behavior === "deny" ? "Denied by the user." : undefined,
    reviewedSha256: behavior === "allow" ? reviewedSha256 : undefined,
    alwaysAllow:
      options.always && options.bot && pending.allowKey ? { botId: options.bot.id, key: pending.allowKey } : undefined,
    onError: options.onError,
  };
}

export function PendingApprovalActions({
  pending,
  threadId,
  bot,
  onCancelTurn,
}: {
  pending: Pending;
  threadId: string;
  /** who asked — "always allow" is remembered against them */
  bot?: Bot;
  onCancelTurn: () => void;
}) {
  const { dispatch } = useStore();
  const isRoutineRequest = isRoutineApproval(pending);
  const isSkillRequest = isSkillApproval(pending);
  const durableRequest = isRoutineRequest || isSkillRequest;
  const reviewedSha256 = pending.message.card?.skillRequest
    ? reviewedSkillSha256(pending.message.card.skillRequest)
    : undefined;
  const decide = (behavior: "allow" | "deny", always = false) =>
    dispatch(approvalDecision(pending, threadId, behavior, { always, bot }));

  const base = "rounded-full px-3.5 py-1.5 text-[13.5px] transition-colors";
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 px-2 py-2">
      {!durableRequest && (
        <button onClick={onCancelTurn} className={cn(base, "text-ink-secondary hover:bg-control hover:text-ink")}>
          {t("Cancel turn")}
        </button>
      )}
      <button
        onClick={() => decide("deny")}
        className={cn(base, "border border-danger/40 text-danger hover:bg-danger/10")}
      >
        {isRoutineRequest ? t("Cancel") : t("Deny")}
      </button>
      {!durableRequest && bot && pending.allowKey && (
        <button
          onClick={() => decide("allow", true)}
          title={t("Stop asking {name} about {key}", { name: bot.name, key: pending.allowKey })}
          className={cn(base, "border border-hairline/50 text-ink hover:bg-control")}
        >
          {t("Always allow")}
        </button>
      )}
      <button
        onClick={() => decide("allow")}
        disabled={isSkillRequest && !reviewedSha256}
        className={cn(
          base,
          "bg-primary font-medium text-primary-ink hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40",
        )}
      >
        {isSkillRequest ? t("Enable") : isRoutineRequest ? t("Confirm") : t("Allow once")}
      </button>
    </div>
  );
}
