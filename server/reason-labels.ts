// Machine reason codes ("rate_limited", "exit_before_result", …) that end up
// in chat status chips, as words in the app's language. English keeps the
// raw code exactly as before, so existing chips and tests read the same.
import { getLocale, msg, t } from "../shared/i18n.ts";

const LABELS: Readonly<Record<string, string>> = {
  rate_limited: msg("rate limited"),
  overloaded: msg("the provider is overloaded"),
  server_error: msg("the provider had a server error"),
  connection_reset: msg("the connection dropped"),
  timeout: msg("timed out"),
  auth: msg("sign-in required"),
  auth_required: msg("sign-in required"),
  quota: msg("quota used up"),
  interrupted: msg("interrupted"),
  cancelled: msg("canceled"),
  canceled: msg("canceled"),
  disposed: msg("the engine was shut down"),
  stalled: msg("no activity, stopped"),
  failed: msg("failed"),
  error: msg("error"),
  unknown: msg("unknown reason"),
  rpc_error: msg("the engine reported an error"),
  exit_before_result: msg("the engine exited before answering"),
  terminal_exit: msg("the engine exited"),
  spawn_error: msg("the engine could not start"),
  stdin_write_failed: msg("could not talk to the engine"),
  unknown_model: msg("the model is not available"),
  invalid_request: msg("the request was rejected"),
  not_found: msg("not found"),
  prompt_too_large: msg("the prompt is too large"),
  mcp_config_error: msg("the tool configuration failed"),
  end_turn: msg("finished"),
};

/** A reason code as words; free text (an engine's own message) passes through. */
export function reasonLabel(reason: string | null | undefined): string {
  const code = (reason ?? "").trim();
  if (getLocale() === "en") return code;
  if (!code) return t("unknown reason");
  return Object.hasOwn(LABELS, code) ? t(LABELS[code]!) : code;
}
