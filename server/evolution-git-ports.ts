// Self-evolution · stage 4: the real git/file-system implementation of the
// executor's ports (ExecPorts in server/evolution-executor.ts).
//
// The executor owns the safety model — accepted proposal, guard diff limits,
// protected-file hashes, green tests, independent review, and the owner's
// approve-merge click. This module owns only the mechanics those rules run on,
// so it is deliberately dumb and blunt:
//   · every git command runs against an explicit -C <dir>; the main checkout is
//     only merged/reverted in after approveAndMerge(), never by this module;
//   · base shas and branch names are validated before they reach git argv;
//   · a worktree lives under os.tmpdir() (or a caller-supplied root) and its
//     branch is a fresh evo/<random> name;
//   · test commands come from the executor's fixed table only, are tokenized
//     here (no shell), and their combined log is cut at 20 KB;
//   · proposeChange is NOT wired to a model: the default implementation returns
//     { error: "no implementer wired" } and the Lead injects the real worker
//     through buildGitExecPorts({ proposeChange }).
//
// The repoRoot passed to buildGitExecPorts() is expected to be on the branch
// that should receive the merge (e.g. main) and clean; merge/revert assume it.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

import type { ExecPorts, ExecTestResult, ExecWorktree } from "./evolution-executor.ts";

/** Fixed table used when runTests() is called without commands. Like the
 * executor's own table this is code-owned: proposal text never reaches argv. */
export const DEFAULT_TEST_COMMANDS: readonly string[] = ["pnpm exec tsc -b"];

/** Combined test log is cut at this many UTF-8 bytes (executor then clips its
 * own copy further). */
export const TEST_LOG_LIMIT_BYTES = 20_000;

/** A single test command may take this long before it is killed. */
const DEFAULT_COMMAND_TIMEOUT_MS = 15 * 60_000;
/** git operations on a small worktree are quick; a hung git must not hang the
 * approval flow forever. */
const GIT_TIMEOUT_MS = 60_000;
/** Large diffs still fit; logs are truncated separately. */
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** A commit sha (SHA-1 or SHA-256, full or abbreviated). */
const SHA_RE = /^[0-9a-f]{4,64}$/i;

export interface GitExecPortOptions {
  /** Absolute path of the main checkout: merge, revert and sha256File run here. */
  repoRoot: string;
  /** Fixed test table (code-owned). Defaults to DEFAULT_TEST_COMMANDS. */
  testCommands?: readonly string[];
  /** The implementer. Injected by the Lead; the default honestly refuses. */
  proposeChange?: ExecPorts["proposeChange"];
  /** Parent directory for worktrees. Defaults to os.tmpdir(). */
  worktreeRoot?: string;
  /** Per-test-command timeout. Defaults to 15 minutes. */
  commandTimeoutMs?: number;
  /** Environment for child processes. Defaults to process.env; callers can
   * extend PATH (e.g. node_modules/.bin) when wiring runTests. */
  env?: NodeJS.ProcessEnv;
  /** Non-fatal warning sink (e.g. a worktree that was already gone). */
  log?: (message: string) => void;
}

interface RunOutput {
  code: number;
  stdout: string;
  stderr: string;
  error?: string;
}

/**
 * Build the real side effects for EvolutionExecutor. Every assumption callers
 * must keep (clean main checkout, dependency availability inside the worktree)
 * is documented on the fields above and in the README/report; nothing here
 * decides whether a change *may* be applied — that is the executor + owner.
 */
