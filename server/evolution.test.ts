// 自我进化阶段 3：失败模式归并 + 改进提案 + 提案存储。
// 只用硬事实（复盘记录 / 派单 gate、handoff、退回次数）构造数据，不碰模型。
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DispatchRun, DispatchSubtask, SubtaskGate } from "../shared/dispatch-types.ts";
import type { DispatchRetro } from "./dispatch.ts";
import { deriveSignals, EvolutionStore, proposeImprovements, type EvolutionProposal } from "./evolution.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const NOW = new Date(2026, 9, 18, 9, 0, 0).getTime(); // 2026-10-18 09:00
const HOUR = 3_600_000;

const subtask = (id: string, extra: Partial<DispatchSubtask> = {}): DispatchSubtask => ({
  id,
  title: `任务 ${id}`,
  brief: "",
  role: "前端工程师",
  needs: [],
  difficulty: 2,
  dependsOn: [],
  assigneeBotId: "bot-1",
  status: "done",
  attempts: 1,
  ...extra,
});

const gate = (extra: Partial<SubtaskGate> = {}): SubtaskGate => ({
  status: "needs_human",
  criteria: [],
  deterministic: [],
  at: NOW,
  ...extra,
});

const run = (subtasks: DispatchSubtask[], extra: Partial<DispatchRun> = {}): DispatchRun => ({
  id: "run-1",
  chiefBotId: "chief",
  sourceThreadId: "t-chief",
  goal: "官网改版",
  policy: "balanced",
  status: "done",
  subtasks,
  createdAt: NOW - 2 * HOUR,
  updatedAt: NOW,
  ...extra,
});

const retroSub = (id: string, extra: Partial<DispatchRetro["subtasks"][number]> = {}): DispatchRetro["subtasks"][number] => ({
  id,
  title: `任务 ${id}`,
  role: "前端工程师",
  status: "done",
  attempts: 1,
  assigneeBotId: "bot-1",
  ...extra,
});

const retro = (subtasks: DispatchRetro["subtasks"], extra: Partial<DispatchRetro> = {}): DispatchRetro => ({
  at: NOW,
  runId: "retro-run-1",
  goal: "官网改版",
  status: "done",
  chiefBotId: "chief",
  startedAt: NOW - 2 * HOUR,
  finishedAt: NOW,
  durationMs: 2 * HOUR,
  versions: { schema: 2, prompt: 1, gate: 1, models: [] },
  counts: { total: subtasks.length, done: subtasks.filter((entry) => entry.status === "done").length, failed: 0, canceled: 0, skipped: 0, retried: 0 },
  subtasks,
  ...extra,
});

const patterns = (signals: ReturnType<typeof deriveSignals>) => signals.map((signal) => signal.pattern);

