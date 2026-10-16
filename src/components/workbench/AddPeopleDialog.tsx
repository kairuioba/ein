// 加人预检 (U4): before anyone is added to a running job, the chief checks
// where it is slow (waiting on others? splittable? capability? rate limits?)
// and proposes how many to add as a new squad, what it costs and saves, which
// not-yet-started items the newcomers take, and their onboarding pack.
// Nothing changes until the owner picks: not now / add a few / as suggested.
import { useCallback, useEffect, useState } from "react";
import { BarChart3, Bell, Check, ChevronDown, Clock, Image as ImageIcon, Loader2, Repeat, Users, X } from "lucide-react";

import { BotTile } from "@/components/mascot/Mascot";
import { Button, Dialog } from "@/components/ui";
import { cn } from "@/lib/cn";
import { msg, t } from "@/lib/i18n";
import { squadName } from "@/lib/org";
import { clip, clock, mascotForModelName, splitRemaining, ungroupedLines } from "@/lib/workbench";
import { amendRun, diagnoseRun } from "@/state/org-api";
import type { DispatchRun } from "../../../shared/dispatch-types";
import type { LibraryDoc, RunDiagnosis } from "../../../shared/org-types";

import type { WorkbenchModel } from "./model";
import { formatYuan } from "./PeopleView";

const CHECK_LABEL: Record<RunDiagnosis["checks"][number]["id"], string> = {
  waiting: msg("Waiting on others?"),
  parallel: msg("Can it be split?"),
  capability: msg("Not capable enough?"),
  rateLimit: msg("Outside rate limits?"),
};

const modelLabel = (name: string) => {
  const kind = mascotForModelName(name);
  return kind === "workbuddy" && !/workbuddy/i.test(name) ? name : kind === "local" ? t("Local model") : kind.charAt(0).toUpperCase() + kind.slice(1);
};

type Phase = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; diagnosis: RunDiagnosis; tookMs: number; at: number };

