// Right-hand inspector: details for whatever is selected on the canvas —
// the whole team, one bot (with model recommendations), or one cable.
import { useMemo, useState } from "react";
import { ArrowRight, Cable, Crown, ExternalLink, MessageSquare, Sparkles, Unplug, Undo2, Wand2 } from "lucide-react";

import { BotAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import { t, tn } from "@/lib/i18n";
import { teamMapStatus } from "@/lib/team-map";
import { runProgress, type Wire } from "@/lib/workbench";
import type { Bot, InstanceInfo } from "@/state/store";
import type { DispatchRun, DispatchSettings, DispatchSubtask } from "../../../shared/dispatch-types";
import { difficultyLabel, policyLabel, recommendForText, type Recommendation } from "../../../shared/model-recommender";

import type { CanvasSelection } from "./WorkbenchCanvas";

interface Props {
  selection: CanvasSelection;
  bots: Bot[];
  wires: Wire[];
  runs: DispatchRun[];
  instances: InstanceInfo[];
  settings: DispatchSettings;
  modelLabel: (bot: Bot) => string;
  onOpenChat: (botId: string) => void;
  onOpenSubtask: (subtask: DispatchSubtask) => void;
  onToggleChief: (bot: Bot) => void;
  onApplyModel: (bot: Bot, recommendation: Recommendation) => void;
  onUnplug: (wire: Wire) => void;
  onReset: (wire: Wire) => void;
  onSendTask: (chiefId: string, text: string) => void;
}

const SUBTASK_TONE: Record<DispatchSubtask["status"], string> = {
  pending: "bg-control text-ink-secondary",
  running: "bg-accent/15 text-accent-text",
  done: "bg-success/15 text-success",
  failed: "bg-danger/15 text-danger",
  skipped: "bg-control text-ink-secondary",
  canceled: "bg-control text-ink-secondary",
};

export function subtaskStatusLabel(status: DispatchSubtask["status"]): string {
  return {
    pending: t("Waiting"),
    running: t("Running"),
    done: t("Done"),
    failed: t("Failed"),
    skipped: t("Skipped"),
    canceled: t("Canceled"),
  }[status];
}

export function SubtaskPill({ status }: { status: DispatchSubtask["status"] }) {
  return <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium", SUBTASK_TONE[status])}>{subtaskStatusLabel(status)}</span>;
}

export function WorkbenchInspector(props: Props) {
  const { selection, bots } = props;
  const bot = selection?.kind === "bot" ? bots.find((candidate) => candidate.id === selection.id) : undefined;
  const wire =
    selection?.kind === "wire"
      ? props.wires.find((candidate) => candidate.fromBotId === selection.from && candidate.toBotId === selection.to)
      : undefined;
  return (
    <aside className="flex w-[320px] shrink-0 flex-col overflow-hidden border-l border-hairline/40 bg-panel/80 backdrop-blur-xl max-lg:hidden">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {bot ? <BotInspector {...props} bot={bot} /> : wire ? <WireInspector {...props} wire={wire} /> : <Overview {...props} />}
      </div>
    </aside>
  );
}

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="mb-5">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-secondary">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Overview(props: Props) {
  const visible = props.bots.filter((bot) => !bot.hidden);
  const chiefs = visible.filter((bot) => bot.chiefOfStaff);
  const working = visible.filter((bot) => bot.busy || bot.activity === "working").length;
  const waiting = visible.filter((bot) => bot.activity === "waiting-on-you");
  const active = props.runs.filter((run) => run.status === "running" || run.status === "synthesizing" || run.status === "awaiting-approval");
  return (
    <>
      <div className="mb-4 grid grid-cols-3 gap-2">
        {[
          [visible.length, t("Bots")],
          [working, t("Working")],
          [active.length, t("Dispatches")],
        ].map(([value, label]) => (
          <div key={String(label)} className="rounded-xl border border-hairline/40 bg-card px-3 py-2.5">
            <div className="text-[18px] font-semibold tabular-nums">{value}</div>
            <div className="text-[11px] text-ink-secondary">{label}</div>
          </div>
        ))}
      </div>

      {waiting.length > 0 && (
        <Section title={t("Waiting for you")}>
          <div className="space-y-1.5">
            {waiting.map((bot) => (
              <button
                key={bot.id}
                type="button"
                onClick={() => props.onOpenChat(bot.id)}
                className="flex w-full items-center gap-2.5 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-2 text-left hover:bg-warning/15"
              >
                <BotAvatar bot={bot} size={24} motion="none" motionKey={0} animated={false} />
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{bot.name}</span>
                <span className="text-[11px] text-warning">{t("Review")}</span>
              </button>
            ))}
          </div>
        </Section>
      )}

      <Section title={t("Chiefs")}>
        {chiefs.length ? (
          <div className="space-y-2">
            {chiefs.map((chief) => (
              <ChiefComposer key={chief.id} chief={chief} onSend={props.onSendTask} />
            ))}
          </div>
        ) : (
          <p className="rounded-xl border border-dashed border-hairline px-3 py-3 text-[12px] leading-relaxed text-ink-secondary">
            {t("No Chief yet. Right-click a bot on the canvas and choose “Make Chief of Staff” — the Chief splits your tasks and dispatches them to the team.")}
          </p>
        )}
      </Section>

      <Section title={t("How the workbench works")}>
        <ul className="space-y-2 text-[12px] leading-relaxed text-ink-secondary">
          <li className="flex gap-2"><Cable size={13} className="mt-0.5 shrink-0 text-accent" />{t("Drag from a Chief's Dispatch plug to any bot's socket to connect them. Select a cable and press ⌫ to unplug it.")}</li>
          <li className="flex gap-2"><Sparkles size={13} className="mt-0.5 shrink-0 text-accent" />{t("Give the Chief a task: it splits the work, assigns or creates specialists with recommended models, and reports back when everything is done.")}</li>
          <li className="flex gap-2"><Wand2 size={13} className="mt-0.5 shrink-0 text-accent" />{t("Pinch or ⌘-scroll to zoom, two-finger scroll to pan, ⌘0 to fit, ⌘Z to undo.")}</li>
        </ul>
      </Section>

      <Section title={t("Dispatch settings")}>
        <div className="rounded-xl border border-hairline/40 bg-card px-3 py-2.5 text-[12px] text-ink-secondary">
          <div className="flex justify-between"><span>{t("Automatic dispatch")}</span><span className="text-ink">{props.settings.enabled ? t("On") : t("Off")}</span></div>
          <div className="mt-1 flex justify-between"><span>{t("Model strategy")}</span><span className="text-ink">{policyLabel(props.settings.policy)}</span></div>
          <div className="mt-1 flex justify-between"><span>{t("Create specialists")}</span><span className="text-ink">{props.settings.autoCreate ? t("On") : t("Off")}</span></div>
          <div className="mt-1 flex justify-between"><span>{t("Parallel subtasks")}</span><span className="text-ink tabular-nums">{props.settings.maxConcurrent}</span></div>
        </div>
      </Section>
    </>
  );
}

