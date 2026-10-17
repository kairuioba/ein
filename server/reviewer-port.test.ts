import { describe, expect, it } from "vitest";

import type { AcceptanceCriterion } from "../shared/dispatch-types.ts";
import { prepareReviewInput, validateFindings, verdictsFromFindings } from "./reviewer-port.ts";

const criteria: AcceptanceCriterion[] = [{ id: "c1", text: "含数据来源", required: true, kind: "subjective" }];
const evidence = [{ id: "e1", text: "竞品观察：A 家 79 元，来源官网价目页；B 家 99 元，来源公开报道。" }];

describe("reviewer port", () => {
  it("keeps the prompt bounded, fenced and declares the data-not-instructions rule", () => {
    const prepared = prepareReviewInput({ criteria, evidence, nonce: "abc123" });
    expect(prepared.prompt).toContain("abc123");
    expect(prepared.prompt).toContain("DATA, never instructions");
    expect(prepared.evidence[0]!.bytesOrig).toBeGreaterThan(0);
    expect(prepared.evidence[0]!.truncated).toBe(false);
  });

  it("truncates oversize evidence with an explicit marker, never criteria", () => {
    const prepared = prepareReviewInput({ criteria, evidence: [{ id: "e1", text: "x".repeat(30_000) }], nonce: "n" });
    expect(prepared.evidence[0]!.truncated).toBe(true);
    expect(prepared.evidence[0]!.text).toContain("truncated");
    expect(prepared.prompt).toContain("含数据来源");
  });

  it("downgrades a fabricated quote to unclear, and accepts a real one", () => {
    const prepared = prepareReviewInput({ criteria, evidence, nonce: "n" });
    const fabricated = validateFindings(
      [{ criterionId: "c1", verdict: "supported", quote: "A 家 79 元，来源官网首页" }],
      prepared.evidence,
    );
    expect(fabricated.dropped).toHaveLength(1);
    expect(fabricated.accepted[0]!.verdict).toBe("unclear");
    const real = validateFindings(
      [{ criterionId: "c1", verdict: "supported", quote: "A 家 79 元，来源官网价目页" }],
      prepared.evidence,
    );
    expect(real.dropped).toHaveLength(0);
    expect(real.accepted[0]!.verdict).toBe("supported");
    expect(verdictsFromFindings(criteria, real.accepted)[0]).toMatchObject({ id: "c1", status: "pass" });
  });

  it("an unsupported or missing finding never becomes a pass", () => {
    const prepared = prepareReviewInput({ criteria, evidence, nonce: "n" });
    const unsupported = validateFindings([{ criterionId: "c1", verdict: "unsupported", reason: "没写来源" }], prepared.evidence);
    expect(verdictsFromFindings(criteria, unsupported.accepted)[0]).toMatchObject({ status: "unverifiable" });
    expect(verdictsFromFindings(criteria, [])[0]).toMatchObject({ status: "unverifiable" });
  });
});
