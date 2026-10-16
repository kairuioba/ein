// The company layer on top of bots: departments, the chief (主 Bot), rules,
// decisions, the "needs you" inbox, the daily brief, spend and the shared
// library. Shared by the server (server/org/*) and the app (src/state/org-api.ts).
//
// Departments are not a second copy of the team: a department IS a sidebar
// section (`bot.section`), and its lead IS that section's chief of staff
// (`bot.chiefOfStaff`). This file only adds what a section string cannot say.

/** A department's extra settings, keyed by the section name its bots carry. */
export interface OrgDepartment {
  /** the `section` value of its bots (never "", which is the unsectioned list) */
  section: string;
  /** display colour, "#RRGGBB" */
  color: string;
  /** 编制: how many bots it may have (lead included); undefined = no limit */
  headcount?: number;
  /** 预算线: CNY per day */
  budgetPerDay?: number;
  /** 隔离区: other departments can only ask and get redacted answers */
  isolated?: boolean;
  /** connected-app slugs its bots may use; undefined = every connected app */
  allowedApps?: string[];
  /** label of its private working folder (shown only) */
  privateFolder?: string;
}

/** A temporary cross-department group (矩阵项目组). Members keep their
 * department; the project lead is a dotted-line manager until `until`. */
export interface OrgProject {
  id: string;
  name: string;
  leadBotId?: string;
  memberBotIds: string[];
  /** ISO date the group dissolves on */
  until?: string;
}

/** Who may decide a kind of question. Levels go up the chain. */
export type DecisionLevel = "employee" | "lead" | "chief" | "owner";
export interface DecisionRight {
  id: string;
  /** shown as written — the server keeps English sources and the app translates */
  label: string;
  decides: DecisionLevel;
  /** levels that may propose but not decide */
  suggest: DecisionLevel[];
  /** owner-set and not editable by any bot */
  locked?: boolean;
}

export interface OrgRules {
  /** a lead manages at most this many bots directly; more are grouped */
  spanOfControl: number;
  /** minutes stuck before a bot's problem moves one level up */
  escalateAfterMin: number;
  /** what the chief may do without asking while inside the budget line */
  chiefMay: { addPeople: boolean; newSpecialist: boolean; switchModel: boolean };
  /** the company's daily budget, CNY */
  budgetPerDay: number;
  /** posting, emailing and going live always need the owner — not editable */
  externalPublishNeedsOwner: true;
  /** an approval nobody answers in this many minutes, while unattended, is voided */
  unattendedExpiryMin: number;
  reportCadence: { everyHours: number; onDone: boolean; onIncident: boolean; dailyBriefAt: string };
}

export interface OrgConfig {
  version: 1;
  /** the 主 Bot (总控): starred and pinned; the owner talks to it first */
  chiefBotId: string | null;
  departments: OrgDepartment[];
  projects: OrgProject[];
  rules: OrgRules;
  decisionRights: DecisionRight[];
  updatedAt: number;
}

export const DEFAULT_ORG_RULES: OrgRules = {
  spanOfControl: 5,
  escalateAfterMin: 10,
  chiefMay: { addPeople: true, newSpecialist: true, switchModel: false },
  budgetPerDay: 60,
  externalPublishNeedsOwner: true,
  unattendedExpiryMin: 10,
  reportCadence: { everyHours: 2, onDone: true, onIncident: true, dailyBriefAt: "18:00" },
};

/** The palette new departments cycle through (sky, green, pink, amber, violet, teal, coral, slate). */
export const DEPARTMENT_COLORS = ["#0EA5E9", "#65A30D", "#EC4899", "#F59E0B", "#8B5CF6", "#14B8A6", "#F97316", "#475467"] as const;

// ── events: what changed, for "since you last looked" and the timeline ───────
export type OrgEventKind =
  | "run.started"
  | "run.done"
  | "run.failed"
  | "subtask.failed"
  | "subtask.retry"
  | "people.added"
  | "decision"
  | "approval.requested"
  | "approval.resolved"
  | "approval.auto"
  | "approval.expired"
  | "library.published"
  | "escalation"
  | "report"
  | "meeting";

export interface OrgEvent {
  id: string;
  at: number;
  kind: OrgEventKind;
  /** one short line, already in the app's language */
  title: string;
  botId?: string;
  section?: string;
  runId?: string;
  threadId?: string;
  groupId?: string;
  decisionId?: number;
  docId?: string;
  severity?: "info" | "warn" | "error";
}

