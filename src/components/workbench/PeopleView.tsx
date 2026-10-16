// 看人 (U10): every bot is a pixel figure standing in its department's room;
// the pose is the status. The 主 Bot stands on top with its crown and says
// what it is watching; "指派" lines run from it to each room. Around the
// floor: what the poses mean, what changed since you last looked, today's
// numbers and spend, the library, the meeting rooms, and today's timeline.
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Check, ChevronRight, Clock, FileText, Folder, Lock, RotateCw, Users, X, Zap } from "lucide-react";

import { Mascot, NameTag, BotTile } from "@/components/mascot/Mascot";
import { cn } from "@/lib/cn";
import { msg, t } from "@/lib/i18n";
import { squadName } from "@/lib/org";
import {
  FLOOR,
  ago,
  clip,
  clock,
  headcount,
  layoutFloor,
  poseOf,
  type DeptStats,
  type FloorPlan,
  type FloorRoomBox,
  type PersonState,
  type PersonStatus,
} from "@/lib/workbench";
import { markSeen } from "@/state/org-api";
import type { LibraryDoc, OrgEvent } from "../../../shared/org-types";

import { DayTimeline, markColor, type TimelineMark } from "./DayTimeline";
import type { BotWithMeta, Room, WorkbenchModel } from "./model";
import { Badge, Crown, DecisionMark, DiamondMark, HealthDot, NewTag, useElementSize } from "./parts";

const TONE_TEXT: Record<PersonState["tone"], string> = {
  blue: "text-accent-text",
  amber: "text-warning",
  red: "text-danger",
  green: "text-success",
  grey: "text-ink-secondary font-medium",
};

export function PeopleView({
  model,
  marks,
  onOpenChat,
  onOpenGroup,
  onOpenLibrary,
}: {
  model: WorkbenchModel;
  marks: TimelineMark[];
  onOpenChat: (botId: string) => void;
  onOpenGroup: (groupId: string) => void;
  onOpenLibrary: () => void;
}) {
  const [hostRef, { width: hostWidth }] = useElementSize<HTMLDivElement>();
  const [replayNonce, setReplayNonce] = useState(0);
  const width = Math.max(720, hostWidth);
  const plan = useMemo(
    () =>
      layoutFloor(
        model.rooms.map((room) => ({ key: room.key, groups: [room.main.length, ...room.squads.map((squad) => squad.length)].filter((count, index) => count > 0 || index === 0), isolated: room.isolated })),
        width,
      ),
    [model.rooms, width],
  );
  const showLegend = width >= 1180;
  const showSince = width >= 980;
  const todayX = width - FLOOR.right - 300;
  const sinceX = todayX - 14 - 270;
  const leftEdge = showLegend ? FLOOR.left + 296 : FLOOR.left;
  const chiefX = Math.round((leftEdge + (showSince ? sinceX : todayX)) / 2);
  const timelineTop = plan.bottom + FLOOR.gap;
  const height = timelineTop + FLOOR.timelineHeight + 18;
  const rooms = new Map(model.rooms.map((room) => [room.key, room]));

  return (
    <div ref={hostRef} className="wb-grid relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto bg-inset/60" style={{ backgroundSize: "22px 22px" }}>
      {hostWidth > 0 && (
        <div className="relative" style={{ width, height }}>
          <AssignLines plan={plan} chiefX={chiefX} hasChief={Boolean(model.chief)} rooms={rooms} />
          {showLegend && <LegendCard />}
          {model.chief ? (
            <ChiefFigure model={model} cx={chiefX} onOpen={() => model.chief && onOpenChat(model.chief.id)} />
          ) : (
            <NoChief cx={chiefX} />
          )}
          {showSince && <SinceCard model={model} x={sinceX} onReplay={() => setReplayNonce((n) => n + 1)} />}
          <TodayCard model={model} x={todayX} />
          {plan.rooms.map((box) => {
            const room = rooms.get(box.key);
            return room ? <RoomFloor key={box.key} box={box} room={room} model={model} stats={model.stats.get(room.section)} onOpenChat={onOpenChat} /> : null;
          })}
          {plan.side && (
            <SideColumn model={model} box={plan.side} onOpenGroup={onOpenGroup} onOpenLibrary={onOpenLibrary} />
          )}
          <DayTimeline
            marks={marks}
            now={model.now}
            replayNonce={replayNonce}
            className="absolute z-[1]"
            style={{ left: FLOOR.left, top: timelineTop, width: width - FLOOR.left - FLOOR.right }}
          />
        </div>
      )}
    </div>
  );
}

