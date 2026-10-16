// The composer's stand-in for an approval card that is out of view: what is
// waiting, a way back to the card, and the answers that need no reading.
import { useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { Diamond } from "@/components/ui/index";
import { approvalDecision, approvalLabel, isRoutineApproval, isSkillApproval, type Pending } from "../PendingApproval";
import { approvalPreview, previewTitle } from "./approval-preview";

export function PendingApprovalStrip({
  pending,
  count,
  threadId,
  bot,
  onShow,
  onCancelTurn,
}: {
  pending: Pending;
  count: number;
  threadId: string;
  bot?: Bot;
  onShow: () => void;
  onCancelTurn: () => void;
}) {
  const { dispatch } = useStore();
  const durable = isRoutineApproval(pending) || isSkillApproval(pending);
  const card = pending.message.card;
  const title = durable
    ? card?.title.trim() || approvalLabel(pending)
    : (card && previewTitle(approvalPreview(card.tool, card.subtitle, card.approvalScope))) || approvalLabel(pending);
  const base = "h-7 shrink-0 rounded-lg px-2.5 text-[12px] font-semibold whitespace-nowrap";
  return (
    // a container, so a narrow chat (a side panel open) drops the extras
    // first: "Cancel turn" below 448px, "Review" (the label opens the card
    // too) below 384px — the answers stay
    <div className="@container/strip mb-2">
    <div
      role="region"
      aria-label={t("Pending approval")}
      className="flex items-center gap-2 rounded-[12px] bg-warning/[0.08] py-1.5 pr-1.5 pl-3 text-[12.5px] text-ink inset-ring inset-ring-warning/25"
    >
      <Diamond size={11} />
      <button type="button" onClick={onShow} className="min-w-0 flex-1 truncate text-left hover:underline" title={t("Show the approval card")}>
        <span className="font-semibold">{t("Waiting for your approval")}</span>
        <span className="text-ink-secondary"> · {title}</span>
        {count > 1 && <span className="text-ink-secondary"> · {t("{index} of {count}", { index: 1, count })}</span>}
      </button>
      {!durable && (
        <button
          type="button"
          onClick={onCancelTurn}
          className={cn(base, "font-medium text-ink-secondary hover:bg-raised-hover hover:text-ink @max-md/strip:hidden")}
        >
          {t("Cancel turn")}
        </button>
      )}
      <button type="button" onClick={onShow} className={cn(base, "bg-raised text-ink hover:bg-raised-hover", !durable && "@max-sm/strip:hidden")}>
        {t("Review")}
      </button>
      {!durable && (
        <button
          type="button"
          onClick={() => dispatch(approvalDecision(pending, threadId, "deny", { bot }))}
          className={cn(base, "bg-control text-ink hover:bg-raised-hover")}
        >
          {t("Deny")}
        </button>
      )}
      {!durable && (
        <button
          type="button"
          onClick={() => dispatch(approvalDecision(pending, threadId, "allow", { bot }))}
          className={cn(base, "bg-primary text-primary-ink hover:brightness-110")}
        >
          {t("Allow once")}
        </button>
      )}
    </div>
    </div>
  );
}
