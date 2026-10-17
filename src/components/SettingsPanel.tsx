// Bot settings (U11): the right-hand panel for one bot. On top, the bot as
// its engine's mascot with its name plate; then name, tag and description;
// engine and department; permissions; notifications, memory and skills.
// Everything else a bot has (avatar image, effort, the full computer choice,
// auto-review, voice, usage, working folder, the memory editor and learned
// skills) sits under "More settings" or in the … menu.
import { BookOpen, ChevronDown, ChevronLeft, ChevronRight, Crown, FolderOpen, Lock, MoreHorizontal, PanelRightClose, Plus, Sparkles, Trash2, Wand2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, useStore, type Bot } from "@/state/store";
import { useOrg } from "@/state/org-api";
import { chiefBot, buildDepartments } from "@/lib/org";
import { stateForBot } from "@/lib/mascot";
import { MASCOT_BODY, MASCOT_BRAND, mascotForBot } from "@/lib/engine-mascots";
import { Mascot, BotTile } from "@/components/mascot/Mascot";
import { Pill, Segmented } from "@/components/ui";
import { CloudBackendPicker } from "./CloudBackendPicker";
import { ModelPicker } from "./ModelPicker";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { cn } from "@/lib/cn";
import { builtInBrowserEnabled, skillRecorderEnabled } from "@/lib/feature-flags";
import { requestNotificationPermission } from "@/lib/notify";
import { botUsage, costCaption, formatTokens, formatUsd, hasFiniteCost } from "@/lib/usage";
import { shortPath } from "@/lib/short-path";
import { instanceSupportsLocalComputer, localComputerDisabledReason, localComputerSelectable } from "@/lib/local-computer";
import { BotProfileAvatarCard } from "./BotProfileAvatarCard";
import { BotAvatar } from "./Avatar";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import { VoiceSettings } from "./VoiceSettings";
import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile";
import { Switch } from "./SettingsPrimitives";
import { msg, t, tn, tRich } from "@/lib/i18n";
import { useAppCatalog } from "./settings/app-catalog";
import { countMemoryNotes, heroStatus, superiorOf, teamSize } from "./settings/bot-panel-model";
import { recommendedFor } from "./settings/engine-model";
import { FieldLabel, MarkTile, RowGroup, SettingRow, inputClass } from "./settings/parts";

/** A bordered sub-card inside the panel (the panel itself is the white stage). */
const cardCls = "rounded-xl p-3.5 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent)]";
const cardTitle = "text-[13.5px] font-semibold text-ink";
const cardSub = "mt-0.5 text-[12px] leading-relaxed text-ink-secondary";

/** What this bot has spent across its tasks. Cost is captioned by how the
 * engine is billed — on a subscription the figure is an equivalent. */
function BotUsageCard({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const usage = botUsage(bot);
  const instance = state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId);
  if (usage.turns === 0) {
    return (
      <div className={cardCls}>
        <div className={cardTitle}>{t("Usage")}</div>
        <div className={cardSub}>{t("Nothing spent yet — figures appear after a bot's first turn.")}</div>
      </div>
    );
  }
  return (
    <div className={cardCls}>
      <div className="flex items-baseline justify-between">
        <div className={cardTitle}>{t("Usage")}</div>
        <button
          onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "usage" })}
          className="text-[12px] text-ink-secondary hover:text-ink"
        >
          {t("All bots →")}
        </button>
      </div>
      <div className="mt-2.5 grid grid-cols-3 gap-3 text-[13px]">
        <div>
          <div className="text-[11.5px] text-ink-secondary">{t("Turns")}</div>
          <div className="mt-0.5 tabular-nums text-ink">{usage.turns}</div>
        </div>
        <div>
          <div className="text-[11.5px] text-ink-secondary">{t("Tokens")}</div>
          <div className="mt-0.5 tabular-nums text-ink" title={`${t("{input} in", { input: formatTokens(usage.input) })} · ${t("{output} out", { output: formatTokens(usage.output) })}`}>
            {formatTokens(usage.input + usage.output)}
          </div>
        </div>
        <div>
          <div className="text-[11.5px] text-ink-secondary">{t("Cost")}</div>
          <div className="mt-0.5 tabular-nums text-ink">{hasFiniteCost(usage.costUsd) ? formatUsd(usage.costUsd) : "—"}</div>
        </div>
      </div>
      <div className="mt-2 text-[12px] text-ink-secondary">
        {hasFiniteCost(usage.costUsd) ? t("Cost {caption}.", { caption: costCaption(instance?.snapshot.billing) }) : t("This engine doesn't report a price; tokens are counted.")}
      </div>
    </div>
  );
}

interface ManagedSkill {
  name: string;
  description: string;
  enabled: boolean;
  source: string;
  warnings: string[];
}

interface StagedSkillSummary {
  id: string;
  name: string;
  gist: string;
}

/** The bot's installed skills, read once per bot for the Skills row. */
function useBotSkills(botId: string): ManagedSkill[] | null {
  const [skills, setSkills] = useState<ManagedSkill[] | null>(null);
  useEffect(() => {
    let alive = true;
    setSkills(null);
    api(`/api/bots/${botId}/skills`)
      .then((result: { skills?: ManagedSkill[] }) => alive && setSkills(result.skills ?? []))
      .catch(() => alive && setSkills([]));
    return () => {
      alive = false;
    };
  }, [botId]);
  return skills;
}

/** Skills are durable behavior, so the user needs a normal way to inspect,
 * disable, and remove them after the one-time approval card is gone. */
