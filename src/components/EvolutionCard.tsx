// 简报页顶部的一张「自我进化」卡：公司从真实失败里总结出的改进提案，
// 老板在这里拍板。只在有 open 提案时出现（无提案完全不占位）。
//
// 一块卡只展示最高优先的一条：标题 + why（折叠 120 字）+ 采纳 / 不采纳 /
// 稍后 + 看证据（默认折叠，最多 3 条）+ 「共 N 条待决定」。不展开时不出现
// attempt/criteria/gate 这类实现黑话；拍板走 POST /api/evolution/:id/resolve，
// 成功后刷新（下一条或整张卡消失），失败给一句人话。
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Sparkles } from "lucide-react";

import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";
import {
  clipWhy,
  evidenceLines,
  openProposals,
  resolveEvolutionProposal,
  topOpenProposal,
  type EvolutionDecision,
  type EvolutionFeed,
} from "@/lib/evolution";
import { t } from "@/lib/i18n";

export function EvolutionCard({ feed }: { feed: EvolutionFeed }) {
  // 拍板成功后刷新返回前，先把刚处理的那条藏起来：卡片立刻换下一条或消失，
  // 不会先闪回旧提案。
  const [decided, setDecided] = useState<ReadonlySet<string>>(() => new Set());
  const [showEvidence, setShowEvidence] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<EvolutionDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );

  const open = useMemo(
    () => openProposals(feed).filter((proposal) => !decided.has(proposal.id)),
    [feed, decided],
  );
  const proposal = topOpenProposal(feed, decided);

  // 换到另一条提案时，收起上一条的展开状态（证据/拒绝输入）。
  useEffect(() => {
    setShowEvidence(false);
    setRejecting(false);
    setNote("");
  }, [proposal?.id]);

  const decide = async (status: EvolutionDecision, reason?: string) => {
    if (!proposal || busy) return;
    setBusy(status);
    setError(null);
    try {
      await resolveEvolutionProposal(proposal.id, status, reason);
      setDecided((current) => new Set(current).add(proposal.id));
      setRejecting(false);
      setNote("");
      setFlash(
        status === "accepted"
          ? t("Accepted — the team will follow up")
          : status === "rejected"
            ? t("Rejected — it won't be pursued")
            : t("Deferred — it waits for later"),
      );
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash(null), 4_000);
    } catch {
      setError(t("Could not save your decision. Try again."));
    } finally {
      setBusy(null);
    }
  };

  if (!proposal || open.length === 0) return null;
  const evidence = evidenceLines(proposal);

  return (
    <section
      aria-labelledby="evolution-card-title"
      className="mb-4 rounded-[14px] bg-raised px-4 py-3.5 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent)]"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="grid size-7 shrink-0 place-items-center rounded-[9px] bg-select/12 text-accent-text">
          <Sparkles size={15} />
        </span>
        <b id="evolution-card-title" className="text-[14.5px]">
          {t("The company is evolving itself")}
        </b>
        <span className="text-[12px] whitespace-nowrap text-ink-secondary">
          {t("{count} waiting for your call", { count: open.length })}
        </span>
        {flash && (
          <span role="status" className="text-[12px] font-semibold text-success">
            {flash}
          </span>
        )}
      </div>

      <p className="mt-2.5 text-[14.5px] leading-snug font-semibold">{proposal.title}</p>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{clipWhy(proposal.why)}</p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="lg" className="max-sm:h-11" disabled={busy !== null} onClick={() => void decide("accepted")}>
          {t("Accept")}
        </Button>
        <Button
          variant="danger"
          size="lg"
          className="max-sm:h-11"
          disabled={busy !== null}
          aria-expanded={rejecting}
          onClick={() => setRejecting((value) => !value)}
        >
          {t("Reject")}
        </Button>
        <Button variant="ghost" size="lg" className="max-sm:h-11" disabled={busy !== null} onClick={() => void decide("deferred")}>
          {t("Later")}
        </Button>
        {evidence.length > 0 && (
          <button
            type="button"
            onClick={() => setShowEvidence((value) => !value)}
            aria-expanded={showEvidence}
            className="ml-auto inline-flex h-9 items-center gap-1 rounded-lg px-2 text-[12.5px] font-semibold whitespace-nowrap text-accent-text hover:bg-control max-sm:ml-0 max-sm:w-full max-sm:justify-center"
          >
            {showEvidence ? t("Hide evidence") : t("See evidence")}
            <ChevronDown size={14} className={cn("transition-transform", showEvidence && "rotate-180")} />
          </button>
        )}
      </div>

      {rejecting && (
        <div className="mt-2.5 flex flex-col gap-2 rounded-xl bg-inset px-3 py-2.5">
          <label htmlFor="evolution-reject-note" className="text-[12px] font-semibold text-ink-secondary">
            {t("Why not? (optional)")}
          </label>
          <input
            id="evolution-reject-note"
            value={note}
            maxLength={200}
            placeholder={t("A short reason helps the team learn")}
            onChange={(event) => setNote(event.target.value)}
            className="h-10 w-full rounded-[10px] bg-raised px-3 text-[13.5px] text-ink shadow-[inset_0_0_0_1px_var(--color-hairline)] placeholder:text-ink-secondary/70 focus:shadow-[inset_0_0_0_1px_var(--color-select)] focus:outline-none"
          />
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="ghost"
              size="md"
              className="max-sm:h-11"
              disabled={busy !== null}
              onClick={() => {
                setRejecting(false);
                setNote("");
              }}
            >
              {t("Cancel")}
            </Button>
            <Button
              variant="danger"
              size="md"
              className="max-sm:h-11"
              disabled={busy !== null}
              onClick={() => void decide("rejected", note)}
            >
              {t("Confirm reject")}
            </Button>
          </div>
        </div>
      )}

      {showEvidence && evidence.length > 0 && (
        <ul aria-label={t("Evidence")} className="mt-2.5 flex flex-col gap-1.5 rounded-xl bg-inset px-3 py-2.5">
          {evidence.map((line, index) => (
            <li key={`${index}-${line}`} className="flex gap-2 text-[12.5px] leading-relaxed text-ink-secondary">
              <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-ink-secondary/50" />
              <span className="min-w-0 break-words">{line}</span>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p role="alert" className="mt-2 text-[12.5px] font-medium text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
