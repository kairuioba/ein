// Settings → General → Language. A switch reloads the window so every
// component, the harness (which bots reply in) and the desktop menus change
// together instead of leaving half the app in the old language.
import { useState } from "react";
import { Loader2 } from "lucide-react";

import { api } from "@/state/store";
import { cn } from "@/lib/cn";
import { LOCALE_OPTIONS, getLocale, rememberLocale, t, type Locale } from "@/lib/i18n";
import { Card } from "./SettingsPrimitives";

export function LanguageSettings() {
  const current = getLocale();
  const [pending, setPending] = useState<Locale | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = async (locale: Locale) => {
    if (locale === current || pending) return;
    setPending(locale);
    setError(null);
    try {
      await api("/api/config", { method: "PATCH", body: JSON.stringify({ locale }) });
      // the desktop shell rebuilds its menus; a plain browser tab has no shell
      await window.ogb?.setLocale?.(locale).catch(() => false);
      rememberLocale(locale);
      window.location.reload();
    } catch (cause) {
      setPending(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <Card
      title={t("Language")}
      subtitle={t("Applies to the app, the menu bar and the replies bots write to you. Code, commands and file names are never translated.")}
    >
      <div className="inline-flex rounded-xl bg-inset p-1" role="radiogroup" aria-label={t("Language")}>
        {LOCALE_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            lang={option.id}
            aria-checked={current === option.id}
            disabled={pending !== null}
            onClick={() => void choose(option.id)}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[12.5px] transition-colors disabled:opacity-60",
              current === option.id ? "bg-raised text-ink shadow" : "text-ink-secondary hover:text-ink",
            )}
          >
            {pending === option.id && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
            {option.label}
          </button>
        ))}
      </div>
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    </Card>
  );
}
