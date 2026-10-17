// Tests for the stage-4 safety floor: path policy, diff scope, protected-file
// hashes and the approval rules. Everything here is pure data, so these tests
// need no filesystem, no git and no worktree.
import { describe, expect, it } from "vitest";

import {
  MAX_CHANGED_FILES,
  MAX_CHANGED_LINES,
  canApply,
  checkDiff,
  checkPath,
  checkProtectedUnchanged,
  hashProtected,
  normalizeRepoPath,
} from "./evolution-guard.ts";

/** A minimal git-style diff for one modified file. */
function modifyDiff(path: string, removed: readonly string[], added: readonly string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${removed.length} +1,${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    "",
  ].join("\n");
}

describe("normalizeRepoPath", () => {
  it("unifies separators and drops empty and '.' segments", () => {
    expect(normalizeRepoPath("./docs//collab\\notes.md")).toEqual({
      path: "docs/collab/notes.md",
      absolute: false,
      traversal: false,
    });
  });

  it("marks absolute, Windows-drive and traversal inputs", () => {
    expect(normalizeRepoPath("/docs/guide.md")).toMatchObject({ absolute: true });
    expect(normalizeRepoPath("C:\\repo\\docs\\guide.md")).toMatchObject({ absolute: true });
    expect(normalizeRepoPath("\\\\server\\share\\docs\\guide.md")).toMatchObject({ absolute: true });
    expect(normalizeRepoPath("docs/../server/dispatch.ts")).toMatchObject({ traversal: true });
  });
});

