// Shown instead of a chat when nothing on this machine can run a bot.
//
// The alternative — which is what used to happen — is a chat that looks
// completely functional until the first message, then fails with a raw spawn
// error. Every engine unavailable is a setup state, not an error state, so it
// gets a screen that says what to do rather than a bot that can't answer.
// Drawn like onboarding: each engine as its mascot with its one next step.
import { Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useStore, type InstanceInfo } from "@/state/store";
import { EngineGroupLabel } from "@/components/EngineGroupLabel";
import { EngineSetup, installCommandFor, needsSignIn } from "@/components/EngineSetup";
import { BotTile, Mascot } from "@/components/mascot/Mascot";
import { Button } from "@/components/ui";
import { splitEngineRail } from "@/lib/engine-rail";
import { t } from "@/lib/i18n";
import { mascotForInstance } from "@/components/settings/engine-model";

function EngineCard({ instance }: { instance: InstanceInfo }) {
  return (
    <div className="rounded-2xl bg-raised p-4 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent),0_1px_2px_rgb(16_24_40/0.05)]">
      <div className="flex items-center gap-3">
        <BotTile kind={mascotForInstance(instance)} size={36} />
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold text-ink">{instance.displayName}</div>
          <div className="text-[12px] text-ink-secondary">{needsSignIn(instance) ? t("Installed, not signed in") : t("Not installed")}</div>
        </div>
      </div>
      <EngineSetup instance={instance} intent={instance.access === "custom" ? "inject" : "cloud"} className="mt-3" />
    </div>
  );
}

export function NoEngines() {
  const { state, refreshInstances } = useStore();
  const [rechecking, setRechecking] = useState(false);

  // Only things you actually install belong on a "get started" screen. The
  // Box cloud runner also reports unavailable here, but it's configured with
  // a token in settings rather than installed, so listing it would just be a
  // dead end alongside the real options.
  const engines = state.instances
    .filter((i) => i.install)
    // An engine with a command for this platform is one the user can act on
    // right now; the rest (GUI downloads, POSIX-only installers on Windows)
    // sort below so the actionable path is the obvious one.
    .sort((a, b) => {
      const aCmd = installCommandFor(a.install) ? 0 : 1;
      const bCmd = installCommandFor(b.install) ? 0 : 1;
      return aCmd - bCmd;
    });

  const recheck = async () => {
    setRechecking(true);
    try {
      await refreshInstances();
    } finally {
      setRechecking(false);
    }
  };

  const { subscription, custom } = splitEngineRail(engines);

  return (
    <main
      className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto"
      style={{
        background:
          "radial-gradient(760px 360px at 50% -10%, color-mix(in oklab, var(--color-select) 9%, transparent) 0%, transparent 70%), radial-gradient(circle, color-mix(in oklab, var(--color-ink) 8%, transparent) 1px, transparent 1.2px) 0 0 / 22px 22px, var(--color-stage)",
      }}
    >
      <div className="mx-auto w-full max-w-[780px] px-6 py-12">
        <div className="flex flex-col items-center text-center">
          <Mascot kind="workbuddy" pose="think" scale={1.5} shadow />
          <h1 className="mt-3 text-[22px] leading-[1.3] font-bold tracking-[-0.2px] text-ink">{t("Install an AI engine to get started")}</h1>
          <p className="mt-1.5 max-w-[60ch] text-[13.5px] leading-relaxed text-ink-secondary">
            {t("Ein doesn’t ship a model of its own — your bots run on an AI CLI installed on this computer, using your existing login. Set up any one of these and your bots come alive.")}
          </p>
        </div>

        {subscription.length > 0 && <EngineGroupLabel className="mt-8 mb-2 px-1">{t("Cloud")}</EngineGroupLabel>}
        <div className="grid gap-3 sm:grid-cols-2">
          {subscription.map((instance) => (
            <EngineCard key={instance.instanceId} instance={instance} />
          ))}
        </div>
        {custom.length > 0 && <EngineGroupLabel className="mt-6 mb-2 px-1">{t("Local")}</EngineGroupLabel>}
        <div className="grid gap-3 sm:grid-cols-2">
          {custom.map((instance) => (
            <EngineCard key={instance.instanceId} instance={instance} />
          ))}
        </div>

        <div className="mt-7 flex justify-center">
          <Button variant="ghost" onClick={() => void recheck()} disabled={rechecking}>
            {rechecking ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {rechecking ? t("Checking…") : t("Check again")}
          </Button>
        </div>
      </div>
    </main>
  );
}
