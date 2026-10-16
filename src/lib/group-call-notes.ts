// What a call screen shows next to the speakers: live captions (who, mm:ss
// into the call, what they said) and the running minutes built from them —
// a few key points and the action items people committed to ("15:40 前交").
// Pure and heuristic on purpose: the transcript IS the source of truth, the
// minutes only make it scannable, and every item links back to its line.

type MessageLike = {
  id: string;
  at: number;
  role: "bot" | "user";
  kind: string;
  text?: string;
  from?: { botId: string; name: string };
};

export type CaptionSpeaker = { kind: "bot"; botId: string; name: string } | { kind: "you" };

export interface CaptionLine {
  id: string;
  speaker: CaptionSpeaker;
  at: number;
  /** ms since the call started */
  offsetMs: number;
  text: string;
}

/** "1:05", "12:40", "1:02:05" — a duration as a clock. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** "00:48" — an offset into the call, always two-digit minutes. */
export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  return `${String(minutes).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

const ATTACHMENT_TAG = /<attached-(?:file|image)\s+path="[^"]*"\s*\/>/g;
/** markdown that reads badly as a caption: links keep their words, emphasis goes */
function plain(text: string): string {
  return text
    .replace(ATTACHMENT_TAG, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]{1,3}([^*_`~]+)[*_`~]{1,3}/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** Every spoken line since the call started: your words and the members'
 * replies. `fallbackBot` names the speaker of a 1:1 call's bot lines. */
export function captionLines(
  messages: readonly MessageLike[],
  startedAt: number,
  fallbackBot?: { botId: string; name: string },
): CaptionLine[] {
  const lines: CaptionLine[] = [];
  for (const message of messages) {
    if (message.kind !== "text" || !message.text || message.at < startedAt - 2_000) continue;
    const text = plain(message.text);
    if (!text) continue;
    const speaker: CaptionSpeaker | null =
      message.role === "user"
        ? { kind: "you" }
        : message.from
          ? { kind: "bot", botId: message.from.botId, name: message.from.name }
          : fallbackBot
            ? { kind: "bot", ...fallbackBot }
            : null;
    if (!speaker) continue;
    lines.push({ id: message.id, speaker, at: message.at, offsetMs: Math.max(0, message.at - startedAt), text });
  }
  return lines;
}

/** While a reply is being read aloud: the part already heard and the part
 * still to come, split after the utterance the speaker is on. */
export function splitSpoken(text: string, caption: string | undefined): { spoken: string; pending: string } {
  const now = caption?.trim();
  if (!now) return { spoken: text, pending: "" };
  const index = text.indexOf(now);
  if (index < 0) return { spoken: text, pending: "" };
  const cut = index + now.length;
  return { spoken: text.slice(0, cut), pending: text.slice(cut) };
}

// ── action items ────────────────────────────────────────────────────────────
export interface CallAction {
  id: string;
  lineId: string;
  title: string;
  /** "15:40 前", "14:00 开工" */
  due?: string;
  ownerId?: string;
  ownerName: string;
  offsetMs: number;
}

const CLAUSE_SPLIT = /[。；;！!？?\n]+/;
const DAY_WORD = "(?:今天|明天|今晚|今早|明早|上午|中午|下午|晚上|周[一二三四五六日天]|today|tomorrow)";
const CLOCK = new RegExp(
  `(?:${DAY_WORD}\\s*)?(\\d{1,2}[:：]\\d{2})\\s*(前交|之前|以前|前|开工|开始|交付|交|完成|截止|上线)?`,
  "i",
);
const ENGLISH_DUE = /\b(?:by|before|at)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i;
const MAX_TITLE = 40;

function tidy(clause: string): string {
  return clause
    .replace(/\s*[，,]\s*[，,]\s*/g, "，")
    .replace(/^[\s，,、:：·-]+|[\s，,、:：·-]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function clip(text: string): string {
  return text.length > MAX_TITLE ? `${text.slice(0, MAX_TITLE - 1)}…` : text;
}

/** Commitments with a time in them, one per clause, owned by whoever said them. */
export function callActions(lines: readonly CaptionLine[]): CallAction[] {
  const actions: CallAction[] = [];
  for (const line of lines) {
    const speaker = line.speaker;
    if (speaker.kind !== "bot") continue;
    line.text.split(CLAUSE_SPLIT).forEach((raw, index) => {
      const clause = raw.trim();
      if (!clause) return;
      // the comma-separated piece that holds the time is the commitment
      const pieces = clause.split(/[，,]/).map((piece) => piece.trim()).filter(Boolean);
      const at = pieces.findIndex((piece) => CLOCK.test(piece) || ENGLISH_DUE.test(piece));
      if (at < 0) return;
      const piece = pieces[at];
      let due: string | undefined;
      let rest = piece;
      const clock = CLOCK.exec(piece);
      if (clock) {
        const suffix = clock[2];
        due = suffix ? `${clock[1].replace("：", ":")} ${/^前|之前|以前/.test(suffix) ? "前" : suffix}` : clock[1].replace("：", ":");
        rest = piece.slice(0, clock.index) + piece.slice(clock.index + clock[0].length);
      } else {
        const english = ENGLISH_DUE.exec(piece)!;
        due = english[0].trim();
        rest = piece.slice(0, english.index) + piece.slice(english.index + english[0].length);
      }
      rest = tidy(rest);
      // "14:00 开工" or "16:50 前给老板挑" says when, not what: borrow the subject
      // from the piece before (and, when nothing is left, the one after)
      const title = rest.length >= 6
        ? rest
        : tidy([pieces[at - 1], rest || pieces[at + 1]].filter(Boolean).join("，"));
      if (!title) return;
      actions.push({
        id: `${line.id}:${index}`,
        lineId: line.id,
        title: clip(title),
        due,
        ownerId: speaker.botId,
        ownerName: speaker.name,
        offsetMs: line.offsetMs,
      });
    });
  }
  return actions;
}

// ── key points ──────────────────────────────────────────────────────────────
const DECIDED = /先用|改用|决定|定了|定为|就用|we decided|decided|going with|we'll use/i;
const WAITING = /在等|等着|等待|等[^，,。；;]{1,12}(?:终稿|定了|确认|出来|好了|再)|依赖|卡在|卡住|blocked|blocker|depends on|waiting (?:on|for)/i;
const QUESTION = /哪|吗|什么|怎么|是否|\bwhat\b|\bhow\b|\bwhy\b/i;

/** The goal (from the room's bulletin), then what was decided and what is
 * waiting on what — the lines a latecomer needs. Decisions come first, then
 * the newest dependencies, one point per subject, in the order they were said. */
export function callPoints(lines: readonly CaptionLine[], goal?: string, max = 2): string[] {
  type Candidate = { text: string; rank: number; order: number };
  const candidates: Candidate[] = [];
  let order = 0;
  for (const line of lines) {
    if (line.speaker.kind !== "bot") continue;
    for (const raw of line.text.split(CLAUSE_SPLIT)) {
      for (const piece of raw.split(/[，,]/)) {
        const clause = tidy(piece);
        order += 1;
        if (clause.length < 4 || CLOCK.test(clause) || QUESTION.test(clause)) continue;
        // "等主色定了再做" waits on a decision — it is a dependency, not one
        const rank = WAITING.test(clause) ? 1 : DECIDED.test(clause) ? 0 : -1;
        if (rank >= 0) candidates.push({ text: clip(clause), rank, order });
      }
    }
  }
  const picked: Candidate[] = [];
  for (const candidate of [...candidates].sort((a, b) => a.rank - b.rank || b.order - a.order)) {
    if (picked.length >= max) break;
    const subject = candidate.text.slice(0, 3);
    if (picked.some((point) => point.text.startsWith(subject))) continue;
    picked.push(candidate);
  }
  const points = picked.sort((a, b) => a.order - b.order).map((point) => point.text);
  return goal?.trim() ? [goal.trim(), ...points] : points;
}

// ── the speaker grid ────────────────────────────────────────────────────────
/** Columns, rows and mascot scale for a call with `count` tiles (you included). */
export function callGridShape(count: number): { cols: number; rows: number; scale: number } {
  if (count <= 2) return { cols: 2, rows: 1, scale: 2.5 };
  if (count <= 4) return { cols: 2, rows: 2, scale: 2.5 };
  if (count <= 6) return { cols: 3, rows: 2, scale: 2.5 };
  if (count <= 8) return { cols: 4, rows: 2, scale: 2 };
  if (count <= 12) return { cols: 4, rows: 3, scale: 1.5 };
  return { cols: 5, rows: Math.ceil(count / 5), scale: 1.5 };
}
