// A group chat read as a meeting (协调会): the agenda pinned in the room's
// bulletin, where the meeting stands, how long it ran against its time limit,
// which decisions it produced and where its minutes were filed. Pure helpers —
// GroupView and the minutes panel draw them, tests pin the parsing down.
import type { LibraryDoc, OrgDecision } from "../../shared/org-types";

type MessageLike = {
  id: string;
  at: number;
  role: "bot" | "user";
  kind: string;
  card?: { requestId?: string; tool?: string; answered?: string; dismissed?: boolean; options?: string[]; decisionId?: number };
};

// ── agenda ───────────────────────────────────────────────────────────────────
export interface AgendaPart {
  key?: string;
  value: string;
  /** the 议题 part — the only key the agenda bar sets in bold */
  topic?: boolean;
}

export interface Agenda {
  /** the bulletin line the agenda was read from */
  raw: string;
  parts: AgendaPart[];
  topic?: string;
  host?: string;
  /** 时限: the meeting's time box in minutes */
  limitMin?: number;
}

const TOPIC_KEY = /^(议题|主题|话题|topic|agenda|subject)$/i;
const HOST_KEY = /^(主持|主持人|host|chair|facilitator)$/i;
const LIMIT = /^(?:时限|限时|time\s*limit|time\s*box|timebox)\s*[:：]?\s*(\d{1,3})\s*(?:分钟|分|mins?|minutes?)$/i;
const KEY_VALUE = /^([^:：]{1,12})[:：]\s*(.+)$/;

/** Read "议题：… · 主持：总控 · 时限 15 分钟" from the first non-empty bulletin
 * line. Any bulletin gives an agenda; it is a meeting when it names a topic. */
export function parseAgenda(bulletin: string | null | undefined): Agenda | null {
  const line = (bulletin ?? "")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  if (!line) return null;
  const agenda: Agenda = { raw: line, parts: [] };
  for (const piece of line.split(/\s*[·•・｜|]\s*/)) {
    const value = piece.trim();
    if (!value) continue;
    const limit = LIMIT.exec(value);
    if (limit) {
      agenda.limitMin ??= Number(limit[1]);
      agenda.parts.push({ value });
      continue;
    }
    // "19:30" is a time, not a "key: value" pair
    const colon = value.search(/[:：]/);
    const isClock = colon > 0 && /\d/.test(value[colon - 1]) && /\d/.test(value[colon + 1] ?? "");
    const pair = isClock ? null : KEY_VALUE.exec(value);
    if (!pair) {
      agenda.parts.push({ value });
      continue;
    }
    const key = pair[1].trim();
    const content = pair[2].trim();
    if (TOPIC_KEY.test(key)) {
      agenda.topic ??= content;
      agenda.parts.push({ key, value: content, topic: true });
    } else {
      if (HOST_KEY.test(key)) agenda.host ??= content;
      agenda.parts.push({ key, value: content });
    }
  }
  return agenda;
}

// ── question cards ───────────────────────────────────────────────────────────
/** A live question to the owner (an options card that is not a permission ask). */
export function isQuestionCard(message: MessageLike): boolean {
  return message.kind === "options" && Boolean(message.card?.requestId) && !message.card?.tool;
}

/** A question the owner actually answered (not voided, not dismissed by the system). */
export function isAnsweredQuestion(message: MessageLike): boolean {
  const card = message.card;
  return isQuestionCard(message) && Boolean(card?.answered) && card?.answered !== "unavailable" && !card?.dismissed;
}

export function openQuestion<M extends MessageLike>(messages: readonly M[]): M | undefined {
  return messages.find((message) => isQuestionCard(message) && !message.card?.answered && !message.card?.dismissed);
}

// ── where the meeting stands ────────────────────────────────────────────────
export type MeetingState = "idle" | "live" | "waiting" | "ended";

export interface MeetingWindow {
  start: number;
  end: number;
}

export function meetingWindow(messages: ReadonlyArray<{ at: number }>): MeetingWindow | null {
  if (!messages.length) return null;
  let start = Infinity;
  let end = -Infinity;
  for (const message of messages) {
    if (message.at < start) start = message.at;
    if (message.at > end) end = message.at;
  }
  return { start, end };
}

/** 未开始 → 进行中 → 等你裁决 → 已结束: waiting on the owner wins over a busy
 * member (a turn holding a question IS busy), and a room is over once it is
 * quiet after a decision. */
export function meetingState(input: { messages: readonly MessageLike[]; busy: boolean; decided: boolean }): MeetingState {
  if (!input.messages.length) return "idle";
  if (openQuestion(input.messages)) return "waiting";
  if (input.busy) return "live";
  if (input.decided || input.messages.some(isAnsweredQuestion)) return "ended";
  return "live";
}

