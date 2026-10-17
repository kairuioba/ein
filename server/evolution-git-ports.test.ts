// Tests for the real git/file-system ports. Every repository here is created
// fresh under os.tmpdir(); the actual worktree /Users/kairuiwang/ein-work/next
// (or any other real checkout) is never opened, modified, merged or reverted.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildGitExecPorts, TEST_LOG_LIMIT_BYTES } from "./evolution-git-ports.ts";
import type { GitExecPortOptions } from "./evolution-git-ports.ts";
import type { ExecPorts, ExecWorktree } from "./evolution-executor.ts";
import type { EvolutionItem } from "./evolution.ts";

/** Run git synchronously in a throwaway repo (setup only). */
function git(cwd: string, ...args: string[]): string {
  return String(execFileSync("git", args, { cwd })).trim();
}

/** A command line that runs the current node binary with `script`. */
function nodeCommand(script: string): string {
  return `"${process.execPath}" -e "${script}"`;
}

describe("git exec ports", () => {
  let root: string;
  let worktreeRoot: string;
  let createdWorktrees: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ein-git-ports-repo-"));
    worktreeRoot = mkdtempSync(join(tmpdir(), "ein-git-ports-wt-"));
    createdWorktrees = [];
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "test@example.invalid");
    git(root, "config", "user.name", "Ports Test");
    writeFileSync(join(root, "README.md"), "base\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "base");
  });

  afterEach(() => {
    for (const dir of createdWorktrees) rmSync(dir, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  const baseSha = (): string => git(root, "rev-parse", "HEAD");

  function makePorts(overrides: Partial<Omit<GitExecPortOptions, "repoRoot" | "worktreeRoot">> = {}): ExecPorts {
    return buildGitExecPorts({ repoRoot: root, worktreeRoot, log: () => {}, ...overrides });
  }

  async function createWorktree(ports: ExecPorts, sha = baseSha()): Promise<ExecWorktree> {
    const worktree = await ports.createWorktree(sha);
    createdWorktrees.push(worktree.dir);
    return worktree;
  }

  /** Write and commit one docs/ file inside a worktree. */
  async function commitDocsFile(ports: ExecPorts, dir: string, name: string, body: string): Promise<string> {
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", name), body);
    const { sha } = await ports.commit(dir, "chore(test): add a doc");
    return sha;
  }

  it("creates a worktree on a fresh evo branch at the base commit", async () => {
    const base = baseSha();
    const ports = makePorts();
    const worktree = await createWorktree(ports, base);

    expect(existsSync(worktree.dir)).toBe(true);
    expect(worktree.branch).toMatch(/^evo\/[0-9a-f]{8}$/);
    expect(git(worktree.dir, "rev-parse", "HEAD")).toBe(base);
    expect(git(worktree.dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(worktree.branch);
    expect(git(root, "worktree", "list", "--porcelain")).toContain(worktree.dir);
  });

  it("rejects a missing or invalid base sha before creating anything", async () => {
    const ports = makePorts();
    await expect(ports.createWorktree("")).rejects.toThrow(/invalid sha/);
    await expect(ports.createWorktree("not-a-sha")).rejects.toThrow(/invalid sha/);
    await expect(ports.createWorktree("deadbeef")).rejects.toThrow(/does not resolve to a commit/);
  });

  it("commits the code-owned message and returns the new head sha", async () => {
    const base = baseSha();
    const ports = makePorts();
    const worktree = await createWorktree(ports, base);

    mkdirSync(join(worktree.dir, "docs"), { recursive: true });
    writeFileSync(join(worktree.dir, "docs", "note.md"), "hello\n");
    const { sha } = await ports.commit(worktree.dir, "chore(evolution): apply accepted improvement p-1");

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(sha).not.toBe(base);
    expect(git(worktree.dir, "rev-parse", "HEAD")).toBe(sha);
    expect(git(worktree.dir, "log", "-1", "--format=%s")).toBe(
      "chore(evolution): apply accepted improvement p-1",
    );
  });

  it("reads committed changes as a diff and returns nothing before the commit", async () => {
    const ports = makePorts();
    const worktree = await createWorktree(ports);
    expect(await ports.readDiff(worktree.dir, baseSha())).toBe("");

    const sha = await commitDocsFile(ports, worktree.dir, "note.md", "hello\n");
    const diff = await ports.readDiff(worktree.dir, baseSha());

    expect(diff).toContain("diff --git a/docs/note.md b/docs/note.md");
    expect(diff).toContain("+hello");
    expect(sha).not.toBe(baseSha());
  });

  it("merges only when the approved head sha matches the branch", async () => {
    const base = baseSha();
    const ports = makePorts();
    const worktree = await createWorktree(ports, base);
    const sha = await commitDocsFile(ports, worktree.dir, "merged.md", "merged\n");

    expect(await ports.merge(worktree.branch, base)).toEqual({ ok: false, ref: "" });
    expect(await ports.merge("evo/does-not-exist", sha)).toEqual({ ok: false, ref: "" });
    expect(git(root, "rev-parse", "HEAD")).toBe(base);

    const merged = await ports.merge(worktree.branch, sha);
    expect(merged).toEqual({ ok: true, ref: sha });
    expect(git(root, "rev-parse", "HEAD")).toBe(sha);
    expect(existsSync(join(root, "docs", "merged.md"))).toBe(true);
  });

  it("reverts a merged commit in the main checkout", async () => {
    const ports = makePorts();
    const worktree = await createWorktree(ports);
    const sha = await commitDocsFile(ports, worktree.dir, "revert-me.md", "revert me\n");
    const merged = await ports.merge(worktree.branch, sha);
    expect(merged.ok).toBe(true);

    expect(await ports.revert(merged.ref)).toEqual({ ok: true });
    expect(existsSync(join(root, "docs", "revert-me.md"))).toBe(false);
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("removes the worktree directory and its registration", async () => {
    const messages: string[] = [];
    const ports = makePorts({ log: (message) => messages.push(message) });
    const worktree = await createWorktree(ports);

    await ports.removeWorktree(worktree.dir);
    expect(existsSync(worktree.dir)).toBe(false);
    expect(git(root, "worktree", "list", "--porcelain")).not.toContain(worktree.dir);

    // Removing an already-removed worktree only logs; it must not throw.
    await expect(ports.removeWorktree(worktree.dir)).resolves.toBeUndefined();
    expect(messages.length).toBeGreaterThan(0);
  });

  it("hashes protected files in the main checkout and throws for missing paths", async () => {
    writeFileSync(join(root, "protected.txt"), "protected\n");
    const ports = makePorts();
    const expected = createHash("sha256").update("protected\n").digest("hex");

    expect(await ports.sha256File("protected.txt")).toBe(expected);
    await expect(ports.sha256File("missing.txt")).rejects.toThrow();
    await expect(ports.sha256File("../outside.txt")).rejects.toThrow(/escapes the repo/);
  });

  it("runs the fixed test table and reports ok/log", async () => {
    const okCommand = nodeCommand("console.log('all good'); process.exit(0)");
    const failCommand = nodeCommand("console.error('boom'); process.exit(3)");
    const ports = makePorts({ testCommands: [okCommand] });
    const worktree = await createWorktree(ports);

    const passed = await ports.runTests(worktree.dir);
    expect(passed.ok).toBe(true);
    expect(passed.log).toContain("all good");

    const failed = await ports.runTests(worktree.dir, [failCommand]);
    expect(failed.ok).toBe(false);
    expect(failed.log).toContain("boom");
    expect(failed.log).toContain("exit code 3");
  });

  it("truncates the test log at 20 KB", async () => {
    const bigCommand = nodeCommand("process.stdout.write('x'.repeat(40000))");
    const ports = makePorts();
    const worktree = await createWorktree(ports);

    const result = await ports.runTests(worktree.dir, [bigCommand]);
    expect(result.ok).toBe(true);
    expect(result.log).toContain("[truncated]");
    expect(Buffer.byteLength(result.log, "utf8")).toBeLessThan(TEST_LOG_LIMIT_BYTES + 64);
  });

  it("keeps Chinese file names literal in the diff (quotePath off)", async () => {
    const ports = makePorts();
    const worktree = await createWorktree(ports);
    await commitDocsFile(ports, worktree.dir, "中文说明.md", "内容\n");

    const diff = await ports.readDiff(worktree.dir, baseSha());
    expect(diff).toContain("docs/中文说明.md");
    expect(diff).not.toContain("\\344");
  });

  it("defaults proposeChange to an honest error and lets the Lead override it", async () => {
    const ports = makePorts();
    const worktree = await createWorktree(ports);
    const input = { dir: worktree.dir, proposal: {} as EvolutionItem, baseSha: baseSha() };

    expect(await ports.proposeChange(input)).toEqual({ error: "no implementer wired" });

    const injected = makePorts({ proposeChange: async () => ({ headSha: "f".repeat(40) }) });
    expect(await injected.proposeChange(input)).toEqual({ headSha: "f".repeat(40) });
  });

  it("rejects a relative repoRoot at construction time", () => {
    expect(() => buildGitExecPorts({ repoRoot: "relative/path" })).toThrow(/absolute repoRoot/);
  });
});
