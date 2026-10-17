// 阶段4的服务编排层：把「老板采纳的提案」推进到 merge_ready，并在老板再次
// 批准后执行真正的 merge。执行器/端口仍然是安全边界：这里只负责持有工作区、
// 持久化执行结果、在失败时清理、在合并后删除 worktree。
import { evolutionExecutor, FIXED_TEST_COMMANDS, type ExecPorts, type ExecutionResult, type ReviewPort } from "./evolution-executor.ts";
import type { EvolutionItem } from "./evolution.ts";
import type { PipelineRun } from "./evolution-pipeline.ts";

export interface EvolutionExecutionRecord {
  proposalId: string;
  runId: string;
  run: PipelineRun;
  state: PipelineRun["state"];
  branch?: string;
  worktreeDir?: string;
  headSha?: string;
  diff?: string;
  testLog?: string;
  review?: { pass: boolean; reason?: string; reviewer?: string };
  protectedHashes?: Record<string, string>;
  error?: string;
  startedAt: number;
  updatedAt: number;
}

export interface EvolutionServiceDeps {
  /** build the real (or fake) git ports around an implementer */
  buildPorts: (proposeChange: ExecPorts["proposeChange"]) => ExecPorts;
  /** hidden-bot implementer: only edits the worktree, never commits */
  implementer: ExecPorts["proposeChange"];
  /** independent reviewer for the diff (never the default stub in production) */
  review: ReviewPort;
  /** must contain the executor's fixed test table (code-owned) */
  testCommands?: readonly string[];
  protectedFiles?: readonly string[];
  persist?: (records: EvolutionExecutionRecord[]) => void;
  now?: () => number;
}

export class EvolutionService {
  private readonly records = new Map<string, EvolutionExecutionRecord>();
  private readonly deps: EvolutionServiceDeps;

  constructor(deps: EvolutionServiceDeps) {
    this.deps = deps;
  }

  list(): EvolutionExecutionRecord[] {
    return [...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Restore persisted executions after a restart. */
  hydrate(records: readonly EvolutionExecutionRecord[]): void {
    for (const record of records) {
      if (record && typeof record.proposalId === "string" && record.run) this.records.set(record.proposalId, record);
    }
  }

  byProposal(proposalId: string): EvolutionExecutionRecord | undefined {
    return this.records.get(proposalId);
  }

  private save(): void {
    this.deps.persist?.(this.list());
  }

  /** Provision → implement → guard → tests → review. Leaves the worktree
   * alive only when the run reaches merge_ready. */
  async start(proposal: EvolutionItem, run: PipelineRun, baseSha?: string): Promise<EvolutionExecutionRecord> {
    const existing = this.records.get(proposal.id);
    if (existing && existing.state === "merge_ready") return existing;
    const startedAt = this.deps.now?.() ?? Date.now();
    const ports = this.deps.buildPorts(this.deps.implementer);
    const result: ExecutionResult = await evolutionExecutor.execute(run, proposal, ports, {
      review: this.deps.review,
      commandWhitelist: this.deps.testCommands ?? FIXED_TEST_COMMANDS,
      ...(this.deps.protectedFiles ? { protectedFiles: this.deps.protectedFiles } : {}),
      ...(baseSha ? { baseSha } : {}),
    });
    const record: EvolutionExecutionRecord = {
      proposalId: proposal.id,
      runId: result.run.id,
      run: result.run,
      state: result.run.state,
      ...(result.branch ? { branch: result.branch } : {}),
      ...(result.run.state === "merge_ready" && result.worktreeDir ? { worktreeDir: result.worktreeDir } : {}),
      ...(result.run.headSha ? { headSha: result.run.headSha } : {}),
      ...(result.diff ? { diff: result.diff } : {}),
      ...(result.testLog ? { testLog: result.testLog } : {}),
      ...(result.review ? { review: result.review } : {}),
      ...(result.protectedHashes ? { protectedHashes: result.protectedHashes } : {}),
      ...(result.error ? { error: result.error } : {}),
      startedAt,
      updatedAt: this.deps.now?.() ?? Date.now(),
    };
    this.records.set(proposal.id, record);
    this.save();
    return record;
  }

  /** Owner-approved merge. Never called from start(); the caller must have a
   * merge_ready record and pass its headSha. Removes the worktree afterwards. */
  async approveMerge(
    proposal: EvolutionItem,
    headSha: string,
  ): Promise<{ ok: boolean; record?: EvolutionExecutionRecord; error?: string }> {
    const record = this.records.get(proposal.id);
    if (!record) return { ok: false, error: "no execution for this proposal" };
    if (record.state !== "merge_ready") return { ok: false, error: `not merge_ready (${record.state})` };
    if (!record.branch || !record.worktreeDir) return { ok: false, error: "missing branch or worktree" };
    const ports = this.deps.buildPorts(this.deps.implementer);
    const merged = await evolutionExecutor.approveAndMerge(
      { ...record.run, ...(record.headSha ? { headSha: record.headSha } : {}) },
      proposal,
      ports,
      {
        branch: record.branch,
        headSha,
        approvedBy: "owner",
        worktreeDir: record.worktreeDir,
        ...(record.protectedHashes ? { protectedHashes: record.protectedHashes } : {}),
        postMergeSmoke: async (input: { ref: string; dir?: string }) => {
          if (!input.dir) return { ok: false, log: "no worktree for post-merge smoke" };
          const result = await ports.runTests(input.dir, this.deps.testCommands ?? FIXED_TEST_COMMANDS);
          return { ok: result.ok, log: result.log };
        },
      },
    );
    const next: EvolutionExecutionRecord = {
      ...record,
      run: merged.run,
      state: merged.run.state,
      updatedAt: this.deps.now?.() ?? Date.now(),
      ...(merged.error ? { error: merged.error } : {}),
    };
    this.records.set(proposal.id, next);
    this.save();
    // executor already cleans up after a successful merge; on failure the
    // worktree may still be alive, so remove it best-effort
    if (!merged.ok) await ports.removeWorktree(record.worktreeDir).catch(() => undefined);
    return { ok: merged.ok, record: next, ...(merged.error ? { error: merged.error } : {}) };
  }
}
