// 「需要你」：把 gate 失败和最终确认这类真正要老板动手的事收在一处。
// 一句人话 + 通过/打回，打回必须写一句原因；不出现闸门/criteria 这类术语。
import { useState } from "react";
import { AlertTriangle, CheckCircle2, X } from "lucide-react";

import { Button, Dialog } from "@/components/ui";
import { t } from "@/lib/i18n";
import { markInboxSeen, resolveInboxItem, type InboxGroup, type InboxItem } from "@/lib/inbox";

const KIND_LABEL: Record<InboxItem["kind"], string> = {
  gate_failed: t("Needs your review"),
  signoff: t("Ready to confirm"),
  question: t("Waiting for your answer"),
  failed_exhausted: t("Gave up — needs you"),
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

  return (
    <Dialog open={open} onClose={onClose} label={t("Needs you")} width={560}>
      <header className="flex h-[56px] shrink-0 items-center gap-2.5 pr-3.5 pl-[22px]">
        <AlertTriangle size={18} className="text-warning" />
        <b className="text-[15.5px] text-ink">{t("Needs you")}</b>
        <span className="flex-1" />
        <button type="button" onClick={onClose} aria-label={t("Close")} className="rounded-full p-1.5 text-ink-secondary hover:bg-raised-hover">
          <X size={14} />
        </button>
      </header>
      {error && <div className="mx-5 mb-2 rounded-lg bg-danger/[0.08] px-3 py-2 text-[12px] text-danger">{error}</div>}
      <div className="max-h-[56vh] overflow-y-auto px-3 pb-3">
        {items.length === 0 ? (
          <p className="px-2 py-8 text-center text-[12.5px] text-ink-secondary">{t("Nothing needs you right now.")}</p>
        ) : (
          items.map((item, index) => {
            const previous = items[index - 1];
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
                    ? t("Approve: the task becomes finished. Send back: record the issue for later.")
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
                  <div className="flex gap-2">
                    <Button size="sm" disabled={!note.trim() || busy === item.id} onClick={() => void act(item, "reject", note.trim())}>
                      {t("Send back and redo")}
                    </Button>
                    <Button size="sm" variant="soft" onClick={() => { setRejecting(null); setNote(""); }}>
                      {t("Cancel")}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-2 flex items-center gap-2">
                  <Button size="sm" disabled={busy === item.id} onClick={() => void act(item, "approve")} className="gap-1">
                    <CheckCircle2 size={13} /> {t("Approve and continue")}
                  </Button>
                  <Button size="sm" variant="soft" disabled={busy === item.id} onClick={() => { setRejecting(item.id); setNote(""); }}>
                    {t("Send back and redo")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { void markInboxSeen(item.id).then(onChanged); }}>
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
