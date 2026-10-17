// The app sidebar (round-8 design, light-kit/sidebar8.html): the page
// navigation with live counts on top, a search field that opens ⌘K, the 主 Bot
// pinned as a card, the departments (sections) with their lead and the
// members that need a look, the group chats, and you + this week's usage at
// the bottom. Densities, collapsing to avatars, dragging sections, context
// menus, rename, archive, the "+" menu and the mobile drawer all stay.
import { track } from "@/lib/analytics";
import { t, tn } from "@/lib/i18n";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ArrowDownToLine,
  BellDot,
  Bot as BotIcon,
  Check,
  ClipboardCopy,
  Copy,
  Crown,
  FolderMinus,
  FolderPlus,
  Hash,
  Library,
  Loader2,
  MessageSquarePlus,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  Star,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { api, useStore, visibleMessages, type Bot, type Group, type Message } from "@/state/store";
import { getLastSeen, saveOrg, useApi, useBrief, useDecisions, useLibrary, useOrg, useUsageSummary } from "@/state/org-api";
import type { DispatchRun } from "../../shared/dispatch-types";
import type { CalendarCall } from "@/lib/calendar-calls";
import { DEPARTMENT_COLORS, type InboxItem } from "../../shared/org-types";

import { BotAvatar } from "./Avatar";
import { Diamond, Kbd } from "./ui";
import { useUpdaterState } from "@/lib/updater";
import { cn } from "@/lib/cn";
import { skillRecorderEnabled } from "@/lib/feature-flags";
import { nextRename } from "@/lib/rename";
import { downloadAllBots } from "@/lib/team-files";
import { buildDepartments, chiefBot, unassignedBots } from "@/lib/org";
import { activityTask } from "@/lib/bot-tasks";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { TeamLibraryPanel, type TeamImportResult } from "./TeamLibraryPanel";
import { RenameTitle } from "./RenameTitle";
import { BotPickerList } from "./BotPickerList";
import { openCommandPalette } from "./CommandPalette";
import {
  BriefIcon,
  CalendarIcon,
  ChiefStar,
  ComposeIcon,
  FolderIcon,
  PlugIcon,
  SidebarToggleIcon,
  SlidersIcon,
  SquareTile,
  WandIcon,
  WorkbenchIcon,
  WorkingSpinner,
  groupTint,
} from "./SidebarIcons";
import {
  loadCollapsedSections,
  loadExpandedMemberSections,
  loadSectionOrder,
  loadSidebarDensity,
  saveCollapsedSections,
  saveExpandedMemberSections,
  saveSectionOrder,
  saveSidebarDensity,
  toggleCollapsedSection,
  type SidebarDensity,
} from "@/lib/sidebar-preferences";
import {
  BOT_CHATS_SECTION_ID,
  BOTS_SECTION_ID,
  CHANNELS_SECTION_ID,
  PINNED_SECTION_ID,
  mergeSectionOrder,
  moveSection,
  orderedSidebarSections,
  partitionSidebarGroups,
  placeSection,
  sameSectionOrder,
  sidebarLayoutInteractive,
  sidebarRevealScrollTop,
  sidebarSectionCollapsed,
  sidebarSectionLabel,
  userSectionId,
  type SectionDropPlace,
} from "@/lib/sidebar-layout";
import { shownTaskTitle } from "./TaskPicker";
import { sidebarSectionAttention, type SidebarSectionAttention } from "@/lib/sidebar-attention";
import {
  activeRunsByLead,
  addedSquadsBySection,
  botRowStatus,
  cardLine,
  messageLine,
  departmentDelivered,
  foldDepartmentMembers,
  groupRowPreview,
  groupUnreadCount,
  inboxByBot,
  latestGroupDecision,
  runAssignees,
  runningWorkCount,
  sidebarTime,
  staleLibraryDocCount,
  summarizeRun,
  todayScheduleCount,
  type BotRowStatus,
} from "@/lib/sidebar-rows";
import { phoneSettingsAction, SidebarPhoneButton } from "./SidebarPhoneButton";
import { SidebarSectionHeader } from "./SidebarSectionHeader";
import { InboxPanel } from "./InboxPanel";
import { TaskFolderList } from "./TaskFolderList";
import { useInbox } from "@/lib/inbox";
import { BOT_DRAG_TYPE } from "@/components/routines/calendar-model";

// ── shared styles ─────────────────────────────────────────────────────────────
const MENU =
  "fixed z-40 overflow-hidden rounded-xl bg-card p-1.5 text-ink shadow-xl ring-1 ring-hairline/40";
const MENU_ITEM =
  "flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13.5px] text-ink hover:bg-raised-hover disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent";
const MENU_SEPARATOR = "mx-1.5 my-1 h-px bg-hairline/35";
/** the white "you are here" fill of the design's selected rows */
const SELECTED_FILL = "bg-raised shadow-xs ring-1 ring-black/[0.04]";
const ROW_HOVER = "hover:bg-raised/55";
/** amber "needs you" — the same tone as the kit's Diamond */
const AMBER = "#D97706";
/** built-in sections take colours from the design (group chats are coral) */
const BUILTIN_COLORS: Record<string, string> = {
  [PINNED_SECTION_ID]: "#F59E0B",
  [CHANNELS_SECTION_ID]: "#F97316",
  [BOT_CHATS_SECTION_ID]: "#14B8A6",
  [BOTS_SECTION_ID]: "#475467",
};
const EMPTY_RUNS: { runs?: DispatchRun[] } = { runs: [] };
const EMPTY_CALLS: { calls?: CalendarCall[] } = { calls: [] };

/** "Milind Soni" → "MS", "milind" → "M", "you@x.dev" → "Y", unset → "你"/"Y" */
function profileInitials(profile?: { name?: string; email?: string }): string {
  const name = profile?.name?.trim();
  if (name) {
    const words = name.split(/\s+/);
    return words
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("");
  }
  const email = profile?.email?.trim();
  return email ? email[0]!.toUpperCase() : t("You").slice(0, 1).toUpperCase();
}

/** Manual update check, next to the settings gear. Packaged app only (no
 * bridge in dev/browser). One button, state-dependent: check → download →
 * restart, with a brief "up to date" tick when a check finds nothing so a
 * click is never silent. The bottom-left popup handles the loud cases. */
function UpdateButton() {
  const s = useUpdaterState();
  const [checkedAt, setCheckedAt] = useState(0);
  const updater = window.ogb?.updater;
  const status = s?.status ?? "idle";
  // download and install both round-trip through main before the status
  // changes — spin on the click itself, and let the new status clear it
  const [pending, setPending] = useState(false);
  useEffect(() => setPending(false), [status]);
  // a check that found nothing lands back on idle — acknowledge it for 3s
  const upToDate = Boolean(checkedAt) && (!s || s.status === "idle") && Date.now() - checkedAt < 3000;
  useEffect(() => {
    if (!upToDate) return;
    const timer = setTimeout(() => setCheckedAt(0), 3000);
    return () => clearTimeout(timer);
  }, [upToDate]);
  if (!updater) return null;

  const working =
    pending || status === "checking" || status === "downloading" || status === "installing";
  const label =
    status === "available"
      ? t("Version {version} available — download", { version: s?.version ?? "" })
      : status === "downloading"
        ? s?.percent == null
          ? t("Starting download…")
          : t("Downloading… {percent}%", { percent: Math.round(s.percent) })
        : status === "downloaded"
          ? t("Version {version} ready — restart to update", { version: s?.version ?? "" })
          : status === "installing"
            ? t("Restarting to update…")
            : status === "checking"
              ? t("Checking for updates…")
              : upToDate
                ? t("You're up to date")
                : t("Check for updates");

  return (
    <button
      onClick={() => {
        if (status === "downloaded") {
          setPending(true);
          return void updater.install();
        }
        if (status === "available") {
          setPending(true);
          return void updater.download();
        }
        setCheckedAt(Date.now());
        void updater.check();
      }}
      disabled={working}
      title={label}
      aria-label={label}
      className="relative grid size-8 shrink-0 place-items-center rounded-[9px] text-accent-text hover:bg-raised disabled:opacity-60"
    >
      {working ? (
        <Loader2 size={16} className="animate-spin" />
      ) : upToDate ? (
        <Check size={16} />
      ) : status === "available" ? (
        <ArrowDownToLine size={16} />
      ) : (
        <RefreshCw size={16} />
      )}
      {status === "downloaded" && (
        <span className="absolute right-1 top-1 size-2 rounded-full bg-select" />
      )}
    </button>
  );
}

/** The last line of a bot's visible conversation, as one line of text. Pass
 * visibleMessages(bot): bot.messages holds every fork, so its last entry can
 * belong to a version the user switched away from. */
function lastLine(visible: readonly Message[]): string {
  const last = visible.at(-1);
  if (!last) return "";
  if (last.kind === "screen") return t("Screen frame");
  return messageLine(last);
}

/** A fresh conversation has no last line yet. When the bot has more than one
 * task, the row names the one that is open ("New task"), so a new chat from
 * the + menu visibly lands on its bot's row instead of blanking it. */
function emptyConversationLine(bot: Bot): string {
  const tasks = bot.tasks ?? [];
  if (tasks.length < 2) return "";
  const open = tasks.find((task) => task.threadId === bot.threadId);
  return open ? shownTaskTitle(open.title) : "";
}

/** The open question in a bot's own thread, when it is waiting on you. */
function openQuestion(visible: readonly Message[]): string | undefined {
  for (let index = visible.length - 1; index >= 0; index -= 1) {
    const card = visible[index]!.card;
    if (card && !card.answered && !card.dismissed) return cardLine(card) || undefined;
  }
  return undefined;
}

interface MenuState {
  botId: string;
  x: number;
  y: number;
}

// ── rows ──────────────────────────────────────────────────────────────────────

type RowDensity = SidebarDensity;

