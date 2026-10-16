// Settings › Organization (U6): who manages whom, who sees what, who decides.
// Departments are sidebar sections and their leads are the sections' chiefs
// of staff (saved on the bots themselves); colours, headcount, budgets,
// isolation, projects, rules and decision rights live in the org config
// (/api/org, saved through saveOrg).
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { ChartColumn, Clock, Folder, Lock, Plus, TriangleAlert, Users } from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { saveOrg, useOrg } from "@/state/org-api";
import { buildDepartments, chiefBot, squadName, unassignedBots } from "@/lib/org";
import { mascotForBot } from "@/lib/engine-mascots";
import { BotTile } from "@/components/mascot/Mascot";
import { BotAvatar } from "@/components/Avatar";
import { Button, Panel } from "@/components/ui";
import { cn } from "@/lib/cn";
import { intlLocale, t } from "@/lib/i18n";
import type { DecisionLevel, OrgConfig, OrgProject } from "../../../shared/org-types";
import {
  DECISION_LEVELS,
  DECISION_LEVEL_LABEL,
  decisionRightsOf,
  departmentCard,
  matrixCell,
  rulesOf,
  setDecider,
  spanExample,
  type DepartmentCard,
} from "./org-model";
import { Checkbox, NumberField, SaveStatus, SectionHeader, Stepper, useSaveState } from "./parts";
import { ChiefPickerDialog, DepartmentDialog, ProjectDialog } from "./OrgDialogs";
import { useAppCatalog } from "./app-catalog";

type OrgPatch = Partial<Omit<OrgConfig, "version" | "updatedAt">>;

/** A failed org save, said plainly: a missing route means A1's service is not there yet. */
export function orgSaveError(cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/^(404|405|501|502|503)$/.test(message.trim()) || /^no route\b/i.test(message.trim())) return new Error(t("the organization service isn't available yet"));
  return cause instanceof Error ? cause : new Error(message);
}

/** The org as the page shows it: the server's copy with this page's unsaved edits on top. */
export function useOrgEditor() {
  const { data: org, loaded, error } = useOrg();
  const save = useSaveState();
  const [overlay, setOverlay] = useState<OrgPatch>({});
  // tolerate a partial body from the server: every list is present, rules complete
  const merged = { ...org, ...overlay } as Partial<OrgConfig>;
  const view: OrgConfig = {
    version: 1,
    chiefBotId: merged.chiefBotId ?? null,
    departments: merged.departments ?? [],
    projects: merged.projects ?? [],
    rules: rulesOf(merged as Pick<OrgConfig, "rules">),
    decisionRights: merged.decisionRights ?? [],
    updatedAt: merged.updatedAt ?? 0,
  };
  const apply = (patch: OrgPatch) => {
    setOverlay((current) => ({ ...current, ...patch }));
    const drop = () =>
      setOverlay((current) => {
        const next = { ...current };
        for (const key of Object.keys(patch) as Array<keyof OrgPatch>) if (next[key] === patch[key]) delete next[key];
        return next;
      });
    return save.run(async () => {
      try {
        const saved = await saveOrg(patch);
        drop();
        return saved;
      } catch (cause) {
        drop();
        throw orgSaveError(cause);
      }
    });
  };
  return { org: view, loaded, unavailable: loaded && error !== null, save, apply };
}

const LINE = "border-ink-secondary/45";