// ── the 指派 lines: the only always-on lines ───────────────────────────────
function AssignLines({ plan, chiefX, hasChief, rooms }: { plan: FloorPlan; chiefX: number; hasChief: boolean; rooms: Map<string, Room> }) {
  if (!hasChief || !plan.rooms.length) return null;
  const busY = FLOOR.roomsTop - 14;
  const rail = 20;
  const assigned = plan.rooms.filter((box) => !rooms.get(box.key)?.unassigned);
  const first = assigned.filter((box) => box.row === 0);
  const later = assigned.filter((box) => box.row > 0);
  const centre = (box: FloorRoomBox) => box.x + box.width / 2;
  const solid = first.filter((box) => !box.isolated);
  const right = Math.max(chiefX, ...solid.map(centre));
  const paths: string[] = [`M${chiefX} 172V${busY}`, `M${right} ${busY}H${rail + 10}`];
  // later rows hang off a rail down the left edge: the first room of a row is
  // entered from its side (mid-height), the others from a short bus above them
  const entry = (box: FloorRoomBox) => (box.x <= FLOOR.left + 1 ? box.y + Math.min(box.height, FLOOR.roomHeight) / 2 : box.y - 7);
  const lowest = later.length ? Math.max(...later.map(entry)) : null;
  if (lowest !== null) paths.push(`M${rail + 10} ${busY}Q${rail} ${busY} ${rail} ${busY + 10}V${lowest - 10}Q${rail} ${lowest} ${rail + 10} ${lowest}`);
  for (const box of solid) paths.push(`M${centre(box)} ${busY}V${box.y}`);
  for (const box of later.filter((candidate) => !candidate.isolated)) {
    const y = entry(box);
    paths.push(box.x <= FLOOR.left + 1 ? `M${rail} ${y}H${box.x}` : `M${rail} ${y}H${centre(box)}V${box.y}`);
  }
  const dashed = assigned.filter((box) => box.isolated).map((box) => (box.row === 0 ? `M${right} ${busY}H${centre(box) - 10}Q${centre(box)} ${busY} ${centre(box)} ${busY + 10}V${box.y}` : box.x <= FLOOR.left + 1 ? `M${rail} ${entry(box)}H${box.x}` : `M${rail} ${box.y - 7}H${centre(box)}V${box.y}`));
  return (
    <svg className="pointer-events-none absolute top-0 left-0 overflow-visible" width="1" height="1" aria-hidden>
      <g fill="none" strokeWidth="1.6" className="stroke-ink-secondary/35">
        {paths.map((d, index) => (
          <path key={index} d={d} />
        ))}
        {dashed.map((d, index) => (
          <path key={`d${index}`} d={d} strokeDasharray="3 3" />
        ))}
      </g>
      {[...solid.map(centre), chiefX].map((x, index) => (
        <circle key={index} cx={x} cy={busY} r="3" className="fill-ink-secondary/45" />
      ))}
      <text x={chiefX + 8} y={busY - 12} fontSize="10.5" className="fill-ink-secondary/70">
        {t("Assigns")}
      </text>
    </svg>
  );
}

// ── the top band ─────────────────────────────────────────────────────────────
const card = "absolute rounded-[14px] bg-raised px-3.5 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent),0_1px_2px_rgb(16_24_40/0.05)]";

function CardHead({ title, aside, icon }: { title: ReactNode; aside?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex h-[38px] items-center gap-1.5 text-[12px] whitespace-nowrap text-ink-secondary">
      <b className="inline-flex items-center gap-1.5 text-[13px] text-ink">
        {icon}
        {title}
      </b>
      {aside !== undefined && <span className="ml-auto inline-flex items-center gap-1.5">{aside}</span>}
    </div>
  );
}

const LEGEND: Array<{ status: PersonStatus; label: string; tone: PersonState["tone"] }> = [
  { status: "working", label: msg("Busy working"), tone: "blue" },
  { status: "waiting", label: msg("Waiting on you"), tone: "amber" },
  { status: "failed", label: msg("Stuck · failed"), tone: "red" },
  { status: "disagree", label: msg("Disagreement"), tone: "red" },
  { status: "delivered", label: msg("Just delivered"), tone: "green" },
  { status: "idle", label: msg("Idle · queued"), tone: "grey" },
];

