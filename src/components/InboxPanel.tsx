// 「需要你」：把 gate 失败和最终确认这类真正要老板动手的事收在一处。
// 一句人话 + 通过/打回，打回必须写一句原因；不出现闸门/criteria 这类术语。
//
// 2.0 收口：
//  · 「稍后」= 保留 markInboxSeen + 本地 snooze 24h（localStorage），到期自动
//    回流，顶部可展开看到期时间并撤销；
//  · 标题用统一口径 GET /api/needs-owner 的 total，接口失败回退 items.length。
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Clock, X } from "lucide-react";

import { Button, Dialog } from "@/components/ui";
import { cn } from "@/lib/cn";
import { formatDateTime, t } from "@/lib/i18n";
import {
  activeInboxSnoozes,
  cancelInboxSnooze,
  markInboxSeen,
  readInboxSnoozes,
  resolveInboxItem,
  snoozeInboxItem,
  splitBySnooze,
  useNeedsOwnerTotal,
  writeInboxSnoozes,
  type InboxGroup,
  type InboxItem,
} from "@/lib/inbox";

const KIND_LABEL: Record<InboxItem["kind"], string> = {
  gate_failed: t("Needs your review"),
  signoff: t("Ready to confirm"),
  question: t("Waiting for your answer"),
  failed_exhausted: t("Gave up — needs you"),
  handoff_stuck: t("A handoff is stuck"),
};