describe("checkPath", () => {
  it("allows files under prompts/, templates/ and docs/", () => {
    for (const path of [
      "prompts/planner.md",
      "templates/plan.md",
      "templates/中文模板.md",
      "docs/self-evolution-1.1.4.md",
      "docs/collab/notes.md",
    ]) {
      expect(checkPath(path)).toMatchObject({ allowed: true, path });
    }
  });

  it("normalizes './', duplicate separators and backslashes before deciding", () => {
    expect(checkPath("./docs/guide.md")).toMatchObject({ allowed: true, path: "docs/guide.md" });
    expect(checkPath("docs//collab///notes.md")).toMatchObject({
      allowed: true,
      path: "docs/collab/notes.md",
    });
    expect(checkPath("docs\\collab\\notes.md")).toMatchObject({
      allowed: true,
      path: "docs/collab/notes.md",
    });
  });

  it("rejects paths outside the three writable roots", () => {
    for (const path of ["README.md", "electron-builder.yml", "config/app.json", "docs"]) {
      const decision = checkPath(path);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toMatch(/not under prompts\//);
    }
  });

  it("rejects every always-forbidden root", () => {
    for (const path of [
      "server/evolution.ts",
      "src/main.tsx",
      "electron/main.mjs",
      ".github/workflows/release-ein.yml",
      "scripts/release.mjs",
    ]) {
      const decision = checkPath(path);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toMatch(/always-forbidden root/);
    }
  });

  it("rejects gate, lock and manifest files by name", () => {
    for (const path of [
      "package.json",
      "pnpm-lock.yaml",
      "server/dispatch.ts",
      "server/reviewer-port.ts",
      "server/permission-proxy.ts",
      "electron/secure-credentials.mjs",
    ]) {
      const decision = checkPath(path);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toMatch(/never writable/);
    }
  });

  it("forbids shared/ unless the exact path is allowlisted", () => {
    expect(checkPath("shared/i18n/zh-CN.json").allowed).toBe(false);
    expect(checkPath("shared/i18n/zh-CN.json").reason).toMatch(/shared\//);
    expect(checkPath("shared/i18n/zh-CN.json", { allowlist: ["shared/i18n/zh-CN.json"] })).toMatchObject({
      allowed: true,
      path: "shared/i18n/zh-CN.json",
    });
    expect(checkPath("shared/other.json", { allowlist: ["shared/i18n/zh-CN.json"] }).allowed).toBe(false);
  });

  it("never lets the allowlist reopen always-forbidden or gate paths", () => {
    for (const path of [
      "server/dispatch.ts",
      "server/evolution-guard.ts",
      "electron/secure-credentials.mjs",
      "package.json",
    ]) {
      const decision = checkPath(path, { allowlist: [path] });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toMatch(/never writable/);
    }
  });

  it("protects the guard module and its test file", () => {
    expect(checkPath("server/evolution-guard.ts").allowed).toBe(false);
    expect(checkPath("server/evolution-guard.test.ts").allowed).toBe(false);
  });

  it("rejects absolute paths", () => {
    for (const path of ["/docs/guide.md", "C:\\repo\\docs\\guide.md", "\\\\server\\share\\docs\\guide.md"]) {
      const decision = checkPath(path);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toMatch(/absolute paths are not allowed/);
    }
  });

  it("rejects directory traversal", () => {
    for (const path of ["docs/../server/dispatch.ts", "../docs/guide.md", "docs/../../etc/passwd", "docs/./../x"]) {
      const decision = checkPath(path);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toMatch(/traversal/);
    }
  });

  it("rejects .env files even inside a writable root", () => {
    for (const path of [".env", ".env.local", ".env.production", "docs/.env"]) {
      const decision = checkPath(path);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toMatch(/never writable/);
    }
  });

  it("rejects empty, directory-only and control-character paths", () => {
    for (const path of ["", "   ", "./", "docs/", "/"]) {
      expect(checkPath(path).allowed).toBe(false);
    }
    expect(checkPath("docs/\nux").reason).toMatch(/control character/);
  });
});

describe("checkDiff", () => {
  it("accepts a small diff entirely inside the writable roots", () => {
    const diff =
      modifyDiff("docs/guide.md", ["old line"], ["new line"]) +
      modifyDiff("prompts/planner.md", [], ["added line"]);
    expect(checkDiff(diff)).toMatchObject({
      ok: true,
      files: ["docs/guide.md", "prompts/planner.md"],
      fileCount: 2,
      addedLines: 2,
      removedLines: 1,
      violations: [],
    });
  });

  it("counts changed hunk lines, never the ---/+++ file headers", () => {
    const result = checkDiff(modifyDiff("docs/guide.md", ["one"], ["two"]));
    expect(result.ok).toBe(true);
    expect([result.addedLines, result.removedLines]).toEqual([1, 1]);
  });

  it("rejects a diff above the file limit", () => {
    const diff = Array.from({ length: MAX_CHANGED_FILES + 1 }, (_, index) =>
      modifyDiff(`docs/f${index}.md`, [], ["x"]),
    ).join("");
    const result = checkDiff(diff);
    expect(result.ok).toBe(false);
    expect(result.fileCount).toBe(MAX_CHANGED_FILES + 1);
    expect(result.files).toHaveLength(MAX_CHANGED_FILES + 1);
    expect(
      result.violations.some((v) => v.path === "<diff>" && v.reason.includes("touches 6 files")),
    ).toBe(true);
  });

  it("rejects a diff above the changed-line limit", () => {
    const removed = Array.from({ length: 100 }, (_, index) => `old ${index}`);
    const added = Array.from({ length: 51 }, (_, index) => `new ${index}`);
    const result = checkDiff(modifyDiff("docs/guide.md", removed, added));
    expect(result.addedLines).toBe(51);
    expect(result.removedLines).toBe(100);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.reason.includes("changes 151 lines"))).toBe(true);
  });

  it("treats both limits as inclusive", () => {
    const removed = (count: number) => Array.from({ length: count }, (_, index) => `old ${index}`);
    const diff =
      modifyDiff("docs/a.md", removed(50), []) +
      modifyDiff("docs/b.md", removed(50), []) +
      modifyDiff("docs/c.md", removed(49), ["plus one"]);
    const result = checkDiff(diff);
    expect(result.ok).toBe(true);
    expect(result.fileCount).toBe(3);
    expect(result.addedLines + result.removedLines).toBe(MAX_CHANGED_LINES);
  });

  it("rejects a diff that touches a forbidden path", () => {
    const diff = modifyDiff("docs/guide.md", [], ["ok"]) + modifyDiff("server/dispatch.ts", [], ["sneaky"]);
    const result = checkDiff(diff);
    expect(result.ok).toBe(false);
    expect(result.violations.map((violation) => violation.path)).toContain("server/dispatch.ts");
    expect(result.violations.map((violation) => violation.path)).not.toContain("docs/guide.md");
  });

  it("rejects a rename whose source is a protected path", () => {
    const diff = [
      "diff --git a/server/dispatch.ts b/docs/dispatch.md",
      "similarity index 100%",
      "rename from server/dispatch.ts",
      "rename to docs/dispatch.md",
      "",
    ].join("\n");
    const result = checkDiff(diff);
    expect(result.ok).toBe(false);
    expect(result.files).toEqual(["docs/dispatch.md"]);
    expect(result.violations.map((violation) => violation.path)).toContain("server/dispatch.ts");
  });

  it("accepts an added file behind /dev/null", () => {
    const diff = [
      "diff --git a/docs/new.md b/docs/new.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/docs/new.md",
      "@@ -0,0 +1,2 @@",
      "+one",
      "+two",
      "",
    ].join("\n");
    expect(checkDiff(diff)).toMatchObject({
      ok: true,
      files: ["docs/new.md"],
      addedLines: 2,
      removedLines: 0,
    });
  });

  it("accepts a deleted file behind /dev/null", () => {
    const diff = [
      "diff --git a/docs/old.md b/docs/old.md",
      "deleted file mode 100644",
      "--- a/docs/old.md",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
      "",
    ].join("\n");
    expect(checkDiff(diff)).toMatchObject({
      ok: true,
      files: ["docs/old.md"],
      addedLines: 0,
      removedLines: 1,
    });
  });

  it("fails closed on a diff without file headers", () => {
    for (const input of ["", "just some text\n", "@@ -1 +1 @@\n-a\n+b\n"]) {
      const result = checkDiff(input);
      expect(result.ok).toBe(false);
      expect(result.violations.some((v) => v.reason.includes("no 'diff --git' headers"))).toBe(true);
    }
  });

  it("fails closed on a quoted diff header instead of guessing the path", () => {
    const diff = [
      'diff --git "a/docs/\\344\\270\\255.md" "b/docs/\\344\\270\\255.md"',
      "--- /dev/null",
      '+++ "b/docs/\\344\\270\\255.md"',
      "@@ -0,0 +1 @@",
      "+x",
      "",
    ].join("\n");
    const result = checkDiff(diff);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.reason.includes("quoted or malformed"))).toBe(true);
  });
});

