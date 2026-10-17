// The receive side of dispatch: whatever model ran a subtask, its reply may end
// with a fenced ```json {"handoff": {...}} ``` block. Parsing it here keeps the
// chief's synthesis cheap (it reads the envelope, not the whole process) and
// lets a reviewer check the worker's own claims. A missing block is not an
// error — older workers and weaker models just fall back to the free text.
import type { DispatchHandoff } from "../shared/dispatch-types.ts";

const LIMITS = {
  summary: 1_000,
  list: 12,
  item: 500,
} as const;

const text = (value: unknown, max = LIMITS.item): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
};

const textList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((entry) => text(entry))
    .filter((entry): entry is string => Boolean(entry))
    .slice(0, LIMITS.list);
  return items.length ? items : undefined;
};

/** Find the LAST fenced json block in a reply (models often show drafts first). */
export function extractHandoffBlock(reply: string): unknown {
  const matches = [...reply.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const body = matches[index]?.[1];
    if (!body || !/"handoff"|'handoff'|"summary"/.test(body)) continue;
    try {
      return JSON.parse(body) as unknown;
    } catch {
      // try an earlier block; a broken fence should not lose a valid earlier one
    }
  }
  return undefined;
}

/** Normalize whatever the model sent into the company's envelope. */
export function parseHandoff(reply: string): DispatchHandoff | undefined {
  const block = extractHandoffBlock(reply);
  const raw = block && typeof block === "object" && "handoff" in block ? (block as { handoff?: unknown }).handoff : block;
  if (!raw || typeof raw !== "object") return undefined;
  const input = raw as Record<string, unknown>;
  const summary = text(input.summary);
  if (!summary) return undefined;
  const statusRaw = typeof input.status === "string" ? input.status.trim().toLowerCase() : "done";
  const status: DispatchHandoff["status"] = statusRaw === "partial" || statusRaw === "blocked" ? statusRaw : "done";
  const decisions = Array.isArray(input.decisions)
    ? input.decisions
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const what = text((entry as Record<string, unknown>).what);
          const why = text((entry as Record<string, unknown>).why);
          return what ? { what, ...(why ? { why } : {}) } : null;
        })
        .filter((entry): entry is { what: string; why?: string } => Boolean(entry))
        .slice(0, LIMITS.list)
    : undefined;
  const risks = Array.isArray(input.risks)
    ? input.risks
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const risk = text((entry as Record<string, unknown>).risk);
          const impact = text((entry as Record<string, unknown>).impact);
          const next = text((entry as Record<string, unknown>).next);
          return risk ? { risk, ...(impact ? { impact } : {}), ...(next ? { next } : {}) } : null;
        })
        .filter((entry): entry is { risk: string; impact?: string; next?: string } => Boolean(entry))
        .slice(0, LIMITS.list)
    : undefined;
  return {
    status,
    summary: summary.slice(0, LIMITS.summary),
    ...(textList(input.evidence) ? { evidence: textList(input.evidence) } : {}),
    ...(textList(input.artifacts) ? { artifacts: textList(input.artifacts) } : {}),
    ...(decisions?.length ? { decisions } : {}),
    ...(textList(input.assumptions) ? { assumptions: textList(input.assumptions) } : {}),
    ...(textList(input.openQuestions) ? { openQuestions: textList(input.openQuestions) } : {}),
    ...(risks?.length ? { risks } : {}),
    ...(text(input.nextStep) ? { nextStep: text(input.nextStep) } : {}),
    ...(typeof input.acceptanceMet === "boolean" ? { acceptanceMet: input.acceptanceMet } : {}),
  };
}

/** One short line for the chief's synthesis: the envelope, not the process. */
export function handoffLine(handoff: DispatchHandoff): string {
  const parts = [handoff.summary];
  if (handoff.acceptanceMet === false) parts.push("acceptance: not met");
  if (handoff.openQuestions?.length) parts.push(`open: ${handoff.openQuestions.join("; ")}`);
  if (handoff.nextStep) parts.push(`next: ${handoff.nextStep}`);
  return parts.join(" · ");
}