export function OrgSection() {
  const { state } = useStore();
  const { org, unavailable, save, apply } = useOrgEditor();
  const rules = rulesOf(org);
  const chief = chiefBot(state.bots, org);
  const departments = useMemo(() => buildDepartments(state.bots, org), [state.bots, org]);
  const cards = useMemo(() => departments.map((dep) => departmentCard(dep, rules.spanOfControl)), [departments, rules.spanOfControl]);
  const loose = unassignedBots(state.bots, org);
  const { labelOf } = useAppCatalog();
  const [dialog, setDialog] = useState<
    | { kind: "new-department" }
    | { kind: "department"; section: string }
    | { kind: "new-project" }
    | { kind: "project"; id: string }
    | { kind: "chief" }
    | null
  >(null);

  const leads = cards.filter((card) => card.lead).length;
  const example = spanExample(cards, rules.spanOfControl);
  const saveRules = (patch: Partial<typeof rules>) => void apply({ rules: { ...rules, ...patch } });

  return (
    <div className="@container">
      <SectionHeader
        title={t("Organization")}
        description={t("Who manages whom, who can see what, who decides. The Chief hands out work by this; changes apply to newly assigned work.")}
        right={<SaveStatus state={save.state} />}
      />
      {unavailable && (
        <div role="status" className="mb-3 flex items-start gap-2 rounded-xl bg-warning/10 px-3 py-2 text-[12.5px] leading-relaxed text-warning">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" />
          <span>
            {t("The organization service isn't available yet, so colours, headcount, budgets, projects, rules and decision rights can't be saved. Department members and leads are saved on the bots and work as usual.")}
          </span>
        </div>
      )}

      <Panel aria-label={t("Org chart")} className="px-5 pt-3.5 pb-5">
        <div className="flex min-h-[30px] flex-wrap items-center gap-x-4 gap-y-1">
          <b className="mr-0.5 text-[15px] font-bold text-ink">{t("Org chart")}</b>
          <span className="inline-flex items-center gap-1.5 text-[12px] whitespace-nowrap text-ink-secondary">
            <i className={cn("w-5 border-t-[1.6px]", LINE)} />
            {t("Reporting line")}
          </span>
          <span className="inline-flex items-center gap-1.5 text-[12px] whitespace-nowrap text-ink-secondary">
            <i className="w-5 border-t-[1.6px] border-dashed border-[#8B5CF6]" />
            {t("Project group (dotted line)")}
          </span>
          <span className="inline-flex items-center gap-1.5 text-[12px] whitespace-nowrap text-ink-secondary">
            <i className="h-3 w-4 rounded-[3px] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_80%,transparent)]" style={HATCH} />
            {t("Isolated: others can only ask, and get redacted results")}
          </span>
          <span className="flex-1" />
          <span className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setDialog({ kind: "new-project" })}>
              <Plus size={13} />
              {t("Project group")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setDialog({ kind: "new-department" })}>
              <Plus size={13} />
              {t("New department")}
            </Button>
          </span>
        </div>

        <div className="mt-3 overflow-x-auto pb-1">
          <div className="w-full min-w-fit px-1 pt-1">
            <div className="grid grid-cols-[1fr_auto_1fr] items-center">
              <div className="flex items-center justify-end">
                <div className="flex h-10 items-center gap-2 rounded-xl bg-raised pr-3 pl-2 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_75%,transparent),0_1px_2px_rgb(16_24_40/0.05)]">
                  <span className="grid size-6 place-items-center rounded-full bg-select/12 text-[11px] font-bold text-accent-text">{t("You")}</span>
                  <span className="flex flex-col leading-[1.3] whitespace-nowrap">
                    <b className="text-[14px] text-ink">{t("You")}</b>
                    <span className="text-[11.5px] text-ink-secondary">{t("Boss")}</span>
                  </span>
                </div>
                <span className="relative mx-1.5 flex w-[58px] flex-col items-center text-ink" aria-hidden>
                  <span className="mb-0.5 text-[11px] whitespace-nowrap text-ink-secondary">{t("Sets goals")}</span>
                  <svg width="58" height="12" viewBox="0 0 58 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2 6H55" />
                    <path d="M50 1.5L55 6L50 10.5" />
                  </svg>
                </span>
              </div>
              <ChiefNode chief={chief} leads={leads} direct={loose.length} budget={rules.budgetPerDay} onPick={() => setDialog({ kind: "chief" })} />
              <div />
            </div>

            {cards.length > 0 ? (
              <>
                <div className={cn("mx-auto h-[14px] w-0 border-l-[1.6px]", LINE)} />
                <DepartmentGrid
                  cards={cards}
                  projects={org.projects ?? []}
                  bots={state.bots}
                  labelOf={labelOf}
                  onOpenDepartment={(section) => setDialog({ kind: "department", section })}
                  onOpenProject={(id) => setDialog({ kind: "project", id })}
                />
              </>
            ) : (
              <div className="mt-5 flex flex-col items-center gap-2 rounded-xl border border-dashed border-hairline/70 px-6 py-7 text-center">
                <div className="text-[13.5px] font-semibold text-ink">{t("No departments yet")}</div>
                <div className="max-w-[46ch] text-[12.5px] leading-relaxed text-ink-secondary">
                  {t("Put a few bots in the same sidebar section and that section is a department, with its lead as the section's chief.")}
                </div>
                <Button variant="ghost" size="sm" className="mt-1" onClick={() => setDialog({ kind: "new-department" })}>
                  <Plus size={13} />
                  {t("New department")}
                </Button>
              </div>
            )}
          </div>
        </div>
      </Panel>

      <div className="mt-3.5 grid grid-cols-1 gap-3.5 @min-[820px]:grid-cols-[1.13fr_1fr]">
        <RulesCard rules={rules} example={example} onChange={saveRules} />
        <DecisionMatrix org={org} onChange={(decisionRights) => void apply({ decisionRights })} />
      </div>

      {dialog?.kind === "new-department" && <DepartmentDialog mode="new" org={org} cards={cards} onApply={apply} onClose={() => setDialog(null)} />}
      {dialog?.kind === "department" && (
        <DepartmentDialog mode="edit" section={dialog.section} org={org} cards={cards} onApply={apply} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "new-project" && <ProjectDialog org={org} onApply={apply} onClose={() => setDialog(null)} />}
      {dialog?.kind === "project" && <ProjectDialog org={org} projectId={dialog.id} onApply={apply} onClose={() => setDialog(null)} />}
      {dialog?.kind === "chief" && <ChiefPickerDialog org={org} onApply={apply} onClose={() => setDialog(null)} />}
    </div>
  );
}

