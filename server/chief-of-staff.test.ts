import { describe, expect, it } from "vitest";

import { chiefOfStaffSystemPrompt } from "./chief-of-staff.ts";

describe("chiefOfStaffSystemPrompt roster caps", () => {
  it("clips oversized persona fields instead of interpolating them whole", () => {
    const prompt = chiefOfStaffSystemPrompt(
      "chief",
      [
        { id: "chief", name: "Atlas" },
        {
          id: "big",
          name: "N".repeat(500),
          title: "T".repeat(500),
          description: "D".repeat(10_000),
        },
      ],
      true,
    );
    // an imported 10KB description must not ride into the Chief's system
    // prompt — the roster line stays bounded
    const rosterLine = prompt.split("\n").find((line) => line.startsWith("- N"))!;
    expect(rosterLine.length).toBeLessThan(500);
    expect(rosterLine).toContain("…");
  });

  it("caps the roster length and says how many were left out", () => {
    const team = Array.from({ length: 60 }, (_, i) => ({ id: `bot${i}`, name: `Bot ${i}` }));
    const prompt = chiefOfStaffSystemPrompt("chief", [{ id: "chief", name: "Atlas" }, ...team], true);
    expect(prompt).toContain("Bot 39");
    expect(prompt).not.toContain("Bot 40 —");
    expect(prompt).toContain("…and 20 more");
  });
});

describe("chiefOfStaffSystemPrompt", () => {
  const bots = [
    { id: "chief", name: "Atlas", title: "Operations", section: "Work" },
    { id: "writer", name: "Quill", title: "Writer", description: "Drafts concise copy", section: "Work" },
    { id: "coder", name: "Patch", title: "Engineer", busy: true, section: "Work" },
    { id: "hidden", name: "Secret", hidden: true, section: "Work" },
    { id: "personal", name: "Scout", title: "Travel planner", section: "Personal" },
  ];

  it("describes visible teammates, roles, and availability", () => {
    const prompt = chiefOfStaffSystemPrompt("chief", bots, true);

    expect(prompt).toContain("Chief of Staff for the Work section");
    expect(prompt).toContain("Quill — Writer: Drafts concise copy (available)");
    expect(prompt).toContain("Patch — Engineer (working right now)");
    expect(prompt).not.toContain("Secret");
    expect(prompt).not.toContain("Scout");
    expect(prompt).not.toContain("Atlas —");
    expect(prompt).toContain("use delegate_bot");
    expect(prompt).toContain("keeps you available to the user");
    expect(prompt).toContain("delivers the teammate's completed result back into this conversation automatically");
    expect(prompt).toContain("Do not call wait_delegation");
    expect(prompt).toContain("Use ask_bot only for a brief consultation");
    expect(prompt).toContain("Never use ask_bot for an assigned task");
    expect(prompt).toContain("use create_bot");
  });

  it("does not promise delegation when the engine cannot mount agent tools", () => {
    const prompt = chiefOfStaffSystemPrompt("chief", bots, false);

    expect(prompt).toContain("cannot contact teammates");
    expect(prompt).not.toContain("delegate_bot");
  });

  it("tells the org's chief to plan through department leads", () => {
    const dispatch = {
      enabled: true,
      autoCreate: true,
      maxSubtasks: 30,
      departments: [
        { section: "技术部", leadName: "阿杰", leadTitle: "前端主管", people: 5 },
        { section: "市场部", leadName: "市场分析师", people: 3 },
      ],
    };
    const prompt = chiefOfStaffSystemPrompt("chief", bots, true, "", dispatch);
    expect(prompt).toContain("company's chief (主 Bot)");
    expect(prompt).toContain("- 技术部: lead 阿杰 — 前端主管 (5 people)");
    expect(prompt).toContain("- 市场部: lead 市场分析师 (3 people)");
    expect(prompt).toContain("give each department's part of the work to its lead");
    expect(prompt).toContain("at most 30 subtasks");
    expect(prompt).toContain("add_people");
    // a section chief's prompt is unchanged
    const section = chiefOfStaffSystemPrompt("chief", bots, true, "", { enabled: true, autoCreate: true, maxSubtasks: 8 });
    expect(section).toContain("Chief of Staff for the Work section");
    expect(section).not.toContain("department");
  });

  it("gives a lead doing the org chief's subtask submit_plan alone", () => {
    const prompt = chiefOfStaffSystemPrompt("chief", bots, true, "", { enabled: true, autoCreate: true, maxSubtasks: 8, planOnly: true });
    expect(prompt).toContain("call submit_plan once to hand it to your own section's team");
    expect(prompt).toContain("delegate_bot, ask_bot and create_bot are not available");
    expect(prompt).not.toContain("AUTOMATIC DISPATCH");
    expect(prompt).not.toContain("use create_bot");
    // its own team is still listed
    expect(prompt).toContain("Quill — Writer");
  });

  it("includes trusted OpenMaus status only when the Chief caller supplies it", () => {
    const status = "TRUSTED EIN STATUS\nfreshness=fresh; runtime_state=degraded";

    const chiefPrompt = chiefOfStaffSystemPrompt("chief", bots, true, status);
    const ordinaryPrompt = chiefOfStaffSystemPrompt("writer", bots, true);

    expect(chiefPrompt).toContain(status);
    expect(ordinaryPrompt).not.toContain("TRUSTED EIN STATUS");
  });
});
