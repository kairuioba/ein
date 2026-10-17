// Owner-time 指标：用已有事件算「老板每天被打扰得值不值」，不埋点、不调模型。
// 决策延迟 = 收件项 createdAt → resolvedAt；返工率来自复盘；
// 自动处理占比需要审计记录，当前版本返回 null 而不是编数字。
import type { InboxItem } from "../shared/dispatch-types.ts";
import type { DispatchRetro } from "./dispatch.ts";

export interface OwnerTimeMetrics {
  generatedAt: number;
  decisions: { today: number; week: number; open: number };
  latency: { p50Ms: number | null; p90Ms: number | null; samples: number };
  rework: { rate: number | null; retriedSubtasks: number; totalSubtasks: number };
  automation: { ratio: number | null; note: string };
  waiting: { projects: number; actionable: number };
}

const DAY = 24 * 60 * 60 * 1000;
/** The owner's calendar runs in China time by default (server clocks can be UTC). */
export const DEFAULT_OWNER_TIME_ZONE = "Asia/Shanghai";

/** Offset of `timeZone` from UTC at instant `now`, in ms (negative west of UTC). */
function zoneOffsetMs(now: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(now));
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour") % 24, value("minute"), value("second"));
  return asUtc - Math.floor(now / 1000) * 1000;
}

/** Turn a local wall-clock instant back into epoch ms (one offset refinement
 * so a DST change at the boundary cannot land on the wrong side). */
function fromWallClock(wall: number, timeZone: string): number {
  let offset = zoneOffsetMs(wall - DAY / 2, timeZone);
  let utc = wall - offset;
  const refined = zoneOffsetMs(utc, timeZone);
  if (refined !== offset) {
    offset = refined;
    utc = wall - offset;
  }
  return utc;
}

/** Local midnight for the owner's timezone (default Asia/Shanghai), not UTC
 * or the server host's zone. */
export function ownerDayStart(now: number, timeZone = DEFAULT_OWNER_TIME_ZONE): number {
  const wall = now + zoneOffsetMs(now, timeZone);
  return fromWallClock(Math.floor(wall / DAY) * DAY, timeZone);
}

/** Local Monday 00:00 of the week `now` falls in, in the owner's timezone. */
export function ownerWeekStart(now: number, timeZone = DEFAULT_OWNER_TIME_ZONE): number {
  const dayStart = ownerDayStart(now, timeZone);
  const wallDayStart = dayStart + zoneOffsetMs(dayStart, timeZone);
  const weekday = (new Date(wallDayStart).getUTCDay() + 6) % 7; // Monday = 0
  return fromWallClock(wallDayStart - weekday * DAY, timeZone);
}

const percentile = (values: number[], p: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
};

export function buildOwnerMetrics(input: {
  items: InboxItem[];
  retros: DispatchRetro[];
  now?: number;
  /** the owner's timezone for today/week boundaries (default Asia/Shanghai) */
  timeZone?: string;
  waitingProjects?: number;
}): OwnerTimeMetrics {
  const now = input.now ?? Date.now();
  const timeZone = input.timeZone ?? DEFAULT_OWNER_TIME_ZONE;
  const dayStart = ownerDayStart(now, timeZone);
  const weekStart = ownerWeekStart(now, timeZone);
  const resolved = input.items.filter((item) => typeof item.resolvedAt === "number" && typeof item.createdAt === "number");
  const latencies = resolved.map((item) => Math.max(0, item.resolvedAt! - item.createdAt));
  const open = input.items.filter((item) => !item.resolvedAt);
  let totalSubtasks = 0;
  let retriedSubtasks = 0;
  for (const retro of input.retros) {
    totalSubtasks += retro.counts.total;
    retriedSubtasks += retro.counts.retried;
  }
  return {
    generatedAt: now,
    decisions: {
      today: resolved.filter((item) => item.resolvedAt! >= dayStart).length,
      week: resolved.filter((item) => item.resolvedAt! >= weekStart).length,
      open: open.length,
    },
    latency: { p50Ms: percentile(latencies, 50), p90Ms: percentile(latencies, 90), samples: latencies.length },
    rework: { rate: totalSubtasks ? retriedSubtasks / totalSubtasks : null, retriedSubtasks, totalSubtasks },
    automation: { ratio: null, note: "automatic decisions are not audited yet" },
    waiting: { projects: input.waitingProjects ?? 0, actionable: open.filter((item) => item.kind === "signoff" || item.kind === "gate_failed").length },
  };
}
