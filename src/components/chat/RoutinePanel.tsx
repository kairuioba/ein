// The right-hand 定时任务 panel of the 1:1 chat (design U8): one of this bot's
// routines — on/off, delete, a test run, its name and instructions, when it
// runs (several times are siblings: the same job saved once per time) and
// its run history, each run opening the isolated conversation it ran in.
// Without a routine selected it lists the bot's routines.
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import { openNotificationTarget, useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { SidePanel } from "@/components/ui/index";
import type { Routine, RoutineRun, RoutineSchedule } from "@/lib/routines";
import {
  anotherTime,
  dayChoice,
  normalizeTime,
  routineSiblings,
  runSummary,
  runTimeLabel,
  scheduleDays,
  scheduleTime,
  withDayChoice,
  withTime,
  type DayChoice,
} from "./chat-model";
import { CardButton, RING, Switch } from "./primitives";
import { IconClock, IconSidebar, IconX } from "./icons";

const RUN_HISTORY = 8;

/** One job per group of sibling routines, oldest first. */
function routineGroups(routines: readonly Routine[], botId: string): Routine[][] {
  const mine = routines.filter((routine) => routine.botId === botId).sort((a, b) => a.createdAt - b.createdAt);
  const seen = new Set<string>();
  const groups: Routine[][] = [];
  for (const routine of mine) {
    if (seen.has(routine.id)) continue;
    const group = routineSiblings(mine, routine);
    for (const member of group) seen.add(member.id);
    groups.push(group);
  }
  return groups;
}

export function RoutinePanel({
  bot,
  routineId,
  onSelect,
  onClose,
}: {
  bot: Bot;
  /** null = the list of this bot's routines */
  routineId: string | null;
  onSelect: (routineId: string | null) => void;
  onClose: () => void;
}) {
  const { state, dispatch } = useStore();
  const routine = routineId ? state.routines.find((candidate) => candidate.id === routineId) : undefined;
  const groups = useMemo(() => routineGroups(state.routines, bot.id), [state.routines, bot.id]);
  const closeButton = (
    <button
      type="button"
      onClick={onClose}
      aria-label={t("Close panel")}
      title={t("Close panel")}
      className="grid size-8 place-items-center rounded-lg text-ink-secondary hover:bg-raised-hover hover:text-ink"
    >
      <IconSidebar size={16} />
    </button>
  );

  return (
    <SidePanel
      title={t("Scheduled task")}
      label={t("Scheduled task")}
      onBack={routineId ? () => onSelect(null) : undefined}
      actions={closeButton}
      width={340}
      className="bg-stage"
    >
      {routine ? (
        <RoutineDetail key={routine.id} bot={bot} routine={routine} onDeleted={() => onSelect(null)} />
      ) : routineId ? (
        <div className="py-10 text-center text-[13px] text-ink-secondary">{t("This scheduled task no longer exists.")}</div>
      ) : (
        <div className="flex flex-col gap-1 pt-1">
          {groups.length === 0 && (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
              <div className="text-[13.5px] font-semibold text-ink">{t("{name} has no scheduled tasks yet", { name: bot.name })}</div>
              <div className="text-[12.5px] text-ink-secondary">{t("Ask in the chat (“every weekday at 18:00 …”), or add one on the calendar.")}</div>
              <CardButton variant="grey" className="mt-1" onClick={() => dispatch({ type: "showRoutines" })}>
                {t("Open the calendar")}
              </CardButton>
            </div>
          )}
          {groups.map((group) => {
            const first = group[0]!;
            const enabled = group.some((member) => member.enabled);
            return (
              <button
                key={first.id}
                type="button"
                onClick={() => onSelect(first.id)}
                className="flex items-center gap-3 rounded-[10px] px-2.5 py-2.5 text-left hover:bg-raised-hover"
              >
                <IconClock size={15} className="shrink-0 text-ink-secondary" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-ink">{first.name}</span>
                  <span className="block truncate text-[12px] text-ink-secondary">
                    {group.map((member) => `${scheduleTime(member.schedule)} · ${scheduleDays(member.schedule)}`).join(t(", "))}
                    {!enabled && ` · ${t("Paused")}`}
                  </span>
                </span>
                <ChevronRight size={14} className="shrink-0 text-ink-secondary" />
              </button>
            );
          })}
          {groups.length > 0 && (
            <button
              type="button"
              onClick={() => dispatch({ type: "showRoutines" })}
              className="mt-2 self-start rounded-md px-2.5 text-[12.5px] font-semibold text-accent-text hover:underline"
            >
              {t("See all on the calendar")}
            </button>
          )}
        </div>
      )}
    </SidePanel>
  );
}

function RoutineDetail({ bot, routine, onDeleted }: { bot: Bot; routine: Routine; onDeleted: () => void }) {
  const { state, dispatch } = useStore();
  const siblings = useMemo(() => routineSiblings(state.routines, routine), [state.routines, routine]);
  const enabled = siblings.some((member) => member.enabled);
  const [name, setName] = useState(routine.name);
  const [prompt, setPrompt] = useState(routine.prompt);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [started, setStarted] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // a change from elsewhere (the calendar, another window) lands here too,
  // unless the field is being edited
  const editing = useRef<"name" | "prompt" | null>(null);
  useEffect(() => {
    if (editing.current !== "name") setName(routine.name);
    if (editing.current !== "prompt") setPrompt(routine.prompt);
  }, [routine.name, routine.prompt]);
  useEffect(() => () => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
  }, []);

  const patchAll = (patch: Partial<Pick<Routine, "name" | "prompt" | "enabled">>) => {
    for (const member of siblings) dispatch({ type: "updateRoutine", routineId: member.id, patch });
  };
  const commitName = () => {
    editing.current = null;
    const next = name.trim();
    if (!next) return setName(routine.name);
    if (next !== routine.name) patchAll({ name: next });
  };
  const commitPrompt = () => {
    editing.current = null;
    const next = prompt.trim();
    if (!next) return setPrompt(routine.prompt);
    if (next !== routine.prompt) patchAll({ prompt: next });
  };
  const setSchedule = (member: Routine, schedule: RoutineSchedule) =>
    dispatch({ type: "updateRoutine", routineId: member.id, patch: { schedule } });
  const addAnother = () => {
    const last = siblings[siblings.length - 1] ?? routine;
    dispatch({
      type: "createRoutine",
      input: {
        name: routine.name,
        prompt: routine.prompt,
        botId: routine.botId,
        runOn: routine.runOn,
        enabled,
        schedule: anotherTime(last.schedule),
        durationMinutes: routine.durationMinutes,
        attachments: routine.attachments,
      },
    });
  };
  const remove = () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmDelete(false), 3500);
      return;
    }
    for (const member of siblings) dispatch({ type: "deleteRoutine", routineId: member.id });
    onDeleted();
  };
  const tryRun = () => {
    dispatch({ type: "runRoutine", routineId: routine.id });
    setStarted(true);
    setTimeout(() => setStarted(false), 2500);
  };

  const ids = new Set(siblings.map((member) => member.id));
  const runs = state.routineRuns
    .filter((run) => ids.has(run.routineId))
    .sort((a, b) => (b.startedAt ?? b.scheduledFor) - (a.startedAt ?? a.scheduledFor))
    .slice(0, RUN_HISTORY);
  const owner = state.bots.find((candidate) => candidate.id === routine.botId) ?? bot;

  return (
    <div className="flex min-h-full flex-col gap-3 pt-1">
      <div className="flex items-center gap-2">
        <Switch checked={enabled} onChange={(next) => patchAll({ enabled: next })} label={t("Enabled")} />
        <span className="flex-1 text-[13px] font-semibold text-ink">{t("Enabled")}</span>
        <CardButton
          variant="grey"
          onClick={remove}
          className={cn("h-8 rounded-[10px] px-3.5 text-[13px]", confirmDelete && "bg-danger text-white hover:bg-danger")}
        >
          {confirmDelete ? t("Delete it") : t("Delete")}
        </CardButton>
        <CardButton onClick={tryRun} disabled={started} className="h-8 rounded-[10px] px-3.5 text-[13px]">
          {started ? t("Started") : t("Test run")}
        </CardButton>
      </div>

      <Field label={t("Name")}>
        <input
          value={name}
          maxLength={80}
          onFocus={() => (editing.current = "name")}
          onChange={(event) => setName(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) event.currentTarget.blur();
            if (event.key === "Escape") {
              setName(routine.name);
              editing.current = null;
              event.currentTarget.blur();
            }
          }}
          aria-label={t("Name")}
          className={cn("w-full rounded-[10px] bg-raised px-2.5 py-2 text-[13px] text-ink focus:outline-none focus:inset-ring-[1.5px] focus:inset-ring-select", RING)}
        />
      </Field>

      <Field label={t("Instructions")}>
        <textarea
          value={prompt}
          rows={4}
          maxLength={20_000}
          onFocus={() => (editing.current = "prompt")}
          onChange={(event) => setPrompt(event.target.value)}
          onBlur={commitPrompt}
          aria-label={t("Instructions")}
          className={cn(
            "min-h-[92px] w-full resize-y rounded-[10px] bg-raised px-2.5 py-2 text-[13px] leading-[1.55] text-ink focus:outline-none focus:inset-ring-[1.5px] focus:inset-ring-select",
            RING,
          )}
        />
      </Field>

      <Field label={t("When it runs")}>
        <div className="flex flex-col gap-1.5">
          {siblings.map((member) => (
            <ScheduleRow
              key={member.id}
              schedule={member.schedule}
              onChange={(schedule) => setSchedule(member, schedule)}
              onRemove={siblings.length > 1 ? () => dispatch({ type: "deleteRoutine", routineId: member.id }) : undefined}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={addAnother}
          className="self-start rounded-md pl-0.5 text-[12.5px] font-semibold text-accent-text hover:underline"
        >
          + {t("Add another")}
        </button>
      </Field>

      <Field label={t("Run history")}>
        {runs.length === 0 ? (
          <div className="py-2 text-[12.5px] text-ink-secondary">{t("No runs yet. Test run shows what it will do.")}</div>
        ) : (
          <div className="flex flex-col">
            {runs.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                onOpen={
                  run.threadId && owner.tasks?.some((task) => task.threadId === run.threadId)
                    ? () => openNotificationTarget(dispatch, { botId: owner.id, threadId: run.threadId! }, state)
                    : undefined
                }
              />
            ))}
          </div>
        )}
      </Field>

      <div className="mt-auto pt-4 text-[11.5px] leading-[1.6] text-ink-secondary/80">
        {t("Every run opens a conversation of its own; its result card comes back here.")}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-[5px]">
      <div className="text-[12px] font-semibold text-ink-secondary">{label}</div>
      {children}
    </div>
  );
}

