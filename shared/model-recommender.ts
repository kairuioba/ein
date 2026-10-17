// Model recommendation: match a task's difficulty and needs against the
// engines and models this machine can actually run right now.
//
// Pure functions shared by the app (recommendation badges, the workbench
// inspector) and the harness (the dispatcher picks models for the bots it
// creates). Inputs are the same instance descriptions /api/instances serves.
import { t } from "./i18n.ts";
import { profileFor, type Capability, type Level, type ModelProfile, type ProfileOverride } from "./model-profiles.ts";

export type RecommendationPolicy = "quality" | "balanced" | "economy";
export const RECOMMENDATION_POLICIES: readonly RecommendationPolicy[] = ["quality", "balanced", "economy"];

export function isRecommendationPolicy(value: unknown): value is RecommendationPolicy {
  return value === "quality" || value === "balanced" || value === "economy";
}

const EFFORT_ORDER = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_ORDER)[number];

export interface TaskProfile {
  /** 1 = trivial, 5 = hardest. */
  difficulty: Level;
  needs: Capability[];
  /** The work needs an agent with tools (files, shell, web), not plain chat. */
  requiresTools: boolean;
  /** The work needs a desktop it can see and click. */
  requiresComputer: boolean;
}

/** One model on one engine instance, as the recommender sees it. */
export interface ModelCandidate {
  instanceId: string;
  engineName: string;
  driverKind: string;
  model: string;
  modelLabel: string;
  tools: boolean;
  computer: boolean;
  images: boolean;
  subscription: boolean;
  effortLevels: readonly string[];
  /** Position in its engine's catalog. Engines list their current models
   * first, so between equally suited models the earlier one is the newer. */
  rank?: number;
}

export interface Recommendation {
  instanceId: string;
  engineName: string;
  model: string;
  modelLabel: string;
  effort?: Effort;
  score: number;
  profile: ModelProfile;
  reasons: string[];
}

/** The subset of an /api/instances row the recommender reads. */
export interface InstanceLike {
  instanceId: string;
  driverKind: string;
  displayName?: string;
  snapshot?: { state?: string; authenticated?: boolean; billing?: string };
  models?: { default?: string; options?: Array<{ id: string; label?: string }> };
  capabilities?: { agentsMcp?: boolean; computerMcp?: boolean; images?: boolean; effortLevels?: readonly string[] };
  access?: string;
}

// Keyword cues, Chinese and English. Deliberately coarse: the planner's own
// difficulty estimate, when present, outranks these.
const CUES: Array<{ need: Capability | "tools" | "complex" | "simple"; pattern: RegExp }> = [
  { need: "coding", pattern: /代码|编程|程序|脚本|函数|接口|bug|修复|重构|实现|部署|测试用例|单元测试|前端|后端|数据库|sql|api|git|仓库|编译|code|coding|script|refactor|implement|debug|deploy|repo|typescript|python|java|react/i },
  { need: "reasoning", pattern: /分析|推理|规划|设计|架构|方案|策略|评估|论证|证明|数学|对比|比较|决策|优化|plan|design|architect|analy[sz]e|strategy|evaluate|prove|math|compare|optimi[sz]e/i },
  { need: "writing", pattern: /写|撰写|文案|文章|稿|翻译|总结|摘要|邮件|报告|润色|改写|公众号|小红书|周报|write|draft|copy|translate|summar|email|report|blog|rewrite/i },
  { need: "chinese", pattern: /[一-鿿]/ },
  { need: "vision", pattern: /图片|截图|图像|照片|设计稿|海报|ocr|识别图|image|screenshot|photo|diagram|figma|mockup/i },
  { need: "computer", pattern: /打开.*(应用|软件|网页|浏览器)|点击|操作电脑|桌面|填写表单|网页上|浏览器里|登录.*网站|click|desktop|browser|fill (in|out)|log ?in to/i },
  { need: "longContext", pattern: /长文档|整本|整个仓库|全部文件|大量|上百|几百页|long document|entire (repo|codebase)|all files|hundreds of/i },
  { need: "tools", pattern: /文件|目录|搜索|调研|查资料|下载|上传|运行|执行|命令|爬取|抓取|file|folder|search|research|download|upload|run |execute|command|scrape|crawl/i },
  { need: "complex", pattern: /复杂|系统性|全面|端到端|完整|多个|多步|一整套|从零|生产级|complex|end-to-end|comprehensive|complete|multi-?step|from scratch|production/i },
  { need: "simple", pattern: /简单|快速|一句话|顺便|小改|看一下|查一下|simple|quick|brief|one-?liner|small/i },
];

const clampLevel = (value: number): Level => Math.min(5, Math.max(1, Math.round(value))) as Level;

