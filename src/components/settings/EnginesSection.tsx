// Settings › Engines (U12): every engine with its sign-in state, models and
// the bots running on it; quiet engines fold away; the dispatch strategy with
// what it would hire for a few sample jobs; and a pointer to auto-review.
import { useMemo, useState } from "react";
import { ArrowRight, ChevronDown, ChevronUp, Loader2, Lock, Plus, RefreshCw, ShieldCheck, Sparkles, X } from "lucide-react";
import { useStore, type Bot, type InstanceInfo } from "@/state/store";
import { useOrg } from "@/state/org-api";
import { chiefBot } from "@/lib/org";
import { BotTile } from "@/components/mascot/Mascot";
import { BotAvatar } from "@/components/Avatar";
import { Button, Dialog, Panel, Segmented } from "@/components/ui";
import { EngineSetup } from "@/components/EngineSetup";
import { EngineRow as EngineCliRow, EnginesSettings } from "@/components/EnginesSettings";
import { WorkBuddySettings } from "@/components/WorkBuddySettings";
import { EffortLadder, useDispatchSettings } from "@/components/DispatchSettingsCard";
import { Switch } from "@/components/SettingsPrimitives";
import { cn } from "@/lib/cn";
import { t, tn } from "@/lib/i18n";
import { effortLabel, type RecommendationPolicy } from "../../../shared/model-recommender";
import {
  ENGINE_STATE_LABEL,
  engineAction,
  engineRows,
  engineSummary,
  engineTone,
  foldRows,
  foldedSummary,
  mascotForInstance,
  modelChips,
  strategyExamples,
  type EngineRow,
  type EngineTone,
} from "./engine-model";
import { reviewCounts, reviewRules } from "./review-model";
import { rulesOf } from "./org-model";
import { SectionHeader } from "./parts";

const TONE_TEXT: Record<EngineTone, string> = {
  ok: "text-success",
  warn: "text-warning",
  found: "text-accent-text",
  off: "text-ink-secondary",
};
const TONE_DOT: Record<EngineTone, string> = {
  ok: "bg-success",
  warn: "bg-[#D97706]",
  found: "bg-select",
  off: "bg-ink-secondary/50",
};

export function engineStateLabel(row: Pick<EngineRow, "state" | "instance">): string {
  if (row.state === "found") {
    const count = row.instance.models.options.filter((option) => option.custom).length;
    return tn(count, "Found {count} model", "Found {count} models");
  }
  // an API-key engine is never "signed in": its setup is a saved key
  if (row.state === "ready" && row.instance.snapshot.credential) return t("API key saved");
  return t(ENGINE_STATE_LABEL[row.state]);
}

function namesLine(bots: Bot[]): string {
  if (bots.length <= 2) return bots.map((bot) => bot.name).join(t(", "));
  return t("{name} and {count} more", { name: bots[0]!.name, count: bots.length });
}

const ROW_GRID = "grid grid-cols-[40px_minmax(150px,212px)_minmax(0,1fr)_minmax(120px,176px)_78px] items-center gap-x-3.5 px-3.5";