function LegendCard() {
  return (
    <section className={card} style={{ left: FLOOR.left, top: FLOOR.bandTop, width: 296, height: FLOOR.bandHeight }} aria-label={t("What the poses mean")}>
      <CardHead title={t("The pose is the status")} aside={t("No need to open anything")} />
      <div className="grid grid-cols-3 gap-y-1.5">
        {LEGEND.map((item) => (
          <span key={item.status} className="flex flex-col items-center gap-px">
            <Mascot kind="pc" pose={poseOf(item.status)} scale={0.5} dim={item.status === "idle"} />
            <em className={cn("text-[11.5px] font-semibold whitespace-nowrap not-italic", TONE_TEXT[item.tone])}>{t(item.label)}</em>
          </span>
        ))}
      </div>
    </section>
  );
}

function ChiefFigure({ model, cx, onOpen }: { model: WorkbenchModel; cx: number; onOpen: () => void }) {
  const chief = model.chief!;
  const state = model.states.get(chief.id);
  const speech = chiefSpeech(chief);
  return (
    <>
      <div className="pointer-events-none absolute rounded-[50%]" style={{ left: cx - 120, top: 0, width: 240, height: 180, background: "radial-gradient(closest-side, color-mix(in srgb, var(--color-select) 11%, transparent), transparent)" }} />
      <Figure
        bot={chief}
        state={state}
        kind={model.mascotOf(chief)}
        driverKind={model.driverOf(chief)}
        lead
        cx={cx}
        top={18}
        onOpen={onOpen}
        crown
      />
      {speech.length > 0 && (
        <div
          className="absolute z-[5] rounded-[10px] px-2.5 py-[5px] text-[11.5px] leading-[1.35] font-semibold whitespace-nowrap text-accent-text shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-select)_30%,transparent),0_6px_14px_-8px_rgb(46_63_176/0.3)]"
          style={{ left: cx + 66, top: 36, background: "color-mix(in srgb, var(--color-select) 7%, var(--color-raised))" }}
        >
          <i
            aria-hidden
            className="absolute top-[13px] -left-[4.5px] size-2 rotate-45"
            style={{ background: "inherit", boxShadow: "inset 1px -1px 0 0 color-mix(in srgb, var(--color-select) 30%, transparent)" }}
          />
          {speech.map((line, index) => (
            <div key={index}>{line}</div>
          ))}
        </div>
      )}
    </>
  );
}

