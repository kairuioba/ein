import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DispatchRun, DispatchSubtask } from "../../shared/dispatch-types.ts";
import type { DecisionRow } from "../decision-log.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { OrgEventLog } from "./events.ts";
import { OrgLayer, type OrgHost } from "./layer.ts";
import { LibraryError } from "./library.ts";
import type { OrgBot, OrgCard, OrgGroup, OrgMessage } from "./util.ts";

class FakeHost implements OrgHost {
  readonly dataDir: string;
  layer!: OrgLayer;
  botList: OrgBot[] = [
    { id: "chief", name: "总控", threadId: "t-chief", chiefOfStaff: true, createdAt: 1 },
    { id: "designer", name: "设计师", threadId: "t-designer", section: "设计部", chiefOfStaff: true, createdAt: 2 },
    { id: "writer", name: "社媒写手", threadId: "t-writer", section: "内容部", createdAt: 3 },
    { id: "auditor", name: "合规官", threadId: "t-auditor", section: "财务法务", chiefOfStaff: true, createdAt: 4 },
  ];
  groupList: OrgGroup[] = [{ id: "g1", name: "价格对齐会", threadId: "t-room", memberIds: ["chief", "designer"] }];
  threads = new Map<string, OrgMessage[]>();
  runList: DispatchRun[] = [];
  rows: DecisionRow[] = [];
  logged: Array<Omit<DecisionRow, "at">> = [];
  chips: Array<{ threadId: string; text: string; ok: boolean }> = [];
  denied: Array<{ instanceId: string; requestId: string }> = [];
  deliver = true;
  live = new Set<string>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }
  bots() {
    return this.botList;
  }
  groups() {
    return this.groupList;
  }
  messages(threadId: string) {
    return this.threads.get(threadId) ?? [];
  }
  patchCard(threadId: string, messageId: string, card: OrgCard) {
    const message = this.threads.get(threadId)?.find((entry) => entry.id === messageId);
    if (message) message.card = card;
  }
  chip(threadId: string, text: string, ok: boolean) {
    this.chips.push({ threadId, text, ok });
  }
  runs() {
    return this.runList;
  }
  maxAttempts() {
    return 2;
  }
  usdToCny() {
    return 7;
  }
  decisionRows() {
    return this.rows;
  }
  logDecision(row: Omit<DecisionRow, "at">) {
    this.logged.push(row);
    this.layer.onDecisionRow(row);
  }
  isLiveRequest(threadId: string, requestId: string) {
    return this.live.has(`${threadId}:${requestId}`);
  }
  async deny(instanceId: string, _threadId: string, requestId: string) {
    this.denied.push({ instanceId, requestId });
    return this.deliver;
  }
}

const question = (id: string, at: number, extra: Partial<OrgCard> = {}, from?: string): OrgMessage => ({
  id,
  role: "bot",
  kind: "options",
  at,
  card: { title: "Your bot has a question", subtitle: "旗舰款定价？", options: ["699", "799"], requestId: `req-${id}`, ...extra },
  ...(from ? { from: { botId: from } } : {}),
});

const subtask = (id: string, assigneeBotId: string, status: DispatchSubtask["status"] = "pending"): DispatchSubtask => ({
  id,
  title: `Task ${id}`,
  brief: "",
  role: "r",
  needs: [],
  difficulty: 2,
  dependsOn: [],
  assigneeBotId,
  status,
  attempts: 0,
});

