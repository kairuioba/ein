// The work tree's right drawer. What it shows follows the selection, or the
// lens when nothing is selected:
//   汇报  a department's summary with numbered citations, the reports they
//         cite (one per subtask: what was done, result, blocker), the rule
//   协作  a work order (需求单) between departments, or a decision (决议 #n)
//         with its action items
//   any   a person, a squad, an output, or — for 总控 — every dispatch run
import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronLeft, Clock, ExternalLink, FileText, MessageSquare, PanelRightClose, RotateCcw, ArrowRight } from "lucide-react";

import { BotTile } from "@/components/mascot/Mascot";
import { Button, Segmented } from "@/components/ui";
import { cn } from "@/lib/cn";
import { msg, t } from "@/lib/i18n";
import { squadName } from "@/lib/org";
import { ago, clip, clock, isActiveRun } from "@/lib/workbench";
import type { DispatchRun, DispatchSubtask } from "../../../shared/dispatch-types";
import type { Health, OrgDecision } from "../../../shared/org-types";

import { RunList } from "./DispatchBoard";
import type { BotWithMeta, Room, WorkbenchModel } from "./model";
import { cadenceLabel, decidedByLabel, type TreeSelection, type WorkOrder } from "./WorkbenchCanvas";
import { DecisionMark, HealthDot, StatusGlyph, TicketMark, type GlyphStatus } from "./parts";

export interface DrawerActions {
  onClose: () => void;
  onOpenChat: (botId: string, threadId?: string) => void;
  onOpenGroup: (groupId: string) => void;
  onNudge: (botId: string, text?: string) => void;
  onRetry: (runId: string, subtaskId: string) => void;
  onApprove: (runId: string) => void;
  onCancel: (runId: string) => void;
  onEditRules: () => void;
  onSelect: (selection: TreeSelection) => void;
}

export function TreeDrawer({ model, selection, orders, actions, width }: { model: WorkbenchModel; selection: NonNullable<TreeSelection>; orders: WorkOrder[]; actions: DrawerActions; width: number }) {
  let body: ReactNode = null;
  if (selection.kind === "dept") {
    const room = model.rooms.find((candidate) => candidate.section === selection.section);
    if (room) body = <DeptReport model={model} room={room} actions={actions} />;
  } else if (selection.kind === "decision") {
    const decision = model.decisions.find((candidate) => candidate.id === selection.id);
    if (decision) body = <DecisionView model={model} decision={decision} actions={actions} />;
  } else if (selection.kind === "order") {
    const order = orders.find((candidate) => candidate.key === selection.key);
    if (order) body = <OrderView model={model} order={order} actions={actions} />;
  } else if (selection.kind === "bot") {
    const bot = model.botById.get(selection.id);
    if (bot) body = <PersonView model={model} bot={bot} actions={actions} />;
  } else if (selection.kind === "squad") {
    const room = model.rooms.find((candidate) => candidate.section === selection.section);
    const members = room?.squads[selection.index - 1];
    if (room && members) body = <SquadView model={model} room={room} index={selection.index} members={members} actions={actions} />;
  } else if (selection.kind === "task") {
    body = <TaskView model={model} taskKey={selection.key} actions={actions} />;
  } else if (selection.kind === "root") {
    body = <RunsView model={model} actions={actions} />;
  }
  if (!body) return null;
  return (
    <aside className="animate-panel-in relative z-20 flex h-full shrink-0 flex-col border-l border-hairline/40 bg-stage shadow-[-18px_0_40px_-28px_rgb(16_24_40/0.35)]" style={{ width }} aria-label={t("Details")}>
      {body}
    </aside>
  );
}