/** A row's second line, coloured by what it means. */
function StatusLine({ status, chiefCount }: { status: BotRowStatus; chiefCount?: number }) {
  if (chiefCount && chiefCount > 0) {
    return <span className="truncate text-warning">{tn(chiefCount, "{count} item for you to decide", "{count} items for you to decide")}</span>;
  }
  if (status.kind === "waiting") {
    return <span className="truncate text-warning">{t("Needs you · {reason}", { reason: status.reason })}</span>;
  }
  if (status.kind === "working") {
    return (
      <span className="flex min-w-0 items-center gap-1 text-accent-text">
        <WorkingSpinner size={12} className="shrink-0 motion-safe:animate-spin" />
        <span className="truncate">{t("Working")}</span>
      </span>
    );
  }
  if (status.kind === "run") return <span className="truncate text-ink-secondary">{status.text}</span>;
  return <span className="truncate text-ink-secondary">{status.text}</span>;
}

function statusTitle(status: BotRowStatus, chiefCount?: number): string {
  if (chiefCount && chiefCount > 0) return tn(chiefCount, "{count} item for you to decide", "{count} items for you to decide");
  if (status.kind === "waiting") return t("Needs you · {reason}", { reason: status.reason });
  if (status.kind === "working") return t("Working");
  return status.text;
}

function BotRow({
  bot,
  density,
  variant,
  selected,
  status,
  time,
  needsYou,
  chiefCount,
  onMenu,
  onArchive,
  archiveDisabled,
}: {
  bot: Bot;
  density: RowDensity;
  variant: "chief" | "lead" | "member";
  selected: boolean;
  status: BotRowStatus;
  time: string;
  /** the amber diamond: waiting on you */
  needsYou: boolean;
  /** the 主 Bot's "N items for you to decide" */
  chiefCount?: number;
  onMenu: (menu: MenuState) => void;
  onArchive: (bot: Bot) => void;
  archiveDisabled: boolean;
}) {
  const { dispatch } = useStore();
  const [renaming, setRenaming] = useState(false);
  const iconOnly = density === "icons";
  const compact = density === "compact";
  const chief = variant === "chief";
  useEffect(() => {
    if (iconOnly) setRenaming(false);
  }, [iconOnly]);
  const tileSize = iconOnly ? (chief ? 32 : 30) : compact ? (chief ? 22 : 18) : chief ? 24 : 20;
  // the 主 Bot's diamond sits on the right; members also mark their tile
  // (in avatar-only mode the tile mark is the only one)
  const marker = needsYou && (!chief || iconOnly) ? "waiting" : undefined;
  const label = statusTitle(status, chiefCount);

  const rowClass = cn(
    "flex w-full items-center text-left transition-colors",
    iconOnly
      ? cn("justify-center rounded-[11px]", chief ? "h-12" : "h-10")
      : cn("gap-2 rounded-[11px] px-1.5", chief ? (compact ? "h-10" : "h-12") : compact ? "h-8" : "h-10"),
    selected ? SELECTED_FILL : ROW_HOVER,
  );
  const select = () => {
    dispatch({ type: "select", id: bot.id });
    // the badge may be about a different task than the active one: open the
    // conversation that actually has the news instead of a blank new task
    const target = activityTask(bot);
    if (target) dispatch({ type: "switchTask", botId: bot.id, threadId: target.threadId });
  };
  const openMenuAt = (x: number, y: number) => onMenu({ botId: bot.id, x, y });
  const flag = needsYou ? (
    <Diamond size={13} label={t("Needs you")} />
  ) : bot.unread ? (
    <span className="size-[7px] rounded-full bg-select" role="img" aria-label={t("Unread")} />
  ) : null;
  const body = (
    <>
      <span className={cn("flex shrink-0 items-center justify-center", chief && !iconOnly && "pt-1")}>
        <BotAvatar bot={bot} size={tileSize} crown={chief} marker={marker} label={bot.name} />
      </span>
      {!iconOnly && (
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="flex h-[17.5px] min-w-0 items-center gap-1 text-[13px] font-semibold text-ink">
            {bot.pinned && !chief && <Pin size={11} className="shrink-0 text-ink-secondary" aria-hidden />}
            <RenameTitle
              key={iconOnly ? "icons" : "expanded"}
              value={bot.name}
              onCommit={(name) => dispatch({ type: "updateBot", botId: bot.id, patch: { name } })}
              onEditingChange={setRenaming}
              className="truncate"
              inputClassName="w-full rounded bg-inset px-1 py-0.5 text-[13px] font-semibold"
            />
            {chief && <ChiefStar size={12} className="shrink-0" />}
            {compact && status.kind === "working" && (
              <WorkingSpinner size={11} className="shrink-0 text-accent-text motion-safe:animate-spin" />
            )}
          </span>
          {!compact && (
            <span className="flex h-[15.5px] min-w-0 items-center text-[11.5px]">
              <StatusLine status={status} chiefCount={chiefCount} />
            </span>
          )}
        </span>
      )}
      {!iconOnly &&
        (compact ? (
          // The archive button is absolutely positioned over this column while
          // the row is hovered; fade the time and unread marker so the two
          // never draw on top of each other.
          <span className="flex shrink-0 items-center gap-1.5 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
            {flag}
            {time && <span className="text-[11.5px] text-ink-secondary/75 tabular-nums">{time}</span>}
          </span>
        ) : (
          <span className="flex shrink-0 flex-col items-end gap-px transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
            <span className="flex h-[17.5px] items-center text-[11.5px] text-ink-secondary/75 tabular-nums">{time}</span>
            <span className="flex h-[15.5px] items-center">{flag}</span>
          </span>
        ))}
    </>
  );
  const onContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    openMenuAt(event.clientX, event.clientY);
  };

  // Keep the rename <input> out of role="button" — a button's descendants
  // are presentational, which hides the field from assistive tech.
  if (renaming) {
    return (
      <div className={rowClass} onContextMenu={onContextMenu}>
        {body}
      </div>
    );
  }

  return (
    <div className="group relative" title={iconOnly ? `${bot.name} · ${label}` : compact ? label : undefined} data-sidebar-bot={bot.id}>
      <div
        role="button"
        tabIndex={0}
        aria-label={iconOnly ? bot.name : undefined}
        aria-current={selected ? "page" : undefined}
        onClick={select}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            select();
          } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            // the menu must be reachable without a pointer
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            openMenuAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
          }
        }}
        onContextMenu={onContextMenu}
        // drag a bot onto the calendar to give it a routine there
        draggable
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "copy";
          event.dataTransfer.setData(BOT_DRAG_TYPE, bot.id);
        }}
        className={rowClass}
      >
        {body}
      </div>
      {iconOnly && bot.unread && !needsYou && (
        <span className="pointer-events-none absolute right-2 top-1.5 size-2 rounded-full border border-panel bg-select" />
      )}
      {!iconOnly && (
        <button
          type="button"
          disabled={archiveDisabled}
          onClick={() => onArchive(bot)}
          aria-label={t("Archive {name}", { name: bot.name })}
          title={
            bot.chiefOfStaff
              ? t("Choose another Chief of Staff first")
              : archiveDisabled
                ? t("Keep at least one active bot")
                : t("Archive {name}", { name: bot.name })
          }
          className="absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-lg bg-card text-ink-secondary opacity-0 shadow-xs ring-1 ring-hairline/40 transition hover:text-ink focus:opacity-100 disabled:hidden group-hover:opacity-100 group-focus-within:opacity-100"
        >
          <Archive size={13} />
        </button>
      )}
    </div>
  );
}

/** A group's tile: "#" for a group chat, people for a meeting, and the two
 * faces for a bot-to-bot chat. */
function GroupTile({ group, members, meeting, size }: { group: Group; members: Bot[]; meeting: boolean; size: number }) {
  if (group.dm && members.length >= 2) {
    const inner = Math.round(size * 0.66);
    return (
      <span className="relative inline-block shrink-0" style={{ width: size, height: size }} aria-hidden>
        <span className="absolute left-0 top-0">
          <BotAvatar bot={members[0]!} size={inner} crown={false} />
        </span>
        <span className="absolute bottom-0 right-0 rounded-[30%] ring-2 ring-panel">
          <BotAvatar bot={members[1]!} size={inner} crown={false} />
        </span>
      </span>
    );
  }
  return (
    <SquareTile tint={groupTint(group.id, meeting)} size={size}>
      {meeting ? <Users size={Math.round(size * 0.47)} strokeWidth={2} /> : <Hash size={Math.round(size * 0.47)} strokeWidth={2.1} />}
    </SquareTile>
  );
}

