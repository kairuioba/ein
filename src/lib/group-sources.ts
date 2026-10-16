// Sources a group chat leans on: library docs, web pages and files the bots
// cite. A citation is a markdown link (or an attachment tag) in a bot's
// message; the room numbers each distinct source once, in the order it was
// first cited, so a chip "[2]" in the transcript and "2" in the meeting
// minutes are the same thing and jump back to the same message.
import { choiceToken } from "./group-meeting";

export type SourceKind = "library" | "web" | "file";

export interface SourceRef {
  /** identity for numbering: the same doc version / URL / file shares one number */
  key: string;
  kind: SourceKind;
  /** the full chip label, e.g. "价格表 v3 · 9月25日" */
  label: string;
  /** the label before its first " · ", e.g. "价格表 v3" */
  title: string;
  /** the rest of the label, e.g. "9月25日" */
  detail?: string;
  /** the href or path as written */
  target: string;
  /** library citations: the doc and the version cited */
  docId?: string;
  version?: number;
  /** library citations named in plain text: when the cited version was published */
  versionAt?: number;
}

/** What source detection needs to know about the library. */
export type LibraryDocLike = { id: string; title: string; versions: ReadonlyArray<{ version: number; at: number }> };

export interface NumberedSource extends SourceRef {
  n: number;
}

export interface CitedSource extends NumberedSource {
  /** the message that cited it first */
  messageId: string;
  at: number;
  botId?: string;
  name?: string;
  /** that message's text, citations removed — for "which option it backs" */
  text: string;
}