export function buildGitExecPorts(options: GitExecPortOptions): ExecPorts {
  if (typeof options.repoRoot !== "string" || options.repoRoot.trim() === "") {
    throw new Error("buildGitExecPorts needs a repoRoot");
  }
  if (!isAbsolute(options.repoRoot)) {
    throw new Error(`buildGitExecPorts needs an absolute repoRoot, got '${options.repoRoot}'`);
  }
  const repoRoot = resolve(options.repoRoot);
  const worktreeRoot = resolve(options.worktreeRoot ?? tmpdir());
  const testCommands = options.testCommands ?? DEFAULT_TEST_COMMANDS;
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const env = options.env ?? process.env;
  const log = options.log ?? ((message: string) => console.warn(message));
  const proposeChange: ExecPorts["proposeChange"] = options.proposeChange ?? (async () => ({
    error: "no implementer wired",
  }));

  /** git run with -C <cwd>; the caller owns sha/branch validation. */
  const gitAt = (cwd: string, args: readonly string[]): Promise<RunOutput> =>
    runFile("git", ["-C", cwd, ...args], { cwd, env, timeoutMs: GIT_TIMEOUT_MS });

  const assertSha = (sha: string): string => {
    if (typeof sha !== "string" || !SHA_RE.test(sha.trim())) {
      throw new Error(`invalid sha: '${String(sha)}'`);
    }
    return sha.trim();
  };

  const assertBranch = (branch: string): string => {
    const valid = typeof branch === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch);
    if (!valid || branch.endsWith("/") || branch.includes("..")) {
      throw new Error(`invalid branch name: '${String(branch)}'`);
    }
    return branch;
  };

  return {
    async createWorktree(baseSha: string): Promise<ExecWorktree> {
      const sha = assertSha(baseSha);
      const resolved = await gitAt(repoRoot, ["rev-parse", "--verify", `${sha}^{commit}`]);
      if (resolved.code !== 0) {
        throw new Error(`base sha ${sha} does not resolve to a commit: ${lastLine(resolved)}`);
      }
      await mkdir(worktreeRoot, { recursive: true });
      const short = randomUUID().replace(/-/g, "").slice(0, 8);
      const dir = join(worktreeRoot, `ein-evo-${short}`);
      const branch = `evo/${short}`;
      const added = await gitAt(repoRoot, ["worktree", "add", "-b", branch, dir, sha]);
      if (added.code !== 0) {
        throw new Error(`git worktree add failed: ${lastLine(added)}`);
      }
      return { dir, branch };
    },

    async removeWorktree(dir: string): Promise<void> {
      // Removal is best-effort: the executor records a worktree_removed event
      // on success and only a port_error on failure; it must never abort a run
      // because a temp directory was already gone.
      const result = await gitAt(repoRoot, ["worktree", "remove", "--force", dir]);
      if (result.code !== 0) {
        log(`could not remove worktree ${dir}: ${lastLine(result)}`);
      }
    },

    proposeChange,

    async runTests(dir: string, commands?: readonly string[]): Promise<ExecTestResult> {
      const table = commands && commands.length > 0 ? commands : testCommands;
      const lines: string[] = [];
      let ran = 0;
      for (const command of table) {
        let tokens: string[];
        try {
          tokens = splitCommand(command);
        } catch (error) {
          lines.push(`invalid test command '${command}': ${messageOf(error)}`);
          return { ok: false, log: clipLog(lines.join("\n")) };
        }
        if (tokens.length === 0) continue;
        ran += 1;
        lines.push(`$ ${command}`);
        const result = await runFile(tokens[0], tokens.slice(1), {
          cwd: dir,
          env,
          timeoutMs: commandTimeoutMs,
        });
        if (result.stdout.trim() !== "") lines.push(result.stdout.trimEnd());
        if (result.stderr.trim() !== "") lines.push(result.stderr.trimEnd());
        if (result.code !== 0) {
          if (result.error && result.stderr.trim() === "") lines.push(result.error);
          lines.push(`command failed with exit code ${result.code}: ${command}`);
          return { ok: false, log: clipLog(lines.join("\n")) };
        }
      }
      if (ran === 0) {
        lines.push("no test commands configured");
        return { ok: false, log: clipLog(lines.join("\n")) };
      }
      return { ok: true, log: clipLog(lines.join("\n")) };
    },

    async readDiff(dir: string, baseSha: string): Promise<string> {
      const sha = assertSha(baseSha);
      // Committed changes only: the executor's proposeChange leaves edits in the
      // worktree and commit() turns them into HEAD before this is called.
      // quotePath=false keeps non-ASCII paths literal, matching checkPath().
      const result = await gitAt(dir, ["-c", "core.quotePath=false", "diff", `${sha}...HEAD`]);
      if (result.code !== 0) {
        throw new Error(`git diff failed: ${lastLine(result)}`);
      }
      return result.stdout;
    },

    async commit(dir: string, message: string): Promise<{ sha: string }> {
      const added = await gitAt(dir, ["add", "-A"]);
      if (added.code !== 0) throw new Error(`git add -A failed: ${lastLine(added)}`);
      // The identity is fixed here so a machine without git user.name/email
      // configured can still record the executor's fixed message.
      const committed = await gitAt(dir, [
        "-c",
        "user.email=ein-evolution@localhost",
        "-c",
        "user.name=Ein Evolution",
        "commit",
        "-m",
        message,
      ]);
      if (committed.code !== 0) throw new Error(`git commit failed: ${lastLine(committed)}`);
      const head = await gitAt(dir, ["rev-parse", "HEAD"]);
      const sha = head.stdout.trim();
      if (head.code !== 0 || sha === "") throw new Error("git commit produced no head sha");
      return { sha };
    },

    async merge(branch: string, headSha: string): Promise<{ ok: boolean; ref: string }> {
      const name = assertBranch(branch);
      const sha = assertSha(headSha);
      // The owner approved a specific head sha: refuse when the branch moved.
      const current = await gitAt(repoRoot, ["rev-parse", "--verify", `${name}^{commit}`]);
      if (current.code !== 0) return { ok: false, ref: "" };
      if (current.stdout.trim() !== sha) return { ok: false, ref: "" };
      const merged = await gitAt(repoRoot, ["merge", "--ff-only", name]);
      if (merged.code !== 0) return { ok: false, ref: "" };
      const head = await gitAt(repoRoot, ["rev-parse", "HEAD"]);
      return { ok: true, ref: head.code === 0 ? head.stdout.trim() : sha };
    },

    async revert(ref: string): Promise<{ ok: boolean }> {
      const target = assertSha(ref);
      const reverted = await gitAt(repoRoot, ["revert", "--no-edit", target]);
      return { ok: reverted.code === 0 };
    },

    async sha256File(relPath: string): Promise<string> {
      // Protected files are code-owned repo-relative paths, but never let a
      // caller (or a future list) read outside the checkout.
      const abs = resolve(repoRoot, relPath);
      if (abs !== repoRoot && !abs.startsWith(repoRoot + sep)) {
        throw new Error(`protected path escapes the repo: ${relPath}`);
      }
      const contents = await readFile(abs);
      return createHash("sha256").update(contents).digest("hex");
    },
  };
}

