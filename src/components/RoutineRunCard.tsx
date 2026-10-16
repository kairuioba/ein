// A routine run as a result card (design U8): the routine's name, a status
// pill, one line about what happened, and the ways in — the isolated run
// itself and the routine's settings panel.
import { cn } from "@/lib/cn";
import { msg, t } from "@/lib/i18n";
import type { RoutineRunCardData } from "../../shared/routine-run";
import type { Message } from "@/state/store";
import { CardButton, ChatCard, SOFT, StatusPill, type StatusTone } from "./chat/primitives";

const DETAIL_LIMIT = 280;

const COPY = {
  queued: { label: msg("Queued"), tone: "grey" },
  running: { label: msg("In progress"), tone: "blue" },
  waiting: { label: msg("Needs your input"), tone: "amber" },
  completed: { label: msg("Completed"), tone: "green" },
  failed: { label: msg("Failed"), tone: "red" },
  cancelled: { label: msg("Cancelled"), tone: "grey" },
  missed: { label: msg("Missed"), tone: "red" },
} satisfies Record<RoutineRunCardData["status"], { label: string; tone: StatusTone }>;

function compactDetail(value: string | undefined): string {
  const clean = value?.replace(/\s+/g, " ").trim() ?? "";
  return clean.length > DETAIL_LIMIT ? `${clean.slice(0, DETAIL_LIMIT - 1).trimEnd()}…` : clean;
}

/** A lifecycle receipt can outlive its isolated execution task. Only offer
 * navigation while the task is still present in the owning bot's task list. */
export function hasRoutineExecutionTask(
  tasks: ReadonlyArray<{ threadId: string }> | undefined,
  executionThreadId: string | undefined,
): executionThreadId is string {
  return Boolean(
    executionThreadId && tasks?.some((task) => task.threadId === executionThreadId),
  );
}

export function RoutineRunCard({
  message,
  onOpen,
  onOpenRoutine,
}: {
  message: Message;
  /** Opens the isolated execution task; absent when it no longer exists. */
  onOpen?: () => void;
  /** Opens the routine's panel (name, instructions, times, history). */
  onOpenRoutine?: (routineId: string) => void;
}) {
  const run = message.routineRun;
  // Newer computers can send this message kind to an older or partially
  // hydrated client. Keep the concise text fallback visible instead of
  // leaving an unexplained hole in the conversation.
  if (!run) {
    const fallback = compactDetail(message.text);
    return fallback ? (
      <div className={cn("w-fit min-w-0 max-w-[560px] rounded-2xl rounded-tl-md px-[13px] py-[9px] text-[13.5px] leading-[1.6] text-ink", SOFT)}>
        {fallback}
      </div>
    ) : null;
  }

  const copy = COPY[run.status];
  const detail = compactDetail(
    run.status === "failed" || run.status === "missed"
      ? (run.error ?? run.summary)
      : (run.summary ?? run.error),
  );
  const actionLabel = run.status === "waiting" ? t("Review") : t("Open run");
  const canOpen = Boolean(onOpen && run.executionThreadId);

  return (
    <ChatCard
      label={t("{name} routine run: {status}", { name: run.routineName, status: t(copy.label) })}
      title={run.routineName}
      pill={
        <StatusPill tone={copy.tone}>{t(copy.label)}</StatusPill>
      }
      live
      meta={
        detail ? (
          <span className={cn("line-clamp-2", (run.status === "failed" || run.status === "missed") && "text-danger")}>{detail}</span>
        ) : (
          <span>{t("Routine run")}</span>
        )
      }
      actions={
        canOpen || onOpenRoutine ? (
          <>
            {canOpen && (
              <CardButton onClick={onOpen} aria-label={t("{action} for {name}", { action: actionLabel, name: run.routineName })}>
                {run.status === "waiting" ? t("Review") : t("Open")}
              </CardButton>
            )}
            {onOpenRoutine && (
              <CardButton variant="grey" onClick={() => onOpenRoutine(run.routineId)}>
                {t("Scheduled task")}
              </CardButton>
            )}
          </>
        ) : undefined
      }
    />
  );
}
