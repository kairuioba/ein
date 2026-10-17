// 自我进化阶段4的流水线状态机（纯逻辑，git/测试/reviewer 都是外部端口）。
// 红线：没有老板 approve-merge，任何产物都不能进主分支。
export type PipelineState =
  | "accepted" | "provisioning" | "implementing" | "guarding" | "testing" | "reviewing" | "merge_ready" | "merged"
  | "aborted" | "rejected" | "expired";

export interface PipelineRun {
  id: string;
  state: PipelineState;
  headSha?: string;
  baseSha: string;
  testFailures: number;
  reviewBlocks: number;
  implementRounds: number;
  guardOkAtHead?: string;
  testsOkAtHead?: string;
  reviewOkAtHead?: string;
  ownerApprovedAtHead?: string;
  updatedAt: number;
}

export type PipelineEvent =
  | { type: "provision"; baseSha: string }
  | { type: "implement"; headSha: string }
  | { type: "guard_pass" }
  | { type: "guard_violation"; reason: string }
  | { type: "test_pass" }
  | { type: "test_fail"; reason: string }
  | { type: "review_pass" }
  | { type: "review_block"; reason: string }
  | { type: "approve_merge"; headSha: string; by: "owner" | "bot" }
  | { type: "abort"; reason: string }
  | { type: "expire" };

export interface PipelineTransition {
  ok: boolean;
  run: PipelineRun;
  reason?: string;
  /** ok=false but the run state changed: callers MUST persist `run` */
  persist?: boolean;
}

const TERMINAL = new Set<PipelineState>(["merged", "aborted", "rejected", "expired"]);
export const MAX_TEST_FAILURES = 2;
export const MAX_REVIEW_BLOCKS = 2;
export const MAX_IMPLEMENT_ROUNDS = 3;

const fail = (run: PipelineRun, reason: string, state?: PipelineState): PipelineTransition => ({
  ok: false,
  run: state ? { ...run, state, updatedAt: Date.now() } : run,
  reason,
  ...(state ? { persist: true } : {}),
});

export function transition(run: PipelineRun, event: PipelineEvent, now = Date.now()): PipelineTransition {
  if (TERMINAL.has(run.state)) return fail(run, `terminal state ${run.state}`);
  const next = (patch: Partial<PipelineRun>, state: PipelineState): PipelineTransition => ({
    ok: true,
    run: { ...run, ...patch, state, updatedAt: now },
    ...(state === "rejected" || state === "aborted" ? { reason: event.type } : {}),
  });
  switch (event.type) {
    case "provision":
      if (run.state !== "accepted") return fail(run, "provision only from accepted");
      return next({ baseSha: event.baseSha }, "provisioning");
    case "implement":
      if (run.state !== "provisioning" && run.state !== "implementing" && run.state !== "testing" && run.state !== "reviewing" && run.state !== "merge_ready" && run.state !== "guarding") return fail(run, "implement not allowed here");
      if (run.implementRounds + 1 > MAX_IMPLEMENT_ROUNDS) return fail(run, "too many implement rounds", "rejected");
      return next({ headSha: event.headSha, implementRounds: run.implementRounds + 1, guardOkAtHead: undefined, testsOkAtHead: undefined, reviewOkAtHead: undefined }, "implementing");
    case "guard_pass":
      if (run.state !== "implementing" && run.state !== "guarding") return fail(run, "guard_pass only after implement or re-guard");
      return next({ guardOkAtHead: run.headSha }, "testing");
    case "guard_violation":
      // violations are never retried: retrying would invite bypassing the guard
      return fail(run, event.reason, "rejected");
    case "test_pass":
      if (run.state !== "testing") return fail(run, "test_pass only while testing");
      return next({ testsOkAtHead: run.headSha }, "reviewing");
    case "test_fail": {
      if (run.state !== "testing") return fail(run, "test_fail only while testing");
      const failures = run.testFailures + 1;
      if (failures > MAX_TEST_FAILURES) return fail({ ...run, testFailures: failures }, "tests failed too often", "rejected");
      return next({ testFailures: failures }, "implementing");
    }
    case "review_pass":
      if (run.state !== "reviewing") return fail(run, "review_pass only while reviewing");
      return next({ reviewOkAtHead: run.headSha }, "merge_ready");
    case "review_block": {
      if (run.state !== "reviewing") return fail(run, "review_block only while reviewing");
      const blocks = run.reviewBlocks + 1;
      if (blocks > MAX_REVIEW_BLOCKS) return fail({ ...run, reviewBlocks: blocks }, "review blocked too often", "rejected");
      return next({ reviewBlocks: blocks }, "implementing");
    }
    case "approve_merge": {
      if (event.by !== "owner") return fail(run, "only the owner may approve a merge");
      if (run.state !== "merge_ready") return fail(run, "merge only from merge_ready");
      if (!run.headSha || event.headSha !== run.headSha) return fail(run, "head sha changed — re-run guard and tests", "guarding");
      if (run.guardOkAtHead !== run.headSha || run.testsOkAtHead !== run.headSha || run.reviewOkAtHead !== run.headSha) {
        return fail(run, "guard/tests/review did not pass at this head sha", "guarding");
      }
      return next({ ownerApprovedAtHead: event.headSha }, "merged");
    }
    case "abort":
      return fail(run, event.reason, "aborted");
    case "expire":
      return fail(run, "expired", "expired");
    default:
      return fail(run, "unknown event");
  }
}

/** Pure render of what the owner would see for a proposal in the pipeline. */
export function pipelineHeadline(run: PipelineRun): string {
  switch (run.state) {
    case "accepted": return "已采纳，等待开始";
    case "provisioning": return "正在准备独立工作区";
    case "implementing": return `维护机器人在改（第 ${run.implementRounds} 轮）`;
    case "guarding": return "正在检查改动范围";
    case "testing": return "正在跑测试";
    case "reviewing": return "独立评审中";
    case "merge_ready": return "等待你批准合并";
    case "merged": return "已合并";
    case "rejected": return "已拒绝（改动不合规或未通过）";
    case "aborted": return "已放弃";
    case "expired": return "已过期";
  }
}
