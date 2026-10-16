// Connected apps (U13): the plugin browser sheet over the 连接应用 page —
// 已连接 summary, search, category chips, 推荐 and 团队插件 in two columns with
// 添加 / ✓ 已添加. Backed by Composio Sessions; the catalog comes from
// /api/connectors/catalog (the full toolkit list when a Composio API key is
// configured, a curated set otherwise). Apps show monogram tiles, never logos.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, Check, Loader2, Plug, RefreshCw, Search, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { api, useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { readCachedInventory, writeCachedInventory } from "@/lib/connected-apps-cache";
import { allTranslations, msg, t, tRich } from "@/lib/i18n";
import { CATEGORY_LABEL, CATEGORY_ORDER, categoryOf, recommendedSlugs, type AppCategory } from "@/lib/app-catalog";
import { AppTile } from "@/components/apps/AppTile";

export interface ToolkitCard {
  slug: string;
  label: string;
  blurb: string;
  logo: string | null;
  noAuth?: boolean;
  domain: string | null;
}

export interface ConnectorStatus {
  connected: boolean;
  pending?: boolean;
  status?: string;
  accounts?: Array<{
    id: string;
    alias?: string;
    status: string;
  }>;
}

// The panel is a modal and unmounts whenever it closes. Keep the last known
// account inventory at module scope so reopening never flashes every service
// as disconnected while a fresh secure status check runs in the background.
let cachedConnectorStatus: Record<string, ConnectorStatus> | null = null;
let cachedConnectorStatusAt = 0;
let cachedConnectorStatusAuthoritative = true;
let connectorStatusRequest: Promise<ConnectorInventory> | null = null;
const CONNECTOR_STATUS_CACHE_MS = 30_000;

/** Composio account statuses, shown lowercase under each account. */
const ACCOUNT_STATUS_LABELS: Record<string, string> = {
  active: msg("active"),
  initiated: msg("initiated"),
  expired: msg("expired"),
  failed: msg("failed"),
};

export interface ConnectorInventory {
  services: Record<string, ConnectorStatus>;
  /** false when the server could not read the credential store: the list is
   * then "we do not know", and nothing may be cleared on the strength of it */
  authoritative: boolean;
}

/** Warm the account inventory once the app server is ready. Concurrent panel
 * opens share the same request, and recent data survives modal unmounts. */
export function preloadConnectedApps(force = false): Promise<ConnectorInventory> {
  if (!force && cachedConnectorStatus !== null && Date.now() - cachedConnectorStatusAt < CONNECTOR_STATUS_CACHE_MS) {
    return Promise.resolve({
      services: cachedConnectorStatus,
      authoritative: cachedConnectorStatusAuthoritative,
    });
  }
  if (connectorStatusRequest) return connectorStatusRequest;
  connectorStatusRequest = api("/api/connectors/connected")
    .then((response) => {
      const services: Record<string, ConnectorStatus> = response.services ?? {};
      // An unreadable credential store tells us nothing about what is
      // connected. Keep the last inventory we were sure about instead.
      if (response.credentialStore === "unavailable") {
        return { services: readCachedInventory()?.services ?? {}, authoritative: false };
      }
      cachedConnectorStatus = services;
      cachedConnectorStatusAt = Date.now();
      cachedConnectorStatusAuthoritative = true;
      writeCachedInventory(services, Date.now());
      return { services, authoritative: true };
    })
    .catch(() => ({ services: readCachedInventory()?.services ?? {}, authoritative: false }))
    .finally(() => {
      connectorStatusRequest = null;
    });
  return connectorStatusRequest;
}

export function disconnectAccountConfirmation(
  service: string,
  account: { id: string; alias?: string },
) {
  const identity = account.alias ? `“${account.alias}” (${account.id})` : `“${account.id}”`;
  return t(
    "Disconnect {identity} from {service}? Only this {service} account will be revoked. Your other {service} accounts will stay connected.",
    { identity, service },
  );
}

