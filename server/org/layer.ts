// The company layer's one object: everything server/index.ts hands it (the
// roster, transcripts, dispatch runs, the decision log) and everything it
// hands back (events, decisions, the inbox, the brief, spend, the library).
// index.ts keeps only one-line hooks; the logic and its tests live here and
// in the modules this file composes.
import type { DispatchRun } from "../../shared/dispatch-types.ts";
import { t } from "../../shared/i18n.ts";
import type { Brief, InboxItem, LibraryDoc, OrgConfig, OrgDecision, OrgEvent, UsageSummary } from "../../shared/org-types.ts";
import type { DecisionRow } from "../decision-log.ts";
import { redactSecrets } from "../redact.ts";
import { approvalEventFor, autoApprovedRow } from "./approval-events.ts";
import { buildBrief, type AutoApprovedRow, type ConversationState } from "./brief.ts";
import { OrgConfigStore } from "./config.ts";
import { basisFromTexts, OrgDecisionStore } from "./decisions.ts";
import type { OrgEventLog } from "./events.ts";
import { ApprovalExpiry, type UnattendedApproval } from "./expiry.ts";
import { collectInbox, isDecisionCard, questionOf } from "./inbox.ts";
import { LibraryError, LibraryStore } from "./library.ts";
import { RunWatcher, type OrgEventInput } from "./run-events.ts";
import { DEFAULT_USD_TO_CNY, summarizeUsage, UsageLedger } from "./usage.ts";
import { botThreads, firstLine, groupThreads, sectionOf, startOfDay, startOfWeek, type OrgBot, type OrgCard, type OrgGroup, type OrgMessage } from "./util.ts";

/** What the org layer needs from the harness (wired in server/index.ts). */
export interface OrgHost {
  dataDir: string;
  bots(): readonly OrgBot[];
  groups(): readonly OrgGroup[];
  messages(threadId: string): readonly OrgMessage[];
  /** replace a message's card; the store broadcasts the patch */
  patchCard(threadId: string, messageId: string, card: OrgCard): void;
  /** a status chip in a conversation */
  chip(threadId: string, text: string, ok: boolean): void;
  runs(): readonly DispatchRun[];
  /** dispatch's attempts per subtask */
  maxAttempts(): number;
  /** the configured USD → CNY rate, if any */
  usdToCny(): number | undefined;
  /** recent decision-log rows, oldest first */
  decisionRows(limit: number): readonly DecisionRow[];
  /** append a decision-log row (its event follows through onDecisionRow) */
  logDecision(row: Omit<DecisionRow, "at">): void;
  /** a provider ask raised by this process and still open */
  isLiveRequest(threadId: string, requestId: string): boolean;
  /** deny an open provider request; false when nothing took the answer */
  deny(instanceId: string, threadId: string, requestId: string, message: string): Promise<boolean>;
}

const DAY_MS = 24 * 60 * 60_000;
/** Auto mode approves every tool call; one timeline line per bot per window is news, the rest is noise. */
const AUTO_EVENT_EVERY_MS = 15 * 60_000;

export class OrgLayer {
  readonly events: OrgEventLog;
  readonly config: OrgConfigStore;
  readonly decisions: OrgDecisionStore;
  readonly ledger: UsageLedger;
  readonly library: LibraryStore;
  private readonly host: OrgHost;
  private readonly runWatch = new RunWatcher();
  private readonly expiry = new ApprovalExpiry();
  /** test seam: expire after this many ms instead of the rule's minutes */
  private readonly expiryMs: number | undefined;
  private autoApproved: AutoApprovedRow[] | null = null;
  /** when each bot's last approval.auto event was written */
  private readonly lastAutoEvent = new Map<string, number>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(host: OrgHost, events: OrgEventLog, opts: { expiryMs?: number } = {}) {
    this.host = host;
    this.events = events;
    this.config = new OrgConfigStore(host.dataDir);
    this.decisions = new OrgDecisionStore(host.dataDir);
    this.ledger = new UsageLedger(host.dataDir);
    this.library = new LibraryStore(host.dataDir);
    this.expiryMs = opts.expiryMs && opts.expiryMs > 0 ? opts.expiryMs : undefined;
    // runs already on disk are history, not news
    this.runWatch.seed(host.runs());
  }

  // ── lookups ──

  private bot(id: string | undefined): OrgBot | undefined {
    return id ? this.host.bots().find((bot) => bot.id === id) : undefined;
  }

  private sectionOfBot(id: string | undefined): string | undefined {
    return sectionOf(this.bot(id)?.section) || undefined;
  }

