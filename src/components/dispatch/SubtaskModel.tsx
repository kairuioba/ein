// One dispatched subtask's engine, model and how hard it thinks, with the
// recommender's suggestion beside it. Until the subtask starts (or after it
// failed, before a retry) you can move it to any model on any engine you are
// signed in to and pick any effort that engine offers; the assignee keeps
// its own settings. Used by the run card in the chief's chat and by the
// workbench's dispatch board.
import { useState } from "react";
import { Check, Loader2 } from "lucide-react";

import { api, useStore, type Bot, type ModelSelection } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { ModelPicker } from "@/components/ModelPicker";
import { EffortPicker } from "@/components/EffortPicker";
import { ProviderMark } from "@/components/ProviderIcons";
import {
  canChooseModel,
  engineName,
  followsRecommendation,
  modelName,
  recommendationPick,
  subtaskModel,
  type SubtaskModel,
} from "@/lib/subtask-model";
import { difficultyLabel, effortLabel, type Effort } from "../../../shared/model-recommender";
import { dispatchSettings, type DispatchRun, type DispatchSubtask } from "../../../shared/dispatch-types";

type Pick = { instanceId?: string | null; model?: string | null; effort?: string | null };

/** PATCH a subtask's pick; the run comes back over the live channel. */
async function choose(runId: string, subtaskId: string, pick: Pick): Promise<void> {
  await api(`/api/dispatch/runs/${encodeURIComponent(runId)}/subtasks/${encodeURIComponent(subtaskId)}`, {
    method: "PATCH",
    body: JSON.stringify(pick),
  });
}

/** Five small bars: how hard the planner judged this subtask. */
export function DifficultyMeter({ level }: { level: number }) {
  const clamped = Math.min(5, Math.max(1, Math.round(level))) as 1 | 2 | 3 | 4 | 5;
  const text = t("Difficulty {level}/5 · {label}", { level: clamped, label: difficultyLabel(clamped) });
  return (
    <span className="inline-flex shrink-0 items-center gap-1" title={text} aria-label={text} role="img">
      <span className="inline-flex items-end gap-[2px]" aria-hidden>
        {[1, 2, 3, 4, 5].map((bar) => (
          <span
            key={bar}
            className={cn("w-[3px] rounded-[1px]", bar <= clamped ? (clamped >= 4 ? "bg-warning" : "bg-accent") : "bg-ink-secondary/25")}
            style={{ height: 4 + bar * 1.6 }}
          />
        ))}
      </span>
      <span>{difficultyLabel(clamped)}</span>
    </span>
  );
}

/** "Claude Haiku 4.5 · Medium", or "WorkBuddy · hunyuan-t1" when the
 * model's own name does not say which engine it runs on. */
export function recommendationText(recommended: NonNullable<DispatchSubtask["recommended"]>): string {
  const named = recommended.modelLabel.toLowerCase().includes(recommended.engineName.toLowerCase());
  return [named ? null : recommended.engineName, recommended.modelLabel, recommended.effort ? effortLabel(recommended.effort) : null].filter(Boolean).join(" · ");
}

/** A read-only chip: the engine's mark, the model and the effort. */
function ModelChip({ current }: { current: SubtaskModel }) {
  const { state } = useStore();
  const engine = state.instances.find((instance) => instance.instanceId === current.instanceId);
  return (
    <span
      className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full bg-inset px-2.5 text-[12px] text-ink shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_30%,transparent)]"
      title={`${engineName(state.instances, current.instanceId)} · ${modelName(state.instances, current.instanceId, current.model)}`}
    >
      {engine && <ProviderMark driverKind={engine.driverKind} size={13} />}
      <span className="truncate">{modelName(state.instances, current.instanceId, current.model)}</span>
      {current.effort && (
        <>
          <span className="text-ink-secondary/60">·</span>
          <span className="shrink-0">{effortLabel(current.effort)}</span>
          {current.auto && <span className="shrink-0 text-ink-secondary">{t("(auto)")}</span>}
        </>
      )}
    </span>
  );
}

