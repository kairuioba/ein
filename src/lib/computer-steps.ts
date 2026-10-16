// The 步骤记录 strip under a bot's live screen (U16): the steps of the bot's
// latest stretch of work, each with the screen frame that followed it, its
// label and how many times it failed. Built only from the transcript's
// activity and screen messages.
import { msg, t } from "@/lib/i18n";
import type { Message } from "@/state/store";

export interface ComputerStep {
  id: string;
  at: number;
  /** short verb phrase, e.g. "Running a command" */
  label: string;
  /** what the tool acted on, when the chip carries it (e.g. "pnpm test") */
  detail?: string;
  /** failed attempts folded into this step */
  failed: number;
  /** the latest screen frame captured during this step */
  frame?: { png: string; mime: string; at: number };
  /** still running */
  live: boolean;
}

// short step names (a thumbnail label is about 100px wide)
const LABELS: Array<[RegExp, string]> = [
  [/\b(?:bash|shell|terminal|exec|command|run_command|computer_exec)\b/i, msg("Run a command")],
  [/\b(?:read|read_file|view|open_file)\b/i, msg("Read a file")],
  [/\b(?:write|write_file|create_file)\b/i, msg("Write a file")],
  [/\b(?:edit|multiedit|apply_patch|replace|str_replace)\b/i, msg("Edit a file")],
  [/\b(?:web_search|search_web|websearch)\b/i, msg("Search the web")],
  [/\b(?:web_fetch|fetch_url|read_page)\b/i, msg("Read a page")],
  [/\b(?:open_url|navigate|goto)\b/i, msg("Open a page")],
  [/\b(?:screenshot|screen_capture)\b/i, msg("Look at the screen")],
  [/\b(?:type_text|type|keypress|press_key|press)\b/i, msg("Type")],
  [/\b(?:click|double_click|left_click)\b/i, msg("Click")],
  [/\b(?:scroll)\b/i, msg("Scroll")],
  [/\b(?:computer|computer_batch)\b/i, msg("Use the computer")],
  [/\b(?:grep|glob|find|search)\b/i, msg("Search")],
]

function sentenceCase(value: string): string {
  const trimmed = value.trim().replace(/[.\s]+$/, "");
  return trimmed ? `${trimmed[0]!.toUpperCase()}${trimmed.slice(1)}` : trimmed;
}

/** "Bash: pnpm test" → { name: "Bash", detail: "pnpm test" }; MCP prefixes dropped. */
export function splitToolName(raw: string): { name: string; detail?: string } {
  const cleaned = raw.replace(/^mcp__[^_]+__/, "").trim();
  const colon = cleaned.indexOf(":");
  if (colon <= 0) return { name: cleaned };
  const detail = cleaned.slice(colon + 1).trim();
  return { name: cleaned.slice(0, colon).trim(), detail: detail ? detail.slice(0, 60) : undefined };
}

/** A known tool gets its short name; otherwise the server's narration, then
 * the tool's own name. */
export function stepLabel(tool: NonNullable<Message["tool"]>): string {
  const { name } = splitToolName(tool.name);
  for (const [pattern, label] of LABELS) if (pattern.test(name)) return t(label);
  if (tool.spoken?.trim()) return sentenceCase(tool.spoken);
  return name.replace(/[_-]+/g, " ").slice(0, 32) || t("Working");
}

const isStep = (message: Message) => message.kind === "activity" && Boolean(message.tool) && !message.comm;

/** The steps of the bot's most recent stretch of work: everything after the
 * last message you sent, or — when nothing happened since — the stretch
 * before it. Consecutive attempts at the same action fold into one step. */
export function computerSteps(messages: readonly Message[], options: { busy?: boolean; max?: number } = {}): ComputerStep[] {
  const max = options.max ?? 6;
  const lastUser = (() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) if (messages[index]!.role === "user") return index;
    return -1;
  })();
  let slice = messages.slice(lastUser + 1);
  if (!slice.some((message) => isStep(message) || message.kind === "screen")) {
    const previousUser = (() => {
      for (let index = lastUser - 1; index >= 0; index -= 1) if (messages[index]!.role === "user") return index;
      return -1;
    })();
    slice = lastUser >= 0 ? messages.slice(previousUser + 1, lastUser) : [];
  }

  const steps: ComputerStep[] = [];
  for (const message of slice) {
    if (isStep(message)) {
      const tool = message.tool!;
      const label = stepLabel(tool);
      const { detail } = splitToolName(tool.name);
      const previous = steps.at(-1);
      // a retry of the same action (same label and target) stays one step
      if (previous && previous.label === label && previous.detail === detail && !previous.frame) {
        previous.failed += tool.ok === false ? 1 : 0;
        previous.live = tool.ok === undefined;
        previous.at = message.at;
        continue;
      }
      steps.push({ id: message.id, at: message.at, label, detail, failed: tool.ok === false ? 1 : 0, live: tool.ok === undefined });
      continue;
    }
    if (message.kind === "screen" && message.png) {
      const frame = { png: message.png, mime: message.mime ?? "image/png", at: message.at };
      const previous = steps.at(-1);
      if (previous) previous.frame = frame;
      else steps.push({ id: message.id, at: message.at, label: t("Look at the screen"), failed: 0, frame, live: false });
    }
  }
  if (!options.busy) for (const step of steps) step.live = false;
  return steps.slice(-max);
}

/** "3:12" between the first and last step. */
export function stepsSpan(steps: readonly ComputerStep[]): string {
  if (steps.length < 2) return "0:00";
  const seconds = Math.max(0, Math.round((steps[steps.length - 1]!.at - steps[0]!.at) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
