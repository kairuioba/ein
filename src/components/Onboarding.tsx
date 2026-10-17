// First run (U19): 登录 → 连接引擎 → 创建第一个 Bot → 设为主 Bot.
// Who you are (name, optional email), which engines this computer can run
// (live checks from the harness), the first bot — your 主 Bot, created with
// POST /api/bots and made the chief of staff — then the optional microphone
// and phone setup that can always be resumed from Settings.
// Every step is skippable: onboarding must never brick the app. Picking a
// connected engine is the one decision that matters, so clicking one moves
// straight on, and the step buttons stay pinned to the bottom of the window
// however many engines the grid shows. Once the main bot exists the next
// click is the app itself; the microphone and phone are an optional detour.
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowRight, Check, Eye, Loader2, Mic, RefreshCw, Sparkles, X } from "lucide-react";
import { identifyEmail, setEmailGateDone, track } from "@/lib/analytics";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { EngineSetup } from "./EngineSetup";
import { PhoneSetupFlow } from "./PhoneSetupFlow";
import { Mascot, BotTile } from "./mascot/Mascot";
import { Button, Dialog } from "./ui";
import { api, useStore, type Bot, type InstanceInfo } from "@/state/store";
import { saveOrg } from "@/state/org-api";
import { cn } from "@/lib/cn";
import { PRODUCT_TAGLINE } from "@/lib/brand";
import { msg, t, tn } from "@/lib/i18n";
import type { MascotPose } from "@/lib/engine-mascots";
import { RECOMMENDED_DRIVER, engineState, engineUsable, mascotForInstance, onboardingEngines, onboardingEnginesWith, type EngineState } from "./settings/engine-model";
import { MarkTile } from "./settings/parts";

type Step = "profile" | "engines" | "bot" | "chief" | "permissions" | "phone";

const STAGES: ReadonlyArray<{ label: string; steps: readonly Step[] }> = [
  { label: msg("Sign in"), steps: ["profile"] },
  { label: msg("Connect engines"), steps: ["engines"] },
  { label: msg("Create the first bot"), steps: ["bot"] },
  { label: msg("Make it the main bot"), steps: ["chief", "permissions", "phone"] },
];

const NAME_MAX = 12;
const TAG_MAX = 8;
const DESCRIPTION_MAX = 200;

const BACKDROP: CSSProperties = {
  background:
    "radial-gradient(900px 420px at 50% -8%, color-mix(in oklab, var(--color-select) 11%, transparent) 0%, transparent 70%), radial-gradient(circle, color-mix(in oklab, var(--color-ink) 10%, transparent) 1px, transparent 1.2px) 0 0 / 22px 22px, var(--color-app)",
};

const cardCls =
  "rounded-2xl bg-raised shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent),0_1px_2px_rgb(16_24_40/0.05),0_12px_28px_-16px_rgb(16_24_40/0.22)]";

const fieldCls =
  "flex h-[38px] items-center gap-2 rounded-[10px] bg-raised px-3 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-ink-secondary)_26%,transparent)] focus-within:shadow-[inset_0_0_0_1.5px_var(--color-select),0_0_0_3px_color-mix(in_oklab,var(--color-select)_16%,transparent)]";

function Stepper({ step }: { step: Step }) {
  const current = STAGES.findIndex((stage) => stage.steps.includes(step));
  return (
    <nav aria-label={t("Setup steps")} className="flex h-10 items-center gap-2.5 rounded-full bg-raised pr-4 pl-2.5 whitespace-nowrap shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent),0_1px_2px_rgb(16_24_40/0.05)]">
      {STAGES.map((stage, index) => {
        const done = index < current;
        const on = index === current;
        return (
          <span key={stage.label} className="flex items-center gap-2.5">
            <span
              aria-current={on ? "step" : undefined}
              className={cn("inline-flex items-center gap-[7px] text-[13px]", done ? "font-medium text-ink-secondary" : on ? "font-bold text-ink" : "font-medium text-ink-secondary/60")}
            >
              <i
                className={cn(
                  "grid size-[22px] place-items-center rounded-full text-[12px] font-bold not-italic",
                  done
                    ? "bg-select text-white"
                    : on
                      ? "text-accent-text shadow-[inset_0_0_0_2px_var(--color-select)]"
                      : "text-ink-secondary/60 shadow-[inset_0_0_0_1.5px_color-mix(in_oklab,var(--color-ink-secondary)_40%,transparent)]",
                )}
              >
                {done ? <Check size={12} strokeWidth={3} /> : index + 1}
              </i>
              {t(stage.label)}
            </span>
            {index < STAGES.length - 1 && <span className={cn("h-0.5 w-[34px] rounded-full", done ? "bg-select" : "bg-ink-secondary/25")} />}
          </span>
        );
      })}
    </nav>
  );
}

