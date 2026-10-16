// ⌘K search (round-8 U18): one field over bots, group chats, messages,
// library files and scheduled tasks, plus a few app actions. Tabs narrow it to
// one kind and show how many of each matched. Bots, group chats, files and
// routines answer instantly from local data; message hits come from
// /api/search a beat later. Self-contained: it owns its open state and the
// global chord, and openCommandPalette() opens it from anywhere (the sidebar's
// search field) — App.tsx only mounts it.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Clock, FileText, Hash, Plus, Search, Users, X } from "lucide-react";
import { api, useStore, visibleMessages, type Bot, type Group } from "@/state/store";
import { useApi, useDecisions, useLibrary, useOrg } from "@/state/org-api";
import type { LibraryDoc } from "../../shared/org-types";
import type { Routine } from "@/lib/routines";
import type { CalendarCall } from "@/lib/calendar-calls";
import {
  ALL_TAB_LIMITS,
  PALETTE_CATEGORIES,
  cycleCategory,
  excerptAround,
  highlightParts,
  nextRunLabel,
  rankByFields,
  routineScheduleLabel,
  type PaletteCategory,
} from "@/lib/palette-rank";
import {
  groupRowPreview,
  latestGroupDecision,
  libraryCurrentVersion,
  sidebarTime,
  staleLibraryUsers,
} from "@/lib/sidebar-rows";
import { chiefBot } from "@/lib/org";
import { cn } from "@/lib/cn";
import type { SearchHit } from "@/lib/search-hit";
import { landOnSearchHit } from "@/lib/focus-message";
import { msg, t, tn, tRich } from "@/lib/i18n";
import { BotAvatar } from "./Avatar";
import { AvatarStack, Kbd, Pill } from "./ui";
import { BriefIcon, SlidersIcon, SquareTile, WorkbenchIcon, CalendarIcon, FolderIcon, PlugIcon, groupTint } from "./SidebarIcons";

const OPEN_EVENT = "omb:command-palette";
/** Handing a file or routine to the page that opens next (see handOff). */
export const LIBRARY_OPEN_EVENT = "omb:library-open";
export const LIBRARY_OPEN_KEY = "omb.library.open";
export const CALENDAR_OPEN_EVENT = "omb:calendar-open";
export const CALENDAR_OPEN_KEY = "omb.calendar.open";

const MESSAGE_LIMIT = 50;
const EMPTY_CALLS: { calls?: CalendarCall[] } = { calls: [] };

/** Open ⌘K from anywhere, optionally with the first characters typed. */
export function openCommandPalette(query = ""): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { query } }));
}

/** Tell the page that is about to open which item to show: kept in
 * sessionStorage for a page that mounts after this, and announced for one
 * that is already on screen. */
function handOff(key: string, event: string, detail: Record<string, unknown>): void {
  try {
    sessionStorage.setItem(key, JSON.stringify({ ...detail, at: Date.now() }));
  } catch {
    // private mode: the page still opens, just without the item selected
  }
  window.setTimeout(() => window.dispatchEvent(new CustomEvent(event, { detail })), 0);
}

const CATEGORY_LABEL: Record<PaletteCategory, string> = {
  all: msg("All <count>{count}</count>"),
  bots: msg("Bots <count>{count}</count>"),
  groups: msg("Group chats <count>{count}</count>"),
  messages: msg("Messages <count>{count}</count>"),
  files: msg("Files <count>{count}</count>"),
  routines: msg("Scheduled <count>{count}</count>"),
};

/** A category's name without its count (the section headings). */
function categoryName(category: PaletteCategory): ReactNode {
  return tRich(CATEGORY_LABEL[category], { count: () => null }, { count: 0 });
}

/** A keycap; symbol keys (⌘ ⇧ ↵ ↑ ↓) read better in the sans face, a size up. */
function Key({ children, className }: { children: string; className?: string }) {
  const symbol = /^[⌘⇧⌥⌃↵↑↓←→]$/.test(children);
  return <Kbd className={cn(symbol && "font-sans text-[12.5px]", className)}>{children}</Kbd>;
}

