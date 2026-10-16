// The 1:1 chat header (design U8): the bot's tile and name, the gold star and
// "主 Bot" chip on the chief, "N running" for its dispatch runs, and on the
// right the computer, export and "more" buttons. The older header controls
// (find, tasks, model, inspector, usage, working folder) live in "more"; the
// task switch stays beside the name once there is more than one task, and the
// call button stays visible because a call cannot start from a menu row.
//
// Narrow (a side panel such as the live computer can leave the chat ~400px):
// the header is a container and gives way in order, by its content width —
// the task title folds to an icon and its count (<672px), the "主 Bot"/lead
// chip goes (the star stays, <576px), "N running" shrinks to its number
// (<512px), export moves into "more" (<448px), and below 320px the task
// switch leaves too. The name truncates last.
import { useCallback, useRef, useState } from "react";
import { Bug, Check, ClipboardCopy, Clock, Cpu, FileJson, FileText, Folder, Plus, Search, Settings2 } from "lucide-react";
import { useStore, type Bot, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { t, tn } from "@/lib/i18n";
import { stateForBot } from "@/lib/mascot";
import { costCaption, formatTokens, formatUsd, hasFiniteCost, usageChip, usageDetail } from "@/lib/usage";
import { BotAvatar } from "@/components/Avatar";
import { RenameTitle } from "@/components/RenameTitle";
import { ModelPicker } from "@/components/ModelPicker";
import { CallButton } from "@/components/CallView";
import { TaskPicker } from "@/components/TaskPicker";
import { Pill } from "@/components/ui/index";
import { IconMonitor, IconMore, IconStar, IconUpload } from "./icons";
import { MenuDivider, MenuItem, PopoverPanel, useDismiss } from "./primitives";

const ICON_BUTTON = "grid size-8 shrink-0 place-items-center rounded-[9px] text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink";

export function ChatHeader({
  bot,
  messages,
  isMainBot,
  runningRuns,
  waitingOnYou,
  findOpen,
  onFind,
  onOpenRoutines,
  routineCount,
}: {
  bot: Bot;
  messages: Message[];
  /** the org's 主 Bot: gold star and the "主 Bot" chip */
  isMainBot: boolean;
  /** this bot's dispatch runs still working */
  runningRuns: number;
  /** an approval or question is waiting on the person */
  waitingOnYou: boolean;
  findOpen: boolean;
  onFind: () => void;
  onOpenRoutines: () => void;
  routineCount: number;
}) {
  const { state, dispatch } = useStore();
  const mascot = stateForBot({ ...bot, messages });
  const marker = waitingOnYou ? "waiting" : bot.busy ? "working" : undefined;

  return (
    <header
      className={cn(
        // @container keeps the older chips' fold rules working (TaskPicker)
        "@container/chathead flex h-[52px] shrink-0 items-center gap-2 border-b border-hairline/30 px-5",
        // room for the drawer button, which overlays this corner below md
        "pl-11 md:pl-5",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <button
          type="button"
          onClick={() => dispatch({ type: "toggleSettings", open: true })}
          className="grid size-8 shrink-0 place-items-center rounded-[9px] hover:bg-raised-hover"
          title={t("Open agent profile")}
          aria-label={t("Open {name}'s profile", { name: bot.name })}
        >
          <BotAvatar bot={bot} state={mascot} size={26} marker={marker} />
        </button>
        <RenameTitle
          value={bot.name}
          onCommit={(name) => dispatch({ type: "updateBot", botId: bot.id, patch: { name } })}
          onActivate={() => dispatch({ type: "toggleSettings", open: true })}
          className="truncate text-[15px] font-bold text-ink"
          inputClassName="max-w-[220px] rounded bg-inset px-1.5 py-0.5 text-[15px] font-bold"
        />
        {isMainBot ? (
          <>
            <span className="-ml-0.5 shrink-0" title={t("Main bot")}>
              <IconStar size={13} />
            </span>
            <Pill tone="grey" className="h-5 shrink-0 text-[11.5px] @max-xl/chathead:hidden">
              {t("Main bot")}
            </Pill>
          </>
        ) : (
          // only the 主 Bot is 总控 (chiefBot in src/lib/org.ts): a section's
          // chief of staff is that department's lead; one without a section
          // gets no badge rather than a second 总控
          bot.chiefOfStaff &&
          bot.section?.trim() && (
            <Pill tone="grey" className="h-5 shrink-0 text-[11.5px] @max-xl/chathead:hidden">
              {t("{section} lead", { section: bot.section.trim() })}
            </Pill>
          )
        )}
        {runningRuns > 0 && (
          <button
            type="button"
            onClick={() => dispatch({ type: "showTeamMap" })}
            title={`${t("{count} running", { count: runningRuns })} · ${t("Open the workbench")}`}
            aria-label={t("{count} running", { count: runningRuns })}
            className="shrink-0 rounded-full"
          >
            <Pill tone="blue" dot className="h-5 text-[11.5px] hover:brightness-95">
              <span className="@max-lg/chathead:hidden">{t("{count} running", { count: runningRuns })}</span>
              <span className="hidden tabular-nums @max-lg/chathead:inline">{runningRuns}</span>
            </Pill>
          </button>
        )}
        <TaskPicker bot={bot} variant="quiet" />
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <CallButton bot={bot} />
        <button
          type="button"
          onClick={() => dispatch({ type: "toggleComputer" })}
          aria-pressed={state.computerOpen}
          aria-label={t("Bot's computer")}
          title={t("Bot's computer")}
          className={cn(ICON_BUTTON, state.computerOpen && "bg-select/10 text-accent-text")}
        >
          <IconMonitor size={18} />
        </button>
        <div className="@max-md/chathead:hidden">
          <ExportMenu bot={bot} />
        </div>
        <MoreMenu bot={bot} findOpen={findOpen} onFind={onFind} onOpenRoutines={onOpenRoutines} routineCount={routineCount} />
      </div>
    </header>
  );
}

/** Copy or download this conversation (GET /api/threads/:id/export). */
function useTranscriptExport(bot: Bot, onDone: () => void) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = (format: "markdown" | "json") => `/api/threads/${encodeURIComponent(bot.threadId)}/export?format=${format}`;
  const download = (format: "markdown" | "json") => {
    const link = document.createElement("a");
    link.href = url(format);
    link.download = "";
    document.body.appendChild(link);
    link.click();
    link.remove();
    onDone();
  };
  const copy = async () => {
    setError(null);
    try {
      const response = await fetch(url("markdown"));
      if (!response.ok) throw new Error(`${response.status}`);
      await navigator.clipboard.writeText(await response.text());
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
        onDone();
      }, 900);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return { copied, error, copy, download };
}

/** The three ways out, as menu rows (the export menu, and "more" when the
 * export button has folded away). */
function ExportItems({ exporter }: { exporter: ReturnType<typeof useTranscriptExport> }) {
  return (
    <>
      <MenuItem
        icon={exporter.copied ? <Check size={14} className="text-success" /> : <ClipboardCopy size={14} />}
        onClick={() => void exporter.copy()}
      >
        {exporter.copied ? t("Copied") : t("Copy as Markdown")}
      </MenuItem>
      <MenuItem icon={<FileText size={14} />} onClick={() => exporter.download("markdown")}>
        {t("Export as Markdown")}
      </MenuItem>
      <MenuItem icon={<FileJson size={14} />} onClick={() => exporter.download("json")}>
        {t("Export as JSON")}
      </MenuItem>
      {exporter.error && <div className="px-2.5 py-1.5 text-[12px] text-danger">{exporter.error}</div>}
    </>
  );
}

function ExportMenu({ bot }: { bot: Bot }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, ref);
  const exporter = useTranscriptExport(bot, close);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("Share or export")}
        title={t("Share or export")}
        className={cn(ICON_BUTTON, open && "bg-raised-hover text-ink")}
      >
        <IconUpload size={17} />
      </button>
      {open && (
        <PopoverPanel label={t("Share or export")} className="top-full right-0 mt-1.5 w-[240px]">
          <ExportItems exporter={exporter} />
        </PopoverPanel>
      )}
    </div>
  );
}

