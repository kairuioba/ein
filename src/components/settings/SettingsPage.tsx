// Settings as one full page (activeView "settings"): a nav on the left with a
// search and a short status per section, the chosen section on the right.
// Opening and closing go through the toggleAppSettings action, which also
// remembers the view to return to.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ChartColumn,
  Cpu,
  Download,
  FlaskConical,
  KeyRound,
  Laptop,
  Palette,
  Repeat,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useStore, type AppSettingsSection } from "@/state/store";
import { useOrg, useUsageSummary } from "@/state/org-api";
import { buildDepartments } from "@/lib/org";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { visibleSections } from "./settings-sections";
import {
  AppearanceSection,
  ComputerSection,
  ConnectionsSection,
  ExperimentalSection,
  GeneralSection,
  PhoneSection,
  UpdatesSection,
  currentSkinName,
  useExperimentalCount,
  useUpdateWaiting,
} from "./BasicSections";
import { OrgSection } from "./OrgSection";
import { EnginesSection } from "./EnginesSection";
import { CadenceSection, ReviewSection, UsageBillingSection } from "./PolicySections";
import { engineSummary } from "./engine-model";
import { reviewCounts, reviewRules } from "./review-model";
import { rulesOf } from "./org-model";

const ICONS: Record<AppSettingsSection, LucideIcon> = {
  general: SlidersHorizontal,
  appearance: Palette,
  org: Users,
  engines: Cpu,
  review: ShieldCheck,
  cadence: Repeat,
  computer: Laptop,
  connections: KeyRound,
  companion: Smartphone,
  usage: ChartColumn,
  experimental: FlaskConical,
  updates: Download,
};

/** The grey status after each nav item ("5 个部门", "日报 18:00" …). */
function useNavMeta(): Partial<Record<AppSettingsSection, ReactNode>> {
  const { state } = useStore();
  const { data: org } = useOrg();
  const { data: usage } = useUsageSummary();
  const experimental = useExperimentalCount();
  const updateWaiting = useUpdateWaiting();
  return useMemo(() => {
    const rules = rulesOf(org);
    const departments = buildDepartments(state.bots, org).length;
    const engines = engineSummary(state.instances);
    const review = reviewCounts(reviewRules(state.bots, rules));
    const config = state.config;
    const configured = [config?.composio?.configured, config?.box?.configured, config?.vps?.configured, config?.opencodeGo?.configured, config?.tts?.configured, config?.xai?.configured].filter(Boolean).length;
    return {
      appearance: currentSkinName() || undefined,
      org: departments ? t("{count} departments", { count: departments }) : undefined,
      engines: engines.total ? t("{count} usable", { count: engines.usable }) : undefined,
      review: t("{count} rules", { count: review.ask + review.allow }),
      cadence: t("Daily brief {time}", { time: rules.reportCadence.dailyBriefAt }),
      connections: configured ? t("{count} set up", { count: configured }) : undefined,
      usage: usage.weekPercent !== null ? `${Math.round(usage.weekPercent)}%` : undefined,
      experimental: experimental ? t("{count} on", { count: experimental }) : undefined,
      updates: updateWaiting ? <span className="size-[7px] rounded-full bg-select" aria-label={t("An update is ready")} /> : undefined,
    };
  }, [state.bots, state.instances, state.config, org, usage.weekPercent, experimental, updateWaiting]);
}

function SettingsNav({ section, query, onQuery }: { section: AppSettingsSection; query: string; onQuery: (value: string) => void }) {
  const { dispatch } = useStore();
  const meta = useNavMeta();
  const shown = visibleSections(query);
  return (
    <nav aria-label={t("Settings sections")} className="flex w-[196px] shrink-0 flex-col border-r border-hairline/40 bg-inset px-2.5 pt-5">
      <div className="flex h-[30px] items-center px-2 text-[16px] font-bold text-ink">{t("Settings")}</div>
      <label className="mt-2.5 mb-3 flex h-[34px] items-center gap-[7px] rounded-[10px] bg-raised px-2.5 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent)]">
        <Search size={15} className="shrink-0 text-ink-secondary/70" />
        <input
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            if (query) onQuery("");
            else dispatch({ type: "toggleAppSettings", open: false });
          }}
          placeholder={t("Search settings")}
          aria-label={t("Search settings")}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-ink placeholder:text-ink-secondary/70 focus:outline-none"
        />
      </label>
      <div className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto pb-4">
        {shown.length === 0 && (
          <div className="px-2.5 py-4 text-[12.5px] leading-relaxed text-ink-secondary">{t("Nothing matches “{query}”", { query: query.trim() })}</div>
        )}
        {shown.map((entry) => {
          const Icon = ICONS[entry.id];
          const on = entry.id === section;
          return (
            <button
              key={entry.id}
              type="button"
              aria-current={on ? "page" : undefined}
              onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: entry.id })}
              className={cn(
                "flex h-9 shrink-0 items-center gap-2 rounded-[9px] px-[9px] text-left text-[13.5px] whitespace-nowrap",
                on
                  ? "bg-raised font-semibold text-ink shadow-[0_1px_2px_rgb(16_24_40/0.05),0_0_0_1px_rgb(16_24_40/0.05)]"
                  : "font-medium text-ink-secondary hover:bg-raised/60 hover:text-ink",
              )}
            >
              <Icon size={16} className={cn("shrink-0", on ? "text-accent-text" : "text-ink-secondary/80")} />
              <span className="min-w-0 truncate">{t(entry.label)}</span>
              {meta[entry.id] !== undefined && (
                <em className={cn("ml-auto flex shrink-0 items-center text-[11.5px] font-normal not-italic", on ? "text-ink-secondary" : "text-ink-secondary/70")}>
                  {meta[entry.id]}
                </em>
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function SectionBody({ section }: { section: AppSettingsSection }) {
  switch (section) {
    case "general":
      return <GeneralSection />;
    case "appearance":
      return <AppearanceSection />;
    case "org":
      return <OrgSection />;
    case "engines":
      return <EnginesSection />;
    case "review":
      return <ReviewSection />;
    case "cadence":
      return <CadenceSection />;
    case "computer":
      return <ComputerSection />;
    case "connections":
      return <ConnectionsSection />;
    case "companion":
      return <PhoneSection />;
    case "usage":
      return <UsageBillingSection />;
    case "experimental":
      return <ExperimentalSection />;
    case "updates":
      return <UpdatesSection />;
  }
}

export function SettingsPage() {
  const { state, dispatch } = useStore();
  const section = state.appSettingsSection;
  const [query, setQuery] = useState("");
  const scroller = useRef<HTMLDivElement>(null);

  // A search that hides the open section moves to the first match.
  useEffect(() => {
    const shown = visibleSections(query);
    if (!shown.length || shown.some((entry) => entry.id === section)) return;
    dispatch({ type: "toggleAppSettings", open: true, section: shown[0]!.id });
  }, [dispatch, query, section]);

  // Each section starts at its top.
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [section]);

  // Esc leaves the page for the view it was opened from — unless a dialog,
  // a menu or a field is handling the key.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"]')) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) return;
      dispatch({ type: "toggleAppSettings", open: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch]);

  return (
    <main aria-label={t("Settings")} className="flex h-full min-w-0 flex-1 bg-stage">
      <SettingsNav section={section} query={query} onQuery={setQuery} />
      <div ref={scroller} className="min-w-0 flex-1 overflow-y-auto">
        <div className="w-full max-w-[1120px] px-7 pt-5 pb-10">
          <SectionBody section={section} />
        </div>
      </div>
    </main>
  );
}