function Highlight({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightParts(text, query).map((part, index) =>
        part.match ? (
          <mark key={index} className="rounded-[3px] bg-[#FFD84D]/45 px-px text-inherit">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

interface PaletteAction {
  id: string;
  label: string;
  keys: string[];
  icon: ReactNode;
  /** listed on the "all" tab even when the query doesn't name it */
  always: boolean;
  run: () => void;
}

type Item =
  | { kind: "bot"; key: string; bot: Bot }
  | { kind: "group"; key: string; group: Group }
  | { kind: "message"; key: string; hit: SearchHit }
  | { kind: "file"; key: string; doc: LibraryDoc; version: number; current: number; staleUsers: number }
  | { kind: "routine"; key: string; routine: Routine }
  | { kind: "action"; key: string; action: PaletteAction };

interface Section {
  key: string;
  title: ReactNode;
  /** "See all 26" — switches to the category's own tab */
  more?: { count: number; category: PaletteCategory };
  items: Item[];
}

export function CommandPalette({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [initialQuery, setInitialQuery] = useState("");
  const [session, setSession] = useState(0);
  const openRef = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    openRef.current = open;
    onOpenChange?.(open);
  }, [onOpenChange, open]);

  const show = useCallback((query: string) => {
    if (!openRef.current) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setInitialQuery(query);
    // a fresh palette every open; stale queries from last time would flash
    setSession((value) => value + 1);
    setOpen(true);
  }, []);

  /** restore = put focus back where it was (dismissed rather than used) */
  const close = useCallback((restore: boolean) => {
    setOpen(false);
    const target = returnFocus.current;
    returnFocus.current = null;
    if (restore && target) window.setTimeout(() => target.isConnected && target.focus(), 0);
  }, []);

  // The chord fires from anywhere — Shell's app-wide shortcuts (⌘N, ⌘1–9)
  // set the precedent of not guarding against focused inputs, and a
  // modifier chord never collides with typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (openRef.current) close(true);
        else show("");
      }
    };
    const onOpen = (event: Event) => show((event as CustomEvent<{ query?: string }>).detail?.query ?? "");
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, [close, show]);

  if (!open) return null;
  return <PaletteDialog key={session} initialQuery={initialQuery} onClose={close} />;
}