const ATTACHMENT = /<attached-(?:file|image)\s+path="([^"]+)"\s*\/>/g;
const MARKDOWN_LINK = /(!?)\[([^\]\n]{1,240})\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const TRAILING_URL = /(^|[\s:：(（])(https?:\/\/[^\s<>()]*[^\s<>().,，。;；:：!?！？、])\s*$/;
/** separators a citation may trail behind, skipped when finding the trailing run */
const BETWEEN_CITATIONS = /[\s、，,;；]/;
/** left dangling once trailing citations are cut ("来源：[x](…)" → "来源") */
const DANGLING_TAIL = /[\s、，,;；:：—–\-]+$/;

function basename(path: string): string {
  const clean = path.replace(/[\\/]+$/, "");
  return clean.split(/[\\/]/).pop() || clean;
}

function splitLabel(label: string): { title: string; detail?: string } {
  const parts = label.split(/\s+[·•・]\s+/);
  const title = parts[0]?.trim() || label.trim();
  const detail = parts.slice(1).join(" · ").trim();
  return detail ? { title, detail } : { title };
}

type Classified = { kind: SourceKind; docId?: string; version?: number; key: string };

function classify(target: string): Classified | null {
  const library =
    /^(?:omb-library|library):(?:\/\/)?([^?#\s]+)(?:[?#](.*))?$/i.exec(target) ?? /^\/library\/([^?#\s]+)(?:[?#](.*))?$/.exec(target);
  if (library) {
    let docId = library[1];
    try {
      docId = decodeURIComponent(docId);
    } catch {
      /* keep the raw id */
    }
    const version = /(?:^|[&;])v(?:ersion)?=?(\d+)\b/i.exec(library[2] ?? "") ?? /^v(\d+)$/i.exec(library[2] ?? "");
    const v = version ? Number(version[1]) : undefined;
    return { kind: "library", docId, version: v, key: `library:${docId}@${v ?? ""}` };
  }
  if (/^https?:\/\//i.test(target)) return { kind: "web", key: `web:${target.replace(/\/+$/, "")}` };
  if (/^file:\/\//i.test(target) || target.startsWith("/") || target.startsWith("~/") || /^[a-zA-Z]:[\\/]/.test(target)) {
    return { kind: "file", key: `file:${target}` };
  }
  return null;
}

function webLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const tail = parsed.pathname.split("/").filter(Boolean).pop();
    return tail ? `${parsed.hostname} › ${decodeURIComponent(tail)}` : parsed.hostname;
  } catch {
    return url;
  }
}

type Hit = { start: number; end: number; source: SourceRef; replacement: string; alwaysRemove: boolean };

/** Library docs a message names in plain text ("依据是价格表 v3"): the doc's
 * exact title (3+ characters, longest titles first), with the version when
 * one follows it. Bots are given the library by title, so this is how they
 * usually cite it. */
export function mentionedDocs(text: string, docs: readonly LibraryDocLike[]): SourceRef[] {
  const found: Array<{ at: number; source: SourceRef }> = [];
  for (const doc of [...docs].sort((a, b) => b.title.length - a.title.length)) {
    const title = doc.title.trim();
    if ([...title].length < 3) continue;
    const at = text.indexOf(title);
    // a longer title already claimed these characters ("价格表单" before "价格表")
    if (at < 0 || found.some((entry) => at < entry.at + entry.source.title.length && at + title.length > entry.at)) continue;
    const after = /^\s*v(\d{1,4})\b/i.exec(text.slice(at + title.length));
    const version = after ? Number(after[1]) : undefined;
    // no version named: the bot was given (and is citing) the latest one
    const known =
      version === undefined
        ? doc.versions.reduce<{ version: number; at: number } | undefined>((latest, entry) => (!latest || entry.version > latest.version ? entry : latest), undefined)
        : doc.versions.find((entry) => entry.version === version);
    const label = version === undefined ? title : `${title} v${version}`;
    found.push({
      at,
      source: {
        key: `library:${doc.id}@${version ?? ""}`,
        kind: "library",
        label,
        title: label,
        target: `library:${doc.id}${version === undefined ? "" : `?v=${version}`}`,
        docId: doc.id,
        version,
        ...(known ? { versionAt: known.at } : {}),
      },
    });
  }
  return found.sort((a, b) => a.at - b.at).map((entry) => entry.source);
}

/** Pull the citations out of one bot message. Trailing citations leave the
 * text entirely (they become chips at the end of the bubble); a link inside a
 * sentence keeps its words in place and also gets a chip; a library doc named
 * in plain text stays in the sentence and gets a chip (pass `docs`). */
export function extractSources(text: string, docs: readonly LibraryDocLike[] = []): { text: string; sources: SourceRef[] } {
  const linked = extractLinks(text);
  if (!docs.length) return linked;
  const cited = new Set(linked.sources.map((source) => source.docId).filter(Boolean));
  const named = mentionedDocs(linked.text, docs).filter((source) => !cited.has(source.docId));
  return named.length ? { text: linked.text, sources: [...named, ...linked.sources] } : linked;
}

function extractLinks(text: string): { text: string; sources: SourceRef[] } {
  const hits: Hit[] = [];
  for (const match of text.matchAll(ATTACHMENT)) {
    const path = match[1];
    const label = basename(path);
    hits.push({
      start: match.index,
      end: match.index + match[0].length,
      source: { key: `file:${path}`, kind: "file", label, title: label, target: path },
      replacement: "",
      alwaysRemove: true,
    });
  }
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    if (match[1] === "!") continue; // images stay images
    const label = match[2].trim();
    const target = match[3];
    const kind = classify(target);
    if (!kind || !label) continue;
    hits.push({
      start: match.index,
      end: match.index + match[0].length,
      source: { key: kind.key, kind: kind.kind, docId: kind.docId, version: kind.version, label, ...splitLabel(label), target },
      replacement: label,
      alwaysRemove: false,
    });
  }
  hits.sort((a, b) => a.start - b.start);

  // the trailing run: citations with nothing but separators after them
  const trailing = new Set<Hit>();
  let cursor = text.length;
  for (let i = hits.length - 1; i >= 0; i -= 1) {
    let j = cursor;
    while (j > hits[i].end && BETWEEN_CITATIONS.test(text[j - 1])) j -= 1;
    if (j !== hits[i].end) break;
    trailing.add(hits[i]);
    cursor = hits[i].start;
  }

  let out = "";
  let at = 0;
  for (const hit of hits) {
    if (hit.start < at) continue; // overlapping match (a link inside an attachment) — first wins
    out += text.slice(at, hit.start);
    out += hit.alwaysRemove || trailing.has(hit) ? "" : hit.replacement;
    at = hit.end;
  }
  out += text.slice(at);

  if (trailing.size) out = out.replace(DANGLING_TAIL, "");

  // a bare URL closing the message is a citation too ("来源：https://…")
  const closingUrls: SourceRef[] = [];
  for (let tail = TRAILING_URL.exec(out); tail; tail = TRAILING_URL.exec(out)) {
    const url = tail[2];
    const label = webLabel(url);
    closingUrls.unshift({ key: `web:${url.replace(/\/+$/, "")}`, kind: "web", label, title: label, target: url });
    out = out.slice(0, tail.index + tail[1].length).replace(DANGLING_TAIL, "");
  }
  const sources = [...hits.map((hit) => hit.source), ...closingUrls];
  return { text: out.replace(/[ \t]+\n/g, "\n").trimEnd(), sources };
}

type MessageLike = {
  id: string;
  at: number;
  role: "bot" | "user";
  kind: string;
  text?: string;
  from?: { botId: string; name: string };
};

export interface RoomSources {
  /** the numbered chips per message */
  byMessage: Map<string, NumberedSource[]>;
  /** each message's text with its trailing citations cut */
  texts: Map<string, string>;
  /** every distinct source, by number */
  list: CitedSource[];
}

/** Number every distinct source cited by the room's bots, in transcript order.
 * `docs` (the library) lets plain-text mentions of a doc count as citations. */
export function numberSources(messages: readonly MessageLike[], docs: readonly LibraryDocLike[] = []): RoomSources {
  const byMessage = new Map<string, NumberedSource[]>();
  const texts = new Map<string, string>();
  const list: CitedSource[] = [];
  const numbers = new Map<string, number>();
  for (const message of messages) {
    if (message.role !== "bot" || message.kind !== "text" || !message.text) continue;
    const { text, sources } = extractSources(message.text, docs);
    if (!sources.length) continue;
    texts.set(message.id, text);
    const chips: NumberedSource[] = [];
    for (const source of sources) {
      let n = numbers.get(source.key);
      if (n === undefined) {
        n = numbers.size + 1;
        numbers.set(source.key, n);
        list.push({ ...source, n, messageId: message.id, at: message.at, botId: message.from?.botId, name: message.from?.name, text });
      }
      if (!chips.some((chip) => chip.n === n)) chips.push({ ...source, n });
    }
    byMessage.set(message.id, chips);
  }
  return { byMessage, texts, list };
}

/** The newer version that replaced a cited library version, if any. */
export function supersededBy(source: Pick<SourceRef, "kind" | "docId" | "version">, docs: ReadonlyArray<{ id: string; versions: ReadonlyArray<{ version: number }> }>): number | undefined {
  if (source.kind !== "library" || !source.docId || source.version === undefined) return undefined;
  const doc = docs.find((candidate) => candidate.id === source.docId);
  if (!doc?.versions.length) return undefined;
  const latest = Math.max(...doc.versions.map((entry) => entry.version));
  return latest > source.version ? latest : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Which of a question's options a citing message argues for: exactly one
 * option's spoken token ("699") appears in it as a standalone figure. */
export function backedOption(text: string, options: readonly string[]): string | undefined {
  const tokens = [...new Set(options.map(choiceToken).filter(Boolean))];
  const found = tokens.filter((token) => new RegExp(`(?<![\\w.])${escapeRegExp(token)}(?![\\w.])`, "u").test(text));
  return found.length === 1 ? found[0] : undefined;
}

/** Map a decision's quoted basis ("渠道报价单") to the room's source numbers. */
export function basisNumbers(basis: readonly string[] | undefined, list: readonly Pick<CitedSource, "n" | "title" | "label">[]): Array<{ text: string; n?: number }> {
  return (basis ?? []).map((text) => {
    const needle = text.trim();
    const hit = list.find((source) => source.title === needle || source.label === needle) ??
      list.find((source) => needle && (source.title.includes(needle) || needle.includes(source.title)));
    return { text: needle, n: hit?.n };
  });
}
