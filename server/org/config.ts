// The org config (DATA_DIR/org.json): the 主 Bot, department settings,
// project groups, the operating rules and the decision-rights table.
//
// Departments are sections (`bot.section`), so what is stored here is only
// what a section string cannot say — colour, headcount, budget line,
// isolation, apps. The whole config the app reads is the stored file merged
// with the live roster: every section a visible bot carries is a department,
// whether or not anyone has configured it yet.
//
// Two rules are not the owner's to switch off from the app either: external
// publishing always needs the owner, and a locked decision-rights row stays
// exactly as it was set.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { msg, t } from "../../shared/i18n.ts";
import {
  DEFAULT_ORG_RULES,
  DEPARTMENT_COLORS,
  type DecisionLevel,
  type DecisionRight,
  type OrgConfig,
  type OrgDepartment,
  type OrgProject,
  type OrgRules,
} from "../../shared/org-types.ts";
import { writeFileAtomic } from "../atomic.ts";
import { readJson, sectionOf, type OrgBot } from "./util.ts";

const FILE_NAME = "org.json";
const LEVELS: readonly DecisionLevel[] = ["employee", "lead", "chief", "owner"];

/** Design U6 (谁拍板). Labels are English sources the app translates. */
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

// ── validation ────────────────────────────────────────────────────────────────

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const ID = /^[\w-]{1,64}$/;
const level = z.enum(["employee", "lead", "chief", "owner"]);

const departmentSchema = z.object({
  section: z.string().trim().min(1).max(60),
  color: z.string().regex(HEX_COLOR).optional(),
  headcount: z.number().int().min(1).max(100).optional(),
  budgetPerDay: z.number().min(0).max(1_000_000).optional(),
  isolated: z.boolean().optional(),
  allowedApps: z.array(z.string().trim().min(1).max(80)).max(100).optional(),
  privateFolder: z.string().trim().max(200).optional(),
});

const projectSchema = z.object({
  id: z.string().regex(ID).optional(),
  name: z.string().trim().min(1).max(80),
  leadBotId: z.string().regex(ID).optional(),
  memberBotIds: z.array(z.string().regex(ID)).max(100).default([]),
  until: z.string().trim().max(40).optional(),
});

const rulesPatchSchema = z.object({
  spanOfControl: z.number().int().min(1).max(20).optional(),
  escalateAfterMin: z.number().int().min(1).max(1_440).optional(),
  chiefMay: z
    .object({ addPeople: z.boolean().optional(), newSpecialist: z.boolean().optional(), switchModel: z.boolean().optional() })
    .optional(),
  budgetPerDay: z.number().min(0).max(1_000_000).optional(),
  // accepted so a client can send the whole rules object back; always true
  externalPublishNeedsOwner: z.unknown().optional(),
  unattendedExpiryMin: z.number().int().min(1).max(1_440).optional(),
  reportCadence: z
    .object({
      everyHours: z.number().int().min(0).max(24).optional(),
      onDone: z.boolean().optional(),
      onIncident: z.boolean().optional(),
      dailyBriefAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    })
    .optional(),
});

const rightSchema = z.object({
  id: z.string().regex(ID),
  label: z.string().trim().min(1).max(160),
  decides: level,
  suggest: z.array(level).max(4).default([]),
  locked: z.boolean().optional(),
});

const patchSchema = z.object({
  chiefBotId: z.string().max(64).nullable().optional(),
  departments: z.array(z.unknown()).max(50).optional(),
  projects: z.array(z.unknown()).max(50).optional(),
  rules: rulesPatchSchema.optional(),
  decisionRights: z.array(z.unknown()).max(40).optional(),
});

/** What PATCH /api/org accepts: any subset of these fields. Arrays replace the
 * stored list; `rules` merges field by field. */
export type OrgPatch = z.input<typeof patchSchema>;

interface StoredOrg {
  version: 1;
  chiefBotId: string | null;
  departments: OrgDepartment[];
  projects: OrgProject[];
  rules: OrgRules;
  decisionRights: DecisionRight[];
  updatedAt: number;
}

export class OrgConfigError extends Error {
  readonly status = 400;
}

/** null-valued keys mean "clear it" in a patch; zod's optional() wants absent. */
function withoutNulls(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null));
}

function issue(error: z.ZodError, where: string): string {
  const first = error.issues[0];
  const path = first?.path.length ? `${where}.${first.path.join(".")}` : where;
  return `${path}: ${first?.message ?? "invalid"}`;
}

function parseDepartment(raw: unknown): OrgDepartment | null {
  const parsed = departmentSchema.safeParse(withoutNulls(raw));
  return parsed.success ? (parsed.data as OrgDepartment) : null;
}

function parseProject(raw: unknown): OrgProject | null {
  const parsed = projectSchema.safeParse(withoutNulls(raw));
  if (!parsed.success) return null;
  const { id, ...rest } = parsed.data;
  return { id: id ?? `project-${randomUUID().slice(0, 8)}`, ...rest };
}

