// The spend ledger: one timestamped NDJSON row per settled turn
// (DATA_DIR/usage-ledger.ndjson), so "what did we spend today / this week, and
// who spent it" has an answer. Task tallies (store.addTaskUsage) only know
// totals per conversation, not when the money went.
//
// Same discipline as the decision log: append-only, 0600, rotated to a single
// `.1` at a cap, and fire-and-forget — a full disk must never fail a turn.
// The last eight days stay in memory, so the summary never rereads the file.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import type { UsageSummary } from "../../shared/org-types.ts";
import { round2, startOfDay, startOfWeek } from "./util.ts";

const FILE_NAME = "usage-ledger.ndjson";
const MAX_BYTES = 4 * 1024 * 1024;
const KEEP_MS = 8 * 24 * 60 * 60_000;
export const DEFAULT_USD_TO_CNY = 7.2;

export interface LedgerRow {
  at: number;
  botId: string;
  /** null when the engine reports tokens but no price */
  costUsd: number | null;
  input: number;
  output: number;
  cachedInput?: number;
}

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;

function isRow(value: unknown): value is LedgerRow {
  const row = value as LedgerRow;
  return (
    Boolean(row) &&
    typeof row.at === "number" &&
    typeof row.botId === "string" &&
    (row.costUsd === null || typeof row.costUsd === "number")
  );
}

export class UsageLedger {
  private readonly file: string;
  private readonly maxBytes: number;
  private rowsInMemory: LedgerRow[] | null = null;

  constructor(dataDir: string, opts: { maxBytes?: number } = {}) {
    this.file = join(dataDir, FILE_NAME);
    this.maxBytes = opts.maxBytes ?? MAX_BYTES;
  }

  private load(now = Date.now()): LedgerRow[] {
    if (this.rowsInMemory) return this.rowsInMemory;
    const rows: LedgerRow[] = [];
    for (const path of [`${this.file}.1`, this.file]) {
      let text = "";
      try {
        if (!existsSync(path)) continue;
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          const value: unknown = JSON.parse(line);
          if (isRow(value) && value.at >= now - KEEP_MS) rows.push(value);
        } catch {
          /* a line torn mid-write — skip it, keep the rest */
        }
      }
    }
    this.rowsInMemory = rows;
    return rows;
  }

  /** Bank one settled turn. Rows with neither tokens nor a cost are not worth
   * a line. Returns the row written, or null. */
  record(input: { botId: string; costUsd?: number | null; input?: number; output?: number; cachedInput?: number; at?: number }): LedgerRow | null {
    const costUsd = typeof input.costUsd === "number" && Number.isFinite(input.costUsd) && input.costUsd >= 0 ? input.costUsd : null;
    const tokensIn = count(input.input);
    const tokensOut = count(input.output);
    if (!input.botId || (costUsd === null && tokensIn === 0 && tokensOut === 0)) return null;
    const row: LedgerRow = {
      at: input.at ?? Date.now(),
      botId: input.botId,
      costUsd,
      input: tokensIn,
      output: tokensOut,
      ...(input.cachedInput !== undefined ? { cachedInput: Math.min(count(input.cachedInput), tokensIn) } : {}),
    };
    const rows = this.load(row.at);
    rows.push(row);
    // forget what no summary can ask about any more
    const horizon = row.at - KEEP_MS;
    if (rows.length && rows[0]!.at < horizon) this.rowsInMemory = rows.filter((entry) => entry.at >= horizon);
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      if (existsSync(this.file) && statSync(this.file).size >= this.maxBytes) renameSync(this.file, `${this.file}.1`);
      appendFileSync(this.file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    } catch {
      /* best effort: the in-memory window still counts it */
    }
    return row;
  }

  /** Rows at or after `since`, oldest first. */
  rows(since: number, now = Date.now()): LedgerRow[] {
    return this.load(now).filter((row) => row.at >= since);
  }
}

/** Today's and this week's spend in CNY. */
export function summarizeUsage(
  rows: readonly LedgerRow[],
  opts: { now: number; usdToCny: number; budgetPerDay: number },
): UsageSummary {
  const dayStart = startOfDay(opts.now);
  const weekStart = startOfWeek(opts.now);
  const rate = Number.isFinite(opts.usdToCny) && opts.usdToCny > 0 ? opts.usdToCny : DEFAULT_USD_TO_CNY;
  let todayUsd = 0;
  let weekUsd = 0;
  let unpricedTokens = 0;
  const perBot = new Map<string, { usd: number; tokens: number }>();
  for (const row of rows) {
    if (row.at < weekStart || row.at > opts.now + 60_000) continue;
    const usd = row.costUsd ?? 0;
    weekUsd += usd;
    if (row.at < dayStart) continue;
    todayUsd += usd;
    const tokens = row.input + row.output;
    if (row.costUsd === null) unpricedTokens += tokens;
    const entry = perBot.get(row.botId) ?? { usd: 0, tokens: 0 };
    entry.usd += usd;
    entry.tokens += tokens;
    perBot.set(row.botId, entry);
  }
  const budget = Number.isFinite(opts.budgetPerDay) && opts.budgetPerDay > 0 ? opts.budgetPerDay : 0;
  const weekCost = round2(weekUsd * rate);
  return {
    currency: "CNY",
    todayCost: round2(todayUsd * rate),
    budgetPerDay: budget,
    weekPercent: budget > 0 ? Math.min(100, Math.max(0, Math.round((weekCost / (budget * 7)) * 100))) : null,
    byBot: [...perBot.entries()]
      .map(([botId, entry]) => ({ botId, cost: round2(entry.usd * rate), tokens: entry.tokens }))
      .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
    unpricedTokens,
    weekCost,
    usdToCny: rate,
  };
}