function Heading({ title, tagline, sub }: { title: string; tagline?: string; sub: ReactNode }) {
  return (
    <div className="text-center">
      <h1 className="text-[24px] leading-[1.3] font-bold tracking-[-0.2px] text-ink">{title}</h1>
      {tagline && <p className="mt-1 text-[13px] tracking-[0.05em] text-ink-secondary/80">{tagline}</p>}
      <p className="mt-1.5 text-[14px] text-ink-secondary">{sub}</p>
    </div>
  );
}

/** A step's actions, pinned to the bottom of the window: with a long engine
 * list or a short window the way forward is still in view without scrolling. */
function StepFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn("sticky bottom-0 z-10 -mx-3 mt-6 flex items-center gap-2.5 px-3 pt-4 pb-3", className)}
      style={{ background: "linear-gradient(180deg, transparent 0%, var(--color-app) 38%)" }}
    >
      {children}
    </div>
  );
}

function Counter({ value, max }: { value: string; max: number }) {
  return <span className="font-mono text-[11.5px] whitespace-nowrap text-ink-secondary/70">{`${[...value].length} / ${max}`}</span>;
}

const STATE_DOT: Record<EngineState, string> = { ready: "bg-success", installed: "bg-success", found: "bg-success", signin: "", key: "", missing: "" };

function engineTileStatus(instance: InstanceInfo, state: EngineState): { text: string; action?: string } {
  if (state === "ready") return { text: t("Connected") };
  if (state === "installed") return { text: t("Installed on this computer") };
  if (state === "found") {
    const count = instance.models.options.filter((option) => option.custom).length;
    return { text: tn(count, "Local · {count} model", "Local · {count} models") };
  }
  if (state === "signin") return { text: t("Not connected"), action: t("Connect") };
  if (state === "key") return { text: t("API key required"), action: t("Add key") };
  return { text: t("Not installed"), action: t("Install") };
}

/** One engine in a grid: a stage with its full-body mascot, its name and status. */
function EngineTile({
  instance,
  selected,
  recommended,
  onSelect,
  onSetup,
}: {
  instance: InstanceInfo;
  selected: boolean;
  recommended: boolean;
  onSelect: () => void;
  onSetup: () => void;
}) {
  const state = engineState(instance);
  const usable = engineUsable(instance);
  const status = engineTileStatus(instance, state);
  return (
    <div
      role="radio"
      aria-checked={selected}
      tabIndex={0}
      onClick={() => (usable ? onSelect() : onSetup())}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        if (usable) onSelect();
        else onSetup();
      }}
      className={cn(
        "relative flex cursor-pointer flex-col items-center gap-0.5 rounded-xl px-1.5 pt-1.5 pb-[9px] outline-none",
        selected
          ? "bg-select/[0.07] shadow-[inset_0_0_0_2px_var(--color-select),0_0_0_4px_color-mix(in_oklab,var(--color-select)_16%,transparent)]"
          : "bg-raised shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent)] hover:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_95%,transparent)] focus-visible:shadow-[inset_0_0_0_2px_var(--color-select)]",
      )}
    >
      {recommended && (
        <span className="absolute top-[11px] left-[11px] z-[1] inline-flex h-[19px] items-center gap-[3px] rounded-md bg-select px-1.5 text-[11px] font-bold text-white">
          <Sparkles size={10} />
          {t("Recommended")}
        </span>
      )}
      {selected && (
        <span className="absolute top-[11px] right-[11px] z-[1] grid size-[19px] place-items-center rounded-full bg-select text-white">
          <Check size={11} strokeWidth={3} />
        </span>
      )}
      <span className={cn("mb-[5px] grid h-[84px] w-full place-items-end justify-center overflow-hidden rounded-lg", selected ? "bg-raised" : "bg-inset")}>
        <Mascot kind={mascotForInstance(instance)} scale={1} className="mb-0.5" />
      </span>
      <b className="max-w-full truncate text-[13px] leading-[1.3] font-semibold text-ink">{instance.displayName}</b>
      <span className={cn("inline-flex max-w-full items-center gap-1 text-[11.5px] whitespace-nowrap", usable ? "text-ink-secondary" : "text-ink-secondary/70")}>
        {usable && <i className={cn("size-1.5 shrink-0 rounded-full", STATE_DOT[state])} />}
        <span className="truncate">{status.text}</span>
        {status.action && (
          <>
            <span>·</span>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onSetup();
              }}
              className="font-semibold text-accent-text hover:underline"
            >
              {status.action}
            </button>
          </>
        )}
      </span>
    </div>
  );
}