export function SubtaskModelControls({ run, subtask, bot }: { run: DispatchRun; subtask: DispatchSubtask; bot: Bot | undefined }) {
  const { state } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settings = dispatchSettings(state.config?.dispatch);
  const current = subtaskModel(subtask, bot, state.instances, settings);
  if (!current) return null;
  const recommended = subtask.recommended;
  const follows = followsRecommendation(current, recommended);
  const changeable = canChooseModel(run, subtask) && Boolean(bot);

  const apply = (pick: Pick) => {
    setBusy(true);
    setError(null);
    choose(run.id, subtask.id, pick)
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  // the effort with no level of yours: the bot's own, the difficulty's, or the engine's default
  const withoutPick = subtaskModel({ ...subtask, choice: subtask.choice ? { ...subtask.choice, effort: undefined } : undefined }, bot, state.instances, settings);
  const unsetLabel = withoutPick?.effort ? (withoutPick.auto ? t("Auto") : t("Bot's own")) : t("Default");
  const engine = state.instances.find((instance) => instance.instanceId === current.instanceId);
  const levels = (engine?.capabilities?.effortLevels ?? []) as readonly Effort[];
  const selection: ModelSelection = { instanceId: current.instanceId, model: current.model };

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {changeable ? (
          <>
            <ModelPicker
              value={selection}
              onPick={(next) => apply({ instanceId: next.instanceId, model: next.model })}
              recommended={recommended}
              align="left"
            />
            <EffortPicker
              levels={levels}
              value={subtask.choice?.effort && levels.includes(subtask.choice.effort) ? subtask.choice.effort : undefined}
              unsetLabel={unsetLabel}
              unsetLevel={withoutPick?.effort}
              recommended={recommended && recommended.instanceId === current.instanceId ? recommended.effort : undefined}
              onChange={(level) => apply({ effort: level })}
              disabled={busy}
            />
          </>
        ) : (
          <ModelChip current={current} />
        )}
        {current.borrowed && bot && (
          <span className="text-[11.5px] text-ink-secondary" title={t("For this task only; {name} keeps its own model", { name: bot.name })}>
            {t("For this task only")}
          </span>
        )}
        {busy && <Loader2 size={13} className="animate-spin text-ink-secondary" />}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] leading-[1.5] text-ink-secondary">
        <DifficultyMeter level={subtask.difficulty} />
        {recommended &&
          (follows ? (
            <span className="inline-flex items-center gap-0.5 text-success">
              <Check size={12} />
              {t("Recommended")}
            </span>
          ) : (
            <span className="min-w-0">
              {t("Recommended: {model}", { model: recommendationText(recommended) })}
            </span>
          ))}
        {changeable && recommended && !follows && (
          <button type="button" disabled={busy} onClick={() => apply(recommendationPick(recommended))} className="font-semibold text-accent-text hover:underline disabled:opacity-50">
            {t("Use it")}
          </button>
        )}
        {changeable && subtask.choice && (
          <button type="button" disabled={busy} onClick={() => apply({ instanceId: null, effort: null })} className="text-ink-secondary hover:text-ink hover:underline disabled:opacity-50">
            {t("Reset")}
          </button>
        )}
      </div>
      {error && <p className="text-[11.5px] text-danger">{error}</p>}
    </div>
  );
}

/** Apply every recommendation that is not followed yet, one subtask at a time. */
export async function applyAllRecommendations(run: DispatchRun, bots: readonly Bot[], instances: Parameters<typeof subtaskModel>[2], settings: Parameters<typeof subtaskModel>[3]): Promise<string | null> {
  for (const subtask of run.subtasks) {
    if (!subtask.recommended || !canChooseModel(run, subtask)) continue;
    const bot = bots.find((entry) => entry.id === subtask.assigneeBotId);
    if (!bot || followsRecommendation(subtaskModel(subtask, bot, instances, settings), subtask.recommended)) continue;
    try {
      await choose(run.id, subtask.id, recommendationPick(subtask.recommended));
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause);
    }
  }
  return null;
}

/** How many subtasks could still take their recommendation. */
export function pendingRecommendations(run: DispatchRun, bots: readonly Bot[], instances: Parameters<typeof subtaskModel>[2], settings: Parameters<typeof subtaskModel>[3]): number {
  return run.subtasks.filter((subtask) => {
    if (!subtask.recommended || !canChooseModel(run, subtask)) return false;
    const bot = bots.find((entry) => entry.id === subtask.assigneeBotId);
    return Boolean(bot) && !followsRecommendation(subtaskModel(subtask, bot, instances, settings), subtask.recommended);
  }).length;
}
