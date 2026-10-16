// 会议纪要 — the minutes of a group chat, assembled from the room itself: the
// agenda (bulletin), when it ran, who was there, the sources it leaned on
// (numbered like the chips in the transcript), its decisions and the action
// items they dispatched. Numbers jump back to the message that cited them.
import { useState, type ReactNode } from "react";
import { Download, Folder, Loader2, PanelRightClose } from "lucide-react";

import type { OrgDecision } from "../../../shared/org-types";

import { SidePanel } from "@/components/ui";
import { publishLibraryDoc } from "@/state/org-api";
import { formatTime, useStore, type Bot, type Group } from "@/state/store";
import { t } from "@/lib/i18n";
import { decisionHeadline, minutesDocName } from "@/lib/group-meeting";
import { backedOption, basisNumbers, supersededBy, type CitedSource } from "@/lib/group-sources";
import { CiteNumber, DecisionMark, ITEM_STATUS_LONG, ItemStatusText, MemberAvatar, decidedByLabel, shortDay, sourceDetail } from "./parts";
import type { Meeting } from "./useMeeting";

/** "价格对齐会 · 今天 16:12 – 16:24 · 用时 12 分钟" */
export function minutesMeta(group: Group, meeting: Meeting): string {
  const timing = meeting.timing;
  if (!timing) return group.name;
  const range = `${shortDay(timing.start)} ${formatTime(timing.start)} – ${formatTime(timing.end)}`;
  // a meeting has a length worth stating; a standing project room does not
  return [group.name, range, ...(meeting.isMeeting ? [t("took {count} min", { count: timing.durationMin })] : [])].join(" · ");
}

