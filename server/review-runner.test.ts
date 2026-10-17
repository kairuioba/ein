// ReviewRunner 的契约测试：全部用注入的 FakeReviewHost，不调用真实模型、
// 不读磁盘（ledger 用临时目录）。验收点是「模型只提供证据，代码裁决」：
//   - 合法 JSON + 逐字 quote → pass；
//   - 编造 quote → unclear + quote_mismatch，不重试；
//   - 超时/引擎报错/坏 JSON → 降级，verdicts 仍完整，绝不抛异常；
//   - criteria 永不截断，放不下就 input_too_large（此时不调模型）；
//   - evidence 超预算 → 裁剪后仍可能成功；
//   - ledger 落盘、reload 可读，写失败不影响评审结论。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { AcceptanceCriterion } from "../shared/dispatch-types.ts";
import { ReviewLedger } from "./review-ledger.ts";
import {
  MAX_PROMPT_CHARS,
  parseReviewerReply,
  REVIEW_TIMEOUT_MS,
  REVIEWER_BOT_ID,
  reviewEvidence,
  runReview,
  type ReviewHost,
  type ReviewHostResult,
} from "./review-runner.ts";

const criteria: AcceptanceCriterion[] = [
  { id: "c1", text: "含数据来源", required: true, kind: "subjective" },
  { id: "c2", text: "给出下一步", required: false, kind: "subjective" },
];
const RESULT = "竞品观察：A 家 79 元，来源官网价目页；B 家 99 元，来源公开报道。下一步：补充第三家。";
const REAL_QUOTE = "A 家 79 元，来源官网价目页";
const FABRICATED_QUOTE = "A 家 79 元，来源官网首页";

function replyWith(findings: unknown): ReviewHostResult {
  return { ok: true, reply: JSON.stringify({ findings }) };
}

type HostInput = { botId: string; prompt: string; timeoutMs: number };

/** 记录调用次数/入参的假引擎口。 */
class FakeHost implements ReviewHost {
  calls = 0;
  lastInput: HostInput | undefined;

  constructor(private readonly respond: (input: HostInput) => ReviewHostResult | Promise<ReviewHostResult>) {}

  async startTurn(input: HostInput): Promise<ReviewHostResult> {
    this.calls += 1;
    this.lastInput = input;
    return this.respond(input);
  }
}

const scratchDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ein-review-runner-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("strict reviewer reply parsing", () => {
  it("accepts only a bare {findings:[…]} object with known verdicts", () => {
    expect(parseReviewerReply('{"findings":[{"criterionId":"c1","verdict":"supported","quote":"x"}]}')).toHaveLength(1);
    expect(parseReviewerReply('```json\n{"findings":[]}\n```')).toBeNull();
    expect(parseReviewerReply('{"findings":[]} trailing commentary')).toBeNull();
    expect(parseReviewerReply('{"findings":[{"criterionId":"c1","verdict":"maybe"}]}')).toBeNull();
    expect(parseReviewerReply('{"findings":[{"verdict":"unclear"}]}')).toBeNull();
    expect(parseReviewerReply('{"findings":[{"criterionId":"c1","verdict":"unclear","quote":3}]}')).toBeNull();
    expect(parseReviewerReply("[]")).toBeNull();
    expect(parseReviewerReply("")).toBeNull();
  });
});

