import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Menu } from "lucide-react";
import { StoreProvider, useStore, type AppView } from "@/state/store";
import { Onboarding } from "@/components/Onboarding";
import { emailGateDone, initAnalytics } from "@/lib/analytics";
import { Sidebar } from "@/components/Sidebar";
import { ChatView } from "@/components/ChatView";
import { GroupView } from "@/components/GroupView";
import { SettingsPanel } from "@/components/SettingsPanel";
import { PluginsPanel, preloadConnectedApps } from "@/components/PluginsPanel";
import { ComputerPanel } from "@/components/ComputerPanel";
import { InspectorPanel } from "@/components/InspectorPanel";
import { SettingsModal } from "@/components/SettingsModal";
import { UpdateBanner } from "@/components/UpdateBanner";
import { DesktopCapabilitiesProvider } from "@/components/DesktopCapabilities";
import { RoutinesPage } from "@/components/RoutinesPage";
import { NoEngines } from "@/components/NoEngines";
import { CommandPalette } from "@/components/CommandPalette";
import { LocalVmWorkspace } from "@/components/LocalVmWorkspace";
import { BrowserWorkspace } from "@/components/BrowserWorkspace";
import { SkillRecorderPage } from "@/components/SkillRecorderPage";
import { TeamMapPage } from "@/components/TeamMapPage";
import { BriefPage } from "@/components/brief/BriefPage";
import { LibraryPage } from "@/components/library/LibraryPage";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { AppsPage } from "@/components/apps/AppsPage";
import { heldComputerControlBotIds } from "@/lib/computer-control";
import { skillRecorderEnabled } from "@/lib/feature-flags";
import { t, tRich } from "@/lib/i18n";