const HATCH: CSSProperties = {
  background:
    "repeating-linear-gradient(135deg, var(--color-raised) 0 3px, color-mix(in oklab, var(--color-ink) 9%, var(--color-raised)) 3px 6px)",
};
const CARD_HATCH: CSSProperties = {
  background:
    "repeating-linear-gradient(135deg, var(--color-raised) 0 7px, color-mix(in oklab, var(--color-ink) 5%, var(--color-raised)) 7px 14px)",
};

function ChiefNode({ chief, leads, direct, budget, onPick }: { chief?: Bot; leads: number; direct: number; budget: number; onPick: () => void }) {
  const { state } = useStore();
  return (
    <button
      type="button"
      onClick={onPick}
      title={t("Choose the main bot")}
      className="flex h-[50px] items-center gap-2.5 rounded-[14px] bg-primary pr-3.5 pl-2.5 text-left text-primary-ink shadow-[0_14px_30px_-16px_rgb(16_24_40/0.6)] hover:brightness-110"
    >
      {chief ? <BotTile kind={mascotForBot(chief, state.instances)} size={24} chief /> : <span className="grid size-6 place-items-center rounded-md bg-primary-ink/15 text-[12px]">?</span>}
      <span className="flex flex-col leading-[1.3] whitespace-nowrap">
        <b className="text-[14px]">{chief?.name ?? t("No main bot yet")}</b>
        <span className="text-[11.5px] opacity-65">
          {chief
            ? `${
                direct
                  ? t("Manages {leads} leads and {direct} bots directly", { leads, direct })
                  : t("Manages {count} leads directly", { count: leads })
              } · ${t("Budget line ¥{amount}/day", { amount: budget })}`
            : t("Pick the bot you talk to first")}
        </span>
      </span>
    </button>
  );
}

