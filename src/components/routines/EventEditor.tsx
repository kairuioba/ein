// Creating and editing calendar entries: the full editor sheet (EventEditor),
// the small composer that pops up after drag-creating a slot (QuickComposer)
// and the pieces they share. Behaviour is unchanged from the original
// calendar; the surfaces follow the skin tokens (no forced dark color-scheme).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Clock3,
  Cloud,
  FileText,
  Laptop,
  Loader2,
  Paperclip,
  Repeat2,
  Search,
  UserRoundPlus,
  X,
} from "lucide-react";

import { BotAvatar } from "@/components/Avatar";
import { pathForFile } from "@/components/ComposerAttachments";
import { Dialog, Segmented } from "@/components/ui";
import type { CalendarCall, CalendarCallAttachment, CalendarCallInput } from "@/lib/calendar-calls";
import { cn } from "@/lib/cn";
import { imageAttachmentFromFile, intakeFiles, type Attachment } from "@/lib/composer-attachments";
import { t, tn } from "@/lib/i18n";
import { atLocalTime, fromLocalDateAndTime, toLocalDateInput, toLocalTimeInput } from "@/lib/routine-calendar";
import type { Routine, RoutineContextAttachment, RoutineInput, RoutineRunOn } from "@/lib/routines";
import { api, useStore, type Bot } from "@/state/store";
import {
  ALL_DAYS,
  makeSchedule,
  niceDate,
  niceTime,
  recurrenceFor,
  weekdayName,
  type EventKind,
  type EventSeed,
  type RecurrenceChoice,
} from "./calendar-model";

/** A form control on the stage: white field, soft hairline, cobalt focus. */
export const FIELD =
  "rounded-[10px] bg-stage px-3 py-2 text-[13px] text-ink shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_70%,transparent)] outline-none placeholder:text-ink-secondary/60 focus:shadow-[inset_0_0_0_1.5px_var(--color-select)]";

export function AttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: Array<RoutineContextAttachment | CalendarCallAttachment>;
  onRemove?: (id: string) => void;
}) {
  if (!attachments.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {attachments.map((attachment) => (
        <div key={attachment.id} className="flex max-w-[260px] items-center gap-2 rounded-[10px] bg-control/60 px-2.5 py-1.5 text-[12px] text-ink">
          <FileText size={14} className="shrink-0 text-ink-secondary" />
          <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
          {onRemove && <button type="button" onClick={() => onRemove(attachment.id)} className="rounded p-0.5 text-ink-secondary hover:bg-raised-hover hover:text-ink" aria-label={t("Remove {name}", { name: attachment.name })}><X size={12} /></button>}
        </div>
      ))}
    </div>
  );
}