/** A pixel name plate with the official icon slot: ">_ name". */
function PreviewNameTag({ name, driverKind }: { name: string; driverKind?: string }) {
  const corners = (n: number) =>
    `polygon(0 ${n}px, ${n}px ${n}px, ${n}px 0, calc(100% - ${n}px) 0, calc(100% - ${n}px) ${n}px, 100% ${n}px, 100% calc(100% - ${n}px), calc(100% - ${n}px) calc(100% - ${n}px), calc(100% - ${n}px) 100%, ${n}px 100%, ${n}px calc(100% - ${n}px), 0 calc(100% - ${n}px))`;
  return (
    <div className="flex flex-col items-center">
      <span className="block bg-[#AEB4C0] p-0.5" style={{ clipPath: corners(4) }}>
        <span className="flex h-9 items-center gap-2 bg-[#16181E] pr-3.5 pl-[9px] text-[#F4F5F7]" style={{ clipPath: corners(2) }}>
          <MarkTile driverKind={driverKind} size={20} markSize={14} />
          <span className="max-w-[220px] truncate text-[16px] leading-none" style={{ fontFamily: "Unifont, ui-monospace, SFMono-Regular, Menlo, monospace" }}>
            <span className="text-[#9AA3AF]">&gt;_ </span>
            {name}
          </span>
        </span>
      </span>
      <span
        aria-hidden
        className="-mt-0.5 h-2 w-3.5 bg-[#16181E]"
        style={{ clipPath: "polygon(0 0,100% 0,100% 3px,calc(100% - 3px) 3px,calc(100% - 3px) 6px,calc(100% - 5px) 6px,calc(100% - 5px) 8px,5px 8px,5px 6px,3px 6px,3px 3px,0 3px)" }}
      />
    </div>
  );
}

function BotPreview({ name, tag, instance, pose = "wave" }: { name: string; tag: string; instance?: InstanceInfo; pose?: MascotPose }) {
  const kind = instance ? mascotForInstance(instance) : "workbuddy";
  const shownName = name.trim() || t("Chief");
  return (
    <section
      aria-label={t("Preview")}
      className={cn(cardCls, "relative min-h-[556px] overflow-hidden")}
      style={{
        background:
          "linear-gradient(180deg, var(--color-raised) 0%, color-mix(in oklab, var(--color-select) 4%, var(--color-raised)) 52%, color-mix(in oklab, var(--color-select) 9%, var(--color-raised)) 100%)",
      }}
    >
      <div className="absolute top-4 right-5 left-5 flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-secondary">
        <Eye size={14} />
        {t("Preview")}
        <span className="ml-auto text-[12px] font-medium text-ink-secondary/70">{t("The look follows the engine")}</span>
      </div>
      <div
        aria-hidden
        className="absolute top-10 left-1/2 h-[326px] w-[372px] -translate-x-1/2 blur-[5px]"
        style={{
          clipPath: "polygon(41% 0,59% 0,100% 100%,0 100%)",
          WebkitMaskImage: "linear-gradient(180deg, transparent 0%, #000 26%, #000 74%, transparent 100%)",
          maskImage: "linear-gradient(180deg, transparent 0%, #000 26%, #000 74%, transparent 100%)",
          background: "linear-gradient(180deg, transparent 0%, color-mix(in oklab, var(--color-raised) 95%, transparent) 100%)",
        }}
      />
      <div
        aria-hidden
        className="absolute top-[326px] left-1/2 h-[76px] w-[360px] -translate-x-1/2 rounded-[50%]"
        style={{
          background:
            "radial-gradient(closest-side, var(--color-raised) 0%, var(--color-raised) 30%, color-mix(in oklab, var(--color-select) 18%, var(--color-raised)) 52%, color-mix(in oklab, var(--color-select) 16%, transparent) 74%, transparent 100%)",
        }}
      />
      <div aria-hidden className="absolute top-[352px] left-1/2 h-5 w-[190px] -translate-x-1/2 rounded-[50%] bg-[radial-gradient(closest-side,rgb(16_24_40/0.26),rgb(16_24_40/0))]" />
      {[
        [96, 150, "var(--color-select)", 0.55],
        [366, 128, "#FBBF24", 0.8],
        [382, 230, "var(--color-select)", 0.35],
        [84, 262, "#FBBF24", 0.5],
        [120, 96, "var(--color-select)", 0.25],
      ].map(([x, y, color, opacity], index) => (
        <i key={index} aria-hidden className="absolute size-[7px]" style={{ left: x as number, top: y as number, background: color as string, opacity: opacity as number }} />
      ))}
      <div className="absolute top-11 left-1/2 -translate-x-1/2">
        <PreviewNameTag name={shownName} driverKind={instance?.driverKind} />
      </div>
      <Mascot kind={kind} pose={pose} scale={4} className="absolute top-[84px] left-1/2 -translate-x-1/2" title={t("{name}'s look", { name: shownName })} />
      <p className="absolute top-[412px] right-0 left-0 m-0 text-center text-[15px] text-ink-secondary">
        {t("It will:")} <b className="font-bold text-ink">{t("split up tasks")}</b>
        {t(", ")}
        <b className="font-bold text-ink">{t("hand them to specialists")}</b>
        {t(", ")}
        <b className="font-bold text-ink">{t("sum up for you")}</b>
      </p>
      <div className="absolute top-[454px] right-6 left-6 rounded-xl bg-inset/85 px-3 pt-2.5 pb-2 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent)]">
        <span className="mb-1 block text-[11.5px] font-semibold text-ink-secondary/70">{t("This is how it looks in the sidebar")}</span>
        <div className="flex h-[46px] items-center gap-2 rounded-[10px] bg-raised pr-2 pl-1 shadow-[0_1px_2px_rgb(16_24_40/0.05),0_0_0_1px_rgb(16_24_40/0.04)]">
          <BotTile kind={kind} size={24} chief />
          <span className="flex min-w-0 flex-1 flex-col gap-px">
            <span className="flex items-center gap-1.5 text-[13px] leading-[1.35] font-semibold whitespace-nowrap text-ink">
              <span className="truncate">{shownName}</span>
              {tag.trim() && <span className="inline-flex h-[18px] shrink-0 items-center rounded-full bg-control/70 px-1.5 text-[11px] font-medium text-ink-secondary">{tag.trim()}</span>}
            </span>
            <span className="truncate text-[11.5px] text-ink-secondary">{t("Just created · waiting for your first request")}</span>
          </span>
          <span className="text-[11.5px] text-ink-secondary/70">{t("Right now")}</span>
        </div>
      </div>
    </section>
  );
}

