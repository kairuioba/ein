// 阶段4的执行面板：已采纳的提案可以交给维护机器人；到了 merge_ready 后
// 只有老板点「批准合并」才会真正 merge（并带 headSha 绑定）。
import { useMemo, useState } from "react";
import { GitBranch, ShieldCheck, Wrench } from "lucide-react";

import { Button } from "@/components/ui";
import { t } from "@/lib/i18n";
import {
  EVOLUTION_STATE_LABELS,
  mergeEvolutionRun,
  startEvolutionRun,
  useEvolutionRuns,
} from "@/lib/evolution-runs";
import type { EvolutionFeed } from "@/lib/evolution";

export function EvolutionRunList({ feed }: { feed: EvolutionFeed }) {
  const { runs, executions } = useEvolutionRuns();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const accepted = useMemo(
    () => (feed.proposals ?? []).filter((proposal) => proposal.status === "accepted"),
    [feed.proposals],
  );
  const byProposal = useMemo(() => new Map(executions.map((execution) => [execution.proposalId, execution])), [executions]);
  const runByProposal = useMemo(
    () => new Map(runs.filter((entry) => entry.run.proposalId).map((entry) => [entry.run.proposalId!, entry])),
    [runs],
  );
  const visible = accepted.filter((proposal) => byProposal.has(proposal.id) || runByProposal.has(proposal.id));
  if (visible.length === 0) return null;
  const act = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="mb-2 rounded-2xl bg-card p-3 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent)]">
      <div className="mb-2 flex items-center gap-2">
        <Wrench size={15} className="text-ink-secondary" />
        <b className="text-[13.5px] text-ink">{t("The company is changing itself")}</b>
      </div>
      {error && <div className="mb-1.5 rounded-lg bg-danger/[0.08] px-2.5 py-1.5 text-[11.5px] text-danger">{error}</div>}
      <ul className="space-y-1.5">
        {visible.map((proposal) => {
          const execution = byProposal.get(proposal.id);
          const run = runByProposal.get(proposal.id);
          const state = execution?.state ?? run?.run.state ?? "accepted";
          const canStart = state === "accepted" && Boolean(run);
          const canMerge = state === "merge_ready" && Boolean(execution?.headSha) && Boolean(run);
          return (
            <li key={proposal.id} className="rounded-xl bg-raised px-3 py-2">
              <div className="flex items-center gap-2">
                <GitBranch size={12} className="shrink-0 text-ink-secondary" />
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{proposal.title}</span>
                <span className="shrink-0 rounded-full bg-control px-2 py-0.5 text-[10.5px] text-ink-secondary">
                  {t(EVOLUTION_STATE_LABELS[state] ?? state)}
                </span>
              </div>
              {execution?.review?.reason && (
                <p className="mt-1 text-[11px] leading-relaxed text-ink-secondary">{t("Review: {reason}", { reason: execution.review.reason })}</p>
              )}
              {execution?.error && <p className="mt-1 text-[11px] text-danger">{execution.error}</p>}
              {(canStart || canMerge) && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {canStart && run && (
                    <Button size="sm" disabled={busy !== null} onClick={() => void act(proposal.id, () => startEvolutionRun(run.run.id))} className="gap-1">
                      <Wrench size={12} /> {t("Hand to the maintenance bot")}
                    </Button>
                  )}
                  {canMerge && run && execution?.headSha && (
                    <Button
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => {
                        if (!window.confirm(t("Merge this self-modification into the source repository now?"))) return;
                        void act(proposal.id, () => mergeEvolutionRun(run.run.id, execution.headSha!));
                      }}
                      className="gap-1"
                    >
                      <ShieldCheck size={12} /> {t("Approve the merge")}
                    </Button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
