// 阶段4流水线的第一层接线：老板「采纳」一个进化提案时，生成一个可跟踪的
// pipeline run（只记录状态，不开分支、不改代码、不发版），并把这次人工批准
// 写进审计（attention-gate 的「手动批准次数」从这一刻开始累计）。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import type { ApprovalAuditStore } from "./approval-audit.ts";
import type { EvolutionItem } from "./evolution.ts";
import type { PipelineRun } from "./evolution-pipeline.ts";

const FILE = "evolution-runs.json";

export class EvolutionRunStore {
  private readonly file: string;
  private runs: PipelineRun[] = [];

  constructor(dataDir = DATA_DIR) {
    this.file = join(dataDir, FILE);
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (Array.isArray(raw)) this.runs = raw.filter((run): run is PipelineRun => Boolean(run) && typeof run.id === "string" && typeof run.state === "string");
    } catch (error) {
      console.error("evolution runs: could not read the runs file", error);
      this.runs = [];
    }
  }

  private save(): void {
    try {
      writeFileAtomic(this.file, JSON.stringify(this.runs, null, 2), { mode: 0o600 });
    } catch (error) {
      console.error("evolution runs: could not persist", error);
    }
  }

  list(): PipelineRun[] {
    return [...this.runs];
  }

  byProposal(proposalId: string): PipelineRun | undefined {
    return this.runs.find((run) => run.proposalId === proposalId);
  }

  /** Deterministic id: repeated accepts (or a replayed request) reuse the run. */
  ensureRun(item: EvolutionItem, now = Date.now()): { run: PipelineRun; created: boolean } {
    const existing = this.byProposal(item.id);
    if (existing) return { run: existing, created: false };
    const run: PipelineRun = {
      id: `evo-run:${item.id}`,
      proposalId: item.id,
      state: "accepted",
      baseSha: "",
      testFailures: 0,
      reviewBlocks: 0,
      implementRounds: 0,
      updatedAt: now,
    };
    this.runs.push(run);
    this.save();
    return { run, created: true };
  }

  /** Record the owner's manual accept as a trust-bearing audit event. The
   * actionType carries area+risk so a low-risk accept never earns trust for a
   * high-risk action. */
  onAccepted(item: EvolutionItem, audit: ApprovalAuditStore, now = Date.now()): { run: PipelineRun; auditDeduped: boolean } {
    const { run } = this.ensureRun(item, now);
    const appended = audit.append({
      idempotencyKey: `evo:accept:${item.id}`,
      event: "approved",
      actionType: `evolution.accept:${item.area}:${item.risk}`,
      project: "ein-self",
      target: item.id,
      actor: "owner",
      mode: "manual",
      ruleVersion: 1,
      decidedAt: now,
      evidence: item.evidence.slice(0, 5),
    });
    return { run, auditDeduped: appended.deduped };
  }
}