function EngineSetupDialog({ instance, onClose }: { instance: InstanceInfo; onClose: () => void }) {
  const { refreshInstances } = useStore();
  return (
    <Dialog open onClose={onClose} label={t("Set up {name}", { name: instance.displayName })} width={520}>
      <div className="flex items-center gap-3 px-5 pt-4 pb-3">
        <BotTile kind={mascotForInstance(instance)} size={36} />
        <b className="min-w-0 flex-1 truncate text-[16px] font-bold text-ink">{t("Set up {name}", { name: instance.displayName })}</b>
        <button type="button" onClick={onClose} aria-label={t("Close")} className="grid size-8 place-items-center rounded-lg text-ink-secondary hover:bg-control hover:text-ink">
          <X size={16} />
        </button>
      </div>
      <div className="px-5 pb-4">
        <EngineSetup instance={instance} intent={instance.access === "custom" ? "inject" : "cloud"} />
      </div>
      <div className="flex justify-end gap-2 border-t border-hairline/30 px-5 py-3">
        <Button variant="ghost" onClick={() => void refreshInstances()}>
          <RefreshCw size={14} />
          {t("Check again")}
        </Button>
        <Button onClick={onClose}>{t("Done")}</Button>
      </div>
    </Dialog>
  );
}

export function Onboarding({ onDone }: { onDone: () => void }) {
  const { capabilities } = useDesktopCapabilities();
  const { state, dispatch, refreshInstances } = useStore();
  const [step, setStep] = useState<Step>("profile");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [perms, setPerms] = useState<{ mic: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [setupFor, setSetupFor] = useState<string | null>(null);
  // the first bot
  const [botName, setBotName] = useState(() => t("Chief"));
  const [botTag, setBotTag] = useState(() => t("My chief of staff"));
  const [botDescription, setBotDescription] = useState(() => t("Keep an eye on all my projects: split what I ask into tasks, hand them to the right specialists, and sum it up on one screen. Ask me first about spending money and anything published outside."));
  const [engineId, setEngineId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [created, setCreated] = useState<Bot | null>(null);

  const instances = state.instances;
  const grid = useMemo(() => onboardingEngines(instances), [instances]);
  const usableCount = instances.filter((instance) => instance.driverKind !== "boxAgent" && engineUsable(instance)).length;
  const recommended = instances.find((instance) => instance.driverKind === RECOMMENDED_DRIVER);
  const chosen = instances.find((instance) => instance.instanceId === engineId);
  // what the first-bot step shows: the curated eight, always with the choice
  const botGrid = useMemo(() => onboardingEnginesWith(instances, engineId), [instances, engineId]);

  // The email is optional in this edition: nothing is mailed, and analytics
  // (the only thing that would ever read it) start switched off.
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
  const valid = (name.trim() !== "" || email.trim() !== "") && (email.trim() === "" || emailValid);
  const stageIndex = STAGES.findIndex((stage) => stage.steps.includes(step));

  useEffect(() => {
    track("onboarding_step", { step: stageIndex, name: step });
  }, [step, stageIndex]);

  // Engines: re-check when the step opens and whenever the window comes back
  // (installing or signing in happens in Terminal, outside this window).
  useEffect(() => {
    if (step !== "engines" && step !== "bot") return;
    void refreshInstances();
    const onFocus = () => void refreshInstances();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [step, refreshInstances]);

  // Pick the recommended engine (or the first one that runs) for the first bot.
  useEffect(() => {
    if (engineId && instances.some((instance) => instance.instanceId === engineId && engineUsable(instance))) return;
    const first = (recommended && engineUsable(recommended) ? recommended : grid.find(engineUsable)) ?? null;
    setEngineId(first?.instanceId ?? null);
  }, [engineId, instances, grid, recommended]);

  useEffect(() => {
    if (step === "permissions" && capabilities.dictation.available) {
      const poll = () => window.ogb?.permStatus?.().then(setPerms).catch(() => {});
      poll();
      // keep polling — the user may grant in System Settings and come back
      const timer = setInterval(poll, 2000);
      return () => clearInterval(timer);
    }
  }, [step, capabilities.dictation.available]);

  const saveProfile = () => {
    if (emailValid) identifyEmail(email.trim().toLowerCase());
    // persisted server-side (~/.ein/config.json) — the sidebar
    // footer reads it back through /api/config
    void fetch("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: { name: name.trim(), email: email.trim().toLowerCase() } }),
    }).catch(() => {});
    setStep("engines");
  };

  const afterChief = () => setStep(capabilities.dictation.available ? "permissions" : "phone");

  // The engines step's one decision: a connected engine becomes the main
  // bot's engine and the next step opens with it already chosen.
  const pickEngine = (instance: InstanceInfo) => {
    setEngineId(instance.instanceId);
    track("onboarding_engine_picked", { engine: instance.driverKind });
    setStep("bot");
  };
  const chosenUsable = chosen ? engineUsable(chosen) : false;

  const finish = () => {
    track("onboarding_completed", {
      engines_available: instances.filter((i) => i.snapshot.state === "available").length,
      mic: perms?.mic ?? "n/a",
      bot_created: Boolean(created),
    });
    setEmailGateDone("submitted");
    onDone();
  };

  const createBot = async () => {
    if (creating) return;
    const nameValue = botName.trim();
    if (!nameValue) return setCreateError(t("Give your bot a name."));
    setCreating(true);
    setCreateError(null);
    try {
      const instance = chosen;
      const model = instance ? instance.models.default || instance.models.options[0]?.id || "default" : undefined;
      const { bot } = (await api("/api/bots", {
        method: "POST",
        body: JSON.stringify({
          name: nameValue,
          title: botTag.trim(),
          description: botDescription.trim(),
          ...(instance && model ? { modelSelection: { instanceId: instance.instanceId, model } } : {}),
        }),
      })) as { bot: Bot };
      // the 主 Bot: the unsectioned chief of staff, pinned to the top
      const { bot: patched } = (await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ chiefOfStaff: true, pinned: true }),
      })) as { bot: Bot };
      const full = { ...bot, ...patched, messages: bot.messages ?? [] };
      dispatch({ type: "botAdded", bot: full });
      // best effort: name it the main bot in the org config as well
      void saveOrg({ chiefBotId: bot.id }).catch(() => {});
      // the starter bot the app made on first launch steps aside (archived,
      // so it can come back) — but only if nobody has talked to it yet
      const others = state.bots.filter((other) => other.id !== bot.id && !other.hidden);
      const starter = others.length === 1 ? others[0]! : undefined;
      if (
        starter &&
        !starter.section?.trim() &&
        !starter.chiefOfStaff &&
        !starter.pinned &&
        (starter.tasks?.length ?? 0) <= 1 &&
        starter.messages.length > 0 &&
        starter.messages.every((message) => message.role !== "user")
      ) {
        dispatch({ type: "updateBot", botId: starter.id, patch: { hidden: true } });
      }
      track("onboarding_bot_created", { engine: instance?.driverKind ?? "default" });
      setCreated(full);
      setStep("chief");
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  };

  const recheck = async () => {
    setChecking(true);
    try {
      await refreshInstances();
    } finally {
      setChecking(false);
    }
  };

  const setupInstance = instances.find((instance) => instance.instanceId === setupFor);
  const engineList = instances.filter((instance) => instance.install && instance.driverKind !== "boxAgent");
  const checkingEngines = !state.connected || instances.length === 0;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto" style={BACKDROP}>
      <div className="mx-auto flex min-h-full w-full max-w-[1180px] flex-col items-center px-8 pt-3.5 pb-8">
        <Stepper step={step} />

        {step === "profile" && (
          <div className="mt-14 flex w-full max-w-[440px] flex-col items-center">
            <Mascot kind="workbuddy" pose="wave" scale={1.5} shadow />
            <div className="mt-3">
              <Heading title={t("Welcome to Ein")} tagline={PRODUCT_TAGLINE} sub={t("Bots that do real work on their own computer. Your name and email appear in the sidebar and stay on this computer.")} />
            </div>
            <div className={cn(cardCls, "mt-6 flex w-full flex-col gap-3 p-6")}>
              <label className={fieldCls}>
                <input
                  autoFocus
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t("Your name")}
                  aria-label={t("Your name")}
                  className="min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-secondary/70 focus:outline-none"
                />
              </label>
              <label className={fieldCls}>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && valid && saveProfile()}
                  placeholder={t("Email (optional)")}
                  aria-label={t("Email (optional)")}
                  className="min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-secondary/70 focus:outline-none"
                />
              </label>
              <Button size="lg" onClick={saveProfile} disabled={!valid} className="mt-1 w-full">
                {t("Continue")}
                <ArrowRight size={15} />
              </Button>
              <button
                onClick={() => {
                  track("email_skipped");
                  setStep("engines");
                }}
                className="text-[12.5px] text-ink-secondary hover:text-ink"
              >
                {t("Maybe later")}
              </button>
            </div>
          </div>
        )}

        {step === "engines" && (
          <div className="mt-[42px] flex w-full max-w-[900px] flex-col">
            <Heading title={t("Connect engines")} sub={t("Pick a connected engine for your main bot. One is enough to start; connect the others any time later.")} />
            <section className={cn(cardCls, "mt-8 p-6")}>
              <div className="mb-3 flex items-center gap-2 text-[12.5px] font-semibold text-ink-secondary">
                {checkingEngines ? (
                  <>
                    <Loader2 size={14} className="animate-spin" /> {t("Checking…")}
                  </>
                ) : (
                  <span>{t("{ready} of {total} ready", { ready: usableCount, total: engineList.length })}</span>
                )}
                <span className="flex-1" />
                <button type="button" onClick={() => void recheck()} disabled={checking} className="inline-flex items-center gap-1.5 font-semibold text-ink-secondary hover:text-ink disabled:opacity-60">
                  {checking ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                  {t("Check again")}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                {engineList.map((instance) => (
                  <EngineTile
                    key={instance.instanceId}
                    instance={instance}
                    selected={instance.instanceId === engineId}
                    recommended={instance.driverKind === RECOMMENDED_DRIVER}
                    onSelect={() => pickEngine(instance)}
                    onSetup={() => setSetupFor(instance.instanceId)}
                  />
                ))}
              </div>
            </section>
            <StepFooter className="justify-end">
              <Button variant="ghost" size="lg" onClick={() => setStep("profile")}>
                {t("Previous step")}
              </Button>
              <Button size="lg" onClick={() => (chosen && chosenUsable ? pickEngine(chosen) : setStep("bot"))}>
                {chosen && chosenUsable ? t("Continue with {name}", { name: chosen.displayName }) : t("Skip for now")}
                <ArrowRight size={15} />
              </Button>
            </StepFooter>
          </div>
        )}

        {step === "bot" && (
          <div className="mt-[42px] flex w-full flex-col">
            <Heading title={t("Create the first bot")} sub={t("Start with a chief. From then on you only talk to it, and it finds the right bots for the work.")} />
            <div className="mt-[34px] grid grid-cols-1 gap-6 lg:grid-cols-[620fr_476fr]">
              <section aria-label={t("Your first bot")} className={cn(cardCls, "flex flex-col gap-[18px] px-7 py-6")}>
                <div className="flex gap-3.5">
                  <label className="flex flex-1 flex-col gap-[7px]">
                    <span className="text-[12.5px] font-semibold text-ink-secondary">{t("Its name")}</span>
                    <span className={fieldCls}>
                      <input
                        value={botName}
                        maxLength={NAME_MAX}
                        onChange={(e) => setBotName(e.target.value)}
                        aria-label={t("Name")}
                        className="min-w-0 flex-1 bg-transparent text-[14px] font-medium text-ink focus:outline-none"
                      />
                      <Counter value={botName} max={NAME_MAX} />
                    </span>
                  </label>
                  <label className="flex flex-1 flex-col gap-[7px]">
                    <span className="flex items-baseline gap-2 text-[12.5px] font-semibold text-ink-secondary">
                      {t("Tag")}
                      <em className="text-[12px] font-normal not-italic text-ink-secondary/70">{t("Shown next to the name")}</em>
                    </span>
                    <span className={fieldCls}>
                      <input
                        value={botTag}
                        maxLength={TAG_MAX}
                        onChange={(e) => setBotTag(e.target.value)}
                        aria-label={t("Tag")}
                        className="min-w-0 flex-1 bg-transparent text-[14px] font-medium text-ink focus:outline-none"
                      />
                      <Counter value={botTag} max={TAG_MAX} />
                    </span>
                  </label>
                </div>
                <label className="flex flex-col gap-[7px]">
                  <span className="flex items-baseline gap-2 text-[12.5px] font-semibold text-ink-secondary">
                    {t("Description")}
                    <em className="text-[12px] font-normal not-italic text-ink-secondary/70">{t("It reads this to understand its job")}</em>
                    <span className="ml-auto">
                      <Counter value={botDescription} max={DESCRIPTION_MAX} />
                    </span>
                  </span>
                  <textarea
                    value={botDescription}
                    maxLength={DESCRIPTION_MAX}
                    onChange={(e) => setBotDescription(e.target.value)}
                    rows={2}
                    aria-label={t("Description")}
                    className="resize-none rounded-[10px] bg-raised px-3 py-[9px] text-[13.5px] leading-[1.65] text-ink shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-ink-secondary)_26%,transparent)] focus:shadow-[inset_0_0_0_1.5px_var(--color-select),0_0_0_3px_color-mix(in_oklab,var(--color-select)_16%,transparent)] focus:outline-none"
                  />
                </label>
                <div className="flex flex-col gap-[7px]">
                  <span className="flex items-baseline gap-2 text-[12.5px] font-semibold text-ink-secondary">
                    {t("Which engine")}
                    <em className="text-[12px] font-normal not-italic text-ink-secondary/70">
                      {t("{count} connected; you can switch any time in settings", { count: usableCount })}
                    </em>
                  </span>
                  <div role="radiogroup" aria-label={t("Which engine")} className="grid grid-cols-4 gap-2.5">
                    {botGrid.map((instance) => (
                      <EngineTile
                        key={instance.instanceId}
                        instance={instance}
                        selected={instance.instanceId === engineId}
                        recommended={instance.driverKind === RECOMMENDED_DRIVER}
                        onSelect={() => setEngineId(instance.instanceId)}
                        onSetup={() => setSetupFor(instance.instanceId)}
                      />
                    ))}
                    {botGrid.length === 0 && <div className="col-span-4 py-6 text-center text-[13px] text-ink-secondary">{t("Checking which engines this computer has…")}</div>}
                  </div>
                </div>
              </section>
              <BotPreview name={botName} tag={botTag} instance={chosen} />
            </div>
            <StepFooter className="flex-wrap">
              <div className={cn(cardCls, "flex h-[52px] items-center gap-2.5 rounded-xl pr-3.5 pl-2.5")}>
                <span className="grid size-8 place-items-center rounded-[9px] bg-[#FFF6DD]">
                  <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden>
                    <path d="M8 1.2l2.1 4.3 4.7.7-3.4 3.3.8 4.7L8 12l-4.2 2.2.8-4.7L1.2 6.2l4.7-.7z" fill="#E5A00D" />
                  </svg>
                </span>
                <span className="flex flex-col leading-[1.35]">
                  <b className="text-[13px] text-ink">{t("Main bot")}</b>
                  <span className="text-[12.5px] whitespace-nowrap text-ink-secondary">{t("The main bot looks for things it can do for you, and asks you first when it matters")}</span>
                </span>
                <span className="ml-3 text-[12px] font-semibold whitespace-nowrap text-accent-text">{t("Set in the next step")}</span>
              </div>
              <span className="flex-1" />
              {createError && <span role="alert" className="max-w-[320px] text-[12.5px] text-danger">{createError}</span>}
              <button type="button" onClick={finish} className="px-2 text-[12.5px] text-ink-secondary hover:text-ink">
                {t("Skip for now")}
              </button>
              <Button variant="ghost" size="lg" className="h-11" onClick={() => setStep("engines")}>
                {t("Previous step")}
              </Button>
              <Button size="lg" className="h-11" onClick={() => void createBot()} disabled={creating || !botName.trim()}>
                {creating ? <Loader2 size={15} className="animate-spin" /> : null}
                {t("Create and continue")}
                <ArrowRight size={15} />
              </Button>
            </StepFooter>
          </div>
        )}

        {step === "chief" && (
          <div className="mt-[42px] flex w-full max-w-[640px] flex-col">
            <Heading
              title={t("Make it the main bot")}
              sub={created ? t("{name} is your main bot: starred and pinned, the first thing you see.", { name: created.name }) : t("Pick a main bot any time in Settings → Organization.")}
            />
            {created && (
              <section className={cn(cardCls, "mt-8 flex items-center gap-5 p-6")}>
                <Mascot kind={chosen ? mascotForInstance(chosen) : "workbuddy"} pose="point" scale={1.5} shadow />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <b className="truncate text-[18px] text-ink">{created.name}</b>
                    {created.title && <span className="inline-flex h-5 items-center rounded-full bg-control/70 px-2 text-[11.5px] font-medium text-ink-secondary">{created.title}</span>}
                    <span className="inline-flex h-5 items-center gap-1 rounded-full bg-warning/12 px-2 text-[11.5px] font-semibold text-warning">★ {t("Main bot")}</span>
                  </div>
                  <ul className="mt-3 flex flex-col gap-2 text-[13px] text-ink">
                    {[t("You talk only to it; it finds the right bots for the work."), t("It asks you first about spending money and anything published outside."), t("It looks for things it can do for you on its own.")].map((line) => (
                      <li key={line} className="flex items-start gap-2">
                        <Check size={14} className="mt-[3px] shrink-0 text-success" />
                        {line}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-4 rounded-xl bg-inset/85 px-3 pt-2.5 pb-2 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent)]">
                    <span className="mb-1 block text-[11.5px] font-semibold text-ink-secondary/70">{t("Pinned to the top of the sidebar")}</span>
                    <div className="flex h-[46px] items-center gap-2 rounded-[10px] bg-raised pr-2 pl-1 shadow-[0_1px_2px_rgb(16_24_40/0.05),0_0_0_1px_rgb(16_24_40/0.04)]">
                      <BotTile kind={chosen ? mascotForInstance(chosen) : "workbuddy"} size={24} chief />
                      <span className="flex min-w-0 flex-1 flex-col gap-px">
                        <span className="flex items-center gap-1 text-[13px] leading-[1.35] font-semibold whitespace-nowrap text-ink">
                          <span className="truncate">{created.name}</span>
                          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden className="shrink-0">
                            <path d="M8 1.2l2.1 4.3 4.7.7-3.4 3.3.8 4.7L8 12l-4.2 2.2.8-4.7L1.2 6.2l4.7-.7z" fill="#E5A00D" />
                          </svg>
                        </span>
                        <span className="truncate text-[11.5px] text-ink-secondary">{t("Just created · waiting for your first request")}</span>
                      </span>
                      <span className="text-[11.5px] text-ink-secondary/70">{t("Right now")}</span>
                    </div>
                  </div>
                </div>
              </section>
            )}
            <p className="mt-4 text-center text-[12.5px] text-ink-secondary">{t("The microphone and your phone are optional: set them up now, or later in Settings.")}</p>
            <div className="mt-5 flex items-center justify-end gap-2.5">
              <Button variant="ghost" size="lg" className="h-11" onClick={afterChief}>
                {t("Set up the microphone and phone")}
              </Button>
              <Button size="lg" className="h-11" onClick={finish}>
                {t("Start using Ein")}
                <ArrowRight size={15} />
              </Button>
            </div>
          </div>
        )}

        {step === "permissions" && (
          <div className="mt-[42px] flex w-full max-w-[520px] flex-col">
            <Heading title={t("Permissions")} sub={t("Optional, and only ever used when you ask for the feature.")} />
            <div className={cn(cardCls, "mt-8 flex items-center justify-between gap-3 p-4")}>
              <div className="flex items-start gap-3">
                <Mic size={18} className="mt-0.5 shrink-0 text-ink-secondary" />
                <div>
                  <div className="text-[14px] font-medium text-ink">{t("Microphone & speech")}</div>
                  <div className="mt-0.5 text-[12.5px] text-ink-secondary">{t("Voice dictation into the composer, transcribed on-device.")}</div>
                </div>
              </div>
              {perms?.mic === "granted" ? (
                <Check size={16} className="shrink-0 text-success" />
              ) : perms?.mic === "denied" || perms?.mic === "restricted" ? (
                <Button variant="ghost" size="sm" onClick={() => window.ogb?.permOpenSettings?.("mic")}>
                  {t("Open Settings")}
                </Button>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => window.ogb?.permRequestMic?.().then(() => window.ogb?.permStatus?.().then(setPerms))}>
                  {t("Enable")}
                </Button>
              )}
              {/* Screen Recording deliberately has no row here: macOS 15+
                  makes a pre-grant unreliable (per-process status caching,
                  helper misattribution, periodic re-prompts) — the OS flow
                  triggers on the first real capture in the Computer panel,
                  which is the moment the user has context for the dialog. */}
            </div>
            <div className="mt-6 flex items-center justify-end gap-2.5">
              <button onClick={() => setStep("phone")} className="px-2 text-[12.5px] text-ink-secondary hover:text-ink">
                {t("Skip for now")}
              </button>
              <Button size="lg" className="h-11" onClick={() => setStep("phone")}>
                {t("Continue")}
                <ArrowRight size={15} />
              </Button>
            </div>
          </div>
        )}

        {step === "phone" && (
          <div className={cn(cardCls, "mt-[42px] w-full max-w-[620px] p-8")}>
            <PhoneSetupFlow
              variant="onboarding"
              profileEmail={email}
              onSkip={() => {
                track("phone_setup_skipped");
                finish();
              }}
              onComplete={() => {
                track("phone_setup_completed");
                finish();
              }}
            />
          </div>
        )}
      </div>
      {setupInstance && <EngineSetupDialog instance={setupInstance} onClose={() => setSetupFor(null)} />}
    </div>
  );
}
