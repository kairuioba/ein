// App settings, as a real modal with sections rather than one long panel.
// Per-bot settings (persona, model, computer) stay in SettingsPanel — this
// is the stuff shared by every bot: who you are, your keys, and the
// machine your bots can borrow.
import { useEffect, useRef, useState } from "react";
import { Coins, FlaskConical, Globe, KeyRound, Monitor, Search, Smartphone, Terminal, Trash2, User, X } from "lucide-react";
import { api, useStore, type AppSettingsSection, type ConfigStatus } from "@/state/store";
import { analyticsEnabled, setAnalyticsEnabled } from "@/lib/analytics";
import { builtInBrowserEnabled, showToolCallsEnabled, skillRecorderEnabled } from "@/lib/feature-flags";
import { ApiKeyRow, VpsConnection } from "./ApiKeys";
import { useUpdaterState } from "@/lib/updater";
import { EnginesSettings } from "./EnginesSettings";
import { LocalComputerSection } from "./LocalComputerSection";
import { CompanionSection } from "./CompanionSection";
import { Card, Switch } from "./SettingsPrimitives";
import { UsageSection } from "./UsageSection";
import { SkinPicker } from "./SkinPicker";
import { RoomTurnTimeoutSettings } from "./RoomTurnTimeoutSettings";
import { TranscriptionSettings } from "./TranscriptionSettings";
import { LanguageSettings } from "./LanguageSettings";
import { DispatchSettingsCard } from "./DispatchSettingsCard";
import { WorkBuddySettings } from "./WorkBuddySettings";
import { cn } from "@/lib/cn";
import { msg, t, tn } from "@/lib/i18n";
import {
  browserProfileDeletionBlockReason,
  browserProfilesForPatch,
} from "@/lib/browser-profiles";

const SECTIONS: Array<{
  id: AppSettingsSection;
  label: string;
  icon: typeof User;
  keywords: string[];
}> = [
  // the Chinese keywords let a search typed in Chinese find these sections too
  { id: "general", label: msg("General"), icon: User, keywords: ["profile", "name", "email", "skin", "theme", "appearance", "analytics", "updates", "tools", "tool calls", "language", "dispatch", "chief", "语言", "中文", "英文", "派发", "调度", "总控", "模型推荐"] },
  { id: "experimental", label: msg("Experimental"), icon: FlaskConical, keywords: ["early", "preview", "teach", "skill", "browser", "profiles"] },
  { id: "connections", label: msg("Connections"), icon: KeyRound, keywords: ["keys", "api", "composio", "box", "xai", "vps"] },
  { id: "engines", label: msg("Engines"), icon: Terminal, keywords: ["models", "claude", "grok", "providers", "cli", "workbuddy", "codebuddy", "tencent", "腾讯", "模型", "引擎"] },
  { id: "companion", label: msg("Phone"), icon: Smartphone, keywords: ["companion", "phone", "pair", "mobile"] },
  { id: "computer", label: msg("Local VM"), icon: Monitor, keywords: ["vm", "virtual", "desktop"] },
  { id: "usage", label: msg("Usage"), icon: Coins, keywords: ["tokens", "cost", "billing"] },
];

function sectionMatches(section: (typeof SECTIONS)[number], query: string): boolean {
  if (!query) return true;
  // the shown (translated) label is searchable too
  return [section.label, t(section.label), ...section.keywords].some((part) => part.toLowerCase().includes(query));
}

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
    "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";
  return (
    <div className="flex flex-col gap-3">
      <input value={name} onChange={(e) => setName(e.target.value)} onBlur={save} placeholder={t("Your name")} className={inputClass} />
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onBlur={save}
        placeholder="you@example.com"
        className={inputClass}
      />
    </div>
  );
}

function UpdatesRow() {
  const s = useUpdaterState();
  if (!window.ogb?.updater) return null;
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
        className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control disabled:opacity-40"
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
          <div className="text-[14px] font-medium text-ink">{t("Show tool calls")}</div>
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
          <div className="text-[14px] font-medium text-ink">{t("Teach a skill")}</div>
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
          <div className="text-[14px] font-medium text-ink">{t("Built-in browser")}</div>
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
                      <button type="submit" disabled={busy !== null} className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-accent-ink disabled:opacity-50">
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
                      className="truncate text-left text-[14px] font-medium text-ink hover:underline"
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
      <div className="flex min-w-0 flex-col items-end gap-2">
        <button
          onClick={() => void exportDiagnostics()}
          disabled={exporting}
          aria-label={t("Export diagnostics to a text file")}
          className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control disabled:opacity-40"
        >
          {exporting ? t("Exporting…") : t("Export Diagnostics…")}
        </button>
        {result ? (
          <span
            role={result.kind === "error" ? "alert" : "status"}
            className={`max-w-64 break-all text-right text-[12px] ${result.kind === "error" ? "text-danger" : "text-success"}`}
          >
            {result.message}
          </span>
        ) : null}
      </div>
    </Card>
  );
}

