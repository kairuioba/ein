// Pure helpers behind Settings › Engines and onboarding's engine grid: each
// engine's status from its instance snapshot, which bots run on it, which rows
// fold away, and the task → engine examples the recommender gives.
import { mascotForDriver, type MascotKind } from "@/lib/engine-mascots";
import { msg } from "@/lib/i18n";
import { recommendForText, type Effort, type InstanceLike, type RecommendationPolicy } from "../../../shared/model-recommender";

/** The engine this edition recommends first (Tencent WorkBuddy). */
export const RECOMMENDED_DRIVER = "workbuddyAgent";

/** Engines whose own models are open-weights (shown with a 开源 badge). */
const OPEN_SOURCE_DRIVERS = new Set(["hermesAgent"]);

export type EngineState = "ready" | "signin" | "installed" | "found" | "missing";

export interface EngineInstance {
  instanceId: string;
  driverKind: string;
  displayName: string;
  snapshot: { state: "available" | "unavailable"; authenticated?: boolean; reason?: string };
  models: { default: string; options: Array<{ id: string; label: string; custom?: boolean }> };
  access?: "subscription" | "custom";
}

export interface EngineBot {
  id: string;
  name: string;
  hidden?: boolean;
  chiefOfStaff?: boolean;
  section?: string;
  createdAt?: number;
  modelSelection: { instanceId: string; model?: string };
}

/** The mascot an engine wears. OpenAI-compatible servers are local models. */
export function mascotForInstance(instance: Pick<EngineInstance, "driverKind">): MascotKind {
  if (instance.driverKind === "openai-compat") return "local";
  return mascotForDriver(instance.driverKind);
}

/** Models found on this machine (Ollama, LM Studio …), counted once each. */
export function localModels(instances: readonly EngineInstance[]): string[] {
  const ids = new Set<string>();
  for (const instance of instances) for (const option of instance.models.options) if (option.custom) ids.add(option.id);
  return [...ids];
}

export function engineState(instance: EngineInstance): EngineState {
  if (instance.snapshot.state !== "available") return "missing";
  const custom = instance.models.options.filter((option) => option.custom);
  if (instance.access === "custom") return custom.length ? "found" : "installed";
  if (instance.snapshot.authenticated === false) return "signin";
  return "ready";
}

/** Can a bot on this engine run a turn right now? */
export function engineUsable(instance: EngineInstance): boolean {
  const state = engineState(instance);
  return state === "ready" || state === "found" || state === "installed";
}

export const ENGINE_STATE_LABEL: Record<Exclude<EngineState, "found">, string> = {
  ready: msg("Signed in"),
  signin: msg("Not signed in"),
  installed: msg("Installed on this computer"),
  missing: msg("Not installed"),
};

export type EngineTone = "ok" | "warn" | "found" | "off";

export function engineTone(state: EngineState): EngineTone {
  if (state === "ready" || state === "installed") return "ok";
  if (state === "signin") return "warn";
  if (state === "found") return "found";
  return "off";
}

export type EngineAction = "settings" | "signin" | "install";

export function engineAction(state: EngineState): EngineAction {
  if (state === "signin") return "signin";
  if (state === "missing") return "install";
  return "settings";
}

/** Up to `limit` model names to show as chips: the default first, then the
 * engine's own list; an engine that only runs local models shows those. */
export function modelChips(instance: EngineInstance, limit = 3): { labels: string[]; mono: boolean } {
  const official = instance.models.options.filter((option) => !option.custom);
  const custom = instance.models.options.filter((option) => option.custom);
  const pool = official.length && instance.access !== "custom" ? official : custom;
  const ordered = [...pool].sort((a, b) => Number(b.id === instance.models.default) - Number(a.id === instance.models.default));
  return { labels: ordered.slice(0, limit).map((option) => option.label || option.id), mono: pool === custom && custom.length > 0 };
}

export interface EngineRow<B extends EngineBot = EngineBot> {
  instance: EngineInstance;
  kind: MascotKind;
  state: EngineState;
  recommended: boolean;
  openSource: boolean;
  bots: B[];
}

/** The bots that run on each engine, the chief first, then oldest first. */
export function botsOnEngine<B extends EngineBot>(bots: readonly B[], instanceId: string, chiefId?: string | null): B[] {
  return bots
    .filter((bot) => !bot.hidden && bot.modelSelection.instanceId === instanceId)
    .sort(
      (a, b) =>
        Number(b.id === chiefId) - Number(a.id === chiefId) ||
        Number(Boolean(b.chiefOfStaff)) - Number(Boolean(a.chiefOfStaff)) ||
        (a.createdAt ?? 0) - (b.createdAt ?? 0),
    );
}

export function engineRows<B extends EngineBot>(instances: readonly EngineInstance[], bots: readonly B[], chiefId?: string | null): EngineRow<B>[] {
  const rows = instances
    // the cloud-computer runner is not an engine a bot talks through
    .filter((instance) => instance.driverKind !== "boxAgent")
    .map((instance) => ({
      instance,
      kind: mascotForInstance(instance),
      state: engineState(instance),
      recommended: instance.driverKind === RECOMMENDED_DRIVER,
      openSource: OPEN_SOURCE_DRIVERS.has(instance.driverKind),
      bots: botsOnEngine(bots, instance.instanceId, chiefId),
    }));
  // the recommended engine leads; everything else keeps the server's order
  return [...rows.filter((row) => row.recommended), ...rows.filter((row) => !row.recommended)];
}