/** The harness's refusal when a second account would replace the first
 * (server/composio.ts). It arrives translated when the harness runs in
 * Chinese, so recognize every rendering, not only the English one. */
const ACCOUNT_ALIAS_REQUIRED = msg("Add an account alias so the existing connection is not replaced");

export function requiresAccountAlias(message: string) {
  return (
    /account alias.*existing connection.*not replaced/i.test(message) ||
    allTranslations(ACCOUNT_ALIAS_REQUIRED).some((rendering) => message.includes(rendering))
  );
}

export type ConnectorInventoryPhase = "loading" | "ready" | "error";

export function connectorActionLabel(
  phase: ConnectorInventoryPhase,
  state: { busy: boolean; included: boolean; canContinue: boolean; hasAccounts: boolean; failed: boolean },
) {
  if (state.busy) return null;
  if (state.included) return t("Included");
  if (phase === "loading") return t("Checking…");
  if (phase === "error") return t("Unavailable");
  if (state.canContinue) return t("Continue");
  if (state.hasAccounts) return t("Add account");
  if (state.failed) return t("Retry");
  return t("Connect");
}

export function connectedInventoryCopy(phase: ConnectorInventoryPhase) {
  if (phase === "loading") return {
    title: t("Checking connected apps…"),
    description: t("Your accounts will appear here as soon as the secure connection check finishes."),
  };
  if (phase === "error") return {
    title: t("Couldn’t load connected apps"),
    description: t("Retry the connection check before adding another account."),
  };
  return {
    title: t("No connected apps yet"),
    description: t("Connect an app from Marketplace and it will appear here."),
  };
}

export function mergeCurrentConnectorStatus(
  current: Record<string, ConnectorStatus>,
  incoming: Record<string, ConnectorStatus>,
  latestGenerations: ReadonlyMap<string, number>,
  requestGenerations: ReadonlyMap<string, number>,
) {
  const next = { ...current };
  for (const [slug, state] of Object.entries(incoming)) {
    if ((latestGenerations.get(slug) ?? 0) !== (requestGenerations.get(slug) ?? 0)) continue;
    next[slug] = state;
  }
  return next;
}

export function mergeCompleteConnectorStatus(
  current: Record<string, ConnectorStatus>,
  incoming: Record<string, ConnectorStatus>,
  latestGenerations: ReadonlyMap<string, number>,
  requestGenerations: ReadonlyMap<string, number>,
  /** Did the server actually KNOW the full picture? A response sent while the
   * credential store was unreadable carries no information about what is
   * connected, so it must not be allowed to clear anything — an empty list
   * from an ignorant server is exactly how a connected app became a Connect
   * button. Disconnection still shows up on the next authoritative answer. */
  authoritative = true,
) {
  const next = { ...current };
  if (!authoritative) return mergeCurrentConnectorStatus(next, incoming, latestGenerations, requestGenerations);
  for (const [slug, state] of Object.entries(current)) {
    if (incoming[slug]) continue;
    if (!state.connected && !state.accounts?.length) continue;
    if ((latestGenerations.get(slug) ?? 0) !== (requestGenerations.get(slug) ?? 0)) continue;
    next[slug] = { connected: false, pending: false, status: "not_connected", accounts: [] };
  }
  return mergeCurrentConnectorStatus(next, incoming, latestGenerations, requestGenerations);
}

export function onlyLatestConnectorResponses(
  incoming: Record<string, ConnectorStatus>,
  latestRequests: ReadonlyMap<string, number>,
  requestIds: ReadonlyMap<string, number>,
) {
  return Object.fromEntries(
    Object.entries(incoming).filter(
      ([slug]) => (latestRequests.get(slug) ?? 0) === (requestIds.get(slug) ?? 0),
    ),
  );
}

type CategoryChip = "all" | "recommended" | "team" | AppCategory;

function NoApps({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="flex flex-col items-center gap-1 px-6 py-10 text-center">
      <div className="text-[14px] font-semibold text-ink">{title}</div>
      {detail && <div className="text-[13px] text-ink-secondary">{detail}</div>}
    </div>
  );
}

