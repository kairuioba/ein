// Settings → General → Automatic dispatch. The same settings the workbench
// toolbar edits (strategy, on/off), plus the limits that keep a Chief from
// creating a crowd of bots or running everything at once.
import { useEffect, useState } from "react";
import { Minus, Plus } from "lucide-react";

import { api, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { DEFAULT_DISPATCH_SETTINGS, dispatchSettings, type DispatchSettings } from "../../shared/dispatch-types";
import { policyLabel, RECOMMENDATION_POLICIES, type RecommendationPolicy } from "../../shared/model-recommender";
import { Card, Switch } from "./SettingsPrimitives";

type StatusWithDispatch = ConfigStatus & { dispatch?: Partial<DispatchSettings> };

export function policyHint(policy: RecommendationPolicy): string {
  if (policy === "quality") return t("New specialists get the strongest model available for their task.");
  if (policy === "economy") return t("New specialists get the cheapest model that can still do the task.");
  return t("Hard tasks get strong models, routine tasks get fast and inexpensive ones.");
}

/** The dispatch settings in /api/config, loaded once per mount and saved as a
 * whole (the strategy card on Settings › Engines shares this). */
export function useDispatchSettings() {
  const { dispatch } = useStore();
  const [settings, setSettings] = useState<DispatchSettings>(DEFAULT_DISPATCH_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api("/api/config")
      .then((status: StatusWithDispatch) => {
        if (!alive) return;
        setSettings(dispatchSettings(status.dispatch));
        setLoaded(true);
      })
      .catch((cause) => alive && setError(cause instanceof Error ? cause.message : String(cause)));
    return () => {
      alive = false;
    };
  }, []);

  const save = (patch: Partial<DispatchSettings>) => {
    const next = dispatchSettings({ ...settings, ...patch });
    const previous = settings;
    setSettings(next);
    setSaving(true);
    setError(null);
    api("/api/config", { method: "PATCH", body: JSON.stringify({ dispatch: next }) })
      .then((status: StatusWithDispatch) => {
        dispatch({ type: "configStatus", config: status });
        setSettings(dispatchSettings(status.dispatch ?? next));
      })
      .catch((cause) => {
        setSettings(previous);
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setSaving(false));
  };

  return { settings, loaded, saving, error, save };
}

export function DispatchSettingsCard() {
  const { settings, loaded, saving, error, save } = useDispatchSettings();

  const disabled = !loaded || saving;

  return (
    <Card
      title={t("Automatic dispatch")}
      subtitle={t("A Chief of Staff splits a multi-step request into subtasks, hands each to the best-suited team member, creates the specialists that are missing, and reports back when everything is done.")}
    >
      <div className="space-y-3.5">
        <ToggleRow
          label={t("Dispatch automatically")}
          hint={t("Chiefs plan and assign work themselves. Off: they only answer and delegate when you ask.")}
          checked={settings.enabled}
          disabled={disabled}
          onChange={(enabled) => save({ enabled })}
        />
        <ToggleRow
          label={t("Create missing specialists")}
          hint={t("When nobody on the team fits a subtask, a new bot is created with a recommended model.")}
          checked={settings.autoCreate}
          disabled={disabled || !settings.enabled}
          onChange={(autoCreate) => save({ autoCreate })}
        />
        <ToggleRow
          label={t("Ask me before a plan starts")}
          hint={t("New plans wait on the workbench until you press Start.")}
          checked={settings.requireApproval}
          disabled={disabled || !settings.enabled}
          onChange={(requireApproval) => save({ requireApproval })}
        />
        <ToggleRow
          label={t("Consolidated report")}
          hint={t("When every subtask has settled, the Chief writes one summary in its conversation.")}
          checked={settings.autoSynthesize}
          disabled={disabled || !settings.enabled}
          onChange={(autoSynthesize) => save({ autoSynthesize })}
        />

        <div className="border-t border-hairline/40 pt-3.5">
          <div className="mb-2 text-[13px] text-ink">{t("Model strategy")}</div>
          <div className="inline-flex rounded-xl bg-inset p-1" role="radiogroup" aria-label={t("Model strategy")}>
            {RECOMMENDATION_POLICIES.map((policy) => (
              <button
                key={policy}
                type="button"
                role="radio"
                aria-checked={settings.policy === policy}
                disabled={disabled}
                onClick={() => save({ policy })}
                className={cn(
                  "rounded-lg px-3.5 py-1.5 text-[12.5px] transition-colors disabled:opacity-60",
                  settings.policy === policy ? "bg-raised text-ink shadow" : "text-ink-secondary hover:text-ink",
                )}
              >
                {policyLabel(policy)}
              </button>
            ))}
          </div>
          <div className="mt-1.5 text-[12px] leading-relaxed text-ink-secondary">{policyHint(settings.policy)}</div>
        </div>

        <div className="grid gap-3 border-t border-hairline/40 pt-3.5 sm:grid-cols-2">
          <Stepper
            label={t("Subtasks running at once")}
            value={settings.maxConcurrent}
            min={1}
            max={8}
            disabled={disabled}
            onChange={(maxConcurrent) => save({ maxConcurrent })}
          />
          <Stepper
            label={t("New bots per plan")}
            value={settings.maxNewBots}
            min={0}
            max={10}
            disabled={disabled || !settings.autoCreate}
            onChange={(maxNewBots) => save({ maxNewBots })}
          />
          <Stepper
            label={t("Subtasks per plan")}
            value={settings.maxSubtasks}
            min={1}
            max={30}
            disabled={disabled}
            onChange={(maxSubtasks) => save({ maxSubtasks })}
          />
          <Stepper
            label={t("Attempts per subtask")}
            value={settings.maxAttempts}
            min={1}
            max={3}
            disabled={disabled}
            onChange={(maxAttempts) => save({ maxAttempts })}
          />
        </div>
      </div>
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    </Card>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-ink">{label}</div>
        <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{hint}</div>
      </div>
      <Switch checked={checked} disabled={disabled} aria-label={label} onClick={() => onChange(!checked)} />
    </div>
  );
}

function Stepper({
  label,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (next: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg bg-inset px-3 py-2">
      <span className="text-[12.5px] text-ink-secondary">{label}</span>
      <div className="flex items-center gap-1" role="group" aria-label={label}>
        <button
          type="button"
          aria-label={t("Decrease")}
          disabled={disabled || value <= min}
          onClick={() => onChange(value - 1)}
          className="flex size-6 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
        >
          <Minus size={12} />
        </button>
        <span className="w-6 text-center text-[13px] tabular-nums text-ink" aria-live="polite">
          {value}
        </span>
        <button
          type="button"
          aria-label={t("Increase")}
          disabled={disabled || value >= max}
          onClick={() => onChange(value + 1)}
          className="flex size-6 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
        >
          <Plus size={12} />
        </button>
      </div>
    </div>
  );
}
