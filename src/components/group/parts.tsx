// Small pieces of the group chat (U9): numbered source chips, the 决议 card
// with its action items, centred system lines and the status words the
// minutes reuse. Presentation only — GroupView owns the data.
import type { ReactNode } from "react";
import { CheckCircle2, CircleAlert, FileText, Globe, LoaderCircle } from "lucide-react";

import type { OrgDecision } from "../../../shared/org-types";
import { BotAvatar } from "@/components/Avatar";
import type { TileState } from "@/components/mascot/Mascot";
import { useOrg } from "@/state/org-api";
import { chiefBot } from "@/lib/org";
import { cn } from "@/lib/cn";
import { formatTime, useStore, type Bot } from "@/state/store";
import { formatDateTime, msg, t } from "@/lib/i18n";
import { decisionHeadline } from "@/lib/group-meeting";
import type { NumberedSource } from "@/lib/group-sources";

/** The company's chief (主 Bot): the org's choice, else the unsectioned chief of staff. */
export function useChiefId(): string | undefined {
  const { state } = useStore();
  const { data: org } = useOrg();
  return chiefBot(state.bots, org)?.id;
}

/** A member's tile. Only the company's chief wears the crown — department
 * leads are chiefs of staff of their own section, not the 主 Bot. */
export function MemberAvatar({ bot, size, marker }: { bot: Bot; size: number; marker?: TileState }) {
  const chiefId = useChiefId();
  return <BotAvatar bot={bot} size={size} marker={marker} crown={bot.id === chiefId} />;
}

/** A department colour as name text: pulled toward the ink so it reads on
 * every skin (darker on light skins, lighter on dark ones). */
export function nameInk(color: string | undefined): string | undefined {
  return color ? `color-mix(in oklab, ${color} 80%, var(--color-ink))` : undefined;
}

/** The blue citation number. Clicking it jumps to the message that cited it. */
export function CiteNumber({ n, onJump, className }: { n: number; onJump?: () => void; className?: string }) {
  const style = "inline-grid h-4 min-w-4 shrink-0 place-items-center rounded-[4px] bg-select/10 px-[3px] text-[10px] leading-none font-bold text-accent-text tabular-nums";
  if (!onJump) return <span className={cn(style, className)}>{n}</span>;
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onJump();
      }}
      title={t("Jump to the message that cited it")}
      className={cn(style, "hover:bg-select/20", className)}
    >
      {n}
    </button>
  );
}

/** "今天" / "昨天" / "9月25日" — when a cited version was published. */
export function shortDay(at: number): string {
  const start = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((start(new Date()) - start(new Date(at))) / 86_400_000);
  if (days === 0) return t("Today");
  if (days === 1) return t("Yesterday");
  return formatDateTime(at, { month: "short", day: "numeric" });
}

/** The words after a source's title: what the citation said, else when the
 * cited version was published. */
export function sourceDetail(source: Pick<NumberedSource, "detail" | "versionAt">): string | undefined {
  return source.detail ?? (source.versionAt ? shortDay(source.versionAt) : undefined);
}

/** One cited source as a chip: icon, label, number. */
export function SourceChip({ source, onOpen }: { source: NumberedSource; onOpen: (source: NumberedSource) => void }) {
  const Icon = source.kind === "web" ? Globe : FileText;
  const detail = source.detail ? undefined : sourceDetail(source);
  return (
    <button
      type="button"
      onClick={() => onOpen(source)}
      title={source.kind === "library" ? t("Open in the library") : source.target}
      className="inline-flex h-[22px] max-w-[260px] shrink-0 items-center gap-1 rounded-[7px] bg-raised pr-[3px] pl-[7px] align-[1px] text-[11.5px] leading-none text-ink-secondary hover:text-ink"
      style={{ boxShadow: "inset 0 0 0 1px color-mix(in oklab, var(--color-hairline) 45%, transparent)" }}
    >
      <Icon size={12} className="shrink-0 opacity-70" aria-hidden />
      <span className="truncate">{detail ? `${source.label} · ${detail}` : source.label}</span>
      <span className="ml-0.5 inline-grid h-4 min-w-4 place-items-center rounded-[4px] bg-select/10 px-[3px] text-[10px] font-bold text-accent-text tabular-nums">
        {source.n}
      </span>
    </button>
  );
}

/** The black diamond that marks a decision (amber is reserved for "needs you"). */
export function DecisionMark({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 22 22" className="shrink-0 text-ink" aria-hidden>
      <rect x="4" y="4" width="14" height="14" rx="2.5" transform="rotate(45 11 11)" fill="currentColor" />
    </svg>
  );
}

export type ItemStatus = OrgDecision["actionItems"][number]["status"];

/** How a decision's action item reads in the transcript (the brief view):
 * dispatched or done. The minutes show the finer state. */
export const ITEM_STATUS_SHORT: Record<ItemStatus, { label: string; tone: "blue" | "green" | "red" }> = {
  pending: { label: msg("Dispatched"), tone: "blue" },
  running: { label: msg("Dispatched"), tone: "blue" },
  done: { label: msg("Completed"), tone: "green" },
  failed: { label: msg("Failed"), tone: "red" },
};

export const ITEM_STATUS_LONG: Record<ItemStatus, string> = {
  pending: msg("Dispatched"),
  running: msg("In progress"),
  done: msg("Completed"),
  failed: msg("Failed"),
};