export function SettingsModal() {
  const { state, dispatch } = useStore();
  const section = state.appSettingsSection;
  const dialogRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const visibleSections = SECTIONS.filter((entry) => sectionMatches(entry, q));

  useEffect(() => {
    const visible = SECTIONS.filter((entry) => sectionMatches(entry, q));
    if (visible.some((entry) => entry.id === section)) return;
    const first = visible[0];
    if (first) dispatch({ type: "toggleAppSettings", open: true, section: first.id });
  }, [dispatch, q, section]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dispatch({ type: "toggleAppSettings", open: false });
        return;
      }
      if (event.key !== "Tab" || !dialog) return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [dispatch]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onMouseDown={(e) => e.target === e.currentTarget && dispatch({ type: "toggleAppSettings", open: false })}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-settings-title"
        tabIndex={-1}
        className="flex h-[560px] w-full max-w-[860px] overflow-hidden rounded-2xl border border-hairline/50 bg-panel shadow-2xl outline-none"
      >
        {/* section nav */}
        <nav className="flex w-[190px] shrink-0 flex-col gap-0.5 border-r border-hairline/40 p-3">
          <div id="app-settings-title" className="px-2 pb-2 pt-1 text-[15px] font-semibold text-ink">
            {t("Settings")}
          </div>
          <div className="mb-1.5 flex items-center gap-2 rounded-lg bg-control/70 px-2.5 py-1.5">
            <Search size={14} className="shrink-0 text-ink-secondary" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.stopPropagation();
                if (query) setQuery("");
                else dispatch({ type: "toggleAppSettings", open: false });
              }}
              placeholder={t("Search")}
              aria-label={t("Search settings")}
              className="w-full bg-transparent text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
            />
          </div>
          {visibleSections.length === 0 && (
            <div className="px-2.5 py-4 text-[12.5px] leading-relaxed text-ink-secondary">
              {t("Nothing matches “{query}”", { query: query.trim() })}
            </div>
          )}
          {visibleSections.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: id })}
              aria-current={section === id ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[14px]",
                section === id ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/50 hover:text-ink",
              )}
            >
              <Icon size={15} />
              {t(label)}
            </button>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between px-5 py-3">
            <span className="text-[15px] font-semibold text-ink">
              {t(SECTIONS.find((s) => s.id === section)?.label ?? "")}
            </span>
            <button
              onClick={() => dispatch({ type: "toggleAppSettings", open: false })}
              aria-label={t("Close settings")}
              className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
            >
              <X size={18} />
            </button>
          </div>

          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5">
            {section === "general" && (
              <>
                <LanguageSettings />
                <Card title={t("Profile")} subtitle={t("Shown in the sidebar. Saved as you go.")}>
                  <ProfileFields />
                </Card>
                <Card title={t("Skin")} subtitle={t("Applies instantly and is remembered on this machine.")}>
                  <SkinPicker />
                </Card>
                <Card title={t("Channel turns")} subtitle={t("Set one maximum duration for every bot turn in a channel.")}>
                  <RoomTurnTimeoutSettings />
                </Card>
                <DispatchSettingsCard />
                <ToolCallsRow />
                <UpdatesRow />
                <DiagnosticsRow />
                <AnalyticsRow />
              </>
            )}

            {section === "experimental" && (
              <>
                <ExperimentalFeaturesRow />
                <BrowserProfilesRow />
              </>
            )}

            {section === "connections" && (
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
            )}

            {section === "engines" && (
              <>
                <WorkBuddySettings />
                <Card title={t("Engine CLIs")} subtitle={t("Which binary each engine runs. Saved as you go.")}>
                  <EnginesSettings />
                </Card>
              </>
            )}

            {section === "companion" && <CompanionSection profileEmail={state.config?.profile?.email} />}

            {section === "computer" && <LocalComputerSection />}

            {section === "usage" && <UsageSection />}
          </div>
        </div>
      </div>
    </div>
  );
}
