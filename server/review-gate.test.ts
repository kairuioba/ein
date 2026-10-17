import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { criteriaFor, evaluateGate } from "./review-gate.ts";

const base = {
  acceptance: undefined,
  criteria: undefined,
  handoff: undefined,
  result: "done",
  currentAttemptId: "a1",
} as const;

describe("acceptance gate", () => {
  it("maps a legacy acceptance string to one required subjective criterion", () => {
    expect(criteriaFor({ ...base, acceptance: "三段以内" })).toEqual([
      { id: "legacy-1", text: "三段以内", required: true, kind: "subjective" },
    ]);
    expect(criteriaFor({ ...base })).toEqual([]);
  });

  it("passes an empty gate when there are no criteria", () => {
    expect(evaluateGate({ subtask: { ...base } })).toMatchObject({ status: "pass", provisional: true, criteria: [] });
  });

  it("an empty result fails, a missing envelope only needs a human", () => {
    const empty = evaluateGate({
      subtask: {
        ...base,
        criteria: [{ id: "c1", text: "写三段", required: true, kind: "deterministic", check: "handoff" }],
        result: "",
        handoff: undefined,
      },
    });
    expect(empty.status).toBe("fail");
    expect(empty.deterministic?.find((check) => check.name === "result")?.ok).toBe(false);
    const envelopeMissing = evaluateGate({
      subtask: {
        ...base,
        criteria: [{ id: "c1", text: "写三段", required: true, kind: "deterministic", check: "handoff" }],
        result: "写了三段，但没有信封",
        handoff: undefined,
      },
    });
    expect(envelopeMissing.status).toBe("needs_human");
    expect(envelopeMissing.deterministic?.find((check) => check.name === "handoff")?.unverifiable).toBe(true);
  });

  it("a subjective criterion without a reviewer becomes needs_human, never a silent pass", () => {
    const gate = evaluateGate({
      subtask: {
        ...base,
        criteria: [{ id: "c1", text: "文风好", required: true, kind: "subjective" }],
        handoff: { status: "done", summary: "写了三段" },
      },
    });
    expect(gate.status).toBe("needs_human");
    expect(gate.criteria[0]).toMatchObject({ id: "c1", status: "unverifiable" });
  });

  it("a worker that reports acceptance not met always needs a human", () => {
    const gate = evaluateGate({
      subtask: {
        ...base,
        criteria: [{ id: "c1", text: "三段", required: true, kind: "deterministic", check: "result" }],
        handoff: { status: "done", summary: "只写了一段", acceptanceMet: false },
      },
    });
    expect(gate.status).toBe("needs_human");
  });

  it("checks declared artifacts against the working folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "ein-gate-"));
    writeFileSync(join(dir, "copy.md"), "三段文案");
    const good = evaluateGate({
      subtask: { ...base, criteria: [{ id: "c1", text: "产物存在", required: true, kind: "deterministic", check: "artifacts" }], handoff: { status: "done", summary: "三段", artifacts: ["copy.md"] } },
      cwd: dir,
    });
    expect(good.deterministic?.find((check) => check.name === "artifacts")?.ok).toBe(true);
    const bad = evaluateGate({
      subtask: { ...base, criteria: [{ id: "c1", text: "产物存在", required: true, kind: "deterministic", check: "artifacts" }], handoff: { status: "done", summary: "三段", artifacts: ["missing.md"] } },
      cwd: dir,
    });
    expect(bad.status).toBe("fail");
  });
});