function EngineListRow({ row, onOpen }: { row: EngineRow<Bot>; onOpen: () => void }) {
  const tone = engineTone(row.state);
  const { labels, mono } = modelChips(row.instance);
  const action = engineAction(row.state);
  const blocked = row.state === "signin" || row.state === "key" || row.state === "missing";
  return (
    <div className={cn(ROW_GRID, "h-[50px] border-t border-hairline/30")}>
      <BotTile kind={row.kind} size={40} title={row.instance.displayName} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-baseline gap-[7px] whitespace-nowrap">
          <b className="truncate text-[14px] leading-[1.35] font-bold text-ink">{row.instance.displayName}</b>
          {row.openSource && <em className="text-[12px] not-italic text-ink-secondary/70">{t("Open source")}</em>}
        </span>
        <span className={cn("flex items-center gap-[5px] text-[12px] leading-[1.35] whitespace-nowrap", TONE_TEXT[tone])}>
          {row.recommended && (
            <>
              <span className="inline-flex h-[17px] items-center rounded-[5px] bg-select/12 px-1.5 text-[11px] font-bold text-accent-text">{t("Recommended")}</span>
              <span className="text-ink-secondary/60">·</span>
            </>
          )}
          <i className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[tone])} />
          {engineStateLabel(row)}
        </span>
      </span>
      <span className="flex min-w-0 gap-[5px] overflow-hidden">
        {labels.length ? (
          labels.map((label) => (
            <span
              key={label}
              className={cn(
                "inline-flex h-[22px] shrink-0 items-center rounded-md px-[7px] text-[12px] whitespace-nowrap",
                mono && "font-mono text-[11.5px]",
                blocked ? "bg-inset text-ink-secondary/70" : "bg-control/70 text-ink-secondary",
              )}
            >
              {label}
            </span>
          ))
        ) : (
          <span className="text-[12px] text-ink-secondary/70">{t("No models yet")}</span>
        )}
      </span>
      <span className="flex min-w-0 items-center gap-[7px] text-[12.5px] whitespace-nowrap text-ink-secondary">
        {row.bots.length ? (
          <>
            <span className={cn("flex shrink-0 pl-1", blocked && "opacity-55")}>
              {row.bots.slice(0, 3).map((bot) => (
                <span key={bot.id} className="-ml-[5px] inline-flex rounded-[6px] ring-[1.5px] ring-raised">
                  <BotAvatar bot={bot} size={18} />
                </span>
              ))}
            </span>
            <span className="flex min-w-0 flex-col leading-[1.3]">
              <span className={cn("truncate", blocked && "opacity-55")}>{namesLine(row.bots)}</span>
              {blocked && (
                <small className="truncate text-[11px] text-warning">
                  {row.state === "signin"
                    ? t("Can't run until you sign in")
                    : row.state === "key"
                      ? t("Can't run until you add an API key")
                      : t("Can't run until it's installed")}
                </small>
              )}
            </span>
          </>
        ) : (
          <span className="text-ink-secondary/60">—</span>
        )}
      </span>
      <span className="flex justify-end">
        {action === "settings" ? (
          <Button variant="soft" size="sm" onClick={onOpen}>
            {t("Settings")}
          </Button>
        ) : (
          <Button size="sm" onClick={onOpen}>
            {action === "signin" ? t("Sign in") : action === "key" ? t("Add key") : t("Install")}
          </Button>
        )}
      </span>
    </div>
  );
}

