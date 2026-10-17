// Settings → 维护岗: the developer edition (server/maintenance.ts). Shown only
// on the owner's machines — where the GitHub CLI's account may push to the
// source repository. Here the owner points Ein at the source clone, picks the
// engine the "Ein 维护" bot runs on, chooses which update channel this install
// follows, and starts a dev build (only dev-channel installs get it) or the
// stable release everyone gets.
import { useCallback, useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { Card } from "@/components/SettingsPrimitives";
import { Button, Segmented } from "@/components/ui";
import { api, useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { SectionHeader, SettingRow } from "./parts";

type Channel = "stable" | "dev";

interface ReleaseRun {
  id: number;
  status: string;
  conclusion: string;
  title: string;
  branch: string;
  createdAt: string;
  url: string;
}

export interface MaintenanceState {
  developer: { available: boolean; account?: string; reason?: "no-gh" | "signed-out" | "no-access" };
  repoPath?: string;
  channel?: Channel;
  repo?: { ok: boolean; reason?: string; branch?: string; commit?: string; subject?: string; dirty?: boolean };
  bot?: { id: string; name: string } | null;
  releases?: ReleaseRun[];
}

/** The developer-edition state, loaded once per mount (and on refresh). */
export function useMaintenance(withReleases = false) {
  const [state, setState] = useState<MaintenanceState | null>(null);
  const load = useCallback(
    () =>
      api(`/api/maintenance${withReleases ? "?releases=1" : ""}`)
        .then((next: MaintenanceState) => setState(next))
        .catch(() => setState({ developer: { available: false } })),
    [withReleases],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return { state, reload: load };
}

function runLabel(run: ReleaseRun): string {
  if (run.status !== "completed") return t("Building…");
  return run.conclusion === "success" ? t("Done") : run.conclusion === "cancelled" ? t("Cancelled") : t("Failed");
}

export function MaintenanceSection() {
  const { state: store, dispatch } = useStore();
  const { state, reload } = useMaintenance(true);
  const [repoPath, setRepoPath] = useState("");
  const [instanceId, setInstanceId] = useState("");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [confirming, setConfirming] = useState<Channel | null>(null);

  useEffect(() => {
    if (!state) return;
    setRepoPath((current) => current || state.repoPath || "");
    setBranch((current) => current || state.repo?.branch || "main");
  }, [state]);

  const ready = store.instances.filter(
    (instance) => instance.snapshot?.state === "available" && instance.snapshot.authenticated !== false && instance.capabilities?.agentsMcp,
  );

  const run = async (key: string, work: () => Promise<string>) => {
    setBusy(key);
    setMessage(null);
    try {
      setMessage({ tone: "ok", text: await work() });
      await reload();
    } catch (cause) {
      setMessage({ tone: "error", text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  };

  if (!state) return <SectionHeader title={t("Maintenance desk")} description={t("Checking this machine…")} />;
  if (!state.developer.available) {
    const why =
      state.developer.reason === "no-gh"
        ? t("Install the GitHub CLI (gh) and sign in with `gh auth login`.")
        : state.developer.reason === "signed-out"
          ? t("Sign in to the GitHub CLI with `gh auth login`.")
          : t("The GitHub account signed in here cannot push to the Ein source repository.");
    return (
      <>
        <SectionHeader title={t("Maintenance desk")} description={t("For the developer's own machines only.")} />
        <Card>
          <p className="text-[13px] leading-relaxed text-ink-secondary">{why}</p>
          <Button className="mt-3" variant="soft" size="sm" onClick={() => void api("/api/maintenance/refresh", { method: "POST", body: "{}" }).then(reload)}>
            {t("Check again")}
          </Button>
        </Card>
      </>
    );
  }

  const selected = ready.find((instance) => instance.instanceId === instanceId) ?? ready[0];
  const channel: Channel = state.channel ?? "stable";
  const repoNote = state.repo?.ok
    ? `${state.repo.branch ?? "?"} · ${state.repo.commit ?? ""} ${state.repo.subject ?? ""}${state.repo.dirty ? ` · ${t("uncommitted changes")}` : ""}`
    : state.repoPath
      ? t("This folder is not the Ein source repository")
      : t("Not set yet");

  return (
    <>
      <SectionHeader
        title={t("Maintenance desk")}
        description={t("Only on your own machines: the GitHub account {account} can push to the Ein source. Report a bug to the Ein maintenance bot, check its dev build here, then publish.", {
          account: state.developer.account ?? "?",
        })}
      />
      <div className="flex flex-col gap-3.5">
        <Card title={t("Source and maintenance bot")} subtitle={t("The bot works in your clone of the source, on its own branch per fix, and asks you before every push and build.")}>
          <div className="mt-3 flex flex-col gap-2">
            <input
              value={repoPath}
              onChange={(event) => setRepoPath(event.target.value)}
              placeholder={t("Full path of your Ein source folder, e.g. /Users/you/Ein-src")}
              aria-label={t("Source folder")}
              className="h-9 rounded-lg border border-hairline/50 bg-app px-2.5 text-[13px] text-ink"
            />
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={selected?.instanceId ?? ""}
                onChange={(event) => setInstanceId(event.target.value)}
                aria-label={t("Engine")}
                className="h-9 min-w-[180px] rounded-lg border border-hairline/50 bg-app px-2 text-[13px] text-ink"
              >
                {ready.map((instance) => (
                  <option key={instance.instanceId} value={instance.instanceId}>
                    {instance.displayName} · {instance.models.options.find((option) => option.id === instance.models.default)?.label ?? instance.models.default}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                disabled={!repoPath.trim() || !selected || busy !== null}
                onClick={() =>
                  void run("setup", async () => {
                    await api("/api/maintenance", {
                      method: "PUT",
                      body: JSON.stringify({
                        repoPath: repoPath.trim(),
                        modelSelection: { instanceId: selected!.instanceId, model: selected!.models.default },
                      }),
                    });
                    return t("The maintenance desk is set up.");
                  })
                }
              >
                {state.bot ? t("Save") : t("Set up the maintenance desk")}
              </Button>
              {state.bot && (
                <Button size="sm" variant="ghost" onClick={() => dispatch({ type: "select", id: state.bot!.id })}>
                  {t("Open {name}", { name: state.bot.name })}
                </Button>
              )}
            </div>
          </div>
          <div className="mt-2 border-t border-hairline/30">
            <SettingRow label={t("Source")} sub={state.repoPath || undefined}>
              <span className="text-[12.5px] text-ink-secondary">{repoNote}</span>
            </SettingRow>
          </div>
        </Card>

        <Card title={t("Update channel for this computer")} subtitle={t("Stable: the release everyone gets. Dev: also the dev builds you start here. Restart Ein after switching; going back to stable returns to the latest stable release.")}>
          <Segmented<Channel>
            className="mt-3"
            value={channel}
            label={t("Update channel for this computer")}
            onChange={(next) =>
              void run("channel", async () => {
                await api("/api/maintenance/channel", { method: "PUT", body: JSON.stringify({ channel: next }) });
                return t("Saved. Restart Ein to switch the update channel.");
              })
            }
            options={[
              { value: "stable", label: t("Stable"), disabled: busy !== null },
              { value: "dev", label: t("Dev"), disabled: busy !== null },
            ]}
          />
        </Card>

        <Card title={t("Build and publish")} subtitle={t("Every build is tagged backup/v<version> in the source repository, and every dev build stays downloadable, so any version can be restored.")}>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              aria-label={t("Branch to build")}
              className="h-9 w-[220px] rounded-lg border border-hairline/50 bg-app px-2.5 font-mono text-[12.5px] text-ink"
            />
            {confirming === "dev" ? (
              <>
                <Button size="sm" disabled={busy !== null} onClick={() => void run("dev", async () => {
                  await api("/api/maintenance/release", { method: "POST", body: JSON.stringify({ channel: "dev", ref: branch.trim() || "main" }) });
                  return t("Dev build started. Dev-channel installs get it in about 30 minutes.");
                })}>
                  {t("Yes, build {branch}", { branch: branch.trim() || "main" })}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>{t("Cancel")}</Button>
              </>
            ) : (
              <Button size="sm" variant="soft" disabled={busy !== null || !branch.trim()} onClick={() => setConfirming("dev")}>
                {t("Build a dev version")}
              </Button>
            )}
            {confirming === "stable" ? (
              <>
                <Button size="sm" variant="warn" disabled={busy !== null} onClick={() => void run("stable", async () => {
                  await api("/api/maintenance/release", { method: "POST", body: JSON.stringify({ channel: "stable" }) });
                  return t("Stable release started from main. Everyone gets it once it is built.");
                })}>
                  {t("Yes, publish main to everyone")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>{t("Cancel")}</Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirming("stable")}>
                {t("Publish the stable release")}
              </Button>
            )}
          </div>
          {confirming === "stable" && (
            <p className="mt-2 text-[12px] leading-relaxed text-warning">
              {t("Only after you checked the dev build and the fix is merged into main (with the version raised): every user updates to it.")}
            </p>
          )}
          {message && <p className={message.tone === "error" ? "mt-2 text-[12px] text-danger" : "mt-2 text-[12px] text-success"}>{message.text}</p>}
          <div className="mt-2 border-t border-hairline/30">
            {(state.releases ?? []).length === 0 && <p className="py-2 text-[12px] text-ink-secondary">{t("No builds yet.")}</p>}
            {(state.releases ?? []).map((release) => (
              <SettingRow key={release.id} label={release.title || release.branch} sub={new Date(release.createdAt).toLocaleString()}>
                <a href={release.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[12.5px] text-accent-text hover:underline">
                  {runLabel(release)}
                  <ExternalLink size={12} aria-hidden />
                </a>
              </SettingRow>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