/** The browser's sheet: a centred card over a dimmed backdrop; Esc closes it
 * and Tab stays inside. Self-contained so this module (and its tests) carry
 * no avatar or mascot imports. */
function Sheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusable = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    (dialog?.querySelector<HTMLElement>("input") ?? focusable()[0] ?? dialog)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      returnFocus?.focus();
    };
  }, []);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(20_22_28/0.38)] p-4"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="connected-apps-title"
        tabIndex={-1}
        className="animate-pop-in flex h-[min(760px,calc(100dvh-2rem))] w-full max-w-[920px] flex-col overflow-hidden rounded-2xl bg-raised shadow-[0_0_0_1px_rgb(16_24_40/0.08),0_2px_8px_rgb(16_24_40/0.08),0_40px_90px_-30px_rgb(16_24_40/0.5)]"
      >
        {children}
      </div>
    </div>
  );
}

/** The label and look of an app row's button in the browser (U13 wording). */
function rowAction(
  phase: ConnectorInventoryPhase,
  state: { busy: boolean; included: boolean; canContinue: boolean; hasAccounts: boolean; failed: boolean },
): { label: string | null; done: boolean } {
  if (state.busy) return { label: null, done: false };
  if (state.included) return { label: t("Included"), done: true };
  if (phase === "loading") return { label: t("Checking…"), done: false };
  if (phase === "error") return { label: t("Unavailable"), done: false };
  if (state.canContinue) return { label: t("Continue"), done: false };
  if (state.hasAccounts) return { label: t("Added"), done: true };
  if (state.failed) return { label: t("Retry"), done: false };
  return { label: t("Add"), done: false };
}

