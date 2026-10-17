// 简报 (U1) — the owner's front page. Left: the chief's summary written as one
// message (headline, progress, a line per department with citations that open
// the source report, what changed since you last looked, the main risk and
// today's spend) over today's timeline. Right: 需要你 · N — one card per inbox
// item, answered in place (pick an option, approve or refuse through the
// approval API, answer an escalation), then what the chief approved for you
// and what expired. Data: useBrief / useUsageSummary / useDecisions / useOrg.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { BarChart3, Check, ChevronDown, Clock, Eye, FileText, Grid2x2, Hand, History, Link2, Lock, Share, SquareArrowOutUpRight, Users } from "lucide-react";

import { Button, Segmented } from "@/components/ui";
import { EvolutionCard } from "@/components/EvolutionCard";
import { BotTile } from "@/components/mascot/Mascot";
import { cn } from "@/lib/cn";
import { mascotForBot } from "@/lib/engine-mascots";
import { formatDateTime, t } from "@/lib/i18n";
import { chiefBot } from "@/lib/org";
import { clip, clock } from "@/lib/workbench";
import { EMPTY_BRIEF, EMPTY_ORG, EMPTY_USAGE, getLastSeen, markSeen, refreshApi, useBrief, useDecisions, useOrg, useUsageSummary } from "@/state/org-api";
import { useEvolution } from "@/lib/evolution";
import { api, useStore, type Bot } from "@/state/store";
import type { Brief, BriefDepartment, InboxItem, OrgEvent } from "../../../shared/org-types";

import { DecisionMark, DiamondMark, HealthDot, StatusGlyph, useElementSize, useNow, useStoredState } from "../workbench/parts";
import { formatYuan } from "../workbench/PeopleView";
import { answerRoute, briefText, decideRoute, foldTimeline, handlingMinutes, headlineOf, inboxOrder, isImageOption, percent, progressSegments, splitDetail, weekStart } from "./brief-model";

type Range = "today" | "week";
const RANGES = ["today", "week"] as const;

export function BriefPage() {
  const { state, dispatch } = useStore();
  const now = useNow(30_000);
  const [range, setRange] = useStoredState<Range>("omb.brief.range", "today", RANGES);
  const [lastSeen] = useState(getLastSeen);
  const since = range === "week" ? weekStart(now) : lastSeen;
  const { data: briefData, loaded, error } = useBrief(since);
  // 自我进化提案：只读，卡片自己处理拍板；没有待决定提案时不占位
  const { data: evolution } = useEvolution();
  const { data: usageData } = useUsageSummary();
  const { data: orgData } = useOrg();
  const { data: decisionData } = useDecisions();
  const [expanded, setExpanded] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [mainRef, { width }] = useElementSize<HTMLElement>();
  const brief = useMemo<Brief>(() => ({ ...EMPTY_BRIEF, ...briefData }), [briefData]);
  const org = useMemo(() => ({ ...EMPTY_ORG, ...orgData, rules: { ...EMPTY_ORG.rules, ...orgData?.rules } }), [orgData]);
  const usage = useMemo(() => {
    const merged = { ...EMPTY_USAGE, ...usageData };
    return merged.budgetPerDay || merged.todayCost ? merged : { ...EMPTY_USAGE, ...brief.spend };
  }, [usageData, brief.spend]);
  const connected = loaded && !error;

  // what you see here counts as seen once you leave
  useEffect(() => () => markSeen(), []);

  const bots = state.bots;
  const botOf = (id: string) => bots.find((bot) => bot.id === id);
  const tileOf = (id: string, size: number, chief = false) => {
    const bot = botOf(id);
    return bot ? <BotTile kind={mascotForBot(bot, state.instances)} size={size} chief={chief || bot.id === org.chiefBotId} /> : null;
  };
  const chief = chiefBot(bots, org);
  const say = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((current) => (current === message ? null : current)), 2400);
  };
  const openChat = (botId: string, threadId?: string) => {
    dispatch({ type: "select", id: botId });
    const bot = botOf(botId);
    if (threadId && bot?.tasks?.some((task) => task.threadId === threadId)) dispatch({ type: "switchTask", botId, threadId });
  };
  const openSource = (decisionId: number) => {
    const decision = decisionData?.decisions?.find((entry) => entry.id === decisionId);
    if (decision) dispatch({ type: "select", id: decision.source.id });
  };
  const share = async () => {
    try {
      await navigator.clipboard.writeText(briefText(brief, now, (id) => botOf(id)?.name ?? "?"));
      say(t("Brief copied"));
    } catch {
      say(t("Could not copy the brief"));
    }
  };

  const twoColumns = width === 0 || width >= 980;
  const dateLine = `${formatDateTime(now, { weekday: "short" })} ${formatDateTime(now, { month: "long", day: "numeric" })} · ${clock(now)}`;
  return (
    <main ref={mainRef} className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-stage text-ink">
      <header className="flex h-[68px] shrink-0 items-center gap-1 pr-[18px] pl-7 max-md:pl-12">
        <div className="flex min-w-0 flex-col leading-[1.25]">
          <h1 className="text-[22px] font-bold tracking-[-0.2px]">{t("Brief")}</h1>
          <span className="mt-0.5 text-[12.5px] text-ink-secondary">{dateLine}</span>
        </div>
        <span className="flex-1" />
        <Segmented
          value={range}
          onChange={setRange}
          label={t("Time range")}
          options={[
            { value: "today", label: t("Today") },
            { value: "week", label: t("This week") },
          ]}
        />
        <span className="w-1" />
        <IconButton label={t("Copy the brief to share")} onClick={() => void share()}>
          <Share size={17} />
        </IconButton>
        <IconButton label={expanded ? t("Fold the timeline") : t("Show the whole day")} active={expanded} onClick={() => setExpanded((value) => !value)}>
          <History size={17} />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-6">
        <EvolutionCard feed={evolution} />
        <div className={cn("grid items-start gap-x-10 gap-y-6", twoColumns ? "grid-cols-[minmax(0,1fr)_minmax(380px,470px)]" : "grid-cols-1")}>
          <section aria-label={t("The chief's brief")} className="flex min-w-0 flex-col gap-3 pt-1.5">
            {connected ? (
              <Digest brief={brief} chief={chief} now={now} range={range} since={since} usage={usage} tileOf={tileOf} botOf={botOf} onOpenChat={openChat} onOpenDecision={openSource} />
            ) : (
              <NotConnected chief={chief} tileOf={tileOf} />
            )}
            <DayLines events={brief.timeline} expanded={expanded} onExpand={() => setExpanded(true)} />
          </section>
          <NeedsYou
            brief={brief}
            connected={connected}
            now={now}
            dailyAt={org.rules.reportCadence.dailyBriefAt}
            tileOf={tileOf}
            botOf={botOf}
            onOpenChat={openChat}
            onAnswered={(message) => say(message)}
          />
        </div>
      </div>
      {toast && <div className="animate-pop-in pointer-events-none absolute bottom-6 left-1/2 z-30 -translate-x-1/2 rounded-full bg-[#14161C] px-3.5 py-1.5 text-[12.5px] text-white shadow-lg">{toast}</div>}
    </main>
  );
}