/** Estimate difficulty and needs from task text, optionally refined by a
 * planner's own estimate (difficulty 1–5 and declared needs). */
export function assessTask(text: string, hint: { difficulty?: number; needs?: readonly string[] } = {}): TaskProfile {
  const needs = new Set<Capability>();
  let tools = false;
  let complex = false;
  let simple = false;
  for (const cue of CUES) {
    if (!cue.pattern.test(text)) continue;
    if (cue.need === "tools") tools = true;
    else if (cue.need === "complex") complex = true;
    else if (cue.need === "simple") simple = true;
    else needs.add(cue.need);
  }
  for (const declared of hint.needs ?? []) {
    if ((["coding", "reasoning", "writing", "chinese", "vision", "computer", "longContext", "speed"] as const).includes(declared as Capability)) {
      needs.add(declared as Capability);
    }
  }
  let difficulty = 2;
  if (needs.has("coding")) difficulty += 1;
  if (needs.has("reasoning")) difficulty += 0.5;
  if (needs.has("computer")) difficulty += 0.5;
  if (complex) difficulty += 1;
  if (text.length > 400) difficulty += 0.5;
  if (text.length > 1200) difficulty += 0.5;
  if (simple) difficulty -= 1;
  if (Number.isFinite(hint.difficulty)) difficulty = (difficulty + 2 * Number(hint.difficulty)) / 3;
  if (simple && !complex) needs.add("speed");
  return {
    difficulty: clampLevel(difficulty),
    needs: [...needs],
    requiresTools: tools || needs.has("coding") || needs.has("computer"),
    requiresComputer: needs.has("computer"),
  };
}

/** Flatten instance descriptions into runnable model candidates. Engines
 * that are unavailable or signed out are left out: recommending something
 * that cannot run is worse than recommending nothing. */
export function candidatesFromInstances(instances: readonly InstanceLike[]): ModelCandidate[] {
  const candidates: ModelCandidate[] = [];
  for (const instance of instances) {
    if (instance.snapshot?.state !== "available" || instance.snapshot.authenticated === false) continue;
    if (instance.driverKind === "boxAgent") continue; // the cloud-computer runner is not a chat engine
    const options = instance.models?.options ?? [];
    for (const [rank, option] of options.entries()) {
      if (!option?.id) continue;
      candidates.push({
        rank,
        instanceId: instance.instanceId,
        engineName: instance.displayName ?? instance.instanceId,
        driverKind: instance.driverKind,
        model: option.id,
        modelLabel: option.label ?? option.id,
        tools: instance.capabilities?.agentsMcp === true,
        computer: instance.capabilities?.computerMcp === true,
        images: instance.capabilities?.images === true,
        subscription: instance.snapshot?.billing === "subscription" || (instance.snapshot?.billing === undefined && instance.access !== "custom"),
        effortLevels: instance.capabilities?.effortLevels ?? [],
      });
    }
  }
  return candidates;
}

const WEIGHTS: Record<RecommendationPolicy, { quality: number; cost: number; speed: number; overkill: number }> = {
  quality: { quality: 3, cost: 0.25, speed: 0.25, overkill: 0 },
  balanced: { quality: 2, cost: 0.9, speed: 0.5, overkill: 0.8 },
  economy: { quality: 1.2, cost: 1.8, speed: 0.9, overkill: 1.4 },
};

const CAPABILITY_LABEL = (capability: Capability): string =>
  ({
    coding: t("coding"),
    reasoning: t("reasoning"),
    writing: t("writing"),
    chinese: t("Chinese"),
    vision: t("images"),
    computer: t("computer use"),
    longContext: t("long documents"),
    speed: t("speed"),
  })[capability];

/** Every effort level, lightest first ("none" = thinking off). */
export const EFFORT_LEVELS: readonly Effort[] = EFFORT_ORDER;

/** How hard to think for a task this difficult, before the engine's own
 * knobs are considered. The whole ladder is used: very easy work gets low,
 * then medium, high and xhigh, and very hard work max; the strategy moves
 * it one step (Strongest up, Save money down — down to thinking off for
 * the easiest work). */
export function wantedEffort(difficulty: Level, policy: RecommendationPolicy = "balanced"): Effort {
  const shift = policy === "quality" ? 1 : policy === "economy" ? -1 : 0;
  return EFFORT_ORDER[Math.min(EFFORT_ORDER.length - 1, Math.max(0, difficulty + shift))]!;
}

/** The reasoning effort that suits a difficulty on this engine, if it has
 * the knob: the wanted level, else the nearest one the engine offers below
 * it, else the lightest one it offers above. */
