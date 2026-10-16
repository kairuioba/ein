// Pure helpers that turn bots + the org config into the company view the UI
// draws: departments (sections) with a lead and members, and the 主 Bot.
import { DEPARTMENT_COLORS, type OrgConfig, type OrgDepartment } from "../../shared/org-types";
import { t } from "@/lib/i18n";

type BotShape = {
  id: string;
  name: string;
  section?: string;
  chiefOfStaff?: boolean;
  hidden?: boolean;
  createdAt?: number;
};

export interface DepartmentView<B extends BotShape = BotShape> {
  section: string;
  color: string;
  lead?: B;
  /** everyone in the section except the lead, in a stable order */
  members: B[];
  settings?: OrgDepartment;
}

const key = (section: string | undefined) => section?.trim() ?? "";

/** The bot the owner talks to first: the org's chief if set and present,
 * else an unsectioned chief of staff, else any chief of staff. */
export function chiefBot<B extends BotShape>(bots: readonly B[], org: Pick<OrgConfig, "chiefBotId"> | null | undefined): B | undefined {
  const visible = bots.filter((b) => !b.hidden);
  if (org?.chiefBotId) {
    const chosen = visible.find((b) => b.id === org.chiefBotId);
    if (chosen) return chosen;
  }
  return visible.find((b) => b.chiefOfStaff && !key(b.section)) ?? visible.find((b) => b.chiefOfStaff);
}

/** Stable order for people inside a room: oldest first, so a new bot never
 * shifts the ones already standing there. */
export function stableOrder<B extends BotShape>(bots: readonly B[]): B[] {
  return bots
    .map((bot, index) => ({ bot, index }))
    .sort((a, b) => (a.bot.createdAt ?? 0) - (b.bot.createdAt ?? 0) || b.index - a.index)
    .map(({ bot }) => bot);
}

/** Departments in the order the org lists them, then any other sections in
 * the order their oldest bot appeared. The chief is left out of every room. */
export function buildDepartments<B extends BotShape>(bots: readonly B[], org: OrgConfig | null | undefined): DepartmentView<B>[] {
  const chief = chiefBot(bots, org ?? null);
  const visible = stableOrder(bots.filter((b) => !b.hidden && b.id !== chief?.id));
  const sections: string[] = [];
  for (const dep of org?.departments ?? []) if (dep.section.trim() && !sections.includes(dep.section.trim())) sections.push(dep.section.trim());
  for (const bot of visible) {
    const s = key(bot.section);
    if (s && !sections.includes(s)) sections.push(s);
  }
  return sections.map((section, index) => {
    const settings = org?.departments.find((d) => d.section.trim() === section);
    const people = visible.filter((b) => key(b.section) === section);
    const lead = people.find((b) => b.chiefOfStaff);
    return {
      section,
      color: settings?.color ?? DEPARTMENT_COLORS[index % DEPARTMENT_COLORS.length],
      lead,
      members: people.filter((b) => b !== lead),
      settings,
    };
  });
}

/** Bots outside every department (no section), chief excluded. */
export function unassignedBots<B extends BotShape>(bots: readonly B[], org: OrgConfig | null | undefined): B[] {
  const chief = chiefBot(bots, org ?? null);
  return stableOrder(bots.filter((b) => !b.hidden && b.id !== chief?.id && !key(b.section)));
}

/** Split a lead's reports into squads of at most `span` (组 A, 组 B …), keeping
 * the oldest in the first squad so positions never move when people are added. */
export function squads<B>(members: readonly B[], span: number): B[][] {
  const size = Math.max(1, span - 1);
  if (members.length <= span) return [members.slice()];
  const out: B[][] = [];
  for (let i = 0; i < members.length; i += size) out.push(members.slice(i, i + size));
  return out;
}

export function squadName(index: number): string {
  return t("Squad {letter}", { letter: String.fromCharCode(65 + index) });
}