function IconButton({ label, onClick, active, children }: { label: string; onClick: () => void; active?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cn("grid size-9 place-items-center rounded-[10px] text-ink-secondary transition-colors hover:bg-control hover:text-ink", active && "bg-control text-ink")}
    >
      {children}
    </button>
  );
}

// ── left: the chief's digest ─────────────────────────────────────────────────
type TileOf = (id: string, size: number, chief?: boolean) => ReactNode;

function MessageHead({ chief, time, meta }: { chief?: Bot; time?: string; meta: string }) {
  return (
    <div className="flex h-5 items-center gap-2 text-[13.5px] whitespace-nowrap">
      <b>{chief?.name ?? t("Chief")}</b>
      {time && <span className="text-[11.5px] text-ink-secondary/70">{time}</span>}
      <span className="truncate text-[11.5px] text-ink-secondary">{meta}</span>
    </div>
  );
}

function NotConnected({ chief, tileOf }: { chief?: Bot; tileOf: TileOf }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="-mt-1.5 shrink-0">{chief ? tileOf(chief.id, 24, true) : null}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <MessageHead chief={chief} meta={t("No brief yet")} />
        <div className="rounded-[4px_16px_16px_16px] bg-inset px-4 py-4">
          <p className="text-[15px] font-bold">{t("The chief hasn't written a brief yet")}</p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">
            {t("Once the brief service is on, the chief rolls every department's reports into this one screen each day — every line links back to the report it came from.")}
          </p>
        </div>
      </div>
    </div>
  );
}