function DepartmentGrid({
  cards,
  projects,
  bots,
  labelOf,
  onOpenDepartment,
  onOpenProject,
}: {
  cards: DepartmentCard<Bot>[];
  projects: OrgProject[];
  bots: Bot[];
  labelOf: (slug: string) => string;
  onOpenDepartment: (section: string) => void;
  onOpenProject: (id: string) => void;
}) {
  const n = cards.length;
  const columnOf = (section: string | undefined) => (section ? cards.findIndex((card) => card.section === section.trim()) : -1);
  return (
    <div className="grid gap-x-3" style={{ gridTemplateColumns: `repeat(${n}, minmax(152px, 1fr))` }}>
      {cards.map((card, index) => (
        <div key={card.section} className="relative pt-4" style={{ gridColumn: index + 1, gridRow: 1 }}>
          <Connector first={index === 0} last={index === n - 1} />
          <DepartmentCardView card={card} labelOf={labelOf} onOpen={() => onOpenDepartment(card.section)} />
        </div>
      ))}
      {projects.map((project, row) => {
        const lead = bots.find((bot) => bot.id === project.leadBotId);
        const members = project.memberBotIds.map((id) => bots.find((bot) => bot.id === id)).filter((bot): bot is Bot => Boolean(bot));
        const home = columnOf(lead?.section);
        const columns = [home, ...members.map((bot) => columnOf(bot.section))].filter((column) => column >= 0);
        const lo = columns.length ? Math.min(...columns) : 0;
        const hi = columns.length ? Math.max(...columns) : n - 1;
        return (
          <ProjectRow
            key={project.id}
            project={project}
            lead={lead}
            members={members}
            row={row + 2}
            from={lo}
            to={hi}
            home={home}
            onOpen={() => onOpenProject(project.id)}
          />
        );
      })}
    </div>
  );
}

function Connector({ first, last }: { first: boolean; last: boolean }) {
  if (first && last) return <span aria-hidden className={cn("absolute top-0 left-1/2 h-4 border-l-[1.6px]", LINE)} />;
  if (first) return <span aria-hidden className={cn("absolute top-0 -right-1.5 left-1/2 h-4 rounded-tl-[9px] border-t-[1.6px] border-l-[1.6px]", LINE)} />;
  if (last) return <span aria-hidden className={cn("absolute top-0 right-1/2 -left-1.5 h-4 rounded-tr-[9px] border-t-[1.6px] border-r-[1.6px]", LINE)} />;
  return (
    <>
      <span aria-hidden className={cn("absolute top-0 -right-1.5 -left-1.5 border-t-[1.6px]", LINE)} />
      <span aria-hidden className={cn("absolute top-0 left-1/2 h-4 border-l-[1.6px]", LINE)} />
    </>
  );
}

const SQUAD_TONES = [
  "bg-warning/12 text-warning",
  "bg-[#8B5CF6]/12 text-[#7C4DEB]",
  "bg-[#14B8A6]/12 text-[#0F8A7E]",
  "bg-select/12 text-accent-text",
  "bg-danger/10 text-danger",
];

function Kv({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div className="flex h-6 items-center justify-between gap-1.5 text-[12px] whitespace-nowrap">
      <span className="text-[11.5px] text-ink-secondary">{label}</span>
      {children}
    </div>
  );
}

