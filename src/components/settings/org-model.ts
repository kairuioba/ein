// Pure helpers behind Settings › Organization: what each department card
// shows, the decision-rights matrix and its edits, and the department and
// project changes the editor saves. No React, no fetches — see OrgSection.
import {
  DEFAULT_ORG_RULES,
  DEPARTMENT_COLORS,
  type DecisionLevel,
  type DecisionRight,
  type OrgConfig,
  type OrgDepartment,
  type OrgProject,
  type OrgRules,
} from "../../../shared/org-types";
import { squads, type DepartmentView } from "@/lib/org";
import { msg } from "@/lib/i18n";

export const DECISION_LEVELS: readonly DecisionLevel[] = ["employee", "lead", "chief", "owner"];

export const DECISION_LEVEL_LABEL: Record<DecisionLevel, string> = {
  employee: msg("Staff"),
  lead: msg("Leads"),
  chief: msg("Chief"),
  owner: msg("Boss"),
};

/** The table the owner starts with (O3): who settles what. The same rows,
 * ids and English sources as the server's defaults (server/org/config.ts), so
 * the page reads the same before the org service answers; the matrix shows
 * the labels through t(). */
export const DEFAULT_DECISION_RIGHTS: readonly DecisionRight[] = [
  { id: "own-task", label: msg("How to do their own task"), decides: "employee", suggest: [] },
  { id: "department-work", label: msg("Splitting work inside a department, approving internal drafts"), decides: "lead", suggest: ["employee"] },
  { id: "department-requests", label: msg("Accepting requests from other departments"), decides: "lead", suggest: ["employee"] },
  { id: "cross-department", label: msg("Moving people across departments, calling coordination meetings, arbitration"), decides: "chief", suggest: ["employee", "lead"] },
  { id: "within-budget", label: msg("Spending within the budget line, adding people, creating specialists"), decides: "chief", suggest: ["employee", "lead"] },
  { id: "external-publish", label: msg("Publishing outside (posts, emails, going live)"), decides: "owner", suggest: ["employee", "lead", "chief"], locked: true },
  { id: "over-budget", label: msg("Going over budget, changing direction, creating departments"), decides: "owner", suggest: ["employee", "lead", "chief"] },
  { id: "isolated-data", label: msg("Seeing isolated departments' data"), decides: "owner", suggest: ["employee", "lead", "chief"] },
];

/** The org's own table, or the defaults while it has none. */
export function decisionRightsOf(org: Pick<OrgConfig, "decisionRights"> | null | undefined): DecisionRight[] {
  const own = org?.decisionRights ?? [];
  return (own.length ? own : DEFAULT_DECISION_RIGHTS).map((right) => ({ ...right, suggest: [...right.suggest] }));
}

/** Make `level` the one that decides a row; every level below it may suggest.
 * Locked rows (set by the owner) never change. */
export function setDecider(rights: readonly DecisionRight[], id: string, level: DecisionLevel): DecisionRight[] {
  const at = DECISION_LEVELS.indexOf(level);
  return rights.map((right) =>
    right.id !== id || right.locked ? right : { ...right, decides: level, suggest: DECISION_LEVELS.slice(0, at) as DecisionLevel[] },
  );
}

export type MatrixCell = "decides" | "suggests" | "none";

export function matrixCell(right: DecisionRight, level: DecisionLevel): MatrixCell {
  if (right.decides === level) return "decides";
  return right.suggest.includes(level) ? "suggests" : "none";
}

/** The org rules with every field present (older configs may lack some). */
export function rulesOf(org: Pick<OrgConfig, "rules"> | null | undefined): OrgRules {
  const rules = org?.rules;
  return {
    ...DEFAULT_ORG_RULES,
    ...rules,
    chiefMay: { ...DEFAULT_ORG_RULES.chiefMay, ...rules?.chiefMay },
    reportCadence: { ...DEFAULT_ORG_RULES.reportCadence, ...rules?.reportCadence },
    externalPublishNeedsOwner: true,
  };
}

// ── department cards ──────────────────────────────────────────────────────────
export interface SquadChip {
  /** index into squadName(): 0 = 组 A */
  index: number;
  size: number;
  /** a squad whose people all arrived in the last day */
  isNew: boolean;
}

export interface DepartmentCard<B> {
  section: string;
  color: string;
  lead?: B;
  members: B[];
  /** everyone in the section, lead included */
  count: number;
  headcount?: number;
  overHeadcount: boolean;
  /** empty when the department is not split into squads */
  squads: SquadChip[];
  privateFolder?: string;
  budgetPerDay?: number;
  isolated: boolean;
  /** undefined = every connected app */
  allowedApps?: string[];
}

const DAY = 24 * 60 * 60 * 1000;

type CardBot = { id: string; name: string; createdAt?: number };