function Shell({ title, icon, aside, onClose, children, footer, tabs }: { title: ReactNode; icon?: ReactNode; aside?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; tabs?: ReactNode }) {
  return (
    <>
      <header className="flex h-[54px] shrink-0 items-center gap-2 pr-2.5 pl-3">
        <button type="button" onClick={onClose} aria-label={t("Back")} className="grid size-[30px] place-items-center rounded-lg text-ink-secondary hover:bg-control hover:text-ink">
          <ChevronLeft size={18} />
        </button>
        {icon}
        <b className="min-w-0 truncate text-[15.5px] text-ink">{title}</b>
        {aside}
        <span className="flex-1" />
        <button type="button" onClick={onClose} aria-label={t("Close")} title={t("Close")} className="grid size-[30px] place-items-center rounded-lg text-ink-secondary hover:bg-control hover:text-ink">
          <PanelRightClose size={17} />
        </button>
      </header>
      {tabs}
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-[18px] pt-0.5 pb-3.5">{children}</div>
      {footer && <footer className="flex shrink-0 items-center gap-2.5 border-t border-hairline/30 px-[18px] py-[11px]">{footer}</footer>}
    </>
  );
}

const Cite = ({ n, onClick }: { n: number; onClick?: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    className="mx-px inline-grid h-4 min-w-4 place-items-center rounded-[4px] bg-select/12 px-[3px] align-[1px] text-[10px] font-bold text-accent-text hover:bg-select/20"
    aria-label={t("Source {n}", { n })}
  >
    {n}
  </button>
);

const HEALTH_PILL: Record<Health, { label: string; className: string }> = {
  green: { label: msg("Health green"), className: "bg-success/12 text-success" },
  yellow: { label: msg("Health yellow"), className: "bg-[#F5B000]/15 text-warning" },
  red: { label: msg("Health red"), className: "bg-danger/10 text-danger" },
};

// ── 汇报: a department's report ─────────────────────────────────────────────
interface ReportEntry {
  n: number;
  run: DispatchRun;
  subtask: DispatchSubtask;
  bot?: BotWithMeta;
  at: number;
}

function reportsOf(model: WorkbenchModel, room: Room): ReportEntry[] {
  const ids = new Set(room.everyone.map((bot) => bot.id));
  return model.dispatch.runs
    .filter((run) => isActiveRun(run) || run.status === "done" || run.status === "failed")
    .flatMap((run) =>
      run.subtasks
        .filter((subtask) => ids.has(subtask.assigneeBotId) && (subtask.status === "done" || subtask.status === "failed" || (subtask.status === "running" && subtask.startedAt) || (subtask.status === "pending" && subtask.error)))
        .map((subtask) => ({ run, subtask, bot: model.botById.get(subtask.assigneeBotId), at: subtask.finishedAt ?? subtask.startedAt ?? run.updatedAt })),
    )
    .sort((a, b) => b.at - a.at)
    .slice(0, 8)
    .map((entry, index) => ({ ...entry, n: index + 1 }));
}

function triggerOf(subtask: DispatchSubtask): string {
  if (subtask.status === "done") return t("reported when done");
  if (subtask.status === "failed" || subtask.error) return t("reported at once on trouble");
  return t("in progress");
}

function DeptReport({ model, room, actions }: { model: WorkbenchModel; room: Room; actions: DrawerActions }) {
  const [tab, setTab] = useState<"summary" | "reports" | "raw">("summary");
  const [open, setOpen] = useState<number | null>(1);
  const stats = model.stats.get(room.section);
  const reports = reportsOf(model, room);
  const cadence = model.org.rules.reportCadence;
  const lead = room.lead;
  const last = stats?.lastReportAt ?? reports[0]?.at;
  const next = last ? last + cadence.everyHours * 3_600_000 : undefined;
  const bullets: Array<{ text: string; cites: number[] }> = [];
  if (stats?.status) bullets.push({ text: stats.status, cites: reports.slice(0, 2).map((report) => report.n) });
  else if (stats && stats.total) bullets.push({ text: t("{done}/{total} done", { done: stats.done, total: stats.total }), cites: [] });
  for (const report of reports.slice(0, 5)) {
    const who = report.bot?.name ?? "?";
    const line =
      report.subtask.status === "done"
        ? t("{name} finished “{title}”", { name: who, title: clip(report.subtask.title, 14) })
        : report.subtask.status === "running"
          ? t("{name} is on “{title}”", { name: who, title: clip(report.subtask.title, 14) })
          : t("{name} could not finish “{title}”: {why}", { name: who, title: clip(report.subtask.title, 10), why: clip(report.subtask.error ?? t("Did not finish"), 14) });
    bullets.push({ text: line, cites: [report.n] });
  }
  const health = stats?.health;
  return (
    <Shell
      title={t("{department} · reports", { department: room.label || t("No department") })}
      icon={<i className="size-2.5 shrink-0 rounded-[3px]" style={{ background: room.color }} />}
      onClose={actions.onClose}
      tabs={
        <div className="flex shrink-0 items-center gap-2.5 px-[18px] pb-2.5">
          <Segmented
            size="sm"
            value={tab}
            onChange={setTab}
            label={t("Report view")}
            options={[
              { value: "summary", label: t("Summary") },
              { value: "reports", label: <span className="inline-flex items-center gap-1">{t("Reports")}<i className="grid h-4 min-w-4 place-items-center rounded-full bg-control px-1 text-[10.5px] font-bold text-ink not-italic">{reports.length}</i></span> },
              { value: "raw", label: t("Raw") },
            ]}
          />
          {next && <span className="ml-auto text-[12px] whitespace-nowrap text-ink-secondary/80">{t("Next summary {time}", { time: clock(next) })}</span>}
        </div>
      }
      footer={
        <>
          <Clock size={16} className="shrink-0 text-ink-secondary" />
          <span className="flex min-w-0 flex-1 flex-col leading-[1.4]">
            <span className="flex items-baseline gap-2 text-[12px] text-ink-secondary">
              <b className="text-[12.5px] text-ink">{t("Report rule")}</b>
              <span className="truncate">{cadenceLabel(cadence)}</span>
            </span>
            <span className="truncate text-[11.5px] text-ink-secondary">{t("Stuck {count} min escalates: employee → lead → chief → you", { count: model.org.rules.escalateAfterMin })}</span>
          </span>
          <Button variant="ghost" size="sm" onClick={actions.onEditRules}>
            {t("Change rule")}
          </Button>
        </>
      }
    >
      {tab === "summary" && (
        <>
          <div className="rounded-[14px] bg-inset px-[13px] pt-[11px] pb-3">
            <div className="flex items-center gap-[7px] whitespace-nowrap">
              {lead && <BotTile kind={model.mascotOf(lead)} size={18} />}
              <b className="text-[13.5px] text-ink">{lead?.name ?? (room.label || t("No department"))}</b>
              <span className="text-[12px] text-ink-secondary">{last ? t("{time} department summary", { time: clock(last) }) : t("No summary yet")}</span>
              {health && (
                <span className={cn("ml-auto inline-flex h-[22px] items-center gap-1 rounded-full px-2 text-[11.5px] font-bold", HEALTH_PILL[health].className)}>
                  <HealthDot health={health} size={7} />
                  {t(HEALTH_PILL[health].label)}
                </span>
              )}
            </div>
            {bullets.length ? (
              <ul className="mt-2 flex flex-col gap-[5px]">
                {bullets.map((bullet, index) => (
                  <li key={index} className="relative pl-3 text-[13px] leading-[1.55] text-ink before:absolute before:top-[9px] before:left-0.5 before:size-1 before:rounded-full before:bg-ink-secondary/60">
                    {bullet.text}
                    {bullet.cites.map((n) => (
                      <Cite key={n} n={n} onClick={() => setOpen(n)} />
                    ))}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-[12.5px] leading-relaxed text-ink-secondary">{t("Nothing reported yet. Reports arrive when work finishes, fails, or on the cadence below.")}</p>
            )}
          </div>
          {reports.length > 0 && <div className="text-[12px] font-bold whitespace-nowrap text-ink-secondary">{t("Cited reports · {count}", { count: reports.length })}</div>}
          {reports.map((report) => (
            <ReportCard key={report.n} model={model} report={report} open={open === report.n} onToggle={() => setOpen(open === report.n ? null : report.n)} actions={actions} />
          ))}
        </>
      )}
      {tab === "reports" &&
        (reports.length ? (
          reports.map((report) => <ReportCard key={report.n} model={model} report={report} open onToggle={() => undefined} actions={actions} />)
        ) : (
          <p className="text-[12.5px] text-ink-secondary">{t("No reports yet.")}</p>
        ))}
      {tab === "raw" &&
        (reports.length ? (
          reports.map((report) => (
            <div key={report.n} className="rounded-[12px] bg-inset px-3 py-2.5">
              <div className="mb-1 flex items-center gap-1.5 text-[12px] text-ink-secondary">
                <Cite n={report.n} />
                <b className="text-ink">{report.bot?.name ?? "?"}</b> · {clock(report.at)}
                <button type="button" className="ml-auto inline-flex items-center gap-1 font-semibold text-accent-text hover:underline" onClick={() => report.bot && actions.onOpenChat(report.bot.id, report.subtask.threadId)}>
                  {t("Open")} <ExternalLink size={11} />
                </button>
              </div>
              <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink">{report.subtask.result || report.subtask.error || report.subtask.brief}</p>
            </div>
          ))
        ) : (
          <p className="text-[12.5px] text-ink-secondary">{t("No reports yet.")}</p>
        ))}
    </Shell>
  );
}

function ReportCard({ model, report, open, onToggle, actions }: { model: WorkbenchModel; report: ReportEntry; open: boolean; onToggle: () => void; actions: DrawerActions }) {
  const { subtask, bot } = report;
  const pill =
    subtask.status === "done"
      ? { label: t("Passed ✓"), className: "bg-success/12 text-success" }
      : subtask.status === "running"
        ? { label: t("In progress"), className: "bg-select/12 text-accent-text" }
        : { label: t("Failed"), className: "bg-danger/10 text-danger" };
  const fields: Array<[string, ReactNode]> = [[t("What was done"), subtask.title]];
  if (subtask.result) fields.push([t("Result and evidence"), <span className="line-clamp-4 whitespace-pre-wrap">{subtask.result}</span>]);
  if (subtask.error) fields.push([t("Blocker"), <span className="font-semibold text-warning">{subtask.error}</span>]);
  if (subtask.acceptance) fields.push([t("Acceptance"), subtask.acceptance]);
  if (subtask.dependsOn.length) {
    const titles = subtask.dependsOn.map((id) => report.run.subtasks.find((entry) => entry.id === id)?.title ?? id);
    fields.push([t("Depends on"), titles.join(t(", "))]);
  }
  return (
    <div className={cn("rounded-[14px] bg-raised shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent)]", open ? "px-3 pt-[9px] pb-1.5" : "px-3 py-[9px]")}>
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-[7px] text-left whitespace-nowrap">
        <Cite n={report.n} />
        {bot && <BotTile kind={model.mascotOf(bot)} size={18} />}
        <b className="truncate text-[13.5px] text-ink">{bot?.name ?? "?"}</b>
        <span className="truncate text-[12px] text-ink-secondary">
          {clock(report.at)} · {triggerOf(subtask)}
        </span>
        <span className="flex-1" />
        <span className={cn("inline-flex h-[22px] shrink-0 items-center rounded-full px-2 text-[11.5px] font-bold", pill.className)}>{pill.label}</span>
        <ChevronDown size={14} className={cn("shrink-0 text-ink-secondary/70 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="mt-2">
          {fields.map(([label, value]) => (
            <div key={label} className="grid grid-cols-[62px_1fr] gap-2.5 border-t border-hairline/30 py-1.5 text-[12.5px] leading-[1.55]">
              <span className="text-[12px] whitespace-nowrap text-ink-secondary">{label}</span>
              <span className="min-w-0 text-ink">{value}</span>
            </div>
          ))}
          <div className="flex items-center gap-1.5 border-t border-hairline/30 py-1.5">
            {bot && (
              <Button variant="soft" size="sm" onClick={() => actions.onOpenChat(bot.id, subtask.threadId)}>
                <MessageSquare size={12} /> {t("Open the conversation")}
              </Button>
            )}
            {subtask.status === "failed" && (
              <Button variant="soft" size="sm" onClick={() => actions.onRetry(report.run.id, subtask.id)}>
                <RotateCcw size={12} /> {t("Retry")}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── 协作: a decision and its outputs ────────────────────────────────────────
function DecisionView({ model, decision, actions }: { model: WorkbenchModel; decision: OrgDecision; actions: DrawerActions }) {
  return (
    <Shell title={t("Decision #{id}", { id: decision.id })} icon={<DecisionMark size={16} />} onClose={actions.onClose}>
      <DecisionCard model={model} decision={decision} actions={actions} />
    </Shell>
  );
}

const ITEM_GLYPH: Record<OrgDecision["actionItems"][number]["status"], GlyphStatus> = { pending: "queue", running: "run", done: "done", failed: "fail" };

export function DecisionCard({ model, decision, actions }: { model: WorkbenchModel; decision: OrgDecision; actions: DrawerActions }) {
  const group = decision.source.kind === "group" ? model.groups.find((candidate) => candidate.id === decision.source.id) : undefined;
  const members = (group?.memberIds ?? []).map((id) => model.botById.get(id)).filter((bot): bot is BotWithMeta => Boolean(bot));
  const done = decision.actionItems.filter((item) => item.status === "done").length;
  const kv = (label: string, value: ReactNode) => (
    <div className="grid grid-cols-[58px_1fr] gap-2.5 text-[13px] leading-[1.55]">
      <span className="pt-px text-[12px] whitespace-nowrap text-ink-secondary">{label}</span>
      <span className="min-w-0 text-ink">{value}</span>
    </div>
  );
  return (
    <div className="flex flex-col gap-[7px] rounded-[14px] bg-raised px-[13px] pt-[11px] pb-2.5 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent)]">
      <div className="flex items-center gap-[7px] whitespace-nowrap">
        <DecisionMark size={14} />
        <b className="text-[13.5px] text-ink">{t("Decision #{id}", { id: decision.id })}</b>
        <span className="truncate text-[12px] text-ink-secondary">
          {group ? `${group.name} · ` : ""}
          {clock(decision.at)}
        </span>
        <span className="flex-1" />
        <span className="inline-flex h-[22px] items-center rounded-full bg-control px-2 text-[11.5px] font-bold text-ink">{t("Action items {done}/{total}", { done, total: decision.actionItems.length })}</span>
      </div>
      {members.length > 0 &&
        kv(
          t("{count} attended", { count: members.length }),
          <span className="flex items-center gap-[7px] whitespace-nowrap">
            <span className="flex">
              {members.slice(0, 5).map((bot, index) => (
                <span key={bot.id} style={{ marginLeft: index ? -3 : 0 }}>
                  <BotTile kind={model.mascotOf(bot)} size={16} chief={bot.id === model.chief?.id} />
                </span>
              ))}
            </span>
            <span className="truncate">{members.map((bot) => bot.name).join(t(", "))}</span>
          </span>,
        )}
      {kv(t("Question"), decision.title)}
      {kv(
        t("Outcome"),
        <span>
          <b>{decision.choice}</b>
          {decision.decidedBy === "owner" ? t(", you decided at {time}", { time: clock(decision.at) }) : ` · ${decidedByLabel(decision.decidedBy)}`}
        </span>,
      )}
      {decision.basis?.length ? kv(t("Based on"), decision.basis.join(t(", "))) : null}
      {kv(t("{count} action items", { count: decision.actionItems.length }), <span className="text-[12px] text-ink-secondary">{t("Each became a task tagged “from decision #{id}”", { id: decision.id })}</span>)}
      <div className="-mt-0.5 flex flex-col gap-1">
        {decision.actionItems.map((item, index) => {
          const bot = item.botId ? model.botById.get(item.botId) : undefined;
          return (
            <button
              key={index}
              type="button"
              onClick={() => bot && actions.onOpenChat(bot.id)}
              className="flex h-8 items-center gap-2 rounded-[9px] bg-inset px-2.5 text-left whitespace-nowrap hover:bg-control/60"
            >
              {bot && <BotTile kind={model.mascotOf(bot)} size={16} />}
              <span className="min-w-0 truncate text-[12.5px] text-ink-secondary">
                {bot && <b className="text-ink">{bot.name}</b>}
                {bot ? " · " : ""}
                {item.title}
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-[5px] text-[11.5px] text-ink-secondary">
                <StatusGlyph status={ITEM_GLYPH[item.status]} />
              </span>
            </button>
          );
        })}
      </div>
      {group && (
        <Button variant="link" size="sm" className="self-start" onClick={() => actions.onOpenGroup(group.id)}>
          {t("Open {name}", { name: group.name })}
        </Button>
      )}
    </div>
  );
}

// ── 协作: a work order between departments ──────────────────────────────────
function OrderView({ model, order, actions }: { model: WorkbenchModel; order: WorkOrder; actions: DrawerActions }) {
  const from = model.botById.get(order.fromBotId);
  const to = model.botById.get(order.toBotId);
  const fromRoom = model.roomOf.get(order.fromBotId);
  const toRoom = model.roomOf.get(order.toBotId);
  const steps: Array<{ label: string; state: "done" | "now" | "todo" }> = [
    { label: t("Raised"), state: "done" },
    { label: t("Taken on"), state: order.state === "running" ? "done" : "now" },
    { label: t("Being done"), state: order.state === "running" ? "now" : "todo" },
    { label: t("Hand-over"), state: "todo" },
    { label: t("Checked"), state: "todo" },
  ];
  const who = (bot: BotWithMeta | undefined, room: Room | undefined) => (
    <span className="flex items-center gap-[7px]">
      {bot && <BotTile kind={model.mascotOf(bot)} size={22} />}
      <span className="flex flex-col leading-[1.4] whitespace-nowrap">
        <em className="text-[11px] text-ink-secondary not-italic">{room?.label || t("No department")}</em>
        <b className="text-[13px] text-ink">{bot?.name ?? "?"}</b>
      </span>
    </span>
  );
  // the decision this order serves, when the target's work came from one
  const decision = model.decisions.find((entry) => entry.actionItems.some((item) => item.botId === order.toBotId || item.botId === order.fromBotId));
  return (
    <Shell
      title={t("Work order")}
      icon={<span className="grid size-[26px] shrink-0 place-items-center rounded-lg bg-select/12 text-accent-text"><TicketMark /></span>}
      aside={<span className="inline-flex h-[22px] shrink-0 items-center rounded-full bg-select/12 px-2 text-[11.5px] font-bold text-accent-text">{order.state === "running" ? t("Accepted · in progress") : t("Waiting to be accepted")}</span>}
      onClose={actions.onClose}
    >
      <div className="flex items-center gap-2.5 rounded-xl bg-inset px-3 py-[9px]">
        {who(from, fromRoom)}
        <ArrowRight size={16} className="shrink-0 text-ink-secondary/70" />
        {who(to, toRoom)}
      </div>
      <div className="grid grid-cols-[58px_1fr] gap-2.5 text-[13px] leading-[1.55]">
        <span className="text-[12px] text-ink-secondary">{t("Asks for")}</span>
        <span className="text-ink">{order.reason || t("(no description)")}</span>
      </div>
      <div className="mt-0.5 text-[12px] font-bold text-ink-secondary">{t("Progress")}</div>
      <div className="relative grid grid-cols-5">
        <i className="absolute top-[9px] right-[10%] left-[10%] h-0.5 bg-control" />
        {steps.map((step) => (
          <div key={step.label} className="relative flex flex-col items-center gap-0.5 text-center whitespace-nowrap">
            <i
              className={cn(
                "relative mb-1 grid size-5 place-items-center rounded-full",
                step.state === "done" ? "bg-success text-white" : step.state === "now" ? "bg-raised shadow-[inset_0_0_0_5px_var(--color-select),0_0_0_4px_color-mix(in_srgb,var(--color-select)_15%,transparent)]" : "bg-raised shadow-[inset_0_0_0_1.5px_color-mix(in_oklab,var(--color-hairline)_80%,transparent)]",
              )}
            >
              {step.state === "done" && <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden><path d="M3.5 8.3l3 3 6-6.2" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>}
            </i>
            <b className={cn("text-[12px] leading-[1.3]", step.state === "now" ? "text-accent-text" : step.state === "todo" ? "font-semibold text-ink-secondary" : "text-ink")}>{step.label}</b>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        {to && (
          <Button size="sm" onClick={() => actions.onNudge(to.id, t("About the work order from {name}: {reason} — how is it going?", { name: from?.name ?? "?", reason: order.reason || t("(no description)") }))}>
            {t("Nudge")}
          </Button>
        )}
        {to && (
          <Button variant="soft" size="sm" onClick={() => actions.onOpenChat(to.id, order.threadId)}>
            {t("Open the conversation")}
          </Button>
        )}
      </div>
      {decision && (
        <>
          <div className="my-1 h-px bg-hairline/30" />
          <div className="text-[12px] font-bold text-ink-secondary">{t("Where this order came from")}</div>
          <DecisionCard model={model} decision={decision} actions={actions} />
        </>
      )}
    </Shell>
  );
}

// ── a person, a squad, an output, the runs ──────────────────────────────────
function PersonView({ model, bot, actions }: { model: WorkbenchModel; bot: BotWithMeta; actions: DrawerActions }) {
  const state = model.states.get(bot.id);
  const room = model.roomOf.get(bot.id);
  const subtask = state?.subtask;
  return (
    <Shell title={bot.name} icon={<BotTile kind={model.mascotOf(bot)} size={24} chief={bot.id === model.chief?.id} />} onClose={actions.onClose}>
      <div className="flex items-center gap-2 text-[12.5px] text-ink-secondary">
        {room && <i className="size-2 rounded-[2px]" style={{ background: room.color }} />}
        {room?.label || t("No department")} · {bot.title || t("Team member")}
      </div>
      {state && (
        <div className="rounded-[14px] bg-inset px-3 py-2.5">
          <div className="text-[12px] font-bold text-ink-secondary">{t("Now")}</div>
          <div className="mt-0.5 text-[14px] font-semibold text-ink">{state.line}</div>
          {state.bubble && <div className="mt-0.5 text-[12.5px] text-ink-secondary">{state.bubble.lines.join(" ")}</div>}
        </div>
      )}
      {subtask && (
        <div className="flex flex-col gap-1.5 rounded-[14px] bg-raised px-3 py-2.5 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent)]">
          <div className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
            <FileText size={13} className="text-ink-secondary" /> {subtask.title}
          </div>
          <p className="text-[12.5px] leading-relaxed text-ink-secondary">{clip(subtask.brief, 220)}</p>
          {subtask.result && <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink">{clip(subtask.result, 400)}</p>}
          {subtask.error && <p className="text-[12.5px] font-semibold text-danger">{subtask.error}</p>}
          {subtask.startedAt && <p className="text-[11.5px] text-ink-secondary">{t("Started {time}", { time: ago(subtask.startedAt, model.now) })}</p>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" onClick={() => actions.onOpenChat(bot.id, subtask?.threadId)}>
          <MessageSquare size={12} /> {t("Open the conversation")}
        </Button>
        {state?.status === "failed" && state.run && subtask && (
          <Button variant="soft" size="sm" onClick={() => actions.onRetry(state.run!.id, subtask.id)}>
            <RotateCcw size={12} /> {t("Retry")}
          </Button>
        )}
        {(state?.status === "working" || state?.status === "blocked") && (
          <Button variant="soft" size="sm" onClick={() => actions.onNudge(bot.id)}>
            {t("Nudge")}
          </Button>
        )}
      </div>
    </Shell>
  );
}

function SquadView({ model, room, index, members, actions }: { model: WorkbenchModel; room: Room; index: number; members: BotWithMeta[]; actions: DrawerActions }) {
  return (
    <Shell title={`${room.label} · ${squadName(index)}`} icon={<i className="size-2.5 shrink-0 rounded-[3px] bg-[#8B5CF6]" />} onClose={actions.onClose}>
      <p className="text-[12.5px] leading-relaxed text-ink-secondary">{t("A lead manages at most {count} people directly; newcomers form a squad whose lead reports for the squad.", { count: model.span })}</p>
      {members.map((bot) => {
        const state = model.states.get(bot.id);
        return (
          <button key={bot.id} type="button" onClick={() => actions.onSelect({ kind: "bot", id: bot.id })} className="flex items-center gap-2.5 rounded-xl bg-inset px-3 py-2 text-left hover:bg-control/60">
            <BotTile kind={model.mascotOf(bot)} size={24} />
            <span className="min-w-0 flex-1">
              <b className="block truncate text-[13px] text-ink">{bot.name}</b>
              <span className="block truncate text-[12px] text-ink-secondary">{state?.line}</span>
            </span>
          </button>
        );
      })}
    </Shell>
  );
}

function TaskView({ model, taskKey, actions }: { model: WorkbenchModel; taskKey: string; actions: DrawerActions }) {
  const [, kind, a, b] = /^(task|derived):([^:]+):(.+)$/.exec(taskKey) ?? [];
  if (kind === "derived") {
    const decision = model.decisions.find((entry) => String(entry.id) === a);
    if (decision) return <DecisionView model={model} decision={decision} actions={actions} />;
  }
  const run = model.dispatch.runs.find((entry) => entry.id === a);
  const subtask = run?.subtasks.find((entry) => entry.id === b);
  const bot = subtask ? model.botById.get(subtask.assigneeBotId) : undefined;
  if (!run || !subtask) return null;
  return (
    <Shell title={subtask.title} onClose={actions.onClose}>
      <div className="text-[12.5px] text-ink-secondary">{bot?.name} · {run.goal}</div>
      <p className="text-[13px] leading-relaxed text-ink">{subtask.brief}</p>
      {subtask.result && <p className="rounded-xl bg-inset px-3 py-2 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink">{clip(subtask.result, 600)}</p>}
      {subtask.error && <p className="text-[12.5px] font-semibold text-danger">{subtask.error}</p>}
      <div className="flex items-center gap-1.5">
        {bot && (
          <Button size="sm" onClick={() => actions.onOpenChat(bot.id, subtask.threadId)}>
            <MessageSquare size={12} /> {t("Open the conversation")}
          </Button>
        )}
        {subtask.status === "failed" && (
          <Button variant="soft" size="sm" onClick={() => actions.onRetry(run.id, subtask.id)}>
            <RotateCcw size={12} /> {t("Retry")}
          </Button>
        )}
      </div>
    </Shell>
  );
}

function RunsView({ model, actions }: { model: WorkbenchModel; actions: DrawerActions }) {
  const chief = model.chief;
  return (
    <Shell title={t("{name} · dispatches", { name: chief?.name ?? t("Chief") })} icon={chief ? <BotTile kind={model.mascotOf(chief)} size={22} chief /> : undefined} onClose={actions.onClose}>
      <RunList
        runs={model.dispatch.runs}
        bots={model.bots}
        onApprove={actions.onApprove}
        onCancel={actions.onCancel}
        onRetry={actions.onRetry}
        onOpenSubtask={(subtask) => actions.onOpenChat(subtask.assigneeBotId, subtask.threadId)}
        onOpenChat={(botId) => actions.onOpenChat(botId)}
      />
    </Shell>
  );
}