/** What the chief last said, in two short lines. */
function chiefSpeech(chief: BotWithMeta): string[] {
  const latest = [...(chief.messages ?? [])].reverse().find((message) => message.role === "bot" && message.kind === "text" && message.text?.trim());
  if (!latest?.text) return [];
  const plain = latest.text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`[\]]/g, "")
    .replace(/\(https?:[^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(plain);
  if (!chars.length) return [];
  const first = chars.slice(0, 14).join("");
  const rest = chars.slice(14);
  return rest.length ? [first, clip(rest.join(""), 14)] : [first];
}

function NoChief({ cx }: { cx: number }) {
  return (
    <div className="absolute flex w-[260px] -translate-x-1/2 flex-col items-center gap-1 rounded-[14px] border border-dashed border-hairline/70 bg-raised/70 px-4 py-4 text-center" style={{ left: cx, top: 40 }}>
      <b className="text-[13px] text-ink">{t("No main bot yet")}</b>
      <span className="text-[12px] leading-relaxed text-ink-secondary">{t("Make one bot the chief: it splits your requests and assigns them to each department.")}</span>
    </div>
  );
}

const CHANGE_COLOR = (event: OrgEvent) => markColor({ kind: event.kind, severity: event.severity });

function SinceCard({ model, x, onReplay }: { model: WorkbenchModel; x: number; onReplay: () => void }) {
  const [dismissed, setDismissed] = useState(false);
  const changes = [...model.brief.changes].slice(0, 4).reverse();
  const title = model.lastSeen > 0 ? t("Since you last looked at {time}", { time: clock(model.lastSeen) }) : t("What changed today");
  return (
    <section className={card} style={{ left: x, top: FLOOR.bandTop, width: 270, height: FLOOR.bandHeight }} aria-label={title}>
      <CardHead
        icon={<RotateCw size={13} className="text-ink-secondary" />}
        title={title}
        aside={
          !dismissed && changes.length > 0 ? (
            <button
              type="button"
              className="grid size-6 place-items-center rounded-md text-ink-secondary/70 hover:bg-control hover:text-ink"
              aria-label={t("Mark as seen")}
              title={t("Mark as seen")}
              onClick={() => {
                markSeen();
                setDismissed(true);
              }}
            >
              <X size={12} />
            </button>
          ) : undefined
        }
      />
      {dismissed || changes.length === 0 ? (
        <div className="flex h-[110px] flex-col items-center justify-center gap-1 border-t border-hairline/30 text-center text-[12px] leading-relaxed text-ink-secondary">
          {dismissed ? t("All caught up.") : model.briefLoaded ? t("Nothing new since then.") : t("Once the brief is connected, what happened while you were away shows up here.")}
        </div>
      ) : (
        <>
          {changes.map((event) => (
            <div key={event.id} className="flex h-[27px] items-center gap-2 border-t border-hairline/30 text-[12.5px] whitespace-nowrap text-ink">
              {event.kind === "decision" ? <DecisionMark size={9} /> : <i className="size-2 shrink-0 rounded-[2.5px]" style={{ background: CHANGE_COLOR(event) }} />}
              <span className="min-w-0 truncate">{event.title}</span>
              <em className="ml-auto font-mono text-[11px] text-ink-secondary/70 not-italic">{clock(event.at)}</em>
            </div>
          ))}
          <button type="button" onClick={onReplay} className="flex h-[28px] w-full items-center gap-[3px] border-t border-hairline/30 text-[12px] font-semibold text-accent-text hover:underline">
            {t("Replay on the timeline")}
            <ChevronRight size={11} />
          </button>
        </>
      )}
    </section>
  );
}

function TodayCard({ model, x }: { model: WorkbenchModel; x: number }) {
  const counts = headcount(model.states.values());
  const usage = model.usage;
  const pct = usage.budgetPerDay > 0 ? Math.min(100, Math.round((usage.todayCost / usage.budgetPerDay) * 100)) : null;
  const auto = model.brief.autoApproved[0];
  const stats: Array<{ n: number; label: string; className: string }> = [
    { n: counts.working, label: t("At work"), className: "text-accent-text" },
    { n: counts.waiting, label: t("Waiting on you"), className: "text-warning" },
    { n: counts.trouble, label: t("In trouble"), className: "text-danger" },
    { n: counts.idle, label: t("Idle"), className: "text-ink-secondary" },
  ];
  return (
    <section className={card} style={{ left: x, top: FLOOR.bandTop, width: 300, height: FLOOR.bandHeight }} aria-label={t("Today")}>
      <CardHead title={t("Today · {count} bots", { count: model.bots.length })} aside={clock(model.now)} />
      <div className="grid grid-cols-4 gap-1.5">
        {stats.map((stat) => (
          <span key={stat.label} className="flex flex-col items-start rounded-[10px] bg-inset px-2 py-1.5">
            <b className={cn("text-[19px] leading-[1.15] font-bold tabular-nums", stat.className)}>{stat.n}</b>
            <em className="text-[11px] whitespace-nowrap text-ink-secondary not-italic">{stat.label}</em>
          </span>
        ))}
      </div>
      <div className="mt-2.5">
        <div className="flex items-baseline gap-[5px] text-[12px] whitespace-nowrap text-ink-secondary">
          <span>{t("Spend")}</span>
          <b className="text-[14px] text-ink">¥{formatYuan(usage.todayCost)}</b>
          {usage.budgetPerDay > 0 ? <span>{t("/ ¥{budget} budget", { budget: formatYuan(usage.budgetPerDay) })}</span> : <span>{t("· no budget set")}</span>}
          {pct !== null && <span className="ml-auto font-semibold text-ink">{pct}%</span>}
        </div>
        <div className="relative my-1.5 h-1.5 overflow-hidden rounded-full bg-control">
          <i className="absolute inset-y-0 left-0 rounded-full bg-ink" style={{ width: `${pct ?? 0}%` }} />
        </div>
        {auto ? (
          <div className="flex items-center gap-1.5 text-[11.5px] whitespace-nowrap text-ink-secondary">
            <i className="size-2 shrink-0 rounded-[2px] bg-[#8B5CF6]" />
            <span className="truncate">{t("{title} · {rule}, approved by the chief", { title: auto.title, rule: auto.rule })}</span>
          </div>
        ) : usage.unpricedTokens > 0 ? (
          <div className="text-[11.5px] text-ink-secondary">{t("Some engines report tokens without a price")}</div>
        ) : null}
      </div>
    </section>
  );
}

export const formatYuan = (value: number) => (Math.round(value * 10) / 10).toString();

// ── rooms ────────────────────────────────────────────────────────────────────
function RoomFloor({
  box,
  room,
  model,
  stats,
  onOpenChat,
}: {
  box: FloorRoomBox;
  room: Room;
  model: WorkbenchModel;
  stats?: DeptStats;
  onOpenChat: (botId: string) => void;
}) {
  const style = { left: box.x, top: box.y, width: box.width, height: box.height, "--rc": room.color } as CSSProperties;
  const label = room.unassigned ? t("No department") : room.label;
  const count = room.everyone.length;
  const squadText = room.squads.length
    ? ` · ${[room.main.length, ...room.squads.map((squad) => squad.length)].map((n, index) => `${squadName(index)} ${n}`).join(" · ")}`
    : "";
  const figures = [room.main, ...room.squads];
  return (
    <>
      <section
        className={cn(
          "absolute z-[1] rounded-2xl",
          room.isolated
            ? "shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--color-hairline)_80%,transparent),inset_0_0_0_5px_color-mix(in_srgb,var(--color-raised)_55%,transparent),0_1px_2px_rgb(16_24_40/0.05)]"
            : "bg-raised shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent),0_1px_2px_rgb(16_24_40/0.05)]",
        )}
        style={{
          ...style,
          ...(room.isolated ? { background: "linear-gradient(160deg, var(--color-inset), color-mix(in srgb, var(--color-control) 75%, var(--color-inset)))" } : {}),
        }}
        aria-label={label}
      >
        {room.isolated && (
          <i
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-2xl"
            style={{
              background:
                "repeating-linear-gradient(118deg, transparent 0 64px, color-mix(in srgb, var(--color-raised) 60%, transparent) 64px 70px, transparent 70px 92px, color-mix(in srgb, var(--color-raised) 40%, transparent) 92px 95px, transparent 95px 190px)",
            }}
          />
        )}
        {!room.isolated && (
          <i
            aria-hidden
            className="pointer-events-none absolute inset-x-px bottom-px h-[84px] rounded-b-[15px]"
            style={{ background: `linear-gradient(180deg, transparent, color-mix(in srgb, ${room.color} 8%, transparent))` }}
          />
        )}
        <div className="absolute inset-x-0 top-0 z-[2] flex h-[34px] items-center gap-[7px] pr-2.5 pl-3.5 text-[12px] whitespace-nowrap text-ink-secondary">
          <i className="size-[9px] shrink-0 rounded-[3px]" style={{ background: room.color }} />
          <b className="shrink-0 text-[13.5px] text-ink">{label}</b>
          <span className="shrink-0">{room.isolated ? t("Isolated") : t("{count} people", { count })}</span>
          {!room.isolated && squadText && <span className="min-w-0 truncate">{squadText.replace(/^ · /, "· ")}</span>}
          {/* badges past the room's width wrap onto a hidden second line, so
              the lowest-priority ones (last) drop out first */}
          <span className="ml-auto flex h-5 min-w-0 flex-wrap content-start items-center justify-end gap-x-[5px] overflow-hidden [&>*]:shrink-0">
            <RoomBadges room={room} stats={stats} now={model.now} />
          </span>
        </div>
      </section>
      {box.groups.map((group, index) =>
        group.boxed ? (
          <SquadBox key={`sq${index}`} group={group} squad={room.squads[group.squad - 1] ?? []} index={group.squad} model={model} />
        ) : null,
      )}
      {box.groups.map((group) =>
        group.cells.map((cell, i) => {
          const bot = figures[group.squad]?.[group.offset + i];
          if (!bot) return null;
          // a new squad says "新" once on its label, not on every member
          const squadIsNew = group.squad > 0 && (room.squads[group.squad - 1] ?? []).some((member) => model.states.get(member.id)?.isNew);
          return (
            <Figure
              key={bot.id}
              bot={bot}
              state={model.states.get(bot.id)}
              kind={model.mascotOf(bot)}
              driverKind={model.driverOf(bot)}
              lead={bot.id === room.lead?.id}
              cx={cell.x}
              top={cell.y}
              glass={room.isolated}
              hideNew={squadIsNew}
              onOpen={() => onOpenChat(bot.id)}
            />
          );
        }),
      )}
    </>
  );
}

function RoomBadges({ room, stats, now }: { room: Room; stats?: DeptStats; now: number }) {
  if (room.isolated) {
    return (
      <span className="inline-flex h-5 items-center gap-[3px] rounded-[6px] bg-control/80 px-1.5 text-[11px] font-bold text-ink-secondary">
        <Lock size={11} strokeWidth={2.2} />
        {t("Request only")}
      </span>
    );
  }
  if (!stats || (!stats.total && !stats.health)) return null;
  if (stats.total > 0 && stats.done === stats.total) {
    return (
      <>
        <Badge kind="ok" className="h-5 px-2 text-[12px]">{t("{done}/{total} delivered", { done: stats.done, total: stats.total })}</Badge>
        {stats.lastReportAt && <Badge kind="clock">{clock(stats.lastReportAt)}</Badge>}
      </>
    );
  }
  return (
    <>
      {stats.total > 0 && (
        <span className="flex items-center gap-[5px]">
          <span className="text-[11.5px] font-bold text-ink tabular-nums">{stats.done}/{stats.total}</span>
          <span className="mr-0.5 block h-[5px] w-10 overflow-hidden rounded-full bg-control">
            <i className="block h-full rounded-full" style={{ width: `${(stats.done / stats.total) * 100}%`, background: room.color }} />
          </span>
        </span>
      )}
      <HealthDot health={stats.health} size={7} />
      {stats.stuck > 0 && <Badge kind="hand">{stats.stuck}</Badge>}
      {stats.disagree > 0 && <Badge kind="bolt">{stats.disagree}</Badge>}
      {stats.waiting > 0 && (
        <span className="inline-flex h-5 items-center gap-[3px] rounded-[6px] bg-warning/12 px-1.5 text-[11px] font-bold text-warning">
          <DiamondMark size={9} />
          {t("Waiting on you {count}", { count: stats.waiting })}
        </span>
      )}
      {stats.failed > 0 && <Badge kind="fail">{t("{count} failed", { count: stats.failed })}</Badge>}
      {stats.lastReportAt && <Badge kind="clock">{ago(stats.lastReportAt, now)}</Badge>}
    </>
  );
}

function SquadBox({ group, squad, index, model }: { group: FloorPlan["rooms"][number]["groups"][number]; squad: BotWithMeta[]; index: number; model: WorkbenchModel }) {
  const fresh = squad.some((bot) => model.states.get(bot.id)?.isNew);
  const joined = Math.min(...squad.map((bot) => bot.createdAt ?? Infinity));
  return (
    <div
      className={cn("absolute z-[1] rounded-[13px] border-[1.5px] border-dashed", fresh ? "border-[#8B5CF6]/55 bg-[#8B5CF6]/[0.035]" : "border-hairline/70 bg-inset/40")}
      style={{ left: group.x, top: group.y, width: group.width, height: group.height }}
    >
      <div className="absolute top-[7px] left-2.5 flex items-center gap-[7px] text-[11.5px] whitespace-nowrap text-ink-secondary">
        <span className={cn("inline-flex h-[19px] items-center rounded-[6px] px-[7px] text-[11px] font-bold", fresh ? "bg-[#8B5CF6] text-white" : "bg-control text-ink")}>
          {fresh ? t("{squad} · new", { squad: squadName(index) }) : squadName(index)}
        </span>
        {Number.isFinite(joined) && group.width > 260 && <span>{t("Joined {time} · the squad lead reports for the squad", { time: clock(joined) })}</span>}
      </div>
    </div>
  );
}

// ── one person ───────────────────────────────────────────────────────────────
function Figure({
  bot,
  state,
  kind,
  driverKind,
  lead,
  cx,
  top,
  crown = false,
  glass = false,
  hideNew = false,
  onOpen,
}: {
  bot: BotWithMeta;
  state?: PersonState;
  kind: Parameters<typeof Mascot>[0]["kind"];
  driverKind?: string;
  lead: boolean;
  cx: number;
  top: number;
  crown?: boolean;
  glass?: boolean;
  hideNew?: boolean;
  onOpen: () => void;
}) {
  const pose = state?.pose ?? "idle";
  const tone = state?.tone ?? "grey";
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group absolute z-[3] flex w-[112px] flex-col items-center rounded-xl outline-offset-4"
      style={{ left: cx - 56, top }}
      title={t("{name} · {status} — open the chat", { name: bot.name, status: state?.line ?? "" })}
    >
      {state?.bubble && <Bubble tone={state.bubble.tone} lines={state.bubble.lines} />}
      <span className="relative block size-[108px] shrink-0 transition-transform group-hover:-translate-y-0.5">
        <Mascot kind={kind} pose={pose} scale={1.5} dim={state?.dim} shadow className={glass ? "opacity-95" : undefined} />
        {pose === "work" && (
          <>
            <i className="absolute top-[46px] left-2 z-[2] size-[5px] bg-select" />
            <i className="absolute top-7 left-[95px] z-[2] size-1 bg-select opacity-70" />
            <i className="absolute top-[70px] left-[98px] z-[2] size-[3px] bg-select opacity-50" />
          </>
        )}
        {crown && <Crown className="absolute -top-[4px] left-1/2 z-[3] -translate-x-1/2" />}
      </span>
      <span className={cn("relative z-[3] -mt-1 flex items-center gap-1", state?.dim && "opacity-70")}>
        <NameTag name={bot.name} driverKind={driverKind} lead={lead} />
        {state?.isNew && !hideNew && <NewTag />}
      </span>
      <StatusLine tone={tone} status={state?.status ?? "idle"} text={state?.line ?? t("Idle")} />
    </button>
  );
}

function StatusLine({ tone, status, text }: { tone: PersonState["tone"]; status: PersonStatus; text: string }) {
  const icon =
    tone === "blue" ? (
      <i className="mx-0.5 inline-block size-[7px] shrink-0 rounded-full bg-current shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-select)_16%,transparent)]" />
    ) : tone === "amber" ? (
      <DiamondMark size={9} />
    ) : tone === "red" ? (
      status === "disagree" ? <Zap size={11} strokeWidth={2.4} /> : <X size={11} strokeWidth={2.6} />
    ) : tone === "green" ? (
      <Check size={11} strokeWidth={2.6} />
    ) : (
      <Clock size={11} />
    );
  return (
    <span className={cn("mt-[3px] inline-flex max-w-[150px] items-center gap-1 text-[11.5px] leading-4 font-semibold whitespace-nowrap", TONE_TEXT[tone])}>
      {icon}
      <span className="truncate">{text}</span>
    </span>
  );
}

function Bubble({ tone, lines }: { tone: "amber" | "red" | "grey"; lines: string[] }) {
  const palette =
    tone === "amber"
      ? { background: "color-mix(in srgb, #F59E0B 9%, var(--color-raised))", color: "var(--color-warning)", edge: "color-mix(in srgb, #F59E0B 55%, transparent)" }
      : tone === "red"
        ? { background: "color-mix(in srgb, var(--color-danger) 6%, var(--color-raised))", color: "var(--color-danger)", edge: "color-mix(in srgb, var(--color-danger) 35%, transparent)" }
        : { background: "var(--color-raised)", color: "var(--color-ink-secondary)", edge: "color-mix(in oklab, var(--color-hairline) 60%, transparent)" };
  return (
    <span
      className={cn("absolute bottom-[calc(100%-10px)] left-1/2 z-[5] -translate-x-1/2 rounded-[10px] px-[9px] py-1 text-center text-[11px] leading-[1.32] whitespace-nowrap", tone === "grey" ? "font-medium" : "font-semibold")}
      style={{ background: palette.background, color: palette.color, boxShadow: `inset 0 0 0 1px ${palette.edge}, 0 6px 14px -8px rgb(16 24 40 / 0.3)` }}
    >
      {lines.map((line, index) => (
        <span key={index} className="block">
          {line}
        </span>
      ))}
      <i aria-hidden className="absolute -bottom-[4.5px] left-1/2 -ml-1 size-2 rotate-45" style={{ background: palette.background, boxShadow: `inset -1px -1px 0 0 ${palette.edge}` }} />
    </span>
  );
}

// ── right column: library + meeting rooms ───────────────────────────────────
function SideColumn({
  model,
  box,
  onOpenGroup,
  onOpenLibrary,
}: {
  model: WorkbenchModel;
  box: { x: number; y: number; width: number; height: number };
  onOpenGroup: (groupId: string) => void;
  onOpenLibrary: () => void;
}) {
  return (
    <>
      <LibraryCard model={model} style={{ left: box.x, top: box.y, width: box.width, height: 122 }} onOpen={onOpenLibrary} />
      <MeetingCard model={model} style={{ left: box.x, top: box.y + 134, width: box.width, height: box.height - 134 }} onOpenGroup={onOpenGroup} />
    </>
  );
}

const docStale = (doc: LibraryDoc) => {
  const latest = Math.max(0, ...doc.versions.map((version) => version.version));
  return doc.inUse.some((use) => use.version < latest);
};

function LibraryCard({ model, style, onOpen }: { model: WorkbenchModel; style: CSSProperties; onOpen: () => void }) {
  const docs = [...model.library].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3);
  const stale = model.library.filter(docStale).length;
  const colorOf = (doc: LibraryDoc) => model.rooms.find((room) => room.section === doc.section)?.color ?? "#14B8A6";
  return (
    <section className={card} style={style} aria-label={t("Library")}>
      <CardHead
        icon={<Folder size={13} className="text-ink-secondary" />}
        title={<button type="button" onClick={onOpen} className="hover:underline">{t("Library")}</button>}
        aside={stale ? <span className="inline-flex h-5 items-center rounded-full bg-warning/12 px-2 text-[11.5px] font-semibold text-warning">{t("{count} need updating", { count: stale })}</span> : undefined}
      />
      {docs.length === 0 ? (
        <div className="border-t border-hairline/30 pt-3 text-[12px] leading-relaxed text-ink-secondary">{t("Published price lists, brand rules and specs land here, with versions and who uses them.")}</div>
      ) : (
        docs.map((doc) => {
          const latest = doc.versions.reduce((max, version) => Math.max(max, version.version), 0);
          const fresh = model.lastSeen > 0 && doc.updatedAt > model.lastSeen;
          const today = new Date(doc.updatedAt).toDateString() === new Date(model.now).toDateString();
          return (
            <button key={doc.id} type="button" onClick={onOpen} className="flex h-[26px] w-full items-center gap-[7px] border-t border-hairline/30 text-left text-[12.5px] whitespace-nowrap">
              <i className="grid size-[18px] shrink-0 place-items-center rounded-[5px] text-white" style={{ background: latest ? colorOf(doc) : "#D97706" }}>
                <FileText size={11} />
              </i>
              <b className="truncate font-semibold text-ink">{doc.title}</b>
              {latest > 0 && <span className="font-mono text-[11px] font-bold text-ink-secondary">v{latest}</span>}
              {fresh && <span className="inline-flex h-[18px] items-center rounded-full bg-select/12 px-1.5 text-[11px] font-semibold text-accent-text">{t("New version")}</span>}
              {latest === 0 && <span className="inline-flex h-[18px] items-center rounded-full bg-warning/12 px-1.5 text-[11px] font-semibold text-warning">{t("Missing")}</span>}
              <em className="ml-auto text-[11.5px] text-ink-secondary not-italic">
                {today ? `${clock(doc.updatedAt)} · ` : ""}
                {t("{count} subscribed", { count: doc.subscribers.length })}
              </em>
            </button>
          );
        })
      )}
    </section>
  );
}

function MeetingCard({ model, style, onOpenGroup }: { model: WorkbenchModel; style: CSSProperties; onOpenGroup: (groupId: string) => void }) {
  const today = new Date(model.now).toDateString();
  const meetings = model.groups
    .filter((group) => !group.dm)
    .map((group) => {
      const todays = group.messages.filter((message) => new Date(message.at).toDateString() === today);
      return { group, first: todays[0]?.at, last: todays[todays.length - 1]?.at };
    })
    .filter((meeting) => meeting.last)
    .sort((a, b) => (b.last ?? 0) - (a.last ?? 0));
  const latest = meetings[0] ?? (model.groups.find((group) => !group.dm) ? { group: model.groups.find((group) => !group.dm)!, first: undefined, last: undefined } : undefined);
  const decision = latest ? model.decisions.find((entry) => entry.source.kind === "group" && entry.source.id === latest.group.id) : undefined;
  const live = meetings.filter((meeting) => meeting.group.busyBotId).length;
  const members = latest ? latest.group.memberIds.map((id) => model.botById.get(id)).filter((bot): bot is BotWithMeta => Boolean(bot)) : [];
  return (
    <section className={card} style={style} aria-label={t("Meeting rooms")}>
      <CardHead
        icon={<Users size={13} className="text-ink-secondary" />}
        title={t("Meeting rooms")}
        aside={meetings.length ? (live ? t("{count} in session", { count: live }) : t("{count} finished", { count: meetings.length })) : undefined}
      />
      {latest ? (
        <button type="button" onClick={() => onOpenGroup(latest.group.id)} className="block w-full text-left">
          <span className="flex items-center gap-[7px] text-[12.5px] whitespace-nowrap">
            <b className="truncate font-semibold text-ink">{latest.group.name}</b>
            {latest.first && latest.last && <span className="text-[11.5px] text-ink-secondary">{latest.first === latest.last ? clock(latest.last) : `${clock(latest.first)} – ${clock(latest.last)}`}</span>}
            <span className="ml-auto flex shrink-0">
              {members.slice(0, 4).map((bot, index) => (
                <span key={bot.id} style={{ marginLeft: index ? -5 : 0 }}>
                  <BotTile kind={model.mascotOf(bot)} size={16} chief={bot.id === model.chief?.id} />
                </span>
              ))}
            </span>
          </span>
          <span className="mt-[5px] flex items-center gap-1.5 text-[11.5px] whitespace-nowrap text-ink-secondary">
            {decision ? (
              <>
                <DecisionMark size={9} />
                {t("Produced decision #{id} · {count} action items sent out", { id: decision.id, count: decision.actionItems.length })}
              </>
            ) : (
              t("{count} members · no decision yet", { count: members.length })
            )}
          </span>
        </button>
      ) : (
        <div className="text-[12px] leading-relaxed text-ink-secondary">{t("Group chats where departments align show up here with what they decided.")}</div>
      )}
    </section>
  );
}

