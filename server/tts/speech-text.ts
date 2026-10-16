// The spoken register — turning an agent's answer into something worth
// hearing.
//
// Agents write for a screen: fenced code, file paths, tables, link soup,
// bullet scaffolding. Read aloud verbatim that is unbearable — a 40-line
// diff becomes four minutes of punctuation, and `server/drivers/acp/core.ts`
// becomes "server slash drivers slash a c p slash core dot t s".
//
// So every string is passed through here before it reaches a voice. The
// rule is: say the prose, name the artifacts, drop the syntax. A code block
// becomes "a code block" — the user is looking at the screen if they care,
// and this is the half of the feature that decides whether it is pleasant.
//
// Pure and synchronous on purpose: it is the piece most likely to need
// tuning against real transcripts, so it stays trivially testable.
import { msg, t } from "../../shared/i18n.ts";

/** A fenced block becomes a mention of itself, with its language if known. */
function describeCodeBlock(fence: string): string {
  const lang = fence.trim().split(/\s+/)[0]?.replace(/[^a-z0-9+#]/gi, "") ?? "";
  type SpokenLanguages = Record<string, string>;
  const spoken: SpokenLanguages = {
    ts: "TypeScript",
    tsx: "TypeScript",
    js: "JavaScript",
    jsx: "JavaScript",
    py: "Python",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    json: "JSON",
    yml: "YAML",
    yaml: "YAML",
    sql: "SQL",
    rs: "Rust",
    go: "Go",
    swift: "Swift",
    diff: "diff",
  };
  const name = spoken[lang.toLowerCase()];
  return name ? `. ${t("(a {language} code block)", { language: name })} ` : `. ${t("(a code block)")} `;
}

/** `a/b/c/file.ts` → `file.ts`. A path's directories are for the eye. */
function shortenPaths(text: string): string {
  return text.replace(/(?:[\w.@-]+\/){1,}([\w.-]+\.\w{1,6})\b/g, "$1");
}

/** Trailing punctuation that already ends a sentence (Latin or CJK). */
const ENDS_SENTENCE = /[.!?:;。！？：；]\s*$/;

/** One CJK character or full-width punctuation mark. */
const CJK = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/**
 * Markdown (or any agent output) → a line a voice can read.
 *
 * Not a markdown parser: a sequence of narrow, ordered replacements, which
 * is both fast enough to run per token-flush and easy to reason about when
 * one of them misfires on a real transcript.
 */
export function speakable(input: string): string {
  if (!input) return "";
  let text = input;

  // fenced code first — everything inside must survive none of the rules below
  text = text.replace(/```([^\n]*)\n[\s\S]*?(?:```|$)/g, (_m, fence: string) => describeCodeBlock(fence));
  text = text.replace(/~~~([^\n]*)\n[\s\S]*?(?:~~~|$)/g, (_m, fence: string) => describeCodeBlock(fence));

  // images before links — the syntax differs by one character
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) =>
    alt ? `. ${t("(image: {alt})", { alt })} ` : `. ${t("(an image)")} `,
  );
  // [label](url) → label; a bare url becomes a noun rather than an alphabet soup
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/<https?:\/\/[^>\s]+>/g, ` ${t("a link")} `);
  text = text.replace(/\bhttps?:\/\/\S+/g, ` ${t("a link")} `);

  // tables: a grid is hopeless aloud, and the separator row is pure noise
  text = text.replace(/^\s*\|?[\s:-]*\|[\s|:-]*$/gm, "");
  text = text.replace(/^\s*\|(.+)\|\s*$/gm, (_m, row: string) =>
    row
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean)
      .join(", "),
  );

  // inline code: keep short identifiers (they carry meaning), drop long ones
  text = text.replace(/`([^`\n]+)`/g, (_m, code: string) => (code.length <= 40 ? code : ` ${t("that snippet")} `));

  // headings become sentences so the voice pauses instead of running on
  text = text.replace(/^\s{0,3}#{1,6}\s+(.*)$/gm, (_m, head: string) =>
    ENDS_SENTENCE.test(head) ? head : `${head.trim()}.`,
  );

  // list scaffolding: the marker is visual, the pause is what matters
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+[.)]\s+/gm, "");
  text = text.replace(/^\s*>\s?/gm, "");
  text = text.replace(/^\s*(?:[-*_]\s*){3,}$/gm, "");

  // emphasis / strikethrough markers
  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
  text = text.replace(/(\*|_)(?=\S)(.*?)(?<=\S)\1/g, "$2");
  text = text.replace(/~~(.*?)~~/g, "$1");

  // checkboxes read as literal brackets otherwise
  text = text.replace(/\[[ xX]\]\s*/g, "");

  text = shortenPaths(text);

  // emoji and the pictographic ranges: a voice either ignores them or,
  // worse, announces them by name
  text = text.replace(
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu,
    "",
  );

  // a blank line is a paragraph break — make it an audible one
  text = text.replace(/\n{2,}/g, ". ");
  text = text.replace(/\n/g, ". ");

  // tidy the punctuation the substitutions above inevitably pile up
  text = text.replace(/\s+/g, " ");
  text = text.replace(/\s+([.,!?;:])/g, "$1");
  text = text.replace(/(?:\.\s*){2,}/g, ". ");
  text = text.replace(/,\s*\./g, ".");
  // Chinese: the paragraph and heading rules above add Latin full stops.
  // After CJK punctuation they are noise; after a CJK character they become
  // 。 so a Chinese voice pauses instead of saying "dot".
  text = text.replace(/([。！？；：，、])\s*\.\s*/g, "$1");
  text = text.replace(/([\u3400-\u9fff])\.\s*/g, "$1。");
  text = text.replace(/\s+([。！？；：，、])/g, "$1");
  text = text.trim();

  // The paragraph→". " rule turns whitespace-only input into a lone full
  // stop, which a synthesizer happily renders as a click. Nothing to say
  // means nothing to send.
  return /[\p{L}\p{N}]/u.test(text) ? text : "";
}

/** Sentence-ish boundary: `.`/`!`/`?` followed by space, but not inside a
 * decimal, an ellipsis, or a common abbreviation. */
const BOUNDARY = /(?<!\b(?:e\.g|i\.e|etc|vs|Dr|Mr|Mrs|Ms|No|approx))(?<![.\d])([.!?])(["')\]]*)\s+/g;

/** Chinese and Japanese end a sentence with no space after it. */
const CJK_BOUNDARY = /([。！？])([”’」』）)\]"']*)\s*/g;

/**
 * Split speakable text into utterances a synthesizer can start on.
 *
 * Both tiers want this: cloud TTS charges and buffers per request, and the
 * local model generates per utterance — so the unit of work is a sentence
 * either way. Very short fragments are glued onto their neighbour, because
 * a synthesizer given two words produces two words of flat, contextless
 * prosody.
 */
export function toUtterances(input: string, { minChars = 12, maxChars = 320 } = {}): string[] {
  const text = speakable(input);
  if (!text) return [];

  // Split on a sentinel, never on the whitespace itself: the boundary
  // match consumes the trailing space, so splitting on " " would split
  // every word in the text rather than every sentence.
  const MARK = "\u0000";
  const rough = text
    .replace(BOUNDARY, `$1$2${MARK}`)
    .replace(CJK_BOUNDARY, `$1$2${MARK}`)
    .split(MARK)
    .map((s) => s.trim())
    .filter(Boolean);

  const out: string[] = [];
  for (const piece of rough) {
    // a sentence longer than the cap is broken at a clause, never mid-word
    const parts = piece.length <= maxChars ? [piece] : splitLong(piece, maxChars);
    for (const part of parts) {
      const prev = out[out.length - 1];
      if (prev && (spokenWeight(prev) < minChars || spokenWeight(part) < minChars)) {
        out[out.length - 1] = joinSpoken(prev, part);
      } else {
        out.push(part);
      }
    }
  }
  return out;
}

/** Length for the "too short to say alone" test. A CJK character carries
 * about as much as a short word, so it counts twice: 「好的。」 is still glued
 * to its neighbour, a ten-character Chinese sentence stands on its own. */
function spokenWeight(text: string): number {
  let cjk = 0;
  for (const char of text) if (CJK.test(char)) cjk += 1;
  return text.length + cjk;
}

/** Glue two utterances: a space between words, none between CJK text. */
function joinSpoken(a: string, b: string): string {
  return CJK.test(a.slice(-1)) || CJK.test(b.charAt(0)) ? `${a}${b}` : `${a} ${b}`;
}

/** Clause breaks, Latin and CJK. A cut lands right after the mark. */
const CLAUSE_BREAKS = [", ", "; ", " — ", "，", "；", "：", "、"];

function splitLong(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    // prefer a clause break, then any space; never cut a word in half
    const at = Math.max(...CLAUSE_BREAKS.map((mark) => window.lastIndexOf(mark)));
    let cut = at > maxChars / 2 ? at + 1 : window.lastIndexOf(" ");
    // text without spaces (Chinese, Japanese) has no words to keep whole
    if (cut <= 0) cut = maxChars;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** A tool-activity chip as a spoken progress line ("reading core.ts").
 * Returns null for chips not worth interrupting the ear for. */
export function narrateTool(toolName: string): string | null {
  const name = toolName.replace(/^mcp__[^_]+__/, "").trim();
  if (!name) return null;
  // the harness writes these as chips too; they are already spoken elsewhere
  if (/^(auto-approved|error):/i.test(name)) return null;

  const bare = name.toLowerCase();
  const verbs: Array<[RegExp, string]> = [
    [/^(bash|shell|terminal|run_command|execute|computer_exec)$/, msg("running a command")],
    [/^(read|read_file|view)$/, msg("reading a file")],
    [/^(write|create_file)$/, msg("writing a file")],
    [/^(edit|apply_patch|str_replace|multiedit)$/, msg("editing a file")],
    [/^(grep|search|glob|find)$/, msg("searching")],
    [/^(web_?search|websearch)$/, msg("searching the web")],
    [/^(web_?fetch|fetch)$/, msg("reading a page")],
    [/^screenshot$/, msg("looking at the screen")],
    [/^(click|type_text|press_key|scroll|computer_batch)$/, msg("using the computer")],
    [/^open_url$/, msg("opening a page")],
    [/^list_bots$/, msg("checking who's around")],
    [/^ask_bot$/, msg("asking a teammate")],
  ];
  for (const [pattern, phrase] of verbs) {
    if (pattern.test(bare)) return t(phrase);
  }
  // an unrecognized tool still deserves a beat, but not its raw argv
  const short = shortenPaths(name).slice(0, 40);
  return /^[\w .:/-]+$/.test(short) ? t("running {tool}", { tool: short }) : null;
}