/** "价格对齐会 10-15": the room and the day the meeting started. */
function filedName(group: Group, meeting: Meeting): string {
  const day = new Date(meeting.timing?.start ?? Date.now());
  const mmdd = `${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  return `${group.name} ${mmdd}`;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-[5px]">
      <h3 className="text-[12px] font-semibold text-ink-secondary/85">{label}</h3>
      {children}
    </section>
  );
}

const softLine = { boxShadow: "inset 0 0 0 1px color-mix(in oklab, var(--color-hairline) 45%, transparent)" };

function Participant({ bot, role }: { bot: Bot; role?: string }) {
  return (
    <span className="inline-flex h-[26px] items-center gap-0.5 rounded-full bg-control/50 pr-[9px] pl-0.5 text-[12.5px] whitespace-nowrap">
      <span className="grid size-[22px] place-items-center">
        <MemberAvatar bot={bot} size={16} />
      </span>
      <b className="font-semibold text-ink">{bot.name}</b>
      {role && <em className="ml-1 text-[11.5px] text-ink-secondary/85 not-italic">{role}</em>}
    </span>
  );
}

function SourceRow({ source, meeting, onJump }: { source: CitedSource; meeting: Meeting; onJump: () => void }) {
  const newer = supersededBy(source, meeting.docs);
  const value = backedOption(source.text, meeting.options);
  const sub = [sourceDetail(source), source.name].filter(Boolean).join(" · ");
  return (
    <button type="button" onClick={onJump} className="flex w-full items-center gap-[9px] border-b border-hairline/25 py-[9px] text-left last:border-b-0" title={t("Jump to the message that cited it")}>
      <CiteNumber n={source.n} />
      <span className="flex min-w-0 flex-1 flex-col gap-px leading-[1.35]">
        <span className="flex min-w-0 items-center">
          <b className="truncate text-[13px] font-semibold text-ink">{source.title}</b>
          {newer !== undefined && (
            <span className="ml-1.5 inline-block h-[18px] shrink-0 rounded-[5px] bg-control/70 px-1.5 text-[11px] leading-[18px] font-semibold text-ink-secondary">
              {t("Replaced by v{version}", { version: newer })}
            </span>
          )}
        </span>
        {sub && <span className="truncate text-[11.5px] text-ink-secondary/85">{sub}</span>}
      </span>
      {value && <span className="shrink-0 text-[14px] font-bold text-ink tabular-nums">{value}</span>}
    </button>
  );
}

function DecisionRow({ decision, meeting, onJumpSource }: { decision: OrgDecision; meeting: Meeting; onJumpSource: (n: number) => void }) {
  const { state } = useStore();
  const basis = basisNumbers(decision.basis, meeting.sources.list).filter((entry) => entry.n !== undefined);
  return (
    <div className="flex items-center gap-2.5 rounded-xl bg-raised px-3 py-2.5" style={{ boxShadow: "inset 0 0 0 1.5px var(--color-ink)" }}>
      <DecisionMark />
      <span className="flex min-w-0 flex-1 flex-col gap-px leading-[1.35]">
        <b className="truncate text-[13.5px] font-semibold text-ink">{t("Decision #{id}: {title}", { id: decision.id, title: decisionHeadline(decision) })}</b>
        <span className="flex flex-wrap items-center gap-x-1 text-[11.5px] text-ink-secondary/85">
          {decidedByLabel(decision, state.bots, meeting.chiefId)}
          {basis.length > 0 && (
            <>
              <span>· {t("based on")}</span>
              {basis.map((entry) => (
                <CiteNumber key={entry.n} n={entry.n!} onJump={() => onJumpSource(entry.n!)} />
              ))}
            </>
          )}
        </span>
      </span>
    </div>
  );
}

/** Markdown of the minutes, for the download button. */
export function minutesMarkdown(group: Group, meeting: Meeting, bots: readonly Bot[]): string {
  const lines = [`# ${t("Meeting minutes")} · ${group.name}`, "", minutesMeta(group, meeting), ""];
  if (meeting.agenda?.topic) lines.push(`## ${t("Topic")}`, "", meeting.agenda.topic, "");
  if (meeting.sources.list.length) {
    lines.push(`## ${t("Key sources")}`, "");
    for (const source of meeting.sources.list) {
      const value = backedOption(source.text, meeting.options);
      lines.push(`${source.n}. ${source.label}${source.name ? ` — ${source.name}` : ""}${value ? ` (${value})` : ""}`);
    }
    lines.push("");
  }
  for (const decision of meeting.decisions) {
    lines.push(`## ${t("Decision #{id}: {title}", { id: decision.id, title: decisionHeadline(decision) })}`, "");
    lines.push(decidedByLabel(decision, bots, meeting.chiefId), "");
    for (const item of decision.actionItems) {
      const owner = bots.find((bot) => bot.id === item.botId)?.name ?? t("Unassigned");
      lines.push(`- [${item.status === "done" ? "x" : " "}] ${item.title} — ${owner} · ${t(ITEM_STATUS_LONG[item.status])}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function download(name: string, text: string) {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name.replace(/[\\/:*?"<>|]+/g, " ").trim() || "minutes"}.md`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function MinutesPanel({
  group,
  members,
  meeting,
  onClose,
  onJump,
  onOpenLibrary,
}: {
  group: Group;
  members: Bot[];
  meeting: Meeting;
  onClose: () => void;
  onJump: (messageId: string) => void;
  onOpenLibrary: () => void;
}) {
  const { state } = useStore();
  const jumpToSource = (n: number) => {
    const source = meeting.sources.list.find((entry) => entry.n === n);
    if (source) onJump(source.messageId);
  };
  const items = meeting.decisions.flatMap((decision) => decision.actionItems.map((item) => ({ item, decision })));
  const decisionIds = meeting.decisions.map((decision) => `#${decision.id}`).join(" ");
  const chairName = meeting.chair?.name ?? t("The chief");
  const empty = !meeting.timing && !meeting.agenda;

  return (
    <SidePanel
      title={t("Meeting minutes")}
      label={t("Meeting minutes")}
      width={330}
      actions={
        <>
          <button
            type="button"
            onClick={() => download(`${t("Meeting minutes")} ${group.name}`, minutesMarkdown(group, meeting, state.bots))}
            aria-label={t("Download minutes")}
            title={t("Download minutes")}
            className="grid size-8 place-items-center rounded-lg text-ink-secondary hover:bg-raised-hover hover:text-ink"
          >
            <Download size={16} />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("Hide minutes")}
            title={t("Hide minutes")}
            className="grid size-8 place-items-center rounded-lg text-ink-secondary hover:bg-raised-hover hover:text-ink"
          >
            <PanelRightClose size={16} />
          </button>
        </>
      }
    >
      <div className="flex min-h-full flex-col gap-3.5">
        <div className="-mt-1 truncate text-[12px] text-ink-secondary/85">{minutesMeta(group, meeting)}</div>

        {empty ? (
          <div className="py-8 text-center text-[13px] leading-relaxed text-ink-secondary">
            {t("Minutes fill in as the room talks: add a topic to the bulletin and the decisions and action items collect here.")}
          </div>
        ) : null}

        {meeting.agenda && (
          <Field label={meeting.agenda.topic ? t("Topic") : t("Bulletin")}>
            <div className="text-[14px] leading-snug font-semibold text-ink">{meeting.agenda.topic ?? meeting.agenda.raw}</div>
          </Field>
        )}

        <Field label={t("Attendees")}>
          <div className="flex flex-wrap gap-1.5">
            {members.map((member) => (
              <Participant key={member.id} bot={member} role={member.id === meeting.chair?.id ? t("Chair") : undefined} />
            ))}
            {(meeting.ownerSpoke || meeting.ownerDecided) && (
              <span className="inline-flex h-[26px] items-center gap-0.5 rounded-full bg-control/50 pr-[9px] pl-0.5 text-[12.5px] whitespace-nowrap">
                <span className="mx-0.5 grid size-[18px] place-items-center rounded-full bg-select/10 text-[10.5px] font-bold text-accent-text">{t("You")}</span>
                <b className="font-semibold text-ink">{t("You")}</b>
                {meeting.ownerDecided && <em className="ml-1 text-[11.5px] text-ink-secondary/85 not-italic">{t("Decider")}</em>}
              </span>
            )}
          </div>
        </Field>

        {meeting.sources.list.length > 0 && (
          <Field label={t("Key sources")}>
            <div className="flex flex-col rounded-xl px-3" style={softLine}>
              {meeting.sources.list.map((source) => (
                <SourceRow key={source.n} source={source} meeting={meeting} onJump={() => onJump(source.messageId)} />
              ))}
            </div>
          </Field>
        )}

        {meeting.decisions.length > 0 && (
          <Field label={t("Decisions")}>
            <div className="flex flex-col gap-2">
              {meeting.decisions.map((decision) => (
                <DecisionRow key={decision.id} decision={decision} meeting={meeting} onJumpSource={jumpToSource} />
              ))}
            </div>
          </Field>
        )}

        {items.length > 0 && (
          <Field label={t("Action items · now tasks tagged “from decision {ids}”", { ids: decisionIds })}>
            <div className="flex flex-col rounded-xl px-3" style={softLine}>
              {items.map(({ item, decision }, index) => {
                const owner = state.bots.find((bot) => bot.id === item.botId);
                return (
                  <div key={`${decision.id}:${index}`} className="flex items-center gap-[9px] border-b border-hairline/25 py-[9px] last:border-b-0">
                    {owner ? <MemberAvatar bot={owner} size={18} /> : <span className="size-[18px] shrink-0 rounded-md bg-control" />}
                    <span className="flex min-w-0 flex-1 flex-col gap-px leading-[1.35]">
                      <b className="truncate text-[13px] font-semibold text-ink">{item.title}</b>
                      <span className="truncate text-[11.5px] text-ink-secondary/85">
                        {owner?.name ?? t("Unassigned")}
                        {meeting.decisions.length > 1 ? ` · ${t("Decision #{id}", { id: decision.id })}` : ""}
                      </span>
                    </span>
                    <ItemStatusText status={item.status} />
                  </div>
                );
              })}
            </div>
          </Field>
        )}

        <div className="mt-auto flex flex-col gap-2.5 pt-2">
          <div className="text-[11.5px] text-ink-secondary/70">
            {meeting.minutesDoc
              ? t("{name} keeps these minutes · numbers jump back to the message · you can edit the filed copy", { name: chairName })
              : t("{name} keeps these minutes · numbers jump back to the message", { name: chairName })}
          </div>
          {meeting.minutesDoc ? (
            <div className="flex h-9 items-center gap-[7px] rounded-[10px] bg-inset px-3 text-[12px] text-ink-secondary">
              <Folder size={14} className="shrink-0 opacity-70" aria-hidden />
              <span className="min-w-0 flex-1 truncate">
                {[t("Library"), t("Meeting minutes"), minutesDocName(meeting.minutesDoc.title)].join(" › ")}
              </span>
              <button type="button" onClick={onOpenLibrary} className="shrink-0 font-semibold text-accent-text hover:underline">
                {t("Open")}
              </button>
            </div>
          ) : (
            meeting.timing && <FileMinutes group={group} meeting={meeting} bots={state.bots} />
          )}
        </div>
      </div>
    </SidePanel>
  );
}

/** No filed copy yet: put these minutes in the library (company-wide, linked
 * to the room's latest decision) so the room can say "纪要已存到资料库". */
function FileMinutes({ group, meeting, bots }: { group: Group; meeting: Meeting; bots: readonly Bot[] }) {
  const [state, setState] = useState<"idle" | "saving" | "failed">("idle");
  const [error, setError] = useState("");
  const file = async () => {
    setState("saving");
    setError("");
    const latest = meeting.decisions.at(-1);
    // summary and decisionId are accepted by POST /api/library (A1); the
    // client helper's input type predates them
    const input: Parameters<typeof publishLibraryDoc>[0] & { summary?: string; decisionId?: number } = {
      title: `${t("Meeting minutes")} · ${filedName(group, meeting)}`,
      section: null,
      text: minutesMarkdown(group, meeting, bots),
      note: t("Filed from the {name} group chat", { name: group.name }),
      ...(meeting.agenda ? { summary: meeting.agenda.topic ?? meeting.agenda.raw } : {}),
      ...(latest ? { decisionId: latest.id } : {}),
    };
    try {
      await publishLibraryDoc(input);
      setState("idle");
    } catch (cause) {
      setState("failed");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex h-9 items-center gap-[7px] rounded-[10px] bg-inset px-3 text-[12px] text-ink-secondary">
        <Folder size={14} className="shrink-0 opacity-70" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{t("Not in the library yet")}</span>
        <button type="button" onClick={() => void file()} disabled={state === "saving"} className="flex shrink-0 items-center gap-1 font-semibold text-accent-text hover:underline disabled:opacity-60">
          {state === "saving" && <Loader2 size={12} className="animate-spin" aria-hidden />}
          {t("File in the library")}
        </button>
      </div>
      {state === "failed" && <div className="px-1 text-[11.5px] text-danger">{error || t("Couldn't file the minutes")}</div>}
    </div>
  );
}
