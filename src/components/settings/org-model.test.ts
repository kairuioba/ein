import { describe, expect, it } from "vitest";

import { DEFAULT_ORG_RULES, type OrgConfig, type OrgDepartment } from "../../../shared/org-types";
import { buildDepartments } from "@/lib/org";
import {
  DEFAULT_DECISION_RIGHTS,
  chiefReserve,
  decisionRightsOf,
  departmentCard,
  matrixCell,
  membershipPatches,
  newProject,
  nextDepartmentColor,
  projectHomeSection,
  renameDepartment,
  rulesOf,
  setDecider,
  spanExample,
  upsertDepartment,
} from "./org-model";

type B = { id: string; name: string; section?: string; chiefOfStaff?: boolean; hidden?: boolean; createdAt?: number };

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function org(patch: Partial<OrgConfig> = {}): OrgConfig {
  return { version: 1, chiefBotId: null, departments: [], projects: [], rules: DEFAULT_ORG_RULES, decisionRights: [], updatedAt: 0, ...patch };
}

describe("decision rights", () => {
  it("falls back to the default table while the org has none", () => {
    const rights = decisionRightsOf(org());
    expect(rights.map((right) => right.id)).toEqual(DEFAULT_DECISION_RIGHTS.map((right) => right.id));
    expect(rights.find((right) => right.id === "publish")).toMatchObject({ decides: "owner", locked: true });
  });

  it("uses the org's own table when it has one", () => {
    const own = [{ id: "x", label: "X", decides: "lead" as const, suggest: ["employee" as const] }];
    expect(decisionRightsOf(org({ decisionRights: own }))).toEqual(own);
  });

  it("moves the decider and lets every level below suggest", () => {
    const rights = setDecider(decisionRightsOf(org()), "own-task", "chief");
    const row = rights.find((right) => right.id === "own-task")!;
    expect(row.decides).toBe("chief");
    expect(row.suggest).toEqual(["employee", "lead"]);
    expect(matrixCell(row, "chief")).toBe("decides");
    expect(matrixCell(row, "lead")).toBe("suggests");
    expect(matrixCell(row, "owner")).toBe("none");
  });

  it("never changes a locked row", () => {
    const before = decisionRightsOf(org());
    const after = setDecider(before, "publish", "employee");
    expect(after.find((right) => right.id === "publish")).toEqual(before.find((right) => right.id === "publish"));
  });
});

describe("rulesOf", () => {
  it("fills missing fields from the defaults and keeps external publishing locked", () => {
    const partial = { rules: { spanOfControl: 7, chiefMay: { addPeople: false } } } as unknown as OrgConfig;
    const rules = rulesOf(partial);
    expect(rules.spanOfControl).toBe(7);
    expect(rules.chiefMay).toEqual({ addPeople: false, newSpecialist: true, switchModel: false });
    expect(rules.reportCadence.dailyBriefAt).toBe("18:00");
    expect(rules.externalPublishNeedsOwner).toBe(true);
  });
});