/** Rows to show and rows folded behind "N more": engines in use and the
 * recommended one always show; quiet engines fill up to `fill` rows (ready
 * ones first) and the rest fold. */
export function foldRows<R extends Pick<EngineRow, "recommended" | "bots" | "state">>(rows: readonly R[], fill = 8): { shown: R[]; folded: R[] } {
  const keep = new Set<R>(rows.filter((row) => row.recommended || row.bots.length > 0));
  const quiet = rows.filter((row) => !keep.has(row));
  const rank = (row: R) => (row.state === "ready" ? 0 : row.state === "found" || row.state === "installed" ? 1 : row.state === "signin" ? 2 : 3);
  for (const row of [...quiet].sort((a, b) => rank(a) - rank(b))) {
    if (keep.size >= fill) break;
    if (row.state === "missing") continue;
    keep.add(row);
  }
  return { shown: rows.filter((row) => keep.has(row)), folded: rows.filter((row) => !keep.has(row)) };
}

/** One word for a folded group: all signed in, or how many need what. */
export function foldedSummary(rows: ReadonlyArray<Pick<EngineRow, "state">>): { tone: EngineTone; parts: Array<{ state: EngineState; count: number }> } {
  const counts = new Map<EngineState, number>();
  for (const row of rows) counts.set(row.state, (counts.get(row.state) ?? 0) + 1);
  const parts = [...counts.entries()].map(([state, count]) => ({ state, count }));
  const allUsable = rows.every((row) => row.state === "ready" || row.state === "installed" || row.state === "found");
  return { tone: allUsable ? "ok" : rows.some((row) => row.state === "signin") ? "warn" : "off", parts };
}

export interface EngineSummary {
  total: number;
  usable: number;
  localModels: number;
}

export function engineSummary(instances: readonly EngineInstance[]): EngineSummary {
  const engines = instances.filter((instance) => instance.driverKind !== "boxAgent");
  return {
    total: engines.length,
    usable: engines.filter(engineUsable).length,
    localModels: localModels(engines).length,
  };
}

/** Engines in the order onboarding's first-bot grid shows them: the
 * recommended one, then the well-known ones, then the rest in server order. */
const ONBOARDING_ORDER = [RECOMMENDED_DRIVER, "claudeAgent", "codex", "grokAgent", "kimiAgent", "qwenAgent", "hermesAgent", "openai-compat"];

export function onboardingEngines<I extends Pick<EngineInstance, "driverKind">>(instances: readonly I[], limit = 8): I[] {
  const rank = (instance: I) => {
    const at = ONBOARDING_ORDER.indexOf(instance.driverKind);
    return at < 0 ? ONBOARDING_ORDER.length : at;
  };
  return instances
    .filter((instance) => instance.driverKind !== "boxAgent")
    .map((instance, index) => ({ instance, index }))
    .sort((a, b) => rank(a.instance) - rank(b.instance) || a.index - b.index)
    .slice(0, limit)
    .map(({ instance }) => instance);
}

/** The sample jobs the strategy card shows, as task text for the recommender. */
export const STRATEGY_EXAMPLES: ReadonlyArray<{ id: string; label: string; task: string }> = [
  { id: "writing", label: msg("Writing"), task: "写一篇发布会新闻稿和三段卖点文案" },
  { id: "coding", label: msg("Coding"), task: "实现落地页前端代码并修复接口 bug" },
  { id: "design", label: msg("Design"), task: "分析竞品的设计方案，给主视觉提三个方向" },
  { id: "books", label: msg("Bookkeeping"), task: "简单核对一下今天的账目和预算" },
];

export interface StrategyExample {
  id: string;
  label: string;
  instanceId: string;
  engineName: string;
  model: string;
  /** how hard it would think there (absent: the engine has no such setting) */
  effort?: Effort;
}

/** For each sample job, the engine the dispatcher would hire under `policy`. */
export function strategyExamples(instances: readonly InstanceLike[], policy: RecommendationPolicy): StrategyExample[] {
  const out: StrategyExample[] = [];
  for (const example of STRATEGY_EXAMPLES) {
    const best = recommendForText(example.task, instances, policy, {}, { limit: 1 }).recommendations[0];
    if (best) out.push({ id: example.id, label: example.label, instanceId: best.instanceId, engineName: best.engineName, model: best.modelLabel, ...(best.effort ? { effort: best.effort } : {}) });
  }
  return out;
}

/** The engine the recommender would pick for a bot's own job description. */
export function recommendedFor(text: string, instances: readonly InstanceLike[], policy: RecommendationPolicy = "balanced"): { instanceId: string; engineName: string; model: string } | null {
  if (!text.trim()) return null;
  const best = recommendForText(text, instances, policy, {}, { limit: 1 }).recommendations[0];
  return best ? { instanceId: best.instanceId, engineName: best.engineName, model: best.modelLabel } : null;
}