function FoldedRow({ rows, expanded, onToggle }: { rows: EngineRow<Bot>[]; expanded: boolean; onToggle: () => void }) {
  const summary = foldedSummary(rows);
  return (
    <div className="flex h-9 items-center gap-2.5 border-t border-hairline/30 bg-inset px-3.5">
      {!expanded && (
        <>
          <span className="flex shrink-0 pl-1">
            {rows.slice(0, 4).map((row) => (
              <span key={row.instance.instanceId} className="-ml-[5px] inline-flex rounded-[6px] ring-[1.5px] ring-inset">
                <BotTile kind={row.kind} size={18} />
              </span>
            ))}
          </span>
          <span className="min-w-0 truncate text-[12.5px] text-ink-secondary">
            {t("{count} more:", { count: rows.length })} <b className="font-semibold text-ink">{rows.map((row) => row.instance.displayName).join(" · ")}</b>
          </span>
          <span className={cn("flex shrink-0 items-center gap-[5px] text-[12px]", TONE_TEXT[summary.tone])}>
            <i className={cn("size-1.5 rounded-full", TONE_DOT[summary.tone])} />
            {summary.tone === "ok"
              ? t("All signed in")
              : summary.parts
                  .map((part) =>
                    part.state === "missing"
                      ? t("{count} not installed", { count: part.count })
                      : part.state === "signin"
                        ? t("{count} not signed in", { count: part.count })
                        : part.state === "key"
                          ? t("{count} need an API key", { count: part.count })
                          : null,
                  )
                  .filter(Boolean)
                  .join(t(", "))}
          </span>
        </>
      )}
      <span className="flex-1" />
      <button type="button" onClick={onToggle} className="inline-flex shrink-0 items-center gap-0.5 text-[12.5px] font-semibold text-accent-text hover:underline">
        {expanded ? t("Collapse") : t("Expand")}
        {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>
    </div>
  );
}

function StrategyCard() {
  const { state } = useStore();
  const { settings, loaded, saving, error, save } = useDispatchSettings();
  const examples = useMemo(() => strategyExamples(state.instances, settings.policy), [state.instances, settings.policy]);
  const hint: Record<RecommendationPolicy, string> = {
    economy: t("Pick the cheapest model that can do the job; strong ones only when nothing cheaper can."),
    balanced: t("Good enough is cheap enough; only hard jobs get the strongest models."),
    quality: t("Every new specialist gets the strongest model that fits its job."),
  };
  const label: Record<RecommendationPolicy, string> = {
    economy: t("Save money"),
    balanced: t("Balanced"),
    quality: t("Strongest"),
  };
  return (
    <Panel aria-label={t("Recommendation strategy")} className="flex min-w-0 flex-1 flex-col px-4 pt-2.5 pb-3">
      <div className="flex h-7 items-center gap-2">
        <span className="grid size-[26px] place-items-center rounded-lg bg-select/12 text-accent-text">
          <Sparkles size={15} />
        </span>
        <b className="text-[14.5px] text-ink">{t("Recommendation strategy")}</b>
        <Segmented<RecommendationPolicy>
          className="ml-auto"
          value={settings.policy}
          label={t("Recommendation strategy")}
          onChange={(policy) => save({ policy })}
          options={(["economy", "balanced", "quality"] as const).map((value) => ({ value, label: label[value], disabled: !loaded || saving }))}
        />
      </div>
      <p className="mt-1.5 text-[13px] leading-[1.6] text-ink-secondary">
        {t("Each time the Chief adds a specialist, it looks at the job first, then picks a model from the engines that can run.")}
        <br />
        <b className="text-ink">{label[settings.policy]}</b>
        {t(": ")}
        {hint[settings.policy]}
      </p>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="text-[12.5px] text-ink">{t("Effort by difficulty")}</span>
        <Switch
          checked={settings.autoEffort}
          disabled={!loaded || saving}
          aria-label={t("Think as hard as each task needs")}
          onClick={() => save({ autoEffort: !settings.autoEffort })}
        />
        {settings.autoEffort ? (
          <EffortLadder policy={settings.policy} />
        ) : (
          <span className="text-[12px] text-ink-secondary">{t("Off: a bot without its own level lets the engine decide.")}</span>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {examples.length === 0 && <span className="text-[12px] text-ink-secondary">{t("Sign in to an engine and examples show here.")}</span>}
        {examples.map((example) => {
          const instance = state.instances.find((entry) => entry.instanceId === example.instanceId);
          return (
            <span
              key={example.id}
              title={`${example.engineName} · ${example.model}`}
              className="inline-flex h-7 items-center gap-[5px] rounded-lg bg-inset pr-[9px] pl-[5px] text-[12px] whitespace-nowrap text-ink-secondary shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_30%,transparent)]"
            >
              {instance && <BotTile kind={mascotForInstance(instance)} size={16} />}
              <span>{t(example.label)}</span>
              <span className="text-ink-secondary/60">→</span>
              <b className="font-semibold text-ink">{example.engineName}</b>
              {example.effort && settings.autoEffort && <span className="text-ink-secondary">· {effortLabel(example.effort)}</span>}
            </span>
          );
        })}
      </div>
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    </Panel>
  );
}

function ReviewSummaryCard() {
  const { state, dispatch } = useStore();
  const { data: org } = useOrg();
  const counts = reviewCounts(reviewRules(state.bots, rulesOf(org)));
  return (
    <Panel aria-label={t("Auto-review")} className="flex w-[262px] shrink-0 flex-col px-4 pt-2.5 pb-3">
      <div className="flex h-7 items-center gap-2">
        <span className="grid size-[26px] place-items-center rounded-lg bg-warning/12 text-warning">
          <ShieldCheck size={15} />
        </span>
        <b className="text-[14.5px] text-ink">{t("Auto-review")}</b>
      </div>
      <div className="mt-2.5 flex items-center gap-[5px] text-[13px] whitespace-nowrap text-ink-secondary">
        <b className="text-ink">{t("{count} ask-first rules", { count: counts.ask })}</b>
        <span className="text-ink-secondary/60">·</span>
        <Lock size={12} />
        {t("{count} locked", { count: counts.locked })}
      </div>
      <div className="mt-1 text-[12px] text-ink-secondary">{t("Publishing, destructive commands and overspending always ask you")}</div>
      <button
        type="button"
        onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "review" })}
        className="mt-auto inline-flex items-center gap-0.5 self-start pt-2 text-[12.5px] font-semibold text-accent-text hover:underline"
      >
        {t("Manage rules")}
        <ArrowRight size={13} />
      </button>
    </Panel>
  );
}