  private groupForThread(threadId: string): OrgGroup | undefined {
    return this.host.groups().find((group) => groupThreads(group).includes(threadId));
  }

  private botForThread(threadId: string): OrgBot | undefined {
    return this.host.bots().find((bot) => botThreads(bot).includes(threadId));
  }

  private emit(event: OrgEventInput): OrgEvent | null {
    try {
      return this.events.append(event);
    } catch {
      return null;
    }
  }

  // ── reads ──

  org(): OrgConfig {
    return this.config.get(this.host.bots());
  }

  /** Throws OrgConfigError (status 400) on an invalid patch. */
  patchOrg(body: unknown): OrgConfig {
    return this.config.patch(body, this.host.bots());
  }

  eventsSince(since: number): OrgEvent[] {
    return this.events.since(since);
  }

  decisionList(): OrgDecision[] {
    return this.decisions.list();
  }

  inbox(): InboxItem[] {
    return collectInbox({
      bots: this.host.bots(),
      groups: this.host.groups(),
      messages: (threadId) => this.host.messages(threadId),
      isLiveRequest: (threadId, requestId) => this.host.isLiveRequest(threadId, requestId),
      runs: this.host.runs(),
    });
  }

  usage(now = Date.now()): UsageSummary {
    return summarizeUsage(this.ledger.rows(startOfWeek(now), now), {
      now,
      usdToCny: this.host.usdToCny() ?? DEFAULT_USD_TO_CNY,
      budgetPerDay: this.config.rules().budgetPerDay,
    });
  }

  private autoApprovedRows(now: number): AutoApprovedRow[] {
    if (!this.autoApproved) {
      const horizon = startOfDay(now) - DAY_MS;
      this.autoApproved = this.host
        .decisionRows(5_000)
        .map((row) => autoApprovedRow(row))
        .filter((row): row is AutoApprovedRow => Boolean(row && row.at >= horizon));
    }
    return this.autoApproved;
  }

