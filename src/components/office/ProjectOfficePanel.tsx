// 项目内协同办公面板：团队状态、此刻等待链、待拍板、异常。
// 数据全部来自 GET /api/task-folders/:id/office（服务端由派单事实推导）。
import { useState } from "react";
import { AlertTriangle, ArrowLeftRight, CheckCircle2, Clock3, Lock, Users, X } from "lucide-react";

import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { resolveInboxItem } from "@/lib/inbox";
import { useProjectOffice, type OfficeMember } from "@/lib/office";
import type { TaskFolderView } from "../../../shared/task-folders";

const PRESENCE: Record<OfficeMember["presence"], { label: string; color: string }> = {
  working: { label: t("Working"), color: "bg-select" },
  waiting: { label: t("Waiting on someone"), color: "bg-warning" },
  reviewing: { label: t("Reviewing"), color: "bg-accent-text" },
  blocked: { label: t("Blocked"), color: "bg-danger" },
  idle: { label: t("Idle"), color: "bg-hairline" },
};

const minutesLabel = (minutes: number): string => (minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}` : `${Math.max(1, Math.round(minutes))}m`);

export function ProjectOfficePanel({
  task,
  onClose,
  onOpenConversation,
}: {
  task: TaskFolderView;
  onClose: () => void;
  onOpenConversation: (botId: string, threadId: string) => void;
}) {
  const office = useProjectOffice(task.id);
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const act = async (id: string, action: "approve" | "reject", attemptId?: string) => {
    setBusy(id);
    setError(null);
    try {
      await resolveInboxItem(id, action, action === "reject" ? note.trim() : undefined, attemptId);
      setRejecting(null);
      setNote("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };
  const waiting = office?.now.waiting ?? [];
  const decisions = office?.decisions ?? [];
  const anomalies = office?.anomalies ?? [];
  const departments = office?.departments ?? [];
  // one-line conclusion: how much attention does this project need right now
  const oldest = waiting.reduce((max, entry) => Math.max(max, entry.minutes), 0);
  const conclusion =
    decisions.length > 0
      ? { tone: "danger", text: t("{count} decision(s) waiting for you", { count: decisions.length }) }
      : anomalies.length > 0
        ? { tone: "warning", text: t("{count} thing(s) need a look", { count: anomalies.length }) }
        : oldest >= 15
          ? { tone: "warning", text: t("Someone has been blocked for {minutes} minutes", { minutes: oldest }) }
          : { tone: "ok", text: t("Everything is under control right now") };
  return (
    <div className="fixed inset-0 z-[70] flex items-stretch justify-center bg-black/30 sm:items-center sm:p-4">
      <div className="flex h-full max-h-none w-full max-w-none flex-col overflow-hidden bg-card shadow-2xl sm:h-auto sm:max-h-[92vh] sm:max-w-[560px] sm:rounded-2xl">
        <header className="flex shrink-0 items-start gap-2 border-b border-hairline/30 px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-semibold text-ink">{task.title}</h2>
            <p className="mt-0.5 text-[11.5px] text-ink-secondary">
              {t("Project office")}
            </p>
          </div>
          {task.conversationId && task.conversationBotId && (
            <Button size="sm" variant="soft" onClick={() => { onOpenConversation(task.conversationBotId!, task.conversationId!); onClose(); }}>
              {t("Open chat")}
            </Button>
          )}
          <button type="button" aria-label={t("Close")} onClick={onClose} className="ml-1 rounded-full p-1.5 text-ink-secondary hover:bg-raised-hover">
            <X size={15} />
          </button>
        </header>
        <div className="shrink-0 px-4 pt-2">
          <div
            className={cn(
              "rounded-lg px-3 py-1.5 text-[12.5px] font-semibold",
              conclusion.tone === "danger" && "bg-danger/[0.09] text-danger",
              conclusion.tone === "warning" && "bg-warning/[0.12] text-warning",
              conclusion.tone === "ok" && "bg-select/[0.08] text-accent-text",
            )}
          >
            {conclusion.text}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(20px,env(safe-area-inset-bottom))] pt-3">
          {error && <div className="mb-2 rounded-lg bg-danger/[0.08] px-3 py-2 text-[12px] text-danger">{error}</div>}
          {!office && <p className="py-8 text-center text-[12.5px] text-ink-secondary">{t("Loading the project office…")}</p>}
          {office && (
            <>
              <section className="mb-3">
                <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-ink">
                  <Lock size={13} className="text-warning" /> {t("Waiting for your decision")} · {decisions.length}
                </div>
                {decisions.length === 0 ? <p className="text-[11.5px] text-ink-secondary">{t("Nothing is waiting for you in this project.")}</p> : decisions.map((decision) => (
                  <div key={decision.id} className="mb-1 rounded-xl bg-raised px-3 py-2">
                    <b className="block truncate text-[12.5px] text-ink">{decision.title}</b>
                    <p className="mt-0.5 text-[11.5px] text-ink-secondary">{decision.reason}</p>
                    {rejecting === decision.id ? (
                      <div className="mt-1.5 flex flex-col gap-1.5">
                        <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder={t("What is wrong? One sentence is enough.")} className="min-h-[56px] w-full rounded-lg bg-card px-2.5 py-1.5 text-[12px] text-ink shadow-[inset_0_0_0_1px_var(--color-hairline)] outline-none" />
                        <div className="flex gap-1.5">
                          <Button size="sm" disabled={!note.trim() || busy !== null} onClick={() => void act(decision.id, "reject")}>{t("Not good — fix it")}</Button>
                          <Button size="sm" variant="soft" onClick={() => { setRejecting(null); setNote(""); }}>{t("Cancel")}</Button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-1.5 flex gap-1.5">
                        <Button size="sm" disabled={busy !== null} onClick={() => void act(decision.id, "approve")} className="gap-1"><CheckCircle2 size={12} /> {t("Approve, go on")}</Button>
                        <Button size="sm" variant="soft" disabled={busy !== null} onClick={() => { setRejecting(decision.id); setNote(""); }}>{t("Not good — fix it")}</Button>
                      </div>
                    )}
                  </div>
                ))}
              </section>

              <section className="mb-3">
                <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-ink">
                  <ArrowLeftRight size={13} className="text-ink-secondary" /> {t("Who is blocked by whom right now")}
                </div>
                {waiting.length === 0 ? <p className="text-[11.5px] text-ink-secondary">{t("Nobody is waiting on anybody.")}</p> : (
                  <ul className="space-y-1">
                    {waiting.slice(0, 5).map((entry, index) => (
                      <li key={`${entry.from.name}-${index}`} className="flex items-center gap-1.5 rounded-lg bg-raised px-2.5 py-1.5 text-[11.5px] text-ink-secondary">
                        <Clock3 size={11} className={cn(entry.minutes >= 15 ? "text-danger" : "text-ink-secondary/70")} />
                        <span className="min-w-0 flex-1 truncate">{entry.item} 等 {entry.to.name}</span>
                        <span className={cn("shrink-0", entry.minutes >= 15 && "text-danger")}>{minutesLabel(entry.minutes)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="mb-3">
                <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-ink">
                  <Users size={13} className="text-ink-secondary" /> {t("The team")}
                </div>
                {departments.length === 0 ? <p className="text-[11.5px] text-ink-secondary">{t("No members are working in this project yet.")}</p> : departments.map((department) => (
                  <div key={department.name} className="mb-1.5">
                    <div className="mb-0.5 text-[11px] font-semibold text-ink-secondary/80">{department.name}</div>
                    <div className="flex flex-wrap gap-1">
                      {department.members.map((member) => (
                        <span key={member.botId} className="inline-flex items-center gap-1 rounded-full bg-raised px-2 py-0.5 text-[11px] text-ink">
                          <span className={cn("size-1.5 rounded-full", PRESENCE[member.presence].color)} />
                          {member.name}
                          <span className="text-ink-secondary/70">{PRESENCE[member.presence].label}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </section>

              {anomalies.length > 0 && (
                <section>
                  <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-warning">
                    <AlertTriangle size={13} /> {t("Needs a look")} · {anomalies.length}
                  </div>
                  <ul className="space-y-1">
                    {anomalies.slice(0, 4).map((anomaly) => (
                      <li key={anomaly.subtaskId} className="rounded-lg bg-warning/[0.08] px-2.5 py-1.5 text-[11.5px] text-ink-secondary">
                        <b className="text-ink">{anomaly.title}</b> · {anomaly.detail}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {office.activity.length > 0 && (
                <p className="mt-3 truncate text-[11px] text-ink-secondary/70">
                  {t("Latest: {summary}", { summary: `${office.activity[0]!.actor} · ${office.activity[0]!.summary}` })}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
