// "/ to use a skill" in the composer: the skills the bot (or the room's
// members) can use, fetched when the picker opens, and the text a pick puts
// in the message — a plain instruction every engine understands.
import { useEffect, useState } from "react";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";

export interface SkillChoice {
  botId: string;
  botName: string;
  name: string;
  description: string;
}

interface SkillListing {
  name: string;
  description?: string;
  enabled?: boolean;
}

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; skills: SkillListing[] }>();

/** The "/query" being typed at the caret: a slash that starts a word, then
 * a skill-name-shaped word. Paths ("src/lib", "/Users/…") don't match once
 * they stop looking like a skill name or nothing is called that. */
export function slashQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("/");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(upto[at - 1]!)) return null;
  const query = upto.slice(at + 1);
  if (query.length > 40 || !/^[\w-]*$/.test(query)) return null;
  return { start: at, query };
}

/** What picking a skill writes into the message. */
export function skillInstruction(name: string): string {
  return t("Use the “{name}” skill: ", { name });
}

/** Enabled skills of the given bots, best match first. */
export function filterSkills(skills: readonly SkillChoice[], query: string): SkillChoice[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...skills];
  const prefix = skills.filter((skill) => skill.name.toLowerCase().startsWith(needle));
  const rest = skills.filter(
    (skill) =>
      !skill.name.toLowerCase().startsWith(needle) &&
      (skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle)),
  );
  return [...prefix, ...rest];
}

async function skillsOf(botId: string): Promise<SkillListing[]> {
  const hit = cache.get(botId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.skills;
  const body = (await api(`/api/bots/${encodeURIComponent(botId)}/skills`)) as { skills?: SkillListing[] };
  const skills = Array.isArray(body?.skills) ? body.skills : [];
  cache.set(botId, { at: Date.now(), skills });
  return skills;
}

/** Load the bots' enabled skills while `active` (the picker is open). */
export function useSkillChoices(bots: ReadonlyArray<{ id: string; name: string }>, active: boolean): { skills: SkillChoice[]; loading: boolean } {
  const [skills, setSkills] = useState<SkillChoice[]>([]);
  const [loading, setLoading] = useState(false);
  const key = bots.map((bot) => bot.id).join(",");
  useEffect(() => {
    if (!active || !key) return;
    let alive = true;
    setLoading(true);
    void Promise.all(
      bots.map(async (bot) => {
        try {
          return (await skillsOf(bot.id))
            .filter((skill) => skill.enabled !== false)
            .map((skill) => ({ botId: bot.id, botName: bot.name, name: skill.name, description: skill.description ?? "" }));
        } catch {
          return [];
        }
      }),
    ).then((lists) => {
      if (!alive) return;
      const seen = new Set<string>();
      setSkills(lists.flat().filter((skill) => (seen.has(skill.name) ? false : (seen.add(skill.name), true))));
      setLoading(false);
    });
    return () => {
      alive = false;
    };
    // the ids are the identity; names ride along for display
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key]);
  return { skills, loading };
}
