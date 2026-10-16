import { msg, t } from "@/lib/i18n";
import type { Message } from "@/state/store";

const FALLBACK_LABELS: Array<[RegExp, string]> = [
  [/\b(?:bash|shell|terminal|exec|command|run_command)\b/i, msg("Running a command")],
  [/\b(?:read|read_file|view|open_file)\b/i, msg("Reading a file")],
  [/\b(?:write|write_file|create_file)\b/i, msg("Writing a file")],
  [/\b(?:edit|apply_patch|replace|str_replace)\b/i, msg("Editing a file")],
  [/\b(?:web_search|search_web)\b/i, msg("Searching the web")],
  [/\b(?:web_fetch|fetch_url|read_page)\b/i, msg("Reading a page")],
  [/\b(?:grep|glob|find|search)\b/i, msg("Searching")],
  [/\b(?:screenshot|screen_capture)\b/i, msg("Looking at the screen")],
  [/\b(?:click|type|keypress|press|scroll|computer)\b/i, msg("Using the computer")],
  [/\b(?:open_url|navigate)\b/i, msg("Opening a page")],
  [/\b(?:list_bots|list_agents)\b/i, msg("Checking who's around")],
  [/\bdelegate_bot\b/i, msg("Handing off a task")],
  [/\b(?:ask_bot|send_message)\b/i, msg("Asking a teammate")],
];

function sentenceCase(value: string): string {
  const trimmed = value.trim().replace(/[.\s]+$/, "");
  if (!trimmed) return t("Thinking");
  return `${trimmed[0].toUpperCase()}${trimmed.slice(1)}`;
}

/**
 * The one quiet line shown while an agent is working. This follows t3code's
 * live-activity model: thinking before a tool starts, then the current verb.
 * The server-provided narration is authoritative; fallbacks cover older
 * messages and third-party drivers that only report a tool name.
 */
export function liveActivityLabel(message?: Message): string {
  if (
    message?.kind !== "activity" ||
    !message.tool ||
    message.tool.ok !== undefined ||
    message.comm
  ) {
    return t("Thinking");
  }

  if (message.tool.spoken?.trim()) return sentenceCase(message.tool.spoken);

  const toolName = message.tool.name.replace(/^mcp__[^_]+__/, "").split(":", 1)[0] ?? "";
  for (const [pattern, label] of FALLBACK_LABELS) {
    if (pattern.test(toolName)) return t(label);
  }
  return t("Working");
}
