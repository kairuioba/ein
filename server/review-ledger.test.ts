// ReviewLedger 的落盘/重载/折叠测试。全部用临时目录，绝不碰 ~/.ein。
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { reviewLedgerPath, ReviewLedger, summarizeReviewLedger, type ReviewLedgerEntry } from "./review-ledger.ts";

const scratchDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ein-review-ledger-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const entry = (overrides: Partial<ReviewLedgerEntry> = {}): ReviewLedgerEntry => ({
  outcome: "ok",
  failure: null,
  quoteDropped: 0,
  at: 1_700_000_000_000,
  ...overrides,
});

describe("ReviewLedger", () => {
  it("appends JSONL that a fresh instance can reload in order", () => {
    const path = join(tempDir(), "nested", "review-ledger.jsonl");
    const ledger = new ReviewLedger(path);
    ledger.append(entry({ runId: "r1", tokensIn: 10, tokensOut: 2, costUsd: 0.001 }));
    ledger.append(entry({ runId: "r2", outcome: "degraded", failure: "timeout" }));

    const reloaded = new ReviewLedger(path).list();
    expect(reloaded.map((row) => row.runId)).toEqual(["r1", "r2"]);
    expect(reloaded[0]).toMatchObject({ outcome: "ok", tokensIn: 10, tokensOut: 2, costUsd: 0.001 });
    expect(reloaded[1]).toMatchObject({ outcome: "degraded", failure: "timeout" });
  });

  it("skips a torn last line instead of losing the whole ledger", () => {
    const path = join(tempDir(), "review-ledger.jsonl");
    const ledger = new ReviewLedger(path);
    ledger.append(entry({ runId: "r1" }));
    appendFileSync(path, '{"runId":"half";'); // crash mid-write
    ledger.append(entry({ runId: "r2" }));

    expect(ledger.list().map((row) => row.runId)).toEqual(["r1", "r2"]);
  });

  it("treats a missing or unreadable ledger as empty", () => {
    expect(new ReviewLedger(join(tempDir(), "absent.jsonl")).list()).toEqual([]);
  });

  it("returns the most recent rows in file order for a positive limit", () => {
    const ledger = new ReviewLedger(join(tempDir(), "review-ledger.jsonl"));
    for (const runId of ["r1", "r2", "r3"]) ledger.append(entry({ runId }));
    expect(ledger.list(2).map((row) => row.runId)).toEqual(["r2", "r3"]);
    expect(ledger.list(0).map((row) => row.runId)).toEqual(["r1", "r2", "r3"]);
  });

  it("summarizes reviews, failures and cost as a pure fold", () => {
    const summary = summarizeReviewLedger([
      entry({ tokensIn: 100, tokensOut: 20, costUsd: 0.01 }),
      entry({ outcome: "degraded", failure: "quote_mismatch", quoteDropped: 1, tokensIn: 50, tokensOut: 5 }),
      entry({ outcome: "degraded", failure: "bad_json" }),
      entry({ outcome: "degraded" }),
    ]);
    expect(summary).toEqual({
      reviews: 4,
      ok: 1,
      degraded: 3,
      failures: { none: 2, quote_mismatch: 1, bad_json: 1 },
      tokensIn: 150,
      tokensOut: 25,
      costUsd: 0.01,
      quoteDropped: 1,
    });
  });

  it("derives the default path from the data dir (never touching it in tests)", () => {
    expect(reviewLedgerPath("/tmp/ein-data")).toBe(join("/tmp/ein-data", "review-ledger.jsonl"));
  });
});
