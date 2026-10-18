// Prominent one-click update prompt, shown once the background updater has
// already downloaded a newer version. The small UpdateBanner stays for
// "available/downloading/error"; this modal owns the moment when a restart is
// all that is left, so the user can update from the launch screen in one click.
import { useEffect, useState } from "react";
import { Download, Loader2, Sparkles } from "lucide-react";

import { Button } from "@/components/ui";
import { useUpdaterState, type UpdaterState } from "@/lib/updater";
import { t } from "@/lib/i18n";

const SNOOZE_KEY = "ein.update.prompt-snooze";
const SNOOZE_MS = 24 * 60 * 60 * 1000;

interface Snooze {
  version: string;
  until: number;
}

/** Parse the snooze record; a torn/foreign value means "no snooze". */
export function parseUpdateSnooze(raw: string | null): Snooze | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; until?: unknown };
    if (typeof parsed.version !== "string" || !parsed.version) return null;
    if (typeof parsed.until !== "number" || !Number.isFinite(parsed.until)) return null;
    return { version: parsed.version, until: parsed.until };
  } catch {
    return null;
  }
}

/** Password-manager style local snooze: only this exact version, until the
 * timestamp. Anything else prompts immediately. */
export function isUpdatePromptSnoozed(state: Pick<UpdaterState, "status" | "version"> | null, now: number, raw: string | null): boolean {
  if (!state || state.status !== "downloaded" || !state.version) return false;
  const snooze = parseUpdateSnooze(raw);
  return Boolean(snooze && snooze.version === state.version && now < snooze.until);
}

export function updatePromptVisible(state: UpdaterState | null, now: number, storage?: Storage | null): boolean {
  if (!state || state.status !== "downloaded" || !state.version) return false;
  try {
    return !isUpdatePromptSnoozed(state, now, storage?.getItem(SNOOZE_KEY) ?? null);
  } catch {
    return true;
  }
}

function snooze(version: string, now = Date.now()): void {
  try {
    localStorage.setItem(SNOOZE_KEY, JSON.stringify({ version, until: now + SNOOZE_MS }));
  } catch {
    // storage full/disabled: the prompt simply appears again next launch
  }
}

/** Pure view: everything the user sees, testable without a native bridge. */
export function UpdatePromptView({
  version,
  installing,
  onInstall,
  onLater,
}: {
  version?: string;
  installing?: boolean;
  onInstall: () => void;
  onLater: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-black/45 p-4" role="dialog" aria-modal="true" aria-label={t("Update available")}>
      <div className="animate-panel-in w-full max-w-[380px] rounded-2xl border border-hairline/40 bg-panel p-5 shadow-2xl shadow-black/50">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
            <Sparkles size={17} />
          </span>
          <div className="min-w-0">
            <div className="text-[15px] font-semibold text-ink">{t("A new version of Ein is ready")}</div>
            <div className="mt-0.5 text-[12.5px] text-ink-secondary">{version ? t("Version {version} has been downloaded.", { version }) : t("The update has been downloaded.")}</div>
          </div>
        </div>
        <p className="mt-3 text-[12.5px] leading-relaxed text-ink-secondary">
          {t("One click restarts Ein into the new version. Your tasks, chats and settings stay on this computer.")}
        </p>
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="soft" onClick={onLater} disabled={installing}>
            {t("Later")}
          </Button>
          <Button onClick={onInstall} disabled={installing} className="gap-1.5">
            {installing ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            {installing ? t("Restarting…") : t("Update now and restart")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function UpdatePrompt() {
  const state = useUpdaterState();
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const status = state?.status;
  useEffect(() => {
    if (status !== "installing") setInstalling(false);
  }, [status]);
  const storage = typeof window !== "undefined" ? window.localStorage : null;
  const visible = updatePromptVisible(state, Date.now(), storage) && dismissedVersion !== state?.version;
  if (!visible || !state?.version || !window.ogb?.updater) return null;
  const updater = window.ogb.updater;
  return (
    <UpdatePromptView
      version={state.version}
      installing={installing || state.status === "installing"}
      onInstall={() => {
        setInstalling(true);
        try {
          void updater.install();
        } catch {
          setInstalling(false);
        }
      }}
      onLater={() => {
        snooze(state.version!);
        setDismissedVersion(state.version ?? null);
      }}
    />
  );
}
