// 连接应用 (U13): every connected app on one page — what it does, which bots
// may use it, when one last did, and a switch per app. "+ 添加应用" opens the
// plugin browser (PluginsPanel) over this page. Reads the same Composio
// inventory as the browser (/api/connectors/connected, /api/connectors/catalog).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Ellipsis, Loader2, Plus, Search } from "lucide-react";

import { BotAvatar } from "@/components/Avatar";
import { preloadConnectedApps, disconnectAccountConfirmation, type ConnectorStatus, type ToolkitCard } from "@/components/PluginsPanel";
import { Switch } from "@/components/SettingsPrimitives";
import { Button, Empty } from "@/components/ui";
import { botsAllowedApp, lastAppUse } from "@/lib/app-catalog";
import { dayTimeLabel } from "@/lib/calendar-view";
import { cn } from "@/lib/cn";
import { t, tn } from "@/lib/i18n";
import { useOrg } from "@/state/org-api";
import { api, useStore } from "@/state/store";
import { AppTile } from "./AppTile";

const GRID = "grid grid-cols-[34px_minmax(0,1fr)_minmax(150px,240px)_minmax(120px,260px)_44px_32px] items-center gap-x-3";

function RowMenu({
  label,
  status,
  onAddAccount,
  onDisconnect,
  onBotSettings,
}: {
  label: string;
  status: ConnectorStatus;
  onAddAccount: () => void;
  onDisconnect: (accountId: string) => void;
  onBotSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const item = "flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] text-ink hover:bg-raised-hover";
  return (
    <div ref={ref} className="relative justify-self-center">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-haspopup="menu" aria-expanded={open} aria-label={t("More for {app}", { app: label })} className="grid size-8 place-items-center rounded-lg text-ink-secondary/70 hover:bg-raised-hover hover:text-ink">
        <Ellipsis size={16} />
      </button>
      {open && (
        <div role="menu" className="animate-pop-in absolute right-0 top-[calc(100%+4px)] z-40 w-[240px] rounded-xl bg-raised p-1.5 shadow-[0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_45%,transparent),0_18px_40px_-16px_rgb(16_24_40/0.35)]">
          <button role="menuitem" type="button" className={item} onClick={() => { setOpen(false); onAddAccount(); }}>{t("Add another account")}</button>
          <button role="menuitem" type="button" className={item} onClick={() => { setOpen(false); onBotSettings(); }}>{t("Manage in bot settings")}</button>
          {(status.accounts ?? []).length > 0 && <div className="my-1 h-px bg-hairline/30" />}
          {(status.accounts ?? []).map((account) => (
            <button
              key={account.id}
              role="menuitem"
              type="button"
              className={cn(item, "text-danger hover:bg-danger/10")}
              onClick={() => {
                setOpen(false);
                if (window.confirm(disconnectAccountConfirmation(label, account))) onDisconnect(account.id);
              }}
            >
              <span className="min-w-0 flex-1 truncate">{t("Disconnect {account}", { account: account.alias || account.id })}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function AppsPage() {
  const { state, dispatch } = useStore();
  const { data: org } = useOrg();
  const [services, setServices] = useState<Record<string, ConnectorStatus> | null>(null);
  const [authoritative, setAuthoritative] = useState(true);
  const [cards, setCards] = useState<ToolkitCard[]>([]);
  const [configured, setConfigured] = useState(true);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async (force = false) => {
    const [inventory, catalog] = await Promise.all([
      preloadConnectedApps(force),
      api("/api/connectors/catalog").catch(() => null),
    ]);
    setServices(inventory.services);
    setAuthoritative(inventory.authoritative);
    if (catalog) {
      setCards(catalog.cards ?? []);
      setConfigured(Boolean(catalog.configured));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // the browser may have connected something: re-read when it closes
  const wasOpen = useRef(state.pluginsOpen);
  useEffect(() => {
    if (wasOpen.current && !state.pluginsOpen) void load(true);
    wasOpen.current = state.pluginsOpen;
  }, [state.pluginsOpen, load]);

  const visibleBots = state.bots.filter((bot) => !bot.hidden);
  const rows = useMemo(() => {
    const connected = Object.entries(services ?? {}).filter(([, status]) => status.connected || Boolean(status.accounts?.length));
    return connected
      .map(([slug, status]) => {
        const card = cards.find((candidate) => candidate.slug === slug);
        const label = card?.label ?? slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
        const accounts = status.accounts ?? [];
        const description = card?.blurb ? t(card.blurb) : "";
        return { slug, status, label, accounts, description, allowed: botsAllowedApp(slug, visibleBots, org), last: lastAppUse(slug, state.bots) };
      })
      .filter((row) => !query.trim() || `${row.label} ${row.slug} ${row.description}`.toLowerCase().includes(query.trim().toLowerCase()))
      .sort((a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0) || a.label.localeCompare(b.label));
  }, [services, cards, visibleBots, org, state.bots, query]);
  const connectedCount = Object.values(services ?? {}).filter((status) => status.connected || Boolean(status.accounts?.length)).length;

  const disconnectService = async (slug: string, label: string) => {
    if (!window.confirm(t("Disconnect {app}? Bots lose access to it until you connect it again.", { app: label }))) return;
    setBusy(slug);
    setError("");
    try {
      await api(`/api/connectors/${slug}`, { method: "DELETE" });
      await load(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };
  const disconnectAccount = async (slug: string, accountId: string) => {
    setBusy(slug);
    setError("");
    try {
      await api(`/api/connectors/${slug}/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" });
      await load(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };
  const openBrowser = () => dispatch({ type: "togglePlugins", open: true });
  const openBotSettings = () => {
    const target = visibleBots.find((bot) => bot.id === state.selectedId) ?? visibleBots[0];
    if (!target) return;
    dispatch({ type: "select", id: target.id });
    dispatch({ type: "toggleSettings", open: true });
  };

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-stage">
      <header className="flex min-h-[72px] shrink-0 flex-wrap items-center gap-2.5 py-3 pl-7 pr-5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h1 className="text-[22px] font-bold leading-[1.3] tracking-[-0.2px] text-ink">{t("Connect apps")}</h1>
          <span className="truncate text-[12.5px] text-ink-secondary">
            {services === null ? t("Checking connected apps…") : t("{count} connected · see at a glance which bots can use what", { count: connectedCount })}
          </span>
        </div>
        <span className="flex-1" />
        <label className="flex h-[34px] w-[240px] items-center gap-2 rounded-[10px] bg-inset px-3 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_45%,transparent)] focus-within:shadow-[inset_0_0_0_1.5px_var(--color-select)]">
          <Search size={15} className="shrink-0 text-ink-secondary" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("Search connected apps")} aria-label={t("Search connected apps")} className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-secondary/80" />
        </label>
        <Button onClick={openBrowser}><Plus size={15} strokeWidth={2.4} />{t("Add app")}</Button>
      </header>

      {!authoritative && (
        <div className="mx-7 mb-2 rounded-lg bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
          {t("Showing what was connected last time — this Mac's credential store could not be opened just now, so these could not be re-checked. Your apps are still connected; restarting Ein usually clears this.")}
        </div>
      )}
      {error && <div role="alert" className="mx-7 mb-2 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}

      <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-6">
        {services === null ? (
          <div className="flex items-center justify-center gap-2 py-24 text-[13px] text-ink-secondary"><Loader2 size={14} className="animate-spin" />{t("Checking connected apps…")}</div>
        ) : rows.length === 0 ? (
          query.trim() ? (
            <Empty title={t("No apps found")} detail={t("Try a different search.")} />
          ) : (
            <div className="mx-auto mt-16 flex max-w-[420px] flex-col items-center text-center">
              <div className="flex gap-1.5 opacity-80" aria-hidden>
                {["飞书", "GitHub", "Notion", "Figma"].map((label) => <AppTile key={label} label={label} size={36} />)}
              </div>
              <div className="mt-5 text-[16px] font-semibold text-ink">{t("No apps connected yet")}</div>
              <div className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">
                {configured
                  ? t("Connect the software your team works in — docs, chat, code, design — and your bots can read and act in it, within what you allow.")
                  : t("Connected apps are temporarily unavailable. You can retry after restarting, or configure your own connection service.")}
              </div>
              <div className="mt-4 flex gap-2">
                <Button onClick={openBrowser}><Plus size={15} strokeWidth={2.4} />{t("Add app")}</Button>
                {!configured && <Button variant="soft" onClick={() => dispatch({ type: "toggleAppSettings", open: true })}>{t("Open settings")}</Button>}
              </div>
            </div>
          )
        ) : (
          <>
            <div className={cn(GRID, "h-[30px] border-b border-hairline/25 text-[12px] font-semibold text-ink-secondary/80")}>
              <span className="col-span-2">{t("App")}</span>
              <span>{t("Who can use it")}</span>
              <span>{t("Last used")}</span>
              <span className="text-center">{t("Enabled")}</span>
              <span />
            </div>
            {rows.map((row) => {
              const lastBot = row.last ? state.bots.find((bot) => bot.id === row.last!.botId) : undefined;
              const pending = row.status.pending;
              return (
                <div key={row.slug} className={cn(GRID, "h-[62px] border-b border-hairline/25")}>
                  <AppTile label={row.label} slug={row.slug} size={34} />
                  <span className="flex min-w-0 flex-col gap-px">
                    <b className="truncate text-[13.5px] font-semibold">{row.label}</b>
                    <span className="truncate text-[12px] text-ink-secondary">
                      {pending
                        ? t("Finish setup in your browser")
                        : row.accounts.length > 1
                          ? t("{count} accounts: {names}", { count: row.accounts.length, names: row.accounts.map((account) => account.alias || account.id).join("、") })
                          : row.description || row.accounts[0]?.alias || ""}
                    </span>
                  </span>
                  <span className="flex min-w-0 items-center">
                    <span className="flex shrink-0 items-center">
                      {row.allowed.slice(0, 4).map((bot, index) => (
                        <span key={bot.id} className="rounded-[6px] ring-2 ring-stage" style={{ marginLeft: index === 0 ? 0 : -4 }}>
                          <BotAvatar bot={bot} size={20} />
                        </span>
                      ))}
                    </span>
                    <em className="ml-1.5 truncate text-[12px] not-italic text-ink-secondary">{tn(row.allowed.length, "{count} bot can use it", "{count} bots can use it")}</em>
                  </span>
                  <span className="truncate text-[12.5px] text-ink-secondary">
                    {row.last ? [dayTimeLabel(row.last.at), lastBot?.name].filter(Boolean).join(" · ") : t("Not used yet")}
                  </span>
                  <span className="justify-self-center">
                    {busy === row.slug ? (
                      <Loader2 size={16} className="animate-spin text-ink-secondary" />
                    ) : (
                      <Switch checked aria-label={t("Disconnect {app}", { app: row.label })} onClick={() => void disconnectService(row.slug, row.label)} />
                    )}
                  </span>
                  <RowMenu
                    label={row.label}
                    status={row.status}
                    onAddAccount={openBrowser}
                    onDisconnect={(accountId) => void disconnectAccount(row.slug, accountId)}
                    onBotSettings={openBotSettings}
                  />
                </div>
              );
            })}
          </>
        )}
      </div>
    </main>
  );
}
