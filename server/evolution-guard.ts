// Self-evolution, stage 4 safety floor.
//
// The maintenance bot may only ever touch a narrow slice of the repository.
// This module is the data-in/data-out half of that promise — no filesystem, no
// git, no worktree — so every rule can be unit-tested and the pipeline that
// owns the branch can call it before (and after) a patch exists:
//
//   · checkPath                 may this repo-relative path be changed at all?
//   · checkDiff                 is this unified diff small and entirely in bounds?
//   · hashProtected             snapshot gate/policy files by sha256;
//   · checkProtectedUnchanged   did any protected file change behind our back?
//   · canApply                  is a proposal accepted, owner-approved, rolled
//                               back and covered by green tests?
//
// The policy comes from docs/self-evolution-1.1.4.md (stage 4) and the minimal
// safety loop in docs/collab/2026-10-17T17-49-self-evolution.md: only prompts/,
// templates/ and docs/ may change; gate, permission, credential, CI, dependency
// and source paths never may; one change touches at most 5 files and 150 lines.
import { createHash } from "node:crypto";

/** Roots a stage-4 change may touch. The trailing slash means a bare root
 * ("docs") is not a file and never matches. */
const WRITABLE_PREFIXES = ["prompts/", "templates/", "docs/"] as const;

/** Roots that can never be changed, whatever the explicit allowlist says. */
const ALWAYS_FORBIDDEN_PREFIXES = ["server/", "src/", "electron/", ".github/", "scripts/"] as const;

/** Shared code is forbidden like the other roots, except when the exact path
 * is named in PathPolicy.allowlist (e.g. shared/i18n/zh-CN.json). */
const SHARED_PREFIX = "shared/";

/** Gate, policy and credential files: forbidden by name even when a caller
 * tries to allowlist them, so the guard cannot be talked out of its own job. */
const HARD_DENIED_FILES: ReadonlySet<string> = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "server/evolution-guard.ts",
  "server/evolution-guard.test.ts",
  "server/dispatch.ts",
  "server/reviewer-port.ts",
  "server/permission-proxy.ts",
  "electron/secure-credentials.mjs",
]);

/** Extra repo-relative paths a caller explicitly allows. Empty by default:
 * nothing outside prompts/, templates/ and docs/ is opened without an opt-in,
 * and always-forbidden roots stay shut even when allowlisted. */
export interface PathPolicy {
  allowlist?: readonly string[];
}

/** A path after normalization, before the policy is applied. */
export interface NormalizedRepoPath {
  /** repo-relative, "/"-separated; "" when the input cannot name a file */
  path: string;
  /** the input was a POSIX, Windows-drive or UNC absolute path */
  absolute: boolean;
  /** the input contained a ".." segment */
  traversal: boolean;
}

/**
 * Normalize a path to repo-relative form: backslashes become "/", empty and
 * "." segments collapse, and duplicate slashes disappear. Nothing here decides
 * whether the path is allowed — checkPath() does — but absolute paths and ".."
 * traversal are reported so the policy can refuse them instead of guessing
 * where a hostile path would land after normalization.
 */
export function normalizeRepoPath(input: string): NormalizedRepoPath {
  const raw = input.trim().replace(/\\/g, "/");
  const absolute = raw.startsWith("/") || /^[A-Za-z]:(\/|$)/.test(raw);
  const segments = raw.split("/").filter((segment) => segment !== "" && segment !== ".");
  return { path: segments.join("/"), absolute, traversal: segments.includes("..") };
}

export interface PathDecision {
  allowed: boolean;
  /** repo-relative, "/"-separated path; "" when the input cannot name a file */
  path: string;
  reason: string;
}

/**
 * Decide whether a stage-4 change may touch `input`.
 *
 * Rejections are explicit and fail closed: absolute paths, ".." traversal,
 * control characters, the always-forbidden roots, the hard-denied gate files
 * and ".env*" files are refused before the allowlist is consulted. Only the
 * three writable roots and an exact PathPolicy.allowlist entry can allow a
 * path, and `shared/` is reopened only by that exact allowlist entry.
 */