function PaletteDialog({ initialQuery, onClose }: { initialQuery: string; onClose: (restore: boolean) => void }) {
  const { state, dispatch } = useStore();
  const { data: org } = useOrg();
  const { data: library } = useLibrary();
  const { data: decisions } = useDecisions();
  const { data: calendarCalls } = useApi("/api/calendar-calls", EMPTY_CALLS, 60_000);
  const [query, setQuery] = useState(initialQuery);
  const [category, setCategory] = useState<PaletteCategory>("all");
  const [cursor, setCursor] = useState(0);
  const [hits, setHits] = useState<{ query: string; hits: SearchHit[] }>({ query: "", hits: [] });
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const now = Date.now();

  const q = query.trim();

  // Same debounce pattern as before: names answer instantly from local
  // state, transcript hits arrive a beat later, and a stale response for an
  // outdated query is dropped.
  useEffect(() => {
    if (!q) return;
    let alive = true;
    const timer = setTimeout(() => {
      api(`/api/search?q=${encodeURIComponent(q)}&limit=${MESSAGE_LIMIT}`)
        .then((result: { hits?: SearchHit[] }) => alive && setHits({ query: q, hits: result.hits ?? [] }))
        .catch(() => alive && setHits({ query: q, hits: [] }));
    }, 150);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q]);

  useEffect(() => setCursor(0), [q, category]);

  // put the caret after a character typed into the sidebar's search field
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, []);

  const chief = chiefBot(state.bots, org);
  const botById = useMemo(() => new Map(state.bots.map((bot) => [bot.id, bot])), [state.bots]);
  const meetingRooms = useMemo(
    () => new Set((calendarCalls.calls ?? []).map((call) => call.roomId).filter((id): id is string => Boolean(id))),
    [calendarCalls],
  );

  const actions = useMemo<PaletteAction[]>(
    () => [
      { id: "new-bot", label: t("Create a bot"), keys: ["⌘", "N"], icon: <Plus size={16} />, always: true, run: () => dispatch({ type: "newBot" }) },
      { id: "workbench", label: t("Open the workbench"), keys: ["⇧", "⌘", "B"], icon: <WorkbenchIcon size={16} />, always: true, run: () => dispatch({ type: "showTeamMap" }) },
      { id: "brief", label: t("Open the brief"), keys: [], icon: <BriefIcon size={16} />, always: true, run: () => dispatch({ type: "showPage", page: "brief" }) },
      { id: "settings", label: t("Open settings"), keys: ["⌘", ","], icon: <SlidersIcon size={16} />, always: true, run: () => dispatch({ type: "toggleAppSettings", open: true }) },
      { id: "calendar", label: t("Open the calendar"), keys: [], icon: <CalendarIcon size={16} />, always: false, run: () => dispatch({ type: "showRoutines" }) },
      { id: "library", label: t("Open the library"), keys: [], icon: <FolderIcon size={16} />, always: false, run: () => dispatch({ type: "showPage", page: "library" }) },
      { id: "apps", label: t("Connect apps"), keys: [], icon: <PlugIcon size={16} />, always: false, run: () => dispatch({ type: "showPage", page: "apps" }) },
    ],
    [dispatch],
  );

  const results = useMemo(() => {
    const visibleBots = state.bots.filter((bot) => !bot.hidden);
    const lastAt = new Map(visibleBots.map((bot) => [bot.id, visibleMessages(bot).at(-1)?.at ?? 0]));
    const recentBots = visibleBots.sort(
      (a, b) => Number(b.id === chief?.id) - Number(a.id === chief?.id) || lastAt.get(b.id)! - lastAt.get(a.id)!,
    );
    const bots = rankByFields(recentBots, q, (bot) => bot.name, (bot) => [bot.title, bot.description, bot.section]);
    const recentGroups = [...state.groups].sort((a, b) => (b.messages.at(-1)?.at ?? b.createdAt) - (a.messages.at(-1)?.at ?? a.createdAt));
    const groups = rankByFields(recentGroups, q, (group) => group.name, (group) => [group.bulletin, group.section]);
    const messages = q && hits.query === q ? hits.hits : [];
    const docs = rankByFields(
      [...library.docs].sort((a, b) => b.updatedAt - a.updatedAt),
      q,
      (doc) => doc.title,
      (doc) => [doc.section],
    );
    const files: Array<Extract<Item, { kind: "file" }>> = [];
    for (const doc of docs) {
      const current = libraryCurrentVersion(doc);
      files.push({ kind: "file", key: `file:${doc.id}`, doc, version: current, current, staleUsers: 0 });
      const stale = staleLibraryUsers(doc);
      if (stale.length) {
        const older = Math.max(...stale.map((use) => use.version));
        files.push({ kind: "file", key: `file:${doc.id}:v${older}`, doc, version: older, current, staleUsers: stale.length });
      }
    }
    const routines = rankByFields(
      [...state.routines].sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity)),
      q,
      (routine) => routine.name,
      (routine) => [routine.prompt],
    );
    const lower = q.toLowerCase();
    const matchingActions = actions.filter((action) => !q || action.label.toLowerCase().includes(lower));
    const listedActions = q ? [...matchingActions, ...actions.filter((action) => action.always && !matchingActions.includes(action))] : actions.filter((action) => action.always);
    return { bots, groups, messages, files, routines, actions: listedActions };
  }, [actions, chief?.id, hits, library.docs, q, state.bots, state.groups, state.routines]);

  const messagesPending = Boolean(q) && hits.query !== q;
  const counts: Record<PaletteCategory, number> = {
    bots: results.bots.length,
    groups: results.groups.length,
    messages: results.messages.length,
    files: results.files.length,
    routines: results.routines.length,
    all: results.bots.length + results.groups.length + results.messages.length + results.files.length + results.routines.length,
  };
  const countLabel = (value: PaletteCategory) =>
    value === "messages" && messagesPending ? "…" : value === "messages" && counts.messages >= MESSAGE_LIMIT ? `${MESSAGE_LIMIT}+` : String(counts[value]);

  const sections: Section[] = [];
  const add = (key: Exclude<PaletteCategory, "all">, items: Item[]) => {
    if (!items.length) return;
    if (category === "all") {
      const limit = ALL_TAB_LIMITS[key];
      sections.push({
        key,
        title: categoryName(key),
        more: items.length > limit ? { count: items.length, category: key } : undefined,
        items: items.slice(0, limit),
      });
    } else if (category === key) {
      sections.push({ key, title: categoryName(key), items });
    }
  };
  add("bots", results.bots.map((bot) => ({ kind: "bot", key: `bot:${bot.id}`, bot })));
  add("groups", results.groups.map((group) => ({ kind: "group", key: `group:${group.id}`, group })));
  add("messages", results.messages.map((hit) => ({ kind: "message", key: `msg:${hit.threadId}:${hit.messageId}`, hit })));
  add("files", results.files);
  add("routines", results.routines.map((routine) => ({ kind: "routine", key: `routine:${routine.id}`, routine })));
  if (category === "all" && results.actions.length) {
    sections.push({
      key: "actions",
      title: t("Actions"),
      items: results.actions.map((action) => ({ kind: "action", key: `action:${action.id}`, action })),
    });
  }
  const items = sections.flatMap((section) => section.items);
  // hits arriving or rows filtering away can strand the cursor past the end
  const selected = items.length ? Math.min(cursor, items.length - 1) : 0;
  const itemId = (index: number) => `${baseId}-item-${index}`;

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected, category]);

  const activate = async (item: Item) => {
    onClose(false);
    switch (item.kind) {
      case "bot":
        dispatch({ type: "select", id: item.bot.id });
        return;
      case "group":
        dispatch({ type: "select", id: item.group.id });
        return;
      case "message":
        try {
          await landOnSearchHit(item.hit, state, dispatch);
        } catch (error) {
          dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
        }
        return;
      case "file":
        dispatch({ type: "showPage", page: "library" });
        handOff(LIBRARY_OPEN_KEY, LIBRARY_OPEN_EVENT, { docId: item.doc.id, version: item.version });
        return;
      case "routine":
        dispatch({ type: "showRoutines" });
        handOff(CALENDAR_OPEN_KEY, CALENDAR_OPEN_EVENT, { routineId: item.routine.id });
        return;
      case "action":
        item.action.run();
        return;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      // shield the window listeners other modals hang their own Esc on
      e.stopPropagation();
      onClose(true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor(items.length ? (selected + 1) % items.length : 0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor(items.length ? (selected - 1 + items.length) % items.length : 0);
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const item = items[selected];
      if (item) void activate(item);
    } else if (e.key === "Tab") {
      e.preventDefault();
      setCategory((current) => cycleCategory(current, e.shiftKey ? -1 : 1));
    }
  };

  const you = t("You");
  const renderItem = (item: Item, index: number) => {
    const isSelected = index === selected;
    let icon: ReactNode;
    let title: ReactNode;
    let sub: ReactNode = null;
    let right: ReactNode = null;
    let size: "row" | "message" | "action" = "row";
    switch (item.kind) {
      case "bot": {
        const bot = item.bot;
        const last = visibleMessages(bot).at(-1);
        const lastText = last?.kind === "text" ? (last.text ?? "").replace(/\s+/g, " ").trim() : last?.card?.title ?? "";
        icon = <BotAvatar bot={bot} size={22} crown={bot.id === chief?.id} />;
        title = (
          <>
            <span className="truncate"><Highlight text={bot.name} query={q} /></span>
            {bot.title && <span className="inline-flex h-[18px] shrink-0 items-center rounded-full bg-control px-1.5 text-[11px] font-medium text-ink-secondary">{bot.title}</span>}
          </>
        );
        const description = [bot.description.replace(/\s+/g, " ").trim(), lastText].filter(Boolean).join(" · ");
        sub = description ? <Highlight text={q ? excerptAround(description, q, 40) : description} query={q} /> : null;
        right = sidebarTime(last?.at, now);
        break;
      }
      case "group": {
        const group = item.group;
        const members = group.memberIds.map((id) => botById.get(id)).filter((bot): bot is Bot => Boolean(bot && !bot.hidden));
        const meeting = meetingRooms.has(group.id);
        icon = (
          <SquareTile tint={groupTint(group.id, meeting)} size={30}>
            {meeting ? <Users size={14} strokeWidth={2} /> : <Hash size={14} strokeWidth={2.1} />}
          </SquareTile>
        );
        title = <span className="truncate"><Highlight text={group.name} query={q} /></span>;
        sub = groupRowPreview({
          memberCount: members.length,
          busyName: group.busyBotId ? (botById.get(group.busyBotId)?.name ?? t("A bot")) : null,
          decision: latestGroupDecision(decisions.decisions, group.id),
          unread: group.unread,
          last: group.messages.at(-1),
        });
        right = (
          <>
            {members.length > 1 && <AvatarStack bots={members} size={16} max={4} />}
            <span>{sidebarTime(group.messages.at(-1)?.at, now)}</span>
          </>
        );
        break;
      }
      case "message": {
        const hit = item.hit;
        size = "message";
        const fromUser = hit.role === "user";
        const group = hit.groupId ? state.groups.find((candidate) => candidate.id === hit.groupId) : undefined;
        const speaker = fromUser
          ? undefined
          : hit.botId
            ? botById.get(hit.botId)
            : group?.memberIds.map((id) => botById.get(id)).find((bot) => bot?.name === hit.from);
        icon = fromUser || !speaker ? (
          <span className="grid size-[26px] place-items-center rounded-full bg-select/12 text-[11.5px] font-bold text-accent-text">
            {fromUser ? you.slice(0, 1) : "#"}
          </span>
        ) : (
          <BotAvatar bot={speaker} size={20} crown={false} />
        );
        const where = hit.groupId ? hit.name : fromUser ? hit.name : (hit.task ?? "");
        title = (
          <>
            <span className="truncate">{fromUser ? you : (hit.from ?? hit.name)}</span>
            {where && (
              <span className="flex min-w-0 items-center gap-1.5 font-medium text-ink-secondary/70">
                <span aria-hidden className="size-[3px] shrink-0 rounded-full bg-current" />
                <span className="truncate">{where}</span>
              </span>
            )}
          </>
        );
        sub = <Highlight text={hit.snippet.replace(/\s+/g, " ")} query={q} />;
        right = sidebarTime(hit.at, now);
        break;
      }
      case "file": {
        const doc = item.doc;
        const old = item.version < item.current;
        const entry = doc.versions.find((version) => version.version === item.version);
        const owner = doc.ownerBotId ? botById.get(doc.ownerBotId)?.name : undefined;
        icon = (
          <SquareTile tint={old ? "#8A909C" : "#16A34A"} size={30}>
            <FileText size={15} />
          </SquareTile>
        );
        title = (
          <>
            <span className="truncate"><Highlight text={doc.title} query={q} /></span>
            {item.version > 0 && (
              <span className={cn("h-[18px] shrink-0 rounded-[5px] px-[5px] text-[11px] font-bold leading-[18px]", old ? "bg-control text-ink-secondary" : "bg-select/10 text-accent-text")}>
                v{item.version}
              </span>
            )}
            <Pill tone={old ? "grey" : "green"} className="h-[18px] px-1.5 text-[11px]">
              {old ? t("Old version") : t("Current")}
            </Pill>
          </>
        );
        sub = old ? (
          <>
            {t("Replaced by v{version}", { version: item.current })}
            {" · "}
            <span className="text-warning">{tn(item.staleUsers, "{count} bot still uses it", "{count} bots still use it")}</span>
          </>
        ) : (
          [
            t("Library"),
            doc.section ?? t("Company-wide"),
            owner,
            entry?.decisionId ? t("From decision #{id}", { id: entry.decisionId }) : undefined,
          ]
            .filter(Boolean)
            .join(" · ")
        );
        right = sidebarTime(entry?.at ?? doc.updatedAt, now);
        break;
      }
      case "routine": {
        const routine = item.routine;
        icon = (
          <SquareTile tint="#3B5BFF" size={30}>
            <Clock size={15} />
          </SquareTile>
        );
        title = <span className="truncate"><Highlight text={routine.name} query={q} /></span>;
        const parts = [routineScheduleLabel(routine.schedule), excerptAround(routine.prompt, q, 18), botById.get(routine.botId)?.name].filter(Boolean);
        sub = <Highlight text={parts.join(" · ")} query={q} />;
        right = routine.enabled ? nextRunLabel(routine.nextRunAt, now) : t("Paused");
        break;
      }
      case "action": {
        size = "action";
        icon = (
          <SquareTile tint="#5A606C" size={30}>
            {item.action.icon}
          </SquareTile>
        );
        title = <span className="truncate font-medium"><Highlight text={item.action.label} query={q} /></span>;
        right = item.action.keys.length ? (
          <span className="flex gap-[3px]">
            {item.action.keys.map((key) => (
              <Key key={key}>{key}</Key>
            ))}
          </span>
        ) : null;
        break;
      }
    }
    return (
      <div
        key={item.key}
        id={itemId(index)}
        role="option"
        aria-selected={isSelected}
        data-index={index}
        // keep the caret in the field: rows are picked by pointer or arrows
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void activate(item)}
        // mousemove, not mouseenter: rows shifting under a resting pointer
        // (hits arriving) must not steal the keyboard selection
        onMouseMove={() => index !== selected && setCursor(index)}
        className={cn(
          "flex shrink-0 cursor-default items-center gap-2.5 rounded-[10px] pl-2 pr-2.5",
          size === "message" ? "h-[52px]" : size === "action" ? "h-10" : "h-[46px]",
          isSelected ? "bg-select/[0.08] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-select)_22%,transparent)]" : "",
        )}
      >
        <span className={cn("grid shrink-0 place-items-center", size === "action" ? "h-[30px] w-[34px]" : "size-[34px]")}>{icon}</span>
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          <span className={cn("flex min-w-0 items-center gap-1.5 font-semibold leading-[1.35] text-ink", size === "message" ? "text-[12.5px]" : "text-[13.5px]")}>
            {title}
          </span>
          {sub && size !== "action" && (
            <span className={cn("truncate leading-[1.45]", size === "message" ? "text-[13px] text-ink/80" : "text-[12px] text-ink-secondary")}>{sub}</span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2 whitespace-nowrap text-[11.5px] text-ink-secondary/75">
          {isSelected ? (
            <span className="flex items-center gap-1.5 text-[12px] font-semibold text-accent-text">
              {t("Open")}
              <Key className="text-accent-text shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-select)_35%,transparent)]">↵</Key>
            </span>
          ) : (
            right
          )}
        </span>
      </div>
    );
  };

  let flatIndex = -1;
  return (
    <div
      className="fixed inset-0 z-50 bg-[rgb(20_22_28/0.34)] backdrop-blur-[1.5px]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose(true)}
      onKeyDown={onKeyDown}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("Command palette")}
        className="animate-pop-in absolute left-1/2 top-[58px] flex max-h-[calc(100dvh-96px)] w-[min(720px,calc(100vw-32px))] -translate-x-1/2 flex-col overflow-hidden rounded-2xl bg-card shadow-[0_0_0_1px_rgb(16_24_40/0.1),0_2px_6px_rgb(16_24_40/0.08),0_44px_96px_-28px_rgb(16_24_40/0.6)] max-sm:top-3"
      >
        <div className="flex h-[58px] shrink-0 items-center gap-3 border-b border-hairline/30 pl-5 pr-4">
          <Search size={19} className="shrink-0 text-ink-secondary" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("Search bots, group chats, messages, files…")}
            role="combobox"
            aria-expanded="true"
            aria-controls={`${baseId}-list`}
            aria-activedescendant={items.length ? itemId(selected) : undefined}
            aria-autocomplete="list"
            aria-label={t("Search")}
            className="min-w-0 flex-1 bg-transparent text-[18px] font-medium tracking-[0.2px] text-ink caret-select placeholder:font-normal placeholder:text-ink-secondary/60 focus:outline-none"
          />
          {query && (
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              aria-label={t("Clear search")}
              title={t("Clear search")}
              className="grid size-5 shrink-0 place-items-center rounded-full bg-control text-ink-secondary hover:text-ink"
            >
              <X size={11} strokeWidth={2.4} />
            </button>
          )}
        </div>
        <div role="tablist" aria-label={t("Search categories")} className="flex h-11 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-hairline/30 px-3.5">
          {PALETTE_CATEGORIES.map((value) => {
            const on = value === category;
            return (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={on}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setCategory(value)}
                className={cn(
                  "inline-flex h-[26px] shrink-0 items-center gap-[5px] whitespace-nowrap rounded-full px-2.5 text-[12.5px] font-semibold transition-colors",
                  on ? "bg-primary text-primary-ink" : "bg-control/70 text-ink/80 hover:bg-control",
                )}
              >
                {tRich(
                  CATEGORY_LABEL[value],
                  {
                    count: (children) => (
                      <em className={cn("text-[11.5px] font-medium not-italic", on ? "text-primary-ink/60" : "text-ink-secondary/70")}>{children}</em>
                    ),
                  },
                  { count: countLabel(value) },
                )}
              </button>
            );
          })}
        </div>
        <div ref={listRef} id={`${baseId}-list`} role="listbox" aria-label={t("Results")} className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-1.5 pt-0.5">
          {items.length === 0 && (
            <div className="px-3 py-8 text-center text-[13px] text-ink-secondary">
              {messagesPending && (category === "messages" || category === "all")
                ? t("Searching…")
                : q
                  ? t("Nothing matches “{query}”", { query: q })
                  : t("Nothing to switch to yet")}
            </div>
          )}
          {sections.map((section) => (
            <div key={section.key} role="group" aria-label={typeof section.title === "string" ? section.title : undefined} className="flex flex-col">
              <div className="flex h-[26px] shrink-0 items-end px-2.5 pb-1 text-[11.5px] font-semibold text-ink-secondary/70">
                <span>{section.title}</span>
                {section.more && (
                  <button
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setCategory(section.more!.category)}
                    className="ml-auto font-medium text-ink-secondary hover:text-ink"
                  >
                    {section.more.category === "messages"
                      ? section.more.count >= MESSAGE_LIMIT
                        ? t("See all {count}+ messages", { count: MESSAGE_LIMIT })
                        : t("See all {count} messages", { count: section.more.count })
                      : t("See all {count}", { count: section.more.count })}
                  </button>
                )}
              </div>
              {section.items.map((item) => {
                flatIndex += 1;
                return renderItem(item, flatIndex);
              })}
            </div>
          ))}
        </div>
        <div className="flex h-10 shrink-0 items-center gap-4 border-t border-hairline/30 bg-inset/70 px-4 text-[12px] text-ink-secondary max-sm:hidden">
          <span className="inline-flex items-center gap-1">
            <Key>↑</Key>
            <Key>↓</Key>
            <span className="ml-0.5">{t("Select")}</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <Key>↵</Key>
            <span className="ml-0.5">{t("Open")}</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <Key>esc</Key>
            <span className="ml-0.5">{t("Close")}</span>
          </span>
          <span className="ml-auto inline-flex items-center gap-1">
            <Key>tab</Key>
            <span className="ml-0.5">{t("Switch category")}</span>
          </span>
        </div>
      </div>
    </div>
  );
}
