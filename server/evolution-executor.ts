// 自我进化 · 阶段 4：把「已采纳的提案」执行到「可合并」的执行器。
//
// 安全模型（全部是红线，缺一不可）：
//   1. 本模块永不自动合并。execute() 只推进到 merge_ready 并返回 diff/测试/评审；
//      唯一能调用 ports.merge 的是老板显式批准后的 approveAndMerge()；
//   2. 批准绑定到具体 head sha：只有 guard、tests、review 三项都在同一个
//      headSha 上通过、且老板点头，合并才会发生；head sha 一变，之前的证据全部作废；
//   3. 改动范围由 evolution-guard 的 checkDiff 判定（只允许 prompts/、templates/、
//      docs/，≤5 文件 ≤150 行），同时用 sha256 对比保护文件（guard/pipeline/审批/
//      注意力门等），跑 guard 前后任何保护文件变化立刻 rejected；
//   4. 测试命令是代码里的固定表，提案文本进不了命令；owner 的 proposals 里写什么都
//      不会被执行；
//   5. 评审端口默认是 stub（返回「需要人工评审」，绝不假装通过）；真 reviewer 之后注入；
//   6. 所有端口都可注入；任何端口抛错/失败都转成终态（aborted/rejected）并返回，
//      不向调用方抛异常；合并后的冒烟失败会自动 revert 并记录 reverted 事件。
//
// git / worktree / 文件系统 / 模型全部通过 ExecPorts 注入：本文件不执行任何真实
// git 命令、不写真实仓库——这样阶段 4 的核心逻辑可以先用 FakePorts 完整测试。
import { canApply, checkDiff, checkProtectedUnchanged } from "./evolution-guard.ts";
import type { DiffPolicy, ProtectedHashes, ProposalKind } from "./evolution-guard.ts";
import type { EvolutionArea, EvolutionItem } from "./evolution.ts";
import type { PipelineEvent, PipelineRun, PipelineState } from "./evolution-pipeline.ts";
import { transition } from "./evolution-pipeline.ts";

/** One isolated checkout a change is made in. */
export interface ExecWorktree {
  /** absolute path of the worktree (owned by the port; the executor never
   * reads or writes files in it directly) */
  dir: string;
  /** branch the port created for this change, e.g. "evo/<proposal-id>" */
  branch: string;
}

export interface ExecChangeRequest {
  dir: string;
  proposal: EvolutionItem;
  baseSha: string;
}

export interface ExecTestResult {
  ok: boolean;
  log: string;
}

/** Every side effect the executor needs. No real git/fs/model live in this
 * module: the Lead wires a git-backed implementation at the route layer, and
 * the tests use FakePorts.
 *
 * `sha256File(path)` must hash a **protected repo-relative path in the main
 * checkout**, not the worktree: that is how a change outside the diff (or a
 * tampered guard file) is caught. */
export interface ExecPorts {
  createWorktree(baseSha: string): Promise<ExecWorktree>;
  removeWorktree(dir: string): Promise<void>;
  /** Let the implementer edit the worktree. Return an error instead of a head
   * sha when it cannot make a change. */
  proposeChange(input: ExecChangeRequest): Promise<{ headSha: string } | { error: string }>;
  /** Run EXACTLY `commands` (the executor's fixed table) in `dir`. The optional
   * argument keeps a one-argument implementation assignable; the executor
   * always passes it. */
  runTests(dir: string, commands?: readonly string[]): Promise<ExecTestResult>;
  /** Unified git diff of the worktree against `baseSha` (-c core.quotePath=false). */
  readDiff(dir: string, baseSha: string): Promise<string>;
  commit(dir: string, message: string): Promise<{ sha: string }>;
  /** Merge is called ONLY by approveAndMerge(), after the owner's approval. */
  merge(branch: string, headSha: string): Promise<{ ok: boolean; ref: string }>;
  /** Roll back a merge ref (used by the post-merge smoke failure path). */
  revert(ref: string): Promise<{ ok: boolean }>;
  sha256File(path: string): Promise<string>;
}