/** Run one argv array without a shell. Resolves even on failure; `code` is the
 * process exit code, -1 for spawn errors/timeouts. */
function runFile(
  file: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<RunOutput> {
  return new Promise((resolvePromise) => {
    execFile(
      file,
      [...args],
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: MAX_BUFFER_BYTES,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const failed = error !== null && error !== undefined;
        const rawCode = failed ? (error as { code?: unknown }).code : 0;
        resolvePromise({
          code: failed ? (typeof rawCode === "number" ? rawCode : -1) : 0,
          stdout: typeof stdout === "string" ? stdout : String(stdout ?? ""),
          stderr: typeof stderr === "string" ? stderr : String(stderr ?? ""),
          ...(failed && error.message ? { error: error.message } : {}),
        });
      },
    );
  });
}

/**
 * Split a code-owned command string into argv without invoking a shell. Quotes
 * group words (so `node -e "..."` works); a backslash outside quotes is kept
 * literally — git test commands do not rely on shell escaping.
 */
function splitCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let hasToken = false;
  for (const char of command) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasToken = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += char;
    hasToken = true;
  }
  if (quote !== null) throw new Error(`unterminated quote in command: ${command}`);
  if (hasToken) tokens.push(current);
  return tokens;
}

/** Cut the log at TEST_LOG_LIMIT_BYTES UTF-8 bytes, keeping the head (which
 * carries the command echo and first failure) and marking the cut. */
function clipLog(log: string): string {
  if (Buffer.byteLength(log, "utf8") <= TEST_LOG_LIMIT_BYTES) return log;
  let bytes = 0;
  let end = 0;
  for (const char of log) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > TEST_LOG_LIMIT_BYTES) break;
    bytes += size;
    end += char.length;
  }
  return `${log.slice(0, end)}\n…[truncated]`;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const lastLine = (result: RunOutput): string => {
  const lines = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const last = lines.at(-1) ?? result.error ?? `exit code ${result.code}`;
  return last.length <= 300 ? last : `${last.slice(0, 300)}…`;
};
