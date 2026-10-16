import {
  Cloud,
  Loader2,
  LogOut,
  ShieldCheck,
  Smartphone,
  Trash2,
  Wifi,
} from "lucide-react";
import {
  PhoneSetupFlowView,
  companionAccountActionError,
  companionBridge,
  loadCompanionBridgeState,
  shouldHydrateCompanionEmail,
  type CompanionState,
  usePhoneSetupController,
} from "./PhoneSetupFlow";
import { companionPairingMode } from "../lib/phone-setup";
import { ConnectionDetail } from "./ConnectionDetail";
import { Card, Switch } from "./SettingsPrimitives";
import { t, tn } from "@/lib/i18n";

export {
  companionAccountActionError,
  companionPairingMode,
  loadCompanionBridgeState,
  shouldHydrateCompanionEmail,
};

export interface CompanionPanelStatus {
  label: string;
  good: boolean;
}

export function deriveCompanionPanelStatus(
  state: Pick<CompanionState, "enabled" | "devices" | "error">,
): CompanionPanelStatus | null {
  if (state.error) return { label: t("Phone access needs attention"), good: false };
  if (!state.enabled) return { label: t("Phone access off"), good: false };
  const pairedCount = state.devices.length;
  if (!pairedCount) return null;
  return {
    label: tn(pairedCount, "{count} phone paired", "{count} phones paired"),
    good: true,
  };
}

const relative = (at: number) => {
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 90) return t("just now");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("{count} min ago", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("{count} h ago", { count: hours });
  return t("{count} d ago", { count: Math.round(hours / 24) });
};

