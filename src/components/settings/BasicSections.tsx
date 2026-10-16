// The settings sections that came over from the old Settings modal: General,
// Appearance, Connections, Mobile, Computer, Experimental and Updates. Their
// rows keep the modal's behaviour; only the frame around them is new.
import { useEffect, useState } from "react";
import { Globe, Trash2 } from "lucide-react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { analyticsEnabled, setAnalyticsEnabled } from "@/lib/analytics";
import { builtInBrowserEnabled, showToolCallsEnabled, skillRecorderEnabled } from "@/lib/feature-flags";
import { useUpdaterState } from "@/lib/updater";
import { browserProfileDeletionBlockReason, browserProfilesForPatch } from "@/lib/browser-profiles";
import { t, tn } from "@/lib/i18n";
import { ApiKeyRow, VpsConnection } from "@/components/ApiKeys";
import { LocalComputerSection } from "@/components/LocalComputerSection";
import { CompanionSection } from "@/components/CompanionSection";
import { Card, Switch } from "@/components/SettingsPrimitives";
import { SkinPicker } from "@/components/SkinPicker";
import { RoomTurnTimeoutSettings } from "@/components/RoomTurnTimeoutSettings";
import { TranscriptionSettings } from "@/components/TranscriptionSettings";
import { LanguageSettings } from "@/components/LanguageSettings";
import { DispatchSettingsCard } from "@/components/DispatchSettingsCard";
import { SKINS, readSkin } from "@/lib/skins";
import { SectionHeader } from "./parts";

/** Name + email, persisted to /api/config {profile} on blur. */
function ProfileFields() {
  const { state, dispatch } = useStore();
  const [name, setName] = useState(state.config?.profile?.name ?? "");
  const [email, setEmail] = useState(state.config?.profile?.email ?? "");
  useEffect(() => {
    setName(state.config?.profile?.name ?? "");
    setEmail(state.config?.profile?.email ?? "");
  }, [state.config?.profile?.name, state.config?.profile?.email]);

  const save = () => {
    void fetch("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: { name: name.trim(), email: email.trim().toLowerCase() } }),
    })
      .then((r) => r.json())
      .then((config) => dispatch({ type: "configStatus", config }))
      .catch(() => {});
  };

  const inputClass =
    "w-full rounded-[10px] bg-raised px-3 py-2 text-[13.5px] text-ink shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_60%,transparent)] placeholder:text-ink-secondary/70 focus:shadow-[inset_0_0_0_1.5px_var(--color-select)] focus:outline-none";
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <input value={name} onChange={(e) => setName(e.target.value)} onBlur={save} placeholder={t("Your name")} aria-label={t("Your name")} className={inputClass} />
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onBlur={save}
        placeholder="you@example.com"
        aria-label={t("Email")}
        className={inputClass}
      />
    </div>
  );
}

function UpdatesRow() {
  const s = useUpdaterState();
  if (!window.ogb?.updater) {
    return <Card title={t("Updates")} subtitle={t("Updates are handled by the desktop app. This window is not running inside it.")} />;
  }
  const updater = window.ogb.updater;
  if (s?.unavailable) {
    return (
      <Card
        title={t("Updates")}
        subtitle={t("This edition does not update itself, so it never turns into the upstream English release. Install new versions from your team's release page.")}
      />
    );
  }
  const label =
    s?.status === "checking"
      ? t("Checking…")
      : s?.status === "available"
        ? t("{version} available", { version: s.version })
        : s?.status === "downloading"
          ? t("Downloading {percent}%", { percent: Math.round(s.percent ?? 0) })
          : s?.status === "downloaded"
            ? t("{version} ready — restart to apply", { version: s.version })
            : s?.status === "error"
              ? t("Check failed: {message}", { message: s.message ?? t("unknown error") })
              : t("You're on the latest version we know of.");
  return (
    <Card title={t("Updates")} subtitle={label}>
      <button
        onClick={() => {
          if (s?.status === "available") return void updater.download();
          if (s?.status === "downloaded") return void updater.install();
          void updater.check();
        }}
        disabled={s?.status === "checking" || s?.status === "downloading"}
        className="h-8 rounded-[9px] bg-raised px-3 text-[13px] font-semibold text-ink shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_75%,transparent)] hover:bg-raised-hover disabled:opacity-40"
      >
        {s?.status === "available"
          ? t("Download")
          : s?.status === "downloaded"
            ? t("Restart and install")
            : t("Check for updates")}
      </button>
    </Card>
  );
}