export function AddPeopleDialog({
  open,
  run,
  model,
  onClose,
  onDone,
  onOpenChief,
}: {
  open: boolean;
  run?: DispatchRun;
  model: WorkbenchModel;
  onClose: () => void;
  onDone: (message: string) => void;
  onOpenChief: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [busy, setBusy] = useState<number | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [packOpen, setPackOpen] = useState(false);

  const diagnose = useCallback(async () => {
    if (!run) return;
    setPhase({ kind: "loading" });
    setSubmitError(null);
    const started = Date.now();
    try {
      const diagnosis = await diagnoseRun(run.id);
      setPhase({ kind: "ready", diagnosis, tookMs: Date.now() - started, at: Date.now() });
    } catch (error) {
      setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [run]);

  useEffect(() => {
    if (open && run) void diagnose();
    if (!open) {
      setBusy(null);
      setPackOpen(false);
    }
  }, [open, run, diagnose]);

  const add = async (count: number) => {
    if (!run) return;
    setBusy(count);
    setSubmitError(null);
    try {
      const result = await amendRun(run.id, count);
      await model.dispatch.refresh();
      onDone(t("Added {count} people to “{goal}”", { count: result.added?.length || count, goal: clip(run.goal, 16) }));
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const title = run ? t("Add-people check · {goal}", { goal: clip(run.goal, 14) }) : t("Add people");
  const chief = model.chief;
  return (
    <Dialog open={open} onClose={onClose} label={title} width={640} className="max-h-[calc(100dvh-48px)]">
      <header className="flex h-[62px] shrink-0 items-center gap-2.5 pr-3.5 pl-[22px]">
        {chief && <BotTile kind={model.mascotOf(chief)} size={26} chief />}
        <div className="flex min-w-0 flex-col leading-[1.35]">
          <b className="truncate text-[16px] text-ink">{title}</b>
          <span className="truncate text-[12px] text-ink-secondary">
            {phase.kind === "ready"
              ? t("{chief} · {time} · checked in {seconds} s, nobody moved yet", { chief: chief?.name ?? t("Chief"), time: clock(phase.at), seconds: Math.max(1, Math.round(phase.tookMs / 1000)) })
              : run
                ? t("{chief} is checking where the job is slow…", { chief: chief?.name ?? t("Chief") })
                : t("Nothing is running right now")}
          </span>
        </div>
        <span className="flex-1" />
        <button type="button" onClick={onClose} aria-label={t("Close")} className="grid size-8 place-items-center rounded-lg text-ink-secondary hover:bg-control hover:text-ink">
          <X size={18} />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 pb-4">
        {!run ? (
          <Notice title={t("No job in progress")} detail={t("Adding people works on a running job. Give the chief a multi-step task first; once it is dispatched you can add people to it here.")} />
        ) : phase.kind === "loading" ? (
          <div className="flex min-h-[260px] flex-col items-center justify-center gap-2 text-[13px] text-ink-secondary">
            <Loader2 size={20} className="animate-spin" />
            {t("Checking: waiting on others, splittable work, capability, rate limits…")}
          </div>
        ) : phase.kind === "error" ? (
          <Notice
            tone="error"
            title={t("The check could not run")}
            detail={t("The server did not answer the add-people check ({error}). It is part of the dispatch hub; try again once it is updated.", { error: phase.message })}
            action={<Button variant="ghost" size="sm" onClick={() => void diagnose()}>{t("Try again")}</Button>}
          />
        ) : (
          <Diagnosis diagnosis={phase.diagnosis} run={run} model={model} packOpen={packOpen} onTogglePack={() => setPackOpen((value) => !value)} />
        )}
      </div>

      <footer className="flex h-[70px] shrink-0 items-center gap-2 border-t border-hairline/30 pr-5 pl-3">
        <button type="button" onClick={onClose} className="h-10 rounded-[10px] px-3 text-[14px] font-semibold text-ink-secondary hover:bg-control hover:text-ink">
          {t("Not now")}
        </button>
        {submitError && <span className="min-w-0 truncate text-[12px] text-danger">{t("Could not add people: {error}", { error: submitError })}</span>}
        <span className="flex-1" />
        {!run ? (
          <Button size="lg" onClick={onOpenChief}>
            {t("Talk to the chief")}
          </Button>
        ) : phase.kind === "ready" && phase.diagnosis.verdict === "add-helps" && phase.diagnosis.suggestion ? (
          <>
            {phase.diagnosis.suggestion.add > 2 && (
              <Button variant="soft" size="lg" disabled={busy !== null} onClick={() => void add(2)}>
                {busy === 2 && <Loader2 size={14} className="animate-spin" />}
                {t("Only add {count}", { count: 2 })}
              </Button>
            )}
            <Button size="lg" disabled={busy !== null} onClick={() => void add(phase.diagnosis.suggestion!.add)}>
              {busy === phase.diagnosis.suggestion.add && <Loader2 size={14} className="animate-spin" />}
              {t("Add {count} as suggested", { count: phase.diagnosis.suggestion.add })}
            </Button>
          </>
        ) : phase.kind === "ready" ? (
          <>
            <Button variant="soft" size="lg" disabled={busy !== null} onClick={() => void add(1)}>
              {t("Add 1 anyway")}
            </Button>
            <Button size="lg" onClick={onClose}>
              {t("Got it")}
            </Button>
          </>
        ) : null}
      </footer>
    </Dialog>
  );
}

function Notice({ title, detail, action, tone = "info" }: { title: string; detail: string; action?: React.ReactNode; tone?: "info" | "error" }) {
  return (
    <div className={cn("my-6 flex flex-col items-center gap-1.5 rounded-[14px] px-6 py-8 text-center", tone === "error" ? "bg-danger/[0.06]" : "bg-inset")}>
      <b className={cn("text-[14px]", tone === "error" ? "text-danger" : "text-ink")}>{title}</b>
      <p className="max-w-[46ch] text-[12.5px] leading-relaxed text-ink-secondary">{detail}</p>
      {action && <div className="mt-1.5">{action}</div>}
    </div>
  );
}

const CheckIcon = ({ ok }: { ok: boolean }) =>
  ok ? (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="shrink-0">
      <circle cx="8" cy="8" r="8" className="fill-success" />
      <path d="M4.6 8.3l2.3 2.3 4.5-4.6" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="shrink-0">
      <circle cx="8" cy="8" r="8" fill="#D97706" />
      <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );

function Diagnosis({ diagnosis, run, model, packOpen, onTogglePack }: { diagnosis: RunDiagnosis; run: DispatchRun; model: WorkbenchModel; packOpen: boolean; onTogglePack: () => void }) {
  const helps = diagnosis.verdict === "add-helps";
  const suggestion = diagnosis.suggestion;
  return (
    <>
      <div>
        <div className="mb-1 flex h-6 items-center gap-2 text-[12.5px] font-semibold text-ink-secondary">
          {t("First, where is it slow?")}
          <span className={cn("ml-auto inline-flex h-[22px] items-center gap-1 rounded-full px-[9px] text-[12px] font-semibold whitespace-nowrap", helps ? "bg-success/12 text-success" : "bg-warning/12 text-warning")}>
            {helps ? <Check size={12} strokeWidth={2.6} /> : <X size={12} strokeWidth={2.6} />}
            {helps ? t("Short of hands — adding people helps") : t("Adding people won't help")}
          </span>
        </div>
        {diagnosis.checks.map((check) => (
          <div key={check.id} className="flex h-[25px] items-center gap-2 text-[13.5px] whitespace-nowrap">
            <CheckIcon ok={check.ok} />
            <b className="font-semibold text-ink">{t(CHECK_LABEL[check.id])}</b>
            <span className="text-ink-secondary/70">→</span>
            <span className="min-w-0 truncate text-ink-secondary">{check.finding}</span>
            {check.evidence && <span className="ml-auto pl-2 text-[12px] text-ink-secondary/70">{check.evidence}</span>}
          </div>
        ))}
      </div>
      {!helps && (
        <div className="rounded-[14px] bg-warning/[0.08] px-4 py-3 text-[13px] leading-relaxed text-ink shadow-[inset_0_0_0_1px_color-mix(in_srgb,#F59E0B_35%,transparent)]">
          <b className="text-warning">{t("Why not")}</b> · {diagnosis.reason ?? t("The bottleneck is not the number of people.")}
        </div>
      )}
      {helps && suggestion && <Suggestion diagnosis={diagnosis} suggestion={suggestion} run={run} model={model} packOpen={packOpen} onTogglePack={onTogglePack} />}
    </>
  );
}

function Suggestion({
  diagnosis,
  suggestion,
  run,
  model,
  packOpen,
  onTogglePack,
}: {
  diagnosis: RunDiagnosis;
  suggestion: NonNullable<RunDiagnosis["suggestion"]>;
  run: DispatchRun;
  model: WorkbenchModel;
  packOpen: boolean;
  onTogglePack: () => void;
}) {
  const split = splitRemaining(diagnosis.remaining, suggestion.add);
  const letter = /([A-Z])\s*$/.exec(suggestion.squad)?.[1];
  const existingName = letter && letter > "A" ? squadName(letter.charCodeAt(0) - 66) : t("Current people");
  const currentPeople = Math.round((1 + Math.sqrt(1 + 8 * suggestion.linesBefore)) / 2);
  const lead = suggestion.models[0] ? modelLabel(suggestion.models[0]) : null;
  const stats = [
    {
      icon: <Clock size={13} />,
      label: t("Done by"),
      value: suggestion.etaAfter ? clock(suggestion.etaAfter) : "—",
      note: suggestion.etaBefore ? t("was {time}", { time: clock(suggestion.etaBefore) }) : "",
    },
    {
      icon: <BarChart3 size={13} />,
      label: t("Costs about"),
      value: `¥${formatYuan(suggestion.costCny)}`,
      note: suggestion.withinBudget ? (
        <span className="inline-flex items-center gap-[3px]">
          <Check size={12} className="text-success" strokeWidth={2.6} />
          {t("within budget")}
        </span>
      ) : (
        <span className="text-danger">{t("over budget — needs you")}</span>
      ),
    },
    {
      icon: <Users size={13} />,
      label: t("Lines of talk"),
      value: `${suggestion.linesBefore} → ${suggestion.linesAfter}`,
      note: t("ungrouped {count}", { count: ungroupedLines(currentPeople + suggestion.add) }),
    },
  ];
  const groups: Array<{ cells: typeof split.done; cls: string; label: string; labelClass?: string }> = [
    { cells: split.done, cls: "bg-success/15 text-success", label: t("{count} done · untouched", { count: split.done.length }) },
    { cells: split.running, cls: "bg-raised text-accent-text shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--color-select)_55%,transparent)]", label: t("{count} in progress · kept", { count: split.running.length }) },
    { cells: split.keep, cls: "bg-[#F59E0B]/15 text-warning shadow-[inset_0_0_0_1px_rgb(242_194_122)]", label: t("{squad} {count} items", { squad: existingName, count: split.keep.length }), labelClass: "font-semibold text-warning" },
    { cells: split.fresh, cls: "bg-[#8B5CF6]/12 text-[#6D3FE0] shadow-[inset_0_0_0_1px_rgb(185_165_248)]", label: t("{squad} {count} · newcomers", { squad: suggestion.squad, count: split.fresh.length }), labelClass: "font-semibold text-[#6D3FE0]" },
  ].filter((group) => group.cells.length);
  const indexOf = new Map(diagnosis.remaining.map((item, index) => [item.subtaskId, index + 1]));

  // the onboarding pack: what a newcomer reads instead of the whole chat
  const pendingSubtasks = run.subtasks.filter((subtask) => split.fresh.some((item) => item.subtaskId === subtask.id));
  const acceptance = pendingSubtasks.find((subtask) => subtask.acceptance)?.acceptance ?? run.subtasks.find((subtask) => subtask.acceptance)?.acceptance;
  const examples = split.done.length ? (split.done.length > 1 ? t("{first} – {last} finished examples", { first: clip(split.done[0]!.title, 8), last: clip(split.done[split.done.length - 1]!.title, 8) }) : t("{title} as the finished example", { title: clip(split.done[0]!.title, 12) })) : t("No finished example yet");
  const docs = model.library.filter((doc: LibraryDoc) => doc.versions.length).slice(0, 2);
  const docsLine = docs.length ? t("Subscribed: {docs}", { docs: docs.map((doc) => `${doc.title} v${Math.max(...doc.versions.map((version) => version.version))}`).join(t(", ")) }) : t("No shared documents yet");
  const room = model.rooms.find((candidate) => run.subtasks.some((subtask) => candidate.everyone.some((bot) => bot.id === subtask.assigneeBotId)));
  const pack: Array<{ icon: React.ReactNode; label: string; value: string }> = [
    { icon: <Check size={13} />, label: t("Acceptance"), value: acceptance ?? t("Same as the finished items") },
    { icon: <ImageIcon size={13} />, label: t("Follow"), value: examples },
    { icon: <Bell size={13} />, label: t("Sources"), value: docsLine },
  ];
  const more: typeof pack = [
    { icon: <Repeat size={13} />, label: t("Agreements"), value: t("Report each item when done; stuck {count} min goes up a level", { count: model.org.rules.escalateAfterMin }) },
    { icon: <Users size={13} />, label: t("Your scope"), value: t("Only the {count} items given to {squad}; leave finished and running ones alone", { count: split.fresh.length, squad: suggestion.squad }) },
    { icon: <Bell size={13} />, label: t("Ask whom"), value: t("{squad} lead → {lead} → chief", { squad: suggestion.squad, lead: room?.lead?.name ?? t("the department lead") }) },
  ];
  return (
    <>
      <div className="rounded-[14px] bg-inset px-4 py-3 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_30%,transparent)]">
        <div className="flex h-[26px] items-center gap-2">
          <b className="truncate text-[15px] text-ink">
            {t("Suggestion: add {count}, as a new squad", { count: suggestion.add })} <em className="text-[#6D3FE0] not-italic">{suggestion.squad}</em>
            {lead ? t(" (lead: {model})", { model: lead }) : ""}
          </b>
          <span className="ml-auto flex shrink-0 gap-px">
            {suggestion.models.slice(0, 6).map((name, index) => (
              <BotTile key={index} kind={mascotForModelName(name)} size={17} />
            ))}
          </span>
        </div>
        <div className="mt-2.5 grid grid-cols-3 gap-2">
          {stats.map((stat) => (
            <div key={stat.label} className="flex flex-col gap-0.5 rounded-[10px] bg-raised px-3 pt-2 pb-[9px] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_50%,transparent)]">
              <span className="flex items-center gap-[5px] text-[12px] text-ink-secondary">
                {stat.icon}
                {stat.label}
              </span>
              <span className="flex items-baseline gap-[7px] whitespace-nowrap">
                <b className="text-[19px] font-bold tracking-[-0.3px] text-ink tabular-nums">{stat.value}</b>
                <span className="inline-flex items-center gap-[3px] text-[12px] text-ink-secondary">{stat.note}</span>
              </span>
            </div>
          ))}
        </div>
        <div className="mt-3.5 flex items-baseline gap-2 whitespace-nowrap">
          <b className="text-[13px] text-ink">{t("Only the {count} not started are re-split", { count: split.keep.length + split.fresh.length })}</b>
          <span className="truncate text-[12px] text-ink-secondary">{t("Finished stays, running isn't taken; newcomers get independent items")}</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-[9px] gap-y-2">
          {groups.map((group) => (
            <div key={group.label} className="flex flex-col gap-[5px]">
              <span className="flex flex-wrap gap-[3px]">
                {group.cells.map((item) => (
                  <i key={item.subtaskId} title={item.title} className={cn("grid h-[22px] w-[19px] place-items-center rounded-[5px] font-mono text-[9px] font-medium tracking-[-0.4px] not-italic", group.cls)}>
                    {String(indexOf.get(item.subtaskId) ?? 0).padStart(2, "0")}
                  </i>
                ))}
              </span>
              <span className={cn("text-[11.5px] whitespace-nowrap text-ink-secondary", group.labelClass)}>{group.label}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-xl shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent)]">
        <button type="button" onClick={onTogglePack} className="flex h-[38px] w-full items-center gap-2 pr-3.5 pl-3 text-left whitespace-nowrap">
          <ChevronDown size={14} className={cn("text-ink-secondary transition-transform", !packOpen && "-rotate-90")} />
          <b className="text-[13.5px] text-ink">{t("{squad} onboarding pack", { squad: suggestion.squad })}</b>
          <span className="truncate text-[12px] text-ink-secondary">{t("Written by the chief · newcomers read only this page")}</span>
          <span className="ml-auto text-[12px] text-ink-secondary">{t("1 page · {count} items", { count: pack.length + more.length })}</span>
        </button>
        {[...pack, ...(packOpen ? more : [])].map((row) => (
          <div key={row.label} className="grid h-[26px] grid-cols-[22px_74px_1fr] items-center pr-3.5 pl-3 text-[13px] whitespace-nowrap">
            <span className="grid w-[22px] place-items-center text-ink-secondary">{row.icon}</span>
            <b className="ml-1.5 font-semibold text-ink">{row.label}</b>
            <span className="truncate text-ink-secondary">{row.value}</span>
          </div>
        ))}
        <button type="button" onClick={onTogglePack} className="mt-1 flex h-[34px] w-full items-center gap-[5px] border-t border-hairline/30 px-3.5 text-[12.5px] font-semibold whitespace-nowrap text-accent-text">
          {packOpen ? t("Show less") : t("Show all {count} items", { count: pack.length + more.length })}
          <ChevronDown size={12} className={cn(packOpen && "rotate-180")} />
          {!packOpen && <span className="ml-1.5 truncate font-normal text-ink-secondary/70">{t("plus agreements, your scope, whom to ask")}</span>}
        </button>
      </div>
      <div className="flex items-center gap-[7px] text-[12.5px] text-ink-secondary">
        <Repeat size={14} className="text-accent-text" />
        {t("Checked again after 30 minutes; if it isn't faster you'll hear why, with a suggestion to undo")}
      </div>
    </>
  );
}
