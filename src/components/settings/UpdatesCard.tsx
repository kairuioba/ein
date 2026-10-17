// Settings › Updates: which version runs, and one button. "Check for
// updates" finds a new version, downloads it and restarts into it; one found
// in the background downloads on its own and waits here (or for the app to
// quit). Mac builds without an Apple signature update by swapping their own
// bundle (electron/bundle-updater.mjs), so the copy must live in Applications.
import { Loader2 } from "lucide-react";

import { useUpdaterState } from "@/lib/updater";
import { t } from "@/lib/i18n";
import { Card } from "@/components/SettingsPrimitives";

export function UpdatesCard() {
  const s = useUpdaterState();
  if (!window.ogb?.updater) {
    return <Card title={t("Updates")} subtitle={t("Updates are handled by the desktop app. This window is not running inside it.")} />;
  }
  const updater = window.ogb.updater;
  const current = s?.current ? t("Version {version}", { version: s.current }) : null;
  if (s?.unavailable) {
    return (
      <Card
        title={t("Updates")}
        subtitle={[current, t("This build has no update feed. Install new versions from the release page.")].filter(Boolean).join(" · ")}
      />
    );
  }
  const status = s?.status ?? "idle";
  const busy = status === "checking" || status === "available" || status === "downloading" || status === "installing";
  const line =
    status === "checking"
      ? t("Checking…")
      : status === "available"
        ? t("Found {version} — downloading", { version: s?.version ?? "" })
        : status === "downloading"
          ? s?.percent == null
            ? t("Downloading {version}…", { version: s?.version ?? "" })
            : t("Downloading {version} · {percent}%", { version: s?.version ?? "", percent: Math.round(s.percent) })
          : status === "downloaded"
            ? t("{version} is ready — restart to finish, or it goes in when you quit", { version: s?.version ?? "" })
            : status === "installing"
              ? t("Restarting into the new version…")
              : status === "error"
                ? t("Check failed: {message}", { message: s?.message ?? t("unknown error") })
                : t("You're on the latest version we know of.");
  return (
    <Card title={t("Updates")} subtitle={[current, line].filter(Boolean).join(" · ")}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <button
          type="button"
          onClick={() => void (status === "downloaded" ? updater.install() : updater.check())}
          disabled={busy}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[9px] bg-raised px-3 text-[13px] font-semibold text-ink shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_75%,transparent)] hover:bg-raised-hover disabled:opacity-50"
        >
          {busy && <Loader2 size={13} className="animate-spin" />}
          {status === "downloaded" ? t("Restart and update") : t("Check for updates")}
        </button>
        <span className="min-w-0 flex-1 text-[12px] leading-[1.5] text-ink-secondary">
          {t("New versions download by themselves. When you check, the app restarts into the new one as soon as it is downloaded.")}
        </span>
      </div>
    </Card>
  );
}