export interface MeetingTiming {
  start: number;
  end: number;
  /** whole minutes between the shown HH:MM times */
  durationMin: number;
  /** ended inside the time limit by this many minutes */
  earlyMin?: number;
  /** ran past the time limit by this many minutes */
  overMin?: number;
  /** still running: minutes left in the time limit */
  leftMin?: number;
}

const minuteOf = (at: number) => Math.floor(at / 60_000);

export function meetingTiming(
  window: MeetingWindow | null,
  state: MeetingState,
  limitMin: number | undefined,
  now: number,
): MeetingTiming | null {
  if (!window) return null;
  const end = state === "ended" ? window.end : Math.max(window.end, now);
  const durationMin = Math.max(0, minuteOf(end) - minuteOf(window.start));
  const timing: MeetingTiming = { start: window.start, end, durationMin };
  if (!limitMin) return timing;
  const spare = limitMin - durationMin;
  if (state === "ended") {
    if (spare > 0) timing.earlyMin = spare;
    else if (spare < 0) timing.overMin = -spare;
  } else if (spare >= 0) {
    timing.leftMin = spare;
  } else {
    timing.overMin = -spare;
  }
  return timing;
}

// ── who chaired ─────────────────────────────────────────────────────────────
/** The chair: the member the agenda names as host, else the room's lead
 * (default responder), else the company's chief when it is in the room. */
export function meetingChair<B extends { id: string; name: string }>(
  members: readonly B[],
  agenda: Agenda | null,
  leadId: string | undefined,
  chiefId: string | undefined,
): B | undefined {
  const host = agenda?.host?.trim();
  if (host) {
    const named = members.find((member) => member.name === host) ?? members.find((member) => host.includes(member.name));
    if (named) return named;
  }
  return members.find((member) => member.id === leadId) ?? members.find((member) => member.id === chiefId);
}

// ── decisions ────────────────────────────────────────────────────────────────
export function decisionsForGroup(decisions: readonly OrgDecision[], groupId: string): OrgDecision[] {
  return decisions.filter((decision) => decision.source.kind === "group" && decision.source.id === groupId).sort((a, b) => a.id - b.id);
}

/** The decision an answered card produced: the card's own `decisionId` when
 * the server patched it in, else the decision that names the message. */
export function decisionForMessage(decisions: readonly OrgDecision[], message: MessageLike): OrgDecision | undefined {
  const id = message.card?.decisionId;
  if (typeof id === "number") {
    const byId = decisions.find((decision) => decision.id === id);
    if (byId) return byId;
  }
  return decisions.find((decision) => decision.source.messageId === message.id);
}

/** "799 · 按渠道报价和参数页" → "799", "按 v2 · 9 人" → "按 v2": the part of an
 * option people say out loud — a leading number, else the first segment. */
export function choiceToken(choice: string): string {
  const segment = choice.trim().split(/\s*[·•・|｜:：(（,，]\s*/)[0]?.trim() ?? "";
  const number = /^[¥$€£]?\d[\d.,]*%?/.exec(segment);
  if (number) return number[0];
  return segment || choice.trim();
}

/** A decision headline that never repeats its choice: "旗舰款价格用 799" stays,
 * "首发价用哪个？" + "799" becomes "首发价用哪个？ → 799". */
export function decisionHeadline(decision: Pick<OrgDecision, "title" | "choice">): string {
  const title = decision.title.trim();
  const token = choiceToken(decision.choice);
  if (!token || title.includes(token)) return title;
  return title ? `${title} → ${token}` : token;
}

// ── the minutes in the library ──────────────────────────────────────────────
const MINUTES_WORD = /纪要|minutes/i;

/** The newest library doc that is this room's minutes (title names the room
 * and says 纪要 / minutes). */
export function minutesDocFor<T extends Pick<LibraryDoc, "title" | "updatedAt">>(docs: readonly T[], groupName: string): T | undefined {
  const name = groupName.trim();
  if (!name) return undefined;
  return docs
    .filter((doc) => doc.title.includes(name) && MINUTES_WORD.test(doc.title))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

/** The doc's title without its "会议纪要 ›" filing prefix, for the
 * "资料库 › 会议纪要 › 价格对齐会 10-15" path. */
export function minutesDocName(title: string): string {
  const stripped = title.replace(/^\s*(?:会议纪要|纪要|meeting minutes|minutes)\s*[·•・›>»:：\-—/|｜]?\s*/i, "").trim();
  return stripped || title.trim();
}
