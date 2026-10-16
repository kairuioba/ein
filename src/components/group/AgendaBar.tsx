// The room's bulletin pinned under the header. A meeting bulletin reads as an
// agenda — 议题 · 主持 · 时限 with the time range on the right ("16:12 – 16:24
// · 提前 3 分钟结束"); any other bulletin shows its first line. Click to edit:
// every bot in the room follows it.
import { Fragment, useEffect, useState } from "react";
import { Clock, Pin } from "lucide-react";

import { formatTime } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Agenda, MeetingState, MeetingTiming } from "@/lib/group-meeting";

export function timingNote(state: MeetingState, timing: MeetingTiming | null): string | null {
  if (!timing) return null;
  const range = `${formatTime(timing.start)} – ${formatTime(timing.end)}`;
  if (state === "ended") {
    if (timing.earlyMin) return `${range} · ${t("ended {count} min early", { count: timing.earlyMin })}`;
    if (timing.overMin) return `${range} · ${t("ran {count} min over", { count: timing.overMin })}`;
    return range;
  }
  if (state === "idle") return null;
  const started = t("started {time}", { time: formatTime(timing.start) });
  if (timing.leftMin !== undefined) return `${started} · ${t("{count} min left", { count: timing.leftMin })}`;
  if (timing.overMin) return `${started} · ${t("{count} min over time", { count: timing.overMin })}`;
  return started;
}

/** "议题：" for a Chinese key, "Topic: " for a Latin one. */
const keyLabel = (key: string) => (/[\u3400-\u9fff]/.test(key) ? `${key}：` : `${key}: `);

export function AgendaBar({
  bulletin,
  agenda,
  state,
  timing,
  onSave,
}: {
  bulletin: string;
  agenda: Agenda | null;
  state: MeetingState;
  timing: MeetingTiming | null;
  onSave: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(bulletin);
  useEffect(() => setDraft(bulletin), [bulletin]);

  const save = () => {
    setEditing(false);
    if (draft !== bulletin) onSave(draft);
  };

  if (editing) {
    return (
      <div className="rounded-xl bg-inset p-2" style={{ boxShadow: "inset 0 0 0 1px color-mix(in oklab, var(--color-hairline) 30%, transparent)" }}>
        <textarea
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) save();
            if (event.key === "Escape") {
              setDraft(bulletin);
              setEditing(false);
            }
          }}
          placeholder={t("Topic: … · Host: … · Time limit 15 min — or any instructions every bot here follows")}
          rows={4}
          className="w-full resize-none bg-transparent px-1 text-[13px] leading-relaxed text-ink placeholder:text-ink-secondary/70 focus:outline-none"
        />
      </div>
    );
  }

  const note = agenda?.topic ? timingNote(state, timing) : null;
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title={t("Channel bulletin — shared instructions for every bot here. Click to edit.")}
      className="flex h-9 w-full items-center gap-2 rounded-xl bg-inset pr-3.5 pl-3 text-left text-[13px] whitespace-nowrap text-ink-secondary hover:bg-raised-hover"
      style={{ boxShadow: "inset 0 0 0 1px color-mix(in oklab, var(--color-hairline) 30%, transparent)" }}
    >
      <Pin size={14} className="shrink-0 opacity-70" aria-hidden />
      {agenda ? (
        <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          {agenda.parts.map((part, index) => (
            <Fragment key={index}>
              {index > 0 && <span className="shrink-0 text-ink-secondary/50">·</span>}
              <span className={cn("truncate", index === 0 ? "min-w-0 shrink" : "shrink-0")}>
                {part.key ? (
                  part.topic ? (
                    <b className="font-semibold text-ink">{keyLabel(part.key)}</b>
                  ) : (
                    keyLabel(part.key)
                  )
                ) : null}
                {part.value}
              </span>
            </Fragment>
          ))}
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate text-ink-secondary/70">{t("Add a topic or instructions for this room…")}</span>
      )}
      {note && (
        <span className="ml-auto flex shrink-0 items-center gap-[5px] pl-2 text-[12px] text-ink-secondary/65">
          <Clock size={13} aria-hidden />
          {note}
        </span>
      )}
    </button>
  );
}