function GroupRow({
  group,
  density,
  selected,
  members,
  meeting,
  preview,
  time,
  unreadCount,
  onMenu,
}: {
  group: Group;
  density: RowDensity;
  selected: boolean;
  members: Bot[];
  meeting: boolean;
  preview: string;
  time: string;
  unreadCount: number;
  onMenu: (menu: { groupId: string; x: number; y: number }) => void;
}) {
  const { dispatch } = useStore();
  const iconOnly = density === "icons";
  const compact = density === "compact";
  return (
    <button
      type="button"
      data-sidebar-group={group.id}
      onClick={() => dispatch({ type: "select", id: group.id })}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ groupId: group.id, x: e.clientX, y: e.clientY });
      }}
      // the menu must be reachable without a pointer: Shift+F10, and the
      // dedicated ContextMenu key (whose native event carries no useful
      // coordinates) both open it centered on the row
      onKeyDown={(e) => {
        if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        onMenu({ groupId: group.id, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      }}
      aria-current={selected ? "page" : undefined}
      className={cn(
        "relative flex w-full items-center text-left transition-colors",
        iconOnly ? "h-10 justify-center rounded-[11px]" : cn("gap-2 rounded-[11px] px-1.5", compact ? "h-8" : "h-10"),
        selected ? SELECTED_FILL : ROW_HOVER,
      )}
      title={iconOnly ? `${group.name} · ${preview}` : compact ? preview : undefined}
      aria-label={iconOnly ? group.name : undefined}
    >
      <GroupTile group={group} members={members} meeting={meeting} size={iconOnly ? 30 : compact ? 22 : 30} />
      {!iconOnly && (
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="flex h-[17.5px] items-center truncate text-[13px] font-semibold text-ink">
            <span className="truncate">{group.name}</span>
          </span>
          {!compact && <span className="h-[15.5px] truncate text-[11.5px] leading-[15.5px] text-ink-secondary">{preview}</span>}
        </span>
      )}
      {!iconOnly && (
        <span className={cn("flex shrink-0 items-end", compact ? "items-center gap-1.5" : "flex-col gap-px")}>
          <span className={cn("flex items-center text-[11.5px] text-ink-secondary/75 tabular-nums", !compact && "h-[17.5px]", compact && "order-2")}>{time}</span>
          <span className={cn("flex items-center", !compact && "h-[15.5px]")}>
            {unreadCount > 0 && (
              <span
                className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-select px-[5px] text-[11px] font-bold leading-none"
                style={{ color: "var(--color-accent-ink)" }}
                role="img"
                aria-label={tn(unreadCount, "{count} unread message", "{count} unread messages")}
              >
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </span>
        </span>
      )}
      {iconOnly && unreadCount > 0 && (
        <span className="pointer-events-none absolute right-2 top-1.5 size-2 rounded-full border border-panel bg-select" />
      )}
    </button>
  );
}

/** One of the page links on top, with its live count on the right. */
function NavRow({
  icon,
  label,
  meta,
  badge,
  selected,
  iconOnly,
  onClick,
  nav,
}: {
  icon: ReactNode;
  label: string;
  meta?: ReactNode;
  /** the dot or count shown on the icon in avatar-only mode */
  badge?: ReactNode;
  selected: boolean;
  iconOnly: boolean;
  onClick: () => void;
  nav: string;
}) {
  return (
    <button
      type="button"
      data-nav={nav}
      onClick={onClick}
      aria-current={selected ? "page" : undefined}
      aria-label={iconOnly ? label : undefined}
      title={iconOnly ? label : undefined}
      className={cn(
        "relative flex h-8 w-full shrink-0 items-center rounded-[9px] text-left text-[13.5px] font-medium transition-colors",
        iconOnly ? "justify-center" : "gap-2.5 px-2.5",
        selected ? cn(SELECTED_FILL, "text-ink") : "text-ink/80 hover:bg-raised/55 hover:text-ink",
      )}
    >
      <span className={cn("shrink-0", selected ? "text-select" : "text-ink-secondary")}>{icon}</span>
      {!iconOnly && <span className="min-w-0 flex-1 truncate">{label}</span>}
      {!iconOnly && meta}
      {iconOnly && badge}
    </button>
  );
}

function RoomContextMenu({
  menu,
  onClose,
  onMoveToSection,
}: {
  menu: { groupId: string; x: number; y: number };
  onClose: () => void;
  onMoveToSection: (groupId: string) => void;
}) {
  const { state, dispatch } = useStore();
  const group = state.groups.find((g) => g.id === menu.groupId);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(group?.name ?? "");

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-room-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  if (!group) return null;
  const isBotChat = Boolean(group.dm);
  const saveRename = () => {
    const name = nextRename(group.name, draft);
    if (name) dispatch({ type: "patchGroup", groupId: group.id, patch: { name } });
    onClose();
  };
  const top = Math.min(menu.y, window.innerHeight - 204);
  const left = Math.min(menu.x, window.innerWidth - 240);
  return createPortal(
    <div data-room-menu role="menu" style={{ top, left }} className={cn(MENU, "w-[228px]")}>
      {renaming ? (
        <div className="flex items-center gap-1 px-1 py-0.5">
          <input
            autoFocus
            value={draft}
            maxLength={100}
            aria-label={t("Rename {name}", { name: group.name })}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                saveRename();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
            className="min-w-0 flex-1 rounded-lg bg-control px-2 py-1.5 text-[13.5px] text-ink focus:outline-none focus:ring-1 focus:ring-select"
          />
          <button
            type="button"
            onClick={saveRename}
            aria-label={isBotChat ? t("Save chat name") : t("Save group chat name")}
            title={t("Save")}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised-hover hover:text-ink"
          >
            <Check size={15} />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={isBotChat ? t("Cancel chat rename") : t("Cancel group chat rename")}
            title={t("Cancel")}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised-hover hover:text-ink"
          >
            <X size={15} />
          </button>
        </div>
      ) : (
        <button
          role="menuitem"
          onClick={() => {
            setDraft(group.name);
            setRenaming(true);
          }}
          className={MENU_ITEM}
        >
          <Pencil size={15} className="text-ink-secondary" />
          {isBotChat ? t("Rename chat") : t("Rename group chat")}
        </button>
      )}
      {!isBotChat && (
        <button
          role="menuitem"
          onClick={() => {
            onClose();
            onMoveToSection(group.id);
          }}
          className={MENU_ITEM}
        >
          <FolderPlus size={15} className="text-ink-secondary" />
          {t("Move to context")}
        </button>
      )}
      <button
        role="menuitem"
        onClick={() => {
          void navigator.clipboard?.writeText(group.threadId);
          onClose();
        }}
        className={MENU_ITEM}
      >
        <ClipboardCopy size={15} className="text-ink-secondary" />
        {t("Copy conversation ID")}
      </button>
      <div className={MENU_SEPARATOR} />
      <button
        role="menuitem"
        onClick={() => {
          dispatch({ type: "deleteGroup", groupId: group.id });
          onClose();
        }}
        className={cn(MENU_ITEM, "text-danger")}
      >
        <Trash2 size={15} />
        {isBotChat ? t("Delete chat") : t("Delete group chat")}
      </button>
    </div>,
    document.body,
  );
}

/** Pick members and an optional Work/Personal/project context, then create. */
function NewRoomPanel({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [name, setName] = useState("");
  const [section, setSection] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const bots = state.bots.filter((b) => !b.hidden);
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const create = () => {
    if (!picked.size) return;
    dispatch({
      type: "createGroup",
      memberIds: [...picked],
      name: name.trim() || undefined,
      section: section.trim() || undefined,
    });
    track("room_created", { members: picked.size, context: Boolean(section.trim()) });
    onClose();
  };
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/35"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("New group chat")}
        className="animate-pop-in w-[360px] rounded-2xl bg-card p-4 shadow-2xl ring-1 ring-hairline/40"
      >
        <div className="mb-3 text-[15px] font-semibold text-ink">{t("New group chat")}</div>
        <input
          autoFocus
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
            if (e.key === "Escape") onClose();
          }}
          placeholder={t("Group chat name (for example, Website launch)")}
          className="mb-2.5 h-9 w-full rounded-[10px] bg-control/60 px-3 text-[13.5px] text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-1 focus:ring-select"
        />
        <input
          value={section}
          maxLength={60}
          onChange={(e) => setSection(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
            if (e.key === "Escape") onClose();
          }}
          placeholder={t("Context (optional): Work, Personal, Client…")}
          aria-label={t("Group chat context")}
          className="mb-3 h-9 w-full rounded-[10px] bg-control/60 px-3 text-[13.5px] text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-1 focus:ring-select"
        />
        <BotPickerList
          bots={bots}
          picked={picked}
          onToggle={toggle}
          emptyHint={t("Create a bot first — group chats are made of bots.")}
        />
        <button
          onClick={create}
          disabled={!picked.size}
          className="mt-3 h-9 w-full rounded-[10px] bg-primary text-[13.5px] font-semibold text-primary-ink hover:brightness-110 disabled:opacity-40"
        >
          {picked.size
            ? tn(picked.size, "Create group chat · {count} bot", "Create group chat · {count} bots")
            : t("Create group chat")}
        </button>
      </div>
    </div>
  );
}

/** Move-to-section popover: existing sections as chips (checkmark on the
 * target's current one), a create field, and a remove action. Serves bots
 * and group chats alike — the caller supplies the assignment. Mirrors the
 * context menu's fixed positioning + dismiss-on-outside-click contract. */
function SectionPicker({
  current,
  anchor,
  onClose,
  onAssign,
}: {
  /** the target's current section; undefined = none */
  current: string | undefined;
  anchor: { x: number; y: number };
  onClose: () => void;
  /** "" clears — the server drops an empty section */
  onAssign: (section: string) => void;
}) {
  const { state } = useStore();
  const [name, setName] = useState("");
  const trimmed = name.trim();

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-section-picker]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  // Hidden bots can carry a stale assignment; don't offer it as a context.
  // Group chats and bots share one namespace, so Work or Personal can hold both.
  const sections = [
    ...new Set([
      ...state.bots.filter((b) => !b.hidden && b.section).map((b) => b.section!),
      ...state.groups.filter((g) => g.section).map((g) => g.section!),
    ]),
  ];

  const assign = (section: string) => {
    onAssign(section);
    onClose();
  };

  const top = Math.max(8, Math.min(anchor.y, window.innerHeight - 300));
  const left = Math.min(anchor.x, window.innerWidth - 260);

  return (
    <div data-section-picker style={{ top, left }} className={cn(MENU, "w-[236px] py-2")}>
      <div className="px-2.5 pb-1 text-[11.5px] font-semibold text-ink-secondary">{t("Move to context")}</div>
      {sections.length > 0 && (
        <div className="flex flex-col gap-0.5 py-1">
          {sections.map((section) => (
            <button
              key={section}
              onClick={() => assign(section)}
              className={cn(MENU_ITEM, "justify-between", section === current && "bg-raised-hover")}
            >
              <span className="truncate">{section}</span>
              {section === current && <Check size={14} className="shrink-0 text-select" />}
            </button>
          ))}
        </div>
      )}
      <form
        className="flex items-center gap-1.5 px-1 py-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (!trimmed || trimmed.length > 60) return;
          assign(trimmed);
        }}
      >
        <input
          autoFocus
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("New context…")}
          aria-label={t("New context name")}
          className="h-8 w-full rounded-lg bg-control/60 px-2.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        <button
          type="submit"
          disabled={!trimmed || trimmed.length > 60}
          className={cn(
            "h-8 shrink-0 rounded-lg px-2.5 text-[12px] font-semibold",
            trimmed ? "bg-primary text-primary-ink" : "bg-control/60 text-ink-secondary",
          )}
        >
          {t("Add")}
        </button>
      </form>
      {current && (
        <>
          <div className={MENU_SEPARATOR} />
          <button onClick={() => assign("")} className={cn(MENU_ITEM, "text-danger")}>
            <FolderMinus size={15} />
            {t("Remove from context")}
          </button>
        </>
      )}
    </div>
  );
}

