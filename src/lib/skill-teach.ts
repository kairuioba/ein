// What the 教授技能 page (U15) fills in live from a recording: the apps the
// demonstration used, the parts that will change next time, a suggested name
// and the slash command. Pure functions over the recorded events.
import { msg } from "@/lib/i18n";
import type { RecordedSkillEvent } from "@/lib/skill-recorder";

const BROWSERS = /^(safari|google chrome|chrome|chromium|arc|firefox|microsoft edge|edge|brave browser|brave|opera|vivaldi|orion|dia)$/i;

export function isBrowserApp(app: string | undefined): boolean {
  return Boolean(app && BROWSERS.test(app.trim()));
}

export function originHost(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** A browser window title usually ends in " - Google Chrome" or "— Safari";
 * keep the page part. */
export function pageTitle(windowTitle: string | undefined): string | undefined {
  const cleaned = windowTitle?.replace(/\s+[-–—|]\s+(?:google chrome|safari|arc|firefox|microsoft edge|brave)$/i, "").trim();
  return cleaned || undefined;
}

export interface SkillApp {
  kind: "browser" | "app" | "download";
  /** app name, or the page / file for browsers and downloads */
  label: string;
  detail?: string;
}

/** The apps a demonstration used, in order of first use: browsers with the
 * page they showed, other apps by name, and where downloads came from. */
export function skillApps(events: readonly RecordedSkillEvent[], max = 4): SkillApp[] {
  const out: SkillApp[] = [];
  const seen = new Set<string>();
  const add = (app: SkillApp, key: string) => {
    if (seen.has(key) || out.length >= max) return;
    seen.add(key);
    out.push(app);
  };
  for (const event of events) {
    if (event.type === "download") {
      const host = originHost(event.whereFroms?.[0]);
      if (host) add({ kind: "download", label: host, detail: event.filename }, `download:${host}`);
      continue;
    }
    if (!event.app) continue;
    if (isBrowserApp(event.app)) {
      const page = pageTitle(event.windowTitle);
      add({ kind: "browser", label: event.app, detail: page }, `browser:${event.app}`);
    } else {
      add({ kind: "app", label: event.app, detail: event.windowTitle?.trim() || undefined }, `app:${event.app}`);
    }
  }
  return out;
}

export interface SkillParam {
  /** msg() label: what kind of input changes */
  kind: string;
  value: string;
}

/** Things that will differ next time — typed text, pasted content and
 * downloaded files — so the bot asks for them instead of replaying them. */
export function skillParams(events: readonly RecordedSkillEvent[], max = 4): SkillParam[] {
  const out: SkillParam[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    let param: SkillParam | null = null;
    if (event.type === "typing") param = { kind: msg("Typed text"), value: event.name ?? pageTitle(event.windowTitle) ?? event.app ?? "" };
    else if (event.type === "clipboard" && event.op === "paste") param = { kind: msg("Pasted content"), value: pageTitle(event.windowTitle) ?? event.app ?? "" };
    else if (event.type === "download") param = { kind: msg("File"), value: event.filename ?? "" };
    if (!param || !param.value) continue;
    const key = `${param.kind}:${param.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...param, value: param.value.length > 18 ? `${param.value.slice(0, 17)}…` : param.value });
    if (out.length >= max) break;
  }
  return out;
}

/** A starting name for the skill: the page or window the demonstration spent
 * the most steps in. Empty until something was recorded. */
export function suggestSkillName(events: readonly RecordedSkillEvent[]): string {
  const counts = new Map<string, number>();
  for (const event of events) {
    const where = pageTitle(event.windowTitle) ?? event.app;
    if (where) counts.set(where, (counts.get(where) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return best ? best.slice(0, 24) : "";
}

/** "/定时发小红书" — the name with spaces joined, as a slash command. */
export function slashCommand(name: string): string {
  const cleaned = name
    .trim()
    .replace(/^\/+/, "")
    .replace(/[\s·•|/\\,，、:：]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return cleaned ? `/${cleaned}` : "";
}

export interface SkillNote {
  id: string;
  /** spoken narration, something typed into the chat box, or a standing rule */
  source: "said" | "typed" | "rule";
  text: string;
  atMs?: number;
}

/** The narration plus anything typed into the box during the recording. */
export function transcriptWithNotes(transcript: string, notes: readonly SkillNote[], format: (atMs: number) => string): string {
  const typed = notes.filter((note) => note.source === "typed" && note.text.trim());
  if (!typed.length) return transcript;
  const lines = typed.map((note) => `[${note.atMs === undefined ? "" : format(note.atMs)}] ${note.text.trim()}`);
  return [transcript.trim(), lines.join("\n")].filter(Boolean).join("\n\n");
}
