// Result cards in the chief's chat (design U8): a dispatch run started from
// this conversation — goal, status pill, progress, who is on it — and a
// decision taken in a meeting, with the ways back to the details.
import { Fragment, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Sparkles } from "lucide-react";
import { api, openNotificationTarget, useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { msg, t, tn } from "@/lib/i18n";
import { Progress } from "@/components/ui/index";
import { dispatchSettings, type DispatchRun, type RunStatus, type SubtaskStatus } from "../../../shared/dispatch-types";
import type { OrgDecision } from "../../../shared/org-types";
import { isActiveRun, runProgress } from "./chat-model";
import { CardButton, ChatCard, MetaDot, MenuItem, PopoverPanel, StatusPill, useDismiss, type StatusTone } from "./primitives";
import { IconChevronDown } from "./icons";
import { applyAllRecommendations, pendingRecommendations, SubtaskModelControls } from "@/components/dispatch/SubtaskModel";

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
  // people added mid-run (中途加人): one squad per addition, until the run ends
  const squads = (run.squads ?? []).filter((squad) => !squad.endedAt);

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
          {squads.map((squad) => (
            <Fragment key={`${squad.name}:${squad.addedAt}`}>
              <MetaDot />
              <span>{tn(squad.botIds.length, "{squad} · {count} person", "{squad} · {count} people", { squad: squad.name })}</span>
            </Fragment>
          ))}
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
      <RunModels run={run} bots={bots} />
      {error && <p className="text-[12px] text-danger">{error}</p>}
    </ChatCard>
  );
}

/** The most subtasks the card lists; the workbench shows every one. */
const MODEL_ROWS = 8;

/** Each subtask's engine, model and effort, with the recommendation. Open
 * while the plan waits for you to press Start — the moment to choose. */
function RunModels({ run, bots }: { run: DispatchRun; bots: readonly Bot[] }) {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(run.status === "awaiting-approval");
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settings = dispatchSettings(state.config?.dispatch);
  const waiting = pendingRecommendations(run, bots, state.instances, settings);
  const rows = run.subtasks.slice(0, MODEL_ROWS);
  const hidden = run.subtasks.length - rows.length;
  if (!run.subtasks.length) return null;
  const applyAll = async () => {
    setApplying(true);
    setError(null);
    setError(await applyAllRecommendations(run, bots, state.instances, settings));
    setApplying(false);
  };
  return (
    <div className="mt-1 rounded-[11px] bg-inset/70 px-2.5 py-1.5 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_25%,transparent)]">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1 py-0.5 text-left text-[12px] font-semibold text-ink-secondary hover:text-ink"
        >
          {open ? <ChevronDown size={13} className="shrink-0" /> : <ChevronRight size={13} className="shrink-0" />}
          <span className="truncate">{t("Model and effort for each subtask")}</span>
        </button>
        {waiting > 0 && (
          <button
            type="button"
            onClick={() => void applyAll()}
            disabled={applying}
            className="inline-flex shrink-0 items-center gap-1 text-[12px] font-semibold text-accent-text hover:underline disabled:opacity-50"
          >
            {applying ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            {tn(waiting, "Use the recommendation", "Use all {count} recommendations")}
          </button>
        )}
      </div>
      {open && (
        <div className="mt-1 flex flex-col">
          {rows.map((subtask) => {
            const assignee = bots.find((bot) => bot.id === subtask.assigneeBotId);
            return (
              <div key={subtask.id} className="flex min-w-0 flex-col gap-1 border-t border-hairline/25 py-2">
                <div className="flex min-w-0 items-center gap-1.5 text-[12.5px]">
                  <span className={cn("size-2 shrink-0 rounded-full", SUBTASK_DOT[subtask.status])} />
                  <span className="min-w-0 truncate font-medium text-ink">{subtask.title}</span>
                  {assignee && <span className="shrink-0 text-ink-secondary">@{assignee.name}</span>}
                </div>
                <SubtaskModelControls run={run} subtask={subtask} bot={assignee} />
              </div>
            );
          })}
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => dispatch({ type: "showTeamMap" })}
              className="border-t border-hairline/25 pt-1.5 text-left text-[12px] font-semibold text-accent-text hover:underline"
            >
              {tn(hidden, "{count} more in the workbench ↗", "{count} more in the workbench ↗")}
            </button>
          )}
          {error && <p className="text-[11.5px] text-danger">{error}</p>}
        </div>
      )}
    </div>
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