function DepartmentCardView({ card, labelOf, onOpen }: { card: DepartmentCard<Bot>; labelOf: (slug: string) => string; onOpen: () => void }) {
  const { state } = useStore();
  const face = card.lead ?? card.members[0];
  const apps = card.allowedApps;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t("Edit {name}", { name: card.section })}
      className={cn(
        "relative flex h-full w-full flex-col rounded-[14px] px-3 pt-3 text-left transition-shadow",
        card.isolated
          ? "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_85%,transparent)] hover:shadow-[inset_0_0_0_1px_var(--color-hairline),0_6px_16px_-10px_rgb(16_24_40/0.35)]"
          : "bg-raised shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent),0_1px_2px_rgb(16_24_40/0.05),0_12px_28px_-16px_rgb(16_24_40/0.22)] hover:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_90%,transparent),0_12px_28px_-14px_rgb(16_24_40/0.3)]",
      )}
      style={card.isolated ? CARD_HATCH : undefined}
    >
      <span aria-hidden className="absolute top-0 right-3.5 left-3.5 h-[3px] rounded-b-[3px]" style={{ background: card.color }} />
      {card.isolated && (
        <span className="absolute -top-2.5 right-2.5 inline-flex h-5 items-center gap-[3px] rounded-full bg-[#475467] px-[7px] text-[11px] font-bold whitespace-nowrap text-white">
          <Lock size={11} />
          {t("Isolated")}
        </span>
      )}
      <div className="mb-[5px] box-content flex h-[34px] items-center gap-[7px] border-b border-hairline/30 pb-[9px]">
        {face ? <BotTile kind={mascotForBot(face, state.instances)} size={22} /> : <span className="size-[22px] rounded-md bg-control" />}
        <span className="flex min-w-0 flex-col leading-[1.3]">
          <b className="truncate text-[13.5px] font-bold text-ink">{card.section}</b>
          <span className={cn("truncate text-[11.5px]", card.lead ? "text-ink-secondary" : "text-warning")}>{card.lead?.name ?? t("No lead yet")}</span>
        </span>
      </div>
      <Kv label={t("Headcount")}>
        <b className={cn("font-semibold tabular-nums", card.overHeadcount ? "text-danger" : "text-ink")}>
          {card.count} / {card.headcount ?? t("no limit")}
        </b>
      </Kv>
      <Kv label={t("Squads")}>
        {card.squads.length ? (
          <span className="flex items-center gap-1">
            {card.squads.map((squad) => (
              <span key={squad.index} className={cn("inline-flex h-5 items-center gap-[3px] rounded-md px-1.5 text-[11.5px] font-semibold", SQUAD_TONES[squad.index % SQUAD_TONES.length])}>
                {squadName(squad.index)} {squad.size}
                {squad.isNew && <i className="rounded-[4px] bg-[#6D3FE0] px-1 text-[10px] leading-[15px] font-semibold not-italic text-white">{t("Just added")}</i>}
              </span>
            ))}
          </span>
        ) : (
          <em className="text-[12px] not-italic text-ink-secondary">{t("Not split")}</em>
        )}
      </Kv>
      <Kv label={t("Private files")}>
        {card.privateFolder ? (
          <b className="inline-flex min-w-0 items-center gap-1 font-semibold text-ink">
            {card.isolated ? <Lock size={12} className="shrink-0 text-ink-secondary" /> : <Folder size={12} className="shrink-0 text-ink-secondary" />}
            <span className="truncate">{card.privateFolder}</span>
          </b>
        ) : (
          <em className="text-[12px] not-italic text-ink-secondary">—</em>
        )}
      </Kv>
      <Kv label={t("Budget line")}>
        {card.budgetPerDay !== undefined ? (
          <b className="font-semibold tabular-nums text-ink">{t("¥{amount} / day", { amount: card.budgetPerDay })}</b>
        ) : (
          <em className="text-[12px] not-italic text-ink-secondary">{t("Not set")}</em>
        )}
      </Kv>
      <Kv label={t("Allowed apps")} />
      <div className="mt-px mb-3 flex flex-wrap gap-1">
        {apps === undefined ? (
          <AppChip isolated={card.isolated}>{t("All connected apps")}</AppChip>
        ) : apps.length === 0 ? (
          <AppChip isolated={card.isolated} muted>
            {t("No apps")}
          </AppChip>
        ) : (
          apps.map((slug) => (
            <AppChip key={slug} isolated={card.isolated}>
              {labelOf(slug)}
            </AppChip>
          ))
        )}
      </div>
    </button>
  );
}