function LearnedSkillsCard({ bot }: { bot: Bot }) {
  const { state } = useStore();
  const featureEnabled = skillRecorderEnabled(state.config);
  const [skills, setSkills] = useState<ManagedSkill[]>([]);
  const [staged, setStaged] = useState<StagedSkillSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const [reviewing, setReviewing] = useState<{ skill: ManagedSkill; text: string } | null>(null);

  const refresh = async (cancelled?: () => boolean) => {
    try {
      const result = await api(`/api/bots/${bot.id}/skills`) as {
        skills?: ManagedSkill[];
        staged?: StagedSkillSummary[];
      };
      if (cancelled?.()) return;
      setSkills(result.skills ?? []);
      setStaged(result.staged ?? []);
      setError("");
    } catch (cause) {
      if (!cancelled?.()) setError(cause instanceof Error ? cause.message : t("Could not load learned skills."));
    } finally {
      if (!cancelled?.()) setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setReviewing(null);
    void refresh(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [bot.id]);

  const toggle = async (skill: ManagedSkill) => {
    setWorking(skill.name);
    setError("");
    try {
      if (!skill.enabled) {
        // A disabled import has not necessarily been reviewed. Fetch the
        // integrity-checked bytes and require one explicit review step before
        // they can reach the bot's prompt or native skill discovery.
        const result = await api(`/api/bots/${bot.id}/skills/${encodeURIComponent(skill.name)}`) as { text?: string };
        if (!result.text) throw new Error(t("The skill contents are unavailable; remove and import or learn it again."));
        setReviewing({ skill, text: result.text });
        return;
      }
      await api(`/api/bots/${bot.id}/skills/${encodeURIComponent(skill.name)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: false }),
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Could not update this skill."));
    } finally {
      setWorking("");
    }
  };

  const enableReviewed = async () => {
    if (!reviewing) return;
    const { skill } = reviewing;
    setWorking(skill.name);
    setError("");
    try {
      await api(`/api/bots/${bot.id}/skills/${encodeURIComponent(skill.name)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: true }),
      });
      setReviewing(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Could not enable this skill."));
    } finally {
      setWorking("");
    }
  };

  const remove = async (skill: ManagedSkill) => {
    if (!window.confirm(t("Remove the learned skill “{name}”?", { name: skill.name }))) return;
    setWorking(skill.name);
    setError("");
    try {
      await api(`/api/bots/${bot.id}/skills/${encodeURIComponent(skill.name)}`, { method: "DELETE" });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Could not remove this skill."));
    } finally {
      setWorking("");
    }
  };

  if (!featureEnabled && !loading && skills.length === 0 && staged.length === 0) return null;
  return (
    <div className={cardCls} id={`bot-skills-${bot.id}`}>
      <div className="flex items-center gap-2">
        <BookOpen size={15} className="text-ink-secondary" />
        <div className={cardTitle}>{t("Learned skills")}</div>
      </div>
      <div className={cardSub}>
        {featureEnabled
          ? t("Use /learn in chat to stage a new skill. Nothing becomes active until you review and enable it.")
          : t("Skill authoring is off, but skills you already enabled stay under your control here.")}
      </div>
      {loading ? (
        <div className="mt-3 text-[12px] text-ink-secondary">{t("Loading…")}</div>
      ) : skills.length === 0 ? (
        <div className="mt-3 rounded-lg bg-inset px-3 py-2 text-[12px] text-ink-secondary">{t("No installed skills yet.")}</div>
      ) : (
        <div className="mt-3 divide-y divide-hairline/40 overflow-hidden rounded-lg border border-hairline/40">
          {skills.map((skill) => (
            <div key={skill.name} className="px-3 py-2.5">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[12.5px] text-ink">{skill.name}</div>
                  <div className="mt-0.5 line-clamp-2 text-[11.5px] text-ink-secondary">{skill.description}</div>
                </div>
                <Switch
                  checked={skill.enabled}
                  aria-label={skill.enabled ? t("Disable {name}", { name: skill.name }) : t("Enable {name}", { name: skill.name })}
                  disabled={working === skill.name}
                  onClick={() => void toggle(skill)}
                />
                <button
                  aria-label={t("Remove {name}", { name: skill.name })}
                  title={t("Remove skill")}
                  disabled={working === skill.name}
                  onClick={() => void remove(skill)}
                  className="flex size-8 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                >
                  <Trash2 size={15} />
                </button>
              </div>
              <div className="mt-1 truncate text-[10.5px] text-ink-secondary" title={skill.source}>{t("Source: {source}", { source: skill.source })}</div>
              {skill.warnings.length > 0 && (
                <div className="mt-1 text-[10.5px] text-warning">{skill.warnings.join(" · ")}</div>
              )}
            </div>
          ))}
        </div>
      )}
      {staged.length > 0 && (
        <div className="mt-2 text-[11.5px] text-warning">
          {tn(staged.length, "{count} proposal is waiting for a decision in chat.", "{count} proposals are waiting for a decision in chat.")}
        </div>
      )}
      {error && <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div>}
      {reviewing && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="skill-review-title"
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 p-6"
        >
          <div className="flex max-h-[min(760px,90vh)] w-full max-w-2xl flex-col rounded-2xl bg-card p-5 shadow-2xl">
            <div id="skill-review-title" className="text-[16px] font-semibold text-ink">
              {t("Review {name} before enabling", { name: reviewing.skill.name })}
            </div>
            <div className="mt-1 break-all text-[11.5px] text-ink-secondary">
              {t("Source: {source}", { source: reviewing.skill.source })}
            </div>
            {reviewing.skill.warnings.length > 0 && (
              <div className="mt-2 rounded-lg bg-warning/10 px-3 py-2 text-[11.5px] text-warning">
                {reviewing.skill.warnings.join(" · ")}
              </div>
            )}
            <pre
              tabIndex={0}
              aria-label={t("Full SKILL.md for {name}", { name: reviewing.skill.name })}
              className="mt-3 min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-inset p-3 font-mono text-[12px] leading-relaxed text-ink"
            >
              {reviewing.text}
            </pre>
            {error && <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={working === reviewing.skill.name}
                onClick={() => setReviewing(null)}
                className="rounded-lg px-4 py-2 text-[13px] font-medium text-ink-secondary hover:bg-raised disabled:opacity-40"
              >
                {t("Cancel")}
              </button>
              <button
                type="button"
                disabled={working === reviewing.skill.name}
                onClick={() => void enableReviewed()}
                className="rounded-lg bg-primary px-4 py-2 text-[13px] font-semibold text-primary-ink disabled:opacity-40"
              >
                {t("Enable reviewed skill")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Effort button captions; the level values stay the engine's identifiers. */
const EFFORT_LABELS: Partial<Record<string, string>> = {
  none: msg("None"),
  low: msg("Low"),
  medium: msg("Medium"),
  high: msg("High"),
  xhigh: msg("X-High"),
  max: msg("Max"),
};

/** Where a bot's shell tools run. Set per bot; each task pins its own copy
 * on its first turn (the server does the pinning — Claude keeps sessions
 * per project folder, so a folder must not move under a live task). The
 * PATCH is made directly rather than through updateBot: the server
 * validates the path and a rejected folder must not stick in local state. */
function WorkingFolder({ bot }: { bot: Bot }) {
  const { capabilities } = useDesktopCapabilities();
  const home = capabilities.host.homeDir;
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const canPick = Boolean(window.ogb?.pickFolder);
  const task = bot.tasks?.find((t) => t.threadId === bot.threadId);
  const pinned = task?.cwd; // undefined = not yet, null = legacy home, string = folder
  const pinnedElsewhere = pinned !== undefined && (pinned ?? undefined) !== bot.cwd;

  const save = async (cwd: string | null) => {
    setSaving(true);
    setError(null);
    try {
      await api(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ cwd }) });
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const pick = async () => {
    const chosen = await window.ogb?.pickFolder?.(bot.cwd);
    if (chosen) void save(chosen);
  };

  return (
    <div className={cardCls}>
      <div className={cardTitle}>{t("Working folder")}</div>
      <div className={cardSub}>{t("Where this bot runs its shell and file tools.")}</div>
      {canPick ? (
        <div className="mt-2.5 flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate rounded-lg bg-inset px-3 py-2 font-mono text-[12px] text-ink" title={bot.cwd}>
            {bot.cwd ? shortPath(bot.cwd, home) : <span className="text-ink-secondary">{t("Private bot workspace")}</span>}
          </div>
          <button onClick={() => void pick()} disabled={saving} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-50">
            <FolderOpen size={14} />{" "}
            {t("Choose…")}
          </button>
          {bot.cwd && (
            <button onClick={() => void save(null)} disabled={saving} className="shrink-0 rounded-lg px-2 py-2 text-[12.5px] text-ink-secondary hover:text-ink disabled:opacity-50">
              {t("Clear")}
            </button>
          )}
        </div>
      ) : (
        <form
          className="mt-2.5 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            // an emptied field clears the folder — the server wants null
            void save((draft ?? bot.cwd ?? "").trim() || null);
          }}
        >
          <input
            className={cn(inputClass, "font-mono text-[12px]")}
            placeholder={t("Private bot workspace — or an absolute path")}
            value={draft ?? bot.cwd ?? ""}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" disabled={saving || draft === null} className="shrink-0 rounded-lg bg-control px-3 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-50">
            {t("Save")}
          </button>
        </form>
      )}
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
      {pinnedElsewhere && (
        <div className="mt-2 text-[12px] text-ink-secondary">
          {pinned
            ? tRich(
                "New tasks start here. This task is pinned to <code>{path}</code> — start a new task to use the new folder.",
                { code: (c) => <span className="font-mono">{c}</span> },
                { path: shortPath(pinned, home) },
              )
            : t("New tasks start here. This task is pinned to the home folder — start a new task to use the new folder.")}
        </div>
      )}
    </div>
  );
}

interface MemoryTopic {
  name: string;
  bytes: number;
}

const formatBytes = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 102.4) / 10} KB`);

/** MEMORY.md + memory/ topic files, surfaced so the user can read and fix
 * what the bot believes. Loaded when opened; opening again re-reads, so notes
 * the bot wrote mid-session show up. */
function MemoryCard({ bot, open, onToggle, onSaved }: { bot: Bot; open: boolean; onToggle: () => void; onSaved: (text: string) => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [topics, setTopics] = useState<MemoryTopic[]>([]);
  const [saving, setSaving] = useState(false);
  const [topic, setTopic] = useState<{ name: string; text: string } | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    setTopic(null);
    try {
      const result: { text: string; truncated: boolean; topics: MemoryTopic[] } = await api(
        `/api/bots/${bot.id}/memory`,
      );
      setText(result.text);
      setTruncated(result.truncated);
      setTopics(result.topics);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read on every open
  }, [open]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const result: { truncated: boolean } = await api(`/api/bots/${bot.id}/memory`, {
        method: "PUT",
        body: JSON.stringify({ text }),
      });
      setTruncated(result.truncated);
      setDirty(false);
      onSaved(text);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const openTopic = async (name: string) => {
    setError(null);
    try {
      setTopic(await api(`/api/bots/${bot.id}/memory/topics/${encodeURIComponent(name)}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className={cardCls} id={`bot-memory-${bot.id}`}>
      <button className="flex w-full items-center justify-between gap-4 text-left" aria-expanded={open} onClick={onToggle}>
        <div>
          <div className={cardTitle}>{t("Memory")}</div>
          <div className={cardSub}>{t("Notes this bot keeps between tasks — plain files you can edit.")}</div>
        </div>
        <ChevronDown size={16} className={cn("shrink-0 text-ink-secondary transition-transform", open && "rotate-180")} />
      </button>

      {open && loading && <div className="mt-3 text-[12.5px] text-ink-secondary">{t("Loading…")}</div>}

      {open && !loading && topic && (
        <div className="mt-3">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-mono text-[12px] text-ink">memory/{topic.name}</span>
            <button onClick={() => setTopic(null)} className="shrink-0 rounded-md px-2 py-1 text-[12.5px] text-ink-secondary hover:bg-control hover:text-ink">
              {t("Back")}
            </button>
          </div>
          <pre className="mt-2 max-h-[240px] overflow-auto whitespace-pre-wrap rounded-lg bg-inset p-3 font-mono text-[12px] leading-relaxed text-ink">{topic.text}</pre>
        </div>
      )}

      {open && !loading && !topic && (
        <div className="mt-3">
          <textarea
            className={cn(inputClass, "min-h-[160px] resize-y font-mono text-[12px] leading-relaxed")}
            value={text}
            placeholder={t("Nothing remembered yet. The bot writes durable notes here — or add your own.")}
            aria-label={t("Bot memory")}
            onChange={(e) => {
              setText(e.target.value);
              setDirty(true);
            }}
          />
          <div className="mt-2 flex items-center gap-3">
            <button onClick={() => void save()} disabled={saving || !dirty} className="rounded-lg bg-control px-3 py-1.5 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-50">
              {saving ? t("Saving…") : t("Save")}
            </button>
            {truncated && <span className="text-[11.5px] text-ink-secondary">{t("Over the budget — only the top of this file loads each turn.")}</span>}
          </div>
          {topics.length > 0 && (
            <div className="mt-3">
              <div className="mb-1.5 text-[12px] font-semibold text-ink-secondary">{t("Topic files")}</div>
              <div className="overflow-hidden rounded-lg border border-hairline/40">
                {topics.map((entry) => (
                  <button
                    key={entry.name}
                    onClick={() => void openTopic(entry.name)}
                    className="flex w-full items-center justify-between gap-2 border-b border-hairline/40 px-3 py-2 text-left last:border-b-0 hover:bg-control/60"
                  >
                    <span className="truncate font-mono text-[12px] text-ink">{entry.name}</span>
                    <span className="shrink-0 text-[11.5px] text-ink-secondary">{formatBytes(entry.bytes)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

/** The name plate on the hero: the engine's official icon (unaltered) in its
 * slot, then ">_ name" in the pixel face. */
function HeroNameTag({ name, driverKind }: { name: string; driverKind?: string }) {
  return (
    <span className="relative mb-1 inline-flex h-9 max-w-full items-center gap-2 rounded-[4px] bg-[#14161C] pr-3 pl-2 shadow-[inset_0_0_0_2px_#3A404D,0_6px_14px_-8px_rgb(20_22_28/0.6)]">
      <span aria-hidden className="absolute top-3 -left-2 border-y-[6px] border-r-[8px] border-y-transparent border-r-[#14161C]" />
      <MarkTile driverKind={driverKind} size={18} markSize={13} />
      <span className="truncate text-[16px] leading-none" style={{ fontFamily: "Unifont, ui-monospace, SFMono-Regular, Menlo, monospace" }}>
        <span className="text-[#4ADE80]">&gt;_ </span>
        <span className="text-[#F3F4F7]">{name}</span>
      </span>
    </span>
  );
}

function BotHero({ bot, department, mainBotId, leads }: { bot: Bot; department?: string; mainBotId?: string; leads: number }) {
  const { state } = useStore();
  const kind = mascotForBot(bot, state.instances);
  const brand = MASCOT_BRAND[kind];
  const instance = state.instances.find((entry) => entry.instanceId === bot.modelSelection.instanceId);
  const status = heroStatus(bot);
  const isMain = bot.id === mainBotId;
  const role = [bot.title.trim() || null, isMain ? t("Main bot") : department ?? t("No department")].filter(Boolean).join(" · ");
  const label =
    status.kind === "working"
      ? t("Working")
      : status.kind === "waiting"
        ? t("Waiting for you")
        : status.kind === "offline"
          ? t("Can't reach it")
          : t("Idle");
  const team = isMain ? t("{count} departments", { count: leads }) : leads ? t("leads {count}", { count: leads }) : null;
  return (
    <div
      className="relative h-[182px] shrink-0 overflow-hidden rounded-2xl"
      style={{
        backgroundColor: `color-mix(in oklab, ${brand} 10%, var(--color-raised))`,
        backgroundImage: `radial-gradient(circle, color-mix(in oklab, ${brand} 22%, transparent) 1px, transparent 1.3px)`,
        backgroundSize: "12px 12px",
        boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${brand} 24%, var(--color-raised))`,
      }}
    >
      <span aria-hidden className="absolute bottom-2 left-[26px] h-3 w-32 rounded-[50%] bg-[rgb(20_40_28/0.16)] blur-[2px]" />
      <Mascot
        kind={kind}
        pose={status.pose}
        scale={2}
        className="absolute bottom-[10px] left-[18px]"
        title={t("{name}'s look: {body}", { name: bot.name, body: t(MASCOT_BODY[kind]) })}
      />
      <div className="absolute top-[24px] right-3.5 left-[186px] flex flex-col items-start gap-2">
        <HeroNameTag name={bot.name || t("Unnamed")} driverKind={instance?.driverKind} />
        <b className="max-w-full truncate text-[13.5px] font-bold text-ink">{role}</b>
        <Pill tone={status.tone} dot>
          {team ? `${label} · ${team}` : label}
        </Pill>
        <span className="text-[11.5px] leading-normal text-ink-secondary">
          {t("Look follows the engine: {engine} {body}", { engine: instance?.displayName ?? "", body: t(MASCOT_BODY[kind]) })}
        </span>
      </div>
    </div>
  );
}

/** "Ask first" chips: the owner's locked rule, the harness's built-in
 * backstop, and the one a bot can switch — asking before contacting bots. */
function AskFirstChips({ bot, canCoordinate, onPeerComms }: { bot: Bot; canCoordinate: boolean; onPeerComms: (next: boolean) => void }) {
  const [adding, setAdding] = useState(false);
  const chip = "inline-flex h-6 items-center gap-1 rounded-full bg-warning/12 px-[9px] text-[12px] font-semibold text-warning";
  return (
    <span className="relative flex items-center gap-1.5">
      <span className={chip} title={t("Set by you; bots can't change it")}>
        <Lock size={11} />
        {t("Publishing")}
      </span>
      <span className={chip} title={t("Built in: deleting files and other destructive commands always stop and ask")}>
        <Lock size={11} />
        {t("Deleting files")}
      </span>
      {bot.approvePeerComms && (
        <span className={cn(chip, "pr-1")}>
          {t("Contacting bots")}
          <button type="button" onClick={() => onPeerComms(false)} aria-label={t("Stop asking before contacting other bots")} className="grid size-4 place-items-center rounded-full hover:bg-warning/20">
            <X size={11} />
          </button>
        </span>
      )}
      <button
        type="button"
        onClick={() => setAdding((value) => !value)}
        disabled={bot.approvePeerComms || !canCoordinate}
        aria-label={t("Add an ask-first rule")}
        title={bot.approvePeerComms || !canCoordinate ? t("Nothing else to add for this bot") : t("Add an ask-first rule")}
        className="grid size-6 place-items-center rounded-full bg-control/70 text-ink-secondary hover:text-ink disabled:opacity-40"
      >
        <Plus size={12} />
      </button>
      {adding && !bot.approvePeerComms && (
        <span className="absolute top-8 right-0 z-30 flex w-[230px] flex-col rounded-xl bg-raised p-1 shadow-[0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent),0_12px_28px_-12px_rgb(16_24_40/0.35)]">
          <button
            type="button"
            onClick={() => {
              onPeerComms(true);
              setAdding(false);
            }}
            className="rounded-lg px-2.5 py-2 text-left text-[12.5px] whitespace-normal text-ink hover:bg-control/60"
          >
            <b className="block font-semibold">{t("Ask before contacting other bots")}</b>
            <span className="text-[11.5px] text-ink-secondary">{t("It stops and asks before it reaches out to a teammate.")}</span>
          </button>
        </span>
      )}
    </span>
  );
}

function MoreMenu({ bot, onAvatar, onClose }: { bot: Bot; onAvatar: () => void; onClose: () => void }) {
  const { dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => !ref.current?.contains(event.target as Node) && setOpen(false);
    const key = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", key);
    };
  }, [open]);
  const item = "flex w-full items-center rounded-lg px-2.5 py-2 text-left text-[13px] text-ink hover:bg-control/60";
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={t("More")}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="grid size-8 place-items-center rounded-lg text-ink-secondary hover:bg-control hover:text-ink"
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div role="menu" className="absolute top-9 right-0 z-30 w-[200px] rounded-xl bg-raised p-1 shadow-[0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent),0_12px_28px_-12px_rgb(16_24_40/0.35)]">
          <button role="menuitem" type="button" className={item} onClick={() => (setOpen(false), onAvatar())}>
            {t("Change avatar")}
          </button>
          <button role="menuitem" type="button" className={item} onClick={() => (setOpen(false), dispatch({ type: "duplicateBot", botId: bot.id }))}>
            {t("Duplicate this bot")}
          </button>
          <button role="menuitem" type="button" className={item} onClick={() => (setOpen(false), dispatch({ type: "toggleAppSettings", open: true, section: "org" }))}>
            {t("Organization settings")}
          </button>
          <button role="menuitem" type="button" className={item} onClick={() => (setOpen(false), onClose())}>
            {t("Close panel")}
          </button>
        </div>
      )}
    </div>
  );
}

export function SettingsPanel({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const { data: org } = useOrg();
  const { capabilities } = useDesktopCapabilities();
  const providerSupportsLocal = instanceSupportsLocalComputer(state.instances, bot);
  const localSelectable = localComputerSelectable({ capabilities, providerSupportsLocal });
  const [localAutoWarning, setLocalAutoWarning] = useState<"auto" | "local" | null>(null);
  const localDisabledReason = localComputerDisabledReason({ capabilities, providerSupportsLocal });
  const [picking, setPicking] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memoryCount, setMemoryCount] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const skills = useBotSkills(bot.id);
  const { connected } = useAppCatalog();

  const patch = (
    p: Partial<
      Pick<
        Bot,
        | "name"
        | "title"
        | "description"
        | "notifications"
        | "computer"
        | "cloudBackend"
        | "autoStartVps"
        | "color"
        | "mascotExpression"
        | "avatarUrl"
        | "avatarCrop"
        | "autoApprove"
        | "autoReview"
        | "speakReplies"
        | "voice"
        | "chiefOfStaff"
        | "approvePeerComms"
        | "composio"
        | "browser"
        | "modelSelection"
      >
    > & { acknowledgeLocalAuto?: boolean },
  ) => dispatch({ type: "updateBot", botId: bot.id, patch: p });
  const activeState = stateForBot(bot);
  const mascotMotion = state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;
  const engine = state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
  const kind = mascotForBot(bot, state.instances);
  const canAutoReview = engine?.capabilities?.approvalReview === true;
  const canCoordinate = engine?.capabilities?.agentsMcp === true;
  const canUseConnectedApps = engine?.capabilities?.composioMcp === true;
  const canUseVps = engine?.capabilities?.computerMcp === true && engine.driverKind !== "boxAgent";
  const connectedAppsConfigured = state.config?.composio?.configured === true;
  const connectedAppsEnabled = bot.composio !== false;
  const canUseBrowser = engine?.capabilities?.browserMcp === true;
  const desktopBrowser = Boolean(window.ogb?.browser);
  const browserBlockedOnWindows = window.ogb?.platform === "win32" && !desktopBrowser;
  const browserFeature = builtInBrowserEnabled(state.config);
  const browserAllowed = bot.browser !== false;
  const browserEnabled = browserFeature && browserAllowed;
  const sectionName = bot.section?.trim() || t("General");
  const currentChief = state.bots.find(
    (candidate) =>
      candidate.chiefOfStaff &&
      (candidate.section?.trim() || "") === (bot.section?.trim() || ""),
  );

  const main = chiefBot(state.bots, org);
  const departments = useMemo(() => buildDepartments(state.bots, org), [state.bots, org]);
  const department = departments.find((dep) => dep.section === bot.section?.trim());
  const superior = superiorOf(bot, state.bots, main?.id);
  const led = bot.id === main?.id ? departments.length : teamSize(bot, state.bots, main?.id);
  const recommendation = useMemo(
    () => recommendedFor([bot.title, bot.description].filter(Boolean).join("\n"), state.instances),
    [bot.title, bot.description, state.instances],
  );
  const modelLabel = engine?.models.options.find((option) => option.id === bot.modelSelection.model)?.label ?? bot.modelSelection.model;

  // MEMORY.md's note count for the Memory row (the editor below re-reads on open)
  useEffect(() => {
    let alive = true;
    setMemoryCount(null);
    api(`/api/bots/${bot.id}/memory`)
      .then((result: { text?: string }) => alive && setMemoryCount(countMemoryNotes(result.text ?? "")))
      .catch(() => alive && setMemoryCount(null));
    return () => {
      alive = false;
    };
  }, [bot.id]);

  // Opening a part of "More settings" from a row above scrolls it into view.
  const reveal = (id: string) => {
    setMoreOpen(true);
    window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  };

  const close = () => dispatch({ type: "toggleSettings", open: false });
  const computerChoice = bot.computer === "cloud" || bot.computer === "local" ? bot.computer : null;
  const computerNow =
    bot.computer === "vm" ? t("Local VM") : bot.computer === "off" ? t("Off") : !bot.computer ? t("Auto") : null;
  const enabledSkills = (skills ?? []).filter((skill) => skill.enabled);
  const appNames = connected.map((app) => app.label);

  return (
    <>
    <aside aria-label={t("Bot Settings")} className="animate-panel-in relative z-20 flex h-full w-[420px] shrink-0 flex-col border-l border-hairline/40 bg-stage">
      <div className="flex h-14 shrink-0 items-center gap-1.5 px-4">
        <button
          onClick={close}
          aria-label={t("Collapse agent profile")}
          title={t("Collapse agent profile")}
          className="grid size-8 place-items-center rounded-lg text-ink-secondary hover:bg-control hover:text-ink"
        >
          <ChevronLeft size={16} />
        </button>
        <b className="ml-1 flex-1 text-[15.5px] font-bold text-ink">{t("Bot Settings")}</b>
        <MoreMenu bot={bot} onAvatar={() => reveal(`bot-avatar-${bot.id}`)} onClose={close} />
        <button
          onClick={close}
          aria-label={t("Close agent profile")}
          title={t("Close agent profile")}
          className="grid size-8 place-items-center rounded-lg text-ink-secondary hover:bg-control hover:text-ink"
        >
          <PanelRightClose size={16} />
        </button>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        <div className="flex flex-col gap-3">
          <BotHero bot={bot} department={department?.section} mainBotId={main?.id} leads={led} />

          <div className="grid grid-cols-2 gap-2.5">
            <label className="block">
              <FieldLabel>{t("Name")}</FieldLabel>
              <input className={inputClass} maxLength={BOT_PROFILE_LIMITS.name} value={bot.name} onChange={(e) => patch({ name: e.target.value })} />
            </label>
            <label className="block">
              <FieldLabel>{t("Tag")}</FieldLabel>
              <input
                className={inputClass}
                maxLength={BOT_PROFILE_LIMITS.title}
                placeholder={t("Shown next to the name")}
                value={bot.title}
                onChange={(e) => patch({ title: e.target.value })}
              />
            </label>
          </div>
          <label className="block">
            <FieldLabel>{t("Description")}</FieldLabel>
            <textarea
              className={cn(inputClass, "min-h-[64px] resize-none")}
              maxLength={BOT_PROFILE_LIMITS.description}
              placeholder={t("What this bot is for — it reads this to understand its job")}
              value={bot.description}
              onChange={(e) => patch({ description: e.target.value })}
            />
          </label>

          <RowGroup>
            <SettingRow label={t("Engine")} sub={modelLabel}>
              <BotTile kind={kind} size={16} />
              <b className="max-w-[92px] truncate font-semibold text-ink">{engine?.displayName ?? bot.modelSelection.instanceId}</b>
              {recommendation && recommendation.instanceId !== bot.modelSelection.instanceId && (
                <span
                  className="inline-flex h-5 max-w-[124px] items-center gap-[3px] rounded-full bg-control/70 px-[7px] text-[11.5px] text-ink-secondary"
                  title={t("For this bot's job the recommender would pick {engine} · {model}", { engine: recommendation.engineName, model: recommendation.model })}
                >
                  <Sparkles size={11} className="shrink-0" />
                  <span className="truncate">{t("Suggested: {engine}", { engine: recommendation.engineName })}</span>
                </span>
              )}
              <button
                type="button"
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() => setPicking((value) => !value)}
                aria-expanded={picking}
                className="ml-1 text-[12.5px] font-semibold text-accent-text hover:underline"
              >
                {t("Change model")}
              </button>
            </SettingRow>
            {picking && (
              <div className="pb-3">
                <ModelPicker bot={bot} contained hideTrigger defaultOpen onClose={() => setPicking(false)} />
              </div>
            )}
            <button
              type="button"
              onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "org" })}
              className="flex min-h-[42px] items-center gap-2.5 py-1.5 text-left"
              title={t("Open the organization settings")}
            >
              <span className="flex-1 text-[13px] font-semibold text-ink">{t("Department")}</span>
              <span className="flex min-w-0 items-center gap-1.5 text-[13px] whitespace-nowrap">
                {department ? <i className="size-2 shrink-0 rounded-[2px]" style={{ background: department.color }} /> : null}
                <b className="truncate font-semibold text-ink">{bot.id === main?.id ? t("Main bot") : department?.section ?? t("No department")}</b>
                <span className="text-ink-secondary/70">· {t("Reports to")}</span>
                {superior.kind === "bot" ? (
                  <>
                    <BotAvatar bot={superior.bot} size={16} />
                    <b className="max-w-[80px] truncate font-semibold text-ink">{superior.bot.name}</b>
                  </>
                ) : superior.kind === "you" ? (
                  <b className="font-semibold text-ink">{t("You")}</b>
                ) : (
                  <span className="text-ink-secondary">—</span>
                )}
                <ChevronRight size={13} className="shrink-0 text-ink-secondary/70" />
              </span>
            </button>
          </RowGroup>

          <div>
            <FieldLabel>{t("Permissions")}</FieldLabel>
            <RowGroup>
              <SettingRow label={t("Approve automatically")} sub={t("Low-risk steps run without waiting for you")}>
                <Switch
                  checked={Boolean(bot.autoApprove)}
                  aria-label={t("Auto mode")}
                  onClick={() => {
                    if (!bot.autoApprove && bot.computer === "local") setLocalAutoWarning("auto");
                    else patch({ autoApprove: !bot.autoApprove });
                  }}
                />
              </SettingRow>
              <SettingRow label={t("Ask first")} sub={t("Beats approving automatically")}>
                <AskFirstChips bot={bot} canCoordinate={canCoordinate} onPeerComms={(approvePeerComms) => patch({ approvePeerComms })} />
              </SettingRow>
              <SettingRow
                label={t("Connect apps")}
                sub={
                  !connectedAppsConfigured
                    ? t("Connect apps in App Settings before giving this bot access.")
                    : !canUseConnectedApps
                      ? t("This bot's current engine cannot use connected apps.")
                      : appNames.length
                        ? appNames.slice(0, 4).join(" · ")
                        : t("No app is connected yet")
                }
              >
                <Switch
                  checked={connectedAppsEnabled}
                  aria-label={t("Allow this bot to use connected apps")}
                  disabled={!connectedAppsEnabled && (!connectedAppsConfigured || !canUseConnectedApps)}
                  onClick={() => patch({ composio: !connectedAppsEnabled })}
                  title={
                    !connectedAppsEnabled && !connectedAppsConfigured
                      ? t("Connect apps in App Settings first")
                      : !connectedAppsEnabled && !canUseConnectedApps
                        ? t("This engine cannot use connected apps")
                        : undefined
                  }
                />
              </SettingRow>
              <SettingRow label={t("Computer")} sub={computerNow ? t("Where it works · now: {mode}", { mode: computerNow }) : t("Which computer it works on")}>
                <Segmented<"cloud" | "local">
                  size="sm"
                  value={(computerChoice ?? "") as "cloud" | "local"}
                  label={t("Computer")}
                  onChange={(mode) => {
                    if (mode === bot.computer) return;
                    if (mode === "local" && bot.autoApprove) setLocalAutoWarning("local");
                    else patch({ computer: mode });
                  }}
                  options={[
                    { value: "cloud", label: t("Cloud") },
                    { value: "local", label: t("This machine"), disabled: !localSelectable },
                  ]}
                />
              </SettingRow>
            </RowGroup>
          </div>

          <RowGroup>
            <SettingRow label={t("Notifications")} sub={t("When it finishes or needs you")}>
              <Switch
                checked={bot.notifications}
                aria-label={t("Agent notifications")}
                onClick={() => {
                  const enabled = !bot.notifications;
                  if (enabled) void requestNotificationPermission();
                  patch({ notifications: enabled });
                }}
              />
            </SettingRow>
            <SettingRow label={t("Memory")}>
              <span className="h-[22px] rounded-md bg-control/70 px-[7px] font-mono text-[11.5px] leading-[22px] text-ink">MEMORY.md</span>
              <span className="text-ink-secondary/80">{memoryCount === null ? "—" : memoryCount ? t("{count} notes", { count: memoryCount }) : t("Empty")}</span>
              <button
                type="button"
                onClick={() => {
                  setMemoryOpen(true);
                  reveal(`bot-memory-${bot.id}`);
                }}
                className="ml-1 text-[12.5px] font-semibold text-accent-text hover:underline"
              >
                {t("View")}
              </button>
            </SettingRow>
            <SettingRow label={t("Skills")}>
              {skills === null ? (
                <span className="text-ink-secondary/70">…</span>
              ) : enabledSkills.length ? (
                <>
                  {enabledSkills.slice(0, 3).map((skill) => (
                    <button
                      key={skill.name}
                      type="button"
                      onClick={() => reveal(`bot-skills-${bot.id}`)}
                      title={skill.description}
                      className="inline-flex h-6 max-w-[92px] items-center gap-1 rounded-full bg-control/70 px-[9px] text-[12px] font-medium text-ink-secondary hover:text-ink"
                    >
                      <Wand2 size={11} className="shrink-0" />
                      <span className="truncate">{skill.name}</span>
                    </button>
                  ))}
                  {enabledSkills.length > 3 && <span className="text-[12px] text-ink-secondary">+{enabledSkills.length - 3}</span>}
                </>
              ) : (
                <>
                  <span className="text-ink-secondary/80">{t("None yet")}</span>
                  {skillRecorderEnabled(state.config) && (
                    <button type="button" onClick={() => dispatch({ type: "showSkillRecorder" })} className="ml-1 text-[12.5px] font-semibold text-accent-text hover:underline">
                      {t("Teach one")}
                    </button>
                  )}
                </>
              )}
            </SettingRow>
          </RowGroup>

          <button
            type="button"
            onClick={() => setMoreOpen((value) => !value)}
            aria-expanded={moreOpen}
            className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-left hover:bg-control/50"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-semibold text-ink">{t("More settings")}</span>
              <span className="block truncate text-[11.5px] text-ink-secondary">{t("Avatar, role, browser, effort, computer, review, voice, usage, folder, memory, skills")}</span>
            </span>
            <ChevronDown size={16} className={cn("shrink-0 text-ink-secondary transition-transform", moreOpen && "rotate-180")} />
          </button>

          {moreOpen && (
            <div className="flex flex-col gap-3">
              <div id={`bot-avatar-${bot.id}`}>
                <BotProfileAvatarCard bot={bot} activeState={activeState} mascotMotion={mascotMotion} onPatch={patch} />
              </div>

              <div className={cn(cardCls, bot.chiefOfStaff && "bg-select/[0.06]")}>
                <div className="flex items-center gap-3">
                  <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", bot.chiefOfStaff ? "bg-primary text-primary-ink" : "bg-control text-ink-secondary")}>
                    <Crown size={16} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className={cardTitle}>{bot.section?.trim() ? t("Department lead") : t("Chief of Staff")}</div>
                    <div className="text-[11.5px] text-ink-secondary">{t("One for {section}", { section: sectionName })}</div>
                  </div>
                  <Switch
                    checked={Boolean(bot.chiefOfStaff)}
                    aria-label={t("Chief of Staff")}
                    disabled={!bot.chiefOfStaff && !canCoordinate}
                    onClick={() => patch({ chiefOfStaff: !bot.chiefOfStaff })}
                    title={!bot.chiefOfStaff && !canCoordinate ? t("This engine cannot contact other bots") : undefined}
                    className="disabled:cursor-not-allowed"
                  />
                </div>
                <div className="mt-2.5 text-[12px] leading-relaxed text-ink-secondary">
                  {bot.chiefOfStaff && !canCoordinate
                    ? t("This bot still holds the role, but its current engine cannot contact teammates. Choose a Claude or ACP engine to restore coordination.")
                    : bot.chiefOfStaff
                      ? t("This is the primary contact for {section}. It can create and coordinate specialists in this section, then combine their work into one answer.", { section: sectionName })
                      : !canCoordinate
                        ? t("Choose a Claude or ACP engine to let this bot coordinate teammates.")
                        : currentChief
                          ? t("Make this bot the {section} Chief and hand the role over from {name}.", { section: sectionName, name: currentChief.name })
                          : t("Make this bot the primary contact for the {section} section.", { section: sectionName })}
                </div>
              </div>

              <div className={cn(cardCls, "flex items-center justify-between gap-4")}>
                <div>
                  <div className={cardTitle}>{t("Browser")}</div>
                  <div className={cardSub}>
                    {!desktopBrowser
                      ? browserBlockedOnWindows
                        ? t("The built-in browser is temporarily unavailable on Windows while Electron's production sandbox support is being verified.")
                        : t("The built-in browser needs the Ein desktop app.")
                      : !browserFeature
                        ? t("The built-in browser is switched off under App Settings → Experimental.")
                        : !canUseBrowser
                          ? t("This bot's current engine cannot use the built-in browser.")
                          : browserEnabled
                            ? t("This bot has its own browser tab in the computer panel — its own logins, watchable and takeable at any time.")
                            : t("Keep the built-in browser unavailable to this bot.")}
                  </div>
                </div>
                <Switch
                  checked={browserEnabled}
                  aria-label={t("Give this bot a built-in browser")}
                  disabled={!browserEnabled && (!desktopBrowser || !browserFeature || !canUseBrowser)}
                  onClick={() => patch({ browser: !browserAllowed })}
                  className="disabled:cursor-not-allowed"
                />
              </div>

              {!!engine?.capabilities?.effortLevels?.length && (
                <div className={cardCls}>
                  <div className={cardTitle}>{t("Effort")}</div>
                  {/* Says what the app does, not what the engine ends up at:
                      Codex applies a level to the whole thread and has no way to
                      take one back, so "currently: engine default" was a promise
                      we could not keep for a thread that had already been sent
                      one. Sending nothing is true on every engine. */}
                  <div className={cardSub}>
                    {bot.modelSelection.effort ? t("How hard this bot thinks") : t("How hard this bot thinks (Default: no level is sent)")}
                  </div>
                  <div className="mt-2.5 flex overflow-hidden rounded-lg border border-hairline/40">
                    {([undefined, ...engine.capabilities.effortLevels] as const).map((level, i) => (
                      <button
                        key={level ?? "default"}
                        aria-pressed={bot.modelSelection.effort === level}
                        onClick={() => patch({ modelSelection: { ...bot.modelSelection, effort: level } })}
                        className={cn(
                          "flex-1 py-1.5 text-[12.5px] capitalize",
                          i > 0 && "border-l border-hairline/40",
                          bot.modelSelection.effort === level ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/60 hover:text-ink",
                        )}
                      >
                        {/* the others capitalize cleanly; "xhigh" would read "Xhigh" */}
                        {level ? t(EFFORT_LABELS[level] ?? level) : t("Default")}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className={cardCls}>
                <div className={cardTitle}>{t("Computer")}</div>
                <div className={cardSub}>
                  {bot.computer ? t("Where this bot's computer runs") : t("Where this bot's computer runs (currently: auto)")}
                </div>
                <div className="mt-2.5 flex overflow-hidden rounded-lg border border-hairline/40">
                  {([
                    ["cloud", t("Cloud")],
                    ["vm", t("Local VM")],
                    ["local", t("This computer")],
                    ["off", t("Off")],
                  ] as const).map(([mode, label], i) => (
                    <button
                      key={mode}
                      disabled={mode === "local" && !localSelectable}
                      title={mode === "local" && !localSelectable ? localDisabledReason ?? undefined : undefined}
                      onClick={() => {
                        if (mode === bot.computer) return;
                        if (mode === "local" && bot.autoApprove) setLocalAutoWarning("local");
                        else patch({ computer: mode });
                      }}
                      className={cn(
                        "flex-1 py-1.5 text-[12.5px] capitalize",
                        i > 0 && "border-l border-hairline/40",
                        mode === "local" && !localSelectable && "cursor-not-allowed opacity-40",
                        bot.computer === mode ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/60 hover:text-ink",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {(!bot.computer || bot.computer === "cloud") && (
                  <>
                    <CloudBackendPicker value={bot.cloudBackend ?? "box"} vpsSupported={canUseVps} onChange={(backend) => patch({ cloudBackend: backend })} />
                    {!bot.computer && bot.cloudBackend === "vps" && (
                      <div className="mt-3 flex items-center justify-between gap-4 rounded-lg bg-inset px-3 py-2.5">
                        <div className="min-w-0">
                          <div className="text-[13px] text-ink">{t("Start VPS automatically")}</div>
                          <div className="mt-0.5 text-[11.5px] text-ink-secondary">{t("Allow Auto to create or wake this bot's managed container when needed.")}</div>
                        </div>
                        <Switch checked={Boolean(bot.autoStartVps)} aria-label={t("Start VPS automatically")} onClick={() => patch({ autoStartVps: !bot.autoStartVps })} />
                      </div>
                    )}
                  </>
                )}
              </div>

              <div className={cardCls}>
                <div className={cardTitle}>{t("Review routine approvals")}</div>
                <div className={cardSub}>
                  {canAutoReview
                    ? t("The same engine reviews ordinary approval cards. Existing safety rules, unattended turns, local-computer access, and questions still wait for you.")
                    : t("This engine cannot run an isolated review safely, so approval cards continue to wait for you.")}
                </div>
                <div className="mt-2.5 flex gap-1 rounded-lg bg-inset p-0.5">
                  {(
                    [
                      ["off", t("Off"), t("Every undecided approval waits for you.")],
                      ["shadow", t("Watch"), t("Record the review without answering the card.")],
                      ["enforce", t("On"), t("Answer only reviews that return a strict approval.")],
                    ] as const
                  ).map(([value, label, hint]) => {
                    const current = bot.autoReview === "shadow" || bot.autoReview === "enforce" ? bot.autoReview : "off";
                    const disabled = value !== "off" && !canAutoReview;
                    return (
                      <button
                        key={value}
                        title={disabled ? t("Not supported by this engine") : hint}
                        disabled={disabled}
                        onClick={() => patch({ autoReview: value })}
                        className={cn(
                          "flex-1 rounded-md px-2.5 py-1.5 text-[12.5px] font-medium disabled:cursor-not-allowed disabled:opacity-40",
                          current === value ? "bg-raised text-ink shadow-[0_1px_2px_rgb(16_24_40/0.12)]" : "text-ink-secondary hover:text-ink",
                        )}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <VoiceSettings bot={bot} onPatch={patch} />
              <BotUsageCard bot={bot} />
              <WorkingFolder bot={bot} />
              {/* keyed so switching bots never shows one bot's notes under another's name */}
              <MemoryCard key={bot.id} bot={bot} open={memoryOpen} onToggle={() => setMemoryOpen((value) => !value)} onSaved={(text) => setMemoryCount(countMemoryNotes(text))} />
              <LearnedSkillsCard key={`skills-${bot.id}`} bot={bot} />
            </div>
          )}
        </div>
      </div>
    </aside>
    <LocalComputerAutoWarning
      open={localAutoWarning !== null}
      onCancel={() => setLocalAutoWarning(null)}
      onConfirm={() => {
        if (localAutoWarning === "auto") patch({ autoApprove: true, acknowledgeLocalAuto: true });
        if (localAutoWarning === "local") patch({ computer: "local", acknowledgeLocalAuto: true });
        setLocalAutoWarning(null);
      }}
    />
    </>
  );
}