function BotContextMenu({
  menu,
  onClose,
  onArchive,
  onMoveToSection,
}: {
  menu: MenuState;
  onClose: () => void;
  onArchive: (bot: Bot) => void;
  onMoveToSection: (botId: string) => void;
}) {
  const { state, dispatch } = useStore();
  const { data: org } = useOrg();
  const bot = state.bots.find((b) => b.id === menu.botId);
  const isMain = Boolean(bot) && chiefBot(state.bots, org)?.id === bot?.id;

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-bot-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  if (!bot) return null;
  const engine = state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
  const canCoordinate = engine?.capabilities?.agentsMcp === true;
  const visibleBotCount = state.bots.filter((candidate) => !candidate.hidden).length;
  const archiveBlocked = Boolean(bot.chiefOfStaff) || visibleBotCount <= 1;
  // in a department the chief of staff is its lead (主管); unsectioned, the 总控
  const department = bot.section?.trim() || "";
  const archiveHint = bot.chiefOfStaff
    ? department
      ? t("Choose another lead for {department} first", { department })
      : t("Choose another Chief of Staff first")
    : visibleBotCount <= 1
      ? t("Keep at least one active bot")
      : undefined;
  // keep the menu on-screen near the click
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - 380));
  const left = Math.min(menu.x, window.innerWidth - 240);

  const item = (
    icon: React.ReactNode,
    label: string,
    onClick?: () => void,
    opts?: { danger?: boolean; disabled?: boolean; hint?: string },
  ) => (
    <button
      key={label}
      role="menuitem"
      disabled={opts?.disabled}
      onClick={() => {
        onClick?.();
        onClose();
      }}
      title={opts?.hint}
      className={cn(MENU_ITEM, opts?.danger && "text-danger")}
    >
      {icon}
      {label}
    </button>
  );
  const divider = (key: string) => <div key={key} className={MENU_SEPARATOR} />;

  return (
    <div data-bot-menu role="menu" style={{ top, left }} className={cn(MENU, "w-[228px]")}>
      {[
        item(
          bot.pinned ? <PinOff size={15} className="text-ink-secondary" /> : <Pin size={15} className="text-ink-secondary" />,
          bot.pinned ? t("Unpin") : t("Pin"),
          () => dispatch({ type: "updateBot", botId: bot.id, patch: { pinned: !bot.pinned } }),
        ),
        ...(isMain
          ? []
          : [
              item(<Star size={15} className="text-ink-secondary" />, t("Make main bot"), () => {
                void saveOrg({ chiefBotId: bot.id }).catch((error: unknown) =>
                  dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) }),
                );
              }),
            ]),
        item(
          <Crown size={15} className={bot.chiefOfStaff ? "text-select" : "text-ink-secondary"} />,
          department
            ? bot.chiefOfStaff
              ? t("Remove as lead of {department}", { department })
              : t("Make lead of {department}", { department })
            : bot.chiefOfStaff
              ? t("Remove Chief of Staff")
              : t("Make Chief of Staff"),
          () => dispatch({ type: "updateBot", botId: bot.id, patch: { chiefOfStaff: !bot.chiefOfStaff } }),
          {
            disabled: !bot.chiefOfStaff && !canCoordinate,
            hint: !bot.chiefOfStaff && !canCoordinate ? t("Choose a Claude or ACP engine first") : undefined,
          },
        ),
        item(<FolderPlus size={15} className="text-ink-secondary" />, t("Move to section"), () => {
          onClose();
          onMoveToSection(bot.id);
        }),
        item(<BellDot size={15} className="text-ink-secondary" />, t("Mark as Unread"), () =>
          dispatch({ type: "markUnread", botId: bot.id }),
        ),
        divider("d1"),
        item(<Pencil size={15} className="text-ink-secondary" />, t("Edit Profile"), () => {
          dispatch({ type: "select", id: bot.id });
          dispatch({ type: "toggleSettings", open: true });
        }),
        item(<Copy size={15} className="text-ink-secondary" />, t("Duplicate"), () =>
          dispatch({ type: "duplicateBot", botId: bot.id }),
        ),
        divider("d2"),
        item(<ClipboardCopy size={15} className="text-ink-secondary" />, t("Copy conversation ID"), () => {
          void navigator.clipboard?.writeText(bot.threadId);
        }),
        divider("d3"),
        item(
          <Archive size={15} className="text-ink-secondary" />,
          t("Archive"),
          () => onArchive(bot),
          {
            disabled: archiveBlocked,
            hint: archiveHint,
          },
        ),
        item(
          <Trash2 size={15} />,
          t("Delete"),
          () => dispatch({ type: "deleteBot", botId: bot.id }),
          { danger: true },
        ),
      ]}
    </div>
  );
}