describe("OrgLayer", () => {
  let dir: string;
  let host: FakeHost;
  let layer: OrgLayer;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-org-layer-"));
    host = new FakeHost(dir);
    layer = new OrgLayer(host, new OrgEventLog(dir));
    host.layer = layer;
  });
  afterEach(async () => {
    layer.stop();
    await removeTempDir(dir);
  });

  describe("decisions", () => {
    it("records the owner's pick as decision #1, marks the card and logs a decision event", () => {
      host.threads.set("t-designer", [question("q1", 100)]);
      const decision = layer.onOptionsAnswered("t-designer", "q1", " 799 ");
      expect(decision).toMatchObject({
        id: 1,
        title: "旗舰款定价？",
        options: ["699", "799"],
        choice: "799",
        decidedBy: "owner",
        source: { kind: "chat", id: "designer", threadId: "t-designer", messageId: "q1" },
      });
      expect(host.threads.get("t-designer")![0]!.card).toMatchObject({ answered: "799", decisionId: 1 });
      expect(layer.eventsSince(0)).toEqual([
        expect.objectContaining({ kind: "decision", decisionId: 1, botId: "designer", section: "设计部", title: "Decision #1: 旗舰款定价？ — 799", detail: "799" }),
      ]);
      // answering again never makes a second decision
      expect(layer.onOptionsAnswered("t-designer", "q1", "699")).toBeNull();
      expect(layer.decisionList()).toHaveLength(1);
    });

    it("records room decisions against the room", () => {
      host.threads.set("t-room", [question("q2", 100, {}, "chief")]);
      expect(layer.onOptionsAnswered("t-room", "q2", "799")?.source).toEqual({ kind: "group", id: "g1", threadId: "t-room", messageId: "q2" });
      expect(layer.eventsSince(0)[0]).toMatchObject({ groupId: "g1", botId: "chief" });
    });

    it("quotes the library docs the meeting cited as the decision's basis", () => {
      const doc = layer.publishDoc({ title: "价格表", section: null, text: "v1", ownerBotId: "designer" });
      layer.publishDoc({ id: doc.id, title: "价格表", section: null, text: "v2" });
      host.threads.set("t-room", [
        { id: "m1", role: "bot", kind: "text", at: 90, text: "按价格表 v1 旗舰款是 699", from: { botId: "writer" } },
        question("q2", 100, {}, "chief"),
      ]);
      expect(layer.onOptionsAnswered("t-room", "q2", "799")?.basis).toEqual(["价格表 v1"]);
    });

    it("ignores approvals, the onboarding quiz, empty answers and unknown messages", () => {
      host.threads.set("t-writer", [
        question("approval", 1, { tool: "Bash", options: ["Allow", "Deny"] }),
        { id: "quiz", role: "bot", kind: "options", at: 2, card: { title: "What do you mostly want help with?", subtitle: "", options: ["Work & projects"] } },
        question("empty", 3),
      ]);
      expect(layer.onOptionsAnswered("t-writer", "approval", "Allow")).toBeNull();
      expect(layer.onOptionsAnswered("t-writer", "quiz", "Work & projects")).toBeNull();
      expect(layer.onOptionsAnswered("t-writer", "empty", "  ")).toBeNull();
      expect(layer.onOptionsAnswered("t-writer", "missing", "x")).toBeNull();
      expect(layer.decisionList()).toEqual([]);
    });

    it("turns a run started from the same conversation into the decision's action items, and keeps them in sync", () => {
      host.threads.set("t-chief", [question("q3", Date.now() - 60_000)]);
      const decision = layer.onOptionsAnswered("t-chief", "q3", "799")!;
      const run: DispatchRun = {
        id: "run-1",
        chiefBotId: "chief",
        sourceThreadId: "t-chief",
        goal: "改价格",
        policy: "balanced",
        status: "running",
        subtasks: [subtask("price", "writer"), subtask("page", "designer")],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      layer.onDispatchRun(run);
      const started = layer.eventsSince(0).find((event) => event.kind === "run.started");
      expect(started?.decisionId).toBe(decision.id);
      expect(layer.decisionList()[0]!.actionItems.map((item) => [item.subtaskId, item.status])).toEqual([
        ["price", "pending"],
        ["page", "pending"],
      ]);
      run.subtasks[0]!.status = "done";
      layer.onDispatchRun(run);
      expect(layer.decisionList()[0]!.actionItems[0]!.status).toBe("done");
      expect(layer.eventsSince(0).find((event) => event.kind === "report")?.decisionId).toBe(decision.id);
    });
  });

  describe("approvals", () => {
    it("turns decision-log rows into events, without secrets", () => {
      layer.onDecisionRow({ threadId: "t-writer", requestId: "r1", botId: "writer", tool: "Bash", summary: "curl -H 'Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' x", decision: "card-shown", source: "no-grant" });
      const [event] = layer.eventsSince(0);
      expect(event).toMatchObject({ kind: "approval.requested", botId: "writer", section: "内容部", threadId: "t-writer" });
      expect(event!.title).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789");
    });

    it("writes one timeline line per bot for a burst of auto-approvals, but counts them all", () => {
      for (let i = 0; i < 5; i += 1) {
        layer.onDecisionRow({ threadId: "t", requestId: `w${i}`, botId: "writer", tool: "Bash", summary: `step ${i}`, decision: "auto-approved", source: "auto-mode" });
      }
      layer.onDecisionRow({ threadId: "t", requestId: "d0", botId: "designer", tool: "Bash", summary: "ls", decision: "auto-approved", source: "auto-mode" });
      expect(layer.eventsSince(0).map((event) => [event.kind, event.botId])).toEqual([
        ["approval.auto", "writer"],
        ["approval.auto", "designer"],
      ]);
      expect(layer.brief(0).autoApprovedTotal).toBe(6);
    });

    it("lists today's auto-approvals in the brief, from the log and from new rows", () => {
      const earlier = new Date(Math.max(new Date().setHours(0, 0, 0, 0), Date.now() - 60_000)).toISOString();
      host.rows = [
        { at: earlier, threadId: "t", requestId: "old-1", botId: "writer", tool: "Bash", summary: "git status", decision: "auto-approved", source: "always-allow", rule: "Bash:git" },
        { at: earlier, threadId: "t", requestId: "x", botId: "writer", tool: "Bash", summary: "ls", decision: "card-shown", source: "no-grant" },
      ];
      layer.onDecisionRow({ threadId: "t", requestId: "new-1", botId: "writer", tool: "Bash", summary: "ls", decision: "auto-approved", source: "auto-mode" });
      const brief = layer.brief(0);
      expect(brief.autoApproved.map((row) => [row.id, row.rule])).toEqual([
        ["new-1", "Auto mode is on for this bot"],
        ["old-1", "Always allowed: Bash:git"],
      ]);
      expect(brief.timeline.map((event) => event.kind)).toEqual(["approval.auto"]);
    });

    it("denies an unattended approval nobody answered in time, marks it expired and logs it", async () => {
      host.threads.set("t-writer", [question("ask", 1, { tool: "Bash", subtitle: "npm install left-pad", options: ["Allow", "Deny"], requestId: "req-ask" })]);
      layer.trackUnattended({ threadId: "t-writer", requestId: "req-ask", messageId: "ask", botId: "writer", botName: "社媒写手", tool: "Bash", summary: "npm install left-pad", instanceId: "kimi" });
      expect(await layer.sweepExpired(Date.now())).toBe(0);
      expect(await layer.sweepExpired(Date.now() + 10 * 60_000)).toBe(1);
      expect(host.denied).toEqual([{ instanceId: "kimi", requestId: "req-ask" }]);
      expect(host.threads.get("t-writer")![0]!.card).toMatchObject({ answered: "expired", dismissed: true });
      expect(host.chips).toEqual([{ threadId: "t-writer", text: "Nobody approved this within 10 minutes while unattended, so it did not run", ok: false }]);
      expect(host.logged).toEqual([expect.objectContaining({ decision: "expired", source: "unattended-expiry", requestId: "req-ask", unattended: true, rule: "unattendedExpiryMin=10" })]);
      expect(layer.eventsSince(0)).toEqual([expect.objectContaining({ kind: "approval.expired", botId: "writer", detail: "npm install left-pad" })]);
      expect(layer.brief(0).expired).toEqual([expect.objectContaining({ title: "npm install left-pad", botId: "writer" })]);
    });

    it("leaves an approval the owner answered in time, or one whose ask is already gone", async () => {
      host.threads.set("t-writer", [
        question("answered", 1, { tool: "Bash", requestId: "req-a", answered: "allow" }),
        question("gone", 2, { tool: "Bash", requestId: "req-g" }),
      ]);
      layer.trackUnattended({ threadId: "t-writer", requestId: "req-a", messageId: "answered", botId: "writer", instanceId: "kimi" });
      layer.trackUnattended({ threadId: "t-writer", requestId: "req-g", messageId: "gone", botId: "writer", instanceId: "kimi" });
      host.deliver = false;
      expect(await layer.sweepExpired(Date.now() + 11 * 60_000)).toBe(0);
      expect(host.denied.map((entry) => entry.requestId)).toEqual(["req-g"]);
      expect(host.threads.get("t-writer")![1]!.card!.answered).toBeUndefined();
      expect(host.logged).toEqual([]);
    });

    it("uses the configured expiry rule", async () => {
      layer.patchOrg({ rules: { unattendedExpiryMin: 30 } });
      host.threads.set("t-writer", [question("ask", 1, { tool: "Bash", requestId: "req-ask" })]);
      layer.trackUnattended({ threadId: "t-writer", requestId: "req-ask", messageId: "ask", botId: "writer", instanceId: "kimi" });
      expect(await layer.sweepExpired(Date.now() + 11 * 60_000)).toBe(0);
      expect(await layer.sweepExpired(Date.now() + 31 * 60_000)).toBe(1);
    });
  });

  describe("library", () => {
    it("publishes, announces the version and feeds subscribers' prompts", () => {
      const doc = layer.publishDoc({ title: "价格表", section: null, text: "旗舰款 ¥799", ownerBotId: "designer", note: "价格对齐会", decisionId: 3 });
      expect(layer.eventsSince(0)).toEqual([
        expect.objectContaining({ kind: "library.published", docId: doc.id, title: "“价格表” v1 published", botId: "designer", decisionId: 3, detail: "价格对齐会" }),
      ]);
      expect(layer.subscribeDoc(doc.id, { botId: "writer", on: true }).subscribers).toEqual(["writer"]);
      expect(layer.libraryPrompt({ id: "writer", section: "内容部" })).toContain("旗舰款 ¥799");
      expect(layer.libraryList()[0]!.inUse).toEqual([{ botId: "writer", version: 1 }]);
    });

    it("keeps isolated departments' documents inside the department", () => {
      layer.patchOrg({ departments: [{ section: "财务法务", isolated: true }] });
      const doc = layer.publishDoc({ title: "预算明细", section: "财务法务", text: "明细" });
      let caught: unknown;
      try {
        layer.subscribeDoc(doc.id, { botId: "writer", on: true });
      } catch (error) {
        caught = error;
      }
      expect((caught as LibraryError).status).toBe(403);
      expect(layer.subscribeDoc(doc.id, { botId: "auditor", on: true }).subscribers).toEqual(["auditor"]);
      // even a subscription made before the department was isolated never leaks
      layer.patchOrg({ departments: [{ section: "财务法务" }] });
      layer.subscribeDoc(doc.id, { botId: "writer", on: true });
      layer.patchOrg({ departments: [{ section: "财务法务", isolated: true }] });
      expect(layer.libraryPrompt({ id: "writer", section: "内容部" })).toBe("");
      expect(layer.libraryPrompt({ id: "auditor", section: "财务法务" })).toContain("明细");
    });

    it("rejects subscriptions for unknown bots or documents", () => {
      const doc = layer.publishDoc({ title: "x", section: null, text: "y" });
      expect(() => layer.subscribeDoc(doc.id, { botId: "nobody", on: true })).toThrow(LibraryError);
      expect(() => layer.subscribeDoc("missing", { botId: "writer", on: true })).toThrow(LibraryError);
      expect(() => layer.subscribeDoc(doc.id, { botId: "writer" })).toThrow(LibraryError);
    });

    it("drops deleted bots from what the app is shown", () => {
      const doc = layer.publishDoc({ title: "x", section: null, text: "y" });
      layer.subscribeDoc(doc.id, { botId: "writer", on: true });
      host.botList = host.botList.filter((bot) => bot.id !== "writer");
      expect(layer.libraryList()[0]!.subscribers).toEqual([]);
      expect(layer.libraryRead(doc.id)!.doc.subscribers).toEqual([]);
    });
  });

  describe("spend and the brief", () => {
    it("banks turns and sums them in CNY", () => {
      layer.recordTurnUsage("writer", { input: 1_000, output: 200 }, 0.5);
      layer.recordTurnUsage("designer", { input: 10, output: 5 }, null);
      layer.recordTurnUsage(undefined, { input: 10, output: 5 }, 1);
      const usage = layer.usage();
      expect(usage.todayCost).toBe(3.5);
      expect(usage.byBot.map((entry) => entry.botId)).toEqual(["writer", "designer"]);
      expect(usage.unpricedTokens).toBe(15);
      expect(usage.budgetPerDay).toBe(60);
    });

    it("brings the inbox, departments and spend together", () => {
      host.threads.set("t-designer", [question("pick", Date.now() - 60_000)]);
      host.live.add("t-designer:req-pick");
      layer.recordTurnUsage("writer", { input: 1, output: 1 }, 1);
      const brief = layer.brief(0);
      expect(brief.needsYou).toEqual([expect.objectContaining({ id: "pick", kind: "choice", botId: "designer", options: ["699", "799"] })]);
      expect(brief.departments.map((dep) => dep.section)).toEqual(["设计部", "内容部", "财务法务"]);
      expect(brief.departments[0]).toMatchObject({ health: "yellow", leadBotId: "designer" });
      expect(brief.headline).toBe("Nothing in progress; 1 thing needs your decision.");
      expect(brief.spend.todayCost).toBe(7);
    });
  });
});
