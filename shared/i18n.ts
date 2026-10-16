// Source-string localization shared by the app, the harness server and the
// desktop shell.
//
// The English text written in the code IS the lookup key: `t("Team map")`
// returns the localized string when the active dictionary has one and the
// English source otherwise. Untranslated copy therefore still renders, code
// stays readable next to upstream, and the English test suites keep asserting
// on the source strings (they run with the "en" locale, see detectLocale).
//
// Placeholders use `{name}` and are filled from `params`. Keep markup out of
// sources; split a sentence around inline elements or use tRich in the app.
import zhCN from "./i18n/zh-CN.json" with { type: "json" };

export type Locale = "zh-CN" | "en";
export const DEFAULT_LOCALE: Locale = "zh-CN";
export const LOCALE_STORAGE_KEY = "omb.locale";
export const LOCALE_OPTIONS: ReadonlyArray<{ id: Locale; label: string }> = [
  { id: "zh-CN", label: "简体中文" },
  { id: "en", label: "English" },
];

export type TranslationParams = Record<string, string | number | null | undefined>;

const DICTIONARIES: Record<Locale, Readonly<Record<string, string>>> = {
  "zh-CN": zhCN as Readonly<Record<string, string>>,
  en: {},
};

export function isLocale(value: unknown): value is Locale {
  return value === "zh-CN" || value === "en";
}

interface LocaleEnvironment {
  env?: Record<string, string | undefined>;
  /** The desktop shell's saved choice (window.ogb.locale in the app window). */
  shell?: string | null;
  storage?: { getItem(key: string): string | null };
}

/** The locale a fresh process starts in: an explicit OMB_LOCALE wins, test
 * runners use the English sources, the desktop shell's saved choice comes
 * next (it survives the server port changing, which browser storage does
 * not), then a stored browser choice, and everything else starts in
 * Simplified Chinese. */
export function detectLocale(environment: LocaleEnvironment = currentEnvironment()): Locale {
  const forced = environment.env?.OMB_LOCALE;
  if (isLocale(forced)) return forced;
  if (environment.env?.VITEST || environment.env?.NODE_TEST_CONTEXT) return "en";
  if (isLocale(environment.shell)) return environment.shell;
  try {
    const stored = environment.storage?.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // storage can be unavailable (privacy modes, server processes)
  }
  return DEFAULT_LOCALE;
}

function currentEnvironment(): LocaleEnvironment {
  const scope = globalThis as {
    process?: { env?: Record<string, string | undefined> };
    localStorage?: { getItem(key: string): string | null };
    ogb?: { locale?: string | null };
  };
  let storage: LocaleEnvironment["storage"];
  try {
    storage = scope.localStorage;
  } catch {
    storage = undefined;
  }
  return { env: scope.process?.env, shell: scope.ogb?.locale, storage };
}

let current: Locale = detectLocale();

export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale): void {
  current = locale;
}

/** Fill `{name}` placeholders. Unknown or empty params leave the placeholder
 * visible rather than printing "undefined". */
export function interpolate(text: string, params: TranslationParams): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = params[key];
    return value === undefined || value === null ? match : String(value);
  });
}

/** Translate English source text into the active locale. */
export function t(source: string, params?: TranslationParams): string {
  const dictionary = DICTIONARIES[current];
  // own keys only: "constructor" or "toString" must not resolve to Object.prototype
  const localized = current !== "en" && Object.hasOwn(dictionary, source) ? dictionary[source]! : source;
  return params ? interpolate(localized, params) : localized;
}

/** Count-aware variant: English keeps its singular/plural sources, and the
 * count is available to both as `{count}`. */
export function tn(count: number, singular: string, plural: string, params?: TranslationParams): string {
  return t(count === 1 ? singular : plural, { count, ...params });
}

/** Mark English source text for translation WITHOUT translating it yet —
 * for label tables whose values are compared or stored as identifiers and
 * translated later at display time with `t(label)`. The i18n check collects
 * msg("…") sources the same way as t("…"). */
export function msg<const Source extends string>(source: Source): Source {
  return source;
}

/** True when the active dictionary has an entry for `source`. */
export function hasTranslation(source: string): boolean {
  return current === "en" || Object.hasOwn(DICTIONARIES[current], source);
}

/** BCP 47 tag for Intl and toLocale* formatting in the active locale. */
export function intlLocale(): string {
  return current === "zh-CN" ? "zh-CN" : "en-US";
}

/** The instruction appended to every bot's system prompt so replies follow
 * the app's language. Empty for English, which needs no instruction. */
export function replyLanguageInstruction(): string {
  return current === "zh-CN"
    ? "Language: reply to the user in Simplified Chinese (简体中文) unless the user writes in another language or explicitly asks for one. Text you put into tools that the user will see — plan goals, subtask titles and roles, task names, names and titles of new teammates — is written in Simplified Chinese too. Keep code, commands, file paths and identifiers unchanged."
    : "";
}