/** Suggesters never include the decider, appear once, and keep chain order. */
function normalizeRight(right: z.output<typeof rightSchema>): DecisionRight {
  const suggest = LEVELS.filter((entry) => entry !== right.decides && right.suggest.includes(entry));
  return { id: right.id, label: right.label, decides: right.decides, suggest, ...(right.locked ? { locked: true } : {}) };
}

function mergeRules(base: OrgRules, patch: z.output<typeof rulesPatchSchema>): OrgRules {
  return {
    spanOfControl: patch.spanOfControl ?? base.spanOfControl,
    escalateAfterMin: patch.escalateAfterMin ?? base.escalateAfterMin,
    chiefMay: { ...base.chiefMay, ...stripUndefined(patch.chiefMay ?? {}) },
    budgetPerDay: patch.budgetPerDay ?? base.budgetPerDay,
    externalPublishNeedsOwner: true,
    unattendedExpiryMin: patch.unattendedExpiryMin ?? base.unattendedExpiryMin,
    reportCadence: { ...base.reportCadence, ...stripUndefined(patch.reportCadence ?? {}) },
  };
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

function defaultRules(): OrgRules {
  return {
    ...DEFAULT_ORG_RULES,
    chiefMay: { ...DEFAULT_ORG_RULES.chiefMay },
    reportCadence: { ...DEFAULT_ORG_RULES.reportCadence },
  };
}

function defaultRights(): DecisionRight[] {
  return DEFAULT_DECISION_RIGHTS.map((right) => ({ ...right, suggest: [...right.suggest] }));
}

/** Locked rows of `current` survive any edit: a patch can neither change nor
 * drop them. A dropped one goes back where it was. */
function keepLocked(current: DecisionRight[], next: DecisionRight[]): DecisionRight[] {
  const out = next.slice();
  current.forEach((locked, index) => {
    if (!locked.locked) return;
    const at = out.findIndex((right) => right.id === locked.id);
    if (at >= 0) out[at] = { ...locked, suggest: [...locked.suggest] };
    else out.splice(Math.min(index, out.length), 0, { ...locked, suggest: [...locked.suggest] });
  });
  return out;
}

function dedupe<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const id = key(item);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Stored rules field by field: one bad value falls back alone. */
function lenientRules(raw: unknown): z.output<typeof rulesPatchSchema> {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(rulesPatchSchema.shape)) {
    const result = (schema as z.ZodType).safeParse(value[key]);
    if (result.success && result.data !== undefined) out[key] = result.data;
  }
  return out as z.output<typeof rulesPatchSchema>;
}

/** Read whatever survives of a stored file; anything unreadable falls back to
 * its default rather than taking the whole config down with it. */
export function parseStoredOrg(raw: unknown): StoredOrg {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const departments = Array.isArray(value.departments)
    ? dedupe(value.departments.map(parseDepartment).filter((entry): entry is OrgDepartment => Boolean(entry)), (dep) => dep.section)
    : [];
  const projects = Array.isArray(value.projects)
    ? dedupe(value.projects.map(parseProject).filter((entry): entry is OrgProject => Boolean(entry)), (project) => project.id)
    : [];
  const rules = mergeRules(defaultRules(), lenientRules(value.rules));
  let decisionRights: DecisionRight[] = defaultRights();
  if (Array.isArray(value.decisionRights)) {
    const rows = value.decisionRights
      .map((row) => rightSchema.safeParse(row))
      .filter((row) => row.success)
      .map((row) => normalizeRight(row.data!));
    if (rows.length) decisionRights = dedupe(rows, (row) => row.id);
  }
  // the default locked rows exist in every config, however it was written
  decisionRights = keepLocked(defaultRights(), decisionRights);
  return {
    version: 1,
    chiefBotId: typeof value.chiefBotId === "string" && ID.test(value.chiefBotId) ? value.chiefBotId : null,
    departments,
    projects,
    rules,
    decisionRights,
    updatedAt: typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  };
}

/** Bots oldest first (the same order the app's stableOrder uses), so a new
 * section always lands after the ones already there. */
function oldestFirst<B extends OrgBot>(bots: readonly B[]): B[] {
  return bots
    .map((bot, index) => ({ bot, index }))
    .sort((a, b) => (a.bot.createdAt ?? 0) - (b.bot.createdAt ?? 0) || b.index - a.index)
    .map(({ bot }) => bot);
}

/** The 主 Bot: the configured one when it is still visible, else the
 * unsectioned chief of staff, else nobody. */
export function resolveChief(chiefBotId: string | null, bots: readonly OrgBot[]): OrgBot | undefined {
  const visible = bots.filter((bot) => !bot.hidden);
  if (chiefBotId) {
    const chosen = visible.find((bot) => bot.id === chiefBotId);
    if (chosen) return chosen;
  }
  return visible.find((bot) => bot.chiefOfStaff && !sectionOf(bot.section));
}

/** Stored departments in their stored order, then every other section a
 * visible bot carries in the order its oldest bot appeared. A colour nobody
 * set defaults to the palette by position (like the app's buildDepartments),
 * moving to the first free palette colour when a stored one already has it. */
