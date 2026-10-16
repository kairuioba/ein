// Desktop-shell side of shared/i18n.ts. The Electron main process runs plain
// .mjs/.cjs without a TypeScript step, so this reads the same dictionary file
// directly. Usage from main-process modules:
//   import { t } from "./i18n.cjs";
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

const DEFAULT_LOCALE = "zh-CN";
const DICTIONARY_PATH = join(__dirname, "..", "shared", "i18n", "zh-CN.json");

let dictionary = {};
try {
  dictionary = JSON.parse(readFileSync(DICTIONARY_PATH, "utf8"));
} catch {
  dictionary = {};
}

function isLocale(value) {
  return value === "zh-CN" || value === "en";
}

function detectLocale(env = process.env) {
  if (isLocale(env.OMB_LOCALE)) return env.OMB_LOCALE;
  if (env.VITEST || env.NODE_TEST_CONTEXT) return "en";
  return DEFAULT_LOCALE;
}

let current = detectLocale();

function getLocale() {
  return current;
}

function setLocale(locale) {
  if (isLocale(locale)) current = locale;
}

function interpolate(text, params) {
  return text.replace(/\{(\w+)\}/g, (match, key) => {
    const value = params[key];
    return value === undefined || value === null ? match : String(value);
  });
}

function t(source, params) {
  // own keys only: "constructor" or "toString" must not resolve to Object.prototype
  const localized = current !== "en" && Object.hasOwn(dictionary, source) ? dictionary[source] : source;
  return params ? interpolate(localized, params) : localized;
}

function tn(count, singular, plural, params) {
  return t(count === 1 ? singular : plural, { count, ...params });
}

/** Mark a source for translation without translating it (see shared/i18n.ts). */
function msg(source) {
  return source;
}

function intlLocale() {
  return current === "zh-CN" ? "zh-CN" : "en-US";
}

/** The desktop app's stored language lives next to its other settings so the
 * menus are right before any window exists. */
function loadStoredLocale(userDataDir) {
  try {
    const stored = JSON.parse(readFileSync(join(userDataDir, "locale.json"), "utf8"));
    if (isLocale(stored.locale) && !isLocale(process.env.OMB_LOCALE)) current = stored.locale;
  } catch {
    // first launch: keep the default
  }
  return current;
}

function saveStoredLocale(userDataDir, locale) {
  if (!isLocale(locale)) return false;
  const path = join(userDataDir, "locale.json");
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ locale }, null, 2));
  current = locale;
  return true;
}

module.exports = {
  DEFAULT_LOCALE,
  detectLocale,
  getLocale,
  interpolate,
  intlLocale,
  isLocale,
  loadStoredLocale,
  msg,
  saveStoredLocale,
  setLocale,
  t,
  tn,
};