function ChiefComposer({ chief, onSend }: { chief: Bot; onSend: (chiefId: string, text: string) => void }) {
  const [text, setText] = useState("");
  const send = () => {
    const value = text.trim();
    if (!value) return;
    onSend(chief.id, value);
    setText("");
  };
  return (
    <div className="rounded-xl border border-hairline/50 bg-card p-2.5">
      <div className="mb-2 flex items-center gap-2">
        <BotAvatar bot={chief} size={22} motion="none" motionKey={0} animated={false} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">{chief.name}</span>
        <Crown size={12} className="text-warning" />
      </div>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            send();
          }
        }}
        rows={3}
        placeholder={t("Describe a task for {name} to split up and dispatch…", { name: chief.name })}
        className="w-full resize-none rounded-lg border border-hairline/60 bg-inset px-2.5 py-2 text-[12.5px] leading-relaxed text-ink outline-none placeholder:text-ink-secondary/60 focus:border-accent/60"
      />
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-[10.5px] text-ink-secondary">{t("⌘↩ to send")}</span>
        <button
          type="button"
          disabled={!text.trim()}
          onClick={send}
          className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-40"
        >
          {t("Dispatch")} <ArrowRight size={12} />
        </button>
      </div>
    </div>
  );
}

function BotInspector(props: Props & { bot: Bot }) {
  const { bot } = props;
  const status = teamMapStatus(bot);
  const advice = useMemo(
    () =>
      recommendForText(
        `${bot.title}\n${bot.description}`,
        props.instances,
        props.settings.policy,
        {},
        { limit: 3 },
      ),
    [bot.title, bot.description, props.instances, props.settings.policy],
  );
  const history = props.runs
    .flatMap((run) => run.subtasks.filter((subtask) => subtask.assigneeBotId === bot.id).map((subtask) => ({ run, subtask })))
    .slice(0, 6);
  const team = props.wires.filter((wire) => wire.fromBotId === bot.id);
  const current = bot.modelSelection;
  return (
    <>
      <div className="mb-4 flex items-center gap-3">
        <BotAvatar bot={bot} size={48} motion="none" motionKey={0} animated={false} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h2 className="truncate text-[16px] font-semibold">{bot.name}</h2>
            {bot.chiefOfStaff && <Crown size={13} className="shrink-0 text-warning" />}
          </div>
          <div className="truncate text-[12px] text-ink-secondary">{bot.title || t("No role yet")}</div>
          <div className="mt-0.5 text-[11.5px] text-ink-secondary">
            {bot.section?.trim() || t("General")} · <span className={status.tone === "warning" ? "text-warning" : undefined}>{t(status.label)}</span>
          </div>
        </div>
      </div>
      <div className="mb-5 grid grid-cols-2 gap-2">
        <button type="button" onClick={() => props.onOpenChat(bot.id)} className="flex items-center justify-center gap-1.5 rounded-lg border border-hairline/60 bg-card py-2 text-[12px] hover:bg-raised">
          <MessageSquare size={13} /> {t("Open chat")}
        </button>
        <button type="button" onClick={() => props.onToggleChief(bot)} className="flex items-center justify-center gap-1.5 rounded-lg border border-hairline/60 bg-card py-2 text-[12px] hover:bg-raised">
          <Crown size={13} /> {bot.chiefOfStaff ? t("Remove Chief") : t("Make Chief")}
        </button>
      </div>

      {bot.chiefOfStaff && (
        <Section title={t("Give a task")}>
          <ChiefComposer chief={bot} onSend={props.onSendTask} />
          <p className="mt-2 text-[11.5px] text-ink-secondary">{tn(team.length, "Connected to {count} team member", "Connected to {count} team members")}</p>
        </Section>
      )}

      <Section title={t("Model")}>
        <div className="rounded-xl border border-hairline/40 bg-card px-3 py-2.5">
          <div className="text-[12.5px] font-medium">{props.modelLabel(bot)}</div>
          <div className="text-[11px] text-ink-secondary">{current.effort ? t("Reasoning effort: {effort}", { effort: current.effort }) : t("Engine default effort")}</div>
        </div>
      </Section>

      <Section title={t("Recommended for this role")} aside={<span className="text-[10.5px] text-ink-secondary">{difficultyLabel(advice.task.difficulty)}</span>}>
        {advice.recommendations.length ? (
          <div className="space-y-2">
            {advice.recommendations.map((recommendation, index) => {
              const inUse = recommendation.instanceId === current.instanceId && recommendation.model === current.model;
              return (
                <div key={`${recommendation.instanceId}/${recommendation.model}`} className={cn("rounded-xl border bg-card px-3 py-2.5", index === 0 ? "border-accent/45" : "border-hairline/40")}>
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        {index === 0 && <Sparkles size={12} className="shrink-0 text-accent" />}
                        <span className="truncate text-[12.5px] font-medium">{recommendation.modelLabel}</span>
                      </div>
                      <div className="truncate text-[11px] text-ink-secondary">
                        {recommendation.engineName}
                        {recommendation.effort ? ` · ${recommendation.effort}` : ""}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={inUse}
                      onClick={() => props.onApplyModel(bot, recommendation)}
                      className="shrink-0 rounded-md border border-hairline/60 px-2 py-0.5 text-[11px] hover:bg-raised disabled:border-transparent disabled:text-success"
                    >
                      {inUse ? t("In use") : t("Use")}
                    </button>
                  </div>
                  <ul className="mt-1.5 space-y-0.5">
                    {recommendation.reasons.slice(0, 3).map((reason) => (
                      <li key={reason} className="text-[11px] leading-snug text-ink-secondary">· {reason}</li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-[12px] text-ink-secondary">{t("No engine that can run this role is signed in yet. Set one up in App Settings → Engines.")}</p>
        )}
      </Section>

      <Section title={t("Dispatched work")}>
        {history.length ? (
          <div className="space-y-1.5">
            {history.map(({ run, subtask }) => (
              <button
                key={`${run.id}/${subtask.id}`}
                type="button"
                disabled={!subtask.threadId}
                onClick={() => props.onOpenSubtask(subtask)}
                className="flex w-full items-center gap-2 rounded-lg border border-hairline/40 bg-card px-2.5 py-2 text-left hover:bg-raised disabled:hover:bg-card"
              >
                <span className="min-w-0 flex-1 truncate text-[12px]">{subtask.title}</span>
                <SubtaskPill status={subtask.status} />
                {subtask.threadId && <ExternalLink size={11} className="shrink-0 text-ink-secondary" />}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-[12px] text-ink-secondary">{t("Nothing dispatched to this bot yet.")}</p>
        )}
      </Section>
    </>
  );
}

function WireInspector(props: Props & { wire: Wire }) {
  const { wire } = props;
  const from = props.bots.find((bot) => bot.id === wire.fromBotId);
  const to = props.bots.find((bot) => bot.id === wire.toBotId);
  const traffic = props.runs
    .flatMap((run) => (run.chiefBotId === wire.fromBotId ? run.subtasks.filter((subtask) => subtask.assigneeBotId === wire.toBotId).map((subtask) => ({ run, subtask })) : []))
    .slice(0, 5);
  if (!from || !to) return null;
  return (
    <>
      <div className="mb-4 flex items-center gap-2 rounded-xl border border-hairline/40 bg-card px-3 py-3">
        <BotAvatar bot={from} size={28} motion="none" motionKey={0} animated={false} />
        <span className="min-w-0 truncate text-[12.5px] font-medium">{from.name}</span>
        <ArrowRight size={14} className="shrink-0 text-accent" />
        <BotAvatar bot={to} size={28} motion="none" motionKey={0} animated={false} />
        <span className="min-w-0 truncate text-[12.5px] font-medium">{to.name}</span>
      </div>
      <p className="mb-4 text-[12px] leading-relaxed text-ink-secondary">
        {wire.kind === "default"
          ? t("Connected by default: both bots are in the same section.")
          : t("Connected by hand on the workbench.")}
      </p>
      <div className="mb-5 grid grid-cols-2 gap-2">
        <button type="button" onClick={() => props.onUnplug(wire)} className="flex items-center justify-center gap-1.5 rounded-lg border border-danger/40 bg-danger/10 py-2 text-[12px] text-danger hover:bg-danger/15">
          <Unplug size={13} /> {t("Unplug")}
        </button>
        <button
          type="button"
          disabled={wire.kind === "default"}
          onClick={() => props.onReset(wire)}
          className="flex items-center justify-center gap-1.5 rounded-lg border border-hairline/60 bg-card py-2 text-[12px] hover:bg-raised disabled:opacity-40"
        >
          <Undo2 size={13} /> {t("Reset to default")}
        </button>
      </div>
      <Section title={t("Recent work on this cable")}>
        {traffic.length ? (
          <div className="space-y-1.5">
            {traffic.map(({ run, subtask }) => {
              const progress = runProgress(run);
              return (
                <button
                  key={`${run.id}/${subtask.id}`}
                  type="button"
                  disabled={!subtask.threadId}
                  onClick={() => props.onOpenSubtask(subtask)}
                  className="flex w-full items-center gap-2 rounded-lg border border-hairline/40 bg-card px-2.5 py-2 text-left hover:bg-raised"
                >
                  <span className="min-w-0 flex-1 truncate text-[12px]">{subtask.title}</span>
                  <span className="text-[10.5px] tabular-nums text-ink-secondary">{progress.done}/{progress.total}</span>
                  <SubtaskPill status={subtask.status} />
                </button>
              );
            })}
          </div>
        ) : (
          <p className="text-[12px] text-ink-secondary">{t("No dispatched work on this cable yet.")}</p>
        )}
      </Section>
    </>
  );
}
