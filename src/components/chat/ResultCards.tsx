// Result cards in the chief's chat (design U8): a dispatch run started from
// this conversation — goal, status pill, progress, who is on it — and a
// decision taken in a meeting, with the ways back to the details.
import { useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { api, openNotificationTarget, useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { msg, t, tn } from "@/lib/i18n";
import { Progress } from "@/components/ui/index";
import type { DispatchRun, RunStatus, SubtaskStatus } from "../../../shared/dispatch-types";
import type { OrgDecision } from "../../../shared/org-types";
import { isActiveRun, runProgress } from "./chat-model";
import { CardButton, ChatCard, MetaDot, MenuItem, PopoverPanel, StatusPill, useDismiss, type StatusTone } from "./primitives";
import { IconChevronDown } from "./icons";

const RUN_PILL: Record<RunStatus, { label: string; tone: StatusTone }> = {
  "awaiting-approval": { label: msg("Waiting to start"), tone: "amber" },
  running: { label: msg("In progress"), tone: "blue" },
  synthesizing: { label: msg("Summarizing"), tone: "blue" },
  done: { label: msg("Completed"), tone: "green" },
  failed: { label: msg("Failed"), tone: "red" },
  canceled: { label: msg("Cancelled"), tone: "grey" },
};

const SUBTASK_DOT: Record<SubtaskStatus, string> = {
  pending: "bg-ink-secondary/40",
  running: "bg-select",
  done: "bg-success",
  failed: "bg-danger",
  skipped: "bg-ink-secondary/40",
  canceled: "bg-ink-secondary/40",
};

const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text);

export function DispatchRunCard({ run, bots }: { run: DispatchRun; bots: readonly Bot[] }) {
  const { state, dispatch } = useStore();
  const [menu, setMenu] = useState(false);
  const [working, setWorking] = useState<"approve" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismiss(menu, () => setMenu(false), menuRef);

  const progress = runProgress(run);
  const pill = RUN_PILL[run.status];
  const names = [...new Set(run.subtasks.map((subtask) => bots.find((bot) => bot.id === subtask.assigneeBotId)?.name).filter(Boolean))] as string[];
  const shown = names.slice(0, 3).map((name) => `@${name}`).join(t(", "));
  const more = names.length > 3 ? t(" +{count} more", { count: names.length - 3 }) : "";
  const openable = run.subtasks.filter((subtask) => subtask.threadId && bots.some((bot) => bot.id === subtask.assigneeBotId));

  const act = async (verb: "approve" | "cancel") => {
    setWorking(verb);
    setError(null);
    try {
      await api(`/api/dispatch/runs/${encodeURIComponent(run.id)}/${verb}`, { method: "POST" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(null);
    }
  };

  return (
    <ChatCard
      label={t("Dispatch: {goal}", { goal: run.goal })}
      title={clip(run.goal, 60)}
      pill={
        <StatusPill tone={pill.tone}>{t(pill.label)}</StatusPill>
      }
      live
      meta={
        <>
          <span>{t("{done}/{total} subtasks done", { done: progress.done, total: progress.total })}</span>
          {shown && (
            <>
              <MetaDot />
              <span>{t("Assigned to {names}", { names: `${shown}${more}` })}</span>
            </>
          )}
          {progress.failed > 0 && (
            <>
              <MetaDot />
              <span className="text-danger">{tn(progress.failed, "{count} failed", "{count} failed")}</span>
            </>
          )}
        </>
      }
      actions={
        run.status === "awaiting-approval" ? (
          <>
            <CardButton onClick={() => void act("approve")} disabled={Boolean(working)}>
              {working === "approve" && <Loader2 size={13} className="animate-spin" />}
              {t("Start")}
            </CardButton>
            <CardButton variant="grey" onClick={() => void act("cancel")} disabled={Boolean(working)}>
              {working === "cancel" && <Loader2 size={13} className="animate-spin" />}
              {t("Cancel")}
            </CardButton>
          </>
        ) : (
          <>
            <CardButton onClick={() => dispatch({ type: "showTeamMap" })}>{t("View")} ↗</CardButton>
            {openable.length > 0 && (
              <div ref={menuRef} className="relative">
                <CardButton variant="grey" onClick={() => setMenu((open) => !open)} aria-expanded={menu} aria-haspopup="menu">
                  {t("Open")}
                  <span className="ml-0.5 flex items-center border-l border-ink/15 pl-1.5 text-ink-secondary">
                    <IconChevronDown size={12} />
                  </span>
                </CardButton>
                {menu && (
                  <PopoverPanel label={t("Open a subtask")} className="bottom-full left-0 mb-1.5 w-[300px]">
                    {openable.map((subtask) => {
                      const assignee = bots.find((bot) => bot.id === subtask.assigneeBotId);
                      return (
                        <MenuItem
                          key={subtask.id}
                          icon={<span className={cn("size-2 rounded-full", SUBTASK_DOT[subtask.status])} />}
                          hint={assignee ? `@${assignee.name}` : undefined}
                          onClick={() => {
                            setMenu(false);
                            if (assignee && subtask.threadId) {
                              openNotificationTarget(dispatch, { botId: assignee.id, threadId: subtask.threadId }, state);
                            }
                          }}
                        >
                          {subtask.title}
                        </MenuItem>
                      );
                    })}
                  </PopoverPanel>
                )}
              </div>
            )}
          </>
        )
      }
    >
      {isActiveRun(run.status) && progress.total > 0 && (
        <Progress value={progress.done} total={progress.total} tone="blue" className="mt-0.5 max-w-[280px]" />
      )}
      {error && <p className="text-[12px] text-danger">{error}</p>}
    </ChatCard>
  );
}

/** A decision taken in a meeting, shown in the chief's chat. */
export function DecisionCard({ decision }: { decision: OrgDecision }) {
  const { state, dispatch } = useStore();
  const group = decision.source.kind === "group" ? state.groups.find((candidate) => candidate.id === decision.source.id) : undefined;
  const items = decision.actionItems.length;
  const openGroup = (focus: boolean) => {
    if (!group) return;
    dispatch({ type: "select", id: group.id });
    if (focus && decision.source.messageId) {
      dispatch({ type: "focusMessage", threadId: group.threadId, messageId: decision.source.messageId });
    }
  };
  const who = decision.decidedBy === "owner" ? t("You decided") : t("Decided by the team");
  return (
    <ChatCard
      label={t("Decision #{id}", { id: decision.id })}
      title={group ? `${group.name} · ${t("Decision #{id}", { id: decision.id })}` : t("Decision #{id}", { id: decision.id })}
      pill={
        <StatusPill tone="green">{t("Decided")}</StatusPill>
      }
      meta={
        <>
          <span>
            {who} {decision.title} <b className="font-semibold text-ink">{decision.choice}</b>
          </span>
          {items > 0 && (
            <>
              <MetaDot />
              <span>{tn(items, "{count} action item sent out", "{count} action items sent out")}</span>
            </>
          )}
          {!!decision.basis?.length && (
            <>
              <MetaDot />
              <span>{t("Based on {sources}", { sources: decision.basis.slice(0, 3).join(t(", ")) })}</span>
            </>
          )}
        </>
      }
      actions={
        group ? (
          <>
            <CardButton onClick={() => openGroup(true)}>{t("View decision")} ↗</CardButton>
            <CardButton variant="grey" onClick={() => openGroup(false)}>
              {t("Open the group")}
            </CardButton>
          </>
        ) : undefined
      }
    />
  );
}
