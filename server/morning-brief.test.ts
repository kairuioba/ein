import { describe, expect, it } from "vitest";

import { buildMorningBrief } from "./morning-brief.ts";
import type { OwnerTimeMetrics } from "./owner-metrics.ts";

const metrics = (extra: Partial<OwnerTimeMetrics> = {}): OwnerTimeMetrics => ({
  generatedAt: 1,
  decisions: { today: 2, week: 5, open: 1 },
  latency: { p50Ms: 60_000, p90Ms: 300_000, samples: 3 },
  rework: { rate: 0.2, retriedSubtasks: 1, totalSubtasks: 5 },
  automation: { ratio: null, note: "not audited" },
  waiting: { projects: 2, actionable: 1 },
  ...extra,
});

describe("morning brief", () => {
  it("leads with decisions when something is waiting", () => {
    const brief = buildMorningBrief({ metrics: metrics(), waitingProjects: 3, now: 10 });
    expect(brief).toMatchObject({ headline: "decisions", openDecisions: 1, waitingProjects: 3, reworkRate: 0.2, decisionLatencyP50Ms: 60_000, decisionsToday: 2 });
  });
  it("falls back to 'running' and then 'nothing'", () => {
    expect(buildMorningBrief({ metrics: metrics({ decisions: { today: 0, week: 0, open: 0 } }), waitingProjects: 2 }).headline).toBe("running");
    expect(buildMorningBrief({ metrics: metrics({ decisions: { today: 0, week: 0, open: 0 } }), waitingProjects: 0 }).headline).toBe("nothing");
  });
});