describe("hashProtected", () => {
  it("sha256-hashes protected file contents", () => {
    expect(hashProtected({ "a.md": "hello", "b/c.md": "world" })).toEqual({
      "a.md": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      "b/c.md": "486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7",
    });
  });

  it("sorts keys so equal snapshots are byte-identical", () => {
    expect(Object.keys(hashProtected({ "z.md": "1", "a.md": "2" }))).toEqual(["a.md", "z.md"]);
  });

  it("hashes an empty snapshot to an empty map", () => {
    expect(hashProtected({})).toEqual({});
  });
});

describe("checkProtectedUnchanged", () => {
  it("reports equal snapshots as unchanged", () => {
    const before = hashProtected({ "server/evolution-guard.ts": "v1", "server/dispatch.ts": "gate" });
    const after = hashProtected({ "server/dispatch.ts": "gate", "server/evolution-guard.ts": "v1" });
    expect(checkProtectedUnchanged(before, after)).toEqual({ ok: true, changed: [] });
  });

  it("reports rewrites, removals and additions", () => {
    const before = hashProtected({ "a.ts": "one", "b.ts": "two" });
    const after = hashProtected({ "a.ts": "one!", "c.ts": "three" });
    expect(checkProtectedUnchanged(before, after)).toEqual({
      ok: false,
      changed: ["a.ts", "b.ts", "c.ts"],
    });
  });
});

describe("canApply", () => {
  const accepted = {
    proposalStatus: "accepted",
    kind: "prompt_patch",
    approvedBy: "owner",
    hasRollback: true,
    testsPassed: true,
  } as const;

  it("accepts a fully approved data-level proposal", () => {
    expect(canApply(accepted)).toEqual({ ok: true, reasons: [] });
  });

  it("accepts plan_template and config proposals", () => {
    expect(canApply({ ...accepted, kind: "plan_template" }).ok).toBe(true);
    expect(canApply({ ...accepted, kind: "config" }).ok).toBe(true);
  });

  it("refuses a proposal that is not accepted", () => {
    for (const proposalStatus of ["open", "rejected", "deferred"]) {
      const decision = canApply({ ...accepted, proposalStatus });
      expect(decision.ok).toBe(false);
      expect(decision.reasons.join(" ")).toMatch(/only 'accepted'/);
    }
  });

  it("refuses an unknown proposal kind", () => {
    const decision = canApply({ ...accepted, kind: "ui" });
    expect(decision.ok).toBe(false);
    expect(decision.reasons.join(" ")).toMatch(/not an applicable proposal kind/);
  });

  it("keeps code_task behind the stage-4 switch", () => {
    const blocked = canApply({ ...accepted, kind: "code_task" });
    expect(blocked.ok).toBe(false);
    expect(blocked.reasons.join(" ")).toMatch(/stage-4 code-task switch/);
    expect(canApply({ ...accepted, kind: "code_task", codeTasksEnabled: true })).toEqual({
      ok: true,
      reasons: [],
    });
  });

  it("only accepts the owner as approver", () => {
    for (const approvedBy of ["agent", "reviewer", "Owner", " owner "]) {
      const decision = canApply({ ...accepted, approvedBy });
      expect(decision.ok).toBe(false);
      expect(decision.reasons.join(" ")).toMatch(/only the owner/);
    }
  });

  it("requires a rollback path", () => {
    const decision = canApply({ ...accepted, hasRollback: false });
    expect(decision.ok).toBe(false);
    expect(decision.reasons.join(" ")).toMatch(/rollback path/);
  });

  it("requires green tests", () => {
    const decision = canApply({ ...accepted, testsPassed: false });
    expect(decision.ok).toBe(false);
    expect(decision.reasons.join(" ")).toMatch(/tests have not passed/);
  });

  it("returns every failing rule at once", () => {
    const decision = canApply({
      proposalStatus: "open",
      kind: "ui",
      approvedBy: "agent",
      hasRollback: false,
      testsPassed: false,
    });
    expect(decision.ok).toBe(false);
    expect(decision.reasons).toHaveLength(5);
  });
});