const TONE: Record<"blue" | "green" | "red" | "grey" | "amber", string> = {
  blue: "bg-select/10 text-accent-text",
  green: "bg-success/10 text-success",
  red: "bg-danger/10 text-danger",
  grey: "bg-control/70 text-ink-secondary",
  amber: "bg-warning/10 text-warning",
};

/** The design's small status pill: dot + word, 20px tall. */
export function StatusPill({ tone, children, className }: { tone: keyof typeof TONE; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex h-5 shrink-0 items-center gap-[5px] rounded-full px-2 text-[11.5px] font-semibold whitespace-nowrap", TONE[tone], className)}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {children}
    </span>
  );
}

/** The minutes' status word with its glyph: ✓ done, ◐ in progress, ✕ failed. */
export function ItemStatusText({ status }: { status: ItemStatus }) {
  const label = t(ITEM_STATUS_LONG[status]);
  if (status === "done") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-[12px] font-semibold text-success">
        <CheckCircle2 size={13} aria-hidden />
        {label}
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-[12px] font-semibold text-danger">
        <CircleAlert size={13} aria-hidden />
        {label}
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-[12px] font-semibold text-accent-text">
      {status === "running" ? <LoaderCircle size={13} className="animate-spin [animation-duration:2.4s]" aria-hidden /> : <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {label}
    </span>
  );
}

/** "你 16:23 拍板" / "总控 16:23 拍板". */
export function decidedByLabel(decision: OrgDecision, bots: readonly Bot[], chiefId?: string): string {
  const time = formatTime(decision.at);
  if (decision.decidedBy === "owner") return t("You decided at {time}", { time });
  const chief = bots.find((bot) => bot.id === chiefId);
  if (decision.decidedBy === "chief" && chief) return t("{name} decided at {time}", { name: chief.name, time });
  if (decision.decidedBy === "lead") return t("A lead decided at {time}", { time });
  return t("Decided at {time}", { time });
}

/** The 决议 card in the transcript: headline, who decided on what basis, and
 * the action items it dispatched. */
export function DecisionCard({
  decision,
  basis,
  chiefId,
  onJump,
}: {
  decision: OrgDecision;
  basis: Array<{ text: string; n?: number }>;
  chiefId?: string;
  onJump: (n: number) => void;
}) {
  const { state } = useStore();
  const items = decision.actionItems;
  return (
    <div className="flex w-full max-w-[560px] flex-col gap-1.5 rounded-[14px] bg-control/60 px-3.5 py-3">
      <div className="flex items-center gap-2">
        <span className="flex min-w-0 flex-1 items-center gap-[7px] text-[13.5px] font-bold text-ink">
          <DecisionMark />
          <span className="truncate">{t("Decision #{id}: {title}", { id: decision.id, title: decisionHeadline(decision) })}</span>
        </span>
        <StatusPill tone="green">{t("Decided")}</StatusPill>
      </div>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] text-ink-secondary">
        <span>{decidedByLabel(decision, state.bots, chiefId)}</span>
        {basis.length > 0 && (
          <>
            <span className="opacity-50">·</span>
            <span className="inline-flex flex-wrap items-center gap-1">
              {t("based on")}
              {basis.map((entry, index) => (
                <span key={`${entry.text}:${index}`} className="inline-flex items-center gap-1">
                  {index > 0 && <span>{t("and")}</span>}
                  <span>{entry.text}</span>
                  {entry.n !== undefined && <CiteNumber n={entry.n} onJump={() => onJump(entry.n!)} />}
                </span>
              ))}
            </span>
          </>
        )}
        {items.length > 0 && (
          <>
            <span className="opacity-50">·</span>
            <b className="font-semibold text-ink">{t("{count} action items created", { count: items.length })}</b>
          </>
        )}
      </div>
      {items.length > 0 && (
        <div className="mt-0.5 rounded-[10px] bg-raised pr-2.5 pl-2" style={{ boxShadow: "inset 0 0 0 1px color-mix(in oklab, var(--color-hairline) 45%, transparent)" }}>
          {items.map((item, index) => {
            const owner = state.bots.find((bot) => bot.id === item.botId);
            const status = ITEM_STATUS_SHORT[item.status];
            return (
              <div key={`${item.title}:${index}`} className="flex h-[30px] items-center gap-2 border-b border-hairline/25 text-[12.5px] last:border-b-0">
                <span className="grid size-[18px] shrink-0 place-items-center rounded-md bg-control/70 text-[11px] font-bold text-ink-secondary">{index + 1}</span>
                <b className="min-w-0 flex-1 truncate font-semibold text-ink">{item.title}</b>
                <span className="flex w-[118px] shrink-0 items-center gap-1 truncate text-ink-secondary">
                  {owner ? <MemberAvatar bot={owner} size={16} /> : null}
                  <span className="truncate">{owner?.name ?? t("Unassigned")}</span>
                </span>
                <StatusPill tone={status.tone}>{t(status.label)}</StatusPill>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** A centred grey line between messages (meeting over, a rule of the room). */
export function SystemLine({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-center gap-1.5 text-center text-[12px] text-ink-secondary [&_b]:font-semibold [&_b]:text-ink">
      {icon}
      <span>{children}</span>
    </div>
  );
}