function Shell() {
  const { state, dispatch } = useStore();
  const unreadCount =
    state.bots.filter((bot) => !bot.hidden && bot.unread).length +
    state.groups.filter((group) => group.unread).length;
  // Mobile-only drawer state. Above md, none of these properties are emitted
  // at all — Sidebar scopes every mobile class with max-md: rather than
  // cancelling them with md:, which would still emit a translate value and
  // turn the aside into a containing block for its fixed descendants (see
  // Sidebar.tsx's className comment).
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [localVmWorkspaceBotId, setLocalVmWorkspaceBotId] = useState<string | null>(null);
  // the Browser tab, expanded into the main column (the small preview in
  // the panel hands off to this and back)
  const [browserWorkspaceBotId, setBrowserWorkspaceBotId] = useState<string | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const previousViewRef = useRef(state.activeView);
  const calendarOriginRef = useRef<Exclude<AppView, "routines">>("chat");
  const group = state.groups.find((g) => g.id === state.selectedId);
  const bot = group ? undefined : (state.bots.find((b) => b.id === state.selectedId) ?? state.bots[0]);

  // Nothing on this machine can run a bot. A missing cloud login does not
  // count — that CLI can still host a local model. Wait for the first
  // /api/instances response before deciding: an empty list means "not asked
  // yet", and flashing the setup screen at every launch would be worse.
  const noEngines =
    state.connected &&
    state.instances.length > 0 &&
    !state.instances.some((i) => i.snapshot.state === "available");

  // App-wide shortcuts: ⌘N new bot · ⌘1–9 jump to bot · ⌘⇧[ / ⌘⇧] prev/next.
  // Kept deliberately small; every panel already closes on Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const bots = state.bots.filter((b) => !b.hidden);
      if (e.key === "n" && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: "newBot" });
      } else if (e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
        // C1: ⇧⌘B workbench and ⌘, settings, as listed in ⌘K. The desktop
        // menu owns both accelerators natively; this covers the browser build.
        e.preventDefault();
        dispatch({ type: "showTeamMap" });
      } else if (e.key === "," && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        dispatch({ type: "toggleAppSettings", open: true });
      } else if (/^[1-9]$/.test(e.key)) {
        const target = bots[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          dispatch({ type: "select", id: target.id });
        }
      } else if (e.shiftKey && (e.key === "[" || e.key === "]")) {
        const idx = bots.findIndex((b) => b.id === state.selectedId);
        const next = bots[(idx + (e.key === "]" ? 1 : -1) + bots.length) % bots.length];
        if (next) {
          e.preventDefault();
          dispatch({ type: "select", id: next.id });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.bots, state.selectedId, dispatch]);

  useEffect(() => {
    window.ogb?.setUnreadCount?.(unreadCount);
  }, [unreadCount]);

  // Menu-bar items that live in the page (electron/app-menu.mjs).
  useEffect(
    () =>
      window.ogb?.onMenuCommand?.((name) => {
        if (name === "new-bot") dispatch({ type: "newBot" });
        else if (name === "open-settings") dispatch({ type: "toggleAppSettings", open: true });
        else if (name === "open-workbench") dispatch({ type: "showTeamMap" });
      }),
    [dispatch],
  );

  // Re-assert every authoritative positive hold in the process that owns the
  // native browser. This covers initial hydration, SSE updates from another
  // computer surface, and renderer reloads. Deliberately never mirror false:
  // only a trusted two-phase release may open Electron's direct browser gate.
  useEffect(() => {
    const setter = window.ogb?.browser?.setHumanControl;
    if (!setter) return;
    for (const botId of heldComputerControlBotIds(state.computerControl)) {
      void setter(botId, true).catch(() => {});
    }
  }, [state.computerControl]);

  // Warm connected-account state as soon as the local server is available.
  // The modal then opens with the correct Connect/Add account buttons and
  // quietly revalidates instead of rediscovering every account from scratch.
  useEffect(() => {
    if (!state.connected) return;
    void preloadConnectedApps().catch(() => {});
  }, [state.connected]);

  // Picking a conversation closes the drawer: on a phone the chat is what you
  // asked for, and leaving the list up would hide it. Watching activeView too
  // catches re-selecting the bot that is already current from another view —
  // the reducer switches the view without changing selectedId. pluginsOpen
  // and settingsOpen cover the same idea from a different trigger: close the
  // drawer whenever an action opens something over the chat.
  useEffect(() => {
    setDrawerOpen(false);
  }, [state.selectedId, state.activeView, state.pluginsOpen, state.settingsOpen]);

  useEffect(() => {
    if (state.activeView === "routines" && previousViewRef.current !== "routines") {
      calendarOriginRef.current = previousViewRef.current;
    }
    previousViewRef.current = state.activeView;
  }, [state.activeView]);

  useEffect(() => {
    if (
      localVmWorkspaceBotId &&
      (state.activeView !== "chat" || state.selectedId !== localVmWorkspaceBotId)
    ) {
      setLocalVmWorkspaceBotId(null);
    }
  }, [localVmWorkspaceBotId, state.activeView, state.selectedId]);

  const openLocalVmWorkspace = (botId: string) => {
    dispatch({ type: "toggleComputer", open: false });
    setLocalVmWorkspaceBotId(botId);
  };
  const openBrowserWorkspace = useCallback((botId: string) => {
    dispatch({ type: "toggleComputer", open: false });
    setBrowserWorkspaceBotId(botId);
  }, [dispatch]);
  const closeBrowserWorkspace = useCallback(() => {
    setBrowserWorkspaceBotId(null);
    dispatch({ type: "toggleComputer", open: true });
  }, [dispatch]);
  useEffect(() => {
    if (browserWorkspaceBotId && (state.activeView !== "chat" || state.selectedId !== browserWorkspaceBotId)) {
      setBrowserWorkspaceBotId(null);
    }
  }, [browserWorkspaceBotId, state.activeView, state.selectedId]);

  const openComputerFromWorkspace = (botId: string) => {
    setLocalVmWorkspaceBotId(null);
    dispatch({ type: "select", id: botId });
    dispatch({ type: "toggleComputer", open: true });
  };

  const closeCalendar = useCallback(() => {
    if (calendarOriginRef.current === "team-map") {
      dispatch({ type: "showTeamMap" });
      return;
    }
    if (calendarOriginRef.current === "skill-recorder" && skillRecorderEnabled(state.config)) {
      dispatch({ type: "showSkillRecorder" });
      return;
    }
    const origin = calendarOriginRef.current;
    if (origin === "brief" || origin === "library" || origin === "settings" || origin === "apps") {
      dispatch({ type: "showPage", page: origin });
      return;
    }
    dispatch({ type: "select", id: state.selectedId });
  }, [dispatch, state.config, state.selectedId]);
  const openCalendarRoom = useCallback((id: string) => {
    dispatch({ type: "select", id });
  }, [dispatch]);

  const nativeViewOverlayOpen =
    drawerOpen ||
    paletteOpen ||
    state.settingsOpen ||
    state.computerOpen ||
    state.inspectorOpen ||
    state.appSettingsOpen ||
    state.pluginsOpen;

  // The viewer outlives ComputerPanel and can target any bot, so release control
  // here (always mounted) when a bot's viewer closes. release() is idempotent.
  useEffect(() => {
    return window.ogb?.desktopViewer?.onState((viewer) => {
      if (viewer.open || !viewer.contextId) return;
      const botId = viewer.contextId;
      void fetch(`/api/bots/${botId}/computer/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "release" }),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((snap) => {
          if (snap) dispatch({ type: "computerControl", botId, held: snap.held === true, helpReason: snap.helpReason ?? null });
        })
        .catch(() => {});
      void fetch(`/api/bots/${botId}/computer/viewer-close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }).catch(() => {});
    });
  }, [dispatch]);

  // C1 shell: one ground (bg-panel) under the sidebar and around the stage
  // card, so the sidebar needs no edge of its own; the sidebar now stays on
  // the calendar too (U14), so there is no calendar focus mode any more.
  return (
    <div className="flex h-full flex-col bg-panel">
      {/* fixed-position popup, bottom-left — outside the layout flow */}
      <UpdateBanner />
      <div className="relative flex min-h-0 flex-1">
      <button
        type="button"
        ref={menuButtonRef}
        aria-label={t("Open bot list")}
        aria-expanded={drawerOpen}
        onClick={() => setDrawerOpen(true)}
        className="absolute left-3.5 top-3.5 z-30 grid size-8 place-items-center rounded-[9px] text-ink-secondary hover:bg-raised-hover hover:text-ink md:hidden"
      >
        <Menu size={18} />
      </button>
      {drawerOpen && (
        <div
          aria-hidden
          onMouseDown={(e) => e.target === e.currentTarget && setDrawerOpen(false)}
          className="absolute inset-0 z-30 bg-[rgb(20_22_28/0.38)] md:hidden"
        />
      )}
      <Sidebar
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          menuButtonRef.current?.focus();
        }}
      />
      {/* The stage: the main view and its side panels share one surface. Fog
          draws it as an inset card (the --stage-* tokens); the other skins
          keep it edge to edge. Below md the sidebar is a drawer, so the card
          keeps its gap on the left too. */}
      <div className="flex min-h-0 min-w-0 flex-1 p-[var(--stage-gap)] md:pl-0">
      <div
        className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-stage"
        style={{ borderRadius: "var(--stage-radius)", outline: "1px solid var(--stage-border)", outlineOffset: -1 }}
      >
      {state.activeView === "brief" ? (
        <BriefPage />
      ) : state.activeView === "library" ? (
        <LibraryPage />
      ) : state.activeView === "settings" ? (
        <SettingsPage />
      ) : state.activeView === "apps" ? (
        <AppsPage />
      ) : state.activeView === "team-map" ? (
        <TeamMapPage />
      ) : state.activeView === "routines" ? (
        <RoutinesPage onBack={closeCalendar} onOpenRoom={openCalendarRoom} />
      ) : state.activeView === "skill-recorder" ? (
        <SkillRecorderPage />
      ) : browserWorkspaceBotId && bot && bot.id === browserWorkspaceBotId ? (
        <BrowserWorkspace bot={bot} onClose={closeBrowserWorkspace} />
      ) : localVmWorkspaceBotId ? (
        <LocalVmWorkspace
          primaryBotId={localVmWorkspaceBotId}
          overlayOpen={nativeViewOverlayOpen}
          onClose={() => setLocalVmWorkspaceBotId(null)}
          onOpenComputer={openComputerFromWorkspace}
        />
      ) : noEngines ? (
        <NoEngines />
      ) : group ? (
        <GroupView key={group.id} group={group} />
      ) : bot ? (
        <ChatView bot={bot} />
      ) : (
        <main className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-app text-ink-secondary">
          <Loader2 size={20} className="animate-spin" />
          <div className="text-[14px]">
            {state.connected ? t("No bots yet") : t("Connecting to the bot server…")}
          </div>
          {!state.connected && (
            <div className="text-[12px]">
              {tRich("Start it with <code>pnpm dev:server</code>", {
                code: (children) => <code className="rounded bg-raised px-1.5 py-0.5">{children}</code>,
              })}
            </div>
          )}
        </main>
      )}
      {state.settingsOpen && bot && <SettingsPanel bot={bot} />}
      {state.computerOpen && bot && (
        <ComputerPanel
          key={bot.id}
          bot={bot}
          onOpenVmWorkspace={openLocalVmWorkspace}
          onExpandBrowser={openBrowserWorkspace}
        />
      )}
      {state.inspectorOpen && bot && <InspectorPanel bot={bot} />}
      </div>
      </div>
      {state.appSettingsOpen && <SettingsModal />}
      {state.pluginsOpen && <PluginsPanel />}
      {/* mounted after the modals: same z-50 tier, so DOM order keeps the
          palette on top when one of them is open underneath */}
      <CommandPalette onOpenChange={setPaletteOpen} />
      </div>
    </div>
  );
}

export default function App() {
  const [gated, setGated] = useState(() => !emailGateDone());
  useEffect(() => {
    initAnalytics();
  }, []);
  return (
    <DesktopCapabilitiesProvider>
      <StoreProvider>
        <Shell />
        {gated && <Onboarding onDone={() => setGated(false)} />}
      </StoreProvider>
    </DesktopCapabilitiesProvider>
  );
}
