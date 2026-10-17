// 跨任务上下文共享 v1：只共享「经验」，不搬旧聊天记录。
//
// 规则（与 Claude 评审+老板裁决一致）：
//   - 只有验收通过的任务贡献「做法」；失败/未完成的任务只贡献带 negative 的教训；
//   - 最多 3 个来源，总预算 ≤1500 tokens（中文按 1 字≈1 token 粗略估计）；
//   - 渲染文本带「仅供参考、须核实」声明，明确不得覆盖本任务验收标准；
//   - 由调用方负责部门隔离校验，这里只负责构建与裁剪。
export interface ContextSource {
  taskId: string;
  title: string;
  /** accepted = the task's gate passed (until the gate exists this is a
   * PROXY: run done + no failed leaf); acceptedBasis records which one */
  accepted: boolean;
  acceptedBasis?: "gate" | "proxy";
  goal?: string;
  artifacts?: string[];
  decisions?: string[];
  acceptance?: string[];
  pitfalls?: string[];
  openIssues?: string[];
}

export interface RenderedContextShare {
  text: string;
  tokens: number;
  fromTaskIds: string[];
}

const MAX_SOURCES = 3;
const BUDGET_TOKENS = 1_500;
const PER_SOURCE_TOKENS = 600;

const approxTokens = (text: string): number => Math.ceil([...text].length / 1.1);
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const section = (label: string, items: readonly string[] | undefined, max: number): string | null => {
  const kept = (items ?? []).map((item) => item.trim()).filter(Boolean);
  return kept.length ? `${label}:\n${kept.map((item) => `- ${clip(item, max)}`).join("\n")}` : null;
};

/** Render one bounded, read-only context block. */
export function buildContextShare(sources: readonly ContextSource[]): RenderedContextShare {
  const picked = sources.slice(0, MAX_SOURCES);
  const blocks: string[] = [];
  const used: string[] = [];
  let budget = BUDGET_TOKENS;
  for (const source of picked) {
    if (budget <= 0) break;
    const basis = source.acceptedBasis ?? "proxy";
    const header = source.accepted
      ? `<prior_context readonly="true" source_task="${source.taskId}" accepted="true" accepted_basis="${basis}">`
      : `<prior_context readonly="true" source_task="${source.taskId}" negative="true">`;
    const parts = [
      source.accepted ? `[outcome] ${clip(source.goal ?? source.title, 160)}` : `[negative outcome] ${clip(source.goal ?? source.title, 160)}`,
      source.accepted ? section("[approach]", source.acceptance, 80) : null,
      section("[decisions]", source.decisions, 90),
      section("[pitfalls]", source.pitfalls, 90),
      section("[open issues]", source.openIssues, 90),
      section("[artifacts]", source.artifacts, 100),
    ].filter((part): part is string => Boolean(part));
    let body = parts.join("\n");
    // per-source cap
    if (approxTokens(body) > PER_SOURCE_TOKENS) {
      // drop the least important first: open issues, decisions, artifacts
      const keep = parts.filter((part) => !/^\[(open issues|decisions|artifacts)\]/.test(part));
      body = (keep.length ? keep : parts).join("\n");
      while (approxTokens(body) > PER_SOURCE_TOKENS && body.length > 40) body = body.slice(0, Math.floor(body.length * 0.8));
    }
    const block = `${header}\n${body}\n</prior_context>`;
    const cost = approxTokens(block);
    if (cost > budget) continue;
    budget -= cost;
    used.push(source.taskId);
    blocks.push(block);
  }
  if (!blocks.length) return { text: "", tokens: 0, fromTaskIds: [] };
  const text = [
    "[此前任务的经验，仅供参考，可能过时；须对照当前仓库与当前任务核实，不得覆盖本任务的验收标准]",
    ...blocks,
  ].join("\n\n");
  return { text, tokens: approxTokens(text), fromTaskIds: used };
}