describe("department cards", () => {
  const tech: B[] = [
    // the main bot: an unsectioned chief of staff, outside every department
    { id: "main", name: "总控", chiefOfStaff: true, createdAt: 0 },
    { id: "lead", name: "阿杰", section: "技术部", chiefOfStaff: true, createdAt: 1 },
    ...[1, 2, 3, 4].map((n) => ({ id: `a${n}`, name: `前端 ${n}`, section: "技术部", createdAt: 10 + n })),
    ...[1, 2, 3, 4].map((n) => ({ id: `b${n}`, name: `专员 ${n}`, section: "技术部", createdAt: NOW - DAY / 2 + n })),
  ];

  it("counts the lead, applies the headcount and splits big departments into squads", () => {
    const view = buildDepartments(tech, org({ departments: [{ section: "技术部", color: "#F59E0B", headcount: 12, budgetPerDay: 22 }] }))[0]!;
    const card = departmentCard(view, 5, NOW);
    expect(card.count).toBe(9);
    expect(card.headcount).toBe(12);
    expect(card.overHeadcount).toBe(false);
    expect(card.squads.map((squad) => [squad.index, squad.size, squad.isNew])).toEqual([
      [0, 4, false],
      [1, 4, true],
    ]);
    expect(card.budgetPerDay).toBe(22);
  });

  it("does not split a department within the span", () => {
    const small = buildDepartments(tech.slice(0, 4), org())[0]!;
    expect(departmentCard(small, 5, NOW).squads).toEqual([]);
  });

  it("flags a department over its headcount", () => {
    const view = buildDepartments(tech, org({ departments: [{ section: "技术部", color: "#F59E0B", headcount: 5 }] }))[0]!;
    expect(departmentCard(view, 5, NOW).overHeadcount).toBe(true);
  });

  it("explains the span rule with the biggest grouped department", () => {
    const view = buildDepartments(tech, org())[0]!;
    const example = spanExample([departmentCard(view, 5, NOW)], 5);
    expect(example).toEqual({ section: "技术部", count: 9, lead: "阿杰", firstSquad: 4, otherSquads: 1, direct: 5 });
    expect(spanExample([departmentCard(buildDepartments(tech.slice(0, 3), org())[0]!, 5, NOW)], 5)).toBeNull();
  });
});

describe("budget and colours", () => {
  it("keeps for the chief what the departments do not take", () => {
    expect(chiefReserve({ budgetPerDay: 60 }, [{ budgetPerDay: 8 }, { budgetPerDay: 10 }, {}])).toBe(42);
    expect(chiefReserve({ budgetPerDay: 10 }, [{ budgetPerDay: 30 }])).toBe(0);
  });

  it("hands a new department the first unused palette colour", () => {
    expect(nextDepartmentColor([{ color: "#0ea5e9" }])).toBe("#65A30D");
  });
});

describe("department edits", () => {
  const deps: OrgDepartment[] = [
    { section: "市场部", color: "#0EA5E9", budgetPerDay: 8 },
    { section: "内容部", color: "#65A30D" },
  ];

  it("replaces a department by section name or appends a new one", () => {
    expect(upsertDepartment(deps, { section: " 市场部 ", color: "#000000" })).toEqual([{ section: "市场部", color: "#000000" }, deps[1]]);
    expect(upsertDepartment(deps, { section: "设计部", color: "#EC4899" })).toHaveLength(3);
  });

  it("carries settings over a rename", () => {
    expect(renameDepartment(deps, "市场部", "增长部")[0]).toEqual({ section: "增长部", color: "#0EA5E9", budgetPerDay: 8 });
  });

  it("moves exactly the bots whose membership changes", () => {
    const bots: B[] = [
      { id: "1", name: "a", section: "市场部" },
      { id: "2", name: "b", section: "内容部" },
      { id: "3", name: "c" },
      { id: "4", name: "d", section: "市场部" },
    ];
    expect(membershipPatches(bots, "市场部", ["1", "2", "3"])).toEqual([
      { botId: "2", section: "市场部" },
      { botId: "3", section: "市场部" },
      { botId: "4", section: null },
    ]);
  });
});

describe("projects", () => {
  it("makes a unique id and de-duplicates members", () => {
    const first = newProject({ name: "Landing page", memberBotIds: ["a", "a", "b"] }, []);
    expect(first).toEqual({ id: "landing-page", name: "Landing page", leadBotId: undefined, memberBotIds: ["a", "b"], until: undefined });
    expect(newProject({ name: "Landing page", memberBotIds: ["c"] }, [first]).id).toBe("landing-page-2");
    expect(newProject({ name: "落地页专项", memberBotIds: ["c"], until: "2026-10-23" }, []).id).toBe("落地页专项");
  });

  it("reports to its lead's department", () => {
    expect(projectHomeSection({ leadBotId: "x" }, [{ id: "x", section: " 技术部 " }])).toBe("技术部");
    expect(projectHomeSection({ leadBotId: "missing" }, [])).toBeUndefined();
  });
});