/** One entry of the executor's own audit trail (persisted by the caller). */
export type ExecutorAuditType =
  | "proposal_not_accepted"
  | "code_task_blocked"
  | "provisioned"
  | "implemented"
  | "guard_violation"
  | "protected_changed"
  | "tests_red"
  | "review_blocked"
  | "merge_ready"
  | "merge_blocked"
  | "merged"
  | "merge_failed"
  | "post_merge_failed"
  | "reverted"
  | "revert_failed"
  | "port_error"
  | "worktree_removed";

export interface ExecutorAuditEvent {
  type: ExecutorAuditType;
  at: number;
  detail: string;
  headSha?: string;
  ref?: string;
}

export interface ReviewInput {
  proposal: EvolutionItem;
  /** the unified diff the reviewer is judging — never the implementer's reasoning */
  diff: string;
  baseSha: string;
  headSha: string;
}

export interface ReviewOutcome {
  pass: boolean;
  reason?: string;
  reviewer?: string;
}

/** The independent reviewer. Injected; the default stub never passes. */
export type ReviewPort = (input: ReviewInput) => Promise<ReviewOutcome>;

/** Default reviewer: the honest "nobody reviewed this yet" answer. It blocks,
 * so a real reviewer must be injected before anything can become merge_ready. */
export const stubReview: ReviewPort = async () => ({
  pass: false,
  reason: "未接入独立评审：需要人工看 diff 后决定（默认不通过）",
  reviewer: "stub",
});

/** Fixed test table — code-owned. Proposal text can never influence it. */
export const FIXED_TEST_COMMANDS: readonly string[] = [
  "tsc -p tsconfig.server.json",
  "vitest run server/evolution-guard.test.ts server/evolution-pipeline.test.ts server/evolution-executor.test.ts",
];

/** Files the evolution loop must never modify on its own. Hashed before and
 * after the change; a difference rejects the run. Callers can extend or
 * override the list (e.g. only existing files). */
export const DEFAULT_PROTECTED_FILES: readonly string[] = [
  "server/evolution-guard.ts",
  "server/evolution-guard.test.ts",
  "server/evolution-pipeline.ts",
  "server/evolution-pipeline.test.ts",
  "server/evolution-executor.ts",
  "server/evolution-executor.test.ts",
  "server/approval-audit.ts",
  "server/attention-gate.ts",
];

const KIND_BY_AREA: Record<EvolutionArea, ProposalKind> = {
  prompt: "prompt_patch",
  plan_template: "plan_template",
  process: "prompt_patch",
  code: "code_task",
  ui: "code_task",
};

/** Which apply kind a proposal maps to (the guard's canApply vocabulary). */
export function proposalKindFor(proposal: EvolutionItem, override?: ProposalKind): ProposalKind {
  return override ?? KIND_BY_AREA[proposal.area];
}

export interface ExecuteOptions {
  /** Fixed timestamp for every transition (tests); defaults to Date.now. */
  now?: number;
  /** Defaults to FIXED_TEST_COMMANDS. A fixed command missing from the
   * whitelist aborts before any test runs. */
  commandWhitelist?: readonly string[];
  /** Independent reviewer. Defaults to the blocking stub. */
  review?: ReviewPort;
  /** Protected files. Defaults to DEFAULT_PROTECTED_FILES. */
  protectedFiles?: readonly string[];
  /** Diff scope limits; defaults to the guard's 5 files / 150 lines. */
  diffPolicy?: DiffPolicy;
  /** Stage-4 code-task switch (off by default). */
  codeTasksEnabled?: boolean;
  /** Fallback base sha when the pipeline run carries none. */
  baseSha?: string;
  /** Force the apply kind (e.g. map "process" to a prompt patch). */
  proposalKind?: ProposalKind;
}

export interface ExecutionResult {
  /** Final pipeline run: merge_ready on success; rejected/aborted on failure. */
  run: PipelineRun;
  /** Every accepted pipeline event, in order (persist with the run). */
  events: PipelineEvent[];
  audit: ExecutorAuditEvent[];
  diff?: string;
  testLog?: string;
  review?: ReviewOutcome;
  /** Protected-file snapshot from before the change: pass it to
   * approveAndMerge() so the merge re-checks the same baseline. */
  protectedHashes?: ProtectedHashes;
  branch?: string;
  /** Kept alive on merge_ready (the reviewer / merge may still need it); the
   * caller removes it after the merge or when the run expires. */
  worktreeDir?: string;
  /** Human-readable reason for a terminal failure. */
  error?: string;
}

