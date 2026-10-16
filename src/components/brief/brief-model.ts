// Pure helpers for the brief (简报): the headline when the server sends only
// numbers, the segmented progress, citations, the folded day, how long the
// inbox will take, and the plain-text copy for sharing.
import type { Brief, BriefDepartment, InboxItem, OrgEvent } from "../../../shared/org-types";
import { t } from "@/lib/i18n";
import { clip, clock } from "@/lib/workbench";

/** The chief's one-line summary; built from the numbers if the server sent none. */
export function headlineOf(brief: Pick<Brief, "headline" | "done" | "total" | "needsYou">): string {
  if (brief.headline.trim()) return brief.headline.trim();
  if (!brief.total) return brief.needsYou.length ? t("{count} things need your call.", { count: brief.needsYou.length }) : "";
  return brief.needsYou.length
    ? t("Overall {done}/{total}; {count} things need your call.", { done: brief.done, total: brief.total, count: brief.needsYou.length })
    : t("Overall {done}/{total}; nothing needs you right now.", { done: brief.done, total: brief.total });
}

export const percent = (done: number, total: number) => (total > 0 ? Math.round((done / total) * 100) : 0);

/** One coloured segment per department (its finished work), then the rest. */
export function progressSegments(departments: readonly BriefDepartment[], total: number): Array<{ key: string; flex: number; color: string | null }> {
  const segments: Array<{ key: string; flex: number; color: string | null }> = departments.filter((dept) => dept.done > 0).map((dept) => ({ key: dept.section, flex: dept.done, color: dept.color }));
  const done = segments.reduce((sum, segment) => sum + segment.flex, 0);
  if (total > done) segments.push({ key: "__rest__", flex: total - done, color: null });
  return segments;
}

/** The inbox in a sensible reading order: oldest wait first within a kind
 * order of choice → approval → escalation (the order the owner answers fastest). */
export function inboxOrder(items: readonly InboxItem[]): InboxItem[] {
  const rank = { choice: 0, approval: 1, escalation: 2 } as const;
  return [...items].sort((a, b) => rank[a.kind] - rank[b.kind] || a.since - b.since);
}

/** "约 2 分钟能处理完": a pick takes half a minute, an approval or escalation one. */
export function handlingMinutes(items: readonly InboxItem[]): number {
  const total = items.reduce((sum, item) => sum + (item.kind === "choice" ? 0.5 : 1), 0);
  return Math.max(1, Math.ceil(total));
}

/** An inbox item's detail: the first line says what happens if nobody
 * answers (when there is more than one line, or it is a pick); the rest is
 * the content to look at (a draft, a question). */
export function splitDetail(item: Pick<InboxItem, "kind" | "detail">): { consequence?: string; body?: string } {
  const lines = (item.detail ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return {};
  if (lines.length > 1) return { consequence: lines[0], body: lines.slice(1).join("\n") };
  return item.kind === "choice" ? { consequence: lines[0] } : { body: lines[0] };
}

/** Options that are pictures (a URL or data URL of an image) show as thumbnails. */
export const isImageOption = (option: string) => /^data:image\//.test(option) || /^(https?:|\/)\S+\.(png|jpe?g|webp|gif|svg)(\?\S*)?$/i.test(option);

export type TimelineRow = { kind: "event"; event: OrgEvent } | { kind: "fold"; from: number; to: number; titles: string[]; count: number };

/** Keep the first `head` and last `tail` events and fold the middle when the
 * day is long, the way the brief reads: "16:05 – 16:47 · 价格分歧、加人 等 8 条". */
export function foldTimeline(events: readonly OrgEvent[], head = 2, tail = 1, max = 5): TimelineRow[] {
  const sorted = [...events].sort((a, b) => a.at - b.at);
  if (sorted.length <= max) return sorted.map((event) => ({ kind: "event", event }));
  const middle = sorted.slice(head, sorted.length - tail);
  return [
    ...sorted.slice(0, head).map((event) => ({ kind: "event" as const, event })),
    { kind: "fold", from: middle[0]!.at, to: middle[middle.length - 1]!.at, titles: middle.slice(0, 3).map((event) => clip(event.title, 8)), count: middle.length },
    ...sorted.slice(sorted.length - tail).map((event) => ({ kind: "event" as const, event })),
  ];
}

/** Monday 00:00 of the week `now` falls in. */
export function weekStart(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const offset = (day.getDay() + 6) % 7;
  day.setDate(day.getDate() - offset);
  return day.getTime();
}

/** The brief as plain text, for sharing (clipboard). */
export function briefText(brief: Brief, now: number, name: (botId: string) => string): string {
  const lines = [t("Brief · {time}", { time: clock(now) }), headlineOf(brief), ""];
  for (const dept of brief.departments) lines.push(`${dept.section} ${dept.done}/${dept.total} · ${dept.status}`);
  if (brief.needsYou.length) {
    lines.push("", t("Needs you · {count}", { count: brief.needsYou.length }));
    for (const item of brief.needsYou) lines.push(`- ${item.title} (${name(item.botId)})`);
  }
  return lines.join("\n").trim();
}
