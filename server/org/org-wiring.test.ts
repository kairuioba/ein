// The company layer's hooks in server/index.ts are one line each, which is
// exactly how they rot: everything keeps working while the events, decisions
// and spend quietly stop being recorded. So, like decision-log-wiring.test.ts,
// these run the real server against the fake CLIs and assert what the org
// routes report:
//
//   1. publishing outside is carded even in auto mode, carries its rule and
//      cannot be "always allowed"; the inbox lists it with its request id
//   2. auto-approvals and the owner's answers become events and brief rows
//   3. an unattended approval nobody answers expires (card, log, event, brief)
//   4. answering a bot's question records 决议 #n and marks the card
//   5. the org config round-trips and a subscribed library doc reaches the
//      bot's prompt, recording the version it used
//   6. a dispatch run's transitions become events, its frames carry a `kind`,
//      and every settled turn lands in the spend ledger (own server: the
//      dispatcher's model recommender may pick any engine for new specialists,
//      so every engine there answers like a worker)
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Brief, OrgDecision, OrgEvent } from "../../shared/org-types.ts";
import type { DecisionRow } from "../decision-log.ts";
import { removeTempDir, waitForExit } from "../testing/cleanup.ts";
import { openSse } from "../testing/sse.ts";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const FAKE_CODEX = join(SERVER_DIR, "testing", "fake-codex-app-server.ts");
const posixOnly = describe.skipIf(process.platform === "win32");

interface Server {
  base: string;
  log: () => string;
  api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>;
  stop(): Promise<void>;
}