export interface ApproveMergeInput {
  /** Branch the execute() worktree created. */
  branch: string;
  /** The head sha the OWNER approved (what the UI showed). */
  headSha: string;
  approvedBy: "owner" | "bot";
  /** The worktree from execute(), if it is still alive: re-checked and used
   * for the post-merge smoke test. */
  worktreeDir?: string;
  /** Snapshot from the ExecutionResult; when present, the protected files are
   * re-hashed before merging. */
  protectedHashes?: ProtectedHashes;
  /** Runs against the merged tree. Default: ports.runTests(worktreeDir). */
  postMergeSmoke?: (input: { ref: string; dir?: string }) => Promise<{ ok: boolean; log?: string }>;
  codeTasksEnabled?: boolean;
  proposalKind?: ProposalKind;
  now?: number;
  protectedFiles?: readonly string[];
}

export interface MergeResult {
  /** true only when the merge happened AND the post-merge smoke passed. */
  ok: boolean;
  run: PipelineRun;
  events: PipelineEvent[];
  audit: ExecutorAuditEvent[];
  /** merge port's ref (merge commit / tag), the revert target. */
  ref?: string;
  reverted?: boolean;
  error?: string;
}

const TERMINAL_STATES: ReadonlySet<PipelineState> = new Set<PipelineState>(["merged", "aborted", "rejected", "expired"]);