function AppChip({ children, isolated, muted }: { children: ReactNode; isolated?: boolean; muted?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-md px-1.5 text-[11.5px] whitespace-nowrap",
        muted ? "text-ink-secondary/70" : "text-ink-secondary",
        isolated ? "bg-raised shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent)]" : "bg-control/70",
      )}
    >
      {children}
    </span>
  );
}

function untilLabel(until: string | undefined): string | null {
  if (!until) return null;
  const date = new Date(`${until}T23:59:59`);
  if (Number.isNaN(date.getTime())) return null;
  const days = (date.getTime() - Date.now()) / 86_400_000;
  if (days < 0) return t("Ended");
  const when =
    days < 7
      ? new Intl.DateTimeFormat(intlLocale(), { weekday: "short" }).format(date)
      : new Intl.DateTimeFormat(intlLocale(), { month: "short", day: "numeric" }).format(date);
  return t("Dissolves after {when}", { when });
}

function ProjectRow({
  project,
  lead,
  members,
  row,
  from,
  to,
  home,
  onOpen,
}: {
  project: OrgProject;
  lead?: Bot;
  members: Bot[];
  row: number;
  from: number;
  to: number;
  home: number;
  onOpen: () => void;
}) {
  const until = untilLabel(project.until);
  return (
    <>
      {home >= 0 && (
        <div aria-hidden className="relative h-5 self-start" style={{ gridColumn: home + 1, gridRow: row }}>
          <span className="absolute top-0 left-1/2 h-full border-l-[1.6px] border-dashed border-[#8B5CF6]" />
        </div>
      )}
      <div className="mt-5" style={{ gridColumn: `${from + 1} / ${to + 2}`, gridRow: row }}>
        <button
          type="button"
          onClick={onOpen}
          className="flex h-10 w-full min-w-0 items-center gap-2 rounded-xl border-[1.5px] border-dashed border-[#8B5CF6]/55 bg-[#8B5CF6]/[0.04] pr-3.5 pl-2.5 text-left text-[13px] whitespace-nowrap hover:bg-[#8B5CF6]/[0.08]"
        >
          <span className="inline-flex h-[22px] shrink-0 items-center gap-1 rounded-md bg-[#8B5CF6]/12 px-[7px] text-[11.5px] font-bold text-[#7C4DEB]">
            <Users size={12} />
            {t("Project group")}
          </span>
          <b className="shrink-0 font-bold text-ink">{project.name}</b>
          {lead && <span className="-ml-1 min-w-0 truncate font-medium text-[#7C4DEB]">· {t("dotted line to {name}", { name: lead.name })}</span>}
          <span className="ml-2 inline-flex shrink-0 items-center gap-px">
            {members.slice(0, 5).map((bot) => (
              <BotAvatar key={bot.id} bot={bot} size={16} />
            ))}
            <span className="ml-[5px] text-[12px] text-ink-secondary">{t("{count} people", { count: members.length })}</span>
          </span>
          {until && <span className="ml-auto shrink-0 pl-2 text-[12px] text-ink-secondary">{until}</span>}
        </button>
      </div>
    </>
  );
}

function RuleRow({ icon, locked, main, sub }: { icon: ReactNode; locked?: boolean; main: ReactNode; sub: ReactNode }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2.5",
        locked
          ? "mx-[-10px] mt-1 rounded-[10px] bg-inset px-2.5 py-[9px] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_30%,transparent)]"
          : "border-t border-hairline/30 py-[9px]",
      )}
    >
      <span
        className={cn(
          "grid size-7 shrink-0 place-items-center rounded-lg",
          locked ? "bg-raised text-ink shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent)]" : "bg-control/70 text-ink-secondary",
        )}
      >
        {icon}
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-h-7 flex-wrap items-center gap-x-1.5 gap-y-1 text-[13.5px] text-ink">{main}</div>
        <div className="text-[12px] text-ink-secondary">{sub}</div>
      </div>
    </div>
  );
}

