// The bot's computer, in the right-side slot (U16: "<bot>的电脑" — live screen,
// 步骤记录 with 回放, 接管 / 还给). Where it runs decides the whole flow: cloud → provision the box on open (idempotent) and preview
// via SSE frames or a ~4s screenshot poll. macOS local mode keeps the legacy
// in-panel capture. Linux local mode is an automation readiness state and its
// separate preview remains explicitly user-initiated. Auto never selects a
// Linux user's desktop.
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  CalendarClock,
  CalendarDays,
  Columns2,
  Eye,
  Hand,
  History,
  Loader2,
  Maximize2,
  Monitor,
  Moon,
  Plus,
  Power,
  Settings,
  X,
} from "lucide-react";
import { api, useStore, type Bot } from "@/state/store";
import type { Routine } from "@/lib/routines";
import { ApiKeyRow } from "./ApiKeys";
import { cn } from "@/lib/cn";
import { intlLocale, msg, t, tRich } from "@/lib/i18n";
import { usePageVisible } from "@/lib/page-visible";
import { CloudBackendPicker } from "./CloudBackendPicker";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { RoutineEditor } from "./RoutinesPage";
import { AndroidDevicePanel, useAndroidUsbDevices } from "./AndroidDevicePanel";
import { BrowserPanel } from "./BrowserPanel";
import { builtInBrowserEnabled } from "@/lib/feature-flags";
import { transitionComputerControlLease, type ComputerControlAction } from "@/lib/computer-control";
import { LocalScreenPreview } from "./LocalScreenPreview";
import { LinuxLocalControl } from "./LinuxLocalControl";
import { MacLocalControl } from "./MacLocalControl";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import { Switch } from "./SettingsPrimitives";
import { Button, Pill, Segmented, type PillTone } from "./ui";
import { StepStrip } from "./computer/StepStrip";
import { computerSteps } from "@/lib/computer-steps";
import { clockTime } from "@/lib/calendar-view";
import { liveActivityLabel } from "@/lib/live-activity";
import {
  autoSelectsLocalComputer,
  instanceSupportsLocalComputer,
  linuxAutoDescription,
  localComputerDisabledReason,
  localComputerSelectable,
} from "@/lib/local-computer";
import {
  readComputerPanelView,
  writeComputerPanelView,
  type ComputerPanelView,
} from "@/lib/computer-panel-view";

interface VpsComputerStatus {
  configured: boolean;
  imageMatches: boolean;
  managed: boolean;
  container: "running" | "stopped" | "missing";
  ready: boolean;
  problem: string | null;
}

type Phase =
  | "checking"
  | "unconfigured"
  | "starting"
  | "ready"
  | "vm"
  | "vm-unavailable"
  | "vps-unconfigured"
  | "vps-incompatible"
  | "vps-stopped"
  | "local"
  | "local-unavailable"
  | "off"
  | "error";

interface LocalVmStatus {
  mode: "shared" | "per-bot";
  max_instances: number;
  image: boolean;
  create_supported: boolean;
  container: "running" | "stopped" | "missing";
  imageMatches: boolean;
  managed: boolean;
  network: "loopback" | "unsafe" | "unknown";
  security: "hardened" | "unsafe" | "unknown";
  persistence: "durable" | "unsafe" | "unknown";
  desktopReady: boolean;
  ready: boolean;
  problem: string | null;
  viewer_url: string;
}

const computerControlSnapshotSchema = z.object({
  held: z.boolean().optional().default(false),
  helpReason: z.string().nullable().optional().default(null),
}).passthrough();