const isTerminal = (state: PipelineState): boolean => TERMINAL_STATES.has(state);

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const clip = (value: string, max: number): string => {
  const flat = value.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, Math.max(1, max - 1)).join("")}…`;
};

/** The commit message is fixed here; the proposal's free text never becomes
 * part of it (only the generated id does). */
const commitMessage = (proposal: EvolutionItem): string =>
  `chore(evolution): apply accepted improvement ${clip(proposal.id, 40)}`;

export class EvolutionExecutor {
  /** Advance an accepted run to merge_ready (or a terminal state on failure).
   * Never merges and never throws. */
  async execute(run: PipelineRun, proposal: EvolutionItem, ports: ExecPorts, options: ExecuteOptions = {}): Promise<ExecutionResult> {
    const at = options.now ?? Date.now();
    const events: PipelineEvent[] = [];
    const audit: ExecutorAuditEvent[] = [];
    const record = (type: ExecutorAuditType, detail: string, extra: Partial<ExecutorAuditEvent> = {}) => {
      audit.push({ type, at, detail, ...extra });
    };
    let current: PipelineRun = run;
    let diff = "";
    let testLog = "";
    let review: ReviewOutcome | undefined;
    let worktree: ExecWorktree | undefined;
    let protectedHashes: ProtectedHashes | undefined;

    const finish = (error?: string): ExecutionResult => ({
      run: current,
      events,
      audit,
      ...(diff ? { diff } : {}),
      ...(testLog ? { testLog } : {}),
      ...(review ? { review } : {}),
      ...(protectedHashes ? { protectedHashes } : {}),
      ...(worktree ? { branch: worktree.branch, worktreeDir: worktree.dir } : {}),
      ...(error ? { error } : {}),
    });

    /** Move the run to a terminal state (unless it already is one). */
    const terminate = (error: string, auditType: ExecutorAuditType = "port_error"): ExecutionResult => {
      if (!isTerminal(current.state)) {
        const event: PipelineEvent = { type: "abort", reason: clip(error, 200) };
        current = transition(current, event, at).run;
        events.push(event);
      }
      record(auditType, error);
      return finish(error);
    };

    const cleanup = async (): Promise<void> => {
      if (!worktree) return;
      try {
        await ports.removeWorktree(worktree.dir);
        record("worktree_removed", `removed ${worktree.dir}`);
      } catch (error) {
        record("port_error", `could not remove worktree: ${messageOf(error)}`);
      }
    };

    try {
      // ── preconditions: accepted, allowed kind, base sha ──
      if (current.state !== "accepted") {
        record("proposal_not_accepted", `run is ${current.state}, only an accepted run may start`);
        return finish(`run is ${current.state}, only an accepted run may start`);
      }
      if (proposal.status !== "accepted") {
        record("proposal_not_accepted", `proposal ${proposal.id} is ${proposal.status}`);
        return terminate(`proposal is ${proposal.status}, only an accepted proposal may be implemented`, "proposal_not_accepted");
      }
      const kind = proposalKindFor(proposal, options.proposalKind);
      if (kind === "code_task" && options.codeTasksEnabled !== true) {
        record("code_task_blocked", "stage-4 code-task switch is off");
        return terminate("code tasks need the stage-4 switch", "code_task_blocked");
      }
      const baseSha = options.baseSha ?? current.baseSha;
      if (!baseSha) return terminate("no base sha: the run must record the commit it started from");

      // ── protected files: baseline BEFORE anything is created ──
      const protectedFiles = options.protectedFiles ?? DEFAULT_PROTECTED_FILES;
      protectedHashes = await this.snapshotProtected(protectedFiles, ports);

      // ── provision ──
      const provisioned = transition(current, { type: "provision", baseSha }, at);
      if (!provisioned.ok) {
        record("port_error", provisioned.reason ?? "could not provision");
        return finish(provisioned.reason ?? "could not provision");
      }
      current = provisioned.run;
      events.push({ type: "provision", baseSha });
      worktree = await ports.createWorktree(baseSha);
      if (!worktree.dir || !worktree.branch) throw new Error("createWorktree returned no dir/branch");
      record("provisioned", `worktree ${worktree.branch} from ${clip(baseSha, 12)}`);

      // ── implement → guard → tests → review, until merge_ready or terminal ──
      let rounds = 0;
      while (current.state !== "merge_ready" && !isTerminal(current.state)) {
        rounds += 1;
        if (rounds > 12) return terminate("the executor loop did not settle");

        // implement (also the retry path after a red test / blocked review)
        const change = await ports.proposeChange({ dir: worktree.dir, proposal, baseSha });
        if ("error" in change) return terminate(`implementer could not make the change: ${clip(change.error, 160)}`);
        const commit = await ports.commit(worktree.dir, commitMessage(proposal));
        if (!commit.sha) throw new Error("commit returned no sha");
        const implemented = transition(current, { type: "implement", headSha: commit.sha }, at);
        if (!implemented.ok) {
          record("port_error", implemented.reason ?? "implement refused");
          return finish(implemented.reason ?? "implement refused");
        }
        current = implemented.run;
        events.push({ type: "implement", headSha: commit.sha });
        record("implemented", `round ${current.implementRounds}`, { headSha: commit.sha });

        // guard: diff scope + protected-file sha snapshot (main checkout)
        diff = await ports.readDiff(worktree.dir, baseSha);
        const diffCheck = checkDiff(diff, options.diffPolicy ?? {});
        const after = await this.snapshotProtected(protectedFiles, ports);
        const protectedCheck = checkProtectedUnchanged(protectedHashes, after);
        if (!diffCheck.ok || !protectedCheck.ok) {
          const reasons: string[] = [
            ...diffCheck.violations.map((violation) => `${violation.path}: ${violation.reason}`),
            ...(protectedCheck.ok ? [] : [`protected files changed: ${protectedCheck.changed.join(", ")}`]),
          ];
          const reason = clip(reasons.join("; ") || "guard violation", 240);
          const violated = transition(current, { type: "guard_violation", reason }, at);
          current = violated.run;
          events.push({ type: "guard_violation", reason });
          record(protectedCheck.ok ? "guard_violation" : "protected_changed", reason, { headSha: commit.sha });
          await cleanup();
          return finish(reason);
        }
        const guarded = transition(current, { type: "guard_pass" }, at);
        if (!guarded.ok) return terminate(guarded.reason ?? "guard_pass refused");
        current = guarded.run;
        events.push({ type: "guard_pass" });

        // tests: the fixed table only, validated against the whitelist
        const table = this.testCommands(options.commandWhitelist);
        if ("error" in table) return terminate(table.error);
        const tested = await ports.runTests(worktree.dir, table.commands);
        testLog = clip(tested.log ?? "", 20_000);
        if (!tested.ok) {
          const red = transition(current, { type: "test_fail", reason: clip(tested.log, 200) }, at);
          current = red.run;
          events.push({ type: "test_fail", reason: clip(tested.log, 200) });
          record("tests_red", `failure ${current.testFailures}: ${clip(tested.log, 160)}`, { headSha: commit.sha });
          if (isTerminal(current.state)) {
            await cleanup();
            return finish("tests kept failing; the change was rejected");
          }
          continue;
        }
        const passed = transition(current, { type: "test_pass" }, at);
        if (!passed.ok) return terminate(passed.reason ?? "test_pass refused");
        current = passed.run;
        events.push({ type: "test_pass" });

        // review: injected port; the default stub blocks instead of pretending
        const verdict = await (options.review ?? stubReview)({
          proposal,
          diff,
          baseSha,
          headSha: commit.sha,
        });
        review = verdict;
        const verdictReason = clip(verdict.reason ?? "review blocked", 200);
        if (!verdict.pass) {
          const blocked = transition(current, { type: "review_block", reason: verdictReason }, at);
          current = blocked.run;
          events.push({ type: "review_block", reason: verdictReason });
          record("review_blocked", verdictReason, { headSha: commit.sha });
          if (isTerminal(current.state)) {
            await cleanup();
            return finish("review kept blocking; the change was rejected");
          }
          continue;
        }
        const reviewed = transition(current, { type: "review_pass" }, at);
        if (!reviewed.ok) return terminate(reviewed.reason ?? "review_pass refused");
        current = reviewed.run;
        events.push({ type: "review_pass" });
      }

      if (current.state !== "merge_ready") {
        await cleanup();
        return finish(`pipeline stopped at ${current.state}`);
      }
      record("merge_ready", `head ${clip(current.headSha ?? "?", 12)} awaits the owner`, {
        ...(current.headSha ? { headSha: current.headSha } : {}),
      });
      return finish();
    } catch (error) {
      // a port threw: never propagate, always a terminal state
      const reason = messageOf(error);
      if (!isTerminal(current.state)) {
        const stopped = transition(current, { type: "abort", reason: clip(reason, 200) }, at);
        current = stopped.run;
      }
      record("port_error", reason, { ...(current.headSha ? { headSha: current.headSha } : {}) });
      await cleanup();
      return finish(reason);
    }
  }

  /** The ONLY path to merge. Requires the owner's approval bound to the same
   * head sha as guard+tests+review, a passing canApply() and (when a snapshot
   * is supplied) unchanged protected files. Post-merge smoke failure reverts. */
  async approveAndMerge(
    run: PipelineRun,
    proposal: EvolutionItem,
    ports: ExecPorts,
    input: ApproveMergeInput,
  ): Promise<MergeResult> {
    const at = input.now ?? Date.now();
    const events: PipelineEvent[] = [];
    const audit: ExecutorAuditEvent[] = [];
    const record = (type: ExecutorAuditType, detail: string, extra: Partial<ExecutorAuditEvent> = {}) => {
      audit.push({ type, at, detail, ...extra });
    };
    let current = run;
    let reverted = false;
    let ref: string | undefined;

    const cleanup = async (): Promise<void> => {
      if (!input.worktreeDir) return;
      try {
        await ports.removeWorktree(input.worktreeDir);
        record("worktree_removed", `removed ${input.worktreeDir}`);
      } catch (error) {
        record("port_error", `could not remove worktree: ${messageOf(error)}`);
      }
    };

    try {
      // ── the apply/source half of the safety floor (pure) ──
      const decision = canApply({
        proposalStatus: proposal.status,
        kind: proposalKindFor(proposal, input.proposalKind),
        approvedBy: input.approvedBy,
        hasRollback: Boolean(run.baseSha),
        testsPassed: Boolean(run.headSha) && run.testsOkAtHead === run.headSha && run.state === "merge_ready",
        codeTasksEnabled: input.codeTasksEnabled,
      });
      if (!decision.ok) {
        const error = decision.reasons.join("; ");
        record("merge_blocked", error);
        return { ok: false, run, events, audit, error };
      }
      // ── approval must bind to the same head sha as guard/tests/review ──
      const approved = transition(current, { type: "approve_merge", headSha: input.headSha, by: input.approvedBy }, at);
      if (!approved.ok) {
        record("merge_blocked", approved.reason ?? "approval refused");
        return { ok: false, run: approved.run, events, audit, error: approved.reason ?? "approval refused" };
      }
      if (approved.run.headSha !== input.headSha) {
        record("merge_blocked", "the approved head sha no longer matches the run");
        return { ok: false, run: approved.run, events, audit, error: "the approved head sha no longer matches the run" };
      }
      // ── re-check the protected baseline captured by execute() ──
      if (input.protectedHashes) {
        const files = input.protectedFiles ?? Object.keys(input.protectedHashes);
        const now = await this.snapshotProtected(files, ports);
        const comparison = checkProtectedUnchanged(input.protectedHashes, now);
        if (!comparison.ok) {
          const reason = `protected files changed before merge: ${comparison.changed.join(", ")}`;
          const violated = transition(run, { type: "guard_violation", reason }, at);
          record("protected_changed", reason);
          return { ok: false, run: violated.run, events, audit, error: reason };
        }
      }
      // ── the merge itself (still only here, after the owner) ──
      const merged = await ports.merge(input.branch, input.headSha);
      ref = merged.ref;
      if (!merged.ok) {
        const error = "merge port refused the merge";
        const aborted = transition(run, { type: "abort", reason: error }, at);
        record("merge_failed", error);
        await cleanup();
        return { ok: false, run: aborted.run, events, audit, error };
      }
      current = approved.run;
      events.push({ type: "approve_merge", headSha: input.headSha, by: input.approvedBy });
      record("merged", `head ${clip(input.headSha, 12)} → ${clip(merged.ref, 12)}`, { headSha: input.headSha, ref: merged.ref });

      // ── post-merge smoke: a failure must not stay merged ──
      const smoke =
        input.postMergeSmoke ??
        (input.worktreeDir
          ? async () => {
              const table = this.testCommands();
              if ("error" in table) return { ok: false, log: table.error };
              return ports.runTests(input.worktreeDir!, table.commands);
            }
          : undefined);
      if (smoke) {
        let smokeResult: { ok: boolean; log?: string };
        try {
          smokeResult = await smoke({ ref: merged.ref, ...(input.worktreeDir ? { dir: input.worktreeDir } : {}) });
        } catch (error) {
          smokeResult = { ok: false, log: messageOf(error) };
        }
        if (!smokeResult.ok) {
          const why = `post-merge smoke failed: ${clip(smokeResult.log ?? "unknown", 200)}`;
          record("post_merge_failed", why, { ref: merged.ref });
          let revertOk = false;
          try {
            const undone = await ports.revert(merged.ref);
            revertOk = undone.ok;
          } catch (error) {
            record("revert_failed", messageOf(error), { ref: merged.ref });
          }
          if (revertOk) {
            reverted = true;
            record("reverted", `reverted ${clip(merged.ref, 12)}`, { ref: merged.ref });
          }
          await cleanup();
          return { ok: false, run: current, events, audit, ref: merged.ref, reverted, error: why };
        }
      }

      await cleanup();
      return { ok: true, run: current, events, audit, ref: merged.ref, reverted: false };
    } catch (error) {
      const reason = messageOf(error);
      record("port_error", reason);
      await cleanup();
      return { ok: false, run: current, events, audit, ...(ref ? { ref } : {}), reverted, error: reason };
    }
  }

  /** Fold the fixed command table through the caller's whitelist. */
  private testCommands(whitelist?: readonly string[]): { commands: string[] } | { error: string } {
    const allowed = whitelist ?? FIXED_TEST_COMMANDS;
    const blocked = FIXED_TEST_COMMANDS.filter((command) => !allowed.includes(command));
    if (blocked.length) return { error: `fixed test command not whitelisted: ${blocked.join(", ")}` };
    return { commands: [...FIXED_TEST_COMMANDS] };
  }

  private async snapshotProtected(files: readonly string[], ports: ExecPorts): Promise<ProtectedHashes> {
    const hashes: ProtectedHashes = {};
    for (const path of [...files].sort()) hashes[path] = await ports.sha256File(path);
    return hashes;
  }
}

/** One shared executor instance: it keeps no state between calls. */
export const evolutionExecutor = new EvolutionExecutor();