function Digest({
  brief,
  chief,
  now,
  range,
  since,
  usage,
  tileOf,
  botOf,
  onOpenChat,
  onOpenDecision,
}: {
  brief: Brief;
  chief?: Bot;
  now: number;
  range: Range;
  since: number;
  usage: Brief["spend"];
  tileOf: TileOf;
  botOf: (id: string) => Bot | undefined;
  onOpenChat: (botId: string, threadId?: string) => void;
  onOpenDecision: (decisionId: number) => void;
}) {
  const [cite, setCite] = useState<string | null>(null);
  const headline = headlineOf(brief);
  const segments = progressSegments(brief.departments, brief.total);
  const reports = brief.departments.filter((dept) => dept.lastReportAt).length;
  const risk = brief.risks[0];
  // the week view shows the week's spend against seven days of budget
  const week = range === "week" && typeof usage.weekCost === "number";
  const spent = week ? usage.weekCost! : usage.todayCost;
  const budget = week ? usage.budgetPerDay * 7 : usage.budgetPerDay;
  const left = budget > 0 ? Math.max(0, budget - spent) : null;
  return (
    <div className="flex items-start gap-2.5">
      <span className="-mt-1.5 shrink-0">{chief ? tileOf(chief.id, 24, true) : null}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <MessageHead chief={chief} time={brief.at ? clock(brief.at) : undefined} meta={reports ? t("From {count} department reports · every line links to its source", { count: reports }) : t("Every line links to its source")} />
        <div className="flex flex-col gap-2.5 rounded-[4px_16px_16px_16px] bg-inset px-3.5 pt-[13px] pb-3.5">
          {headline && <p className="mx-0.5 text-[17px] leading-[1.4] font-bold tracking-[-0.1px]">{headline}</p>}
          {brief.total > 0 && (
            <div className="mx-0.5 -mt-0.5 mb-0.5 flex items-center gap-2.5">
              <span className="flex h-1.5 flex-1 gap-0.5">
                {segments.map((segment) => (
                  <i key={segment.key} className={cn("block h-full rounded-[3px]", !segment.color && "bg-control")} style={{ flex: segment.flex, background: segment.color ?? undefined }} />
                ))}
              </span>
              <span className="text-[12px] whitespace-nowrap text-ink-secondary">{t("{done} / {total} done · {percent}%", { done: brief.done, total: brief.total, percent: percent(brief.done, brief.total) })}</span>
            </div>
          )}
          {brief.departments.length > 0 ? (
            <div className="flex flex-col rounded-xl bg-raised px-2.5 py-[3px]">
              {brief.departments.map((dept, index) => (
                <DeptRow
                  key={dept.section}
                  dept={dept}
                  n={index + 1}
                  first={index === 0}
                  open={cite === dept.section}
                  onCite={() => setCite(cite === dept.section ? null : dept.section)}
                  tileOf={tileOf}
                  botOf={botOf}
                  onOpenChat={onOpenChat}
                />
              ))}
            </div>
          ) : (
            <p className="mx-0.5 text-[13px] text-ink-secondary">{t("No department has reported yet today.")}</p>
          )}
          <Changes brief={brief} since={since} range={range} now={now} onOpenDecision={onOpenDecision} />
          <div className="flex gap-2.5">
            {risk && (
              <div className="flex flex-[1.75] flex-col gap-0.5 rounded-xl bg-raised px-3 pt-2 pb-[9px]">
                <div className="flex h-5 items-center gap-1.5 text-[12px] font-semibold text-danger">
                  <Link2 size={13} />
                  {t("Risk · dependency")}
                </div>
                <b className="truncate text-[13px]">{risk.title}</b>
                <span className="truncate text-[11.5px] text-ink-secondary">{risk.detail}</span>
              </div>
            )}
            <div className="flex flex-1 flex-col gap-[3px] rounded-xl bg-raised px-3 pt-2 pb-[9px]">
              <div className="flex h-5 items-center gap-1.5 text-[12px] font-semibold text-ink-secondary">
                <BarChart3 size={13} />
                {t("Spend")}
              </div>
              <span className="flex items-baseline gap-[5px] whitespace-nowrap">
                <b className="text-[17px] leading-[1.2]">¥{formatYuan(spent)}</b>
                <span className="text-[12px] text-ink-secondary">{budget > 0 ? t("/ budget ¥{budget}", { budget: formatYuan(budget) }) : t("· no budget set")}</span>
              </span>
              <span className="my-px block h-1 overflow-hidden rounded-full bg-control">
                <i className="block h-full rounded-full bg-ink-secondary" style={{ width: `${budget > 0 ? Math.min(100, (spent / budget) * 100) : 0}%` }} />
              </span>
              <span className="text-[11.5px] whitespace-nowrap text-ink-secondary">
                {left !== null ? (week ? t("This week · ¥{left} left", { left: formatYuan(left) }) : t("Today · ¥{left} left", { left: formatYuan(left) })) : week ? t("This week") : t("Today")}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function DeptRow({
  dept,
  n,
  first,
  open,
  onCite,
  tileOf,
  botOf,
  onOpenChat,
}: {
  dept: BriefDepartment;
  n: number;
  first: boolean;
  open: boolean;
  onCite: () => void;
  tileOf: TileOf;
  botOf: (id: string) => Bot | undefined;
  onOpenChat: (botId: string) => void;
}) {
  const lead = dept.leadBotId ? botOf(dept.leadBotId) : undefined;
  const pct = dept.total ? (dept.done / dept.total) * 100 : 0;
  const healthChip = dept.health === "green" ? { label: t("Green"), className: "bg-success/12 text-success" } : dept.health === "yellow" ? { label: t("Yellow"), className: "bg-[#F5B000]/15 text-warning" } : { label: t("Red"), className: "bg-danger/10 text-danger" };
  return (
    <>
      <div className={cn("grid h-[31px] grid-cols-[66px_82px_8px_minmax(0,1fr)] items-center gap-x-[9px]", !first && "border-t border-hairline/25")}>
        <span className="flex items-center gap-1.5 text-[13px] font-bold whitespace-nowrap">
          <i className="size-[7px] shrink-0 rounded-[2px]" style={{ background: dept.color }} />
          <span className="truncate">{dept.section}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-1 flex-1 overflow-hidden rounded-full bg-control">
            <i className="block h-full rounded-full" style={{ width: `${pct}%`, background: dept.color }} />
          </span>
          <span className="w-7 text-[11.5px] whitespace-nowrap text-ink-secondary">
            {dept.done}/{dept.total}
          </span>
        </span>
        <HealthDot health={dept.health} />
        <span className="flex min-w-0 items-center text-[12.5px] whitespace-nowrap text-ink-secondary">
          <span className="truncate">{dept.status}</span>
          <button
            type="button"
            onClick={onCite}
            aria-expanded={open}
            aria-label={t("Source {n}", { n })}
            className={cn(
              "mx-px ml-1 inline-grid h-4 min-w-4 shrink-0 place-items-center rounded-[4px] px-[3px] text-[10px] font-bold",
              open ? "bg-select text-white shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-select)_20%,transparent)]" : "bg-select/12 text-accent-text hover:bg-select/20",
            )}
          >
            {n}
          </button>
        </span>
      </div>
      {open && (
        <div role="dialog" aria-label={t("Source {n}", { n })} className="relative mx-[-4px] mt-px mb-[7px] rounded-xl bg-raised px-3 pt-[9px] pb-2.5 shadow-[0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent),0_14px_30px_-14px_rgb(16_24_40/0.32)]">
          <div className="flex h-5 items-center gap-1.5 whitespace-nowrap">
            {lead && tileOf(lead.id, 16)}
            <b className="text-[12.5px]">{lead?.name ?? dept.section}</b>
            <span className="truncate text-[11.5px] text-ink-secondary">
              {dept.lastReportAt ? `${clock(dept.lastReportAt)} · ` : ""}
              {t("{department} summary", { department: dept.section })}
            </span>
            <span className={cn("inline-flex h-[18px] items-center gap-1 rounded-[5px] px-1.5 text-[11px] font-bold", healthChip.className)}>
              <HealthDot health={dept.health} size={7} />
              {healthChip.label}
            </span>
            {lead && (
              <button type="button" onClick={() => onOpenChat(lead.id)} className="ml-auto inline-flex items-center gap-[3px] text-[12px] font-semibold text-accent-text hover:underline">
                {t("Open the source")}
                <SquareArrowOutUpRight size={12} />
              </button>
            )}
          </div>
          <div className="mt-1.5 flex flex-col gap-0.5 border-l-2 border-select/30 pl-2.5">
            <div className="flex gap-2 text-[12.5px] leading-[1.55]">
              <span className="w-16 shrink-0 text-[12px] text-ink-secondary">{t("Progress")}</span>
              <span>{t("{done}/{total} done", { done: dept.done, total: dept.total })}</span>
            </div>
            <div className="flex gap-2 text-[12.5px] leading-[1.55]">
              <span className="w-16 shrink-0 text-[12px] text-ink-secondary">{t("Now")}</span>
              <span className="min-w-0">{dept.status}</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function changeIcon(event: OrgEvent): ReactNode {
  const box = (className: string, child: ReactNode) => <span className={cn("grid size-[22px] shrink-0 place-items-center rounded-[7px]", className)}>{child}</span>;
  switch (event.kind) {
    case "decision":
      return box("bg-control/70", <DecisionMark size={13} />);
    case "people.added":
      return box("bg-[#8B5CF6]/12 text-[#6D3FE0]", <Users size={13} />);
    case "library.published":
      return box("bg-select/12 text-accent-text", <FileText size={13} />);
    case "run.failed":
    case "subtask.failed":
    case "subtask.retry":
      return box("bg-danger/10", <StatusGlyph status="fail" size={12} />);
    case "run.done":
    case "approval.resolved":
      return box("bg-success/12", <StatusGlyph status="done" size={12} />);
    case "approval.requested":
    case "approval.auto":
    case "approval.expired":
      return box("bg-warning/12 text-warning", <Lock size={12} />);
    case "escalation":
      return box("bg-warning/12 text-warning", <Hand size={12} />);
    case "meeting":
      return box("bg-[#EC4899]/10 text-[#BE185D]", <Users size={13} />);
    default:
      return box("bg-control/70 text-ink-secondary", <Clock size={12} />);
  }
}

function Changes({ brief, since, range, now, onOpenDecision }: { brief: Brief; since: number; range: Range; now: number; onOpenDecision: (decisionId: number) => void }) {
  const changes = brief.changes.slice(0, range === "week" ? 8 : 5);
  const title =
    range === "week" ? t("This week so far") : since > 0 ? t("Since you looked at {time}", { time: since > now - 86_400_000 ? clock(since) : formatDateTime(since, { month: "numeric", day: "numeric" }) }) : t("Today so far");
  return (
    <div className="rounded-xl bg-raised px-3 pt-2 pb-[9px]">
      <div className="flex h-5 items-center gap-1.5 text-[12px] font-semibold whitespace-nowrap text-ink-secondary">
        <Eye size={14} />
        {title}
        <span className="ml-auto font-medium text-ink-secondary/70">{t("{count} changes", { count: brief.changes.length })}</span>
      </div>
      {changes.length === 0 ? (
        <p className="pt-1.5 text-[12.5px] text-ink-secondary">{t("Nothing new since then.")}</p>
      ) : (
        changes.map((event, index) => (
          <button
            key={event.id}
            type="button"
            disabled={event.decisionId === undefined}
            onClick={() => event.decisionId !== undefined && onOpenDecision(event.decisionId)}
            className={cn("flex h-[29px] w-full items-center gap-[9px] text-left text-[13px] whitespace-nowrap", index > 0 && "border-t border-hairline/25", event.decisionId !== undefined && "hover:text-accent-text")}
          >
            {changeIcon(event)}
            <span className="min-w-0 flex-1 truncate">{event.title}</span>
            <span className="font-mono text-[11.5px] text-ink-secondary/70">{clock(event.at)}</span>
          </button>
        ))
      )}
    </div>
  );
}

function DayLines({ events, expanded, onExpand }: { events: OrgEvent[]; expanded: boolean; onExpand: () => void }) {
  const rows = expanded ? [...events].sort((a, b) => a.at - b.at).map((event) => ({ kind: "event" as const, event })) : foldTimeline(events);
  return (
    <div className="flex flex-col items-center gap-[5px] pl-11">
      <span className="flex w-full items-center gap-2.5 text-[11.5px] whitespace-nowrap text-ink-secondary/70 before:h-px before:flex-1 before:bg-hairline/40 after:h-px after:flex-1 after:bg-hairline/40">
        {t("Today · timeline")}
      </span>
      {rows.length === 0 && <span className="text-[12px] text-ink-secondary">{t("Nothing has happened yet today.")}</span>}
      {rows.map((row) =>
        row.kind === "event" ? (
          <span key={row.event.id} className="text-[12px] leading-[18px] whitespace-nowrap text-ink-secondary">
            <span className="mr-[7px] font-mono text-[11px] text-ink-secondary/70">{clock(row.event.at)}</span>
            {row.event.title}
          </span>
        ) : (
          <button key="fold" type="button" onClick={onExpand} className="inline-flex h-6 items-center gap-[5px] rounded-full bg-control/70 px-2.5 text-[12px] whitespace-nowrap text-ink-secondary hover:bg-control">
            <ChevronDown size={13} />
            {t("{from} – {to} · {titles} and {count} more", { from: clock(row.from), to: clock(row.to), titles: row.titles.join(t(", ")), count: row.count })}
          </button>
        ),
      )}
    </div>
  );
}

// ── right: needs you ─────────────────────────────────────────────────────────
function NeedsYou({
  brief,
  connected,
  now,
  dailyAt,
  tileOf,
  botOf,
  onOpenChat,
  onAnswered,
}: {
  brief: Brief;
  connected: boolean;
  now: number;
  dailyAt: string;
  tileOf: TileOf;
  botOf: (id: string) => Bot | undefined;
  onOpenChat: (botId: string, threadId?: string) => void;
  onAnswered: (message: string) => void;
}) {
  const { dispatch } = useStore();
  const [answered, setAnswered] = useState<Record<string, string>>({});
  const items = inboxOrder(brief.needsYou);
  // answering follows where the question lives (see answerRoute)
  const answer = (item: InboxItem, text: string) => {
    const lastAsker = item.chain?.length ? item.chain[item.chain.length - 1]!.botId : item.botId;
    const route = answerRoute(item);
    if (route === "request") dispatch({ type: "decideRequest", threadId: item.threadId!, requestId: item.requestId!, behavior: "answer", message: text });
    else if (route === "room") dispatch({ type: "sendGroup", groupId: item.groupId!, text, replyToId: item.messageId });
    else if (route === "card") dispatch({ type: "answerCard", botId: item.botId, messageId: item.messageId!, answer: text });
    else dispatch({ type: "send", botId: lastAsker, text: t("About “{title}”: {answer}", { title: item.title, answer: text }) });
    setAnswered((current) => ({ ...current, [item.id]: text }));
    onAnswered(t("Answered: {answer}", { answer: clip(text, 16) }));
    void refreshApi("/api/brief");
  };
  const decide = async (item: InboxItem, behavior: "allow" | "deny") => {
    const route = decideRoute(item);
    if (route === "run") {
      try {
        await api(`/api/dispatch/runs/${encodeURIComponent(item.runId!)}/${behavior === "allow" ? "approve" : "cancel"}`, { method: "POST", body: "{}" });
        setAnswered((current) => ({ ...current, [item.id]: behavior === "allow" ? t("Started") : t("Canceled") }));
        onAnswered(behavior === "allow" ? t("The plan is running") : t("The plan was canceled"));
      } catch (error) {
        onAnswered(error instanceof Error ? error.message : String(error));
      }
      void refreshApi("/api/brief");
      return;
    }
    if (route === "chat") {
      onOpenChat(item.botId, item.threadId);
      return;
    }
    dispatch({ type: "decideRequest", threadId: item.threadId!, requestId: item.requestId!, behavior, message: behavior === "deny" ? "Denied by the owner from the brief." : undefined });
    setAnswered((current) => ({ ...current, [item.id]: behavior === "allow" ? t("Approved") : t("Refused") }));
    onAnswered(behavior === "allow" ? t("Approved — it goes out as scheduled") : t("Refused — it won't go out"));
    void refreshApi("/api/brief");
  };
  return (
    <section aria-label={t("Needs you")} className="flex min-w-0 flex-col gap-2.5 pt-1.5">
      <div className="flex h-5 items-center gap-2 whitespace-nowrap">
        <DiamondMark size={12} />
        <b className="text-[15.5px]">{t("Needs you · {count}", { count: items.length })}</b>
        {items.length > 0 && <span className="ml-auto text-[12px] text-ink-secondary/70">{t("About {count} min to clear", { count: handlingMinutes(items) })}</span>}
      </div>
      {items.length === 0 && (
        <div className="flex flex-col items-center gap-1 rounded-[14px] bg-raised px-5 py-7 text-center shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent)]">
          <span className="grid size-8 place-items-center rounded-full bg-success/12 text-success">
            <Check size={16} strokeWidth={2.6} />
          </span>
          <b className="mt-1 text-[14px]">{t("Nothing needs you")}</b>
          <p className="max-w-[36ch] text-[12.5px] leading-relaxed text-ink-secondary">
            {connected ? t("Picks, approvals and escalations that need your call land here.") : t("Once the brief service is on, picks, approvals and escalations that need your call land here.")}
          </p>
        </div>
      )}
      {items.map((item) =>
        item.kind === "choice" ? (
          <ChoiceCard key={item.id} item={item} now={now} tileOf={tileOf} botOf={botOf} done={answered[item.id]} onAnswer={(text) => answer(item, text)} onOpenChat={onOpenChat} />
        ) : item.kind === "approval" ? (
          <ApprovalCard key={item.id} item={item} now={now} tileOf={tileOf} botOf={botOf} done={answered[item.id]} onDecide={(behavior) => void decide(item, behavior)} onOpenChat={onOpenChat} />
        ) : (
          <EscalationCard key={item.id} item={item} now={now} tileOf={tileOf} botOf={botOf} done={answered[item.id]} onAnswer={(text) => answer(item, text)} onOpenChat={onOpenChat} />
        ),
      )}
      {brief.autoApproved.length > 0 && (
        <>
          <div className="mt-1 -mb-1 ml-0.5 text-[12px] font-semibold text-ink-secondary">{t("The chief approved for you · {count}", { count: brief.autoApprovedTotal ?? brief.autoApproved.length })}</div>
          {brief.autoApproved.map((entry) => (
            <div key={entry.id} className="flex h-[34px] items-center gap-2 rounded-[10px] bg-inset pr-3 pl-[9px] text-[12.5px] whitespace-nowrap">
              {tileOf(entry.botId, 14, true)}
              <span className="min-w-0 flex-1 truncate text-ink-secondary">
                <b className="text-ink">{entry.title}</b> · {t("rule: {rule}", { rule: entry.rule })}
              </span>
              <span className="font-mono text-[11.5px] text-ink-secondary/70">{clock(entry.at)}</span>
              <button type="button" className="text-[12.5px] font-semibold text-accent-text hover:underline" onClick={() => onOpenChat(entry.botId)}>
                {t("View")}
              </button>
            </div>
          ))}
        </>
      )}
      {brief.expired.length > 0 && (
        <>
          <div className="mt-1 -mb-1 ml-0.5 text-[12px] font-semibold text-ink-secondary">{t("Expired · {count}", { count: brief.expired.length })}</div>
          {brief.expired.map((entry) => (
            <div key={entry.id} className="flex h-[34px] items-center gap-2 rounded-[10px] bg-inset pr-3 pl-[9px] text-[12.5px] whitespace-nowrap">
              <span className="grid size-[18px] shrink-0 place-items-center rounded-full bg-control text-ink-secondary">
                <Clock size={12} />
              </span>
              <span className="min-w-0 flex-1 truncate text-ink-secondary">{t("{title} · nobody answered in time, voided and not run", { title: entry.title })}</span>
              <button type="button" className="text-[12.5px] font-semibold text-accent-text hover:underline" onClick={() => onOpenChat(entry.botId)}>
                {t("Ask again")}
              </button>
            </div>
          ))}
        </>
      )}
      <div className="mt-2 flex h-7 items-center justify-center gap-[5px] border-t border-hairline/30 text-[12px] whitespace-nowrap text-ink-secondary">
        <Clock size={12} />
        {t("Next daily brief at {time}", { time: dailyAt || "18:00" })}
      </div>
    </section>
  );
}

const waited = (since: number, now: number) => t("Waited {count} min", { count: Math.max(1, Math.round((now - since) / 60_000)) });

function CardShell({
  icon,
  tag,
  item,
  now,
  tileOf,
  botOf,
  consequence,
  children,
}: {
  icon: ReactNode;
  tag: string;
  item: InboxItem;
  now: number;
  tileOf: TileOf;
  botOf: (id: string) => Bot | undefined;
  consequence?: string;
  children: ReactNode;
}) {
  const bot = botOf(item.botId);
  return (
    <article className="flex flex-col gap-[9px] rounded-[14px] bg-raised px-3 pt-[11px] pb-3 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent),0_1px_2px_rgb(16_24_40/0.05)]">
      <div className="flex h-[22px] items-center gap-2 whitespace-nowrap">
        <span className="inline-flex h-5 items-center gap-1 rounded-[6px] bg-warning/12 px-[7px] text-[11.5px] font-bold text-warning">
          {icon}
          {tag}
        </span>
        <b className="min-w-0 truncate text-[14px]">{item.title}</b>
        <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[11.5px] text-ink-secondary">
          <Clock size={12} />
          {waited(item.since, now)}
        </span>
      </div>
      <div className="-mt-1 flex items-center gap-[5px] text-[12px] whitespace-nowrap">
        {tileOf(item.botId, 14)}
        <span className="font-semibold text-ink-secondary">{bot?.name ?? "?"}</span>
        {consequence && (
          <>
            <span className="text-ink-secondary/60">·</span>
            <span className="truncate text-ink-secondary">{consequence}</span>
          </>
        )}
      </div>
      {children}
    </article>
  );
}

function Done({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-success">
      <Check size={14} strokeWidth={2.6} />
      {t("Answered: {answer}", { answer: text })}
    </div>
  );
}

function ChoiceCard({ item, now, tileOf, botOf, done, onAnswer, onOpenChat }: { item: InboxItem; now: number; tileOf: TileOf; botOf: (id: string) => Bot | undefined; done?: string; onAnswer: (text: string) => void; onOpenChat: (botId: string, threadId?: string) => void }) {
  const [picked, setPicked] = useState<number | null>(null);
  const options = item.options ?? [];
  const { consequence, body } = splitDetail(item);
  return (
    <CardShell icon={<Grid2x2 size={12} />} tag={t("Pick")} item={item} now={now} tileOf={tileOf} botOf={botOf} consequence={consequence}>
      {body && <p className="text-[13px] leading-[1.6]">{body}</p>}
      {options.length > 0 && (
        <div className="flex gap-2" role="radiogroup" aria-label={item.title}>
          {options.slice(0, 4).map((option, index) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={picked === index}
              disabled={Boolean(done)}
              onClick={() => setPicked(index)}
              className={cn(
                "relative h-[58px] min-w-0 flex-1 overflow-hidden rounded-[9px] text-[12.5px] leading-tight transition-shadow",
                isImageOption(option) ? "bg-control" : "bg-inset px-2 pb-1 text-ink hover:bg-control/70",
                picked === index && "outline-[2.5px] outline-offset-2 outline-select outline-solid",
              )}
              title={option}
            >
              {isImageOption(option) ? <img src={option} alt="" className="size-full object-cover" /> : <span className="line-clamp-2">{option}</span>}
              <i className="absolute bottom-[5px] left-[5px] h-4 min-w-4 rounded-[5px] bg-raised/90 px-1 text-center text-[10.5px] leading-4 font-bold text-ink not-italic">{index + 1}</i>
              {picked === index && (
                <i className="absolute top-[5px] right-[5px] grid size-[18px] place-items-center rounded-full bg-select text-white">
                  <Check size={11} strokeWidth={3} />
                </i>
              )}
            </button>
          ))}
        </div>
      )}
      {done ? (
        <Done text={done} />
      ) : (
        <div className="flex items-center gap-1.5 whitespace-nowrap">
          <Button size="sm" disabled={picked === null} onClick={() => picked !== null && onAnswer(options[picked]!)}>
            {t("Pick this one")}
          </Button>
          <Button variant="soft" size="sm" onClick={() => onOpenChat(item.botId, item.threadId)}>
            {t("None of these — say what you need")}
          </Button>
          {picked !== null && <span className="ml-auto text-[11.5px] text-ink-secondary/70">{t("Picked No. {n}", { n: picked + 1 })}</span>}
        </div>
      )}
    </CardShell>
  );
}

function ApprovalCard({ item, now, tileOf, botOf, done, onDecide, onOpenChat }: { item: InboxItem; now: number; tileOf: TileOf; botOf: (id: string) => Bot | undefined; done?: string; onDecide: (behavior: "allow" | "deny") => void; onOpenChat: (botId: string, threadId?: string) => void }) {
  const { consequence, body } = splitDetail(item);
  const plan = Boolean(item.runId);
  return (
    <CardShell icon={<Lock size={12} />} tag={t("Approval")} item={item} now={now} tileOf={tileOf} botOf={botOf} consequence={consequence}>
      {body && (
        <div className="rounded-[11px] bg-inset px-[11px] pt-[9px] pb-2.5">
          <p className="text-[13px] leading-[1.6] whitespace-pre-wrap">
            {body.split(/(\s#\S+)/).map((part, index) => (/^\s#/.test(part) ? <span key={index} className="text-accent-text">{part}</span> : <span key={index}>{part}</span>))}
          </p>
        </div>
      )}
      {done ? (
        <Done text={done} />
      ) : (
        <div className="flex items-center gap-1.5 whitespace-nowrap">
          <Button size="sm" onClick={() => onDecide("allow")}>
            {plan ? t("Start the plan") : t("Approve and send")}
          </Button>
          <Button variant="soft" size="sm" onClick={() => onOpenChat(item.botId, item.threadId)}>
            {plan ? t("Look at the plan") : t("Change it")}
          </Button>
          <Button variant="soft" size="sm" onClick={() => onDecide("deny")}>
            {plan ? t("Cancel") : t("Refuse")}
          </Button>
          {item.rule && (
            <span className="ml-auto inline-flex min-w-0 items-center gap-1 text-[11.5px] text-ink-secondary">
              <Lock size={12} className="shrink-0" />
              <span className="truncate">{t("Rule: {rule}", { rule: item.rule })}</span>
            </span>
          )}
        </div>
      )}
    </CardShell>
  );
}

function EscalationCard({ item, now, tileOf, botOf, done, onAnswer, onOpenChat }: { item: InboxItem; now: number; tileOf: TileOf; botOf: (id: string) => Bot | undefined; done?: string; onAnswer: (text: string) => void; onOpenChat: (botId: string, threadId?: string) => void }) {
  const { consequence, body } = splitDetail(item);
  const chain = item.chain ?? [];
  return (
    <CardShell icon={<Hand size={12} />} tag={t("Escalated")} item={item} now={now} tileOf={tileOf} botOf={botOf} consequence={consequence}>
      {chain.length > 0 && (
        <div className="flex items-center gap-[3px] overflow-hidden rounded-[9px] bg-inset px-1.5 py-1 whitespace-nowrap">
          {chain.map((step, index) => (
            <span key={`${step.botId}${index}`} className="contents">
              <span className="inline-flex h-[22px] items-center gap-1 px-1 text-[12px]">
                {tileOf(step.botId, 13)}
                <b className="font-semibold text-ink-secondary">{botOf(step.botId)?.name ?? "?"}</b>
                <i className="font-mono text-[10.5px] text-ink-secondary/70 not-italic">{clock(step.at)}</i>
              </span>
              <ChevronDown size={12} className="-rotate-90 text-ink-secondary/60" />
            </span>
          ))}
          <span className="inline-flex h-[22px] items-center gap-1 rounded-[7px] bg-warning/12 pr-[7px] pl-[3px] text-[12px] font-semibold text-warning">
            <span className="grid size-[17px] place-items-center rounded-full bg-select text-[9.5px] font-bold text-white">{t("You")}</span>
            {t("You")}
          </span>
        </div>
      )}
      {body && <p className="text-[13px] leading-[1.6]">{body}</p>}
      {done ? (
        <Done text={done} />
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {(item.options ?? []).map((option) => (
            <Button key={option} variant="ghost" size="sm" onClick={() => onAnswer(option)}>
              {option}
            </Button>
          ))}
          {!item.options?.length && (
            <Button size="sm" onClick={() => onOpenChat(chain.length ? chain[chain.length - 1]!.botId : item.botId, item.threadId)}>
              {t("Answer in the chat")}
            </Button>
          )}
        </div>
      )}
    </CardShell>
  );
}