export function checkPath(input: string, policy: PathPolicy = {}): PathDecision {
  if (/[\0\r\n]/.test(input)) {
    return { allowed: false, path: "", reason: "path contains a control character" };
  }
  const normalized = normalizeRepoPath(input);
  const path = normalized.path;
  if (path === "") return { allowed: false, path, reason: "path does not name a file" };
  if (normalized.absolute) return { allowed: false, path, reason: "absolute paths are not allowed" };
  if (normalized.traversal) {
    return { allowed: false, path, reason: "directory traversal ('..') is not allowed" };
  }
  if (isHardDenied(path)) {
    return { allowed: false, path, reason: "gate, permission or credential path — never writable" };
  }
  if (isUnderAny(path, WRITABLE_PREFIXES)) {
    return { allowed: true, path, reason: "under a writable root" };
  }
  const allowed = explicitAllowlist(policy);
  if (isUnder(path, SHARED_PREFIX)) {
    return allowed.has(path)
      ? { allowed: true, path, reason: "explicitly allowlisted" }
      : { allowed: false, path, reason: "shared/ is forbidden unless the exact path is allowlisted" };
  }
  if (isUnderAny(path, ALWAYS_FORBIDDEN_PREFIXES)) {
    return { allowed: false, path, reason: "path is under an always-forbidden root" };
  }
  if (allowed.has(path)) return { allowed: true, path, reason: "explicitly allowlisted" };
  return {
    allowed: false,
    path,
    reason: "path is not under prompts/, templates/, docs/ or the explicit allowlist",
  };
}

function isUnder(path: string, prefix: string): boolean {
  return path.startsWith(prefix);
}

function isUnderAny(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path.startsWith(prefix));
}

function isHardDenied(path: string): boolean {
  if (HARD_DENIED_FILES.has(path)) return true;
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.startsWith(".env");
}

function explicitAllowlist(policy: PathPolicy): ReadonlySet<string> {
  const allowed = new Set<string>();
  for (const entry of policy.allowlist ?? []) {
    const normalized = normalizeRepoPath(entry);
    if (normalized.path !== "" && !normalized.absolute && !normalized.traversal) {
      allowed.add(normalized.path);
    }
  }
  return allowed;
}

/** One reason a diff was refused. `path` is the offending repo-relative path,
 * or "<diff>" when the rule is about the diff as a whole (size limits,
 * malformed headers). */
export interface DiffViolation {
  path: string;
  reason: string;
}

export interface DiffCheck {
  ok: boolean;
  /** changed repo-relative paths in diff order (a rename lists its destination) */
  files: string[];
  fileCount: number;
  addedLines: number;
  removedLines: number;
  violations: DiffViolation[];
}

/** Path policy plus the stage-4 size limits (defaults: 5 files, 150 lines). */
export interface DiffPolicy extends PathPolicy {
  maxFiles?: number;
  maxChangedLines?: number;
}

/** Stage-4 limit: one change touches at most this many files. */
export const MAX_CHANGED_FILES = 5;
/** Stage-4 limit: one change adds and removes at most this many lines in total. */
export const MAX_CHANGED_LINES = 150;

interface DiffBlock {
  headerOld: string;
  headerNew: string;
  minusPath: string;
  plusPath: string;
  renameFrom: string;
  renameTo: string;
  inHunk: boolean;
}

/**
 * Check a unified diff (git format, one or more "diff --git" blocks) against
 * the stage-4 scope. It parses the file headers and counts added/removed lines
 * inside hunks — never the "---"/"+++" file headers, which are not changes.
 *
 * A change is refused when it touches more than maxFiles files, changes more
 * than maxChangedLines lines in total, or names any path checkPath() rejects.
 * Rename blocks are checked on both sides, so renaming a gate file out of the
 * way is caught even when the destination itself is writable. Malformed or
 * quoted headers fail closed: git's C-style quoting would hide the real path,
 * so callers must run `git diff -c core.quotePath=false` when paths are quoted.
 */