export function PluginsPanel() {
  const { state, dispatch } = useStore();
  const [cards, setCards] = useState<ToolkitCard[] | null>(null);
  const [source, setSource] = useState<"api" | "curated">("curated");
  const [configured, setConfigured] = useState(true);
  const [mode, setMode] = useState<"managed" | "self-hosted" | "unavailable">("unavailable");
  // Paint what we last knew before any request goes out: the module cache if
  // this window already fetched, otherwise the inventory saved on disk. An
  // empty panel is never the first thing a connected user sees.
  const [status, setStatus] = useState<Record<string, ConnectorStatus>>(
    () => cachedConnectorStatus ?? readCachedInventory()?.services ?? {},
  );
  /** true when what is on screen is remembered rather than confirmed */
  const [stale, setStale] = useState(
    cachedConnectorStatus !== null && !cachedConnectorStatusAuthoritative,
  );
  const [pendingUrls, setPendingUrls] = useState<Record<string, string>>({});
  const [aliasSlug, setAliasSlug] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState("");
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [inventoryPhase, setInventoryPhase] = useState<ConnectorInventoryPhase>(
    cachedConnectorStatus === null ? "loading" : "ready",
  );
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<CategoryChip>("all");

  const pollTimers = useRef(new Map<string, ReturnType<typeof setInterval>>());
  const statusGenerations = useRef(new Map<string, number>());
  const latestStatusRequests = useRef(new Map<string, number>());

  const refreshStatus = useCallback((slugs: string[]): Promise<Record<string, ConnectorStatus>> => {
    if (!slugs.length) return Promise.resolve({});
    const requestGenerations = new Map(slugs.map((slug) => [slug, statusGenerations.current.get(slug) ?? 0]));
    const requestIds = new Map(slugs.map((slug) => {
      const requestId = (latestStatusRequests.current.get(slug) ?? 0) + 1;
      latestStatusRequests.current.set(slug, requestId);
      return [slug, requestId];
    }));
    return api(`/api/connectors?services=${slugs.join(",")}`)
      .then((r) => {
        const services = onlyLatestConnectorResponses(
          r.services ?? {},
          latestStatusRequests.current,
          requestIds,
        );
        // A one-service OAuth poll must not erase every other app's state.
        // A request that began before Connect must also not erase the newer
        // local INITIATED state when its stale not_connected result arrives.
        setStatus((current) => mergeCurrentConnectorStatus(
          current,
          services,
          statusGenerations.current,
          requestGenerations,
        ));
        for (const [slug, state] of Object.entries(services)) {
          const isCurrent = (statusGenerations.current.get(slug) ?? 0) === (requestGenerations.get(slug) ?? 0);
          if (isCurrent && state.connected && !state.pending) setPendingUrls((current) => {
            if (!current[slug]) return current;
            const next = { ...current };
            delete next[slug];
            return next;
          });
        }
        return services;
      })
      .catch(() => ({}));
  }, []);

  const refreshConnectedStatus = useCallback((force = false): Promise<Record<string, ConnectorStatus>> => {
    const requestGenerations = new Map(statusGenerations.current);
    setRefreshing(true);
    return preloadConnectedApps(force)
      .then(({ services, authoritative }) => {
        setStale(!authoritative);
        setStatus((current) => mergeCompleteConnectorStatus(
          current,
          services,
          statusGenerations.current,
          requestGenerations,
          authoritative,
        ));
        for (const [slug, state] of Object.entries(services)) {
          const isCurrent = (statusGenerations.current.get(slug) ?? 0) === (requestGenerations.get(slug) ?? 0);
          if (isCurrent && state.connected && !state.pending) setPendingUrls((current) => {
            if (!current[slug]) return current;
            const next = { ...current };
            delete next[slug];
            return next;
          });
        }
        return services;
      })
      .finally(() => setRefreshing(false));
  }, []);

  const loadConnectionInventory = useCallback((force = false) => {
    const hadCachedInventory = cachedConnectorStatus !== null;
    if (!hadCachedInventory) setInventoryPhase("loading");
    setError(null);
    return refreshConnectedStatus(force)
      .then((services) => {
        setInventoryPhase("ready");
        return services;
      })
      .catch((cause) => {
        if (!hadCachedInventory) setInventoryPhase("error");
        setError(cause instanceof Error ? cause.message : String(cause));
        return {};
      });
  }, [refreshConnectedStatus]);

  useEffect(() => () => {
    for (const timer of pollTimers.current.values()) clearInterval(timer);
    pollTimers.current.clear();
  }, []);

  useEffect(() => {
    if (inventoryPhase !== "ready") return;
    cachedConnectorStatus = status;
    cachedConnectorStatusAt = Date.now();
    cachedConnectorStatusAuthoritative = !stale;
  }, [inventoryPhase, stale, status]);

  useEffect(() => {
    let alive = true;
    void loadConnectionInventory();
    api("/api/connectors/catalog")
      .then((r) => {
        if (!alive) return;
        setCards(r.cards ?? []);
        setSource(r.source ?? "curated");
        setConfigured(Boolean(r.configured));
        setMode(r.mode ?? "unavailable");
      })
      .catch((e) => {
        if (!alive) return;
        setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [loadConnectionInventory]);

  const openConnectUrl = async (url: string) => {
    if (window.ogb?.openExternal) {
      await window.ogb.openExternal(url);
      return;
    }
    // Browser development fallback. If a popup blocker rejects the first
    // asynchronous open, the visible Continue button retries from a direct
    // user gesture using the URL retained in pendingUrls.
    const opened = window.open("", "_blank");
    if (!opened) throw new Error(t("Your browser blocked the connection page. Click Continue to open it."));
    // Open a same-origin blank page first so the OAuth origin never receives
    // an opener reference, while a real null remains a reliable blocked signal.
    opened.opener = null;
    opened.location.replace(url);
  };

  const startPolling = (slug: string) => {
    const old = pollTimers.current.get(slug);
    if (old) clearInterval(old);
    let tries = 0;
    const timer = setInterval(() => {
      void refreshStatus([slug]).then((services) => {
        const state = services[slug];
        if (++tries >= 24 || (state?.connected && !state.pending) || (state?.status && /^(expired|failed)$/i.test(state.status))) {
          clearInterval(timer);
          pollTimers.current.delete(slug);
        }
      });
    }, 5000);
    pollTimers.current.set(slug, timer);
  };

  const connect = async (slug: string, alias?: string) => {
    statusGenerations.current.set(slug, (statusGenerations.current.get(slug) ?? 0) + 1);
    setBusySlug(slug);
    setError(null);
    try {
      const request: RequestInit = { method: "POST" };
      if (alias) request.body = JSON.stringify({ alias });
      const { url } = await api(`/api/connectors/${slug}/authorize`, request);
      setPendingUrls((current) => ({ ...current, [slug]: url }));
      setStatus((current) => ({
        ...current,
        [slug]: {
          ...current[slug],
          connected: current[slug]?.connected ?? false,
          pending: true,
          status: "INITIATED",
        },
      }));
      setAliasSlug(null);
      setAliasDraft("");
      startPolling(slug);
      await openConnectUrl(url);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (requiresAccountAlias(message)) {
        // Recover gracefully if an existing account was discovered after the
        // button rendered. Show the label field and refresh only this app.
        setAliasSlug(slug);
        setAliasDraft("");
        setError(t("This app already has an account. Add a label such as work or personal to connect another."));
        void refreshStatus([slug]);
      } else {
        setError(message);
      }
    } finally {
      setBusySlug(null);
    }
  };

  const disconnectAccount = (slug: string, accountId: string) => {
    setBusySlug(slug);
    api(`/api/connectors/${slug}/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" })
      .then(() => refreshStatus([slug]))
      .catch((e) => setError(e.message))
      .finally(() => setBusySlug(null));
  };

  const close = () => dispatch({ type: "togglePlugins", open: false });
  const connectedSlugs = Object.entries(status)
    .filter(([, service]) => service.connected || Boolean(service.accounts?.length))
    .map(([slug]) => slug);
  const labelFor = (slug: string) => cards?.find((card) => card.slug === slug)?.label ?? slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  const botsUsing = state.bots.filter((bot) => !bot.hidden && bot.composio !== false).length;
  const all = cards ?? [];
  const query = search.trim().toLowerCase();
  const matching = all.filter((card) => !query || `${card.label} ${card.slug} ${card.blurb}`.toLowerCase().includes(query));
  const recommended = recommendedSlugs(all);
  const recommendedSet = new Set(recommended.map((card) => card.slug));
  const inCategory = (card: ToolkitCard) => categoryOf(card.slug) === category;

  const openBotSettings = () => {
    const target = state.bots.find((bot) => bot.id === state.selectedId && !bot.hidden) ?? state.bots.find((bot) => !bot.hidden);
    close();
    if (!target) return;
    dispatch({ type: "select", id: target.id });
    dispatch({ type: "toggleSettings", open: true });
  };

  const row = (card: ToolkitCard) => {
    const serviceStatus = status[card.slug];
    const pending = serviceStatus?.pending;
    const failed = serviceStatus?.status && /^(expired|failed)$/i.test(serviceStatus.status);
    const accounts = serviceStatus?.accounts ?? [];
    // connected with no accounts and nothing in flight = a no-auth
    // toolkit: there is no OAuth to run, so "Connect" would mint a
    // pointless authorize. It ships included.
    const included = card.noAuth === true
      || (serviceStatus?.connected === true && !accounts.length && !pending && !failed);
    const addingAccount = aliasSlug === card.slug;
    const busy = busySlug === card.slug;
    const action = rowAction(inventoryPhase, {
      busy,
      included,
      canContinue: Boolean(pending && pendingUrls[card.slug]),
      hasAccounts: accounts.length > 0,
      failed: Boolean(failed),
    });
    // keep the legacy label available to assistive tech (and the tests' wording)
    const legacyLabel = connectorActionLabel(inventoryPhase, { busy, included, canContinue: Boolean(pending && pendingUrls[card.slug]), hasAccounts: accounts.length > 0, failed: Boolean(failed) });
    return (
      <div key={card.slug} className="border-t border-hairline/25 py-3 [&:nth-child(-n+2)]:border-t-0">
        <div className="flex min-h-10 items-center gap-3">
          <AppTile label={card.label} slug={card.slug} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-semibold leading-[1.35] text-ink">{card.label}</div>
            <div className="truncate text-[12.5px] leading-[1.4] text-ink-secondary">
              {pending ? t("Finish setup in your browser") : failed && !accounts.length ? t("Authorization expired — try again") : t(card.blurb)}
            </div>
          </div>
          <button
            type="button"
            disabled={!configured || inventoryPhase !== "ready" || busy || included}
            onClick={() => {
              if (pending && pendingUrls[card.slug]) {
                setError(null);
                void openConnectUrl(pendingUrls[card.slug]).catch((e) => setError(e.message));
              } else if (accounts.length) {
                setAliasSlug((current) => current === card.slug ? null : card.slug);
                setAliasDraft("");
              } else void connect(card.slug);
            }}
            aria-label={legacyLabel ? `${legacyLabel} · ${card.label}` : card.label}
            className={cn(
              "inline-flex h-7 min-w-[64px] shrink-0 items-center justify-center gap-1 rounded-full px-3.5 text-[12.5px] font-semibold transition-colors disabled:cursor-default",
              action.done ? "bg-control/60 font-medium text-ink-secondary hover:bg-control" : "bg-control text-ink hover:bg-raised-hover disabled:opacity-40",
              action.done && included && "disabled:opacity-100",
            )}
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <>{action.done && <Check size={12} />}{action.label}</>}
          </button>
        </div>
        {accounts.length > 0 && addingAccount && (
          <div className="ml-[52px] mt-2.5 space-y-1.5">
            {accounts.map((account) => {
              const active = /^active$/i.test(account.status);
              return (
                <div key={account.id} className="flex items-center gap-2 rounded-lg bg-inset px-3 py-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink">
                      {active && <Check size={13} className="shrink-0 text-success" />}
                      <span className="truncate">{account.alias || account.id}</span>
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-ink-secondary">
                      {account.alias ? `${account.id} · ` : ""}{t(ACCOUNT_STATUS_LABELS[account.status.toLowerCase()] ?? account.status.toLowerCase())}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(disconnectAccountConfirmation(card.label, account))) return;
                      disconnectAccount(card.slug, account.id);
                    }}
                    className="rounded-md px-2 py-1 text-[11.5px] text-ink-secondary transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                    aria-label={t("Disconnect {account} from {service}", { account: account.alias || account.id, service: card.label })}
                  >
                    {t("Disconnect")}
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {addingAccount && (
          <form
            className="ml-[52px] mt-2 flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const alias = aliasDraft.trim();
              if (!alias) {
                setError(t("Enter a label for the account, such as work or personal."));
                return;
              }
              void connect(card.slug, alias);
            }}
          >
            <input
              autoFocus
              value={aliasDraft}
              maxLength={64}
              onChange={(event) => setAliasDraft(event.target.value)}
              placeholder={t("Account label (work, personal…)")}
              aria-label={t("Label for another {service} account", { service: card.label })}
              className="min-w-0 flex-1 rounded-lg bg-stage px-3 py-1.5 text-[12.5px] text-ink shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_60%,transparent)] placeholder:text-ink-secondary focus:outline-none focus:shadow-[inset_0_0_0_1.5px_var(--color-select)]"
            />
            <button type="submit" disabled={busy || !aliasDraft.trim()} className="inline-flex h-7 shrink-0 items-center rounded-lg bg-primary px-2.5 text-[12.5px] font-semibold text-primary-ink hover:brightness-110 disabled:opacity-40">{t("Add account")}</button>
          </form>
        )}
      </div>
    );
  };

  const grid = (list: ToolkitCard[]) => <div className="mt-1 grid grid-cols-1 gap-x-8 md:grid-cols-2">{list.map(row)}</div>;
  const section = (title: string, note: string | null, body: ReactNode, right?: ReactNode) => (
    <section className="mt-5">
      <div className="flex h-[22px] items-baseline gap-2">
        <b className="text-[14.5px]">{title}</b>
        {note && <span className="truncate text-[12.5px] text-ink-secondary">{note}</span>}
        {right && <span className="ml-auto shrink-0 text-[12.5px] text-ink-secondary/80">{right}</span>}
      </div>
      {body}
    </section>
  );
  const teamSection = section(
    t("Team plugins"),
    t("Published by your admin, visible only to your team"),
    <div className="mt-2 rounded-xl bg-inset px-4 py-3.5 text-[12.5px] leading-relaxed text-ink-secondary">{t("No team plugins yet. When your admin publishes one, it shows up here with a Team tag.")}</div>,
  );
  const chips: Array<{ value: CategoryChip; label: string }> = [
    { value: "all", label: t("All") },
    { value: "recommended", label: t("Recommended") },
    { value: "team", label: t("Team") },
    ...CATEGORY_ORDER.map((value) => ({ value, label: t(CATEGORY_LABEL[value]) })),
  ];

  return (
    <Sheet onClose={close}>
      <header className="flex shrink-0 items-start gap-3 pb-1 pl-7 pr-4 pt-5">
        <div className="min-w-0 flex-1">
          <h2 id="connected-apps-title" className="text-[20px] font-bold leading-7 tracking-[-0.2px] text-ink">{t("Connect apps")}</h2>
          <p className="mt-0.5 text-[13px] leading-normal text-ink-secondary">{t("Give your bots the software your team uses — read docs, send messages, push code — always within what you allow.")}</p>
        </div>
        <button
          type="button"
          onClick={() => void loadConnectionInventory(true)}
          disabled={refreshing}
          className="grid size-8 place-items-center rounded-lg text-ink-secondary hover:bg-raised-hover hover:text-ink disabled:opacity-50"
          title={t("Refresh connection status")}
          aria-label={t("Refresh connection status")}
        >
          <RefreshCw size={15} className={cn(refreshing && "animate-spin")} />
        </button>
        <button type="button" onClick={close} aria-label={t("Close connected apps")} className="grid size-8 place-items-center rounded-lg text-ink-secondary hover:bg-raised-hover hover:text-ink">
          <X size={17} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-5 pt-3">
        {stale && (
          // Say which of the two things is true. Silence here is what makes a
          // remembered list indistinguishable from a confirmed one.
          <div className="mb-3 flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
            <TriangleAlert size={14} className="mt-px shrink-0" />
            <span>
              {t("Showing what was connected last time — this Mac's credential store could not be opened just now, so these could not be re-checked. Your apps are still connected; restarting OpenMausBot usually clears this.")}
            </span>
          </div>
        )}
        {/* Two notices about the same fact is one too many: the stale banner
            above already explains this launch, and "configure your own
            connection service" is advice for someone who never set one up. */}
        {!configured && !stale && (
          <div className="mb-3 rounded-xl bg-warning/10 px-4 py-3 text-[13px] text-warning">
            {t("Connected apps are temporarily unavailable. You can retry after restarting, or configure your own connection service.")}{" "}
            <button
              type="button"
              className="font-medium underline underline-offset-2"
              onClick={() => {
                close();
                dispatch({ type: "toggleAppSettings", open: true });
              }}
            >
              {t("Open settings")}
            </button>
          </div>
        )}
        {configured && source === "curated" && mode === "self-hosted" && (
          <div className="mb-3 text-[12px] text-ink-secondary">
            {tRich("Showing featured apps. <link>Update your Composio key</link> for the full catalog.", {
              link: (children) => (
                <button
                  type="button"
                  className="underline underline-offset-2 hover:text-ink"
                  onClick={() => {
                    close();
                    dispatch({ type: "toggleAppSettings", open: true });
                  }}
                >
                  {children}
                </button>
              ),
            })}
          </div>
        )}
        {error && <div role="alert" className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}

        {/* 已连接 N + monograms + 管理 */}
        <div className="flex h-[52px] items-center gap-2 rounded-xl bg-inset pl-3 pr-3.5 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_25%,transparent)]">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-raised text-ink-secondary shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_45%,transparent)]"><Plug size={15} /></span>
          <b className="shrink-0 text-[13.5px]">{t("Connected")}</b>
          <span className="mr-2 shrink-0 text-[13px] font-semibold text-ink-secondary">{inventoryPhase === "loading" ? "…" : connectedSlugs.length}</span>
          <span className="flex min-w-0 gap-[5px] overflow-hidden">
            {connectedSlugs.slice(0, 10).map((slug) => <AppTile key={slug} label={labelFor(slug)} slug={slug} size={24} />)}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => {
              close();
              dispatch({ type: "showPage", page: "apps" });
            }}
            className="inline-flex shrink-0 items-center gap-1 text-[12.5px] text-ink-secondary hover:text-ink"
          >
            {t("{count} bots use them · Manage", { count: botsUsing })}
            <ArrowRight size={15} />
          </button>
        </div>

        <label className="mt-3.5 flex h-10 items-center gap-2.5 rounded-xl bg-stage px-3.5 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent)] focus-within:shadow-[inset_0_0_0_1.5px_var(--color-select)]">
          <Search size={16} className="shrink-0 text-ink-secondary" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("Search apps, e.g. Feishu, Notion, GitHub")}
            aria-label={t("Search apps")}
            className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink placeholder:text-ink-secondary/80 focus:outline-none"
          />
        </label>

        <div className="mt-3 flex flex-wrap gap-1.5" role="tablist" aria-label={t("Categories")}>
          {chips.map((chip) => (
            <button
              key={chip.value}
              type="button"
              role="tab"
              aria-selected={category === chip.value}
              onClick={() => setCategory(chip.value)}
              className={cn(
                "inline-flex h-[30px] items-center rounded-full px-[13px] text-[13px] whitespace-nowrap transition-colors",
                category === chip.value ? "bg-primary font-semibold text-primary-ink" : "bg-control/60 font-medium text-ink-secondary hover:bg-control hover:text-ink",
              )}
            >
              {chip.label}
            </button>
          ))}
        </div>

        {cards === null ? (
          <div className="flex items-center justify-center gap-2 py-24 text-[13px] text-ink-secondary">
            <Loader2 size={14} className="animate-spin" /> {t("Loading catalog…")}
          </div>
        ) : query ? (
          section(t("Search results"), null, matching.length ? grid(matching) : <NoApps title={t("No apps found")} detail={t("Try a different search.")} />)
        ) : category === "all" ? (
          <>
            {recommended.length > 0 && section(t("Recommended"), t("Picked from what teams like yours use"), grid(recommended), t("{count} apps in all", { count: all.length }))}
            {section(t("All apps"), null, grid(all.filter((card) => !recommendedSet.has(card.slug))), recommended.length ? undefined : t("{count} apps in all", { count: all.length }))}
            {teamSection}
          </>
        ) : category === "recommended" ? (
          section(t("Recommended"), t("Picked from what teams like yours use"), recommended.length ? grid(recommended) : <NoApps title={t("No apps found")} />)
        ) : category === "team" ? (
          teamSection
        ) : (
          section(t(CATEGORY_LABEL[category]), null, all.filter(inCategory).length ? grid(all.filter(inCategory)) : <NoApps title={t("No apps found")} detail={t("This catalog has no apps in this category yet.")} />)
        )}
      </div>

      <footer className="flex h-[52px] shrink-0 items-center gap-2 border-t border-hairline/25 bg-inset/60 px-7 text-[12.5px] text-ink-secondary">
        <ShieldCheck size={15} className="shrink-0" />
        <span className="min-w-0 truncate">{t("Connect once and every allowed bot can use it; each bot can switch it off.")}</span>
        <span className="flex-1" />
        <button type="button" onClick={openBotSettings} className="inline-flex shrink-0 items-center gap-0.5 font-semibold text-accent-text hover:underline">
          {t("Manage in bot settings")}
          <ArrowRight size={13} />
        </button>
      </footer>
    </Sheet>
  );
}