export function effortFor(difficulty: Level, levels: readonly string[], policy: RecommendationPolicy = "balanced"): Effort | undefined {
  const order = EFFORT_ORDER as readonly string[];
  const available = (levels.filter((level) => order.includes(level)) as Effort[]).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  if (!available.length) return undefined;
  const wantedIndex = order.indexOf(wantedEffort(difficulty, policy));
  const below = available.filter((level) => order.indexOf(level) <= wantedIndex);
  return below.length ? below[below.length - 1] : available[0];
}

/** A short label for an effort level ("XHigh", "Max", "Off"). */
export function effortLabel(effort: Effort): string {
  return effort === "xhigh" ? "XHigh" : effort === "none" ? t("Off") : effort.charAt(0).toUpperCase() + effort.slice(1);
}

/** Score every candidate for the task and return the best `limit`, best first. */
export function recommendModels(
  task: TaskProfile,
  candidates: readonly ModelCandidate[],
  policy: RecommendationPolicy = "balanced",
  options: { limit?: number; overrides?: Readonly<Record<string, ProfileOverride>> } = {},
): Recommendation[] {
  const weights = WEIGHTS[policy];
  const scored: Array<Recommendation & { rank: number }> = [];
  for (const candidate of candidates) {
    if (task.requiresTools && !candidate.tools) continue;
    if (task.requiresComputer && !candidate.computer) continue;
    if (task.needs.includes("vision") && !candidate.images) continue;
    const profile = profileFor(candidate.model, candidate.modelLabel, options.overrides);
    const reasons: string[] = [];
    const gap = profile.tier - task.difficulty;
    let score = weights.quality * Math.min(profile.tier, task.difficulty + 1);
    if (gap < 0) score -= 2.5 * -gap; // underpowered models fail tasks; that costs more than tokens
    if (gap > 1) score -= weights.overkill * (gap - 1);
    const matched = task.needs.filter((need) => profile.strengths.includes(need));
    score += 1.2 * matched.length;
    score -= weights.cost * profile.cost;
    score += weights.speed * (profile.speed - 3);
    if (candidate.subscription) score += policy === "economy" ? 1.2 : 0.4;
    if (task.requiresTools && candidate.tools) score += 0.3;

    if (gap >= 0) reasons.push(t("Capable enough for this task (level {tier} of 5)", { tier: profile.tier }));
    else reasons.push(t("Below this task's difficulty — expect weaker results"));
    if (matched.length) reasons.push(t("Strong at {skills}", { skills: matched.map(CAPABILITY_LABEL).join(t(", ")) }));
    if (task.requiresComputer) reasons.push(t("Can operate a computer"));
    else if (task.requiresTools) reasons.push(t("Can use files, the shell and the web"));
    if (candidate.subscription) reasons.push(t("Runs on a subscription you already have"));
    if (profile.cost <= 1 && profile.speed >= 4) reasons.push(t("Fast and inexpensive"));
    else if (profile.tier === 5) reasons.push(t("One of the most capable models available"));

    scored.push({
      instanceId: candidate.instanceId,
      engineName: candidate.engineName,
      model: candidate.model,
      modelLabel: candidate.modelLabel,
      effort: effortFor(task.difficulty, candidate.effortLevels, policy),
      score: Math.round(score * 100) / 100,
      profile,
      reasons,
      rank: candidate.rank ?? Number.MAX_SAFE_INTEGER,
    });
  }
  // Ties go to the model its engine lists first — the current one. A label
  // tie-break picked "Claude Fable 5" over "Claude Fable 5.1" and "Sonnet
  // 4.6" over "Sonnet 5.5" once engines listed their older models too.
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.profile.cost - b.profile.cost ||
      a.rank - b.rank ||
      a.modelLabel.localeCompare(b.modelLabel),
  );
  return scored.slice(0, options.limit ?? 3).map(({ rank: _rank, ...recommendation }) => recommendation);
}

/** Convenience: assess the text and recommend in one call. */
export function recommendForText(
  text: string,
  instances: readonly InstanceLike[],
  policy: RecommendationPolicy = "balanced",
  hint: { difficulty?: number; needs?: readonly string[] } = {},
  options: { limit?: number; overrides?: Readonly<Record<string, ProfileOverride>> } = {},
): { task: TaskProfile; recommendations: Recommendation[] } {
  const task = assessTask(text, hint);
  return { task, recommendations: recommendModels(task, candidatesFromInstances(instances), policy, options) };
}

/** Short human label for a difficulty level. */
export function difficultyLabel(level: Level): string {
  return [t("Trivial"), t("Easy"), t("Moderate"), t("Hard"), t("Very hard")][level - 1]!;
}

/** Short human label for a policy. */
export function policyLabel(policy: RecommendationPolicy): string {
  return policy === "quality" ? t("Best quality") : policy === "economy" ? t("Lowest cost") : t("Balanced");
}