export function checkDiff(unifiedDiff: string, policy: DiffPolicy = {}): DiffCheck {
  const maxFiles = policy.maxFiles ?? MAX_CHANGED_FILES;
  const maxChangedLines = policy.maxChangedLines ?? MAX_CHANGED_LINES;
  const violations: DiffViolation[] = [];
  const files: string[] = [];
  let addedLines = 0;
  let removedLines = 0;
  let sawHeader = false;
  let block: DiffBlock | null = null;

  const finishBlock = (): void => {
    if (!block) return;
    const current = block;
    block = null;
    const oldPaths = [current.headerOld, current.minusPath, current.renameFrom].filter((p) => p !== "");
    const newPaths = [current.headerNew, current.plusPath, current.renameTo].filter((p) => p !== "");
    const display =
      current.plusPath || current.renameTo || current.headerNew || current.minusPath || current.headerOld;
    if (display === "") {
      violations.push({ path: "<diff>", reason: "diff block does not name a file" });
      return;
    }
    files.push(display);
    for (const candidate of new Set([...oldPaths, ...newPaths])) {
      const decision = checkPath(candidate, policy);
      if (!decision.allowed) violations.push({ path: candidate, reason: decision.reason });
    }
  };

  for (const line of unifiedDiff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      finishBlock();
      sawHeader = true;
      const parsed = parseDiffGitLine(line);
      if (parsed === null) {
        violations.push({
          path: "<diff>",
          reason: "quoted or malformed diff header; pass -c core.quotePath=false and a literal path",
        });
        block = emptyBlock();
      } else {
        block = { ...emptyBlock(), headerOld: parsed.oldPath, headerNew: parsed.newPath };
      }
      continue;
    }
    if (!block) continue;
    if (line.startsWith("@@")) {
      block.inHunk = true;
      continue;
    }
    if (!block.inHunk) {
      if (line.startsWith("--- ")) {
        const parsed = parsePathLine(line, "a/");
        if (parsed === null) violations.push(unparsablePathViolation("---"));
        else block.minusPath = parsed;
      } else if (line.startsWith("+++ ")) {
        const parsed = parsePathLine(line, "b/");
        if (parsed === null) violations.push(unparsablePathViolation("+++"));
        else block.plusPath = parsed;
      } else if (line.startsWith("rename from ")) {
        block.renameFrom = line.slice("rename from ".length).trim();
      } else if (line.startsWith("rename to ")) {
        block.renameTo = line.slice("rename to ".length).trim();
      }
      continue;
    }
    if (line.startsWith("+")) addedLines += 1;
    else if (line.startsWith("-")) removedLines += 1;
  }
  finishBlock();

  if (!sawHeader) {
    violations.push({ path: "<diff>", reason: "no 'diff --git' headers found in the diff" });
  }
  const changedLines = addedLines + removedLines;
  if (files.length > maxFiles) {
    violations.push({
      path: "<diff>",
      reason: `diff touches ${files.length} files, the limit is ${maxFiles}`,
    });
  }
  if (changedLines > maxChangedLines) {
    violations.push({
      path: "<diff>",
      reason: `diff changes ${changedLines} lines (${addedLines} added + ${removedLines} removed), the limit is ${maxChangedLines}`,
    });
  }

  return {
    ok: violations.length === 0,
    files,
    fileCount: files.length,
    addedLines,
    removedLines,
    violations,
  };
}

function emptyBlock(): DiffBlock {
  return { headerOld: "", headerNew: "", minusPath: "", plusPath: "", renameFrom: "", renameTo: "", inHunk: false };
}

/** "diff --git a/<old> b/<new>" → the two paths. Quoted headers are rejected:
 * git escapes special and (by default) non-ASCII characters there, and guessing
 * the unescaped path would let a hostile name slip past the policy. */
function parseDiffGitLine(line: string): { oldPath: string; newPath: string } | null {
  const rest = line.slice("diff --git ".length);
  if (rest.includes('"')) return null;
  const marker = rest.lastIndexOf(" b/");
  if (marker < 0) return null;
  const oldPart = rest.slice(0, marker);
  if (!oldPart.startsWith("a/")) return null;
  return { oldPath: oldPart.slice(2), newPath: rest.slice(marker + 3) };
}