  brief(since: number, now = Date.now()): Brief {
    const bots = this.host.bots();
    const conversations = new Map<string, ConversationState>();
    const conversation = (threadId: string): ConversationState => {
      let state = conversations.get(threadId);
      if (state) return state;
      const messages = this.host.messages(threadId);
      state = { lastAt: messages.at(-1)?.at, replied: false };
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i]!;
        if (message.role === "user" && message.kind === "text") {
          state.lastUserAt = message.at;
          break;
        }
        if (message.role === "bot" && message.kind === "text" && message.text?.trim()) state.replied = true;
      }
      conversations.set(threadId, state);
      return state;
    };
    const lastBotMessageAt = (botId: string): number | undefined => {
      const bot = bots.find((entry) => entry.id === botId);
      if (!bot) return undefined;
      let latest = 0;
      for (const threadId of botThreads(bot)) {
        const messages = this.host.messages(threadId);
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          const message = messages[i]!;
          if (message.role === "bot" && message.kind === "text") {
            latest = Math.max(latest, message.at);
            break;
          }
        }
      }
      return latest || undefined;
    };
    const dayStart = startOfDay(now);
    return buildBrief({
      now,
      since,
      org: this.config.get(bots),
      bots,
      groups: this.host.groups(),
      runs: this.host.runs(),
      needsYou: this.inbox(),
      events: this.events.since(Math.min(since, dayStart)),
      autoApproved: this.autoApprovedRows(now),
      spend: this.usage(now),
      conversation,
      lastBotMessageAt,
    });
  }

  // ── hooks (called from server/index.ts) ──

  /** Every decision-log row as it is appended: approvals become events. */
  onDecisionRow(raw: Omit<DecisionRow, "at">): void {
    try {
      // summaries carry whatever the agent typed; never put a secret in an event title
      const row = redactSecrets(raw) as Omit<DecisionRow, "at">;
      const bot = this.bot(row.botId);
      const now = Date.now();
      const event = approvalEventFor(row, {
        botName: bot?.name ?? row.botName,
        section: this.sectionOfBot(row.botId),
        groupId: this.groupForThread(row.threadId)?.id,
      });
      const quiet = row.decision === "auto-approved" && now - (this.lastAutoEvent.get(row.botId ?? "") ?? 0) < AUTO_EVENT_EVERY_MS;
      if (event && !quiet) {
        this.emit(event);
        if (row.decision === "auto-approved") this.lastAutoEvent.set(row.botId ?? "", now);
      }
      if (row.decision === "auto-approved") {
        const entry = autoApprovedRow({ ...row, at: new Date(now).toISOString() });
        const rows = this.autoApprovedRows(now);
        if (entry && !rows.some((existing) => existing.id === entry.id)) rows.push(entry);
        const horizon = startOfDay(now) - DAY_MS;
        if (rows.length && rows[0]!.at < horizon) this.autoApproved = rows.filter((existing) => existing.at >= horizon);
      }
    } catch {
      /* recording must never take down the approval it records */
    }
  }

  /** Every dispatch broadcast: run/subtask transitions become events, a run
   * started right after a decision becomes its action items. */
  onDispatchRun(run: DispatchRun): void {
    try {
      const events = this.runWatch.diff(run, {
        botName: (id) => this.bot(id)?.name,
        botSection: (id) => this.sectionOfBot(id),
        maxAttempts: this.host.maxAttempts(),
      });
      if (events.some((event) => event.kind === "run.started")) {
        this.decisions.linkRun(run, (decision) =>
          decision.source.threadId === run.sourceThreadId ||
          (decision.source.kind === "group" && this.groupForThread(run.sourceThreadId)?.id === decision.source.id),
        );
      }
      const decisionId = this.decisions.decisionForRun(run.id);
      for (const event of events) this.emit(decisionId !== undefined ? { ...event, decisionId } : event);
      this.decisions.syncRun(run);
    } catch (error) {
      console.error("org: could not record a dispatch change", error);
    }
  }

  /** The owner answered an options card: record the decision (决议 #n) and
   * mark the card with it. Returns the decision, or null when the card is not
   * a decision (an approval, the onboarding quiz) or already has one. */
  onOptionsAnswered(threadId: string, messageId: string, choice: string | undefined): OrgDecision | null {
    try {
      const message = this.host.messages(threadId).find((entry) => entry.id === messageId);
      const card = message?.card;
      const answer = (choice ?? "").trim();
      if (!message || !isDecisionCard(card) || card.decisionId || !answer) return null;
      const group = this.groupForThread(threadId);
      const owner = group ? undefined : this.botForThread(threadId);
      const botId = message.from?.botId ?? owner?.id;
      const title = questionOf(card);
      // the sources the question leans on: library docs cited in the run-up
      // (a meeting's recent discussion, a chat's last few turns) and the card
      const thread = this.host.messages(threadId);
      const index = thread.findIndex((entry) => entry.id === messageId);
      const leadUp = thread.slice(Math.max(0, index - (group ? 30 : 8)), Math.max(0, index)).map((entry) => entry.text ?? "");
      const basis = basisFromTexts([...leadUp, card.title, card.subtitle, ...card.options], this.library.list());
      const decision = this.decisions.create({
        title,
        options: card.options,
        choice: answer,
        source: group
          ? { kind: "group", id: group.id, threadId, messageId }
          : { kind: "chat", id: owner?.id ?? threadId, threadId, messageId },
        ...(basis.length ? { basis } : {}),
      });
      // read the card again: the provider's own settle may have landed meanwhile
      const latest = this.host.messages(threadId).find((entry) => entry.id === messageId)?.card ?? card;
      this.host.patchCard(threadId, messageId, { ...latest, answered: answer, decisionId: decision.id });
      this.emit({
        kind: "decision",
        title: t("Decision #{id}: {title} — {choice}", { id: decision.id, title: firstLine(title, 40), choice: firstLine(answer, 30) }),
        decisionId: decision.id,
        threadId,
        ...(botId ? { botId } : {}),
        ...(group ? { groupId: group.id } : {}),
        ...(this.sectionOfBot(botId) ? { section: this.sectionOfBot(botId) } : {}),
        detail: answer,
        severity: "info",
      });
      return decision;
    } catch (error) {
      console.error("org: could not record a decision", error);
      return null;
    }
  }

  /** Bank one settled turn in the spend ledger. */
  recordTurnUsage(botId: string | undefined, usage: { input?: number; output?: number; cachedInput?: number } | undefined, costUsd: number | null | undefined): void {
    if (!botId) return;
    try {
      this.ledger.record({ botId, costUsd, input: usage?.input, output: usage?.output, cachedInput: usage?.cachedInput });
    } catch {
      /* the spend ledger must never fail a turn */
    }
  }

  /** The library block of a bot's system prompt (subscribed docs, latest
   * versions, isolation respected). Never throws. */
  libraryPrompt(bot: { id: string; section?: string }): string {
    try {
      const isolated = new Set(this.org().departments.filter((dep) => dep.isolated).map((dep) => dep.section));
      const own = sectionOf(bot.section);
      return this.library.promptFor(bot.id, { readable: (doc) => !doc.section || !isolated.has(doc.section) || doc.section === own });
    } catch {
      return "";
    }
  }

  // ── library (the app calls as the owner) ──

  /** A doc as the app sees it: subscribers and readers that still exist. */
  private live(doc: LibraryDoc): LibraryDoc {
    const ids = new Set(this.host.bots().map((bot) => bot.id));
    return { ...doc, subscribers: doc.subscribers.filter((id) => ids.has(id)), inUse: doc.inUse.filter((entry) => ids.has(entry.botId)) };
  }

  libraryList(): LibraryDoc[] {
    return this.library.list().map((doc) => this.live(doc));
  }

  libraryRead(id: string, version?: number): { doc: LibraryDoc; text: string; version: number } | null {
    const read = this.library.read(id, version);
    return read ? { ...read, doc: this.live(read.doc) } : null;
  }

  publishDoc(body: unknown): LibraryDoc {
    const doc = this.library.publish(body, { kind: "owner" });
    const latest = doc.versions.at(-1)!;
    this.emit({
      kind: "library.published",
      title: t("“{title}” v{version} published", { title: firstLine(doc.title, 40), version: latest.version }),
      docId: doc.id,
      ...(doc.ownerBotId ? { botId: doc.ownerBotId } : {}),
      ...(doc.section ? { section: doc.section } : {}),
      ...(latest.decisionId ? { decisionId: latest.decisionId } : {}),
      ...(latest.note ? { detail: latest.note } : {}),
      severity: "info",
    });
    return this.live(doc);
  }

  subscribeDoc(id: string, body: unknown): LibraryDoc {
    const value = (body ?? {}) as { botId?: unknown; on?: unknown };
    if (typeof value.botId !== "string" || typeof value.on !== "boolean") throw new LibraryError("botId and on are required");
    const bot = this.bot(value.botId);
    if (!bot || bot.hidden) throw new LibraryError(t("No such bot"), 404);
    const doc = this.library.get(id);
    if (!doc) throw new LibraryError("no such document", 404);
    if (value.on && doc.section && doc.section !== sectionOf(bot.section)) {
      const isolated = this.org().departments.some((dep) => dep.section === doc.section && dep.isolated);
      if (isolated) throw new LibraryError(t("{section} is isolated: other departments can only ask for redacted results", { section: doc.section }), 403);
    }
    return this.live(this.library.subscribe(id, bot.id, value.on));
  }

  // ── unattended approvals expire ──

  /** An approval card shown while the bot was unattended. */
  trackUnattended(entry: Omit<UnattendedApproval, "at">): void {
    this.expiry.track({ ...entry, at: Date.now() });
    if (!this.sweepTimer) {
      const every = Math.min(15_000, Math.max(250, Math.floor((this.expiryMs ?? 60_000) / 4)));
      this.sweepTimer = setInterval(() => void this.sweepExpired(), every);
      this.sweepTimer.unref?.();
    }
  }

  /** Deny every tracked approval that waited past the rule. Returns how many expired. */
  async sweepExpired(now = Date.now()): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    let expired = 0;
    try {
      const minutes = this.config.rules().unattendedExpiryMin;
      for (const entry of this.expiry.due(now, this.expiryMs ?? minutes * 60_000)) {
        const card = this.host.messages(entry.threadId).find((message) => message.id === entry.messageId)?.card;
        if (!card || card.answered || card.dismissed) continue; // answered in time
        const delivered = await this.host
          .deny(
            entry.instanceId,
            entry.threadId,
            entry.requestId,
            `Nobody approved this within ${minutes} minutes while the owner was away, so it was not run. Do not retry it now; say in your reply that it is waiting for the owner.`,
          )
          .catch(() => false);
        if (!delivered) continue; // the ask is already gone with its turn
        const latest = this.host.messages(entry.threadId).find((message) => message.id === entry.messageId)?.card ?? card;
        this.host.patchCard(entry.threadId, entry.messageId, { ...latest, answered: "expired", dismissed: true });
        this.host.chip(entry.threadId, t("Nobody approved this within {minutes} minutes while unattended, so it did not run", { minutes }), false);
        this.host.logDecision({
          threadId: entry.threadId,
          requestId: entry.requestId,
          botId: entry.botId,
          botName: entry.botName,
          tool: entry.tool,
          summary: entry.summary,
          decision: "expired",
          source: "unattended-expiry",
          rule: `unattendedExpiryMin=${minutes}`,
          unattended: true,
        });
        expired += 1;
      }
    } finally {
      this.sweeping = false;
      if (this.expiry.size === 0 && this.sweepTimer) {
        clearInterval(this.sweepTimer);
        this.sweepTimer = null;
      }
    }
    return expired;
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }
}
