// The shared live-catalog cache: the picker never waits, a stale answer is
// refreshed in the background, failures keep the last good list, and answers
// survive a restart on disk.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ModelCatalog } from "../contracts.ts";
import {
  createLiveCatalog,
  liveModelProbesEnabled,
  mergeOptions,
  pickDefault,
  reviveCatalog,
  secretId,
} from "./live-catalog.ts";

const catalog = (...ids: string[]): ModelCatalog => ({
  default: ids[0]!,
  options: ids.map((id) => ({ id, label: id.toUpperCase() })),
});

const ON = { VITEST: "true", EIN_PROBE_LIVE_MODELS: "1" };

let fileCounter = 0;
const uniqueFile = () => `test-${process.pid}-${Date.now()}-${fileCounter++}.json`;

describe("createLiveCatalog", () => {
  it("answers at once and fills in from a background probe", async () => {
    const cache = createLiveCatalog({ file: uniqueFile(), revive: reviveCatalog });
    let calls = 0;
    const probe = async () => {
      calls += 1;
      return catalog("model-a", "model-b");
    };
    expect(cache.read("fp", probe, ON)).toBeNull();
    await cache.settle("fp");
    expect(cache.read("fp", probe, ON)?.options.map((option) => option.id)).toEqual(["model-a", "model-b"]);
    // fresh: no second probe
    expect(calls).toBe(1);
  });

  it("keeps the last good list when a later probe fails, and backs off", async () => {
    let clock = 1_000;
    const cache = createLiveCatalog({
      file: uniqueFile(),
      revive: reviveCatalog,
      ttlMs: 100,
      retryMs: 1_000,
      now: () => clock,
    });
    cache.read("fp", async () => catalog("good"), ON);
    await cache.settle("fp");

    clock += 200; // stale
    let failures = 0;
    const failing = async () => {
      failures += 1;
      return null;
    };
    expect(cache.read("fp", failing, ON)?.default).toBe("good");
    await cache.settle("fp");
    expect(failures).toBe(1);

    clock += 500; // still inside the retry window
    expect(cache.read("fp", failing, ON)?.default).toBe("good");
    await cache.settle("fp");
    expect(failures).toBe(1);

    clock += 1_000;
    cache.read("fp", async () => catalog("newer"), ON);
    await cache.settle("fp");
    expect(cache.peek("fp")?.default).toBe("newer");
  });

  it("treats a thrown or hung probe as a failure", async () => {
    const cache = createLiveCatalog({ file: uniqueFile(), revive: reviveCatalog, timeoutMs: 20 });
    cache.read("throws", async () => {
      throw new Error("boom");
    }, ON);
    await cache.settle("throws");
    expect(cache.peek("throws")).toBeNull();

    cache.read("hangs", () => new Promise<ModelCatalog | null>(() => {}), ON);
    await cache.settle("hangs");
    expect(cache.peek("hangs")).toBeNull();
  });

  it("persists answers so a restart opens on the last list", async () => {
    const file = uniqueFile();
    const first = createLiveCatalog({ file, revive: reviveCatalog });
    first.read("fp", async () => catalog("persisted", "second"), ON);
    await first.settle("fp");
    const onDisk = join(DATA_DIR, "model-catalogs", file);
    expect(existsSync(onDisk)).toBe(true);
    expect(readFileSync(onDisk, "utf8")).toContain("persisted");

    const restarted = createLiveCatalog({ file, revive: reviveCatalog });
    expect(restarted.peek("fp")?.options.map((option) => option.id)).toEqual(["persisted", "second"]);
    expect(restarted.peek("another-account")).toBeNull();
  });

  it("does not probe under a test runner unless asked to", async () => {
    const cache = createLiveCatalog({ file: uniqueFile(), revive: reviveCatalog });
    let calls = 0;
    cache.read("fp", async () => {
      calls += 1;
      return catalog("x");
    }, { VITEST: "true" });
    await cache.settle("fp");
    expect(calls).toBe(0);
    expect(liveModelProbesEnabled({ VITEST: "true" })).toBe(false);
    expect(liveModelProbesEnabled({ VITEST: "1", EIN_PROBE_LIVE_MODELS: "1" })).toBe(true);
  });
});

describe("live-catalog helpers", () => {
  it("revives only well-formed rows", () => {
    expect(reviveCatalog(null)).toBeNull();
    expect(reviveCatalog({ options: [] })).toBeNull();
    expect(
      reviveCatalog({
        default: "missing",
        options: [{ id: "a", label: "A", custom: true, contextWindow: 1000 }, { id: 3 }, { id: "b", label: "B", contextWindow: -1 }],
      }),
    ).toEqual({ default: "a", options: [{ id: "a", label: "A", custom: true, contextWindow: 1000 }, { id: "b", label: "B" }] });
  });

  it("merges without duplicates and picks the first preferred default that exists", () => {
    const merged = mergeOptions([{ id: "a", label: "A" }], [{ id: "a", label: "dup" }, { id: "b", label: "B" }]);
    expect(merged).toEqual([{ id: "a", label: "A" }, { id: "b", label: "B" }]);
    expect(pickDefault(merged, "missing", "b")).toBe("b");
    expect(pickDefault(merged, undefined)).toBe("a");
    expect(pickDefault([], "a")).toBe("");
  });

  it("names a secret without keeping it", () => {
    expect(secretId("sk-secret")).not.toContain("secret");
    expect(secretId("sk-secret")).toHaveLength(12);
    expect(secretId("")).toBe("-");
  });
});
