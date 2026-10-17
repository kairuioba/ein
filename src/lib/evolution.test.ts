// 自我进化卡片的纯逻辑 + 服务端渲染自检：挑选「最高优先」提案、why 截断、
// 证据最多 3 条，以及不展开时卡片上不出现实现黑话。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EvolutionCard } from "@/components/EvolutionCard";
import {
  clipWhy,
  EMPTY_EVOLUTION,
  evidenceLines,
  openProposals,
  resolveEvolutionProposal,
  topOpenProposal,
  type EvolutionFeed,
  type EvolutionProposal,
} from "./evolution";

const proposal = (patch: Partial<EvolutionProposal> = {}): EvolutionProposal => ({
  id: "evo-1",
  signal: "missing_handoff",
  title: "员工交付缺少结构化交接单",
  why: "有 2 次交付只给了自然语言，没有交接单。",
  suggestedChange: "在员工提示词里固定要求交接单信封。",
  area: "prompt",
  risk: "low",
  evidence: ["「官网改版」的「任务 copy」交付时没有写结构化交接单"],
  status: "open",
  createdAt: 100,
  ...patch,
});

const feed = (proposals: EvolutionProposal[]): EvolutionFeed => ({
  signals: [],
  proposals,
  open: proposals.filter((item) => item.status === "open").length,
});

describe("clipWhy", () => {
  it("keeps a short why intact and collapses its whitespace", () => {
    expect(clipWhy("  一句   很短的原因\n第二行 ")).toBe("一句 很短的原因 第二行");
  });

  it("cuts a long why to 120 characters including the ellipsis", () => {
    const clipped = clipWhy("字".repeat(300));
    expect(Array.from(clipped)).toHaveLength(120);
    expect(clipped.endsWith("…")).toBe(true);
  });

  it("counts Unicode code points, not UTF-16 units", () => {
    const clipped = clipWhy("😀".repeat(200), 10);
    expect(Array.from(clipped)).toHaveLength(10);
    expect(clipped.startsWith("😀")).toBe(true);
  });
});

describe("evidenceLines", () => {
  it("drops blank/duplicate lines and keeps at most three", () => {
    expect(
      evidenceLines({
        evidence: [" 第一条 ", "", "第一条", "第二条", "第三条", "第四条"],
      }),
    ).toEqual(["第一条", "第二条", "第三条"]);
  });

  it("handles a proposal with no evidence", () => {
    expect(evidenceLines({ evidence: [] })).toEqual([]);
  });
});

describe("topOpenProposal", () => {
  it("returns the highest-risk open proposal, then the oldest", () => {
    const low = proposal({ id: "low", risk: "low", createdAt: 1 });
    const highNew = proposal({ id: "high-new", risk: "high", createdAt: 30 });
    const highOld = proposal({ id: "high-old", risk: "high", createdAt: 20 });
    expect(topOpenProposal(feed([low, highNew, highOld]))?.id).toBe("high-old");
  });

  it("ignores resolved proposals and hidden ids", () => {
    const accepted = proposal({ id: "done", status: "accepted" });
    const open = proposal({ id: "open" });
    expect(openProposals(feed([accepted, open])).map((item) => item.id)).toEqual(["open"]);
    expect(topOpenProposal(feed([accepted]))).toBeNull();
    expect(topOpenProposal(feed([open]), new Set(["open"]))).toBeNull();
  });
});

describe("resolveEvolutionProposal", () => {
  const withFetch = async (
    handler: (url: string, init?: RequestInit) => Response,
    run: (calls: Array<{ url: string; init?: RequestInit }>) => Promise<void>,
  ) => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const saved = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      return handler(url, init);
    }) as typeof fetch;
    try {
      await run(calls);
    } finally {
      globalThis.fetch = saved;
    }
  };

  it("posts the decision (with an optional trimmed reason) to the resolve route", async () => {
    await withFetch(
      () => new Response(JSON.stringify({ proposal: { id: "evo-1", status: "rejected" } }), { status: 200 }),
      async (calls) => {
        await resolveEvolutionProposal("evo-1", "rejected", "  代价太高  ");
        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe("/api/evolution/evo-1/resolve");
        expect(calls[0]!.init?.method).toBe("POST");
        expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ status: "rejected", note: "代价太高" });
      },
    );
  });

  it("omits the note when it is blank and surfaces a failed save", async () => {
    await withFetch(
      () => new Response(JSON.stringify({ error: "no such evolution proposal" }), { status: 404 }),
      async (calls) => {
        await expect(resolveEvolutionProposal("gone", "deferred", "   ")).rejects.toThrow(
          "no such evolution proposal",
        );
        expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ status: "deferred" });
      },
    );
  });
});

describe("EvolutionCard", () => {
  it("renders nothing while there is no open proposal", () => {
    expect(renderToStaticMarkup(createElement(EvolutionCard, { feed: EMPTY_EVOLUTION }))).toBe("");
    expect(
      renderToStaticMarkup(
        createElement(EvolutionCard, { feed: feed([proposal({ status: "rejected" })]) }),
      ),
    ).toBe("");
  });

  it("renders one card: title, why, three decisions, the count, evidence folded away", () => {
    const markup = renderToStaticMarkup(
      createElement(EvolutionCard, {
        feed: feed([
          proposal({ id: "low", risk: "low", why: "低风险的原因" }),
          proposal({ id: "high", risk: "high", title: "高优先的提案", why: "高风险的原因" }),
        ]),
      }),
    );
    expect(markup).toContain("The company is evolving itself");
    expect(markup).toContain("2 waiting for your call");
    // only the top (highest-risk) proposal is on the card
    expect(markup).toContain("高优先的提案");
    expect(markup).toContain("高风险的原因");
    expect(markup).not.toContain("低风险的原因");
    expect(markup).toContain("Accept");
    expect(markup).toContain("Reject");
    expect(markup).toContain("Later");
    expect(markup).toContain("See evidence");
    // evidence stays folded until asked for, and no implementation jargon leaks
    expect(markup).not.toContain("官网改版");
    expect(markup.toLowerCase()).not.toContain("attempt");
    expect(markup.toLowerCase()).not.toContain("criteria");
    expect(markup.toLowerCase()).not.toContain("gate");
  });
});
