import { mkdtempSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DecisionRow } from "../decision-log.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { handleOrgApi, isOrgApiPath, type OrgApiDeps } from "./api.ts";
import { OrgEventLog } from "./events.ts";
import { OrgLayer, type OrgHost } from "./layer.ts";
import type { OrgBot } from "./util.ts";

const BOTS: OrgBot[] = [
  { id: "chief", name: "总控", threadId: "t-chief", chiefOfStaff: true, createdAt: 1 },
  { id: "lead", name: "市场分析师", threadId: "t-lead", section: "市场部", chiefOfStaff: true, createdAt: 2 },
];

function hostFor(dir: string): OrgHost {
  return {
    dataDir: dir,
    bots: () => BOTS,
    groups: () => [],
    messages: () => [],
    patchCard: () => {},
    chip: () => {},
    runs: () => [],
    maxAttempts: () => 2,
    usdToCny: () => undefined,
    decisionRows: (): DecisionRow[] => [],
    logDecision: () => {},
    isLiveRequest: () => false,
    deny: async () => false,
  };
}

describe("org API routes", () => {
  let dir: string;
  let deps: OrgApiDeps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-org-api-"));
    const events = new OrgEventLog(dir);
    deps = {
      json: (res, status, body) => {
        const out = res as unknown as { status: number; body: unknown };
        out.status = status;
        out.body = body;
      },
      readBody: async (req) => (req as unknown as { body: unknown }).body,
      events,
      org: new OrgLayer(hostFor(dir), events),
    };
  });
  afterEach(async () => {
    await removeTempDir(dir);
  });

  async function call(method: string, pathAndQuery: string, body?: unknown): Promise<{ handled: boolean; status: number; body: any }> {
    const url = new URL(`http://127.0.0.1${pathAndQuery}`);
    const res = { status: 0, body: undefined as unknown };
    const handled = await handleOrgApi(method, url.pathname, url, { body } as unknown as IncomingMessage, res as unknown as ServerResponse, deps);
    return { handled, status: res.status, body: res.body };
  }

  it("serves and patches the org config", async () => {
    const org = await call("GET", "/api/org");
    expect(org.status).toBe(200);
    expect(org.body).toMatchObject({ version: 1, chiefBotId: "chief", departments: [{ section: "市场部" }] });
    expect(org.body.decisionRights).toHaveLength(8);

    const patched = await call("PATCH", "/api/org", { rules: { budgetPerDay: 80 }, departments: [{ section: "市场部", color: "#0EA5E9", headcount: 5 }] });
    expect(patched.status).toBe(200);
    expect(patched.body.rules.budgetPerDay).toBe(80);
    expect(patched.body.departments[0]).toEqual({ section: "市场部", color: "#0EA5E9", headcount: 5 });

    const bad = await call("PATCH", "/api/org", { rules: { spanOfControl: -1 } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/spanOfControl/);
    expect((await call("DELETE", "/api/org")).status).toBe(405);
  });

  it("serves events, decisions, the brief and spend", async () => {
    deps.events.append({ kind: "report", title: "old", at: 1_000 });
    deps.events.append({ kind: "report", title: "new", at: 5_000 });
    expect((await call("GET", "/api/org/events?since=2000")).body).toEqual({ events: [expect.objectContaining({ title: "new" })] });
    expect((await call("GET", "/api/org/events")).body.events).toHaveLength(2);
    expect((await call("GET", "/api/org/events?since=junk")).body.events).toHaveLength(2);
    expect((await call("GET", "/api/org/decisions")).body).toEqual({ decisions: [] });

    const brief = await call("GET", "/api/brief?since=0");
    expect(brief.status).toBe(200);
    expect(brief.body).toMatchObject({ headline: "Nothing in progress, and nothing needs your decision.", needsYou: [], departments: [{ section: "市场部" }] });
    expect(brief.body.changes.map((event: { title: string }) => event.title)).toEqual(["new", "old"]);

    expect((await call("GET", "/api/usage/summary")).body).toMatchObject({ currency: "CNY", todayCost: 0, budgetPerDay: 60, usdToCny: 7.2 });
    expect((await call("POST", "/api/brief")).status).toBe(405);
  });

  it("publishes, reads and subscribes library documents", async () => {
    const created = await call("POST", "/api/library", { title: "价格表", section: null, text: "旗舰款 ¥799", ownerBotId: "lead" });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ title: "价格表", section: null, ownerBotId: "lead", versions: [{ version: 1, byOwner: true }] });
    const id = created.body.id as string;

    await call("POST", "/api/library", { id, title: "价格表", section: null, text: "旗舰款 ¥899", note: "v2" });
    expect((await call("GET", "/api/library")).body.docs.map((doc: { id: string }) => doc.id)).toEqual([id]);
    expect((await call("GET", `/api/library/${id}`)).body).toMatchObject({ version: 2, text: "旗舰款 ¥899" });
    expect((await call("GET", `/api/library/${id}?version=1`)).body).toMatchObject({ version: 1, text: "旗舰款 ¥799" });
    expect((await call("GET", `/api/library/${id}?version=7`)).status).toBe(404);
    expect((await call("GET", `/api/library/${id}?version=zero`)).status).toBe(400);
    expect((await call("GET", "/api/library/missing")).status).toBe(404);

    expect((await call("POST", `/api/library/${id}/subscribe`, { botId: "lead", on: true })).body.subscribers).toEqual(["lead"]);
    expect((await call("POST", `/api/library/${id}/subscribe`, { botId: "ghost", on: true })).status).toBe(404);
    expect((await call("POST", "/api/library", { title: "", section: null, text: "x" })).status).toBe(400);
    expect((await call("GET", `/api/library/${id}/subscribe`)).status).toBe(405);

    const events = (await call("GET", "/api/org/events")).body.events.map((event: { kind: string; title: string }) => [event.kind, event.title]);
    expect(events).toEqual([
      ["library.published", "“价格表” v1 published"],
      ["library.published", "“价格表” v2 published"],
    ]);
  });

  it("leaves paths it does not own to the server", async () => {
    expect((await call("GET", "/api/library/a/b/c")).handled).toBe(false);
    expect(isOrgApiPath("/api/org")).toBe(true);
    expect(isOrgApiPath("/api/org/decisions")).toBe(true);
    expect(isOrgApiPath("/api/brief")).toBe(true);
    expect(isOrgApiPath("/api/usage/summary")).toBe(true);
    expect(isOrgApiPath("/api/library/x/subscribe")).toBe(true);
    expect(isOrgApiPath("/api/usage")).toBe(false);
    expect(isOrgApiPath("/api/organization")).toBe(false);
  });
});