/** Usage analytics, off by default in this edition. Naming what is sent
 * matters more than the switch: people who cannot see the scope assume the
 * worst, and the worst — conversation text — is exactly what this never
 * sends (autocapture is off; see lib/analytics.ts). */
function AnalyticsRow() {
  const [on, setOn] = useState(analyticsEnabled);
  return (
    <Card
      title={t("Usage analytics")}
      subtitle={t("Off unless you turn it on. Sends anonymous product events (app opened, which features get used) to the upstream OpenMausBot project's PostHog in the United States — never conversations, prompts, file contents, or bot output. Your email is only attached if you shared it during setup.")}
    >
      <Switch
        checked={on}
        aria-label={t("Send usage analytics")}
        onClick={() => {
          const next = !on;
          setAnalyticsEnabled(next);
          setOn(next);
        }}
      />
    </Card>
  );
}

function ToolCallsRow() {
  const { state, dispatch } = useStore();
  const enabled = showToolCallsEnabled(state.config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const toggle = async () => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ features: { showToolCalls: !enabled } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Could not save the tool-call setting."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title={t("Tool calls")}
      subtitle={t("Show each tool a bot runs in the transcript. Off by default — the mascot already shows that work is happening.")}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[13.5px] font-medium text-ink">{t("Show tool calls")}</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
            {t("Named chips for Bash, search, and other tools. Errors and bot-to-bot messages still appear.")}
          </div>
        </div>
        <Switch
          checked={enabled}
          aria-label={t("Show tool calls in chat")}
          disabled={saving}
          onClick={() => void toggle()}
          className="disabled:cursor-wait disabled:opacity-50"
        />
      </div>
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
    </Card>
  );
}

function ExperimentalFeaturesRow() {
  const { state, dispatch } = useStore();
  const skillRecorder = skillRecorderEnabled(state.config);
  const browser = builtInBrowserEnabled(state.config);
  const desktopBrowser = Boolean(window.ogb?.browser);
  const browserBlockedOnWindows = window.ogb?.platform === "win32" && !desktopBrowser;
  const [saving, setSaving] = useState<"skillRecorder" | "browser" | null>(null);
  const [error, setError] = useState("");

  const toggle = async (feature: "skillRecorder" | "browser", next: boolean) => {
    if (saving) return;
    setSaving(feature);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ features: { [feature]: next } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Could not save the experimental feature setting."));
    } finally {
      setSaving(null);
    }
  };

  return (
    <Card
      title={t("Experimental features")}
      subtitle={t("Early features may change while we test them. They stay off unless you enable them.")}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[13.5px] font-medium text-ink">{t("Teach a skill")}</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
            {t("Show the workflow recorder and let supported bots stage skills with /learn.")}
          </div>
        </div>
        <Switch
          checked={skillRecorder}
          aria-label={t("Show Teach a skill")}
          disabled={saving !== null}
          onClick={() => void toggle("skillRecorder", !skillRecorder)}
          className="disabled:cursor-wait disabled:opacity-50"
        />
      </div>
      <div className="mt-4 flex items-center justify-between gap-4 border-t border-hairline/30 pt-4">
        <div className="min-w-0">
          <div className="text-[13.5px] font-medium text-ink">{t("Built-in browser")}</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
            {desktopBrowser
              ? browser
                ? t("Enabled for this workspace. Each bot also has its own browser switch.")
                : t("Off by default. Enable it to let supported bots use a browser tab you can watch and take over.")
              : browserBlockedOnWindows
                ? t("Temporarily unavailable on Windows while Electron's production sandbox support is being verified.")
                : t("Needs the OpenMausBot desktop app.")}
          </div>
        </div>
        <Switch
          checked={browser}
          aria-label={t("Enable the built-in browser")}
          disabled={saving !== null || (!browser && !desktopBrowser)}
          onClick={() => void toggle("browser", !browser)}
          className="disabled:cursor-wait disabled:opacity-50"
        />
      </div>
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
    </Card>
  );
}

