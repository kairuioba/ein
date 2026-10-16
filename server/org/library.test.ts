import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { LIBRARY_PROMPT_MAX_BYTES, LibraryError, LibraryStore, summaryOf, truncateBytes } from "./library.ts";

const OWNER = { kind: "owner" } as const;

describe("library", () => {
  let dir: string;
  let library: LibraryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-org-library-"));
    library = new LibraryStore(dir);
  });
  afterEach(async () => {
    await removeTempDir(dir);
  });

  it("creates a document at v1 and publishes later versions without rewriting earlier ones", () => {
    const created = library.publish({ title: "价格表", section: null, text: "# 价格表\n旗舰款 ¥699", ownerBotId: "market-lead" }, OWNER, 1_000);
    expect(created).toMatchObject({ title: "价格表", section: null, ownerBotId: "market-lead", subscribers: [], inUse: [], updatedAt: 1_000, summary: "旗舰款 ¥699" });
    expect(created.id).toMatch(/^doc-/);
    expect(created.versions).toEqual([{ version: 1, at: 1_000, byOwner: true, size: Buffer.byteLength("# 价格表\n旗舰款 ¥699") }]);

    const next = library.publish({ id: created.id, title: "价格表", section: null, text: "# 价格表\n旗舰款 ¥799", note: "价格对齐会", decisionId: 3 }, OWNER, 2_000);
    expect(next.versions.map((entry) => entry.version)).toEqual([1, 2]);
    expect(next.versions[1]).toMatchObject({ note: "价格对齐会", decisionId: 3 });
    expect(next.ownerBotId).toBe("market-lead");

    expect(library.read(created.id)).toMatchObject({ version: 2, text: "# 价格表\n旗舰款 ¥799" });
    expect(library.read(created.id, 1)?.text).toBe("# 价格表\n旗舰款 ¥699");
    expect(library.read(created.id, 9)).toBeNull();
    expect(library.read("missing")).toBeNull();
    expect(existsSync(join(dir, "library", created.id, "v1.md"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "library", created.id, "meta.json"), "utf8")).versions).toHaveLength(2);
  });

  it("keeps a caller-chosen id, lists newest first and survives a restart", () => {
    library.publish({ id: "brand", title: "品牌规范", section: null, text: "logo" }, OWNER, 1);
    library.publish({ id: "specs", title: "产品参数", section: "技术部", text: "specs", summary: "规格、续航、包装清单" }, OWNER, 2);
    const reloaded = new LibraryStore(dir);
    expect(reloaded.list().map((doc) => doc.id)).toEqual(["specs", "brand"]);
    expect(reloaded.get("specs")).toMatchObject({ section: "技术部", summary: "规格、续航、包装清单" });
  });

  it("lets only the owner or the document's owning bot publish", () => {
    const doc = library.publish({ id: "prices", title: "价格表", section: null, text: "v1", ownerBotId: "market-lead" }, OWNER);
    expect(() => library.publish({ id: doc.id, title: "价格表", section: null, text: "v2" }, { kind: "bot", botId: "writer" })).toThrow(LibraryError);
    const byBot = library.publish({ id: doc.id, title: "价格表", section: null, text: "v2" }, { kind: "bot", botId: "market-lead" });
    expect(byBot.versions[1]).toMatchObject({ version: 2, byBotId: "market-lead" });
    expect(() => library.publish({ title: "x", section: null, text: "y", ownerBotId: "someone" }, { kind: "bot", botId: "writer" })).toThrow(/owner/);
  });

  it("validates what is published", () => {
    expect(() => library.publish({ title: "", section: null, text: "x" }, OWNER)).toThrow(/title/);
    expect(() => library.publish({ title: "t", section: null, text: "   " }, OWNER)).toThrow(/text/);
    expect(() => library.publish({ id: "../escape", title: "t", section: null, text: "x" }, OWNER)).toThrow(/id/);
    let caught: unknown;
    try {
      library.publish({ title: "big", section: null, text: "x".repeat(300_000) }, OWNER);
    } catch (error) {
      caught = error;
    }
    expect((caught as LibraryError).status).toBe(413);
  });

  it("subscribes and unsubscribes bots", () => {
    const doc = library.publish({ id: "prices", title: "价格表", section: null, text: "v1" }, OWNER);
    expect(library.subscribe(doc.id, "writer", true).subscribers).toEqual(["writer"]);
    expect(library.subscribe(doc.id, "writer", true).subscribers).toEqual(["writer"]);
    expect(library.subscribe(doc.id, "front-2", true).subscribers).toEqual(["writer", "front-2"]);
    expect(library.subscribe(doc.id, "writer", false).subscribers).toEqual(["front-2"]);
    expect(() => library.subscribe("nope", "writer", true)).toThrow(LibraryError);
  });

  it("puts the latest version of subscribed documents in the prompt and records the version used", () => {
    const prices = library.publish({ id: "prices", title: "价格表", section: null, text: "旗舰款 ¥699" }, OWNER, 1);
    library.publish({ id: "secret", title: "预算明细", section: "财务法务", text: "detail" }, OWNER, 2);
    library.publish({ id: "unrelated", title: "Other", section: null, text: "other" }, OWNER, 3);
    library.subscribe("prices", "writer", true);
    library.subscribe("secret", "writer", true);

    const prompt = library.promptFor("writer", { readable: (doc) => doc.section !== "财务法务" });
    expect(prompt).toContain('--- BEGIN LIBRARY DOCUMENT "价格表" v1 (company-wide) ---\n旗舰款 ¥699');
    expect(prompt).not.toContain("detail");
    expect(prompt).not.toContain("other");
    expect(library.get("prices")!.inUse).toEqual([{ botId: "writer", version: 1 }]);
    expect(library.get("secret")!.inUse).toEqual([]);

    // a new version: the stale marker shows until the bot's next turn uses it
    library.publish({ id: prices.id, title: "价格表", section: null, text: "旗舰款 ¥799" }, OWNER, 4);
    expect(library.get("prices")!.inUse).toEqual([{ botId: "writer", version: 1 }]);
    expect(library.promptFor("writer")).toContain("v2");
    expect(library.get("prices")!.inUse).toEqual([{ botId: "writer", version: 2 }]);
    expect(library.promptFor("nobody")).toBe("");
  });

  it("caps the library text in a prompt", () => {
    library.publish({ id: "big", title: "Big", section: null, text: "字".repeat(5_000) }, OWNER, 2);
    library.publish({ id: "small", title: "Small", section: null, text: "small text" }, OWNER, 1);
    library.subscribe("big", "bot", true);
    library.subscribe("small", "bot", true);
    const prompt = library.promptFor("bot");
    const bodies = prompt.split("--- BEGIN").slice(1).join("");
    expect(Buffer.byteLength(bodies, "utf8")).toBeLessThan(LIBRARY_PROMPT_MAX_BYTES + 400);
    expect(prompt).toContain("…(truncated)");
    expect(prompt).not.toContain("�");
  });

  it("reads an empty or damaged library as empty", () => {
    expect(library.list()).toEqual([]);
    library.publish({ id: "ok", title: "OK", section: null, text: "x" }, OWNER);
    writeFileSync(join(dir, "library", "ok", "meta.json"), "{ nope");
    expect(new LibraryStore(dir).list()).toEqual([]);
  });

  it("summarizes a document by its first line of body text", () => {
    expect(summaryOf("# 价格表\n\n三款定价 · 发布价与早鸟价\n旗舰款", "价格表")).toBe("三款定价 · 发布价与早鸟价");
    expect(summaryOf("价格表\n旗舰款 ¥799", "价格表")).toBe("旗舰款 ¥799");
    expect(summaryOf("# 只有标题", "x")).toBe("只有标题");
    expect(summaryOf("", "x")).toBe("");
  });

  it("truncates UTF-8 text without splitting a character", () => {
    expect(truncateBytes("abc", 10)).toBe("abc");
    expect(truncateBytes("价格表", 4)).toBe("价");
    expect(truncateBytes("价格表", 6)).toBe("价格");
  });
});