function EngineDetail({ row, onClose }: { row: EngineRow<Bot>; onClose: () => void }) {
  const instance = row.instance as InstanceInfo;
  const tone = engineTone(row.state);
  const blocked = row.state === "signin" || row.state === "key" || row.state === "missing";
  const official = instance.models.options.filter((option) => !option.custom);
  const custom = instance.models.options.filter((option) => option.custom);
  return (
    <Dialog open onClose={onClose} label={instance.displayName} width={600}>
      <div className="flex items-center gap-3 px-5 pt-4 pb-3">
        <BotTile kind={row.kind} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <b className="text-[16px] font-bold text-ink">{instance.displayName}</b>
            {instance.snapshot.billing === "metered" && (
              <span className="rounded bg-control px-1.5 py-0.5 text-[10.5px] font-medium text-ink-secondary">{t("Pay as you go")}</span>
            )}
            {instance.snapshot.version && <span className="truncate text-[12px] text-ink-secondary">{instance.snapshot.version}</span>}
          </div>
          <div className={cn("mt-0.5 flex items-center gap-[5px] text-[12.5px]", TONE_TEXT[tone])}>
            <i className={cn("size-1.5 rounded-full", TONE_DOT[tone])} />
            {engineStateLabel(row)}
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label={t("Close")} className="grid size-8 place-items-center rounded-lg text-ink-secondary hover:bg-control hover:text-ink">
          <X size={16} />
        </button>
      </div>
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 pb-5">
        {(blocked || instance.snapshot.credential) && (
          <EngineSetup instance={instance} intent={instance.access === "custom" ? "inject" : "cloud"} />
        )}
        {instance.driverKind === "workbuddyAgent" && <WorkBuddySettings />}
        <section>
          <div className="mb-1.5 text-[12px] font-semibold text-ink-secondary">{t("Models")}</div>
          <div className="flex flex-wrap gap-1.5">
            {official.map((option) => (
              <span key={option.id} className="inline-flex h-[22px] items-center rounded-md bg-control/70 px-[7px] text-[12px] text-ink-secondary">
                {option.label}
                {option.id === instance.models.default && <span className="ml-1 text-[10.5px] text-ink-secondary/70">{t("Default")}</span>}
              </span>
            ))}
            {custom.map((option) => (
              <span key={option.id} className="inline-flex h-[22px] items-center rounded-md bg-control/70 px-[7px] font-mono text-[11.5px] text-ink-secondary">
                {option.label}
              </span>
            ))}
            {!official.length && !custom.length && <span className="text-[12px] text-ink-secondary">{t("No models yet")}</span>}
          </div>
        </section>
        <section>
          <div className="mb-1.5 text-[12px] font-semibold text-ink-secondary">{t("Bots on this engine")}</div>
          {row.bots.length ? (
            <div className="flex flex-col">
              {row.bots.map((bot) => (
                <div key={bot.id} className="flex h-8 items-center gap-2 text-[13px]">
                  <BotAvatar bot={bot} size={20} />
                  <span className="font-medium text-ink">{bot.name}</span>
                  <span className="truncate text-[12px] text-ink-secondary">
                    {instance.models.options.find((option) => option.id === bot.modelSelection.model)?.label ?? bot.modelSelection.model}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[12.5px] text-ink-secondary">{t("No bot runs on it yet. Pick it in a bot's settings under Engine.")}</div>
          )}
        </section>
        {(instance.cliDefault !== undefined || instance.cli !== undefined) && (
          <section>
            <div className="mb-1.5 text-[12px] font-semibold text-ink-secondary">{t("Command-line app")}</div>
            <EngineCliRow instance={instance} />
          </section>
        )}
      </div>
    </Dialog>
  );
}

export function EnginesSection() {
  const { state, refreshInstances } = useStore();
  const { data: org } = useOrg();
  const chief = chiefBot(state.bots, org);
  const rows = useMemo(() => engineRows<Bot>(state.instances, state.bots, chief?.id), [state.instances, state.bots, chief?.id]);
  const { shown, folded } = foldRows(rows);
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState(false);
  const [showCli, setShowCli] = useState(false);
  const summary = engineSummary(state.instances);
  const visible = expanded ? rows : shown;
  const open = rows.find((row) => row.instance.instanceId === detail);

  const rescan = async () => {
    setRescanning(true);
    try {
      await refreshInstances();
    } finally {
      setRescanning(false);
    }
  };

  return (
    <>
      <SectionHeader
        title={t("Engines")}
        description={t("Every model your bots work with comes from here. Sign in once and every bot can use it; which one a bot uses is set in that bot's own settings.")}
      />
      <div className="mb-2 flex min-h-[30px] flex-wrap items-center gap-2">
        <span className="text-[12.5px] whitespace-nowrap text-ink-secondary">
          <b className="mr-0.5 text-[14px] text-ink">{tn(summary.total, "{count} engine", "{count} engines")}</b>
          {" · "}
          {t("{count} usable", { count: summary.usable })}
          {" · "}
          {summary.localModels ? tn(summary.localModels, "{count} model found on this computer", "{count} models found on this computer") : t("No local models found")}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => void rescan()}
          disabled={rescanning}
          className="mr-1.5 inline-flex items-center gap-[5px] text-[12.5px] font-semibold whitespace-nowrap text-ink-secondary hover:text-ink disabled:opacity-60"
        >
          {rescanning ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          {t("Rescan this computer")}
        </button>
        <Button variant="ghost" size="sm" onClick={() => setExpanded(true)} title={t("Show every engine, including the ones to install")}>
          <Plus size={13} />
          {t("Add engine")}
        </Button>
      </div>

      <div className="overflow-x-auto rounded-[14px] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent)]">
        <div className="min-w-[700px] overflow-hidden rounded-[14px]">
          <div className={cn(ROW_GRID, "h-7 bg-inset text-[11.5px] font-semibold text-ink-secondary/80")}>
            <span className="col-span-2">{t("Engine")}</span>
            <span>{t("Models")}</span>
            <span>{t("Bots using it")}</span>
            <span />
          </div>
          {visible.map((row) => (
            <EngineListRow key={row.instance.instanceId} row={row} onOpen={() => setDetail(row.instance.instanceId)} />
          ))}
          {rows.length === 0 && <div className="border-t border-hairline/30 px-4 py-6 text-center text-[13px] text-ink-secondary">{t("Checking which engines this computer has…")}</div>}
          {folded.length > 0 && <FoldedRow rows={folded} expanded={expanded} onToggle={() => setExpanded((value) => !value)} />}
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-3.5 sm:flex-row">
        <StrategyCard />
        <ReviewSummaryCard />
      </div>

      <div className="mt-3.5">
        <button
          type="button"
          onClick={() => setShowCli((value) => !value)}
          aria-expanded={showCli}
          className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-ink-secondary hover:text-ink"
        >
          {showCli ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          {t("Command-line paths (advanced)")}
        </button>
        {showCli && (
          <div className="mt-2 flex flex-col gap-3">
            <Panel className="p-4">
              <div className="mb-3 text-[12.5px] text-ink-secondary">{t("Which binary each engine runs. Saved as you go.")}</div>
              <EnginesSettings />
            </Panel>
            {/* WorkBuddy's key and edition live in its row's detail; without a
                WorkBuddy row they stay reachable here */}
            {!state.instances.some((instance) => instance.driverKind === "workbuddyAgent") && <WorkBuddySettings />}
          </div>
        )}
      </div>

      {open && <EngineDetail row={open} onClose={() => setDetail(null)} />}
    </>
  );
}
