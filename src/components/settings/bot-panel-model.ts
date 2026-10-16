// Pure helpers for the Bot settings panel: the status its hero shows, who the
// bot reports to, and how many notes its MEMORY.md holds.
import type { MascotPose } from "@/lib/engine-mascots";

export type HeroStatus = { tone: "blue" | "amber" | "red" | "grey"; pose: MascotPose; kind: "working" | "waiting" | "offline" | "idle" };

type StatusBot = { busy?: boolean; activity?: "working" | "waiting-on-you" | "idle" | "no-signal" | "dead" };

/** The hero's pill and the mascot's pose: working, waiting on you, offline or idle. */
export function heroStatus(bot: StatusBot): HeroStatus {
  if (bot.activity === "waiting-on-you") return { tone: "amber", pose: "wave", kind: "waiting" };
  if (bot.activity === "dead" || bot.activity === "no-signal") return { tone: "red", pose: "scared", kind: "offline" };
  if (bot.busy || bot.activity === "working") return { tone: "blue", pose: "work", kind: "working" };
  return { tone: "grey", pose: "idle", kind: "idle" };
}

type OrgBot = { id: string; name: string; section?: string; chiefOfStaff?: boolean; hidden?: boolean };

/** Who a bot reports to: the main bot reports to you; a department lead to the
 * main bot; a member to its department's lead (or the main bot when the
 * department has none); a bot outside every department to the main bot. */
export function superiorOf<B extends OrgBot>(bot: B, bots: readonly B[], mainBotId: string | undefined): { kind: "you" } | { kind: "bot"; bot: B } | { kind: "none" } {
  if (bot.id === mainBotId) return { kind: "you" };
  const main = bots.find((candidate) => candidate.id === mainBotId && !candidate.hidden);
  const section = bot.section?.trim() ?? "";
  if (section && !bot.chiefOfStaff) {
    const lead = bots.find((candidate) => !candidate.hidden && candidate.chiefOfStaff && (candidate.section?.trim() ?? "") === section && candidate.id !== bot.id && candidate.id !== mainBotId);
    if (lead) return { kind: "bot", bot: lead };
  }
  return main ? { kind: "bot", bot: main } : { kind: "none" };
}

/** How many people a lead leads: its department minus itself; the main bot
 * counts every other visible bot. */
export function teamSize<B extends OrgBot>(bot: B, bots: readonly B[], mainBotId: string | undefined): number {
  const others = bots.filter((candidate) => !candidate.hidden && candidate.id !== bot.id);
  if (bot.id === mainBotId) return others.length;
  const section = bot.section?.trim() ?? "";
  if (!bot.chiefOfStaff || !section) return 0;
  return others.filter((candidate) => (candidate.section?.trim() ?? "") === section && candidate.id !== mainBotId).length;
}

/** Notes in a MEMORY.md: its list items, or — for a file written as plain
 * lines — the non-empty lines that are not headings. */
export function countMemoryNotes(text: string): number {
  const lines = text.split(/\r?\n/);
  const items = lines.filter((line) => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line)).length;
  if (items) return items;
  return lines.filter((line) => line.trim() && !/^\s*#/.test(line) && !/^\s*(?:---|```)/.test(line)).length;
}