// ── decisions (决议 #n) ───────────────────────────────────────────────────────
export interface OrgDecision {
  /** shown as #id; counts up from 1 */
  id: number;
  title: string;
  choice: string;
  options: string[];
  decidedBy: DecisionLevel;
  at: number;
  /** where it was asked: a group (meeting) or a 1:1 chat */
  source: { kind: "group" | "chat"; id: string; messageId?: string };
  /** sources quoted when asking, e.g. "价格表 v3" */
  basis?: string[];
  /** work it produced; each becomes a task tagged "from decision #n" */
  actionItems: Array<{ title: string; botId?: string; runId?: string; subtaskId?: string; status: "pending" | "running" | "done" | "failed" }>;
}

// ── the "needs you" inbox ─────────────────────────────────────────────────────
export type InboxKind = "choice" | "approval" | "escalation";
export interface InboxItem {
  /** stable id: the options card's message id, the approval request id, or the escalation id */
  id: string;
  kind: InboxKind;
  title: string;
  botId: string;
  threadId?: string;
  groupId?: string;
  messageId?: string;
  /** when it started waiting */
  since: number;
  detail?: string;
  /** the rule that sent it to you, e.g. "external publishing always needs you" */
  rule?: string;
  /** escalation path, oldest first */
  chain?: Array<{ botId: string; at: number }>;
  /** the choices to offer inline (a choice card's options) */
  options?: string[];
  /** for approvals: the request to answer through the existing approval API */
  requestId?: string;
}

// ── spend ─────────────────────────────────────────────────────────────────────
export interface UsageSummary {
  currency: "CNY";
  todayCost: number;
  budgetPerDay: number;
  /** share of the week's budget used, 0–100; null when no budget is set */
  weekPercent: number | null;
  /** today's spend per bot, highest first */
  byBot: Array<{ botId: string; cost: number; tokens: number }>;
  /** engines that report tokens but no price are counted as 0 here */
  unpricedTokens: number;
}

// ── the daily brief (简报) ─────────────────────────────────────────────────────
export type Health = "green" | "yellow" | "red";
export interface BriefDepartment {
  section: string;
  color: string;
  done: number;
  total: number;
  health: Health;
  /** one line: what is happening there now */
  status: string;
  leadBotId?: string;
  lastReportAt?: number;
}
export interface Brief {
  at: number;
  /** "整体 13/31…；有 3 件事要你拍板。" — built from the numbers below */
  headline: string;
  done: number;
  total: number;
  departments: BriefDepartment[];
  needsYou: InboxItem[];
  /** approved for you by a rule */
  autoApproved: Array<{ id: string; title: string; botId: string; at: number; rule: string }>;
  /** voided because nobody answered in time */
  expired: Array<{ id: string; title: string; botId: string; at: number }>;
  /** events since `since` (the caller's last visit), newest first */
  changes: OrgEvent[];
  risks: Array<{ title: string; detail: string; botId?: string; severity: "warn" | "error" }>;
  spend: UsageSummary;
  /** today's events, oldest first */
  timeline: OrgEvent[];
}

// ── the shared library (资料库) ────────────────────────────────────────────────
export interface LibraryDocVersion {
  version: number;
  at: number;
  byBotId?: string;
  byOwner?: boolean;
  note?: string;
  /** the decision that produced this version, if any */
  decisionId?: number;
  size: number;
}
export interface LibraryDoc {
  id: string;
  title: string;
  /** null = company-wide (L3); a section name = that department's (L1) */
  section: string | null;
  /** the one bot allowed to publish new versions; the owner can always */
  ownerBotId?: string;
  versions: LibraryDocVersion[];
  /** bots told when a new version is published */
  subscribers: string[];
  /** which version each bot last used — a lower one than current is stale */
  inUse: Array<{ botId: string; version: number }>;
  updatedAt: number;
}

// ── adding people mid-run (中途加人) ──────────────────────────────────────────
export interface RunDiagnosis {
  runId: string;
  /** the four questions, answered from the run's own numbers */
  checks: Array<{ id: "waiting" | "parallel" | "capability" | "rateLimit"; ok: boolean; finding: string; evidence?: string }>;
  verdict: "add-helps" | "add-wont-help";
  /** why not, in one line, when adding won't help */
  reason?: string;
  suggestion?: {
    add: number;
    /** the new squad's name, e.g. "组 B" */
    squad: string;
    models: string[];
    /** finishing time now and after, epoch ms */
    etaBefore?: number;
    etaAfter?: number;
    costCny: number;
    withinBudget: boolean;
    /** communication lines for the lead before/after (grouped) */
    linesBefore: number;
    linesAfter: number;
  };
  /** not-started subtasks that would be re-split; done and running stay put */
  remaining: Array<{ subtaskId: string; title: string; status: "done" | "running" | "pending" }>;
}