/** Named browser sessions: rename or delete; deleting wipes that session's
 * logins, storage and cache and sends any bot on it back to its own. */
function BrowserProfilesRow() {
  const { state, dispatch } = useStore();
  const profiles = state.config?.browserProfiles ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState("");
  // Windows temporarily gates the live browser surface, but upgraded users
  // must still be able to rename or permanently erase existing sessions.
  // The packaged server can perform that private lifecycle cleanup without
  // exposing the browser renderer bridge.
  if (!window.ogb || (!builtInBrowserEnabled(state.config) && profiles.length === 0)) return null;

  const save = async (next: typeof profiles) => {
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ browserProfiles: browserProfilesForPatch(next) }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Could not save browser profiles."));
    } finally {
      setBusy(null);
      setRenaming(null);
    }
  };
  const remove = async (id: string) => {
    if (busy) return;
    const profile = profiles.find((candidate) => candidate.id === id);
    if (!profile) return;
    const referencedBots = state.bots.filter((bot) => bot.browserProfile === id);
    const blocked = browserProfileDeletionBlockReason(state.bots, id);
    if (blocked) {
      setError(blocked);
      return;
    }
    const confirmation = referencedBots.length
      ? t("Delete “{name}”? {bots} will switch to their own browser sessions. This permanently signs out of this profile and erases its browser data.", {
          name: profile.name,
          bots: referencedBots.length === 1 ? referencedBots[0]!.name : tn(referencedBots.length, "{count} bot", "{count} bots"),
        })
      : t("Delete “{name}”? This permanently signs out of this profile and erases its browser data.", { name: profile.name });
    if (!window.confirm(confirmation)) {
      return;
    }
    setBusy(id);
    setError("");
    try {
      // The server commits the profile list and clears every bot reference as
      // one transaction, then privately asks Electron to erase the partition.
      // Never wipe browser data from the renderer before that commit succeeds:
      // a rejected config save must leave the user's signed-in session intact.
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({
          browserProfiles: browserProfilesForPatch(profiles.filter((candidate) => candidate.id !== id)),
        }),
      });
      dispatch({ type: "configStatus", config });
      // Packaged Electron receives the same post-commit cleanup privately
      // from the server. Keep this idempotent fallback for split-process
      // desktop development, where the server has no parent message port.
      try {
        await window.ogb?.browser?.forgetProfile?.(profile.partitionId ?? profile.id);
      } catch {
        setError(t("The profile was removed, but its local browser data could not be erased. Restart OpenMausBot before reusing that profile name."));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Could not delete the browser profile."));
    } finally {
      setBusy(null);
    }
  };
  const rename = () => {
    if (!renaming || busy) return;
    const name = renaming.name.trim();
    if (!name) return;
    setBusy(renaming.id);
    setError("");
    void save(profiles.map((profile) => (profile.id === renaming.id ? { ...profile, name } : profile)));
  };
  const usersOf = (id: string) => state.bots.filter((bot) => !bot.hidden && bot.browserProfile === id).map((bot) => bot.name);

  return (
    <Card
      title={t("Browser profiles")}
      subtitle={t("Named sign-in sessions any bot can use. Create one from a bot's Browser tab; sign in once and it stays.")}
    >
      {profiles.length === 0 ? (
        <div className="text-[13px] text-ink-secondary">{t("No profiles yet — pick \"+ Add profile…\" under a bot's browser.")}</div>
      ) : (
        <div className="flex flex-col divide-y divide-hairline/30">
          {profiles.map((profile) => {
            const users = usersOf(profile.id);
            const editing = renaming?.id === profile.id;
            return (
              <div key={profile.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <Globe size={14} className="shrink-0 text-ink-secondary" />
                  {editing ? (
                    <form
                      className="flex items-center gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        rename();
                      }}
                    >
                      <input
                        autoFocus
                        value={renaming.name}
                        onChange={(event) => setRenaming({ id: profile.id, name: event.target.value })}
                        maxLength={40}
                        className="rounded-md bg-inset px-2 py-1 text-[13px] text-ink outline-none"
                        aria-label={t("Profile name")}
                      />
                      <button type="submit" disabled={busy !== null} className="rounded-md bg-primary px-2.5 py-1 text-[12px] font-medium text-primary-ink disabled:opacity-50">
                        {t("Save")}
                      </button>
                      <button type="button" onClick={() => setRenaming(null)} className="text-[12px] text-ink-secondary hover:text-ink">
                        {t("Cancel")}
                      </button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setRenaming({ id: profile.id, name: profile.name })}
                      className="truncate text-left text-[13.5px] font-medium text-ink hover:underline"
                      title={t("Rename")}
                    >
                      {profile.name}
                    </button>
                  )}
                  <span className="truncate text-[12px] text-ink-secondary">
                    {users.length ? t("used by {names}", { names: users.join(", ") }) : t("not in use")}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => void remove(profile.id)}
                  disabled={busy !== null}
                  className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-control hover:text-danger disabled:opacity-50"
                  title={t("Delete this profile and forget its logins")}
                >
                  <Trash2 size={13} />{" "}
                  {t("Delete")}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
    </Card>
  );
}

/** Writes a redacted diagnostics file to a location the user picks. The
 * report holds versions, configured-or-not booleans and the server.log tail —
 * never credential values (the desktop shell does not read secret fields). */
function DiagnosticsRow() {
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const available = Boolean(window.ogb?.exportDiagnostics);

  const exportDiagnostics = async () => {
    if (!window.ogb?.exportDiagnostics || exporting) return;
    setExporting(true);
    setResult(null);
    try {
      const path = await window.ogb.exportDiagnostics();
      if (path) setResult({ kind: "success", message: t("Saved to {path}", { path }) });
    } catch (e) {
      setResult({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setExporting(false);
    }
  };

  return (
    <Card
      title={t("Diagnostics")}
      subtitle={t("Versions, configuration on/off state and a redacted server log tail. Review the file before sharing it.")}
    >
      <div className="flex min-w-0 flex-col items-start gap-2">
        <button
          onClick={() => void exportDiagnostics()}
          disabled={exporting || !available}
          title={available ? undefined : t("Needs the OpenMausBot desktop app.")}
          aria-label={t("Export diagnostics to a text file")}
          className="h-8 rounded-[9px] bg-raised px-3 text-[13px] font-semibold text-ink shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_75%,transparent)] hover:bg-raised-hover disabled:opacity-40"
        >
          {exporting ? t("Exporting…") : t("Export Diagnostics…")}
        </button>
        {result ? (
          <span role={result.kind === "error" ? "alert" : "status"} className={`break-all text-[12px] ${result.kind === "error" ? "text-danger" : "text-success"}`}>
            {result.message}
          </span>
        ) : null}
      </div>
    </Card>
  );
}

export function GeneralSection() {
  return (
    <>
      <SectionHeader title={t("General")} description={t("Who you are, how the Chief hands out work, and what the app records.")} />
      <div className="flex flex-col gap-3.5">
        <Card title={t("Profile")} subtitle={t("Shown in the sidebar. Saved as you go.")}>
          <ProfileFields />
        </Card>
        <DispatchSettingsCard />
        <Card title={t("Channel turns")} subtitle={t("Set one maximum duration for every bot turn in a channel.")}>
          <RoomTurnTimeoutSettings />
        </Card>
        <ToolCallsRow />
        <AnalyticsRow />
      </div>
    </>
  );
}

export function AppearanceSection() {
  return (
    <>
      <SectionHeader title={t("Appearance")} description={t("The skin and the language the app speaks. Both apply to this computer only.")} />
      <div className="flex flex-col gap-3.5">
        <Card title={t("Skin")} subtitle={t("Applies instantly and is remembered on this machine.")}>
          <SkinPicker />
        </Card>
        <LanguageSettings />
      </div>
    </>
  );
}

/** The skin's display name, for the nav meta. */
export function currentSkinName(): string {
  const id = (typeof document !== "undefined" && document.documentElement.dataset.skin) || readSkin();
  const name = SKINS.find((skin) => skin.id === id)?.name;
  return name ? t(name) : "";
}

export function ConnectionsSection() {
  const { state } = useStore();
  return (
    <>
      <SectionHeader title={t("Connections")} description={t("Service keys and remote computers your bots can use. Everything stays on this computer.")} />
      <Card
        title={t("Connections")}
        subtitle={t("Connected apps work automatically in the installed app. Other optional service keys stay on this computer.")}
      >
        <div className="flex flex-col gap-4">
          {state.config?.composio.mode === "managed" ? (
            <div className="rounded-lg border border-success/25 bg-success/10 px-3 py-2 text-[13px] text-success">
              {t("Connected apps service is ready")}
            </div>
          ) : null}
          <TranscriptionSettings />
          <ApiKeyRow section="box" />
          <VpsConnection />
          <ApiKeyRow section="opencodeGo" />
          <details className="rounded-lg border border-hairline/40 bg-inset px-3 py-2">
            <summary className="cursor-pointer text-[13px] text-ink-secondary">{t("Self-host connected apps")}</summary>
            <div className="mt-3">
              <ApiKeyRow section="composio" />
            </div>
          </details>
        </div>
      </Card>
    </>
  );
}

export function PhoneSection() {
  const { state } = useStore();
  return (
    <>
      <SectionHeader title={t("Mobile")} description={t("Pair your phone to talk to your bots and answer approvals away from the desk.")} />
      <div className="flex flex-col gap-3.5">
        <CompanionSection profileEmail={state.config?.profile?.email} />
      </div>
    </>
  );
}

export function ComputerSection() {
  return (
    <>
      <SectionHeader title={t("Computer")} description={t("The computer your bots borrow when a task needs a screen: a cloud box, a local VM, or this machine.")} />
      <div className="flex flex-col gap-3.5">
        <LocalComputerSection />
      </div>
    </>
  );
}

export function ExperimentalSection() {
  return (
    <>
      <SectionHeader title={t("Experimental")} description={t("Early features may change while we test them. They stay off unless you enable them.")} />
      <div className="flex flex-col gap-3.5">
        <ExperimentalFeaturesRow />
        <BrowserProfilesRow />
      </div>
    </>
  );
}

export function UpdatesSection() {
  return (
    <>
      <SectionHeader title={t("Updates")} description={t("Which version you run, and a redacted report to send when something breaks.")} />
      <div className="flex flex-col gap-3.5">
        <UpdatesRow />
        <DiagnosticsRow />
      </div>
    </>
  );
}

/** For the nav: true when a downloaded or available update is waiting. */
export function useUpdateWaiting(): boolean {
  const s = useUpdaterState();
  return s?.status === "available" || s?.status === "downloaded";
}

/** For the nav: how many experimental features are on. */
export function useExperimentalCount(): number {
  const { state } = useStore();
  return [skillRecorderEnabled(state.config), builtInBrowserEnabled(state.config)].filter(Boolean).length;
}