export function BotPicker({
  bots,
  selected,
  multiple,
  locked,
  onChange,
}: {
  bots: Bot[];
  selected: string[];
  multiple: boolean;
  locked?: boolean;
  onChange: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = bots.filter((bot) => `${bot.name} ${bot.title}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="rounded-xl bg-inset p-2 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_35%,transparent)]">
      {!locked && bots.length > 5 && (
        <label className="mb-2 flex items-center gap-2 rounded-lg bg-stage px-2.5 py-1.5 text-ink-secondary shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_45%,transparent)]">
          <Search size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("Find a bot")} className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-secondary/60" />
        </label>
      )}
      <div className="grid max-h-48 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
        {filtered.map((bot) => {
          const active = selected.includes(bot.id);
          return (
            <button
              key={bot.id}
              type="button"
              disabled={locked}
              onClick={() => onChange(multiple ? (active ? selected.filter((id) => id !== bot.id) : [...selected, bot.id]) : [bot.id])}
              className={cn("flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition", active ? "bg-select/10 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-select)_45%,transparent)]" : "hover:bg-raised-hover", locked && "cursor-default")}
            >
              <BotAvatar bot={bot} size={26} />
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{bot.name}</span>
              {active && <CheckCircle2 size={14} className="shrink-0 text-accent-text" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function toContextAttachments(attachments: Attachment[]): Array<RoutineContextAttachment | CalendarCallAttachment> {
  return attachments.flatMap((attachment) => attachment.kind === "paste" ? [] : [{
    id: attachment.id,
    kind: attachment.kind,
    name: attachment.name,
    path: attachment.path,
    size: attachment.size,
  }]);
}

function Row({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-4">
      <span className="mt-2 shrink-0 text-ink-secondary">{icon}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function EventEditor({
  seed,
  bots,
  lockedBotId,
  defaultRunOn,
  onClose,
  onSavedCall,
}: {
  seed: EventSeed;
  bots: Bot[];
  lockedBotId?: string;
  defaultRunOn?: RoutineRunOn;
  onClose: () => void;
  onSavedCall: (call: CalendarCall) => void;
}) {
  const { state, dispatch } = useStore();
  const existingRoutine = seed.routine;
  const existingCall = seed.call;
  const [kind, setKind] = useState<EventKind>(seed.kind);
  const [name, setName] = useState(existingRoutine?.name ?? existingCall?.name ?? seed.name ?? "");
  const [description, setDescription] = useState(existingRoutine?.prompt ?? existingCall?.description ?? seed.description ?? "");
  const initialAt = existingRoutine?.schedule.type === "once"
    ? existingRoutine.schedule.at
    : existingRoutine?.schedule.type === "daily"
      ? atLocalTime(seed.at, existingRoutine.schedule.time)
      : existingCall?.schedule.type === "once"
        ? existingCall.schedule.at
        : existingCall?.schedule.type === "daily"
          ? atLocalTime(seed.at, existingCall.schedule.time)
          : seed.at;
  const schedule = existingRoutine?.schedule ?? existingCall?.schedule ?? { type: "once" as const, at: initialAt };
  const [date, setDate] = useState(toLocalDateInput(initialAt));
  const [startTime, setStartTime] = useState(toLocalTimeInput(initialAt));
  const [durationMinutes, setDurationMinutes] = useState(existingRoutine?.durationMinutes ?? existingCall?.durationMinutes ?? seed.durationMinutes);
  const [recurrence, setRecurrence] = useState<RecurrenceChoice>(recurrenceFor(schedule, initialAt));
  const [weekdays, setWeekdays] = useState(schedule.type === "daily" ? schedule.weekdays : [new Date(initialAt).getDay()]);
  const [botIds, setBotIds] = useState(lockedBotId ? [lockedBotId] : existingRoutine ? [existingRoutine.botId] : existingCall?.botIds ?? seed.botIds);
  const [runOn, setRunOn] = useState<RoutineRunOn>(existingRoutine?.runOn ?? defaultRunOn ?? "maus");
  const [attachments, setAttachments] = useState<Array<RoutineContextAttachment | CalendarCallAttachment>>(existingRoutine?.attachments ?? existingCall?.attachments ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [attachmentNotice, setAttachmentNotice] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  // Dialog focuses its first control when it opens; the title is where typing starts.
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => titleRef.current?.focus(), []);
  const cloudInstance = state.instances.find((instance) => instance.driverKind === "boxAgent");
  const cloudReady = Boolean(state.config?.box.configured && cloudInstance?.snapshot.state === "available");
  const at = fromLocalDateAndTime(date, startTime);
  const endAt = at + durationMinutes * 60_000;
  const selectedBots = botIds.flatMap((id) => bots.find((bot) => bot.id === id) ?? []);

  const pickFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const result = await intakeFiles(Array.from(files), {
      allowImages: true,
      getPath: pathForFile,
      uploadImage: imageAttachmentFromFile,
    });
    const added = toContextAttachments(result.attachments);
    if (added.length) {
      setAttachments((current) => [...current, ...added].slice(0, 20));
      if (runOn === "cloud") setRunOn("maus");
    }
    if (result.notice) setAttachmentNotice(result.notice);
  };

  const save = async () => {
    const nextSchedule = makeSchedule(recurrence, at, weekdays);
    setSaving(true);
    setError("");
    try {
      if (kind === "routine") {
        const input: RoutineInput = {
          name,
          prompt: description,
          botId: botIds[0] ?? "",
          runOn,
          enabled: existingRoutine ? undefined : true,
          schedule: nextSchedule,
          durationMinutes,
          attachments: attachments as RoutineContextAttachment[],
        };
        const response = await api(existingRoutine ? `/api/routines/${existingRoutine.id}` : "/api/routines", {
          method: existingRoutine ? "PATCH" : "POST",
          body: JSON.stringify(input),
        });
        dispatch({ type: "routinePatched", routine: response.routine });
      } else {
        const input: CalendarCallInput = {
          name,
          description,
          botIds,
          schedule: nextSchedule,
          durationMinutes,
          attachments: attachments as CalendarCallAttachment[],
        };
        const response = await api(existingCall ? `/api/calendar-calls/${existingCall.id}` : "/api/calendar-calls", {
          method: existingCall ? "PATCH" : "POST",
          body: JSON.stringify(input),
        });
        onSavedCall(response.call);
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const valid = name.trim() && botIds.length > 0 && (kind === "call" || description.trim());
  const canSwitchKind = !existingRoutine && !existingCall && !lockedBotId;
  const editing = Boolean(existingRoutine || existingCall);

  return (
    <Dialog open onClose={onClose} label={editing ? t("Edit calendar event") : t("Create calendar event")} width={720} className="max-h-[94vh]">
      <div className="flex items-center justify-between px-6 pb-2 pt-5">
        <div className="text-[18px] font-bold text-ink">{editing ? t("Edit event") : t("New event")}</div>
        <button type="button" onClick={onClose} className="grid size-8 place-items-center rounded-lg text-ink-secondary hover:bg-raised-hover hover:text-ink" aria-label={t("Close")}><X size={17} /></button>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-4">
        {canSwitchKind && (
          <Segmented
            label={t("Event type")}
            value={kind}
            onChange={(next) => {
              setKind(next);
              if (next === "routine") setBotIds((ids) => ids.slice(0, 1));
            }}
            options={[{ value: "routine", label: t("Routine") }, { value: "call", label: t("Call") }]}
          />
        )}

        <input ref={titleRef} value={name} onChange={(event) => setName(event.target.value)} placeholder={kind === "routine" ? t("Add title") : t("Add call title")} className="w-full border-b border-hairline/50 bg-transparent px-1 pb-2 text-[20px] font-semibold text-ink outline-none placeholder:text-ink-secondary/55 focus:border-select" />

        <Row icon={<Clock3 size={17} />}>
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <input type="date" value={date} onChange={(event) => setDate(event.target.value)} className={FIELD} />
              <input type="time" step={900} value={startTime} onChange={(event) => setStartTime(event.target.value)} className={FIELD} />
              <span className="text-[12px] text-ink-secondary">{t("to")}</span>
              <span className="rounded-[10px] bg-control/60 px-3 py-2 text-[13px] text-ink">{niceTime(endAt)}</span>
              <select value={durationMinutes} onChange={(event) => setDurationMinutes(Number(event.target.value))} className={FIELD}>
                {[15, 30, 45, 60, 90, 120, 180, 240].map((minutes) => <option key={minutes} value={minutes}>{minutes < 60 ? t("{minutes} min", { minutes }) : t("{hours} hr", { hours: minutes / 60 })}</option>)}
              </select>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Repeat2 size={14} className="text-ink-secondary" />
              <select value={recurrence} onChange={(event) => setRecurrence(event.target.value as RecurrenceChoice)} className={FIELD}>
                <option value="none">{t("Does not repeat")}</option>
                <option value="daily">{t("Daily")}</option>
                <option value="weekdays">{t("Every weekday (Monday to Friday)")}</option>
                <option value="weekly">{t("Weekly on {day}", { day: weekdayName(new Date(at).getDay()) })}</option>
                <option value="custom">{t("Custom…")}</option>
              </select>
            </div>
            {recurrence === "custom" && (
              <div className="flex flex-wrap gap-1.5">
                {ALL_DAYS.map((day) => <button key={day} type="button" onClick={() => setWeekdays((current) => current.includes(day) ? (current.length === 1 ? current : current.filter((value) => value !== day)) : [...current, day].sort())} className={cn("size-8 rounded-full text-[11px] font-semibold", weekdays.includes(day) ? "bg-primary text-primary-ink" : "bg-control/70 text-ink-secondary hover:bg-raised-hover hover:text-ink")}>{weekdayName(day, "narrow")}</button>)}
              </div>
            )}
          </div>
        </Row>

        <Row icon={<UserRoundPlus size={17} />}>
          <div className="mb-2 text-[12.5px] font-semibold text-ink">{kind === "routine" ? t("Assign a bot") : t("Add guests")}</div>
          {bots.length > 0 ? (
            <>
              <BotPicker bots={bots} selected={botIds} multiple={kind === "call"} locked={Boolean(lockedBotId)} onChange={setBotIds} />
              <div className="mt-2 text-[11.5px] text-ink-secondary">{kind === "routine" ? t("This bot owns each scheduled run.") : selectedBots.length ? tn(selectedBots.length, "{count} bot invited to the call.", "{count} bots invited to the call.") : t("No bots invited to the call.")}</div>
            </>
          ) : (
            <button type="button" onClick={() => { dispatch({ type: "newBot" }); onClose(); }} className="w-full rounded-xl border border-dashed border-select/45 bg-select/[0.06] px-4 py-4 text-left hover:bg-select/10">
              <div className="text-[12.5px] font-semibold text-accent-text">{t("Create your first bot")}</div>
              <div className="mt-1 text-[11.5px] text-ink-secondary">{t("A calendar event needs at least one bot.")}</div>
            </button>
          )}
        </Row>

        <Row icon={<FileText size={17} />}>
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={5} placeholder={kind === "routine" ? t("Add instructions for the bot") : t("Add description or agenda")} className={cn(FIELD, "w-full resize-y px-3.5 py-3 leading-relaxed")} />
        </Row>

        <Row icon={<Paperclip size={17} />}>
          <div className="space-y-2">
            <input ref={fileInput} type="file" multiple className="hidden" onChange={(event) => { void pickFiles(event.target.files); event.target.value = ""; }} />
            <button type="button" onClick={() => fileInput.current?.click()} className="h-8 rounded-[10px] bg-control px-3 text-[12.5px] font-semibold text-ink hover:bg-raised-hover">{t("Add attachment")}</button>
            <AttachmentChips attachments={attachments} onRemove={(id) => setAttachments((current) => current.filter((attachment) => attachment.id !== id))} />
            <div className="text-[11.5px] leading-relaxed text-ink-secondary">
              {kind === "routine"
                ? t("Attachments are passed to each local routine run and excluded from shared team files.")
                : selectedBots.length > 1
                  ? t("References will be shared in the room when the event starts.")
                  : t("References stay with the event and are available when you join the room.")}
            </div>
            {attachmentNotice && <div className="text-[11.5px] text-warning">{attachmentNotice}</div>}
          </div>
        </Row>

        {kind === "routine" && (
          <Row icon={runOn === "cloud" ? <Cloud size={17} /> : <Laptop size={17} />}>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setRunOn("maus")} className={cn("rounded-xl p-3 text-left", runOn === "maus" ? "bg-select/10 shadow-[inset_0_0_0_1.5px_var(--color-select)]" : "bg-inset shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_40%,transparent)] hover:bg-raised-hover")}><div className="text-[12.5px] font-semibold text-ink">{t("This computer")}</div><div className="mt-1 text-[11px] text-ink-secondary">{t("Uses the bot’s current model and tools.")}</div></button>
              <button type="button" disabled={!cloudReady || attachments.length > 0} onClick={() => setRunOn("cloud")} className={cn("rounded-xl p-3 text-left disabled:cursor-not-allowed disabled:opacity-45", runOn === "cloud" ? "bg-select/10 shadow-[inset_0_0_0_1.5px_var(--color-select)]" : "bg-inset shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_40%,transparent)] hover:bg-raised-hover")}><div className="text-[12.5px] font-semibold text-ink">{t("Cloud VM")}</div><div className="mt-1 text-[11px] text-ink-secondary">{t("Uses your connected cloud VM; Ein must stay running to launch it.")}</div></button>
            </div>
          </Row>
        )}

        {error && <div className="flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2.5 text-[12.5px] text-danger"><CircleAlert size={15} className="mt-0.5 shrink-0" />{error}</div>}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-hairline/40 px-6 py-3.5">
        <button type="button" onClick={onClose} className="h-[34px] rounded-[10px] px-4 text-[13px] font-semibold text-ink-secondary hover:bg-raised-hover hover:text-ink">{t("Cancel")}</button>
        <button type="button" onClick={() => void save()} disabled={saving || !valid} className="flex h-[34px] items-center gap-2 rounded-[10px] bg-primary px-5 text-[13px] font-semibold text-primary-ink hover:brightness-110 disabled:opacity-40">{saving && <Loader2 size={14} className="animate-spin" />}{editing ? t("Save") : kind === "call" ? t("Schedule call") : t("Schedule routine")}</button>
      </div>
    </Dialog>
  );
}

export function QuickComposer({
  seed,
  bots,
  onClose,
  onMore,
  onSavedRoutine,
  onSavedCall,
}: {
  seed: EventSeed;
  bots: Bot[];
  onClose: () => void;
  onMore: (seed: EventSeed) => void;
  onSavedRoutine: (routine: Routine) => void;
  onSavedCall: (call: CalendarCall) => void;
}) {
  const { dispatch } = useStore();
  const [kind, setKind] = useState<EventKind>(seed.kind);
  const [name, setName] = useState(seed.name ?? "");
  const [description, setDescription] = useState(seed.description ?? "");
  const [botIds, setBotIds] = useState(seed.botIds.length ? seed.botIds : bots[0] ? [bots[0].id] : []);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const [dialogPosition, setDialogPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!seed.anchor) {
      setDialogPosition(null);
      return;
    }
    const dialog = dialogRef.current;
    if (!dialog) return;
    const place = () => {
      const gap = 12;
      const rect = dialog.getBoundingClientRect();
      let left = seed.anchor!.x + gap;
      let top = seed.anchor!.y + gap;
      if (left + rect.width > window.innerWidth - gap) left = seed.anchor!.x - rect.width - gap;
      if (top + rect.height > window.innerHeight - gap) top = seed.anchor!.y - rect.height - gap;
      setDialogPosition({
        left: Math.max(gap, Math.min(left, window.innerWidth - rect.width - gap)),
        top: Math.max(gap, Math.min(top, window.innerHeight - rect.height - gap)),
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [kind, seed.anchor]);

  const save = async () => {
    setWorking(true);
    setError("");
    try {
      if (kind === "routine") {
        const response = await api("/api/routines", {
          method: "POST",
          body: JSON.stringify({
            name,
            prompt: description,
            botId: botIds[0],
            runOn: "maus",
            enabled: true,
            schedule: { type: "once", at: seed.at },
            durationMinutes: seed.durationMinutes,
            attachments: [],
          } satisfies RoutineInput),
        });
        onSavedRoutine(response.routine);
      } else {
        const response = await api("/api/calendar-calls", {
          method: "POST",
          body: JSON.stringify({
            name,
            description,
            botIds,
            schedule: { type: "once", at: seed.at },
            durationMinutes: seed.durationMinutes,
          } satisfies CalendarCallInput),
        });
        onSavedCall(response.call);
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };

  const valid = Boolean(name.trim() && botIds.length && (kind === "call" || description.trim()));
  return (
    <div ref={dialogRef} role="dialog" aria-label={t("Quick create")} style={dialogPosition ?? undefined} className={cn("animate-pop-in fixed z-50 max-h-[calc(100vh-24px)] w-[min(420px,calc(100vw-24px))] overflow-y-auto rounded-2xl bg-raised shadow-[0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_45%,transparent),0_28px_64px_-24px_rgb(16_24_40/0.42)]", !dialogPosition && "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2")}>
      <div className="flex items-center justify-between px-4 pb-1 pt-3">
        <div className="text-[12.5px] font-semibold text-ink-secondary">{t("New calendar event")}</div>
        <button type="button" onClick={onClose} className="grid size-7 place-items-center rounded-lg text-ink-secondary hover:bg-raised-hover hover:text-ink" aria-label={t("Close")}><X size={15} /></button>
      </div>
      <div className="space-y-3 px-4 pb-4 pt-1">
        <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={t("Add title")} onKeyDown={(event) => { if (event.key === "Enter" && valid) void save(); }} className="w-full border-b border-hairline/50 bg-transparent pb-2 text-[17px] font-semibold text-ink outline-none placeholder:text-ink-secondary/55 focus:border-select" />
        <Segmented
          size="sm"
          label={t("Event type")}
          value={kind}
          onChange={(next) => {
            setKind(next);
            if (next === "routine") setBotIds((ids) => ids.slice(0, 1));
          }}
          options={[{ value: "routine", label: t("Routine") }, { value: "call", label: t("Call") }]}
        />
        <div className="flex items-start gap-3 text-[12.5px] text-ink">
          <Clock3 size={16} className="mt-0.5 shrink-0 text-ink-secondary" />
          <div><div>{niceDate(seed.at)}</div><div className="mt-0.5 text-ink-secondary">{niceTime(seed.at)} – {niceTime(seed.at + seed.durationMinutes * 60_000)}</div></div>
        </div>
        <div className="flex items-start gap-3">
          <UserRoundPlus size={16} className="mt-2.5 shrink-0 text-ink-secondary" />
          {bots.length === 0 ? (
            <button type="button" onClick={() => { dispatch({ type: "newBot" }); onClose(); }} className="min-w-0 flex-1 rounded-xl border border-dashed border-select/45 bg-select/[0.06] px-3 py-3 text-left hover:bg-select/10">
              <div className="text-[12px] font-semibold text-accent-text">{t("Create your first bot")}</div>
              <div className="mt-0.5 text-[11px] text-ink-secondary">{t("Then come back to schedule it.")}</div>
            </button>
          ) : kind === "routine" ? (
            <select value={botIds[0] ?? ""} onChange={(event) => setBotIds([event.target.value])} className={cn(FIELD, "min-w-0 flex-1")}>
              <option value="">{t("Assign a bot")}</option>
              {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
            </select>
          ) : (
            <div className="min-w-0 flex-1"><BotPicker bots={bots} selected={botIds} multiple onChange={setBotIds} /></div>
          )}
        </div>
        <div className="flex items-start gap-3">
          <FileText size={16} className="mt-2.5 shrink-0 text-ink-secondary" />
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} placeholder={kind === "routine" ? t("What should the bot do?") : t("Add a description (optional)")} className={cn(FIELD, "min-w-0 flex-1 resize-none leading-relaxed")} />
        </div>
        {error && <div className="rounded-lg bg-danger/10 px-3 py-2 text-[11.5px] text-danger">{error}</div>}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-hairline/40 px-4 py-3">
        <button type="button" onClick={() => onMore({ ...seed, kind, botIds, name, description })} className="h-8 rounded-[10px] px-3 text-[12.5px] font-semibold text-accent-text hover:bg-select/10">{t("More options")}</button>
        <button type="button" onClick={() => void save()} disabled={!valid || working} className="flex h-8 items-center gap-1.5 rounded-[10px] bg-primary px-4 text-[12.5px] font-semibold text-primary-ink hover:brightness-110 disabled:opacity-40">{working && <Loader2 size={13} className="animate-spin" />}{t("Save")}</button>
      </div>
    </div>
  );
}
