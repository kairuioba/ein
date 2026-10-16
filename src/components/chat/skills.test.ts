import { describe, expect, it } from "vitest";

import { filterSkills, skillInstruction, slashQueryAt } from "./skills";

describe("slashQueryAt", () => {
  it("opens on a slash that starts a word", () => {
    expect(slashQueryAt("/", 1)).toEqual({ start: 0, query: "" });
    expect(slashQueryAt("please /rev", 11)).toEqual({ start: 7, query: "rev" });
    expect(slashQueryAt("use /code-review now", 16)).toEqual({ start: 4, query: "code-review" });
  });

  it("stays shut inside paths, URLs and after the word ends", () => {
    expect(slashQueryAt("src/lib", 7)).toBeNull();
    expect(slashQueryAt("see /Users/me", 13)).toBeNull();
    expect(slashQueryAt("/review then", 12)).toBeNull();
    expect(slashQueryAt("no slash", 8)).toBeNull();
  });
});

describe("filterSkills", () => {
  const skills = [
    { botId: "a", botName: "A", name: "code-review", description: "Review a pull request" },
    { botId: "a", botName: "A", name: "release-notes", description: "Write notes for a review" },
    { botId: "b", botName: "B", name: "expense", description: "File an expense" },
  ];

  it("ranks name prefixes first, then name or description matches", () => {
    expect(filterSkills(skills, "re").map((skill) => skill.name)).toEqual(["release-notes", "code-review"]);
    expect(filterSkills(skills, "expense").map((skill) => skill.name)).toEqual(["expense"]);
    expect(filterSkills(skills, "")).toHaveLength(3);
  });
});

describe("skillInstruction", () => {
  it("names the skill in a plain instruction", () => {
    expect(skillInstruction("code-review")).toBe("Use the “code-review” skill: ");
  });
});