function RulesCard({
  rules,
  example,
  onChange,
}: {
  rules: ReturnType<typeof rulesOf>;
  example: ReturnType<typeof spanExample>;
  onChange: (patch: Partial<ReturnType<typeof rulesOf>>) => void;
}) {
  const may = rules.chiefMay;
  return (
    <Panel aria-label={t("Rules")} className="px-[18px] pt-3.5 pb-3">
      <div className="mb-1.5 flex h-[30px] items-center gap-2.5 whitespace-nowrap">
        <b className="text-[15px] font-bold text-ink">{t("Rules")}</b>
        <span className="truncate text-[12px] text-ink-secondary">{t("The Chief handles these itself, without asking you each time")}</span>
      </div>
      <RuleRow
        icon={<Users size={15} />}
        main={
          <>
            {t("A lead manages at most")}
            <Stepper label={t("Span of control")} value={rules.spanOfControl} min={2} max={12} onChange={(spanOfControl) => onChange({ spanOfControl })} />
            {t("bots directly; more are grouped automatically")}
          </>
        }
        sub={
          example
            ? example.otherSquads === 1
              ? t("{section} has {count}: {lead} manages squad A's {first} plus squad B's lead — {direct} in all", {
                  section: example.section,
                  count: example.count,
                  lead: example.lead ?? t("the lead"),
                  first: example.firstSquad,
                  direct: example.direct,
                })
              : t("{section} has {count}: {lead} manages squad A's {first} plus {others} squad leads — {direct} in all", {
                  section: example.section,
                  count: example.count,
                  lead: example.lead ?? t("the lead"),
                  first: example.firstSquad,
                  others: example.otherSquads,
                  direct: example.direct,
                })
            : t("No department is that big yet, so nobody is grouped")
        }
      />
      <RuleRow
        icon={<Clock size={15} />}
        main={
          <>
            {t("Escalate when stuck for")}
            <NumberField label={t("Minutes before escalating")} value={rules.escalateAfterMin} min={1} max={240} onCommit={(value) => value !== null && onChange({ escalateAfterMin: value })} />
            {t("minutes per level")}
          </>
        }
        sub={t("Staff → lead → Chief → you; each level that can solve it keeps it")}
      />
      <RuleRow
        icon={<ChartColumn size={15} />}
        main={
          <>
            {t("Within the budget line the Chief may:")}
            <Checkbox className="ml-1" checked={rules.chiefMay.addPeople} onChange={(addPeople) => onChange({ chiefMay: { ...may, addPeople } })}>
              {t("Add people")}
            </Checkbox>
            <Checkbox className="ml-1" checked={rules.chiefMay.newSpecialist} onChange={(newSpecialist) => onChange({ chiefMay: { ...may, newSpecialist } })}>
              {t("New specialists")}
            </Checkbox>
            <Checkbox className="ml-1" checked={rules.chiefMay.switchModel} onChange={(switchModel) => onChange({ chiefMay: { ...may, switchModel } })}>
              {t("Switch models")}
            </Checkbox>
          </>
        }
        sub={
          // the dispatcher adds people mid-run on its own only with this box on,
          // when its diagnosis says more people help and it stays in budget
          rules.chiefMay.addPeople
            ? t("A slow job that more people would help gets them from the Chief within the line, and you hear after; over the line it asks first")
            : t("It tells you when it's done; anything over the budget line asks you first")
        }
      />
      <RuleRow
        locked
        icon={<Lock size={15} />}
        main={
          <>
            <b className="font-bold">{t("Publishing outside always needs you")}</b>
            <span className="ml-1.5 inline-flex h-[22px] items-center gap-1 rounded-[7px] bg-raised px-2 text-[12px] font-medium text-ink-secondary shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent)]">
              <Lock size={11} />
              {t("Set by you; bots can't change it")}
            </span>
          </>
        }
        sub={t("Posts, emails and going live all count; unattended, nobody approving within {minutes} minutes voids it and it never runs", { minutes: rules.unattendedExpiryMin })}
      />
    </Panel>
  );
}