const endpointHost = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export function CompanionSection({ profileEmail = "" }: { profileEmail?: string }) {
  const c = usePhoneSetupController(profileEmail);
  const state = c.state;

  if (!companionBridge()) {
    return (
      <Card
        title={t("Use OpenMausBot from your phone")}
        subtitle={t("Open Settings in the OpenMausBot desktop app to set up a phone.")}
      />
    );
  }

  if (!state) {
    return (
      <Card title={t("Phone")} subtitle={t("Checking phone access…")}>
        <Loader2 size={15} className="animate-spin text-ink-secondary" />
      </Card>
    );
  }

  const pairedCount = state.devices.length;
  const panelStatus = deriveCompanionPanelStatus(state);
  const accountActionError = companionAccountActionError(c.account, c.accountError);
  const hosted = state.endpoints?.find((endpoint) => endpoint.kind === "hosted");
  const localRoutes = [
    state.tailnetName ? { label: "Tailscale", value: `${state.tailnetName}:${state.port}` } : null,
    state.lan ? { label: "Wi-Fi", value: `${state.lan}:${state.port}` } : null,
    state.discovery?.name
      ? { label: t("Nearby discovery"), value: `${state.discovery.name}:${state.port}` }
      : null,
    ...(state.addresses ?? [])
      .filter((address) => address !== state.lan && address !== state.tailscale)
      .map((address, index) => ({ label: t("Local route {number}", { number: index + 1 }), value: `${address}:${state.port}` })),
  ].filter((route): route is { label: string; value: string } => Boolean(route));

  return (
    <div className="flex flex-col gap-4">
      <Card>
        {(panelStatus || (pairedCount > 0 && c.hostedReady)) && (
          <div className="mb-4 flex items-center justify-between gap-3">
            {panelStatus && (
              <div
                className={`flex items-center gap-2 rounded-full px-2.5 py-1 text-[11.5px] ${
                  panelStatus.good ? "bg-success/10 text-success" : "bg-control text-ink-secondary"
                }`}
              >
                <span className={`size-1.5 rounded-full ${panelStatus.good ? "bg-success" : "bg-ink-secondary/50"}`} />
                {panelStatus.label}
              </div>
            )}
            {pairedCount > 0 && c.hostedReady && (
              <div className="flex items-center gap-1.5 text-[11.5px] text-ink-secondary">
                <ShieldCheck size={13} className="text-accent" /> {t("Works away from home")}
              </div>
            )}
          </div>
        )}
        <PhoneSetupFlowView controller={c} variant="settings" />
      </Card>

      <Card
        title={t("Paired phones")}
        subtitle={pairedCount ? t("Manage the phones that can use this OpenMausBot.") : t("No phones are paired yet.")}
      >
        {pairedCount > 0 && (
          <ul className="flex flex-col gap-2">
            {state.devices.map((device) => (
              <li key={device.id} className="rounded-xl bg-inset px-3 py-3">
                <div className="flex items-center gap-3">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-control text-ink-secondary">
                    <Smartphone size={15} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-medium text-ink">{device.name}</div>
                    <div className="text-[11.5px] text-ink-secondary">{t("Last seen {time}", { time: relative(device.lastSeenAt) })}</div>
                  </div>
                  <button
                    disabled={c.busy}
                    onClick={() => void c.act((companion) => companion.revoke(device.id))}
                    aria-label={t("Remove {name}", { name: device.name })}
                    className="shrink-0 rounded p-1.5 text-ink-secondary hover:bg-control hover:text-danger disabled:opacity-40"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <div className="mt-3 flex items-center justify-between gap-3 border-t border-hairline/30 pt-3">
                  <div>
                    <div className="text-[12px] text-ink">{t("Allow computer view")}</div>
                    <div className="mt-0.5 text-[11px] text-ink-secondary">{t("Full interactive access from this phone.")}</div>
                  </div>
                  <Switch
                    checked={device.cloudDesktopAccess}
                    aria-label={t("Computer view access for {name}", { name: device.name })}
                    disabled={c.busy}
                    onClick={() =>
                      void c.act((companion) =>
                        companion.cloudDesktop(device.id, !device.cloudDesktopAccess),
                      )
                    }
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <details className="rounded-xl border border-hairline/40 bg-card">
        <summary className="cursor-pointer px-4 py-3.5 text-[13px] font-medium text-ink">
          {t("Advanced & troubleshooting")}
        </summary>
        <div className="flex flex-col gap-4 border-t border-hairline/30 px-4 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[13px] text-ink">{t("Phone access")}</div>
              <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">
                {t("Turn off all phone connections to this computer.")}
              </div>
            </div>
            <Switch
              checked={state.enabled}
              aria-label={t("Phone access")}
              disabled={c.busy}
              onClick={() => void c.act((companion) => (state.enabled ? companion.stop() : companion.start()))}
            />
          </div>

          <div className="flex items-center justify-between gap-4 border-t border-hairline/30 pt-4">
            <div className="min-w-0">
              <div className="text-[13px] text-ink">{t("Keep this computer awake")}</div>
              <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">
                {t("Keeps phone access and scheduled work available while the screen is off.")}
              </div>
            </div>
            <Switch
              checked={state.keepAwake}
              aria-label={t("Keep this computer awake while Phone access is on")}
              disabled={c.busy || !state.enabled}
              onClick={() => void c.act((companion) => companion.keepAwake(!state.keepAwake))}
            />
          </div>

          <div className="border-t border-hairline/30 pt-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-2.5">
                <Cloud size={15} className="mt-0.5 shrink-0 text-accent" />
                <div className="min-w-0">
                  <div className="text-[13px] text-ink">{t("Secure phone account")}</div>
                  <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">
                    {c.account?.status === "ready"
                      ? t("Signed in as {email}.", { email: c.account.email ?? t("your account") })
                      : c.account?.status === "connecting"
                        ? t("Finishing secure access…")
                        : c.account?.status === "error"
                          ? (c.account.message ? t(c.account.message) : t("Secure access needs attention."))
                          : t("You’ll be asked to sign in when you pair a phone.")}
                  </div>
                </div>
              </div>
              {(c.account?.status === "ready" || c.account?.status === "connecting" || c.account?.status === "error") && (
                <button
                  disabled={c.accountBusy}
                  onClick={() => void c.accountAct((remote) => remote.signOut())}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1.5 text-[11.5px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40"
                >
                  <LogOut size={12} />{" "}
                  {t("Sign out")}
                </button>
              )}
            </div>
            {c.account?.status === "error" && (
              <button
                disabled={c.accountBusy}
                onClick={c.retryAccount}
                className="mt-3 rounded-lg border border-hairline/40 px-3 py-1.5 text-[12px] text-ink hover:bg-control disabled:opacity-40"
              >
                {c.accountBusy ? t("Trying again…") : t("Retry secure access")}
              </button>
            )}
            {accountActionError && <div className="mt-2 text-[12px] text-danger">{accountActionError}</div>}
          </div>

          <div className="border-t border-hairline/30 pt-4">
            <div className="text-[13px] text-ink">{t("Connection details")}</div>
            <div className="mt-0.5 text-[11.5px] text-ink-secondary">
              {t("Reveal or copy an address only when troubleshooting manual pairing.")}
            </div>
            <div className="mt-3 flex flex-col gap-2">
              {hosted && <ConnectionDetail label={t("Secure route")} value={endpointHost(hosted.url)} />}
              {localRoutes.map((route) => <ConnectionDetail key={`${route.label}:${route.value}`} {...route} />)}
              {!hosted && localRoutes.length === 0 && (
                <div className="text-[12px] text-ink-secondary">{t("No reachable address is available yet.")}</div>
              )}
            </div>
          </div>

          <div className="border-t border-hairline/30 pt-4">
            {c.tailscaleAvailable && (
              <div className="mb-4 border-b border-hairline/30 pb-4">
                <div className="flex items-start gap-2.5">
                  <ShieldCheck size={15} className="mt-0.5 shrink-0 text-accent" />
                  <div>
                    <div className="text-[13px] text-ink">{t("Tailscale pairing")}</div>
                    <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">
                      {t("Keep pairing on your private tailnet, even when a secure hosted route is available.")}
                    </div>
                  </div>
                </div>
                <button
                  disabled={c.busy || c.accountBusy}
                  onClick={c.useTailscale}
                  className="mt-3 rounded-lg border border-hairline/40 px-3 py-1.5 text-[12px] text-ink hover:bg-control disabled:opacity-40"
                >
                  {t("Pair over Tailscale")}
                </button>
              </div>
            )}
            <div className="flex items-start gap-2.5">
              <Wifi size={15} className="mt-0.5 shrink-0 text-ink-secondary" />
              <div>
                <div className="text-[13px] text-ink">{t("Direct Wi-Fi pairing")}</div>
                <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">
                  {t("Use this only when both devices are nearby and the network allows devices to see each other.")}
                </div>
              </div>
            </div>
            <button
              disabled={c.busy || c.accountBusy}
              onClick={c.useLocal}
              className="mt-3 rounded-lg border border-hairline/40 px-3 py-1.5 text-[12px] text-ink hover:bg-control disabled:opacity-40"
            >
              {t("Pair on this Wi-Fi")}
            </button>
          </div>

          {state.enabled && !hosted && state.tailscale && !state.tailnetName && (
            <div className="rounded-lg bg-warning/10 px-3 py-2 text-[11.5px] leading-relaxed text-ink-secondary">
              {t("Tailscale is connected, but its device name could not be read. Check MagicDNS in Tailscale or use the secure account above.")}
            </div>
          )}
          {state.enabled && !hosted && !state.tailscale && (
            <div className="rounded-lg bg-inset px-3 py-2 text-[11.5px] leading-relaxed text-ink-secondary">
              {t("Without secure phone access or Tailscale, this computer is reachable only on a compatible local network.")}
            </div>
          )}
          {(c.error || state.error) && <div className="text-[12px] text-danger">{c.error ?? state.error}</div>}
        </div>
      </details>
    </div>
  );
}
