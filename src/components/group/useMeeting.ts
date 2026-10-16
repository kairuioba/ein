// Everything GroupView, its agenda bar and the minutes panel need to read a
// room as a meeting, computed once per transcript change. Decisions and the
// library come from the company layer's polled endpoints (empty until the
// server answers them), the rest from the room itself — no new server API.
import { useEffect, useMemo, useState } from "react";

import type { LibraryDoc, OrgDecision } from "../../../shared/org-types";
import { useDecisions, useLibrary, useOrg } from "@/state/org-api";
import type { Bot, Group, Message } from "@/state/store";
import { buildDepartments, chiefBot } from "@/lib/org";
import { effectiveDefaultResponder } from "@/lib/group-routing";
import {
  decisionsForGroup,
  isAnsweredQuestion,
  isQuestionCard,
  meetingChair,
  meetingState,
  meetingTiming,
  meetingWindow,
  minutesDocFor,
  parseAgenda,
  type Agenda,
  type MeetingState,
  type MeetingTiming,
} from "@/lib/group-meeting";
import { numberSources, type RoomSources } from "@/lib/group-sources";

export interface Meeting {
  agenda: Agenda | null;
  /** the bulletin names a topic: this room is a 协调会 */
  isMeeting: boolean;
  state: MeetingState;
  timing: MeetingTiming | null;
  chair?: Bot;
  chiefId?: string;
  sources: RoomSources;
  decisions: OrgDecision[];
  /** options of the room's latest question, for "which option a source backs" */
  options: string[];
  /** you answered a question or a decision names you */
  ownerDecided: boolean;
  ownerSpoke: boolean;
  docs: LibraryDoc[];
  minutesDoc?: LibraryDoc;
  /** department colour per bot id (the chief has none: it reads in ink) */
  colors: Map<string, string>;
}

/** A clock that ticks once a minute while `live` — enough for "还剩 3 分钟". */
function useMinuteClock(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [live]);
  return now;
}

const isSpoken = (message: Message) => message.kind !== "activity" && message.kind !== "screen";
const NO_DOCS: LibraryDoc[] = [];

export function useMeeting(group: Group, members: Bot[], allBots: Bot[]): Meeting {
  const { data: decisionData } = useDecisions();
  const { data: library } = useLibrary();
  const { data: org } = useOrg();
  const busy = Boolean(group.busyBotId);
  const live = busy || group.messages.length > 0;
  const now = useMinuteClock(live);
  const docs = library.docs ?? NO_DOCS;

  const base = useMemo(() => {
    const agenda = parseAgenda(group.bulletin);
    const spoken = group.messages.filter(isSpoken);
    const decisions = decisionsForGroup(decisionData.decisions ?? [], group.id);
    const question = [...group.messages].reverse().find(isQuestionCard);
    const chief = chiefBot(allBots, org);
    const responder = effectiveDefaultResponder(group, members);
    const chair = meetingChair(members, agenda, responder.kind === "member" ? responder.botId : undefined, chief?.id);
    const colors = new Map<string, string>();
    for (const department of buildDepartments(allBots, org)) {
      if (department.lead) colors.set(department.lead.id, department.color);
      for (const member of department.members) colors.set(member.id, department.color);
    }
    return {
      agenda,
      isMeeting: Boolean(agenda?.topic),
      spoken,
      decisions,
      decided: decisions.length > 0,
      chair,
      chiefId: chief?.id,
      // a doc named in a bot's message counts as cited, like a link to it
      sources: numberSources(group.messages, docs),
      options: question?.card?.options ?? [],
      ownerDecided: decisions.some((decision) => decision.decidedBy === "owner") || group.messages.some(isAnsweredQuestion),
      ownerSpoke: group.messages.some((message) => message.role === "user"),
      colors,
    };
  }, [group, members, allBots, decisionData.decisions, org, docs]);

  const state = meetingState({ messages: base.spoken, busy, decided: base.decided });
  const window = useMemo(() => {
    const span = meetingWindow(base.spoken);
    if (!span) return null;
    // a decision recorded after the last message still belongs to the meeting
    const lastDecision = Math.max(0, ...base.decisions.map((decision) => decision.at));
    return { start: span.start, end: Math.max(span.end, lastDecision) };
  }, [base.spoken, base.decisions]);
  const timing = meetingTiming(window, state, base.agenda?.limitMin, now);

  const minutesDoc = useMemo(
    () => minutesDocFor(docs, group.name, base.decisions.map((decision) => decision.id)),
    [docs, group.name, base.decisions],
  );

  return {
    agenda: base.agenda,
    isMeeting: base.isMeeting,
    state,
    timing,
    chair: base.chair,
    chiefId: base.chiefId,
    sources: base.sources,
    decisions: base.decisions,
    options: base.options,
    ownerDecided: base.ownerDecided,
    ownerSpoke: base.ownerSpoke,
    docs,
    minutesDoc,
    colors: base.colors,
  };
}
