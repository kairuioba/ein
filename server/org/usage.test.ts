import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { DEFAULT_USD_TO_CNY, summarizeUsage, UsageLedger, type LedgerRow } from "./usage.ts";
import { startOfDay, startOfWeek } from "./util.ts";

// a Thursday afternoon, local time
const NOW = new Date(2026, 9, 15, 16, 52).getTime();
const HOUR = 60 * 60_000;

describe("usage ledger", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-org-usage-"));
  });
  afterEach(async () => {
    await removeTempDir(dir);
  });

  it("appends one timestamped row per turn to usage-ledger.ndjson and skips empty turns", () => {
    const ledger = new UsageLedger(dir);
    expect(ledger.record({ botId: "a", costUsd: 0.5, input: 100, output: 20, cachedInput: 60, at: NOW })).toEqual({
      at: NOW,
      botId: "a",
      costUsd: 0.5,
      input: 100,
      output: 20,
      cachedInput: 60,
    });
    expect(ledger.record({ botId: "b", input: 10, output: 5, at: NOW })).toMatchObject({ costUsd: null, input: 10, output: 5 });
    expect(ledger.record({ botId: "c", at: NOW })).toBeNull();
    expect(ledger.record({ botId: "", costUsd: 1, at: NOW })).toBeNull();
    // junk numbers never poison the tally
    expect(ledger.record({ botId: "d", costUsd: Number.NaN, input: -5, output: 3.7, at: NOW })).toMatchObject({ costUsd: null, input: 0, output: 3 });

    const file = join(dir, "usage-ledger.ndjson");
    const lines = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as LedgerRow);
    expect(lines.map((row) => row.botId)).toEqual(["a", "b", "d"]);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("reads earlier rows back after a restart, skipping torn lines and rows older than the window", () => {
    const file = join(dir, "usage-ledger.ndjson");
    writeFileSync(
      file,
      [
        JSON.stringify({ at: NOW - 30 * 24 * HOUR, botId: "old", costUsd: 9, input: 1, output: 1 }),
        "{ torn",
        JSON.stringify({ at: NOW - HOUR, botId: "a", costUsd: 1, input: 1, output: 1 }),
        "",
      ].join("\n"),
    );
    const ledger = new UsageLedger(dir);
    expect(ledger.rows(0, NOW).map((row) => row.botId)).toEqual(["a"]);
    ledger.record({ botId: "b", costUsd: 2, at: NOW });
    expect(ledger.rows(NOW - 2 * HOUR, NOW).map((row) => row.botId)).toEqual(["a", "b"]);
  });

  it("rotates to a single .1 file at the cap and still reads across it", () => {
    const ledger = new UsageLedger(dir, { maxBytes: 200 });
    for (let i = 0; i < 6; i += 1) ledger.record({ botId: `bot-${i}`, costUsd: 0.1, input: 1000, output: 100, at: NOW + i });
    expect(existsSync(join(dir, "usage-ledger.ndjson.1"))).toBe(true);
    expect(new UsageLedger(dir).rows(0, NOW + 10).length).toBeGreaterThanOrEqual(2);
  });
});

describe("summarizeUsage", () => {
  const rows: LedgerRow[] = [
    { at: startOfWeek(NOW) - HOUR, botId: "last-week", costUsd: 100, input: 1, output: 1 },
    { at: startOfWeek(NOW) + HOUR, botId: "a", costUsd: 2, input: 100, output: 10 },
    { at: startOfDay(NOW) + HOUR, botId: "a", costUsd: 1, input: 50, output: 5 },
    { at: startOfDay(NOW) + 2 * HOUR, botId: "b", costUsd: 2.5, input: 10, output: 10 },
    { at: startOfDay(NOW) + 3 * HOUR, botId: "c", costUsd: null, input: 700, output: 300 },
  ];

  it("converts today's and this week's spend to CNY and ranks today's bots by cost", () => {
    const summary = summarizeUsage(rows, { now: NOW, usdToCny: 7, budgetPerDay: 60 });
    expect(summary.currency).toBe("CNY");
    expect(summary.todayCost).toBe(24.5);
    expect(summary.weekCost).toBe(38.5);
    expect(summary.budgetPerDay).toBe(60);
    expect(summary.weekPercent).toBe(Math.round((38.5 / 420) * 100));
    expect(summary.byBot).toEqual([
      { botId: "b", cost: 17.5, tokens: 20 },
      { botId: "a", cost: 7, tokens: 55 },
      { botId: "c", cost: 0, tokens: 1000 },
    ]);
    expect(summary.unpricedTokens).toBe(1000);
    expect(summary.usdToCny).toBe(7);
  });

  it("has no week share without a budget, caps it at 100, and falls back to the default rate", () => {
    expect(summarizeUsage(rows, { now: NOW, usdToCny: 7, budgetPerDay: 0 }).weekPercent).toBeNull();
    expect(summarizeUsage(rows, { now: NOW, usdToCny: 7, budgetPerDay: 1 }).weekPercent).toBe(100);
    const fallback = summarizeUsage(rows, { now: NOW, usdToCny: Number.NaN, budgetPerDay: 60 });
    expect(fallback.usdToCny).toBe(DEFAULT_USD_TO_CNY);
    expect(fallback.todayCost).toBe(Math.round(3.5 * DEFAULT_USD_TO_CNY * 100) / 100);
  });

  it("is empty and well-formed with no rows", () => {
    expect(summarizeUsage([], { now: NOW, usdToCny: 7.2, budgetPerDay: 60 })).toEqual({
      currency: "CNY",
      todayCost: 0,
      budgetPerDay: 60,
      weekPercent: 0,
      byBot: [],
      unpricedTokens: 0,
      weekCost: 0,
      usdToCny: 7.2,
    });
  });
});