export function departmentCard<B extends CardBot>(view: DepartmentView<B>, span: number, now = Date.now()): DepartmentCard<B> {
  const settings = view.settings;
  const count = view.members.length + (view.lead ? 1 : 0);
  const groups = squads(view.members, span);
  const chips: SquadChip[] =
    groups.length > 1
      ? groups.map((members, index) => ({
          index,
          size: members.length,
          isNew: index > 0 && members.length > 0 && members.every((bot) => (bot.createdAt ?? 0) > now - DAY),
        }))
      : [];
  return {
    section: view.section,
    color: view.color,
    lead: view.lead,
    members: view.members,
    count,
    headcount: settings?.headcount,
    overHeadcount: settings?.headcount !== undefined && count > settings.headcount,
    squads: chips,
    privateFolder: settings?.privateFolder,
    budgetPerDay: settings?.budgetPerDay,
    isolated: settings?.isolated === true,
    allowedApps: settings?.allowedApps,
  };
}

/** The department with the most people that needs squads, explained the way
 * the span-of-control rule reads it: "技术部 9 人：阿杰直接管 组 A 4 人 + 组 B 组长". */
export interface SpanExample {
  section: string;
  count: number;
  lead?: string;
  firstSquad: number;
  /** squad leaders the lead also manages directly (组 B, 组 C …) */
  otherSquads: number;
  direct: number;
}

export function spanExample<B extends { name: string }>(cards: ReadonlyArray<Pick<DepartmentCard<B>, "section" | "count" | "lead" | "members">>, span: number): SpanExample | null {
  let best: SpanExample | null = null;
  for (const card of cards) {
    const groups = squads(card.members, span);
    if (groups.length < 2) continue;
    const example: SpanExample = {
      section: card.section,
      count: card.count,
      lead: card.lead?.name,
      firstSquad: groups[0]!.length,
      otherSquads: groups.length - 1,
      direct: groups[0]!.length + groups.length - 1,
    };
    if (!best || example.count > best.count) best = example;
  }
  return best;
}

/** What the chief keeps for itself once every department's line is taken. */
export function chiefReserve(rules: Pick<OrgRules, "budgetPerDay">, departments: ReadonlyArray<Pick<OrgDepartment, "budgetPerDay">>): number {
  const assigned = departments.reduce((sum, dep) => sum + (dep.budgetPerDay ?? 0), 0);
  return Math.max(0, rules.budgetPerDay - assigned);
}

// ── edits the editor saves ────────────────────────────────────────────────────
/** The next unused palette colour for a new department. */
export function nextDepartmentColor(departments: ReadonlyArray<Pick<OrgDepartment, "color">>, sectionsInUse = 0): string {
  const used = new Set(departments.map((dep) => dep.color.toUpperCase()));
  return DEPARTMENT_COLORS.find((color) => !used.has(color.toUpperCase())) ?? DEPARTMENT_COLORS[(departments.length + sectionsInUse) % DEPARTMENT_COLORS.length]!;
}

/** Replace (or add) one department's settings, keyed by its section name. */
export function upsertDepartment(departments: readonly OrgDepartment[], next: OrgDepartment): OrgDepartment[] {
  const key = next.section.trim();
  const cleaned: OrgDepartment = { ...next, section: key };
  const at = departments.findIndex((dep) => dep.section.trim() === key);
  if (at < 0) return [...departments, cleaned];
  return departments.map((dep, index) => (index === at ? cleaned : dep));
}

/** A department renamed: its settings follow the new section name. */
export function renameDepartment(departments: readonly OrgDepartment[], from: string, to: string): OrgDepartment[] {
  const target = to.trim();
  return departments
    .filter((dep) => dep.section.trim() !== target || target === from.trim())
    .map((dep) => (dep.section.trim() === from.trim() ? { ...dep, section: target } : dep));
}

/** Bots whose section must change so `memberIds` are exactly the department's
 * people: chosen bots move in, unchosen current members move out (to no section). */
export function membershipPatches<B extends { id: string; section?: string }>(
  bots: readonly B[],
  section: string,
  memberIds: readonly string[],
): Array<{ botId: string; section: string | null }> {
  const key = section.trim();
  const chosen = new Set(memberIds);
  const patches: Array<{ botId: string; section: string | null }> = [];
  for (const bot of bots) {
    const inside = (bot.section?.trim() ?? "") === key;
    if (chosen.has(bot.id) && !inside) patches.push({ botId: bot.id, section: key });
    if (!chosen.has(bot.id) && inside) patches.push({ botId: bot.id, section: null });
  }
  return patches;
}

/** A new project group. Its id must pass the server's `[\w-]{1,64}` rule, so
 * it is built from the ASCII part of the name, or "project" for a name
 * written only in Chinese. */
export function newProject(input: { name: string; leadBotId?: string; memberBotIds: string[]; until?: string }, existing: readonly OrgProject[]): OrgProject {
  const base = input.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "project";
  let id = base;
  for (let n = 2; existing.some((project) => project.id === id); n += 1) id = `${base}-${n}`;
  return {
    id,
    name: input.name.trim(),
    leadBotId: input.leadBotId,
    memberBotIds: [...new Set(input.memberBotIds)],
    until: input.until || undefined,
  };
}

/** Which department a project reports to (its lead's section), for the dashed line. */
export function projectHomeSection<B extends { id: string; section?: string }>(project: Pick<OrgProject, "leadBotId">, bots: readonly B[]): string | undefined {
  const lead = bots.find((bot) => bot.id === project.leadBotId);
  return lead?.section?.trim() || undefined;
}