export function mergeDepartments(stored: readonly OrgDepartment[], bots: readonly OrgBot[], chiefId?: string): OrgDepartment[] {
  const sections = stored.map((dep) => dep.section.trim());
  for (const bot of oldestFirst(bots.filter((entry) => !entry.hidden && entry.id !== chiefId))) {
    const section = sectionOf(bot.section);
    if (section && !sections.includes(section)) sections.push(section);
  }
  const used = new Set(stored.map((dep) => dep.color).filter(Boolean));
  return sections.map((section, index) => {
    const settings = stored.find((dep) => dep.section.trim() === section);
    let color = settings?.color;
    if (!color) {
      color = DEPARTMENT_COLORS[index % DEPARTMENT_COLORS.length]!;
      if (used.has(color)) color = DEPARTMENT_COLORS.find((candidate) => !used.has(candidate)) ?? color;
      used.add(color);
    }
    return { ...(settings ?? {}), section, color };
  });
}

export class OrgConfigStore {
  private readonly file: string;
  private cached: StoredOrg | null = null;

  constructor(dataDir: string) {
    this.file = join(dataDir, FILE_NAME);
  }

  private stored(): StoredOrg {
    this.cached ??= parseStoredOrg(readJson(this.file));
    return this.cached;
  }

  /** The rules as stored (defaults filled in). */
  rules(): OrgRules {
    return this.stored().rules;
  }

  /** The whole config the app reads, merged with the live roster. */
  get(bots: readonly OrgBot[]): OrgConfig {
    const stored = this.stored();
    const chief = resolveChief(stored.chiefBotId, bots);
    return {
      version: 1,
      chiefBotId: chief?.id ?? null,
      departments: mergeDepartments(stored.departments, bots, chief?.id),
      projects: stored.projects.map((project) => ({ ...project, memberBotIds: [...project.memberBotIds] })),
      rules: { ...stored.rules, chiefMay: { ...stored.rules.chiefMay }, reportCadence: { ...stored.rules.reportCadence } },
      decisionRights: stored.decisionRights.map((right) => ({ ...right, suggest: [...right.suggest] })),
      updatedAt: stored.updatedAt,
    };
  }

  /** Apply a partial update and return the whole config. Throws
   * OrgConfigError (status 400) when the patch is invalid. */
  patch(body: unknown, bots: readonly OrgBot[], now = Date.now()): OrgConfig {
    const parsed = patchSchema.safeParse(body ?? {});
    if (!parsed.success) throw new OrgConfigError(issue(parsed.error, "org"));
    const patch = parsed.data;
    const current = this.stored();
    const next: StoredOrg = { ...current, updatedAt: now };

    if (patch.chiefBotId !== undefined) {
      if (patch.chiefBotId !== null && !bots.some((bot) => bot.id === patch.chiefBotId && !bot.hidden)) {
        throw new OrgConfigError(t("No such bot"));
      }
      next.chiefBotId = patch.chiefBotId;
    }
    if (patch.departments) {
      const departments: OrgDepartment[] = [];
      for (const [index, raw] of patch.departments.entries()) {
        const result = departmentSchema.safeParse(withoutNulls(raw));
        if (!result.success) throw new OrgConfigError(issue(result.error, `departments.${index}`));
        departments.push(result.data as OrgDepartment);
      }
      // a department that was never given a colour keeps the one it is shown
      // with; a brand-new one takes the first palette colour nobody uses
      const shown = mergeDepartments(current.departments, bots, resolveChief(current.chiefBotId, bots)?.id);
      const unique = dedupe(departments, (dep) => dep.section);
      const used = new Set<string>([...unique.map((dep) => dep.color), ...shown.map((dep) => dep.color)].filter((color): color is string => Boolean(color)));
      next.departments = unique.map((dep) => {
        const color =
          dep.color ??
          shown.find((entry) => entry.section === dep.section)?.color ??
          DEPARTMENT_COLORS.find((candidate) => !used.has(candidate)) ??
          DEPARTMENT_COLORS[0];
        used.add(color);
        return { ...dep, color };
      });
    }
    if (patch.projects) {
      const projects: OrgProject[] = [];
      for (const [index, raw] of patch.projects.entries()) {
        const result = projectSchema.safeParse(withoutNulls(raw));
        if (!result.success) throw new OrgConfigError(issue(result.error, `projects.${index}`));
        const { id, ...rest } = result.data;
        projects.push({ id: id ?? `project-${randomUUID().slice(0, 8)}`, ...rest });
      }
      next.projects = dedupe(projects, (project) => project.id);
    }
    if (patch.rules) next.rules = mergeRules(current.rules, patch.rules);
    if (patch.decisionRights) {
      const rows: DecisionRight[] = [];
      for (const [index, raw] of patch.decisionRights.entries()) {
        const result = rightSchema.safeParse(raw);
        if (!result.success) throw new OrgConfigError(issue(result.error, `decisionRights.${index}`));
        rows.push(normalizeRight(result.data));
      }
      next.decisionRights = keepLocked(current.decisionRights, dedupe(rows, (row) => row.id));
    }

    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify(next, null, 2), { mode: 0o600 });
    this.cached = next;
    return this.get(bots);
  }
}