export function InboxPanel({
  open,
  items,
  groups,
  onClose,
  onChanged,
}: {
  open: boolean;
  items: InboxItem[];
  groups?: InboxGroup[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  // 统一口径：接口没部署/失败时回退到本列表长度（不挡住收件箱）
  const unifiedTotal = useNeedsOwnerTotal({ enabled: open });

  // ── 本地稍后（localStorage ein.inbox.snooze）────────────────────────
  const [now, setNow] = useState(() => Date.now());
  const [revision, setRevision] = useState(0);
  const [showSnoozed, setShowSnoozed] = useState(false);
  const snoozes = useMemo(() => activeInboxSnoozes(readInboxSnoozes(), now), [now, revision]);
  const { due, snoozed } = useMemo(() => splitBySnooze(items, snoozes, now), [items, snoozes, now]);
  const rereadSnoozes = () => {
    setNow(Date.now());
    setRevision((value) => value + 1);
  };
  useEffect(() => {
    if (!open) return;
    rereadSnoozes();
    // 到期自动回流：面板开着时每分钟重新判定一次，并用新时间重绘
    const timer = window.setInterval(() => {
      writeInboxSnoozes(activeInboxSnoozes(readInboxSnoozes(), Date.now()));
      rereadSnoozes();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [open]);

  const act = async (item: InboxItem, action: "approve" | "reject" | "abandon", text?: string) => {
    setBusy(item.id);
    setError(null);
    try {
      await resolveInboxItem(item.id, action, text, item.attemptId);
      if (action !== "abandon") await markInboxSeen(item.id).catch(() => undefined);
      setRejecting(null);
      setNote("");
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  /** 「稍后」：告诉服务端已读（保留原行为），再在本地压 24 小时。 */
  const later = async (item: InboxItem) => {
    setBusy(item.id);
    setError(null);
    try {
      await markInboxSeen(item.id).catch(() => undefined);
      snoozeInboxItem(item.id);
      rereadSnoozes();
      onChanged();
    } finally {
      setBusy(null);
    }
  };

  const bringBack = (item: InboxItem) => {
    cancelInboxSnooze(item.id);
    rereadSnoozes();
  };

  const titleCount = unifiedTotal ?? items.length;

  return (
    <Dialog open={open} onClose={onClose} label={t("Needs you")} width={560}>
      <header className="flex h-[56px] shrink-0 items-center gap-2.5 pr-3.5 pl-[22px]">
        <AlertTriangle size={18} className="text-warning" />
        <b className="text-[15.5px] text-ink">{t("Needs you {count}", { count: titleCount })}</b>
        <span className="flex-1" />
        <button type="button" onClick={onClose} aria-label={t("Close")} className="grid size-9 place-items-center rounded-full text-ink-secondary hover:bg-raised-hover">
          <X size={14} />
        </button>
      </header>
      {error && <div className="mx-5 mb-2 rounded-lg bg-danger/[0.08] px-3 py-2 text-[12px] text-danger">{error}</div>}
      <div className="max-h-[56vh] overflow-y-auto px-3 pb-3">
        {snoozed.length > 0 && (
          <div className="mx-2 mb-2 rounded-xl bg-raised px-2 py-1.5">
            <button
              type="button"
              onClick={() => setShowSnoozed((value) => !value)}
              aria-expanded={showSnoozed}
              className="flex min-h-9 w-full items-center gap-1.5 px-1 text-left text-[12px] font-semibold text-ink-secondary max-sm:min-h-11"
            >
              <Clock size={13} className="shrink-0 text-ink-secondary/70" />
              <span className="min-w-0 flex-1 truncate">{t("{count} snoozed until tomorrow", { count: snoozed.length })}</span>
              <ChevronDown size={13} className={cn("shrink-0 transition-transform", showSnoozed && "rotate-180")} />
            </button>
            {showSnoozed && (
              <ul className="mt-1 flex flex-col gap-1 border-t border-hairline/25 pt-1.5">
                {snoozed.map((item) => (
                  <li key={item.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 py-0.5">
                    <span className="min-w-0 flex-1 basis-[60%] truncate text-[12px] text-ink">{item.title}</span>
                    <span className="text-[11px] text-ink-secondary/70">
                      {t("Snoozed until {time}", {
                        time: formatDateTime(snoozes[item.id] ?? now, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }),
                      })}
                    </span>
                    <Button size="sm" variant="ghost" className="max-sm:h-11" onClick={() => bringBack(item)}>
                      {t("Cancel snooze")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {due.length === 0 ? (
          <p className="px-2 py-8 text-center text-[12.5px] text-ink-secondary">{t("Nothing needs you right now.")}</p>
        ) : (
          due.map((item, index) => {
            const previous = due[index - 1];
            const header = item.taskId !== previous?.taskId ? groups?.find((group) => group.taskId === item.taskId) : undefined;
            const headerTitle = header?.title ?? (item.taskId ? undefined : t("Other items"));
            return (
              <div key={item.id}>
                {headerTitle && (
                  <div className="mt-2 flex items-center gap-2 px-3 pb-1 text-[11.5px] font-semibold text-ink-secondary">
                    <span className="min-w-0 truncate">{headerTitle}</span>
                    {header && <span className="shrink-0 rounded-full bg-control px-1.5 text-[10.5px]">{t("{count} to handle", { count: header.counts.open })}</span>}
                  </div>
                )}
                <div className="mb-1 rounded-xl px-3 py-2.5 hover:bg-raised-hover/50">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex h-5 items-center rounded-full bg-warning/12 px-2 text-[10.5px] font-semibold text-warning">{KIND_LABEL[item.kind]}</span>
                    <b className="min-w-0 truncate text-[13.5px] text-ink">{item.title}</b>
                  </div>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">{item.reason}</p>
                  <p className="mt-1 text-[11px] text-ink-secondary/70">
                    {item.kind === "gate_failed"
                      ? t("Approve: accept this result. Send back: it redoes the work with your sentence.")
                      : item.kind === "signoff"
                        ? t("Approve: the task becomes finished (the machine only checked form and facts — the content is yours to judge). Send back: record the issue for later.")
                        : t("Approve to continue.")}
                  </p>
                  {item.evidence?.length ? (
                    <ul className="mt-1 list-disc pl-4 text-[11.5px] text-ink-secondary/85">
                      {item.evidence.slice(0, 4).map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  ) : null}
                  {rejecting === item.id ? (
                    <div className="mt-2 flex flex-col gap-2">
                      <textarea
                        value={note}
                        onChange={(event) => setNote(event.target.value)}
                        placeholder={t("What is wrong? One sentence is enough.")}
                        className="min-h-[64px] w-full rounded-lg bg-raised px-3 py-2 text-[12.5px] text-ink shadow-[inset_0_0_0_1px_var(--color-hairline)] outline-none"
                      />
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" className="max-sm:h-11" disabled={!note.trim() || busy === item.id} onClick={() => void act(item, "reject", note.trim())}>
                          {t("Send back and redo")}
                        </Button>
                        <Button size="sm" variant="soft" className="max-sm:h-11" onClick={() => { setRejecting(null); setNote(""); }}>
                          {t("Cancel")}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Button size="sm" className="max-sm:h-11" disabled={busy === item.id} onClick={() => void act(item, "approve")}>
                        <CheckCircle2 size={13} /> {t("Approve and continue")}
                      </Button>
                      <Button size="sm" variant="soft" className="max-sm:h-11" disabled={busy === item.id} onClick={() => { setRejecting(item.id); setNote(""); }}>
                        {t("Send back and redo")}
                      </Button>
                      <Button size="sm" variant="ghost" className="max-sm:h-11" disabled={busy === item.id} onClick={() => void later(item)}>
                        {t("Later")}
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </Dialog>
  );
}
