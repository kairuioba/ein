// The calendar's right detail panel (U14): 启用 · 删除 · 试运行, who takes part,
// who hosts, when (+ 再加一个), the agenda or instructions, the last minutes or
// result, and the run history. Built from routines, runs, calls, the call's
// room transcript and the org's decisions — nothing here is stored separately.
import { useMemo, useState } from "react";
import {
  CalendarClock,
  Check,
  CircleAlert,
  Clock3,
  Cloud,
  ExternalLink,
  FileText,
  Laptop,
  Loader2,
  Lock,
  Minus,
  PanelRightClose,
  Pencil,
  Phone,
  Repeat2,
  X,
} from "lucide-react";

import { BotAvatar } from "@/components/Avatar";
import { Switch } from "@/components/SettingsPrimitives";
import { Button, Diamond, Pill, SidePanel, type PillTone } from "@/components/ui";
import type { CalendarCall } from "@/lib/calendar-calls";
import {
  agendaItems,
  cadenceLabel,
  callSessions,
  clockTime,
  dayTimeLabel,
  dayWord,
  durationLabel,
  runMinutes,
  runTone,
  RUN_STATUS_LABEL,
  type RunTone,
} from "@/lib/calendar-view";
import { cn } from "@/lib/cn";
import { msg, t } from "@/lib/i18n";
import { buildDepartments, chiefBot } from "@/lib/org";
import { atLocalTime } from "@/lib/routine-calendar";
import type { RoutineRun } from "@/lib/routines";
import { useDecisions, useOrg } from "@/state/org-api";
import { api, useStore, type Bot } from "@/state/store";
import type { OrgDecision } from "../../../shared/org-types";
import { AttachmentChips } from "./EventEditor";
import { nextOccurrence, type CalendarSelection, type EventSeed } from "./calendar-model";

const TONE_ICON: Record<RunTone, string> = {
  green: "bg-success/12 text-success",
  blue: "bg-select/12 text-accent-text",
  amber: "bg-warning/12 text-warning",
  red: "bg-danger/10 text-danger",
  grey: "bg-control text-ink-secondary",
};

function RunIcon({ tone }: { tone: RunTone }) {
  return (
    <span className={cn("grid size-[18px] shrink-0 place-items-center rounded-full", TONE_ICON[tone])}>
      {tone === "green" ? <Check size={11} strokeWidth={2.6} /> : tone === "blue" ? <Loader2 size={11} className="animate-spin" /> : tone === "amber" ? <Diamond size={8} /> : tone === "red" ? <X size={11} strokeWidth={2.6} /> : <Minus size={11} />}
    </span>
  );
}

const ACTION_STATUS: Record<OrgDecision["actionItems"][number]["status"], { label: string; tone: PillTone }> = {
  done: { label: msg("Delivered"), tone: "green" },
  running: { label: msg("Started"), tone: "blue" },
  pending: { label: msg("Not started"), tone: "grey" },
  failed: { label: msg("failed"), tone: "red" },
};

function Label({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-[12px] font-semibold text-ink-secondary">
      {children}
      {right && <span className="ml-auto font-medium">{right}</span>}
    </div>
  );
}

function Count({ value }: { value: number }) {
  return <span className="inline-grid h-[18px] min-w-[18px] place-items-center rounded-full bg-control/70 px-1.5 text-[11px] font-bold text-ink-secondary">{value}</span>;
}

function Person({ bot, crown }: { bot: Bot; crown?: boolean }) {
  return (
    <span className="flex w-[56px] flex-col items-center gap-1 text-center text-[11px] text-ink-secondary" title={bot.title ? `${bot.name} · ${bot.title}` : bot.name}>
      <BotAvatar bot={bot} size={30} crown={crown} />
      <span className="w-full truncate">{bot.name}</span>
    </span>
  );
}

function KV({ k, children, link }: { k: string; children: React.ReactNode; link?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 text-[13px]">
      <span className="w-[30px] shrink-0 text-[12px] font-semibold text-ink-secondary">{k}</span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">{children}</span>
      {link}
    </div>
  );
}