function routineScheduleLabel(routine: Routine) {
  if (routine.schedule.type === "once") {
    return new Date(routine.schedule.at).toLocaleString(intlLocale(), {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
  const days = routine.schedule.weekdays;
  const cadence =
    days.length === 7
      ? t("Every day")
      : days.join(",") === "1,2,3,4,5"
        ? t("Weekdays")
        : days.map((day) => t([msg("Sun"), msg("Mon"), msg("Tue"), msg("Wed"), msg("Thu"), msg("Fri"), msg("Sat")][day])).join(", ");
  const [hour, minute] = routine.schedule.time.split(":").map(Number);
  return `${cadence} · ${new Date(2000, 0, 1, hour, minute).toLocaleTimeString(intlLocale(), { hour: "numeric", minute: "2-digit" })}`;
}

function nextRunLabel(at: number | null) {
  if (at == null) return t("Paused");
  const date = new Date(at);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? t("Today, {time}", { time: date.toLocaleTimeString(intlLocale(), { hour: "numeric", minute: "2-digit" }) })
    : date.toLocaleString(intlLocale(), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const PANEL_WIDTH_KEY = "omb-computer-panel-width";
const PANEL_MIN_WIDTH = 360;
const PANEL_MAX_WIDTH = 960;
/** U16: the live screen wants room — about half the window by default. */
function defaultPanelWidth(): number {
  const half = typeof window === "undefined" ? 640 : Math.round(window.innerWidth / 2);
  return Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, half));
}

function readPanelWidth(): number {
  try {
    const stored = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    if (Number.isFinite(stored) && stored >= PANEL_MIN_WIDTH && stored <= PANEL_MAX_WIDTH) return stored;
  } catch {
    /* storage blocked — default width */
  }
  return defaultPanelWidth();
}

export function ComputerPanel({
  bot,
  onOpenVmWorkspace,
  onExpandBrowser,
}: {
  bot: Bot;
  onOpenVmWorkspace?: (botId: string) => void;
  onExpandBrowser?: (botId: string) => void;
}) {
  // The panel is a fixed column by default; a drag handle on its left edge
  // makes it wide enough to actually read a page in the Browser tab.
  const [panelWidth, setPanelWidth] = useState(readPanelWidth);
  const resizeFrom = useRef<{ x: number; width: number } | null>(null);
  const onResizeStart = (event: React.PointerEvent<HTMLDivElement>) => {
    resizeFrom.current = { x: event.clientX, width: panelWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onResizeMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeFrom.current) return;
    const next = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, resizeFrom.current.width + (resizeFrom.current.x - event.clientX)));
    setPanelWidth(next);
  };
  const onResizeEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeFrom.current) return;
    resizeFrom.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth));
    } catch {
      /* storage blocked — width lives for this session */
    }
  };
  const { state, dispatch } = useStore();
  const { capabilities, ready: capabilitiesReady } = useDesktopCapabilities();
  const localAvailable = capabilities.localComputer.available;
  const isLinux = capabilities.host.platform === "linux";
  const providerSupportsLocal = instanceSupportsLocalComputer(state.instances, bot);
  const localSelectable = localComputerSelectable({ capabilities, providerSupportsLocal });
  const [localAutoWarning, setLocalAutoWarning] = useState(false);
  const localDisabledReason = localComputerDisabledReason({ capabilities, providerSupportsLocal });
  const [phase, setPhase] = useState<Phase>("checking");
  const [boxState, setBoxState] = useState<string | null>(null);
  const [polledFrame, setPolledFrame] = useState<{ png: string; mime: string } | null>(null);
  const [vmFrame, setVmFrame] = useState<string | null>(null);
  // The Local VM's interactive noVNC viewer (passworded, autoconnect). The
  // preview below is a periodic screenshot that swallows clicks — this URL is
  // the only way a person can actually drive the VM.
  const [vmViewerUrl, setVmViewerUrl] = useState<string | null>(null);
  const [vmStatus, setVmStatus] = useState<LocalVmStatus | null>(null);
  const [vpsStatus, setVpsStatus] = useState<VpsComputerStatus | null>(null);
  const [localFrame, setLocalFrame] = useState<string | null>(null);
  const [pending, setPending] = useState<
    "join" | "sleep" | "provision" | "vps-replace" | "vm-create" | "vm-recreate" | "vm-delete" | null
  >(null);
  const [controlPending, setControlPending] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creatingRoutine, setCreatingRoutine] = useState(false);
  // 回放: which step's frame the screen shows (null = live) and the frame's real size
  const [replay, setReplay] = useState<number | null>(null);
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);
  const [panelView, setPanelView] = useState<ComputerPanelView>(() => readComputerPanelView(bot.id));
  const androidStatus = useAndroidUsbDevices();
  const androidConnected = androidStatus.devices.length > 0;
  // the built-in browser: a per-bot switch in Settings, and only the desktop app has one
  const browserEnabled = builtInBrowserEnabled(state.config) && bot.browser !== false && Boolean(window.ogb?.browser);
  // bumped when a Box API key is saved inline, to re-run the spin-up flow
  const [retry, setRetry] = useState(0);
  const vmReadinessAttempts = useRef(0);
  const selectedInstance = state.instances.find(
    (instance) => instance.instanceId === bot.modelSelection.instanceId,
  );

  const selectPanelView = (view: ComputerPanelView) => {
    setPanelView(view);
    writeComputerPanelView(bot.id, view);
  };

  useEffect(() => {
    setPanelView(readComputerPanelView(bot.id));
  }, [bot.id]);

  // Pause the screenshot poll while this bot's viewer is open; seed from the
  // live viewer so a remount/switch mid-session doesn't wrongly resume it.
  useEffect(() => {
    let alive = true;
    const dv = window.ogb?.desktopViewer;
    if (dv?.currentState) {
      void dv
        .currentState()
        .then((s) => {
          if (alive) setViewerOpen(s.open && s.contextId === bot.id);
        })
        .catch(() => {});
    }
    const off = dv?.onState((viewer) => {
      if (viewer.contextId === bot.id) setViewerOpen(viewer.open);
    });
    return () => {
      alive = false;
      off?.();
    };
  }, [bot.id]);

  useEffect(() => {
    if ((!androidConnected && panelView === "android") || (!browserEnabled && panelView === "browser")) {
      setPanelView("computer");
      writeComputerPanelView(bot.id, "computer");
    }
  }, [androidConnected, bot.id, browserEnabled, panelView]);
  useEffect(() => {
    vmReadinessAttempts.current = 0;
  }, [bot.id, bot.computer]);
  const vmSupported = Boolean(
    selectedInstance?.snapshot.state === "available" &&
      selectedInstance.capabilities?.computerMcp &&
      selectedInstance.driverKind !== "boxAgent",
  );
  const computerToolSupported = selectedInstance?.capabilities?.computerMcp === true;
  const vpsSupported = Boolean(computerToolSupported && selectedInstance?.driverKind !== "boxAgent");
  const cloudBackend = bot.cloudBackend ?? "box";
  const cloudSupported = cloudBackend === "vps"
    ? vpsSupported
    : computerToolSupported || selectedInstance?.driverKind === "boxAgent";
  const botRoutines = state.routines
    .filter((routine) => routine.botId === bot.id)
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity));
  const cloudRoutineReady = Boolean(
    state.config?.box.configured &&
      state.instances.some((instance) => instance.driverKind === "boxAgent" && instance.snapshot.state === "available"),
  );
  const activeRoutineRun = state.routineRuns.find(
    (run) => run.botId === bot.id && ["queued", "running", "waiting"].includes(run.status),
  );
  const computerDestination =
    bot.computer === "cloud"
      ? cloudBackend === "vps" ? "this self-hosted VPS" : "this cloud box"
      : bot.computer === "vm"
        ? "the Local VM"
      : bot.computer === "local"
        ? "this computer"
        : bot.computer === "off"
          ? null
          : phase === "ready"
            ? cloudBackend === "vps" ? "the self-hosted VPS selected by Auto" : "the cloud box selected by Auto"
            : "this computer selected by Auto";

  // resolve the mode on open; box endpoints are only ever hit on the
  // cloud path, so local/off can never render a JSON error as an image
  useEffect(() => {
    // Browser and Android own their own live surfaces. Do not provision a VM,
    // wake a box, or churn preview state behind either tab.
    if (panelView !== "computer") return;
    let alive = true;
    setPhase("checking");
    setPolledFrame(null);
    setVmFrame(null);
    setVmViewerUrl(null);
    setVmStatus(null);
    setVpsStatus(null);
    setLocalFrame(null);
    setError(null);
    if (bot.computer === "off") {
      setPhase("off");
      return;
    }
    if (bot.computer === "local") {
      if (!providerSupportsLocal) {
        setError(t("This model engine cannot control this computer. Choose Claude or an ACP engine."));
      }
      setPhase(capabilitiesReady && localAvailable && providerSupportsLocal ? "local" : "local-unavailable");
      return;
    }
    if (bot.computer === "vm") {
      if (!vmSupported) {
        setError(t("This model engine cannot use the Local VM. Choose Claude or an ACP engine."));
        setPhase("vm-unavailable");
        return;
      }
      let retryTimer: number | undefined;
      api(`/api/bots/${bot.id}/local-computer`)
        .then((rawStatus) => {
          if (!alive) return;
          const status: LocalVmStatus = rawStatus;
          setVmStatus(status);
          // parse at the boundary: our own status endpoint sends a string or nothing
          const viewerUrl = String(status.viewer_url ?? "");
          if (viewerUrl.startsWith("http")) setVmViewerUrl(viewerUrl);
          if (status.ready) {
            vmReadinessAttempts.current = 0;
            setPhase("vm");
          } else if (
            status.container === "running" &&
            status.imageMatches &&
            status.managed &&
            status.network === "loopback" &&
            status.security === "hardened" &&
            status.persistence === "durable" &&
            !status.desktopReady &&
            vmReadinessAttempts.current < 15
          ) {
            vmReadinessAttempts.current += 1;
            setError(null);
            setPhase("checking");
            retryTimer = window.setTimeout(() => setRetry((n) => n + 1), 2000);
          }
          else {
            const canCreateHere =
              status.mode === "per-bot" &&
              status.container === "missing" &&
              status.image &&
              status.create_supported;
            setError(canCreateHere ? null : t("{problem}. Open App Settings → Local VM.", { problem: status.problem ?? t("The Local VM is not ready") }));
            setPhase("vm-unavailable");
          }
        })
        .catch((e) => {
          if (!alive) return;
          setError(e.message);
          setPhase("vm-unavailable");
        });
      return () => {
        alive = false;
        if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      };
    }
    if (bot.computer === "cloud" && !cloudSupported) {
      setError(t("This model engine cannot use cloud computer tools. Choose Claude, an ACP engine, or the Computer engine."));
      setPhase("error");
      return;
    }
    if (bot.computer !== "cloud" && !capabilitiesReady) return;
    if (cloudBackend === "vps") {
      const autoLocal =
        !isLinux && bot.computer !== "cloud" && capabilitiesReady && localSelectable;
      if (!vpsSupported) {
        if (autoLocal) setPhase("local");
        else {
          setError(t("This model engine cannot use a self-hosted VPS. Choose Claude or an ACP engine, or switch the cloud backend to Box."));
          setPhase("error");
        }
        return;
      }
      api(`/api/bots/${bot.id}/computer`)
        .then((rawStatus) => {
          if (!alive) return;
          const status: VpsComputerStatus = rawStatus;
          setVpsStatus(status);
          if (!status.configured) {
            if (autoLocal) setPhase("local");
            else {
              setError(t("Add the VPS SSH config alias in App Settings → Connections."));
              setPhase("vps-unconfigured");
            }
            return;
          }
          if (status.ready) {
            setBoxState(status.container ?? null);
            setPhase("ready");
            return;
          }
          // App updates can bump IMAGE_LAYER_VERSION while this bot still has
          // a managed container from the previous release. Provision refuses
          // to overwrite it by design, so surface the explicit replacement
          // path instead of automatically issuing a request that can only 409.
          if (status.managed && status.container !== "missing" && !status.imageMatches) {
            setError(status.problem);
            setPhase("vps-incompatible");
            return;
          }
          if (bot.computer === "cloud") {
            setPhase("starting");
            return api(`/api/bots/${bot.id}/computer/provision`, { method: "POST" }).then((result) => {
              if (!alive) return;
              setBoxState(result.container ?? null);
              if (result.ready) setPhase("ready");
              else {
                setError(result.problem ?? t("The VPS Cua desktop is not ready yet"));
                setPhase("error");
              }
            });
          }
          if (autoLocal) {
            setPhase("local");
            return;
          }
          setBoxState(status.container ?? null);
          setError(
            bot.autoStartVps
              ? t("{problem}. Auto will prepare or wake it when this bot next works.", { problem: status.problem ?? t("No ready VPS container") })
              : t("{problem}. Enable Start VPS automatically below, or choose Cloud to provision it.", { problem: status.problem ?? t("No ready VPS container") }),
          );
          setPhase(status.container === "stopped" ? "vps-stopped" : "vps-unconfigured");
        })
        .catch((e) => {
          if (!alive) return;
          setError(e.message);
          setPhase("error");
        });
      return () => {
        alive = false;
      };
    }
    // cloud, or auto (cloud box wins when one exists, else local in-app)
    api(`/api/bots/${bot.id}/computer`)
      .then((status) => {
        if (!alive) return;
        const autoLocal = autoSelectsLocalComputer({
          platform: capabilities.host.platform,
          computer: bot.computer,
          capabilitiesReady,
          localSelectable,
        });
        if (!status.configured) {
          setPhase(autoLocal ? "local" : "unconfigured");
          return;
        }
        if (!status.box && autoLocal) {
          setPhase("local");
          return;
        }
        setPhase("starting");
        return api(`/api/bots/${bot.id}/computer/provision`, { method: "POST" }).then((r) => {
          if (!alive) return;
          setBoxState(r.state ?? null);
          setPhase("ready");
        });
      })
      .catch((e) => {
        if (!alive) return;
        setError(e.message);
        setPhase("error");
      });
    return () => {
      alive = false;
    };
  }, [
    bot.id,
    bot.computer,
    bot.autoStartVps,
    cloudBackend,
    retry,
    capabilitiesReady,
    localSelectable,
    isLinux,
    providerSupportsLocal,
    vmSupported,
    cloudSupported,
    vpsSupported,
    state.config?.vps?.sshAlias,
    panelView,
  ]);

  // cloud preview: SSE frames win while the bot works; otherwise poll.
  // Every preview poll below gates on visibility and slows way down for an
  // idle bot — a drawer left open overnight must not keep shooting.
  const pageVisible = usePageVisible();
  const live = state.screens[bot.id];
  const sseFlowing = Boolean(bot.busy && live);
  const inFlight = useRef(false);
  useEffect(() => {
    if (panelView !== "computer" || phase !== "ready" || sseFlowing || viewerOpen || !pageVisible) return;
    let alive = true;
    const shoot = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const { png, format } = await api(`/api/bots/${bot.id}/computer/screenshot`, { method: "POST" });
        if (alive) setPolledFrame({ png, mime: format === "jpeg" ? "image/jpeg" : "image/png" });
      } catch {
        /* box mid-command or asleep — next tick */
      } finally {
        inFlight.current = false;
      }
    };
    void shoot();
    const timer = setInterval(shoot, bot.busy ? 4000 : 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [panelView, phase, sseFlowing, bot.id, viewerOpen, pageVisible, bot.busy]);

  // Local VM preview comes directly from Cua Driver through the harness. It
  // does not use the password-protected noVNC viewer or cloud endpoints.
  const vmInFlight = useRef(false);
  useEffect(() => {
    if (panelView !== "computer" || phase !== "vm" || viewerOpen || !pageVisible) return;
    let alive = true;
    const shoot = async () => {
      if (vmInFlight.current) return;
      vmInFlight.current = true;
      try {
        const { image } = await api(`/api/bots/${bot.id}/local-computer/screenshot`, { method: "POST" });
        if (alive && typeof image === "string") setVmFrame(image);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        vmInFlight.current = false;
      }
    };
    void shoot();
    const timer = window.setInterval(() => void shoot(), bot.busy ? 3000 : 30_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [panelView, phase, bot.id, viewerOpen, pageVisible, bot.busy]);

  // local preview: frames from the Electron main process. The FIRST capture
  // attempt is what makes macOS show the Screen Recording prompt (there is
  // no reliable pre-grant flow on macOS 15+), so repeated empty frames mean
  // the user denied — surface the Settings repair path instead of spinning.
  const [localMisses, setLocalMisses] = useState(0);
  useEffect(() => {
    if (panelView !== "computer" || phase !== "local" || !window.ogb || isLinux || !pageVisible) return;
    let alive = true;
    setLocalMisses(0);
    const shoot = async () => {
      try {
        const url = await window.ogb!.screenFrame();
        if (alive && url) setLocalFrame(url);
        else if (alive) setLocalMisses((n) => n + 1);
      } catch {
        if (alive) setLocalMisses((n) => n + 1);
      }
    };
    void shoot();
    // A real ScreenCaptureKit capture + PNG encode per tick: idle bots get a
    // slow heartbeat, working ones the live cadence.
    const timer = setInterval(shoot, bot.busy ? 3000 : 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [panelView, phase, isLinux, pageVisible, bot.busy, bot.id]);

  const lastScreenMessage = [...bot.messages].reverse().find((m) => m.kind === "screen" && m.png);
  const cloudFrame =
    live ??
    polledFrame ??
    (lastScreenMessage ? { png: lastScreenMessage.png!, mime: lastScreenMessage.mime ?? "image/png" } : null);
  const frameSrc =
    phase === "vm"
      ? vmFrame
      : phase === "local" && !isLinux
      ? localFrame
      : phase === "ready" || phase === "starting"
        ? cloudFrame && `data:${cloudFrame.mime};base64,${cloudFrame.png}`
        : null;
  const previewOpensDesktop = Boolean(
    frameSrc &&
      ((phase === "vm" && vmViewerUrl) || phase === "ready"),
  );

  // who-is-driving: SSE keeps this fresh; the mount fetch covers a panel
  // opened after the last frame (e.g. an app reload mid-hold)
  const control = state.computerControl[bot.id] ?? { held: false, helpReason: null };
  useEffect(() => {
    let alive = true;
    api(`/api/bots/${bot.id}/computer/control`)
      .then((raw) => {
        if (!alive) return;
        const snap = computerControlSnapshotSchema.parse(raw);
        dispatch({
          type: "computerControl",
          botId: bot.id,
          held: snap.held === true,
          helpReason: snap.helpReason,
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id]);
  const requestControl = useCallback(async (action: ComputerControlAction) => {
    const snap = computerControlSnapshotSchema.parse(await api(`/api/bots/${bot.id}/computer/control`, {
      method: "POST",
      body: JSON.stringify({ action }),
    }));
    dispatch({
      type: "computerControl",
      botId: bot.id,
      held: snap.held === true,
      helpReason: snap.helpReason,
    });
    return snap;
  }, [bot.id, dispatch]);

  const setNativeBrowserControl = useCallback(async (held: boolean): Promise<boolean> => {
    const setter = window.ogb?.browser?.setHumanControl;
    if (!setter) return true;
    const profile = bot.browserProfile === "guest" ? "guest" : bot.browserProfile ?? "";
    return (await setter(bot.id, held, profile)) === true;
  }, [bot.browserProfile, bot.id]);

  const transitionControl = useCallback(async (action: ComputerControlAction) => {
    // BrowserPanel performs the same two-phase transition itself. Every
    // other computer surface must also gate Electron's direct browser host:
    // the server hold is bot-wide, and a shell-capable agent can otherwise
    // bypass the server proxy while the person drives Local VM/Box/VPS.
    return transitionComputerControlLease({
      action,
      syncNativeBrowser: panelView !== "browser",
      requestControl,
      setNativeBrowserControl,
    });
  }, [panelView, requestControl, setNativeBrowserControl]);

  const controlAction = useCallback(async (action: ComputerControlAction): Promise<boolean> => {
    setControlPending(true);
    setError(null);
    try {
      await transitionControl(action);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setControlPending(false);
    }
  }, [transitionControl]);

  const expandBrowser = useCallback(() => {
    onExpandBrowser?.(bot.id);
  }, [bot.id, onExpandBrowser]);

  const openDesktop = async () => {
    setPending("join");
    setControlPending(true);
    setError(null);
    let tookControl = false;
    // A plain-web development session still needs a synchronous blank tab;
    // the packaged app uses the reliable Electron viewer window below.
    let fallbackTab: Window | null = null;
    if (!window.ogb?.desktopViewer && !window.ogb?.openExternal) {
      fallbackTab = window.open("", "_blank");
      if (fallbackTab) fallbackTab.opener = null;
    }
    try {
      if (!control.held) {
        await transitionControl("take");
        tookControl = true;
      }

      let viewerUrl = vmViewerUrl;
      if (phase === "ready") {
        const result = await api(`/api/bots/${bot.id}/computer/join`, { method: "POST" });
        viewerUrl = result.joinUrl?.constructor === String ? String(result.joinUrl) : null;
      }
      if (!viewerUrl) throw new Error(t("The computer did not return a live desktop link"));

      if (window.ogb?.desktopViewer) {
        const opened = await window.ogb.desktopViewer.open(viewerUrl, t("{name}'s live desktop", { name: bot.name }), bot.id);
        if (!opened) throw new Error(t("Ein could not open the live desktop"));
      } else if (fallbackTab) {
        fallbackTab.location.replace(viewerUrl);
      } else if (window.ogb?.openExternal) {
        const opened = await window.ogb.openExternal(viewerUrl);
        if (!opened) throw new Error(t("Ein could not open the live desktop link"));
      } else if (!window.open(viewerUrl, "_blank", "noopener")) {
        throw new Error(t("Your browser blocked the live desktop tab"));
      }
    } catch (e) {
      fallbackTab?.close();
      // Release the bot before waiting on best-effort tunnel cleanup. A sick
      // SSH process must never leave the agent paused indefinitely.
      if (tookControl) await transitionControl("release").catch(() => {});
      if (phase === "ready" && cloudBackend === "vps") {
        await api(`/api/bots/${bot.id}/computer/viewer-close`, { method: "POST", body: "{}" }).catch(() => {});
      }
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
      setControlPending(false);
    }
  };

  const run = (kind: "sleep" | "provision") => {
    setPending(kind);
    setError(null);
    api(`/api/bots/${bot.id}/computer/${kind}`, { method: "POST" })
      .then((result) => {
        if (kind === "provision") {
          setBoxState(result.container ?? null);
          if (result.ready) setPhase("ready");
          else {
            setError(result.problem ?? t("The VPS Cua desktop is not ready yet"));
            setPhase("error");
          }
        }
        if (kind === "sleep") {
          setBoxState(cloudBackend === "vps" ? "stopped" : "archived");
          if (cloudBackend === "vps") setPhase("vps-stopped");
        }
      })
      .catch((e) => {
        setError(e.message);
      })
      .finally(() => setPending(null));
  };

  const runVmAction = async (action: "vm-create" | "vm-recreate" | "vm-delete") => {
    if (
      (action === "vm-recreate" || action === "vm-delete") &&
      !window.confirm(
        action === "vm-delete"
          ? t("Delete {name}'s Local VM? Its private durable workspace will remain.", { name: bot.name })
          : t("Replace {name}'s Local VM? Its private durable workspace will remain.", { name: bot.name }),
      )
    ) return;
    setPending(action);
    setError(null);
    setVmStatus(null);
    vmReadinessAttempts.current = 0;
    try {
      if (action !== "vm-create") {
        await api(`/api/bots/${bot.id}/local-computer/remove`, {
          method: "POST",
          body: "{}",
        });
      }
      if (action !== "vm-delete") {
        const status: LocalVmStatus = await api(`/api/bots/${bot.id}/local-computer/run`, {
          method: "POST",
          body: "{}",
        });
        setVmStatus(status);
        setPhase(status.ready ? "vm" : "checking");
      } else {
        setVmStatus((current) => current ? { ...current, container: "missing", ready: false } : current);
        setPhase("vm-unavailable");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("vm-unavailable");
    } finally {
      setPending(null);
      setRetry((n) => n + 1);
    }
  };

  const replaceVpsComputer = async () => {
    if (!window.confirm(t("Replace {name}'s VPS computer with the version required by this Ein update? Files stored only inside the disposable container will be deleted.", { name: bot.name }))) return;
    setPending("vps-replace");
    setError(null);
    try {
      await api(`/api/bots/${bot.id}/computer/remove`, { method: "POST", body: "{}" });
      const result: VpsComputerStatus = await api(`/api/bots/${bot.id}/computer/provision`, {
        method: "POST",
        body: "{}",
      });
      setVpsStatus(result);
      setBoxState(result.container ?? null);
      setPhase(result.ready ? "ready" : "error");
      if (!result.ready) setError(result.problem ?? t("The replacement VPS Cua desktop is not ready yet"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    } finally {
      setPending(null);
      setRetry((n) => n + 1);
    }
  };

  const openVmSettings = () => {
    window.sessionStorage.setItem("openmausbot.settings.section", "computer");
    dispatch({ type: "toggleAppSettings", open: true });
  };

  const openConnectionSettings = () => {
    dispatch({ type: "toggleAppSettings", open: true, section: "connections" });
  };

  const emptyState = {
    checking: t("Checking…"),
    starting: t("Starting your bot's computer…"),
    unconfigured: t("No cloud computer configured"),
    "vps-unconfigured": t("No managed VPS computer is configured for this bot"),
    "vps-incompatible": t("This VPS computer belongs to an earlier Ein version"),
    "vps-stopped": t("The managed VPS computer is stopped"),
    "local-unavailable": localDisabledReason ?? t("Local computer control isn't ready."),
    "vm-unavailable": t("The Local VM isn't available for this bot"),
    off: t("This bot's computer is off"),
    error: t("Couldn't reach the computer"),
  } satisfies Record<Exclude<Phase, "ready" | "local" | "vm">, string>;

  // ── U16 chrome: what the header pills, the screen overlay and the step log say ──
  const steps = computerSteps(bot.messages, { busy: Boolean(bot.busy) });
  const replayStep = replay !== null ? steps[replay] : undefined;
  const shownSrc = replayStep?.frame ? `data:${replayStep.frame.mime};base64,${replayStep.frame.png}` : frameSrc;
  const lastActivity = [...bot.messages].reverse().find((message) => message.kind === "activity" && message.tool && !message.comm);
  const actionLabel = bot.busy && lastActivity?.tool?.ok === undefined ? liveActivityLabel(lastActivity) : null;
  const modeLabel =
    phase === "local" || bot.computer === "local"
      ? t("This Mac")
      : phase === "vm" || bot.computer === "vm"
        ? t("Local VM")
        : bot.computer === "off"
          ? t("Computer")
          : cloudBackend === "vps"
            ? t("VPS")
            : t("Cloud computer");
  const sleeping = (phase === "ready" && boxState === "archived") || phase === "vps-stopped";
  const status: { tone: PillTone; label: string } =
    sleeping
      ? { tone: "grey", label: t("{mode} · asleep", { mode: modeLabel }) }
      : phase === "ready" || phase === "vm" || phase === "local"
        ? { tone: "green", label: t("{mode} · online", { mode: modeLabel }) }
        : phase === "starting"
          ? { tone: "blue", label: t("Starting…") }
          : phase === "checking"
            ? { tone: "grey", label: t("Checking…") }
            : phase === "off"
              ? { tone: "grey", label: t("Computer off") }
              : { tone: "red", label: t("Not connected") };
  const canTakeOver = panelView === "computer" && (phase === "ready" || phase === "vm");
  const takeOver = () => {
    if (control.held) {
      void controlAction("release");
      void window.ogb?.desktopViewer?.close(bot.id);
      return;
    }
    void openDesktop();
  };
  const segments = [
    { value: "computer" as const, label: modeLabel },
    { value: "android" as const, label: t("Phone screen"), disabled: !androidConnected },
    ...(browserEnabled ? [{ value: "browser" as const, label: t("Browser") }] : []),
  ];

  return (
    <>
    <aside
      aria-label={t("{name}'s computer", { name: bot.name })}
      className="animate-panel-in relative flex h-full shrink-0 flex-col border-l border-hairline/40 bg-inset"
      style={{ width: panelWidth }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("Resize panel")}
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-select/30"
      />
      {/* Header: whose computer, its state, what you're doing, where to look, 接管 */}
      <div className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 py-2 pl-[18px] pr-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-raised text-ink-secondary shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_45%,transparent)]">
          <Monitor size={16} />
        </span>
        <b className="mr-1 truncate text-[15.5px]">{t("{name}'s computer", { name: bot.name })}</b>
        <Pill tone={status.tone} dot className="h-6">{status.label}</Pill>
        {(canTakeOver || control.held) && (
          control.held
            ? <Pill tone="amber" className="h-6"><Hand size={12} />{t("You're driving")}</Pill>
            : <Pill tone="grey" className="h-6 bg-raised shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_45%,transparent)]"><Eye size={12} />{t("You're watching · read-only")}</Pill>
        )}
        <span className="flex-1" />
        <Segmented
          label={t("Which screen")}
          value={panelView}
          onChange={(view) => {
            setError(null);
            setReplay(null);
            selectPanelView(view);
          }}
          options={segments}
        />
        {canTakeOver && (
          <Button size="sm" onClick={takeOver} disabled={controlPending || pending === "join" || (phase === "vm" && !vmViewerUrl && !control.held)}>
            {controlPending || pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <Hand size={14} />}
            {control.held ? t("Hand back to {name}", { name: bot.name }) : t("Take over")}
          </Button>
        )}
        <button
          type="button"
          onClick={() => dispatch({ type: "toggleSettings", open: true })}
          className="grid size-8 place-items-center rounded-lg text-ink-secondary hover:bg-raised-hover hover:text-ink"
          title={t("Bot settings")}
          aria-label={t("Bot settings")}
        >
          <Settings size={16} />
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: "toggleComputer", open: false })}
          aria-label={t("Close")}
          className="grid size-8 place-items-center rounded-lg text-ink-secondary hover:bg-raised-hover hover:text-ink"
        >
          <X size={17} />
        </button>
      </div>

      {panelView === "browser" && browserEnabled ? (
        <div className="flex min-h-0 flex-1 flex-col px-4 pb-4">
          <BrowserPanel
            bot={bot}
            control={control}
            controlPending={controlPending}
            onControl={controlAction}
            onExpand={onExpandBrowser ? expandBrowser : undefined}
          />
          {error && (
            <div role="alert" className="mt-2 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">
              {error}
            </div>
          )}
        </div>
      ) : panelView === "android" && androidConnected ? (
        <div className="flex-1 overflow-y-auto px-4 pt-2">
          <AndroidDevicePanel status={androidStatus} />
        </div>
      ) : (
      <div className="flex-1 space-y-3.5 overflow-y-auto px-[18px] pb-5">
        {/* The bot asked for your hands */}
        {(phase === "ready" || phase === "vm") && control.helpReason && !control.held && (
          <div className="flex items-center gap-3 rounded-xl bg-warning/10 px-3.5 py-2.5 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-warning)_25%,transparent)]">
            <Hand size={16} className="shrink-0 text-warning" />
            <div className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-ink">
              <b>{bot.name}</b> {t("asked for your hands: {reason}", { reason: control.helpReason })}
            </div>
            <Button size="sm" onClick={() => void openDesktop()} disabled={controlPending || pending === "join"}>
              {pending === "join" ? <Loader2 size={13} className="animate-spin" /> : <Hand size={13} />}
              {t("Take over")}
            </Button>
            <Button size="sm" variant="soft" onClick={() => void controlAction("dismiss-help")} disabled={controlPending}>{t("Dismiss")}</Button>
          </div>
        )}

        {/* The live screen */}
        <div
          className="relative overflow-hidden rounded-2xl shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_40%,transparent)]"
          style={{ background: "radial-gradient(120% 90% at 85% 0%, color-mix(in srgb, var(--color-select) 12%, var(--color-control)) 0, var(--color-control) 55%)" }}
        >
          <div className="flex aspect-[16/10] w-full items-center justify-center px-3 pb-[42px] pt-3">
            {shownSrc && previewOpensDesktop && replay === null ? (
              <button
                type="button"
                onClick={() => void openDesktop()}
                disabled={controlPending || pending === "join"}
                className="group relative flex h-full w-full cursor-pointer items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-select disabled:cursor-wait"
                aria-label={t("Open {name}'s live desktop", { name: bot.name })}
                title={t("Open live desktop")}
              >
                <img
                  src={shownSrc}
                  alt={t("{name}'s screen", { name: bot.name })}
                  onLoad={(event) => setFrameSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
                  className="max-h-full max-w-full rounded-[10px] object-contain shadow-[0_0_0_1px_rgb(16_24_40/0.1),0_18px_40px_-18px_rgb(16_24_40/0.4)] transition group-hover:brightness-90 group-focus-visible:brightness-90"
                />
                <span className="pointer-events-none absolute right-2 top-2 flex items-center gap-1 rounded-md bg-[rgb(20_22_28/0.78)] px-2 py-1 text-[11px] font-medium text-white opacity-0 shadow-sm transition group-hover:opacity-100 group-focus-visible:opacity-100">
                  {pending === "join" ? <Loader2 size={12} className="animate-spin" /> : <Maximize2 size={12} />}
                  {t("Open")}
                </span>
              </button>
            ) : shownSrc ? (
              <img
                src={shownSrc}
                alt={t("{name}'s screen", { name: bot.name })}
                onLoad={(event) => setFrameSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
                className="max-h-full max-w-full rounded-[10px] object-contain shadow-[0_0_0_1px_rgb(16_24_40/0.1),0_18px_40px_-18px_rgb(16_24_40/0.4)]"
                title={phase === "vm" ? t("Watch-only preview") : undefined}
              />
            ) : (
              <div className="flex max-w-[420px] flex-col items-center gap-2 px-6 text-center text-ink-secondary">
                {phase === "checking" || phase === "starting" || phase === "vm" || (phase === "local" && !isLinux) ? (
                  <Loader2 size={18} className="animate-spin" />
                ) : phase === "off" ? (
                  <Power size={22} />
                ) : (
                  <Monitor size={22} />
                )}
                <span className="text-[12.5px]">
                  {phase === "ready"
                    ? t("Waiting for the first frame…")
                    : phase === "vm"
                      ? t("Capturing the Local VM screen…")
                    : phase === "local"
                      ? isLinux
                        ? t("Ready for approved bot actions. Start the separate preview below when you want to watch the screen.")
                        : localMisses >= 3
                        ? t("No frames yet — the preview needs Screen Recording permission. After granting, relaunch the app.")
                        : t("Capturing this computer's screen…")
                      : emptyState[phase]}
                </span>
                {phase === "local" && !isLinux && localMisses >= 3 && (
                  <Button size="sm" variant="ghost" onClick={() => window.ogb?.permOpenSettings?.("screen")}>{t("Open Settings")}</Button>
                )}
                {phase === "vm-unavailable" && (
                  vmStatus?.mode === "per-bot" && vmStatus.image && vmStatus.create_supported ? (
                    <Button size="sm" onClick={() => void runVmAction(vmStatus.container === "missing" ? "vm-create" : "vm-recreate")} disabled={pending !== null}>
                      {(pending === "vm-create" || pending === "vm-recreate") && <Loader2 size={13} className="animate-spin" />}
                      {vmStatus.container === "missing" ? t("Create {name}'s VM", { name: bot.name }) : t("Replace {name}'s VM", { name: bot.name })}
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={openVmSettings}>{t("Open Local VM setup")}</Button>
                  )
                )}
                {(phase === "vps-unconfigured" || phase === "vps-stopped") && (
                  <Button size="sm" variant="ghost" onClick={openConnectionSettings}>{t("Open VPS settings")}</Button>
                )}
                {(phase === "vps-stopped" || (phase === "vps-unconfigured" && vpsStatus?.configured)) &&
                  (bot.computer === "cloud" || bot.autoStartVps) && (
                  <Button size="sm" variant="soft" onClick={() => run("provision")} disabled={pending === "provision"}>
                    {pending === "provision" && <Loader2 size={13} className="animate-spin" />}
                    {phase === "vps-stopped" ? t("Start VPS computer") : t("Prepare VPS computer")}
                  </Button>
                )}
                {phase === "vps-incompatible" && vpsStatus?.managed &&
                  (bot.computer === "cloud" || bot.autoStartVps) && (
                  <Button size="sm" onClick={() => void replaceVpsComputer()} disabled={pending === "vps-replace"}>
                    {pending === "vps-replace" && <Loader2 size={13} className="animate-spin" />}
                    {t("Replace VPS computer")}
                  </Button>
                )}
              </div>
            )}
          </div>
          {/* what the bot is doing right now */}
          {actionLabel && replay === null && shownSrc && (
            <span className="absolute left-4 top-4 inline-flex h-6 max-w-[70%] items-center gap-1.5 rounded-[7px] bg-select px-2.5 text-[12px] font-semibold text-white shadow-[0_6px_14px_-6px_color-mix(in_srgb,var(--color-select)_70%,transparent)]">
              <Loader2 size={12} className="shrink-0 animate-spin" />
              <span className="truncate">{t("{name} · {action}", { name: bot.name, action: actionLabel })}</span>
            </span>
          )}
          {/* the dock: live or replay, frame size, clock */}
          <div className="absolute inset-x-3 bottom-0 flex h-[42px] items-center justify-between">
            {replay !== null && replayStep ? (
              <button type="button" onClick={() => setReplay(null)} className="inline-flex h-[22px] items-center gap-1.5 rounded-[7px] bg-warning px-2 text-[11px] font-semibold text-white">
                <History size={12} />
                {t("Replay {step}/{total} · back to live", { step: replay + 1, total: steps.length })}
              </button>
            ) : shownSrc ? (
              <span className="inline-flex h-[22px] items-center gap-1.5 rounded-[7px] bg-[rgb(20_22_28/0.78)] px-2 text-[11px] font-semibold text-white">
                <i className="size-[7px] rounded-full bg-[#7C93FF] shadow-[0_0_0_3px_rgb(124_147_255/0.35)]" />
                {frameSize ? t("Live · {width}×{height}", { width: frameSize.width, height: frameSize.height }) : t("Live")}
              </span>
            ) : <span />}
            <span className="font-mono text-[11.5px] text-ink-secondary">{replayStep ? clockTime(replayStep.at) : clockTime(Date.now())}</span>
          </div>
        </div>

        {error && (
          <div className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">
            {error}
          </div>
        )}
        {phase === "unconfigured" && (
          <div className="rounded-[14px] bg-raised p-4 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_45%,transparent)]">
            <div className="mb-3 text-[13px] text-ink-secondary">
              {t("Add a Box API key to give this bot a cloud computer — it spins up right here.")}
            </div>
            <ApiKeyRow
              section="box"
              onSaved={(configured) => configured && setRetry((n) => n + 1)}
            />
          </div>
        )}
        {phase === "vps-unconfigured" && (
          <div className="rounded-[14px] bg-raised p-4 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_45%,transparent)]">
            <div className="mb-3 text-[13px] text-ink-secondary">
              {t("Configure the VPS SSH alias in App Settings → Connections. Auto only reuses an existing ready container.")}
            </div>
            <Button variant="soft" onClick={openConnectionSettings}>{t("Open VPS settings")}</Button>
          </div>
        )}

        <StepStrip steps={steps} replay={replay} onReplay={setReplay} />

        {/* the 接管 rule, only where taking over is possible */}
        {(canTakeOver || control.held) && (
          <div className="flex min-h-11 items-center gap-2.5 rounded-xl bg-raised py-2 pl-2 pr-3.5 text-[12.5px] text-ink shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_45%,transparent)]">
            <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-warning/12 text-warning"><Hand size={15} /></span>
            <span className="min-w-0 flex-1">
              {control.held
                ? t("You have the wheel — the bot's clicks and keystrokes are refused until you hand it back.")
                : t("Taking over pauses {name}; hand it back to {name} and it carries on from the current screen.", { name: bot.name })}
            </span>
            {!control.held && <span className="hidden shrink-0 text-[11.5px] text-ink-secondary/80 xl:inline">{t("While read-only, your clicks don't reach the computer")}</span>}
          </div>
        )}

        {/* everything else the panel could always do */}
        <div className="flex flex-wrap gap-2">
          {((phase === "vm" && vmViewerUrl && control.held) || (phase === "ready" && control.held)) && (
            <Button variant="ghost" size="sm" onClick={() => void openDesktop()} disabled={pending === "join"} title={t("Open the Local VM's live desktop inside Ein")}>
              {pending === "join" ? <Loader2 size={13} className="animate-spin" /> : <Monitor size={13} />}
              {t("Open live desktop")}
            </Button>
          )}
          {phase === "ready" && (cloudBackend === "vps" || boxState !== "archived") && (
            <Button variant="ghost" size="sm" onClick={() => run("sleep")} disabled={pending === "sleep"} title={t("Put the computer to sleep")}>
              {pending === "sleep" ? <Loader2 size={13} className="animate-spin" /> : <Moon size={13} />}
              {t("Sleep")}
            </Button>
          )}
          {phase === "vm" && vmStatus?.mode === "per-bot" && window.ogb?.desktopWorkspace && onOpenVmWorkspace && (
            <Button variant="ghost" size="sm" onClick={() => onOpenVmWorkspace(bot.id)} disabled={pending !== null} title={t("Watch two Local VM desktops together without pausing either bot")}>
              <Columns2 size={13} />
              {t("Open two desktops")}
            </Button>
          )}
          {phase === "vm" && vmStatus?.mode === "per-bot" && (
            <Button variant="danger" size="sm" onClick={() => void runVmAction("vm-delete")} disabled={pending !== null || bot.busy} title={bot.busy ? t("Stop this bot's turn before deleting its VM") : t("Delete {name}'s Local VM", { name: bot.name })}>
              {pending === "vm-delete" ? <Loader2 size={13} className="animate-spin" /> : <Power size={13} />}
              {t("Delete this bot's VM")}
            </Button>
          )}
        </div>

        <LocalScreenPreview />
        <LinuxLocalControl />
        <MacLocalControl />

        {/* Computer source */}
        <div className="rounded-[14px] bg-raised p-4 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_45%,transparent)]">
          <div className="text-[14px] font-semibold text-ink">{t("Runs on")}</div>
          <div className="mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary">
            {!bot.computer &&
              (isLinux || !localSelectable
                ? cloudBackend === "vps"
                  ? t("Auto reuses a ready VPS when one is configured; otherwise computer use stays off. ")
                  : `${linuxAutoDescription()} `
                : cloudBackend === "vps"
                  ? t("Auto reuses a ready VPS when one exists, otherwise this computer. ")
                  : t("Auto uses a cloud box when one exists, otherwise this computer. "))}
            {tRich(
              "Pick where this bot's computer lives. <b>Local VM</b> is a Cua-controlled Linux desktop in a container on this machine — free and separate from your own desktop. Set it up in App Settings → Local VM.",
              { b: (chunk) => <b className="text-ink">{chunk}</b> },
            )}
          </div>
          <div className="mt-3 flex gap-0.5 rounded-[10px] bg-control p-0.5">
            {(
              [
                ["cloud", msg("Cloud")],
                ["vm", msg("Local VM")],
                ["local", msg("This computer")],
                ["off", msg("Off")],
              ] as const
            ).map(([mode, label]) => {
              const disabled =
                (mode === "cloud" && !cloudSupported) ||
                (mode === "vm" && !vmSupported) ||
                (mode === "local" && !localSelectable);
              const unavailableTitle =
                mode === "vm" && !vmSupported
                  ? t("This model engine cannot use the Local VM")
                  : mode === "cloud" && !cloudSupported
                    ? t("This model engine cannot use cloud computer tools")
                    : mode === "local" && !localSelectable
                      ? localDisabledReason ?? t("Local computer control isn't ready")
                      : undefined;
              return (
                <button
                  key={mode}
                  type="button"
                  disabled={disabled}
                  title={unavailableTitle}
                  aria-pressed={bot.computer === mode}
                  onClick={() => {
                    if (mode === bot.computer) return;
                    if (mode === "local" && bot.autoApprove) setLocalAutoWarning(true);
                    else dispatch({ type: "updateBot", botId: bot.id, patch: { computer: mode } });
                  }}
                  className={cn(
                    "h-7 flex-1 rounded-lg text-[12.5px] font-medium transition-colors",
                    disabled && "cursor-not-allowed opacity-40",
                    bot.computer === mode
                      ? "bg-raised font-semibold text-ink shadow-[0_1px_2px_rgb(16_24_40/0.12)]"
                      : "text-ink-secondary hover:text-ink",
                  )}
                >
                  {t(label)}
                </button>
              );
            })}
          </div>
          {(!bot.computer || bot.computer === "cloud") && (
            <>
              <CloudBackendPicker
                value={cloudBackend}
                vpsSupported={vpsSupported}
                onChange={(backend) => dispatch({ type: "updateBot", botId: bot.id, patch: { cloudBackend: backend } })}
              />
              {!bot.computer && cloudBackend === "vps" && (
                <div className="mt-3 flex items-center justify-between gap-4 rounded-lg bg-inset px-3 py-2.5">
                  <div className="min-w-0">
                    <div className="text-[13px] text-ink">{t("Start VPS automatically")}</div>
                    <div className="mt-0.5 text-[11.5px] text-ink-secondary">
                      {t("Off by default. When enabled, Auto may create or wake this bot's managed container.")}
                    </div>
                  </div>
                  <Switch
                    checked={Boolean(bot.autoStartVps)}
                    aria-label={t("Start VPS automatically")}
                    onClick={() => dispatch({
                      type: "updateBot",
                      botId: bot.id,
                      patch: { autoStartVps: !bot.autoStartVps },
                    })}
                  />
                </div>
              )}
            </>
          )}
        </div>

        {/* Routines */}
        <div className="rounded-[14px] bg-raised p-4 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_45%,transparent)]">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-[14px] font-semibold text-ink">
              <CalendarClock size={16} className="text-accent-text" />
              {t("Scheduled tasks")}
            </div>
            {botRoutines.length > 0 && (
              <span className="rounded-full bg-control px-2 py-0.5 text-[10.5px] font-semibold text-ink-secondary">
                {botRoutines.length}
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[12.5px] text-ink-secondary">
            {t("Schedule work for {name}. Use its current setup, or run the whole job inside its cloud VM.", { name: bot.name })}
          </div>
          {!computerDestination && (
            <div className="mt-3 flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-[11.5px] leading-relaxed text-warning">
              <Power size={13} className="mt-0.5 shrink-0" />
              {t("Scheduled tasks on this computer will not have desktop access while this is Off. Choose Cloud VM in the schedule editor to run the whole job there.")}
            </div>
          )}
          {activeRoutineRun && (
            <button
              type="button"
              onClick={() => dispatch({ type: "showRoutines" })}
              className="mt-3 flex w-full items-center gap-2 rounded-lg bg-select/10 px-3 py-2 text-left text-[12px] text-accent-text hover:bg-select/15"
            >
              <Loader2 size={13} className={activeRoutineRun.status === "queued" ? "" : "animate-spin"} />
              <span className="min-w-0 flex-1 truncate">
                {activeRoutineRun.routineName} · {activeRoutineRun.status === "waiting"
                  ? t("needs you")
                  : activeRoutineRun.status === "queued"
                    ? t("queued")
                    : activeRoutineRun.status === "running"
                      ? t("running")
                      : activeRoutineRun.status}
              </span>
            </button>
          )}
          {botRoutines.length > 0 && (
            <div className="mt-3 space-y-1.5">
              {botRoutines.slice(0, 3).map((routine) => (
                <button
                  key={routine.id}
                  type="button"
                  onClick={() => dispatch({ type: "showRoutines" })}
                  className="flex w-full items-center gap-2 rounded-lg bg-inset px-3 py-2 text-left hover:bg-raised-hover"
                >
                  <span className={cn("size-1.5 shrink-0 rounded-full", routine.enabled ? "bg-success" : "bg-ink-secondary/40")} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium text-ink">{routine.name}</span>
                    <span className="block truncate text-[11px] text-ink-secondary">
                      {routineScheduleLabel(routine)}{routine.runOn === "cloud" ? t(" · runs on VM") : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-[11px] text-ink-secondary">{nextRunLabel(routine.nextRunAt)}</span>
                </button>
              ))}
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <Button size="sm" className="flex-1" onClick={() => setCreatingRoutine(true)}>
              <Plus size={14} />
              {t("Create schedule")}
            </Button>
            <Button size="sm" variant="soft" onClick={() => dispatch({ type: "showRoutines" })} title={t("Open schedules")}>
              <CalendarDays size={14} />
              {t("Schedules")}
            </Button>
          </div>
        </div>
      </div>
      )}
      {creatingRoutine && (
        <RoutineEditor
          bots={[bot]}
          lockedBotId={bot.id}
          defaultRunOn={cloudRoutineReady ? "cloud" : "maus"}
          onClose={() => setCreatingRoutine(false)}
        />
      )}
    </aside>
    <LocalComputerAutoWarning
      open={localAutoWarning}
      onCancel={() => setLocalAutoWarning(false)}
      onConfirm={() => {
        dispatch({ type: "updateBot", botId: bot.id, patch: { computer: "local", acknowledgeLocalAuto: true } });
        setLocalAutoWarning(false);
      }}
    />
    </>
  );
}