/** "--- a/<path>" or "+++ b/<path>"; "" for /dev/null, null when unparsable. */
function parsePathLine(line: string, prefix: string): string | null {
  const rest = line.slice(4).trim();
  if (rest === "/dev/null") return "";
  if (rest.startsWith('"')) return null;
  return rest.startsWith(prefix) ? rest.slice(prefix.length) : null;
}

function unparsablePathViolation(header: string): DiffViolation {
  return {
    path: "<diff>",
    reason: `unparsable ${header} path (quoted or without the expected prefix)`,
  };
}

/** The content of each protected file. Hashing is the caller's half of this
 * contract: it reads the files, this module only fingerprints them. */
export type ProtectedFileContents = Readonly<Record<string, string>>;
export type ProtectedHashes = Record<string, string>;

/**
 * sha256 every protected file's contents. Keys are sorted, so equal snapshots
 * produce byte-identical maps regardless of the order the caller collected
 * them in.
 */
export function hashProtected(files: ProtectedFileContents): ProtectedHashes {
  const hashes: ProtectedHashes = {};
  for (const path of Object.keys(files).sort()) {
    hashes[path] = createHash("sha256").update(files[path], "utf8").digest("hex");
  }
  return hashes;
}

export interface ProtectedComparison {
  /** true when no protected path was added, removed or rewritten */
  ok: boolean;
  /** protected paths added, removed or rewritten between the snapshots */
  changed: string[];
}

/**
 * Compare two hashProtected() snapshots. A missing path on either side counts
 * as changed — deleting or adding a protected file is exactly the kind of
 * self-modification the guard must report.
 */
export function checkProtectedUnchanged(before: ProtectedHashes, after: ProtectedHashes): ProtectedComparison {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changed = paths.filter((path) => before[path] !== after[path]);
  return { ok: changed.length === 0, changed };
}

/** Proposal kinds a stage-4 apply may carry. code_task is deliberately absent:
 * it needs the separate stage-4 switch and is handled in ApplyCandidate. */
export type ProposalKind = "prompt_patch" | "plan_template" | "config" | "code_task";

/** Kinds that may be applied without the stage-4 code-task switch. */
const APPLICABLE_KINDS: ReadonlySet<string> = new Set(["prompt_patch", "plan_template", "config"]);

export interface ApplyCandidate {
  proposalStatus: string;
  kind: string;
  approvedBy: string;
  hasRollback: boolean;
  testsPassed: boolean;
  /** Stage-4 switch. Off by default: code_task proposals stay blocked until
   * the owner turns this on explicitly. */
  codeTasksEnabled?: boolean;
}

export interface ApplyDecision {
  ok: boolean;
  /** every rule that failed, so the caller can show the owner all of them */
  reasons: string[];
}

/**
 * The approval/source half of the safety floor, pure data in and out.
 *
 * All five conditions must hold: the proposal was accepted (an open/rejected/
 * deferred proposal can never be applied), its kind is one of the three
 * data-level kinds (code_task only with the stage-4 switch), the owner — not
 * the proposing agent — approved it, it carries a rollback path, and its tests
 * passed. Every failure is returned, not just the first.
 */
export function canApply(candidate: ApplyCandidate): ApplyDecision {
  const reasons: string[] = [];
  if (candidate.proposalStatus !== "accepted") {
    reasons.push(`proposal status is '${candidate.proposalStatus}', only 'accepted' may be applied`);
  }
  if (candidate.kind === "code_task") {
    if (candidate.codeTasksEnabled !== true) {
      reasons.push("code_task proposals need the stage-4 code-task switch");
    }
  } else if (!APPLICABLE_KINDS.has(candidate.kind)) {
    reasons.push(`kind '${candidate.kind}' is not an applicable proposal kind`);
  }
  if (candidate.approvedBy !== "owner") {
    reasons.push("only the owner may approve an apply");
  }
  if (!candidate.hasRollback) {
    reasons.push("the proposal has no rollback path");
  }
  if (!candidate.testsPassed) {
    reasons.push("tests have not passed");
  }
  return { ok: reasons.length === 0, reasons };
}