async function waitFor<T>(read: () => Promise<T | null | undefined | false>, what: string, log: () => string, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. server output:\n${log().slice(-2000)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function boot(instances: Record<string, unknown>): Promise<Server> {
  const port = 18800 + Math.floor(Math.random() * 10_000);
  const base = `http://127.0.0.1:${port}`;
  const home = mkdtempSync(join(tmpdir(), "omb-org-e2e-"));
  mkdirSync(join(home, ".ein"), { recursive: true });
  // these integration tests exercise the mechanics, not the owner-confirmation
  // gate, so plans start immediately here
  writeFileSync(join(home, ".ein", "config.json"), JSON.stringify({ usage: { usdToCny: 7 }, instances, dispatch: { requireApproval: false } }));
  let output = "";
  const child: ChildProcess = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      OMB_LOCALE: "en", // the assertions read the English source strings
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(port),
      OMB_WEBHOOK_PORT: String(port + 1),
      OMB_UNATTENDED_EXPIRY_MS: "1500",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (chunk) => (output += chunk));
  child.stderr!.on("data", (chunk) => (output += chunk));
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  await waitFor(
    async () => {
      try {
        return (await fetch(`${base}/api/health`)).ok;
      } catch {
        return false;
      }
    },
    "the server to come up",
    () => output,
    25_000,
  );
  return {
    base,
    log: () => output,
    api,
    stop: async () => {
      await waitForExit(child, { signal: "SIGTERM" });
      await removeTempDir(home);
    },
  };
}

/** Helpers bound to one server. */
function helpers(server: Server) {
  const { api, log } = server;
  const until = <T>(read: () => Promise<T | null | undefined | false>, what: string, ms?: number) => waitFor(read, what, log, ms);
  const events = async () => (await api("GET", "/api/org/events?since=0")).body.events as OrgEvent[];
  return {
    until,
    events,
    event: (pred: (entry: OrgEvent) => boolean, what: string) => until(async () => (await events()).find(pred), what),
    decisionRow: (pred: (row: DecisionRow) => boolean, what: string) =>
      until(async () => ((await api("GET", "/api/decisions")).body.decisions as DecisionRow[]).filter(pred).at(-1), what),
    /** An open options card on a conversation. */
    openCard: (threadId: string, what: string) =>
      until(
        async () =>
          ((await api("GET", `/api/threads/${threadId}/messages`)).body.messages ?? []).find(
            (m: { kind: string; card?: { requestId?: string; answered?: string } }) => m.kind === "options" && m.card?.requestId && !m.card.answered,
          ),
        what,
      ),
    makeBot: async (name: string, instanceId: string, patch: Record<string, unknown> = {}, model = "fake-model") => {
      const created = await api("POST", "/api/bots", { name });
      expect(created.status).toBe(201);
      const patched = await api("PATCH", `/api/bots/${created.body.bot.id}`, { ...patch, modelSelection: { instanceId, model } });
      expect(patched.status).toBe(200);
      return patched.body.bot as { id: string; threadId: string; name: string };
    },
  };
}

posixOnly("company layer wiring: approvals, decisions, org and library", () => {
  let server: Server;
  let h: ReturnType<typeof helpers>;

  beforeAll(async () => {
    chmodSync(FAKE_ACP, 0o755);
    chmodSync(FAKE_CODEX, 0o755);
    server = await boot({
      grok: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "permission" }, config: { cli: FAKE_ACP, fullAuto: false } },
      publisher: {
        driver: "grokAgent",
        environment: { FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_COMMAND: "npm publish --access public" },
        config: { cli: FAKE_ACP, fullAuto: false },
      },
      echo: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "echo-gated" }, config: { cli: FAKE_ACP, fullAuto: false } },
      codex: { driver: "codex", environment: { FAKE_CODEX_MODE: "question" }, config: { cli: FAKE_CODEX, fullAuto: false } },
    });
    h = helpers(server);
  }, 40_000);

  afterAll(async () => {
    await server?.stop();
  });

  it(
    "cards publishing outside even in auto mode, with its rule and no always-allow",
    async () => {
      const { api } = server;
      const bot = await h.makeBot("Publisher", "publisher", { autoApprove: true, alwaysAllow: ["shell:npm"] });
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "ship the package" })).status).toBe(202);
      const card = await h.openCard(bot.threadId, "the external-publishing card");
      expect(card.card.rule).toBe("External publishing always needs your approval");
      expect(card.card.allowKey).toBeUndefined();
      expect(card.card.held).toBeUndefined();

      const row = await h.decisionRow((entry) => entry.requestId === card.card.requestId && entry.decision === "card-shown", "the card's decision row");
      expect(row.source).toBe("external-publish");
      expect(await h.event((entry) => entry.kind === "approval.requested" && entry.botId === bot.id, "approval.requested")).toMatchObject({
        title: "Publisher wants to publish outside — needs your approval: npm publish --access public",
      });

      const brief = (await api("GET", "/api/brief?since=0")).body as Brief;
      expect(brief.needsYou).toContainEqual(
        expect.objectContaining({ kind: "approval", requestId: card.card.requestId, botId: bot.id, rule: "External publishing always needs your approval" }),
      );

      expect((await api("POST", `/api/bots/${bot.id}/respond`, { requestId: card.card.requestId, behavior: "deny" })).status).toBe(200);
      await h.event((entry) => entry.kind === "approval.resolved" && entry.botId === bot.id, "approval.resolved after the deny");
      const after = (await api("GET", "/api/brief?since=0")).body as Brief;
      expect(after.needsYou.some((item) => item.requestId === card.card.requestId)).toBe(false);
    },
    90_000,
  );

  it(
    "turns auto-approvals and the owner's answers into events and brief rows",
    async () => {
      const { api } = server;
      const granted = await h.makeBot("Granted", "grok", { alwaysAllow: ["shell:echo"] });
      expect((await api("POST", `/api/bots/${granted.id}/messages`, { text: "run it" })).status).toBe(202);
      await h.event((entry) => entry.kind === "approval.auto" && entry.botId === granted.id, "approval.auto");
      const brief = (await api("GET", "/api/brief?since=0")).body as Brief;
      expect(brief.autoApproved).toContainEqual(expect.objectContaining({ botId: granted.id, title: "echo hi", rule: "Always allowed: shell:echo" }));

      const asker = await h.makeBot("Asker", "grok");
      expect((await api("POST", `/api/bots/${asker.id}/messages`, { text: "run it" })).status).toBe(202);
      const card = await h.openCard(asker.threadId, "an approval card");
      expect(card.card.allowKey).toBe("shell:echo");
      expect(card.card.rule).toBeUndefined();
      await h.event((entry) => entry.kind === "approval.requested" && entry.botId === asker.id, "approval.requested");
      expect((await api("POST", `/api/threads/${asker.threadId}/respond`, { requestId: card.card.requestId, behavior: "allow" })).status).toBe(200);
      expect(await h.event((entry) => entry.kind === "approval.resolved" && entry.botId === asker.id, "approval.resolved")).toMatchObject({
        title: "You approved Asker: echo hi",
      });
    },
    90_000,
  );

  it(
    "expires an unattended approval nobody answered",
    async () => {
      const { api } = server;
      const bot = await h.makeBot("Nightshift", "grok", { autoApprove: true });
      const hook = await api("POST", "/api/webhooks", { name: "Nightly", prompt: "Handle the event", botId: bot.id, runOn: "maus" });
      expect(hook.status).toBe(201);
      const delivered = await fetch(hook.body.credential.url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(delivered.status).toBe(202);
      const { runId } = (await delivered.json()) as { runId: string };
      const threadId = await h.until(async () => {
        const run = ((await api("GET", "/api/routines")).body.runs ?? []).find((entry: { id: string }) => entry.id === runId);
        return run?.threadId as string | undefined;
      }, "the webhook's task");

      const card = await h.openCard(threadId, "the unattended card");
      const expired = await h.until(async () => {
        const messages = (await api("GET", `/api/threads/${threadId}/messages`)).body.messages ?? [];
        return messages.find((m: { id: string; card?: { answered?: string } }) => m.id === card.id && m.card?.answered === "expired");
      }, "the card to expire");
      expect(expired.card.dismissed).toBe(true);

      const row = await h.decisionRow((entry) => entry.requestId === card.card.requestId && entry.decision === "expired", "the expiry row");
      expect(row).toMatchObject({ source: "unattended-expiry", unattended: true, botId: bot.id });
      await h.event((entry) => entry.kind === "approval.expired" && entry.botId === bot.id, "approval.expired");
      const brief = (await api("GET", "/api/brief?since=0")).body as Brief;
      expect(brief.expired).toContainEqual(expect.objectContaining({ botId: bot.id, title: "echo hi" }));
    },
    90_000,
  );

  it(
    "records the owner's answer to a bot's question as decision #n and marks the card",
    async () => {
      const { api } = server;
      const bot = await h.makeBot("Pricer", "codex", {}, "gpt-fake-default");
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "price it" })).status).toBe(202);
      const card = await h.openCard(bot.threadId, "the question card");
      expect(card.card.options).toEqual(["699", "799"]);
      expect(card.card.tool).toBeUndefined();

      const listed = (await api("GET", "/api/brief?since=0")).body as Brief;
      expect(listed.needsYou).toContainEqual(expect.objectContaining({ id: card.id, kind: "choice", options: ["699", "799"], requestId: card.card.requestId }));

      const answered = await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: card.card.requestId, behavior: "answer", message: "799" });
      expect(answered.status).toBe(200);
      const decisions = (await api("GET", "/api/org/decisions")).body.decisions as OrgDecision[];
      expect(decisions[0]).toMatchObject({
        title: "Flagship price: 699 or 799?",
        options: ["699", "799"],
        choice: "799",
        decidedBy: "owner",
        source: { kind: "chat", id: bot.id, threadId: bot.threadId, messageId: card.id },
      });
      const marked = ((await api("GET", `/api/threads/${bot.threadId}/messages`)).body.messages ?? []).find((m: { id: string }) => m.id === card.id);
      expect(marked.card).toMatchObject({ answered: "799", decisionId: decisions[0]!.id });
      expect(await h.event((entry) => entry.kind === "decision", "the decision event")).toMatchObject({ decisionId: decisions[0]!.id, botId: bot.id });
    },
    90_000,
  );

  it(
    "round-trips the org config and feeds a subscribed library doc into the bot's prompt",
    async () => {
      const { api } = server;
      const org = await api("PATCH", "/api/org", { rules: { budgetPerDay: 80, externalPublishNeedsOwner: false }, departments: [{ section: "市场部", headcount: 5 }] });
      expect(org.status).toBe(200);
      expect(org.body.rules).toMatchObject({ budgetPerDay: 80, externalPublishNeedsOwner: true });
      expect((await api("GET", "/api/org")).body.departments[0]).toMatchObject({ section: "市场部", headcount: 5 });
      expect((await api("PATCH", "/api/org", { chiefBotId: "nobody" })).status).toBe(400);

      const reader = await h.makeBot("Reader", "echo");
      const doc = await api("POST", "/api/library", { title: "Price list", section: null, text: "Flagship: 799" });
      expect(doc.status).toBe(200);
      expect((await api("POST", `/api/library/${doc.body.id}/subscribe`, { botId: reader.id, on: true })).body.subscribers).toEqual([reader.id]);

      expect((await api("POST", `/api/bots/${reader.id}/messages`, { text: "what is the price?" })).status).toBe(202);
      const reply = await h.until(async () => {
        const messages = (await api("GET", `/api/threads/${reader.threadId}/messages`)).body.messages ?? [];
        return messages.find((m: { role: string; kind: string; text?: string }) => m.role === "bot" && m.kind === "text" && m.text?.startsWith("echo:"));
      }, "the echoed prompt");
      expect(reply.text).toContain('BEGIN LIBRARY DOCUMENT "Price list" v1');
      expect(reply.text).toContain("Flagship: 799");
      const docs = (await api("GET", "/api/library")).body.docs;
      expect(docs[0].inUse).toEqual([{ botId: reader.id, version: 1 }]);
      await h.event((entry) => entry.kind === "library.published" && entry.docId === doc.body.id, "library.published");
    },
    90_000,
  );
});

