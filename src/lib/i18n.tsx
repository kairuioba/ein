// App-side localization helpers. Components import from here:
//   import { t } from "@/lib/i18n";
// See shared/i18n.ts for the source-string model.
import { Fragment, type ReactNode } from "react";

import {
  LOCALE_STORAGE_KEY,
  getLocale,
  intlLocale,
  isLocale,
  setLocale,
  t,
  type Locale,
  type TranslationParams,
} from "../../shared/i18n";

export {
  DEFAULT_LOCALE,
  LOCALE_OPTIONS,
  LOCALE_STORAGE_KEY,
  getLocale,
  hasTranslation,
  intlLocale,
  isLocale,
  msg,
  setLocale,
  t,
  tn,
  type Locale,
  type TranslationParams,
} from "../../shared/i18n";

/** Translate a source containing simple inline tags such as
 * "Press <kbd>⌘K</kbd> to search". Each tag in the localized string is
 * rendered by the matching function in `tags`; unknown tags keep their text. */
export function tRich(
  source: string,
  tags: Record<string, (children: ReactNode) => ReactNode>,
  params?: TranslationParams,
): ReactNode {
  const text = t(source, params);
  const parts: ReactNode[] = [];
  const pattern = /<(\w+)>([\s\S]*?)<\/\1>/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    const render = tags[match[1]];
    parts.push(<Fragment key={key++}>{render ? render(match[2]) : match[2]}</Fragment>);
    cursor = pattern.lastIndex;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

/** Persist a language choice and apply it. The caller reloads the window so
 * every component, the harness and the desktop menus pick it up together. */
export function rememberLocale(locale: Locale): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // the choice still applies for this session
  }
  setLocale(locale);
}

/** The persisted choice, when one exists. */
export function storedLocale(): Locale | null {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** Date and number formatting in the active language. */
export function formatDateTime(value: number | Date, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(intlLocale(), options).format(value);
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(intlLocale(), options).format(value);
}

/** True when the app is showing Chinese copy. */
export function isChinese(): boolean {
  return getLocale() === "zh-CN";
}