describe("deriveSignals", () => {
  it("returns nothing when there is no history to learn from", () => {
    expect(deriveSignals()).toEqual([]);
    expect(deriveSignals({ retros: [], runs: [], now: NOW })).toEqual([]);
    expect(proposeImprovements([])).toEqual([]);
  });

  it("turns a gate's needs_human into missing acceptance or handoff signals", () => {
    const signals = deriveSignals({
      now: NOW,
      runs: [
        run([
          // 有验收标准，但只能靠人判（没有独立评审）
          subtask("page", {
            criteria: [{ id: "c1", text: "页面能打开且没有报错", required: true, kind: "subjective" }],
            gate: gate({ reason: "2 required criterion(ia) cannot be verified without a reviewer" }),
          }),
          // 员工没写交接单，闸门只能要人看
          subtask("copy", {
            criteria: [{ id: "c2", text: "文案通顺", required: true, kind: "subjective" }],
            handoff: { status: "done", summary: "写完了", synthetic: true },
            gate: gate({ reason: "the worker did not use the handoff envelope" }),
          }),
        ]),
      ],
    });
    const byPattern = new Map(signals.map((signal) => [signal.pattern, signal]));
    expect(byPattern.get("missing_acceptance")).toMatchObject({
      id: "signal-missing_acceptance",
      count: 1,
      evidence: [expect.stringContaining("验收标准")],
    });
    expect(byPattern.get("missing_handoff")).toMatchObject({
      count: 2,
      evidence: expect.arrayContaining([expect.stringContaining("交接单")]),
    });
    // 稳定：同样的输入再次派生，id 和次数都不变
    const again = deriveSignals({ now: NOW, runs: [] });
    expect(again).toEqual([]);
  });

  it("flags a declared artifact the gate could not find", () => {
    const signals = deriveSignals({
      now: NOW,
      runs: [
        run([
          subtask("build", {
            criteria: [{ id: "c1", text: "dist/index.html 存在", required: true, kind: "deterministic" }],
            handoff: { status: "done", summary: "打好了", artifacts: ["dist/index.html"] },
            gate: gate({
              criteria: [{ id: "c1", status: "unverifiable", evidence: "missing: dist/index.html" }],
              deterministic: [{ name: "artifacts", ok: false, unverifiable: true, detail: "missing: dist/index.html" }],
              reason: "cannot verify: artifacts",
            }),
          }),
        ]),
      ],
    });
    expect(signals).toEqual([
      expect.objectContaining({
        pattern: "artifact_missing",
        count: 1,
        evidence: [expect.stringContaining("dist/index.html")],
      }),
    ]);
  });

  it("reports a subtask the owner sent back twice or more", () => {
    const criteria = [{ id: "c1", text: "标题具体", required: true, kind: "deterministic" as const }];
    const handoff = { status: "done" as const, summary: "写完了", artifacts: ["copy.md"] };
    const runWith = (reworkCount: number) => run([subtask("copy", { criteria, handoff, reworkCount, reworkNote: "标题不够具体" })]);
    const looped = deriveSignals({ now: NOW, runs: [runWith(2)] });
    expect(looped).toEqual([
      expect.objectContaining({ pattern: "rework_loop", count: 1, evidence: [expect.stringContaining("标题不够具体")] }),
    ]);
    // one send-back is normal review, not a pattern
    expect(patterns(deriveSignals({ now: NOW, runs: [runWith(1)] }))).not.toContain("rework_loop");
  });

  it("reports subtasks that ran out of retries, from runs and from retros", () => {
    const signals = deriveSignals({
      now: NOW,
      runs: [
        run([
          subtask("api", {
            criteria: [{ id: "c1", text: "接口返回 200", required: true, kind: "deterministic" }],
            status: "failed",
            attempts: 2,
            error: "接口 500",
          }),
        ]),
      ],
      retros: [retro([retroSub("api", { status: "failed", attempts: 2 })])],
    });
    expect(signals).toEqual([
      expect.objectContaining({
        pattern: "failed_exhausted",
        count: 2,
        evidence: [expect.stringContaining("接口 500"), expect.stringContaining("复盘")],
      }),
    ]);
    // a first failure with retries left is not exhausted
    expect(deriveSignals({ now: NOW, runs: [run([subtask("api", { status: "failed", attempts: 1 })])] }).map((signal) => signal.pattern)).not.toContain(
      "failed_exhausted",
    );
  });

  it("reports a run or subtask with no activity for two hours", () => {
    const stalledSubtask = subtask("build", { status: "running", attempts: 1, startedAt: NOW - 3 * HOUR });
    const signals = deriveSignals({
      now: NOW,
      runs: [run([stalledSubtask], { status: "running", updatedAt: NOW - 3 * HOUR })],
      retros: [retro([retroSub("build")], { durationMs: 4 * HOUR })],
    });
    expect(signals).toEqual([
      expect.objectContaining({
        pattern: "stalled",
        count: 2,
        evidence: [expect.stringContaining("分钟没有任何进展"), expect.stringContaining("小时才结束")],
      }),
    ]);
  });

  it("spots a role that only delivered after switching models", () => {
    const retros = [
      retro([retroSub("a", { status: "failed", ranWith: { instanceId: "codex", model: "cheap-model" } })], { runId: "r1" }),
      retro([retroSub("b", { status: "done", ranWith: { instanceId: "claude", model: "strong-model" } })], { runId: "r2" }),
    ];
    const mismatch = deriveSignals({ now: NOW, retros });
    expect(mismatch).toEqual([
      expect.objectContaining({ pattern: "model_mismatch", count: 1 }),
    ]);
    expect(mismatch[0]!.evidence[0]).toContain("cheap-model");
    expect(mismatch[0]!.evidence[0]).toContain("strong-model");
    // the same model failing and succeeding says nothing about model choice
    const sameModel = [
      retro([retroSub("a", { status: "failed", ranWith: { instanceId: "codex", model: "one-model" } })], { runId: "r1" }),
      retro([retroSub("b", { status: "done", ranWith: { instanceId: "codex", model: "one-model" } })], { runId: "r2" }),
    ];
    expect(deriveSignals({ now: NOW, retros: sameModel })).toEqual([]);
  });
});

