// What a call screen knows about the people on it beyond the bots themselves:
// department colours for the name dots, each bot's engine name for its chip,
// the company's chief, and the calendar entry (if any) that scheduled this
// room's call — its name, start and length title the call.
import { useMemo } from "react";

import { useApi, useOrg } from "@/state/org-api";
import { useStore, type Bot } from "@/state/store";
import { buildDepartments, chiefBot } from "@/lib/org";
import type { CalendarCall } from "@/lib/calendar-calls";

export interface CallContext {
  colors: Map<string, string>;
  engineOf: (bot: Bot) => string | undefined;
  chiefId?: string;
  calls: CalendarCall[];
}

export function useCallContext(): CallContext {
  const { state } = useStore();
  const { data: org } = useOrg();
  const { data: calendar } = useApi<{ calls?: CalendarCall[] }>("/api/calendar-calls", { calls: [] }, 60_000);
  return useMemo(() => {
    const colors = new Map<string, string>();
    for (const department of buildDepartments(state.bots, org)) {
      if (department.lead) colors.set(department.lead.id, department.color);
      for (const member of department.members) colors.set(member.id, department.color);
    }
    const engineOf = (bot: Bot) => state.instances.find((instance) => instance.instanceId === bot.modelSelection?.instanceId)?.displayName;
    return { colors, engineOf, chiefId: chiefBot(state.bots, org)?.id, calls: calendar.calls ?? [] };
  }, [state.bots, state.instances, org, calendar.calls]);
}

/** Start of today's occurrence of a calendar call (or its one-off time). */
export function callOccurrence(call: CalendarCall, now: number): number | null {
  if (call.schedule.type === "once") return call.schedule.at;
  const [hh, mm] = call.schedule.time.split(":").map(Number);
  const day = new Date(now);
  day.setHours(hh, mm, 0, 0);
  return day.getTime();
}

/** Speaking time estimated from text when no voice was measured (≈ 4.5 chars a second). */
export function estimateSpeechMs(text: string): number {
  return Math.round(text.replace(/\s+/g, " ").trim().length * 220);
}