const DAY_OPTIONS: Array<{ value: DayChoice; label: () => string }> = [
  { value: "daily", label: () => t("Every day") },
  { value: "weekdays", label: () => t("Weekdays") },
  { value: "weekends", label: () => t("Weekends") },
  { value: "once", label: () => t("Once") },
];

function ScheduleRow({
  schedule,
  onChange,
  onRemove,
}: {
  schedule: RoutineSchedule;
  onChange: (schedule: RoutineSchedule) => void;
  onRemove?: () => void;
}) {
  const choice = dayChoice(schedule);
  const time = schedule.type === "daily" ? schedule.time : new Date(schedule.at).toTimeString().slice(0, 5);
  return (
    <div className={cn("group/row flex h-10 items-center gap-2 rounded-[10px] bg-raised pr-1.5 pl-2.5 text-[13px] text-ink", RING)}>
      <IconClock size={14} className="shrink-0 text-ink-secondary" />
      <span className="shrink-0">{schedule.type === "once" ? scheduleDays(schedule) : t("Daily")}</span>
      <TimeField value={time} onCommit={(next) => onChange(withTime(schedule, next))} />
      <span className="flex-1" />
      <select
        value={choice}
        onChange={(event) => onChange(withDayChoice(schedule, event.target.value as DayChoice))}
        aria-label={t("Days")}
        className="max-w-[110px] cursor-pointer appearance-none bg-transparent text-right text-[12px] text-ink-secondary hover:text-ink focus:outline-none"
      >
        {choice === "custom" && <option value="custom">{scheduleDays(schedule)}</option>}
        {DAY_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label()}
          </option>
        ))}
      </select>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={t("Remove this time")}
          title={t("Remove this time")}
          className="grid size-6 shrink-0 place-items-center rounded-md text-ink-secondary opacity-60 hover:bg-raised-hover hover:opacity-100"
        >
          <IconX size={12} />
        </button>
      )}
    </div>
  );
}