describe("proposeImprovements", () => {
  it("writes one readable Chinese proposal per signal, with evidence and a risk", () => {
    const signals = deriveSignals({
      now: NOW,
      runs: [
        run([
          subtask("page", {
            criteria: [{ id: "c1", text: "页面能打开", required: true, kind: "subjective" }],
            gate: gate({ reason: "needs a human reviewer" }),
          }),
          subtask("copy", { reworkCount: 3 }),
        ]),
      ],
    });
    expect(signals.length).toBeGreaterThanOrEqual(2);
    const proposals = proposeImprovements(signals);
    expect(proposals).toHaveLength(signals.length);
    for (const [index, proposal] of proposals.entries()) {
      const signal = signals[index]!;
      expect(proposal).toMatchObject({
        signal: signal.pattern,
        status: "open",
        evidence: signal.evidence,
      });
      expect(proposal.id).toMatch(/^evo-/);
      expect(["prompt", "plan_template", "code", "ui", "process"]).toContain(proposal.area);
      expect(["low", "medium", "high"]).toContain(proposal.risk);
      // 中文可读，不把 attempt/criteria 这类黑话直接丢给老板
      for (const text of [proposal.title, proposal.why, proposal.suggestedChange]) {
        expect(text).toMatch(/[\u4e00-\u9fff]/);
        expect(text).not.toMatch(/\b(attempt|attempts|criteria|handoff|gate)\b/i);
      }
      expect(proposal.why).toContain(String(signal.count));
      expect(proposal.why).toContain(signal.evidence[0]!);
    }
  });
});

describe("EvolutionStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ein-evolution-"));
  });
  afterEach(async () => {
    await removeTempDir(dir);
  });

  const signals = () =>
    deriveSignals({
      now: NOW,
      runs: [run([subtask("copy", { reworkCount: 3 }), subtask("api", { status: "failed", attempts: 2 })])],
    });

  it("persists proposals and reloads them", () => {
    const store = new EvolutionStore(dir);
    const created = signals();
    const proposals = proposeImprovements(created);
    const { added, skipped } = store.append(proposals, NOW);
    expect(added).toHaveLength(proposals.length);
    expect(skipped).toBe(0);
    expect(added.every((item) => item.status === "open" && item.createdAt === NOW)).toBe(true);

    const reloaded = new EvolutionStore(dir);
    expect(reloaded.list("all").map((item) => item.signal)).toEqual(proposals.map((proposal) => proposal.signal));
    const raw = JSON.parse(readFileSync(join(dir, "evolution.json"), "utf8")) as EvolutionProposal[];
    expect(raw).toHaveLength(proposals.length);
  });

  it("does not stack a second open proposal for the same signal", () => {
    const store = new EvolutionStore(dir);
    const proposals = proposeImprovements(signals());
    store.append(proposals, NOW);
    const again = store.append(proposals, NOW + 1);
    expect(again.added).toEqual([]);
    expect(again.skipped).toBe(proposals.length);
    expect(store.list("open")).toHaveLength(proposals.length);
  });

  it("records the owner's decision once, keeps the note, and remembers it", () => {
    const store = new EvolutionStore(dir);
    const [item] = store.append(proposeImprovements(signals()), NOW).added;
    expect(store.resolve(item!.id, "accepted", "排进下个开发版")).toMatchObject({
      id: item!.id,
      status: "accepted",
      note: "排进下个开发版",
      resolvedAt: expect.any(Number),
    });
    // a second decision does not overwrite the first
    expect(store.resolve(item!.id, "rejected")).toMatchObject({ status: "accepted", note: "排进下个开发版" });
    // unknown ids are an error the route maps to 404
    expect(store.resolve("missing", "deferred")).toEqual({ error: expect.any(String) });
    // a resolved signal may be proposed again later, so improvements are not blocked for ever
    const next = store.append(proposeImprovements(signals()), NOW + 1);
    expect(next.added.map((entry) => entry.signal)).toContain(item!.signal);
    expect(new EvolutionStore(dir).list("all").find((entry) => entry.id === item!.id)).toMatchObject({ status: "accepted" });
  });

  it("starts empty when the file is missing or unreadable", () => {
    expect(new EvolutionStore(dir).list("all")).toEqual([]);
    const broken = mkdtempSync(join(tmpdir(), "ein-evolution-broken-"));
    try {
      writeFileSync(join(broken, "evolution.json"), "{not json");
      const store = new EvolutionStore(broken);
      expect(store.list("all")).toEqual([]);
      expect(store.append(proposeImprovements(signals()), NOW).added).toHaveLength(signals().length);
    } finally {
      void removeTempDir(broken);
    }
  });
});