export function EventPanel({
  selection,
  calls,
  onClose,
  onEdit,
  onAddAnother,
  onCallDeleted,
  onOpenRoom,
}: {
  selection: CalendarSelection;
  calls: CalendarCall[];
  onClose: () => void;
  onEdit: (seed: EventSeed) => void;
  onAddAnother: (seed: EventSeed) => void;
  onCallDeleted: (id: string) => void;
  onOpenRoom: (id: string) => void;
}) {
  const { state, dispatch } = useStore();
  const { data: org } = useOrg();
  const { data: decisionData } = useDecisions();
  const [working, setWorking] = useState<null | "run" | "delete" | "toggle" | "cancel">(null);
  const [error, setError] = useState("");
  const now = Date.now();

  const routine = selection.kind === "routine" ? state.routines.find((candidate) => candidate.id === selection.routineId) ?? null : null;
  const call = selection.kind === "call" ? calls.find((candidate) => candidate.id === selection.callId) ?? null : null;
  const orphanRun = selection.kind === "run" ? state.routineRuns.find((run) => run.id === selection.runId) ?? null : null;
  const runs = useMemo(
    () => routine ? state.routineRuns.filter((run) => run.routineId === routine.id).sort((a, b) => b.scheduledFor - a.scheduledFor) : orphanRun ? [orphanRun] : [],
    [routine, orphanRun, state.routineRuns],
  );
  const group = call?.roomId ? state.groups.find((candidate) => candidate.id === call.roomId) : undefined;
  const sessions = useMemo(() => call && group ? callSessions(call.id, call.botIds, group.messages) : [], [call, group]);
  const decision = useMemo(() => {
    if (!call?.roomId) return undefined;
    return decisionData.decisions
      .filter((candidate) => candidate.source.kind === "group" && candidate.source.id === call.roomId)
      .sort((a, b) => b.at - a.at)[0];
  }, [call?.roomId, decisionData.decisions]);

  if (!routine && !call && !orphanRun) return null;

  const visibleBots = state.bots.filter((bot) => !bot.hidden);
  const participantIds = call ? call.botIds : [routine?.botId ?? orphanRun?.botId ?? ""];
  const participants = participantIds.flatMap((id) => state.bots.find((bot) => bot.id === id) ?? []);
  const chief = chiefBot(visibleBots, org);
  const host = call ? participants.find((bot) => bot.id === chief?.id) ?? participants.find((bot) => bot.chiefOfStaff) ?? participants[0] : participants[0];
  const schedule = routine?.schedule ?? call?.schedule;
  const durationMinutes = routine?.durationMinutes ?? call?.durationMinutes ?? orphanRun?.durationMinutes ?? 30;
  const title = routine?.name ?? call?.name ?? orphanRun?.routineName ?? t("Routine");
  const occurrenceAt = schedule?.type === "daily" ? atLocalTime(selection.at, schedule.time) : schedule?.type === "once" ? schedule.at : selection.at;
  const when = schedule
    ? schedule.type === "daily"
      ? `${cadenceLabel(schedule.weekdays)} ${clockTime(atLocalTime(now, schedule.time))}`
      : dayTimeLabel(schedule.at, now)
    : dayTimeLabel(selection.at, now);
  const next = routine ? (routine.enabled ? routine.nextRunAt ?? null : null) : schedule ? nextOccurrence(schedule, now) : null;
  const description = call?.description ?? routine?.prompt ?? orphanRun?.prompt ?? "";
  const attachments = call?.attachments ?? routine?.attachments ?? orphanRun?.attachments ?? [];
  const isolated = call && call.botIds.length > 1
    ? buildDepartments(visibleBots, org).filter((department) => department.settings?.isolated && ![department.lead, ...department.members].some((bot) => bot && call.botIds.includes(bot.id)))
    : [];
  const activeRun = runs.find((run) => ["queued", "running", "waiting"].includes(run.status));
  const waitingRun = runs.find((run) => run.status === "waiting");
  const lastResult = runs.find((run) => run.output || run.error || run.status === "completed" || run.status === "failed");

  const run = async (path: string, method = "POST", body?: unknown) => {
    const response = await api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    if (response.routine) dispatch({ type: "routinePatched", routine: response.routine });
    if (response.run) dispatch({ type: "routineRunPatched", run: response.run });
    return response;
  };
  const guard = async (kind: NonNullable<typeof working>, action: () => Promise<unknown>) => {
    setWorking(kind);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(null);
    }
  };

  const tryRun = () => guard("run", async () => {
    if (routine) {
      await run(`/api/routines/${routine.id}/run`);
      return;
    }
    if (!call) return;
    if (call.botIds.length < 2) {
      if (call.botIds[0]) onOpenRoom(call.botIds[0]);
      return;
    }
    // Open (or reuse) the call's room and start a session now, exactly as the
    // scheduler would at the event time (same sendId shape, so it counts).
    const { group: room } = await api(`/api/calendar-calls/${call.id}/room`, { method: "POST" });
    dispatch({ type: "groupPatched", group: room });
    dispatch({
      type: "sendGroup",
      groupId: room.id,
      threadId: room.threadId,
      text: `@everyone ${call.description.trim() || call.name}`,
      sendId: `calendar_${call.id}_${Date.now()}`,
    });
    onOpenRoom(room.id);
  });

  const remove = () => {
    if (!window.confirm(t("Delete “{name}”?", { name: title }))) return;
    void guard("delete", async () => {
      if (call) {
        await api(`/api/calendar-calls/${call.id}`, { method: "DELETE" });
        onCallDeleted(call.id);
      } else if (routine) {
        dispatch({ type: "deleteRoutine", routineId: routine.id });
      }
      onClose();
    });
  };

  const seed = (): EventSeed => call
    ? { kind: "call", at: occurrenceAt, durationMinutes, botIds: call.botIds, call }
    : { kind: "routine", at: occurrenceAt, durationMinutes, botIds: participantIds.filter(Boolean), routine: routine ?? undefined };
  const copySeed = (): EventSeed => ({
    kind: call ? "call" : "routine",
    at: occurrenceAt + 60 * 60_000,
    durationMinutes,
    botIds: participantIds.filter(Boolean),
    name: title,
    description,
  });

  const openRun = (target: RoutineRun) => {
    const owner = state.bots.find((bot) => bot.id === target.botId);
    if (!owner || !target.threadId) return;
    dispatch({ type: "select", id: owner.id });
    dispatch({ type: "switchTask", botId: owner.id, threadId: target.threadId });
  };

  const footer = call
    ? call.botIds.length > 1
      ? t("At the event time the bots meet in a group chat; minutes and action items stay there.")
      : t("A one-bot event reminds you and opens that bot's chat.")
    : t("Every run opens its own task, and the result comes back here.");

  return (
    <SidePanel
      width={336}
      label={t("Calendar event details")}
      onBack={onClose}
      title={<span className="flex min-w-0 items-center gap-1.5"><span className="truncate">{title}</span><span className="shrink-0 text-ink-secondary">·</span><span className="shrink-0">{when}</span></span>}
      actions={
        <>
          {(routine || call) && (
            <button type="button" onClick={() => onEdit(seed())} aria-label={t("Edit")} title={t("Edit")} className="grid size-8 place-items-center rounded-lg text-ink-secondary hover:bg-raised-hover hover:text-ink">
              <Pencil size={15} />
            </button>
          )}
          <button type="button" onClick={onClose} aria-label={t("Hide details")} title={t("Hide details")} className="grid size-8 place-items-center rounded-lg text-ink-secondary hover:bg-raised-hover hover:text-ink">
            <PanelRightClose size={17} />
          </button>
        </>
      }
    >
      <div className="flex min-h-full flex-col gap-[18px] pb-2">
        {/* 启用 · 删除 · 试运行 */}
        <div className="flex items-center gap-2">
          {routine ? (
            <>
              <Switch
                checked={routine.enabled}
                disabled={working === "toggle"}
                aria-label={routine.enabled ? t("Pause routine") : t("Resume routine")}
                onClick={() => void guard("toggle", () => run(`/api/routines/${routine.id}`, "PATCH", { enabled: !routine.enabled }))}
              />
              <span className="text-[13px] font-semibold">{routine.enabled ? t("Enabled") : t("Paused")}</span>
            </>
          ) : call ? null : (
            <Pill tone={runTone(orphanRun!.status)} dot>{t(RUN_STATUS_LABEL[orphanRun!.status])}</Pill>
          )}
          <span className="flex-1" />
          {(routine || call) && (
            <Button variant="soft" size="sm" onClick={remove} disabled={working === "delete"}>{t("Delete")}</Button>
          )}
          {(routine || call) && (
            <Button size="sm" onClick={() => void tryRun()} disabled={working === "run"}>
              {working === "run" && <Loader2 size={13} className="animate-spin" />}
              {t("Try it now")}
            </Button>
          )}
          {orphanRun?.threadId && <Button size="sm" variant="ghost" onClick={() => openRun(orphanRun)}>{t("Open task")}</Button>}
        </div>

        <div className="-mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-secondary">
          {call ? <span className="inline-flex items-center gap-1"><Phone size={13} />{call.botIds.length > 1 ? t("Multi-bot call") : t("Reminder")}</span>
            : routine ? <span className="inline-flex items-center gap-1">{routine.runOn === "cloud" ? <Cloud size={13} /> : <Laptop size={13} />}{routine.runOn === "cloud" ? t("Cloud VM") : t("This computer")}</span> : null}
          <span className="inline-flex items-center gap-1"><Clock3 size={13} />{durationLabel(durationMinutes)}</span>
          {next ? <span>{t("Next {when}", { when: dayTimeLabel(next, now) })}</span> : routine && !routine.enabled ? <span>{t("Paused")}</span> : null}
        </div>

        {error && <div className="flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2 text-[12px] text-danger"><CircleAlert size={14} className="mt-0.5 shrink-0" />{error}</div>}

        {waitingRun && (
          <div className="rounded-xl bg-warning/10 px-3 py-2.5 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-warning)_25%,transparent)]">
            <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-warning"><Diamond size={9} />{t("Waiting for you")}</div>
            <div className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-ink">{waitingRun.attention || t("This bot needs your answer. Open its task to continue the run.")}</div>
            {waitingRun.threadId && <button type="button" onClick={() => openRun(waitingRun)} className="mt-1.5 text-[12px] font-semibold text-accent-text hover:underline">{t("Answer now")}</button>}
          </div>
        )}

        {/* who takes part */}
        <section className="flex flex-col gap-2">
          <Label right={(routine || call) && <button type="button" onClick={() => onEdit(seed())} className="text-ink-secondary hover:text-ink">{call ? t("+ Invite") : t("Change")}</button>}>
            {call ? t("Taking part") : t("Runs it")}
            <Count value={participants.length} />
          </Label>
          <div className="grid grid-cols-5 justify-items-center gap-y-3">
            {participants.map((bot) => <Person key={bot.id} bot={bot} crown={bot.id === chief?.id} />)}
          </div>
          {isolated.map((department) => (
            <div key={department.section} className="flex items-center gap-1.5 text-[11.5px] text-ink-secondary">
              <Lock size={12} className="shrink-0" />
              {t("{department} is in the isolated zone and stays out of this meeting", { department: department.section })}
            </div>
          ))}
        </section>

        <section className="flex flex-col gap-2.5">
          {host && call && (
            <KV k={t("Host")}>
              <BotAvatar bot={host} size={18} crown={host.id === chief?.id} />
              <b className="truncate font-semibold">{host.name}</b>
              {host.title && <em className="truncate text-[12px] not-italic text-ink-secondary">{host.title}</em>}
            </KV>
          )}
          {schedule && (
            <KV k={t("When")} link={<button type="button" onClick={() => onAddAnother(copySeed())} className="shrink-0 text-[12.5px] font-semibold text-accent-text hover:underline">{t("+ Add another")}</button>}>
              {schedule.type === "daily" ? <Repeat2 size={13} className="shrink-0 text-ink-secondary" /> : <CalendarClock size={13} className="shrink-0 text-ink-secondary" />}
              <span className="truncate">
                {schedule.type === "daily"
                  ? `${cadenceLabel(schedule.weekdays)} ${clockTime(atLocalTime(now, schedule.time))} – ${clockTime(atLocalTime(now, schedule.time) + durationMinutes * 60_000)}`
                  : `${dayWord(schedule.at, now)} ${clockTime(schedule.at)} – ${clockTime(schedule.at + durationMinutes * 60_000)}`}
              </span>
              {schedule.type === "daily" && (
                <em className="shrink-0 text-[12px] not-italic text-ink-secondary">
                  {schedule.weekdays.includes(0) && schedule.weekdays.includes(6) ? t("weekends too") : !schedule.weekdays.includes(0) && !schedule.weekdays.includes(6) ? t("weekdays only") : ""}
                </em>
              )}
            </KV>
          )}
          {call && call.botIds.length > 1 && (
            <KV
              k={t("Minutes")}
              link={group ? <button type="button" onClick={() => onOpenRoom(group.id)} className="shrink-0 text-[12.5px] font-semibold text-accent-text hover:underline">{t("Open")}</button> : undefined}
            >
              <FileText size={13} className="shrink-0 text-ink-secondary" />
              <span className="truncate">{group ? t("In “{room}”", { room: group.name }) : t("A group chat opens at the first meeting")}</span>
            </KV>
          )}
        </section>

        {description.trim() && (
          <section className="flex flex-col gap-2">
            <Label>{call ? t("Agenda") : t("Instructions")}</Label>
            {call ? (
              <ol className="m-0 flex list-none flex-col gap-[7px] p-0">
                {agendaItems(description).map((line, index) => (
                  <li key={index} className="flex items-start gap-2 text-[13px] leading-[1.45]">
                    <i className="grid size-[18px] shrink-0 place-items-center rounded-[6px] bg-control/70 text-[11px] font-bold not-italic text-ink-secondary">{index + 1}</i>
                    <span className="min-w-0">{line}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="m-0 line-clamp-6 whitespace-pre-wrap text-[13px] leading-relaxed text-ink">{description}</p>
            )}
          </section>
        )}

        {attachments.length > 0 && (
          <section className="flex flex-col gap-2">
            <Label>{t("Attachments")}</Label>
            <AttachmentChips attachments={attachments} />
          </section>
        )}

        {/* the last minutes (calls) or the last result (routines) */}
        {call && (decision || sessions[0]) && (
          <section className="rounded-xl bg-inset px-3 pb-2.5 pt-3">
            <div className="mb-1.5 flex items-baseline gap-2">
              <b className="text-[13.5px]">{t("Last minutes")}</b>
              <span className="truncate text-[11.5px] text-ink-secondary">
                {sessions[0] ? [dayTimeLabel(sessions[0].at, now), sessions[0].minutes ? durationLabel(sessions[0].minutes) : null].filter(Boolean).join(" · ") : decision ? dayTimeLabel(decision.at, now) : ""}
              </span>
              {group && <button type="button" onClick={() => onOpenRoom(group.id)} className="ml-auto inline-flex shrink-0 items-center gap-1 self-center text-[12px] font-semibold text-accent-text hover:underline">{t("Open")}<ExternalLink size={12} /></button>}
            </div>
            {decision ? (
              <>
                <div className="mb-1 flex items-center gap-1.5 text-[12px] text-ink-secondary"><span className="inline-block size-1.5 rotate-45 rounded-[1px] bg-ink" />{t("Decision #{id}: {choice}", { id: decision.id, choice: decision.choice })}</div>
                <ul className="m-0 flex list-none flex-col p-0">
                  {decision.actionItems.map((item, index) => {
                    const owner = item.botId ? state.bots.find((bot) => bot.id === item.botId) : undefined;
                    const status = ACTION_STATUS[item.status];
                    return (
                      <li key={index} className={cn("flex h-7 items-center gap-2 text-[12.5px]", index > 0 && "border-t border-hairline/30")}>
                        <i className="size-[5px] shrink-0 rounded-full bg-ink-secondary/60" />
                        <span className="min-w-0 flex-1 truncate">{owner ? `${owner.name}：${item.title}` : item.title}</span>
                        <Pill tone={status.tone} dot>{t(status.label)}</Pill>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : sessions[0]?.lastLine ? (
              <p className="m-0 line-clamp-3 text-[12.5px] leading-relaxed text-ink">{sessions[0].lastLine}</p>
            ) : (
              <p className="m-0 text-[12.5px] text-ink-secondary">{t("Nobody has replied in this meeting yet.")}</p>
            )}
          </section>
        )}
        {!call && lastResult && (lastResult.output || lastResult.error) && (
          <section className="rounded-xl bg-inset px-3 pb-2.5 pt-3">
            <div className="mb-1.5 flex items-center gap-2">
              <b className="text-[13.5px]">{t("Last result")}</b>
              <span className="truncate text-[11.5px] text-ink-secondary">{dayTimeLabel(lastResult.scheduledFor, now)}</span>
              <Pill tone={runTone(lastResult.status)} dot className="ml-auto">{t(RUN_STATUS_LABEL[lastResult.status])}</Pill>
            </div>
            {lastResult.output && <p className="m-0 line-clamp-4 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink">{lastResult.output}</p>}
            {lastResult.error && <p className="m-0 mt-1 text-[12px] text-danger">{lastResult.error}</p>}
          </section>
        )}

        {/* run history */}
        {(runs.length > 0 || sessions.length > 0) && (
          <section className="flex flex-col gap-1">
            <Label right={t("{count} in total", { count: call ? sessions.length : runs.length })}>{t("Run history")}</Label>
            <div className="flex flex-col">
              {call
                ? sessions.slice(0, 6).map((session) => (
                    <div key={session.messageId} className="flex h-[34px] items-center gap-2 border-b border-hairline/25 text-[12.5px] whitespace-nowrap">
                      <RunIcon tone={session.attended > 0 ? "green" : "grey"} />
                      <b className="w-[78px] shrink-0 truncate font-semibold">{dayTimeLabel(session.at, now)}</b>
                      <span className="min-w-0 truncate text-ink-secondary">
                        {[session.minutes ? durationLabel(session.minutes) : null, t("{attended}/{invited} joined", { attended: session.attended, invited: session.invited })].filter(Boolean).join(" · ")}
                      </span>
                      {group && <button type="button" onClick={() => onOpenRoom(group.id)} className="ml-auto shrink-0 font-semibold text-accent-text hover:underline">{t("Open")}</button>}
                    </div>
                  ))
                : runs.slice(0, 6).map((item) => {
                    const minutes = runMinutes(item);
                    const active = ["queued", "running", "waiting"].includes(item.status);
                    return (
                      <div key={item.id} className="flex h-[34px] items-center gap-2 border-b border-hairline/25 text-[12.5px] whitespace-nowrap">
                        <RunIcon tone={runTone(item.status)} />
                        <b className="w-[78px] shrink-0 truncate font-semibold">{dayTimeLabel(item.scheduledFor, now)}</b>
                        <span className="min-w-0 truncate text-ink-secondary">
                          {[minutes ? durationLabel(minutes) : null, t(RUN_STATUS_LABEL[item.status]), item.manual ? t("manual") : null].filter(Boolean).join(" · ")}
                        </span>
                        <span className="ml-auto flex shrink-0 items-center gap-2">
                          {active && <button type="button" onClick={() => void guard("cancel", () => run(`/api/routine-runs/${item.id}/cancel`))} disabled={working === "cancel"} className="font-semibold text-ink-secondary hover:text-ink disabled:opacity-40">{t("Cancel")}</button>}
                          {item.threadId && <button type="button" onClick={() => openRun(item)} className="font-semibold text-accent-text hover:underline">{t("Open")}</button>}
                        </span>
                      </div>
                    );
                  })}
            </div>
          </section>
        )}
        {activeRun && !waitingRun && (
          <div className="flex items-center gap-2 text-[12px] text-accent-text"><Loader2 size={13} className="animate-spin" />{t("{name} is running now", { name: title })}</div>
        )}

        <div className="mt-auto pt-2 text-[11.5px] leading-relaxed text-ink-secondary/80">{footer}</div>
      </div>
    </SidePanel>
  );
}