/** A 24-hour "HH:MM" field (the native time input follows the OS clock and
 * shows 06:00 PM). Commits on blur or Enter; anything unreadable reverts. */
function TimeField({ value, onCommit }: { value: string; onCommit: (time: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const next = normalizeTime(draft);
    if (next && next !== value) onCommit(next);
    else setDraft(value);
  };
  return (
    <input
      value={draft}
      inputMode="numeric"
      maxLength={5}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
      aria-label={t("Time")}
      className="w-[52px] rounded-md bg-transparent px-1 tabular-nums text-ink hover:bg-raised-hover focus:bg-raised-hover focus:outline-none"
    />
  );
}

function RunRow({ run, onOpen }: { run: RoutineRun; onOpen?: () => void }) {
  const summary = runSummary(run);
  return (
    <div className="flex items-center gap-2 border-b border-hairline/25 px-0.5 py-2 text-[12.5px]">
      <RunBadge status={run.status} />
      <b className="shrink-0 font-semibold whitespace-nowrap text-ink">{runTimeLabel(run.startedAt ?? run.scheduledFor)}</b>
      <span className="min-w-0 flex-1 truncate text-ink-secondary">{summary || statusWord(run.status)}</span>
      {onOpen && (
        <button type="button" onClick={onOpen} className="shrink-0 font-semibold text-accent-text hover:underline">
          {t("Open")}
        </button>
      )}
    </div>
  );
}

function statusWord(status: RoutineRun["status"]): string {
  switch (status) {
    case "running":
      return t("In progress");
    case "queued":
      return t("Queued");
    case "waiting":
      return t("Needs your input");
    case "failed":
      return t("Failed");
    case "missed":
      return t("Missed");
    case "cancelled":
      return t("Cancelled");
    default:
      return t("Completed");
  }
}

function RunBadge({ status }: { status: RoutineRun["status"] }) {
  const base = "grid size-[18px] shrink-0 place-items-center rounded-full text-[11px] font-extrabold";
  if (status === "running" || status === "queued") {
    return (
      <span className={cn(base, "bg-select/12 text-accent-text")} aria-label={statusWord(status)}>
        <Loader2 size={11} className={status === "running" ? "animate-spin" : undefined} />
      </span>
    );
  }
  if (status === "completed") return <span className={cn(base, "bg-success/12 text-success")} aria-label={statusWord(status)}>✓</span>;
  if (status === "waiting") return <span className={cn(base, "bg-warning/12 text-warning")} aria-label={statusWord(status)}>!</span>;
  if (status === "cancelled") return <span className={cn(base, "bg-control text-ink-secondary")} aria-label={statusWord(status)}>–</span>;
  return <span className={cn(base, "bg-danger/10 text-danger")} aria-label={statusWord(status)}>✕</span>;
}