function DecisionMatrix({ org, onChange }: { org: OrgConfig; onChange: (rights: ReturnType<typeof decisionRightsOf>) => void }) {
  const rights = decisionRightsOf(org);
  const pick = (id: string, level: DecisionLevel) => onChange(setDecider(rights, id, level));
  return (
    <Panel aria-label={t("Who decides")} className="px-[18px] pt-3.5 pb-3">
      <div className="mb-1.5 flex h-[30px] items-center gap-2.5 whitespace-nowrap">
        <b className="text-[15px] font-bold text-ink">{t("Who decides")}</b>
        <span className="inline-flex items-center gap-[5px] text-[12px] text-ink-secondary">
          <i className="size-2.5 rounded-full bg-select" />
          {t("Decides")}
          <i className="ml-2 size-2.5 rounded-full shadow-[inset_0_0_0_1.5px_color-mix(in_oklab,var(--color-ink-secondary)_60%,transparent)]" />
          {t("May suggest")}
        </span>
        <span className="ml-auto text-[12px] text-ink-secondary/70">{t("Click a dot to change it")}</span>
      </div>
      <div role="table" aria-label={t("Who decides")} className="text-[12.5px]">
        <div role="row" className="grid h-[26px] grid-cols-[1fr_repeat(4,42px)] items-center text-[12px] font-semibold text-ink-secondary">
          <span role="columnheader" />
          {DECISION_LEVELS.map((level) => (
            <span key={level} role="columnheader" className="text-center">
              {t(DECISION_LEVEL_LABEL[level])}
            </span>
          ))}
        </div>
        {rights.map((right) => (
          <div
            key={right.id}
            role="row"
            className={cn(
              "grid h-[29px] grid-cols-[1fr_repeat(4,42px)] items-center",
              right.locked ? "mx-[-8px] rounded-lg bg-inset px-2" : "border-t border-hairline/30",
            )}
          >
            <span role="cell" className="truncate text-ink" title={t(right.label)}>
              {t(right.label)}
            </span>
            {DECISION_LEVELS.map((level) => {
              const cell = matrixCell(right, level);
              const label = `${t(right.label)} · ${t(DECISION_LEVEL_LABEL[level])}`;
              return (
                <span key={level} role="cell" className="flex items-center justify-center gap-[3px]">
                  <button
                    type="button"
                    disabled={right.locked}
                    aria-pressed={cell === "decides"}
                    aria-label={label}
                    title={right.locked ? t("Set by you; bots can't change it") : t("{level} decides", { level: t(DECISION_LEVEL_LABEL[level]) })}
                    onClick={() => pick(right.id, level)}
                    className="grid size-6 place-items-center rounded-full enabled:hover:bg-control disabled:cursor-default"
                  >
                    {cell === "decides" ? (
                      <i className="size-2.5 rounded-full bg-select" />
                    ) : cell === "suggests" ? (
                      <i className="size-2.5 rounded-full shadow-[inset_0_0_0_1.5px_color-mix(in_oklab,var(--color-ink-secondary)_60%,transparent)]" />
                    ) : (
                      <i className="size-1 rounded-full bg-transparent" />
                    )}
                  </button>
                  {right.locked && level === "owner" && <Lock size={11} className="-ml-1.5 text-ink-secondary" />}
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </Panel>
  );
}