function MoreMenu({
  bot,
  findOpen,
  onFind,
  onOpenRoutines,
  routineCount,
}: {
  bot: Bot;
  findOpen: boolean;
  onFind: () => void;
  onOpenRoutines: () => void;
  routineCount: number;
}) {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, ref);
  const exporter = useTranscriptExport(bot, close);
  const run = (action: () => void) => () => {
    action();
    setOpen(false);
  };

  const task = bot.tasks?.find((entry) => entry.threadId === bot.threadId);
  const usage = task?.usage;
  const usageText = usage ? usageChip(usage) : "";
  const billing = state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId)?.snapshot.billing;
  const usageTitle = usage
    ? [
        tn(usage.turns, "{count} turn", "{count} turns"),
        usageDetail(usage),
        hasFiniteCost(usage.costUsd) ? `${formatUsd(usage.costUsd)} ${costCaption(billing)}` : null,
      ]
        .filter(Boolean)
        .join("\n")
    : undefined;
  const folder = task?.cwd === undefined ? bot.cwd : (task.cwd ?? undefined);
  const folderName = folder ? folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || folder : undefined;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("More")}
        title={t("More")}
        className={cn(ICON_BUTTON, (open || findOpen || state.inspectorOpen) && "bg-raised-hover text-ink")}
      >
        <IconMore size={18} />
      </button>
      {open && (
        <PopoverPanel label={t("More")} className="top-full right-0 mt-1.5 w-[280px]">
          <MenuItem icon={<Search size={14} />} hint="⌘F" onClick={run(onFind)}>
            {t("Find in conversation")}
          </MenuItem>
          <MenuItem icon={<Plus size={14} />} disabled={bot.busy} onClick={run(() => dispatch({ type: "newTask", botId: bot.id }))}>
            {t("New task")}
          </MenuItem>
          <MenuItem icon={<Clock size={14} />} hint={routineCount ? String(routineCount) : undefined} onClick={run(onOpenRoutines)}>
            {t("Scheduled tasks")}
          </MenuItem>
          {/* the export button folds away in a narrow header; its rows land here */}
          <div className="hidden @max-md/chathead:block">
            <MenuDivider />
            <ExportItems exporter={exporter} />
          </div>
          <MenuDivider />
          <div className="py-1 pr-1 pl-2.5">
            <ModelPicker
              bot={bot}
              contained
              label={
                <span className="flex items-center gap-2.5 text-[13px] text-ink">
                  <Cpu size={14} className="text-ink-secondary" />
                  {t("Model")}
                </span>
              }
            />
          </div>
          <MenuDivider />
          <MenuItem
            icon={<Bug size={14} />}
            hint={state.inspectorOpen ? <Check size={13} /> : undefined}
            onClick={run(() => dispatch({ type: "toggleInspector" }))}
          >
            {t("Inspector")}
          </MenuItem>
          <MenuItem icon={<Settings2 size={14} />} onClick={run(() => dispatch({ type: "toggleSettings", open: true }))}>
            {t("Bot settings")}
          </MenuItem>
          {(usageText || folderName) && <MenuDivider />}
          {usageText && usage && (
            <MenuItem
              icon={<span className="text-[11px] font-bold">¤</span>}
              title={usageTitle}
              hint={usage.costUsd !== null ? formatUsd(usage.costUsd) : formatTokens(usage.input + usage.output)}
              onClick={run(() => dispatch({ type: "toggleSettings", open: true }))}
            >
              {t("Usage")}
            </MenuItem>
          )}
          {folderName && folder && (
            <MenuItem
              icon={<Folder size={14} />}
              title={t("Working folder: {path}", { path: folder })}
              hint={<span className="font-mono">{folderName}</span>}
              onClick={run(() => dispatch({ type: "toggleSettings", open: true }))}
            >
              {t("Working folder")}
            </MenuItem>
          )}
        </PopoverPanel>
      )}
    </div>
  );
}