posixOnly("company layer wiring: dispatch runs and spend", () => {
  let server: Server;
  let h: ReturnType<typeof helpers>;

  beforeAll(async () => {
    chmodSync(FAKE_ACP, 0o755);
    server = await boot({
      planner: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "chief-plan" }, config: { cli: FAKE_ACP, fullAuto: false } },
    });
    h = helpers(server);
  }, 40_000);

  afterAll(async () => {
    await server?.stop();
  });

  it(
    "turns a dispatch run into events, names its frames, and banks every turn's spend",
    async () => {
      const { api } = server;
      const sse = await openSse(`${server.base}/api/events`);
      try {
        const chief = await h.makeBot("Chief", "planner", { chiefOfStaff: true });
        expect((await api("POST", `/api/bots/${chief.id}/messages`, { text: "DISPATCH_PLAN launch kit" })).status).toBe(202);
        const frame = await sse.until((entry) => entry.kind === "dispatch.run", 30_000);
        expect(frame.run.chiefBotId).toBe(chief.id);

        const done = await h.event((entry) => entry.kind === "run.done" && entry.botId === chief.id, "run.done");
        const runEvents = (await h.events()).filter((entry) => entry.runId === done.runId).map((entry) => entry.kind);
        expect(runEvents).toEqual(["run.started", "people.added", "report", "report", "run.done"]);

        const brief = (await api("GET", "/api/brief?since=0")).body as Brief;
        expect([brief.done, brief.total]).toEqual([2, 2]);
        expect(brief.headline).toBe("Overall 2/2; nothing needs your decision.");

        const usage = (await api("GET", "/api/usage/summary")).body;
        expect(usage.byBot.map((entry: { botId: string }) => entry.botId)).toContain(chief.id);
        expect(usage.unpricedTokens).toBeGreaterThan(0);
        expect(usage.usdToCny).toBe(7);
      } finally {
        sse.close();
      }
    },
    90_000,
  );
});