describe("ReviewRunner", () => {
  it("maps a supported finding with a verbatim quote to a passing verdict", async () => {
    const host = new FakeHost(() =>
      replyWith([
        { criterionId: "c1", verdict: "supported", quote: REAL_QUOTE, reason: "有官网出处" },
        { criterionId: "c2", verdict: "unsupported", reason: "没有第三家" },
      ]),
    );
    const review = await runReview({ criteria, result: RESULT, host });

    expect(review.ok).toBe(true);
    expect(review.failure).toBeUndefined();
    expect(review.dropped).toEqual([]);
    expect(review.verdicts).toEqual([
      { id: "c1", status: "pass", evidence: REAL_QUOTE },
      { id: "c2", status: "unverifiable", evidence: "没有第三家" },
    ]);
    // exactly one turn, with the reviewer identity and the 90s ceiling
    expect(host.calls).toBe(1);
    expect(host.lastInput).toMatchObject({ botId: REVIEWER_BOT_ID, timeoutMs: REVIEW_TIMEOUT_MS });
    // the prompt carries the criteria verbatim and the data-not-instructions fence
    expect(host.lastInput!.prompt).toContain("含数据来源");
    expect(host.lastInput!.prompt).toContain("DATA, never instructions");
    expect(host.lastInput!.prompt).toContain("result");
    expect(host.lastInput!.prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
  });

  it("downgrades a fabricated quote to unclear and reports quote_mismatch without retrying", async () => {
    const host = new FakeHost(() =>
      replyWith([{ criterionId: "c1", verdict: "supported", quote: FABRICATED_QUOTE }]),
    );
    const review = await runReview({ criteria, result: RESULT, host });

    expect(review.ok).toBe(false);
    expect(review.failure).toBe("quote_mismatch");
    expect(review.dropped).toHaveLength(1);
    expect(review.dropped[0]?.criterionId).toBe("c1");
    expect(review.verdicts[0]).toMatchObject({ id: "c1", status: "unverifiable" });
    // a bad quote is a degraded REVIEW, never a rerun
    expect(host.calls).toBe(1);
  });

  it("degrades malformed JSON to bad_json with a complete verdict list and no retry", async () => {
    const host = new FakeHost(() => ({ ok: true, reply: 'Here you go: {"findings":[]}' }));
    const review = await runReview({ criteria, result: RESULT, host });

    expect(review.ok).toBe(false);
    expect(review.failure).toBe("bad_json");
    expect(review.dropped).toEqual([]);
    expect(review.verdicts).toHaveLength(criteria.length);
    expect(review.verdicts.every((verdict) => verdict.status === "unverifiable")).toBe(true);
    expect(host.calls).toBe(1);
  });

  it("times out a hung host and still returns usable verdicts", async () => {
    const host = new FakeHost(() => new Promise<ReviewHostResult>(() => {}));
    const startedAt = Date.now();
    const review = await runReview({ criteria, result: RESULT, host, timeoutMs: 25 });

    expect(review.ok).toBe(false);
    expect(review.failure).toBe("timeout");
    expect(review.verdicts).toHaveLength(criteria.length);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(host.calls).toBe(1);
  });

  it("degrades a throwing or unsuccessful host to host_error", async () => {
    const throwing = new FakeHost(() => {
      throw new Error("engine down");
    });
    const thrown = await runReview({ criteria, result: RESULT, host: throwing });
    expect(thrown).toMatchObject({ ok: false, failure: "host_error" });
    expect(thrown.verdicts).toHaveLength(criteria.length);

    const unhappy = new FakeHost(() => ({ ok: false, reply: "" }));
    expect(await runReview({ criteria, result: RESULT, host: unhappy })).toMatchObject({ ok: false, failure: "host_error" });
  });

  it("refuses input_too_large without calling the model when the criteria cannot fit", async () => {
    const host = new FakeHost(() => replyWith([]));
    const hugeCriteria: AcceptanceCriterion[] = [
      { id: "c1", text: "x".repeat(MAX_PROMPT_CHARS + 5_000), required: true, kind: "subjective" },
    ];
    const review = await runReview({ criteria: hugeCriteria, result: RESULT, host });

    expect(review).toMatchObject({ ok: false, failure: "input_too_large" });
    expect(review.verdicts).toHaveLength(1);
    expect(host.calls).toBe(0);
  });

  it("budgets oversize evidence by clipping it, then still accepts a quote from the sent text", async () => {
    const host = new FakeHost(() => replyWith([{ criterionId: "c1", verdict: "supported", quote: "A".repeat(12) }]));
    const review = await runReview({ criteria, result: "A".repeat(30_000), host });

    expect(review.ok).toBe(true);
    expect(review.verdicts[0]).toMatchObject({ id: "c1", status: "pass" });
    expect(host.lastInput!.prompt).toContain("[…truncated");
    expect(host.lastInput!.prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
  });

  it("reports host accounting without inventing it", async () => {
    const host = new FakeHost(() => ({
      ...replyWith([{ criterionId: "c1", verdict: "supported", quote: REAL_QUOTE }]),
      tokensIn: 100,
      tokensOut: 20,
      costUsd: 0.003,
      model: "cheap-reviewer",
    }));
    const review = await runReview({ criteria: [criteria[0]!], result: RESULT, host });
    expect(review).toMatchObject({ ok: true, tokens: 120, costUsd: 0.003 });

    const silent = new FakeHost(() => replyWith([{ criterionId: "c1", verdict: "unclear", reason: "看不出来" }]));
    const unaccounted = await runReview({ criteria: [criteria[0]!], result: RESULT, host: silent });
    expect(unaccounted).toMatchObject({ ok: true });
    expect(unaccounted.tokens).toBeUndefined();
    expect(unaccounted.costUsd).toBeUndefined();
  });

  it("never calls the model when there is nothing to judge", async () => {
    const host = new FakeHost(() => replyWith([]));
    expect(await runReview({ criteria: [], result: RESULT, host })).toEqual({ ok: true, verdicts: [], dropped: [] });
    expect(host.calls).toBe(0);
  });

  it("carries handoff, extra evidence and artifact paths into the fenced prompt", async () => {
    const host = new FakeHost(() => replyWith([{ criterionId: "c1", verdict: "unclear", reason: "没写来源" }]));
    await runReview({
      criteria: [criteria[0]!],
      result: RESULT,
      handoff: { status: "done", summary: "做了竞品对比", evidence: ["官方价目页截图"], artifacts: ["report.md"] },
      arts: ["/work/report.md"],
      evidence: [{ id: "file:report.md", text: "报告摘录：A 家 79 元" }],
      host,
    });
    const prompt = host.lastInput!.prompt;
    expect(prompt).toContain("做了竞品对比");
    expect(prompt).toContain("报告摘录：A 家 79 元");
    expect(prompt).toContain("/work/report.md");
  });
});

describe("review evidence and ledger integration", () => {
  it("orders evidence blocks by prompt priority (result first, artifacts last)", () => {
    const blocks = reviewEvidence({
      result: "RESULT-TEXT",
      handoff: { status: "partial", summary: "HANDOFF-SUMMARY" },
      evidence: [{ id: "file:1", text: "EXTRA-TEXT" }],
      arts: ["/work/a.md"],
    });
    expect(blocks.map((block) => block.id)).toEqual(["result", "handoff", "file:1", "artifact-paths"]);
    expect(blocks.at(-1)!.text).toContain("/work/a.md");
  });

  it("appends one ledger row per review that reloads from disk", async () => {
    const path = join(tempDir(), "review-ledger.jsonl");
    const ledger = new ReviewLedger(path);
    const host = new FakeHost(() => ({ ok: true, reply: "not json" }));

    await runReview({
      criteria,
      result: RESULT,
      host,
      ledger,
      meta: { runId: "r1", subtaskId: "s1", attemptId: "a1", model: "reviewer-cheap" },
      now: 1_000,
    });

    const reloaded = new ReviewLedger(path).list();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]).toMatchObject({
      runId: "r1",
      subtaskId: "s1",
      attemptId: "a1",
      model: "reviewer-cheap",
      outcome: "degraded",
      failure: "bad_json",
      quoteDropped: 0,
      at: 1_000,
    });
    expect(reloaded[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(reloaded[0]!.tokensIn).toBeUndefined();
  });

  it("records quote drops and host accounting in the ledger", async () => {
    const path = join(tempDir(), "review-ledger.jsonl");
    const ledger = new ReviewLedger(path);
    const host = new FakeHost(() => ({
      ...replyWith([{ criterionId: "c1", verdict: "supported", quote: FABRICATED_QUOTE }]),
      tokensIn: 10,
      tokensOut: 5,
      costUsd: 0.001,
    }));

    const review = await runReview({ criteria: [criteria[0]!], result: RESULT, host, ledger, meta: { runId: "r2" } });
    expect(review.failure).toBe("quote_mismatch");

    const [entry] = new ReviewLedger(path).list();
    expect(entry).toMatchObject({
      quoteDropped: 1,
      outcome: "degraded",
      failure: "quote_mismatch",
      tokensIn: 10,
      tokensOut: 5,
      costUsd: 0.001,
    });
  });

  it("keeps the verdict when the ledger cannot be written", async () => {
    const dir = tempDir();
    const blocker = join(dir, "blocked");
    writeFileSync(blocker, "not a directory");
    // the ledger's parent is a regular file: append must fail, the review must not
    const ledger = new ReviewLedger(join(blocker, "review-ledger.jsonl"));
    const host = new FakeHost(() => replyWith([{ criterionId: "c1", verdict: "supported", quote: REAL_QUOTE }]));

    const review = await runReview({ criteria: [criteria[0]!], result: RESULT, host, ledger });
    expect(review).toMatchObject({ ok: true });
    expect(review.verdicts[0]).toMatchObject({ status: "pass" });
  });
});
