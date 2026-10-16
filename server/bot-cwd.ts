// A bot's working folder — where its shell tools run. Validated here, once,
// so a bad path is refused at PATCH time with a reason the settings panel
// can show, rather than surfacing later as a driver spawn failure.
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import { t } from "../shared/i18n.ts";

export type CwdValidation = { ok: true; cwd: string | null } | { ok: false; error: string };

export function validateBotCwd(input: unknown): CwdValidation {
  if (input === null) return { ok: true, cwd: null };
  if (typeof input !== "string") return { ok: false, error: t("working folder must be a path") };
  const trimmed = input.trim();
  if (!trimmed) return { ok: true, cwd: null };
  const expanded = trimmed === "~" || trimmed.startsWith("~/") ? homedir() + trimmed.slice(1) : trimmed;
  if (!isAbsolute(expanded)) return { ok: false, error: t("working folder must be an absolute path") };
  const cwd = resolve(expanded);
  let stat;
  try {
    stat = statSync(cwd);
  } catch {
    return { ok: false, error: t("that folder doesn't exist: {path}", { path: cwd }) };
  }
  if (!stat.isDirectory()) return { ok: false, error: t("that path is not a folder: {path}", { path: cwd }) };
  return { ok: true, cwd };
}
