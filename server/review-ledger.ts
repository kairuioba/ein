// ReviewLedger：评审的落盘账本（~/.ein/review-ledger.jsonl）。
//
// 一行一次评审（JSONL，追加写，崩溃只可能丢最后一行）。office 的成本汇总、
// 「review 到底跑没跑、花了多少、失败在哪一类」都从这里读；它不做裁决，
// 也不参与 gate —— 评审结果只走 runReview 的返回值。
//
// 设计取舍：
//   - append/list 足够简单，不需要数据库；失败（磁盘满、只读）由调用方
//     （runReview）吞掉，绝不改变评审结论。
//   - list 逐行容错：崩溃留下的半行/坏行跳过，不让一份坏数据毁掉整个账本。
//   - summarize 是纯函数，测试和 UI 可以脱离文件使用。
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, join } from "node:path";

import { DATA_DIR } from "./config.ts";

export type ReviewOutcome = "ok" | "degraded";

/** 一行评审记录。字段全部可选（除 outcome），因为 host 不一定会报成本。 */
export interface ReviewLedgerEntry {
  runId?: string;
  subtaskId?: string;
  attemptId?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  durationMs?: number;
  outcome: ReviewOutcome;
  failure?: string | null;
  /** 被 quote 逐字校验拒绝的 finding 数 */
  quoteDropped?: number;
  /** 评审开始时刻（ms）；注入 now 时是调用方给的时钟 */
  at?: number;
}

export interface ReviewLedgerSummary {
  reviews: number;
  ok: number;
  degraded: number;
  /** failure 枚举 → 次数（null/缺省记作 "none"） */
  failures: Record<string, number>;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  quoteDropped: number;
}

/** 默认账本路径。<DATA_DIR> 跟随 OMB_DATA_DIR（测试/浸泡环境隔离）。 */
export function reviewLedgerPath(dataDir = DATA_DIR): string {
  return join(dataDir, "review-ledger.jsonl");
}

/** A crash can leave a half-written last line. Repair it before appending so
 * the NEXT review is not glued onto the torn fragment (JSONL needs one record
 * per line); the torn line itself stays and is skipped by list(). */
function endsWithNewline(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const { size } = fstatSync(fd);
    if (!size) return true;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } catch {
    return true; // no file yet (or unreadable): append starts a fresh line
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function isEntry(value: unknown): value is ReviewLedgerEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const outcome = (value as { outcome?: unknown }).outcome;
  return outcome === "ok" || outcome === "degraded";
}

export class ReviewLedger {
  readonly path: string;

  constructor(path: string = reviewLedgerPath()) {
    this.path = path;
  }

  /** 追加一行。写失败会抛给直接调用方；runReview 会吞掉它。 */
  append(entry: ReviewLedgerEntry): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const prefix = endsWithNewline(this.path) ? "" : "\n";
    appendFileSync(this.path, `${prefix}${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  /** 最近的 `limit` 条（文件顺序，旧→新）。账本不存在/不可读时返回空数组；
   * 坏行跳过（崩溃可能留下半行）。limit <= 0 表示全部。 */
  list(limit = 200): ReviewLedgerEntry[] {
    let text = "";
    try {
      text = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    const entries: ReviewLedgerEntry[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (isEntry(parsed)) entries.push(parsed);
    }
    return limit > 0 ? entries.slice(-limit) : entries;
  }
}

/** 纯函数折叠：成本/失败分布。office 和测试共用，不读文件。 */
export function summarizeReviewLedger(entries: readonly ReviewLedgerEntry[]): ReviewLedgerSummary {
  const summary: ReviewLedgerSummary = {
    reviews: 0,
    ok: 0,
    degraded: 0,
    failures: {},
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    quoteDropped: 0,
  };
  for (const entry of entries) {
    summary.reviews += 1;
    if (entry.outcome === "ok") summary.ok += 1;
    else summary.degraded += 1;
    const failure = entry.failure ?? "none";
    summary.failures[failure] = (summary.failures[failure] ?? 0) + 1;
    if (typeof entry.tokensIn === "number") summary.tokensIn += entry.tokensIn;
    if (typeof entry.tokensOut === "number") summary.tokensOut += entry.tokensOut;
    if (typeof entry.costUsd === "number") summary.costUsd += entry.costUsd;
    if (typeof entry.quoteDropped === "number") summary.quoteDropped += entry.quoteDropped;
  }
  return summary;
}