function ArchivedBotsPanel({
  bots,
  onClose,
  onRestored,
}: {
  bots: Bot[];
  onClose: () => void;
  onRestored: (message: string) => void;
}) {
  const { dispatch } = useStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [restoringAll, setRestoringAll] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyId && !restoringAll) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busyId, onClose, restoringAll]);

  const restore = async (bot: Bot) => {
    setBusyId(bot.id);
    setError("");
    try {
      const response = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: false }),
      });
      dispatch({ type: "botPatched", bot: response.bot });
      dispatch({ type: "select", id: bot.id });
      onRestored(t("{name} restored", { name: bot.name }));
      if (bots.length === 1) onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  const restoreAll = async () => {
    setRestoringAll(true);
    setError("");
    try {
      const responses = await Promise.all(
        bots.map((bot) =>
          api(`/api/bots/${bot.id}`, {
            method: "PATCH",
            body: JSON.stringify({ hidden: false }),
          }),
        ),
      );
      for (const response of responses) dispatch({ type: "botPatched", bot: response.bot });
      const first = bots[0];
      if (first) dispatch({ type: "select", id: first.id });
      onRestored(tn(bots.length, "{count} bot restored", "{count} bots restored"));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRestoringAll(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 sm:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && !busyId && !restoringAll && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="archived-bots-title"
        tabIndex={-1}
        style={{ maxHeight: "min(680px, calc(100dvh - 2rem))" }}
        className="animate-pop-in flex w-full max-w-[760px] flex-col overflow-hidden rounded-[20px] bg-card shadow-2xl ring-1 ring-hairline/40 outline-none"
      >
        <header className="flex items-start justify-between gap-4 px-6 pb-4 pt-6 sm:px-8 sm:pt-7">
          <div>
            <h2 id="archived-bots-title" className="text-[20px] font-bold tracking-[-0.01em] text-ink">{t("Archived bots")}</h2>
            <p className="mt-1 text-[13px] text-ink-secondary">{t("Conversations are kept until you choose to delete a bot.")}</p>
          </div>
          <div className="flex items-center gap-1">
            {bots.length > 1 && (
              <button
                onClick={() => void restoreAll()}
                disabled={restoringAll || Boolean(busyId)}
                className="flex h-8 items-center gap-1.5 rounded-lg bg-control px-3 text-[12.5px] font-semibold text-ink hover:bg-raised-hover disabled:opacity-40"
              >
                {restoringAll && <Loader2 size={13} className="animate-spin" />}
                {t("Restore all")}
              </button>
            )}
            <button
              onClick={onClose}
              disabled={restoringAll || Boolean(busyId)}
              className="flex size-9 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised-hover hover:text-ink disabled:opacity-40"
              aria-label={t("Close archived bots")}
            >
              <X size={19} />
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-7 pt-3 sm:px-8">
          <div className="mb-3 text-[12px] font-medium text-ink-secondary">{t("{count} archived", { count: bots.length })}</div>
          <div className="grid grid-cols-1 gap-x-8 md:grid-cols-2">
            {bots.map((bot) => (
              <div key={bot.id} className="flex min-h-[72px] items-center gap-3 border-b border-hairline/35 px-1 py-3">
                <BotAvatar bot={bot} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-semibold text-ink">{bot.name}</div>
                  <div className="mt-0.5 truncate text-[12.5px] text-ink-secondary">{bot.title || t("Bot")}</div>
                </div>
                <button
                  onClick={() => void restore(bot)}
                  disabled={restoringAll || Boolean(busyId)}
                  className="flex h-8 min-w-[72px] items-center justify-center gap-1.5 rounded-lg bg-control px-3 text-[12.5px] font-semibold text-ink hover:bg-raised-hover disabled:opacity-40"
                >
                  {busyId === bot.id && <Loader2 size={13} className="animate-spin" />}
                  {t("Restore")}
                </button>
              </div>
            ))}
          </div>
          {error && <div role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── the sidebar ───────────────────────────────────────────────────────────────

type SectionRow = { kind: "bot"; bot: Bot; role: "lead" | "member" } | { kind: "group"; group: Group };

interface SectionView {
  id: string;
  label: string;
  color?: string;
  note?: ReactNode;
  count: number;
  rows: SectionRow[];
  /** everything in the section, for the collapsed summary */
  bots: Bot[];
  groups: Group[];
}

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const importReturnRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [sectionPicker, setSectionPicker] = useState<MenuState | null>(null);
  const [roomMenu, setRoomMenu] = useState<{ groupId: string; x: number; y: number } | null>(null);
  const [roomSectionPicker, setRoomSectionPicker] = useState<{ groupId: string; x: number; y: number } | null>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const [newRoom, setNewRoom] = useState(false);
  const [teamLibraryOpen, setTeamLibraryOpen] = useState(false);
  const [teamInstallUrl, setTeamInstallUrl] = useState<string | null>(null);
  const [archivedBotsOpen, setArchivedBotsOpen] = useState(false);
  const [exportingTeam, setExportingTeam] = useState(false);
  const [teamFeedback, setTeamFeedback] = useState<{
    error: boolean;
    text: string;
    undo?: TeamImportResult;
    restoreBot?: { id: string; name: string };
  } | null>(null);
  const [density, setDensityState] = useState<SidebarDensity>(() => loadSidebarDensity());
  const [lastExpandedDensity, setLastExpandedDensity] = useState<Exclude<SidebarDensity, "icons">>(() => {
    const saved = loadSidebarDensity();
    return saved === "icons" ? "comfortable" : saved;
  });
  const [collapsedSections, setCollapsedSections] = useState<string[]>(() => loadCollapsedSections());
  const [expandedMembers, setExpandedMembers] = useState<string[]>(() => loadExpandedMemberSections());
  const [sectionOrder, setSectionOrder] = useState<string[]>(() => loadSectionOrder());
  const [draggingSectionId, setDraggingSectionId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; place: SectionDropPlace } | null>(null);
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");
  const sectionDragRef = useRef<{
    from: string | null;
    over: { id: string; place: SectionDropPlace } | null;
  }>({ from: null, over: null });
  // a minute clock for the relative row times ("Yesterday" rolls over)
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // ── the company layer (polled; empty until the server knows the routes) ──
  const { data: org } = useOrg();
  const { data: brief } = useBrief(getLastSeen());
  const { data: usage } = useUsageSummary();
  const { data: library } = useLibrary();
  const { data: decisions } = useDecisions();
  const { data: dispatchState } = useApi("/api/dispatch/state", EMPTY_RUNS, 5_000);
  const { data: calendarCalls } = useApi("/api/calendar-calls", EMPTY_CALLS, 60_000);

  const iconOnly = density === "icons";
  const compact = density === "compact";

  const setDensity = (next: SidebarDensity) => {
    setDensityState(next);
    if (next !== "icons") setLastExpandedDensity(next);
    saveSidebarDensity(next);
  };

  const toggleCollapsed = () => {
    if (density === "icons") setDensity(lastExpandedDensity);
    else {
      setLastExpandedDensity(density);
      setDensity("icons");
    }
  };

  // Esc closes the drawer, mirroring ApiKeys.tsx:75-85. Bound only while the
  // drawer is open — on mobile, exactly when a bot/room context menu or the
  // New Group Chat panel can be open on top of it, so the same Escape press
  // closes them together. Fine, since both directions are "get me out of here."
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);

  useEffect(() => {
    if (!plusOpen) return;
    const closeMenu = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPlusOpen(false);
    };
    window.addEventListener("keydown", closeMenu);
    return () => window.removeEventListener("keydown", closeMenu);
  }, [plusOpen]);

  useEffect(() => {
    return window.ogb?.onPackageInstall?.((url) => {
      setTeamInstallUrl(url);
      setTeamLibraryOpen(true);
    });
  }, []);

  useEffect(() => {
    if (!teamFeedback) return;
    const timer = window.setTimeout(() => setTeamFeedback(null), 5000);
    return () => window.clearTimeout(timer);
  }, [teamFeedback]);

  const exportAllBots = async () => {
    setExportingTeam(true);
    setTeamFeedback(null);
    try {
      const exported = await downloadAllBots();
      track("team_exported", { members: exported.members, scope: "all_visible" });
      setTeamFeedback({ error: false, text: t("{count} bots exported", { count: exported.members }) });
    } catch (cause) {
      setTeamFeedback({
        error: true,
        text: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setExportingTeam(false);
    }
  };

  const undoTeamLoad = async (result: TeamImportResult) => {
    setTeamFeedback(null);
    try {
      await Promise.all([
        ...result.importedRoutineIds.map((routineId) =>
          api(`/api/routines/${routineId}`, { method: "DELETE" }).then(() =>
            dispatch({ type: "routineDeleted", routineId }),
          ),
        ),
        ...result.importedGroupIds.map((groupId) =>
          api(`/api/groups/${groupId}`, { method: "DELETE" }).then(() =>
            dispatch({ type: "groupDeleted", groupId }),
          ),
        ),
      ]);
      const archiveNew = await Promise.all(
        result.importedBotIds.map((botId) =>
          api(`/api/bots/${botId}`, {
            method: "PATCH",
            body: JSON.stringify({ hidden: true, chiefOfStaff: false }),
          }),
        ),
      );
      for (const response of archiveNew) dispatch({ type: "botPatched", bot: response.bot });

      const previousChiefs = result.archived.filter((bot) => bot.chiefOfStaff);
      const restoreOthers = await Promise.all(
        result.archived
          .filter((bot) => !bot.chiefOfStaff)
          .map((bot) =>
            api(`/api/bots/${bot.id}`, {
              method: "PATCH",
              body: JSON.stringify({ hidden: false }),
            }),
          ),
      );
      for (const response of restoreOthers) dispatch({ type: "botPatched", bot: response.bot });
      const restoredChiefs = await Promise.all(
        previousChiefs.map((previousChief) =>
          api(`/api/bots/${previousChief.id}`, {
            method: "PATCH",
            body: JSON.stringify({ hidden: false, chiefOfStaff: true }),
          }),
        ),
      );
      for (const response of restoredChiefs) dispatch({ type: "botPatched", bot: response.bot });
      const first = result.archived[0];
      if (first) dispatch({ type: "select", id: first.id });
      setTeamFeedback({ error: false, text: t("Previous team restored") });
    } catch (cause) {
      setTeamFeedback({ error: true, text: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const archiveBot = async (bot: Bot) => {
    const activeBots = state.bots.filter((candidate) => !candidate.hidden);
    if (bot.chiefOfStaff || activeBots.length <= 1) return;
    setTeamFeedback(null);
    try {
      const response = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: true }),
      });
      dispatch({ type: "botPatched", bot: response.bot });
      if (state.selectedId === bot.id) {
        const next = activeBots.find((candidate) => candidate.id !== bot.id);
        if (next) dispatch({ type: "select", id: next.id });
      }
      setTeamFeedback({
        error: false,
        text: t("{name} archived", { name: bot.name }),
        restoreBot: { id: bot.id, name: bot.name },
      });
    } catch (cause) {
      setTeamFeedback({ error: true, text: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const undoBotArchive = async (bot: { id: string; name: string }) => {
    setTeamFeedback(null);
    try {
      const response = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: false }),
      });
      dispatch({ type: "botPatched", bot: response.bot });
      dispatch({ type: "select", id: bot.id });
      setTeamFeedback({ error: false, text: t("{name} restored", { name: bot.name }) });
    } catch (cause) {
      setTeamFeedback({ error: true, text: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const macInset = capabilities.windowChrome === "mac-inset";
  const browser = capabilities.host.label === "Browser";
  // SAFETY: Electron's documented -webkit-app-region CSS property is not in
  // React's CSSProperties type, but the renderer accepts it as an inline style.
  const windowDragStyle = macInset
    ? ({ WebkitAppRegion: "drag" } as React.CSSProperties)
    : undefined;
  // SAFETY: Same Electron-only CSS property as windowDragStyle; interactive
  // buttons must explicitly opt out of the draggable title-bar region.
  const windowNoDragStyle = macInset
    ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties)
    : undefined;

  // ── what the rows say ──
  const runs = useMemo(() => dispatchState.runs ?? [], [dispatchState]);
  const runsByLead = useMemo(() => activeRunsByLead(runs), [runs]);
  const inbox = brief.needsYou;
  const approvalInbox = useInbox();
  const [inboxOpen, setInboxOpen] = useState(false);
  const inboxForBot = useMemo(() => inboxByBot(inbox), [inbox]);
  const meetingRoomIds = useMemo(
    () => new Set((calendarCalls.calls ?? []).map((call) => call.roomId).filter((id): id is string => Boolean(id))),
    [calendarCalls],
  );
  const chief = chiefBot(state.bots, org);
  const isSelected = (id: string) => state.activeView === "chat" && state.selectedId === id;
  const waitingOnYou = (bot: Bot) => (inboxForBot.get(bot.id)?.length ?? 0) > 0 || bot.activity === "waiting-on-you";
  const rowStatus = (bot: Bot, items: readonly InboxItem[], visible: readonly Message[]) => {
    const run = runsByLead.get(bot.id);
    return botRowStatus({
      activity: bot.activity,
      busy: bot.busy,
      inbox: items,
      waitingReason: bot.activity === "waiting-on-you" ? openQuestion(visible) : undefined,
      run: run ? summarizeRun(run) : null,
      preview: lastLine(visible),
    });
  };
  const previewFor = (bot: Bot, visible: readonly Message[]) => (visible.length ? undefined : emptyConversationLine(bot));
  const botById = useMemo(() => new Map(state.bots.map((bot) => [bot.id, bot])), [state.bots]);
  const squadBySection = useMemo(
    () => addedSquadsBySection(runs, (id) => botById.get(id)?.section?.trim() || undefined),
    [runs, botById],
  );
  const groupMembers = (group: Group) =>
    group.memberIds.map((id) => botById.get(id)).filter((bot): bot is Bot => Boolean(bot && !bot.hidden));

  // ── sections ──
  const layoutInteractive = sidebarLayoutInteractive(density, "");
  const pinned = state.bots.filter((bot) => !bot.hidden && bot.pinned && !bot.chiefOfStaff && bot.id !== chief?.id);
  const pinnedIds = new Set(pinned.map((bot) => bot.id));
  const departments = buildDepartments(state.bots, org);
  const unassigned = unassignedBots(state.bots, org).filter((bot) => !pinnedIds.has(bot.id));
  // group chats in the order they were made, like bots: a new one never
  // moves the ones you already know where to find
  const partitioned = partitionSidebarGroups([...state.groups].sort((a, b) => a.createdAt - b.createdAt));
  const botChats = partitioned.botChats;
  const sectionedRooms = partitioned.sectionedRooms.filter((group) => group.section!.trim());
  // a section of only spaces is no section
  const unsectionedRooms = [...partitioned.unsectionedRooms, ...partitioned.sectionedRooms.filter((group) => !group.section!.trim())];
  const departmentSections = new Set(departments.map((department) => department.section));
  const roomOnlySections: string[] = [];
  for (const group of sectionedRooms) {
    const section = group.section!.trim();
    if (section && !departmentSections.has(section) && !roomOnlySections.includes(section)) roomOnlySections.push(section);
  }

  const views = new Map<string, SectionView>();
  departments.forEach((department, index) => {
    const id = userSectionId(department.section);
    const lead = department.lead && !pinnedIds.has(department.lead.id) ? department.lead : undefined;
    const members = department.members.filter((bot) => !pinnedIds.has(bot.id));
    const rooms = sectionedRooms.filter((group) => group.section?.trim() === department.section);
    if (!lead && !members.length && !rooms.length) return;
    const leadRun = lead ? runsByLead.get(lead.id) : undefined;
    const inRun = runAssignees(leadRun);
    const keep = (bot: Bot) =>
      isSelected(bot.id) ||
      Boolean(bot.unread) ||
      waitingOnYou(bot) ||
      ((bot.activity === "working" || Boolean(bot.busy)) && !inRun.has(bot.id));
    const folding = foldDepartmentMembers(members, { hasLead: Boolean(lead), expanded: false, keep, runAssignees: inRun });
    // avatar-only mode has no headers to unfold from, so it lists everyone
    const expanded = iconOnly || expandedMembers.includes(id);
    const shown = expanded ? members : folding.shown;
    // "+N" counts the quiet members; those working in the lead's run are
    // already summed up on the lead's row ("8 people · 13/24")
    const canToggle =
      !sidebarSectionCollapsed(id, collapsedSections, density, "") &&
      (expanded ? folding.folded + folding.inRun > 0 : folding.folded > 0);
    const everyone = [...(lead ? [lead] : []), ...members];
    const delivered = departmentDelivered(department.section, brief.departments, runs, new Set(everyone.map((bot) => bot.id)), now);
    const squad = squadBySection.get(department.section);
    const toggleMembers = () => {
      const next = toggleCollapsedSection(expandedMembers, id);
      setExpandedMembers(next);
      saveExpandedMemberSections(next);
    };
    views.set(id, {
      id,
      label: department.section,
      color: department.color ?? DEPARTMENT_COLORS[index % DEPARTMENT_COLORS.length],
      count: everyone.length + rooms.length,
      note: (
        <>
          {delivered && <span className="pointer-events-none text-success">{t("Delivered")}</span>}
          {squad && (
            <span className="pointer-events-none h-4 rounded-[4px] bg-[#6D3FE0] px-[5px] text-[10px] font-bold leading-4 text-white">
              {t("{squad} new", { squad })}
            </span>
          )}
          {canToggle && (
            <button
              type="button"
              onClick={toggleMembers}
              aria-expanded={expanded}
              title={expanded ? t("Fold quiet members") : tn(folding.folded, "Show {count} more bot", "Show {count} more bots")}
              className="-ml-1 rounded px-1 font-medium text-ink-secondary/70 hover:bg-raised hover:text-ink"
            >
              {expanded ? t("Fold") : `+${folding.folded}`}
            </button>
          )}
        </>
      ),
      rows: [
        ...(lead ? [{ kind: "bot" as const, bot: lead, role: "lead" as const }] : []),
        ...shown.map((bot) => ({ kind: "bot" as const, bot, role: "member" as const })),
        ...rooms.map((group) => ({ kind: "group" as const, group })),
      ],
      bots: everyone,
      groups: rooms,
    });
  });
  roomOnlySections.forEach((section, index) => {
    const id = userSectionId(section);
    const rooms = sectionedRooms.filter((group) => group.section?.trim() === section);
    views.set(id, {
      id,
      label: section,
      color: DEPARTMENT_COLORS[(departments.length + index) % DEPARTMENT_COLORS.length],
      count: rooms.length,
      rows: rooms.map((group) => ({ kind: "group" as const, group })),
      bots: [],
      groups: rooms,
    });
  });
  const builtin = (id: string, bots: Bot[], groups: Group[]) => {
    if (!bots.length && !groups.length) return;
    views.set(id, {
      id,
      // with departments around, the bots outside them are "not in a department"
      label: id === BOTS_SECTION_ID && departments.length ? t("Not in any department") : sidebarSectionLabel(id),
      color: BUILTIN_COLORS[id],
      count: bots.length + groups.length,
      rows: [
        ...bots.map((bot) => ({ kind: "bot" as const, bot, role: "member" as const })),
        ...groups.map((group) => ({ kind: "group" as const, group })),
      ],
      bots,
      groups,
    });
  };
  builtin(PINNED_SECTION_ID, pinned, []);
  builtin(BOTS_SECTION_ID, unassigned, []);
  builtin(CHANNELS_SECTION_ID, [], unsectionedRooms);
  builtin(BOT_CHATS_SECTION_ID, [], botChats);

  const naturalSectionIds = [
    PINNED_SECTION_ID,
    ...departments.map((department) => userSectionId(department.section)),
    ...roomOnlySections.map(userSectionId),
    BOTS_SECTION_ID,
    CHANNELS_SECTION_ID,
    BOT_CHATS_SECTION_ID,
  ].filter((id) => views.has(id));
  const sectionIds = orderedSidebarSections(naturalSectionIds, sectionOrder);
  const sectionCollapsed = (id: string) => sidebarSectionCollapsed(id, collapsedSections, density, "");

  const toggleSection = (id: string) => {
    if (!layoutInteractive) return;
    const next = toggleCollapsedSection(collapsedSections, id);
    setCollapsedSections(next);
    saveCollapsedSections(next);
  };

  // ── the open conversation stays in sight ──
  // A new bot lands in 未分部门 and a new group chat in 群聊, both at the
  // bottom of the list; a chat opened from ⌘K, the workbench or a
  // notification can be anywhere. Whenever the open conversation changes,
  // its section opens if it was folded and the list scrolls its row into
  // view — waiting for the row when it is created a moment later.
  const openChatId = state.activeView === "chat" ? state.selectedId : null;
  const openChatSection = openChatId
    ? (sectionIds.find((id) => views.get(id)?.rows.some((row) => (row.kind === "bot" ? row.bot.id : row.group.id) === openChatId)) ?? null)
    : null;
  const openChatFolded = openChatSection !== null && sectionCollapsed(openChatSection);
  useEffect(() => {
    if (!openChatSection || !openChatFolded) return;
    const next = collapsedSections.filter((id) => id !== openChatSection);
    setCollapsedSections(next);
    saveCollapsedSections(next);
    // only when the open conversation moves into a folded section: folding
    // it again afterwards is the reader's choice
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openChatId, openChatSection]);
  const listRef = useRef<HTMLDivElement>(null);
  const pendingReveal = useRef<{ id: string; smooth: boolean } | null>(null);
  const revealedOnce = useRef(false);
  useLayoutEffect(() => {
    pendingReveal.current = openChatId ? { id: openChatId, smooth: revealedOnce.current } : null;
  }, [openChatId]);
  useLayoutEffect(() => {
    const pending = pendingReveal.current;
    const list = listRef.current;
    if (!pending || !list) return;
    const id = CSS.escape(pending.id);
    const row = list.querySelector<HTMLElement>(`[data-sidebar-bot="${id}"], [data-sidebar-group="${id}"]`);
    if (!row) return; // not drawn yet: a row being created, a section unfolding
    pendingReveal.current = null;
    revealedOnce.current = true;
    const top = sidebarRevealScrollTop(list.getBoundingClientRect(), row.getBoundingClientRect(), list.scrollTop);
    if (top === null) return;
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    list.scrollTo({ top, behavior: pending.smooth && !reduced ? "smooth" : "auto" });
  });

  const commitSectionOrder = (visibleOrder: string[]) => {
    if (!layoutInteractive) return;
    const next = mergeSectionOrder(sectionOrder, visibleOrder);
    if (sameSectionOrder(next, sectionOrder)) return;
    setSectionOrder(next);
    saveSectionOrder(next);
  };

  const announceSectionPosition = (id: string, visibleOrder: string[]) => {
    const position = visibleOrder.indexOf(id);
    if (position < 0) return;
    setReorderAnnouncement(
      t("{name} moved to position {position} of {total}", {
        name: views.get(id)?.label ?? sidebarSectionLabel(id),
        position: position + 1,
        total: visibleOrder.length,
      }),
    );
  };

  const moveSidebarSection = (id: string, direction: -1 | 1) => {
    const next = moveSection(sectionIds, id, direction);
    if (sameSectionOrder(next, sectionIds)) return;
    commitSectionOrder(next);
    announceSectionPosition(id, next);
  };

  const resetSectionDrag = () => {
    sectionDragRef.current = { from: null, over: null };
    setDraggingSectionId(null);
    setDropTarget(null);
  };

  const updateSectionDropTarget = (event: React.DragEvent<HTMLDivElement>, id: string) => {
    if (!layoutInteractive || !sectionDragRef.current.from) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    const place: SectionDropPlace = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
    const next = { id, place };
    sectionDragRef.current.over = next;
    setDropTarget(next);
  };

  const dropSection = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const from =
      event.dataTransfer.getData("application/x-ein-sidebar-section") ||
      event.dataTransfer.getData("text/plain") ||
      sectionDragRef.current.from;
    const over = sectionDragRef.current.over;
    if (from && over) {
      const next = placeSection(sectionIds, from, over.id, over.place);
      if (!sameSectionOrder(next, sectionIds)) {
        commitSectionOrder(next);
        announceSectionPosition(from, next);
      }
    }
    resetSectionDrag();
  };
  const activeBotCount = state.bots.filter((bot) => !bot.hidden).length;
  const archivedBots = state.bots.filter((bot) => bot.hidden);
  const pendingTeamUndo = teamFeedback?.undo;
  const pendingBotUndo = teamFeedback?.restoreBot;

  // ── the nav's live counts ──
  const needsYouCount = inbox.length;
  const runningCount = runningWorkCount(runs, state.bots);
  const todayCount = todayScheduleCount(state.routines, state.routineRuns, calendarCalls.calls ?? [], now);
  const staleDocs = staleLibraryDocCount(library.docs);
  const failedRoutine = state.routineRuns.some((run) => ["failed", "missed"].includes(run.status) && !run.seenAt);
  const profileName = state.config?.profile?.name?.trim() || t("You");
  const weekPercent = usage.weekPercent == null ? null : Math.max(0, Math.min(100, Math.round(usage.weekPercent)));

  const renderBot = (bot: Bot, variant: "chief" | "lead" | "member") => {
    const items = inboxForBot.get(bot.id) ?? [];
    const visible = visibleMessages(bot);
    const fresh = previewFor(bot, visible);
    const base = rowStatus(bot, items, visible);
    const status = fresh && base.kind === "preview" ? { kind: "preview" as const, text: fresh } : base;
    const chiefCount = variant === "chief" ? needsYouCount : undefined;
    const needsYou = variant === "chief" ? needsYouCount > 0 || status.kind === "waiting" : status.kind === "waiting";
    return (
      <BotRow
        key={bot.id}
        bot={bot}
        density={density}
        variant={variant}
        selected={isSelected(bot.id)}
        status={status}
        time={sidebarTime(visible.at(-1)?.at, now)}
        needsYou={needsYou}
        chiefCount={chiefCount}
        onMenu={setMenu}
        onArchive={(candidate) => void archiveBot(candidate)}
        archiveDisabled={Boolean(bot.chiefOfStaff) || activeBotCount <= 1}
      />
    );
  };
  const renderGroup = (group: Group) => {
    const members = groupMembers(group);
    const decision = latestGroupDecision(decisions.decisions, group.id);
    const last = group.messages.at(-1);
    return (
      <GroupRow
        key={group.id}
        group={group}
        density={density}
        selected={isSelected(group.id)}
        members={members}
        meeting={meetingRoomIds.has(group.id)}
        preview={groupRowPreview({
          memberCount: members.length,
          busyName: group.busyBotId ? (botById.get(group.busyBotId)?.name ?? t("A bot")) : null,
          decision,
          unread: group.unread,
          last,
        })}
        time={sidebarTime(last?.at, now)}
        unreadCount={groupUnreadCount(group)}
        onMenu={setRoomMenu}
      />
    );
  };

  const navMeta = {
    brief:
      needsYouCount > 0 ? (
        <span className="inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11.5px] font-bold text-white" style={{ background: AMBER }}>
          {t("Needs you {count}", { count: needsYouCount })}
        </span>
      ) : null,
    workbench:
      runningCount > 0 ? (
        <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-select/10 px-2 text-[12px] font-medium text-accent-text">
          {t("{count} running", { count: runningCount })}
        </span>
      ) : null,
    calendar: failedRoutine ? (
      <span className="size-2 shrink-0 rounded-full bg-danger" aria-label={t("A routine failed")} />
    ) : todayCount > 0 ? (
      <span className="shrink-0 text-[12px] text-ink-secondary/75">{t("{count} today", { count: todayCount })}</span>
    ) : null,
    library:
      staleDocs > 0 ? <span className="shrink-0 text-[12px] text-warning">{t("{count} to update", { count: staleDocs })}</span> : null,
  };
  const dot = (className: string) => <span className={cn("absolute right-1.5 top-1 size-2 rounded-full ring-2 ring-panel", className)} />;

  return (
    <aside
      aria-label={t("Bots and navigation")}
      data-native-view-overlay
      className={cn(
        "flex h-full shrink-0 flex-col bg-panel transition-[width] duration-200",
        iconOnly ? "w-[68px]" : compact ? "w-[248px]" : "w-[264px]",
        // Below md only: the sidebar leaves the flow and slides in over the chat.
        // Scoped with max-md: rather than cancelled with md: on purpose — Tailwind
        // v4 emits the native `translate` property, and any value other than
        // `none` turns this element into a containing block for its `fixed`
        // descendants. Cancelling it with an `md:` prefix still emits a value, which
        // silently reparents NewRoomPanel's overlay and the "+" menu backdrop on
        // desktop.
        "max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:shadow-2xl",
        "max-md:transition-transform max-md:duration-200",
        open ? "max-md:translate-x-0" : "max-md:-translate-x-full",
      )}
    >
      {/* Window bar: macOS owns inset traffic lights; Linux/Windows use native chrome. */}
      <div
        className={cn("flex shrink-0 items-center", iconOnly ? "flex-col gap-1 px-2 pt-3" : "h-[50px] justify-between pl-[18px] pr-3")}
        style={windowDragStyle}
      >
        {macInset ? (
          <div className={iconOnly ? "h-5 w-full" : "w-14"} />
        ) : browser && !iconOnly ? (
          <div className="flex items-center gap-2" aria-hidden>
            <span className="size-3 rounded-full bg-[#ff5f57]" />
            <span className="size-3 rounded-full bg-[#febc2e]" />
            <span className="size-3 rounded-full bg-[#28c840]" />
          </div>
        ) : <div />}
        <div
          className={cn("relative flex items-center gap-0.5", iconOnly && "flex-col")}
          style={windowNoDragStyle}
        >
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={iconOnly ? t("Expand sidebar") : t("Collapse sidebar to avatars")}
            title={iconOnly ? t("Expand sidebar") : t("Collapse to avatars")}
            className="grid size-8 place-items-center rounded-[9px] text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <SidebarToggleIcon size={18} />
          </button>
          <button
            ref={importReturnRef}
            type="button"
            onClick={() => setPlusOpen((o) => !o)}
            aria-label={t("New: chat, group chat, bot")}
            aria-expanded={plusOpen}
            aria-haspopup="menu"
            title={t("New: chat, group chat, bot")}
            className="grid size-8 place-items-center rounded-[9px] text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <ComposeIcon size={18} />
          </button>
          {plusOpen && (
            <>
              <div className="fixed inset-0 z-30" onMouseDown={() => setPlusOpen(false)} />
              <div role="menu" className={cn(MENU, "absolute top-full mt-1 w-52", iconOnly ? "left-0" : "right-0")}>
                {(chief ?? botById.get(state.selectedId)) && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      setPlusOpen(false);
                      const target = chief ?? botById.get(state.selectedId);
                      if (!target) return;
                      dispatch({ type: "select", id: target.id });
                      dispatch({ type: "newTask", botId: target.id });
                    }}
                    className={MENU_ITEM}
                  >
                    <MessageSquarePlus size={15} className="text-ink-secondary" />
                    {chief ? t("New chat with {name}", { name: chief.name }) : t("New chat")}
                  </button>
                )}
                <button
                  role="menuitem"
                  onClick={() => {
                    setPlusOpen(false);
                    setNewRoom(true);
                  }}
                  className={MENU_ITEM}
                >
                  <Users size={15} className="text-ink-secondary" />
                  {t("New group chat")}
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setPlusOpen(false);
                    track("bot_created");
                    dispatch({ type: "newBot" });
                  }}
                  className={MENU_ITEM}
                >
                  <BotIcon size={15} className="text-ink-secondary" />
                  {t("New Bot")}
                </button>
                <div className={MENU_SEPARATOR} />
                <button
                  role="menuitem"
                  onClick={() => {
                    setPlusOpen(false);
                    setTeamLibraryOpen(true);
                  }}
                  className={MENU_ITEM}
                >
                  <Library size={15} className="text-ink-secondary" />
                  {t("Teams")}
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setPlusOpen(false);
                    void exportAllBots();
                  }}
                  disabled={exportingTeam}
                  className={MENU_ITEM}
                >
                  {exportingTeam ? <Loader2 size={15} className="animate-spin text-ink-secondary" /> : <ArrowDownToLine size={15} className="text-ink-secondary" />}
                  {exportingTeam ? t("Exporting…") : t("Export all bots")}
                </button>
                {archivedBots.length > 0 && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      setPlusOpen(false);
                      setArchivedBotsOpen(true);
                    }}
                    className={MENU_ITEM}
                  >
                    <Archive size={15} className="text-ink-secondary" />
                    <span className="flex-1">{t("Archived bots")}</span>
                    <span className="text-[11.5px] text-ink-secondary">{archivedBots.length}</span>
                  </button>
                )}
                <div className={MENU_SEPARATOR} />
                <div className="px-2.5 pb-0.5 pt-1 text-[11.5px] font-semibold text-ink-secondary">{t("Sidebar density")}</div>
                {(["comfortable", "compact"] as const).map((option) => (
                  <button
                    key={option}
                    role="menuitemradio"
                    aria-checked={density === option}
                    onClick={() => {
                      setPlusOpen(false);
                      setDensity(option);
                    }}
                    className={cn(MENU_ITEM, "justify-between")}
                  >
                    {option === "compact" ? t("Compact") : t("Comfortable")}
                    {density === option && <Check size={14} className="text-select" />}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Search opens ⌘K: bots, group chats, messages, files and routines. */}
      <div className={cn("shrink-0", iconOnly ? "flex justify-center px-2 pb-1 pt-1" : "px-3")}>
        {iconOnly ? (
          <button
            type="button"
            onClick={() => openCommandPalette()}
            aria-label={t("Search bots, group chats, files…")}
            title={t("Search (⌘K)")}
            className="grid size-8 place-items-center rounded-[9px] text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <Search size={17} />
          </button>
        ) : (
          <button
            type="button"
            data-sidebar-search
            onClick={() => openCommandPalette()}
            onKeyDown={(event) => {
              // typing on the focused field starts the search with that key;
              // an input method's keystroke ("Process") just opens it
              if (event.key === "Process") {
                openCommandPalette();
              } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey && event.key !== " ") {
                event.preventDefault();
                openCommandPalette(event.key);
              }
            }}
            aria-keyshortcuts="Meta+K Control+K"
            className="flex h-[34px] w-full items-center gap-2 rounded-[10px] bg-raised/70 pl-3 pr-1.5 text-left inset-ring-1 inset-ring-hairline/45 transition-colors hover:bg-raised"
          >
            <Search size={16} strokeWidth={1.8} className="shrink-0 text-ink-secondary" />
            <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink-secondary/70">{t("Search bots, group chats, files…")}</span>
            <Kbd className="text-[10.5px] shadow-none inset-ring-1 inset-ring-hairline/55">⌘K</Kbd>
          </button>
        )}
      </div>

      {/* Pages */}
      <nav aria-label={t("Pages")} className={cn("flex shrink-0 flex-col gap-px", iconOnly ? "px-2.5 pt-1" : "px-3 pt-2.5")}>
        <NavRow
          nav="brief"
          icon={<BriefIcon size={18} />}
          label={t("Brief")}
          meta={navMeta.brief}
          badge={needsYouCount > 0 ? (
            <span className="absolute right-0.5 top-0 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[9.5px] font-bold text-white ring-2 ring-panel" style={{ background: AMBER }}>
              {needsYouCount}
            </span>
          ) : null}
          selected={state.activeView === "brief"}
          iconOnly={iconOnly}
          onClick={() => dispatch({ type: "showPage", page: "brief" })}
        />
        {approvalInbox.counts.needsYou > 0 && (
          <NavRow
            nav="approval-inbox"
            icon={<BellDot size={18} />}
            label={t("Needs you")}
            meta={
              <span className="inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11.5px] font-bold text-white" style={{ background: AMBER }}>
                {t("Needs you {count}", { count: approvalInbox.counts.needsYou })}
              </span>
            }
            badge={dot("bg-warning")}
            selected={inboxOpen}
            iconOnly={iconOnly}
            onClick={() => setInboxOpen(true)}
          />
        )}
        <NavRow
          nav="workbench"
          icon={<WorkbenchIcon size={18} />}
          label={t("Workbench")}
          meta={navMeta.workbench}
          badge={runningCount > 0 ? dot("bg-select") : null}
          selected={state.activeView === "team-map"}
          iconOnly={iconOnly}
          onClick={() => dispatch({ type: "showTeamMap" })}
        />
        <NavRow
          nav="calendar"
          icon={<CalendarIcon size={18} />}
          label={t("Calendar")}
          meta={navMeta.calendar}
          badge={failedRoutine ? dot("bg-danger") : null}
          selected={state.activeView === "routines"}
          iconOnly={iconOnly}
          onClick={() => dispatch({ type: "showRoutines" })}
        />
        <NavRow
          nav="library"
          icon={<FolderIcon size={18} />}
          label={t("Library")}
          meta={navMeta.library}
          badge={staleDocs > 0 ? dot("bg-warning") : null}
          selected={state.activeView === "library"}
          iconOnly={iconOnly}
          onClick={() => dispatch({ type: "showPage", page: "library" })}
        />
        {skillRecorderEnabled(state.config) && (
          <NavRow
            nav="skills"
            icon={<WandIcon size={18} />}
            label={t("Skills")}
            selected={state.activeView === "skill-recorder"}
            iconOnly={iconOnly}
            onClick={() => dispatch({ type: "showSkillRecorder" })}
          />
        )}
        <NavRow
          nav="apps"
          icon={<PlugIcon size={18} />}
          label={t("Connect apps")}
          selected={state.activeView === "apps"}
          iconOnly={iconOnly}
          onClick={() => dispatch({ type: "showPage", page: "apps" })}
        />
      </nav>
      <div className={cn("mt-2 h-px shrink-0 bg-hairline/30", iconOnly ? "mx-4" : "mx-[22px]")} />

      {/* The team */}
      <div ref={listRef} className={cn("min-h-0 flex-1 overflow-y-auto pb-2 pt-2", iconOnly ? "px-2.5" : "px-3")}>
        <div className="flex flex-col">
          {chief && <div className="mb-0.5">{renderBot(chief, "chief")}</div>}
          {!iconOnly && (
            <TaskFolderList
              needsYouByTask={approvalInbox.counts.byTask}
              onOpenTask={(botId, threadId) => {
                dispatch({ type: "select", id: botId });
                dispatch({ type: "switchTask", botId, threadId });
              }}
            />
          )}
          {sectionIds.map((id, index) => {
            const view = views.get(id);
            if (!view) return null;
            const collapsed = sectionCollapsed(id);
            const attention: SidebarSectionAttention | undefined = collapsed ? sidebarSectionAttention(view.bots, view.groups) : undefined;
            return (
              <div key={id} data-sidebar-section-id={id} className="flex flex-col">
                {dropTarget?.id === id && dropTarget.place === "before" && draggingSectionId !== id && (
                  <div className="mx-2 h-0.5 rounded-full bg-select" />
                )}
                {iconOnly ? (
                  (chief || index > 0) && <div className="mx-auto my-1.5 h-[3px] w-5 rounded-full opacity-70" style={{ background: view.color ?? "var(--color-hairline)" }} aria-hidden />
                ) : (
                  <SidebarSectionHeader
                    name={view.label}
                    color={view.color}
                    note={view.note}
                    count={view.count}
                    collapsed={collapsed}
                    attention={attention}
                    onToggle={layoutInteractive ? () => toggleSection(id) : undefined}
                    reorderable={layoutInteractive && sectionIds.length > 1}
                    dragging={draggingSectionId === id}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("application/x-ein-sidebar-section", id);
                      event.dataTransfer.setData("text/plain", id);
                      sectionDragRef.current = { from: id, over: null };
                      setDraggingSectionId(id);
                    }}
                    onDragEnd={resetSectionDrag}
                    onDragOver={(event) => updateSectionDropTarget(event, id)}
                    onDrop={dropSection}
                    onMove={(direction) => moveSidebarSection(id, direction)}
                  />
                )}
                {!collapsed &&
                  view.rows.map((row) =>
                    row.kind === "bot" ? renderBot(row.bot, row.role) : renderGroup(row.group),
                  )}
                {dropTarget?.id === id && dropTarget.place === "after" && draggingSectionId !== id && (
                  <div className="mx-2 h-0.5 rounded-full bg-select" />
                )}
              </div>
            );
          })}
        </div>
      </div>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {reorderAnnouncement}
      </p>

      {/* You and this week's usage */}
      <div className={cn("shrink-0 pb-3", iconOnly ? "px-2" : "px-3")}>
        <div className={cn("flex items-center border-t border-hairline/40 pt-2", iconOnly ? "flex-col gap-1" : "gap-1 pl-1")}>
          <button
            type="button"
            onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "usage" })}
            title={t("Usage and billing")}
            aria-label={iconOnly ? t("Usage and billing") : undefined}
            className={cn("flex min-w-0 items-center rounded-[10px] py-1 text-left hover:bg-raised/55", iconOnly ? "justify-center px-1" : "flex-1 gap-2.5 px-1")}
          >
            <span className="grid size-[30px] shrink-0 place-items-center rounded-full bg-select/12 text-[12.5px] font-bold text-accent-text">
              {profileInitials(state.config?.profile)}
            </span>
            {!iconOnly && (
              <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                <span className="truncate text-[13px] font-bold leading-tight text-ink">{profileName}</span>
                <span className="truncate text-[11px] leading-tight text-ink-secondary">
                  {weekPercent == null ? t("Usage this week") : t("Usage this week {percent}%", { percent: weekPercent })}
                </span>
                {weekPercent != null && (
                  <span
                    className="block h-1 overflow-hidden rounded-sm bg-control"
                    role="progressbar"
                    aria-label={t("Usage this week")}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={weekPercent}
                  >
                    <span className="block h-full rounded-sm bg-ink/70" style={{ width: `${weekPercent}%` }} />
                  </span>
                )}
              </span>
            )}
          </button>
          <SidebarPhoneButton density={density} onOpen={() => dispatch(phoneSettingsAction())} quiet />
          {!iconOnly && <UpdateButton />}
          <button
            type="button"
            onClick={() => dispatch({ type: "toggleAppSettings", open: true })}
            className="grid size-8 shrink-0 place-items-center rounded-[9px] text-ink-secondary hover:bg-raised hover:text-ink"
            title={t("App settings")}
            aria-label={t("App settings")}
          >
            <SlidersIcon size={18} />
          </button>
        </div>
      </div>

      {menu && (
        <BotContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onArchive={(bot) => void archiveBot(bot)}
          onMoveToSection={(botId) => setSectionPicker({ botId, x: menu.x, y: menu.y })}
        />
      )}
      {sectionPicker && (
        <SectionPicker
          current={state.bots.find((b) => b.id === sectionPicker.botId)?.section}
          anchor={sectionPicker}
          onClose={() => setSectionPicker(null)}
          onAssign={(section) => dispatch({ type: "updateBot", botId: sectionPicker.botId, patch: { section } })}
        />
      )}
      {roomMenu && (
        <RoomContextMenu
          key={roomMenu.groupId}
          menu={roomMenu}
          onClose={() => setRoomMenu(null)}
          onMoveToSection={(groupId) => setRoomSectionPicker({ groupId, x: roomMenu.x, y: roomMenu.y })}
        />
      )}
      {roomSectionPicker && (
        <SectionPicker
          current={state.groups.find((g) => g.id === roomSectionPicker.groupId)?.section}
          anchor={roomSectionPicker}
          onClose={() => setRoomSectionPicker(null)}
          onAssign={(section) =>
            dispatch({ type: "patchGroup", groupId: roomSectionPicker.groupId, patch: { section } })
          }
        />
      )}
      {newRoom && <NewRoomPanel onClose={() => setNewRoom(false)} />}
      {archivedBotsOpen && (
        <ArchivedBotsPanel
          bots={archivedBots}
          onClose={() => setArchivedBotsOpen(false)}
          onRestored={(message) => setTeamFeedback({ error: false, text: message })}
        />
      )}
      {teamLibraryOpen && (
        <TeamLibraryPanel
          returnFocusRef={importReturnRef}
          initialUrl={teamInstallUrl ?? undefined}
          onClose={() => {
            setTeamLibraryOpen(false);
            setTeamInstallUrl(null);
          }}
          onImported={(result) => {
            setTeamLibraryOpen(false);
            setTeamInstallUrl(null);
            setTeamFeedback(
              result.archived.length > 0
                ? {
                    error: false,
                    text: tn(result.members, "{name} loaded · {count} bot", "{name} loaded · {count} bots", { name: result.name }),
                    undo: result,
                  }
                : {
                    error: false,
                    text: tn(result.members, "{name} loaded · {count} bot", "{name} loaded · {count} bots", { name: result.name }),
                  },
            );
          }}
        />
      )}
      <InboxPanel
        open={inboxOpen}
        items={approvalInbox.items}
        onClose={() => setInboxOpen(false)}
        onChanged={() => void approvalInbox.refresh()}
      />
      {teamFeedback &&
        createPortal(
          <div
            role="status"
            className={cn(
              "fixed bottom-4 left-4 z-[60] max-w-[300px] rounded-xl bg-card px-3.5 py-2.5 text-[13px] shadow-xl ring-1 ring-hairline/40",
              teamFeedback.error ? "text-danger" : "text-ink",
            )}
          >
            <div className="flex items-center gap-3">
              <span>{teamFeedback.text}</span>
              {pendingTeamUndo && (
                <button
                  onClick={() => void undoTeamLoad(pendingTeamUndo)}
                  className="rounded-md px-1.5 py-0.5 font-semibold text-accent-text hover:bg-raised-hover"
                >
                  {t("Undo")}
                </button>
              )}
              {pendingBotUndo && (
                <button
                  onClick={() => void undoBotArchive(pendingBotUndo)}
                  className="rounded-md px-1.5 py-0.5 font-semibold text-accent-text hover:bg-raised-hover"
                >
                  {t("Undo")}
                </button>
              )}
            </div>
          </div>,
          document.body,
        )}
    </aside>
  );
}
