import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_ORG_RULES, DEPARTMENT_COLORS } from "../../shared/org-types.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { DEFAULT_DECISION_RIGHTS, mergeDepartments, OrgConfigError, OrgConfigStore, parseStoredOrg, resolveChief } from "./config.ts";
import type { OrgBot } from "./util.ts";

const bot = (id: string, extra: Partial<OrgBot> = {}): OrgBot => ({ id, name: id, threadId: `t-${id}`, createdAt: 1, ...extra });

const TEAM: OrgBot[] = [
  bot("chief", { chiefOfStaff: true, createdAt: 1 }),
  bot("market-lead", { section: "市场部", chiefOfStaff: true, createdAt: 2 }),
  bot("market-1", { section: "市场部", createdAt: 3 }),
  bot("content-lead", { section: "内容部", chiefOfStaff: true, createdAt: 4 }),
  bot("archived", { section: "旧部门", hidden: true, createdAt: 5 }),
  bot("design", { section: " 设计部 ", createdAt: 6 }),
];

describe("org config", () => {
  let dir: string;
  let store: OrgConfigStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-org-config-"));
    store = new OrgConfigStore(dir);
  });
  afterEach(async () => {
    await removeTempDir(dir);
  });

  it("starts from the defaults: the eight decision rows of U6 with external publishing locked", () => {
    const org = store.get([]);
    expect(org.version).toBe(1);
    expect(org.rules).toEqual(DEFAULT_ORG_RULES);
    expect(org.decisionRights.map((right) => right.id)).toEqual(DEFAULT_DECISION_RIGHTS.map((right) => right.id));
    expect(org.decisionRights).toHaveLength(8);
    const locked = org.decisionRights.filter((right) => right.locked);
    expect(locked.map((right) => right.id)).toEqual(["external-publish"]);
    expect(locked[0]!.decides).toBe("owner");
    expect(org.decisionRights[0]).toEqual({ id: "own-task", label: "How to do their own task", decides: "employee", suggest: [] });
    expect(org.decisionRights[3]!.suggest).toEqual(["employee", "lead"]);
  });

  it("makes every section a visible bot carries a department, oldest first, palette colours in order", () => {
    const org = store.get(TEAM);
    expect(org.departments).toEqual([
      { section: "市场部", color: DEPARTMENT_COLORS[0] },
      { section: "内容部", color: DEPARTMENT_COLORS[1] },
      { section: "设计部", color: DEPARTMENT_COLORS[2] },
    ]);
  });

  it("defaults the chief to the unsectioned chief of staff, and keeps a configured one", () => {
    expect(store.get(TEAM).chiefBotId).toBe("chief");
    expect(store.get(TEAM.filter((entry) => entry.id !== "chief")).chiefBotId).toBeNull();
    const org = store.patch({ chiefBotId: "content-lead" }, TEAM);
    expect(org.chiefBotId).toBe("content-lead");
    // the chief's section is not a department of its own when nobody else is in it
    expect(org.departments.map((dep) => dep.section)).toEqual(["市场部", "设计部"]);
    // a configured chief that disappears falls back to the default again
    expect(store.get(TEAM.filter((entry) => entry.id !== "content-lead")).chiefBotId).toBe("chief");
  });

  it("refuses a chief that is not a visible bot", () => {
    expect(() => store.patch({ chiefBotId: "nobody" }, TEAM)).toThrow(OrgConfigError);
    expect(() => store.patch({ chiefBotId: "archived" }, TEAM)).toThrow(OrgConfigError);
    expect(store.patch({ chiefBotId: null }, TEAM).chiefBotId).toBe("chief");
  });

  it("merges stored department settings, keeps stored order, and appends new sections after them", () => {
    const org = store.patch(
      { departments: [{ section: "内容部", color: "#123456", headcount: 3, budgetPerDay: 10 }, { section: "新部门", isolated: true }] },
      TEAM,
    );
    expect(org.departments).toEqual([
      { section: "内容部", color: "#123456", headcount: 3, budgetPerDay: 10 },
      // a department without bots stays (it was just created on the org page),
      // with the first palette colour no other department shows
      { section: "新部门", isolated: true, color: DEPARTMENT_COLORS[3] },
      { section: "市场部", color: DEPARTMENT_COLORS[2] },
      // its positional colour is taken by a stored department: the first free one
      { section: "设计部", color: DEPARTMENT_COLORS[0] },
    ]);
  });

  it("keeps the colour a department was shown with when a patch leaves it out", () => {
    const shown = store.get(TEAM).departments.find((dep) => dep.section === "设计部")!.color;
    const org = store.patch({ departments: [{ section: "设计部", headcount: 4 }] }, TEAM);
    expect(org.departments[0]).toEqual({ section: "设计部", headcount: 4, color: shown });
  });

  it("merges rules field by field and never lets external publishing be switched off", () => {
    const org = store.patch(
      { rules: { spanOfControl: 7, chiefMay: { switchModel: true }, reportCadence: { dailyBriefAt: "17:30" }, externalPublishNeedsOwner: false } },
      TEAM,
    );
    expect(org.rules.spanOfControl).toBe(7);
    expect(org.rules.chiefMay).toEqual({ addPeople: true, newSpecialist: true, switchModel: true });
    expect(org.rules.reportCadence).toEqual({ ...DEFAULT_ORG_RULES.reportCadence, dailyBriefAt: "17:30" });
    expect(org.rules.externalPublishNeedsOwner).toBe(true);
    expect(org.rules.escalateAfterMin).toBe(DEFAULT_ORG_RULES.escalateAfterMin);
  });

  it("keeps locked decision rows exactly as they were, even when a patch edits or drops them", () => {
    const edited = DEFAULT_DECISION_RIGHTS.map((right) =>
      right.id === "external-publish" ? { ...right, decides: "chief" as const, locked: false, label: "x" } : right,
    );
    expect(store.patch({ decisionRights: edited }, TEAM).decisionRights.find((right) => right.id === "external-publish")).toEqual(
      DEFAULT_DECISION_RIGHTS.find((right) => right.id === "external-publish"),
    );
    const dropped = store.patch({ decisionRights: DEFAULT_DECISION_RIGHTS.filter((right) => right.id !== "external-publish") }, TEAM);
    expect(dropped.decisionRights.map((right) => right.id)).toEqual(DEFAULT_DECISION_RIGHTS.map((right) => right.id));
  });

  it("lets the owner edit unlocked rows and normalizes who may suggest", () => {
    const org = store.patch(
      { decisionRights: [{ id: "own-task", label: "Own work", decides: "lead", suggest: ["owner", "lead", "employee", "employee"] }] },
      TEAM,
    );
    expect(org.decisionRights[0]).toEqual({ id: "own-task", label: "Own work", decides: "lead", suggest: ["employee", "owner"] });
    // the locked row is still there
    expect(org.decisionRights.some((right) => right.id === "external-publish" && right.locked)).toBe(true);
  });

  it("rejects invalid patches with the field that failed", () => {
    expect(() => store.patch({ rules: { spanOfControl: 0 } }, TEAM)).toThrow(/rules\.spanOfControl/);
    expect(() => store.patch({ departments: [{ section: "", color: "#fff" }] }, TEAM)).toThrow(/departments\.0/);
    expect(() => store.patch({ departments: [{ section: "a", color: "blue" }] }, TEAM)).toThrow(OrgConfigError);
    expect(() => store.patch({ decisionRights: [{ id: "x", label: "y", decides: "boss" }] }, TEAM)).toThrow(/decisionRights\.0/);
    expect(() => store.patch({ rules: { reportCadence: { dailyBriefAt: "25:00" } } }, TEAM)).toThrow(OrgConfigError);
  });

  it("ignores the read-only fields a client sends back and clears optional fields given as null", () => {
    store.patch({ departments: [{ section: "市场部", color: "#111111", headcount: 5 }] }, TEAM);
    const org = store.patch(
      { version: 1, updatedAt: 5, departments: [{ section: "市场部", color: "#111111", headcount: null }] } as never,
      TEAM,
    );
    expect(org.departments[0]).toEqual({ section: "市场部", color: "#111111" });
    expect(org.updatedAt).toBeGreaterThan(5);
  });

  it("gives projects an id and keeps them across reloads", () => {
    const org = store.patch({ projects: [{ name: "落地页专项", leadBotId: "market-lead", memberBotIds: ["market-1"], until: "2026-10-23" }] }, TEAM);
    expect(org.projects).toHaveLength(1);
    expect(org.projects[0]!.id).toMatch(/^project-/);
    const reloaded = new OrgConfigStore(dir).get(TEAM);
    expect(reloaded.projects).toEqual(org.projects);
    expect(reloaded.updatedAt).toBe(org.updatedAt);
  });

  it("persists to org.json privately and reads a damaged file field by field", () => {
    store.patch({ rules: { budgetPerDay: 80 } }, TEAM);
    const stored = JSON.parse(readFileSync(join(dir, "org.json"), "utf8"));
    expect(stored.rules.budgetPerDay).toBe(80);
    if (process.platform !== "win32") expect(statSync(join(dir, "org.json")).mode & 0o777).toBe(0o600);

    writeFileSync(
      join(dir, "org.json"),
      JSON.stringify({ rules: { budgetPerDay: "lots", escalateAfterMin: 20 }, departments: [{ section: "市场部", color: "#222222" }, { nope: 1 }], decisionRights: "x" }),
    );
    const damaged = new OrgConfigStore(dir).get(TEAM);
    expect(damaged.rules.budgetPerDay).toBe(DEFAULT_ORG_RULES.budgetPerDay);
    expect(damaged.rules.escalateAfterMin).toBe(20);
    expect(damaged.departments[0]).toEqual({ section: "市场部", color: "#222222" });
    expect(damaged.decisionRights).toHaveLength(8);

    writeFileSync(join(dir, "org.json"), "{ not json");
    expect(new OrgConfigStore(dir).get(TEAM).rules).toEqual(DEFAULT_ORG_RULES);
  });

  it("restores the locked rows into a stored table that lost them", () => {
    const parsed = parseStoredOrg({ decisionRights: [{ id: "own-task", label: "Own", decides: "employee", suggest: [] }] });
    expect(parsed.decisionRights.map((right) => right.id)).toEqual(["own-task", "external-publish"]);
  });
});

describe("helpers", () => {
  it("resolveChief prefers the configured visible bot", () => {
    expect(resolveChief("market-lead", TEAM)?.id).toBe("market-lead");
    expect(resolveChief("archived", TEAM)?.id).toBe("chief");
  });

  it("mergeDepartments leaves the chief and hidden bots out of the sections", () => {
    expect(mergeDepartments([], TEAM, "market-lead").map((dep) => dep.section)).toEqual(["市场部", "内容部", "设计部"]);
    expect(mergeDepartments([], [bot("solo", { section: "独立", chiefOfStaff: true })], "solo")).toEqual([]);
  });
});
