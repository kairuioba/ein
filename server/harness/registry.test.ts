// The registry's contract is forward/backward compatibility: a config
// written by a newer or differently-built app must load as an
// unavailable shadow, never crash the fleet. These tests pin that.
import { describe, expect, it } from "vitest";

import { makeFakeDriver } from "../testing/fake-driver.ts";
import { ProviderRegistry } from "./registry.ts";

describe("ProviderRegistry", () => {
  it("creates live instances for known drivers", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake", displayName: "Bot A" } });

    const live = registry.get("a");
    expect(live).not.toBeNull();
    expect(live!.driverKind).toBe("fake");
    expect(live!.displayName).toBe("Bot A");
    expect(registry.instances()).toHaveLength(1);
  });

  it("uses defaultConfig when the entry has no config", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });
    // decodeConfig must NOT have been called — defaultConfig() is used verbatim
    expect(fake.decodedConfigs).toHaveLength(0);
    expect(registry.get("a")).not.toBeNull();
  });

  it("reports cli as overridden only when the raw config sets it", async () => {
    // Regression: override detection used to read the DECODED config, whose
    // cli field is always filled in with the driver default — every instance
    // then showed as "custom" though nothing was touched.
    const fake = makeFakeDriver();
    fake.driver.defaultConfig = () => ({ cli: "fakebin" });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({
      untouched: { driver: "fake", config: { other: true } },
      overridden: { driver: "fake", config: { cli: "/opt/fake/custom-bin" } },
      bare: { driver: "fake" },
    });

    const described = Object.fromEntries((await registry.describe()).map((d) => [d.instanceId, d]));
    expect(described.untouched.cli).toBeUndefined();
    expect(described.bare.cli).toBeUndefined();
    expect(described.overridden.cli).toBe("/opt/fake/custom-bin");
    expect(described.untouched.cliDefault).toBe("fakebin");
    expect(described.untouched.access).toBe("subscription");
  });

  it("publishes custom-only access from driver metadata", async () => {
    const fake = makeFakeDriver();
    Object.assign(fake.driver.metadata, { access: "custom" });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ local: { driver: "fake" } });
    const [described] = await registry.describe();
    expect(described.access).toBe("custom");
  });

  it("keeps an unknown driver as an unavailable shadow instead of failing", async () => {
    const registry = new ProviderRegistry([makeFakeDriver().driver]);
    await registry.load({ mystery: { driver: "from-the-future", displayName: "Tomorrow" } });

    expect(registry.get("mystery")).toBeNull();
    const [described] = await registry.describe();
    expect(described.snapshot.state).toBe("unavailable");
    expect(described.snapshot.reason).toContain("from-the-future");
    expect(described.displayName).toBe("Tomorrow");
    expect(described.models.options).toHaveLength(0);
  });

  it("downgrades a config-decode failure to a shadow with the error as reason", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ broken: { driver: "fake", config: { bad: true } } });

    expect(registry.get("broken")).toBeNull();
    const [described] = await registry.describe();
    expect(described.snapshot).toMatchObject({ state: "unavailable", reason: "fake: bad config" });
  });

  it("downgrades a create() rejection to a shadow without touching siblings", async () => {
    const good = makeFakeDriver({ kind: "good" });
    const flaky = makeFakeDriver({ kind: "flaky", failCreate: "boom at create" });
    const registry = new ProviderRegistry([good.driver, flaky.driver]);
    await registry.load({
      g: { driver: "good" },
      f: { driver: "flaky" },
    });

    expect(registry.get("g")).not.toBeNull();
    expect(registry.get("f")).toBeNull();
    const described = await registry.describe();
    const f = described.find((d) => d.instanceId === "f")!;
    expect(f.snapshot).toMatchObject({ state: "unavailable", reason: "boom at create" });
  });

  it("describe() reports a snapshot() failure as unavailable rather than throwing", async () => {
    const fake = makeFakeDriver({ failSnapshot: "provider probe exploded" });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    const [described] = await registry.describe();
    expect(described.snapshot).toMatchObject({ state: "unavailable", reason: "provider probe exploded" });
  });

  it("forwards a live instance's declared effort levels in describe()", async () => {
    const fake = makeFakeDriver({ effortLevels: ["low", "high"] });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    const [described] = await registry.describe();
    expect(described.capabilities.effortLevels).toEqual(["low", "high"]);
  });

  it("omits effortLevels from describe() when the driver declares none", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    const [described] = await registry.describe();
    expect(described.capabilities.effortLevels).toBeUndefined();
  });

  it("reports whether an instance supports isolated approval review", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    expect((await registry.describe())[0].capabilities.approvalReview).toBe(false);
    Object.assign(registry.get("a")!, { reviewPermission: async () => "ok" });
    expect((await registry.describe())[0].capabilities.approvalReview).toBe(true);
  });

  describe("reconcile", () => {
    // Regression: every settings save (dispatch strategy, language, any one
    // key) rebuilt the whole fleet, killing every running turn and posting
    // "turn interrupted — provider settings changed" into each busy chat.
    it("keeps instances whose entry did not change, even with keys reordered", async () => {
      const fake = makeFakeDriver();
      const registry = new ProviderRegistry([fake.driver]);
      await registry.load({
        a: { driver: "fake", config: { cli: "x", flags: ["-v"] }, environment: { K: "1", L: "2" } },
        b: { driver: "fake" },
      });
      const a = registry.get("a");
      const b = registry.get("b");

      const same = {
        a: { environment: { L: "2", K: "1" }, config: { flags: ["-v"], cli: "x" }, driver: "fake" },
        b: { driver: "fake" },
      };
      expect(registry.changedInstances(same)).toEqual([]);
      const result = await registry.reconcile(same);

      expect(result).toEqual({ replaced: [], created: [] });
      expect(registry.get("a")).toBe(a);
      expect(registry.get("b")).toBe(b);
      expect(fake.disposed).toEqual([]);
    });

    it("rebuilds only the changed instance and leaves its siblings running", async () => {
      const fake = makeFakeDriver();
      const registry = new ProviderRegistry([fake.driver]);
      await registry.load({ a: { driver: "fake", environment: { KEY: "old" } }, b: { driver: "fake" } });
      const a = registry.get("a");
      const b = registry.get("b");

      const next = { a: { driver: "fake", environment: { KEY: "new" } }, b: { driver: "fake" } };
      expect(registry.changedInstances(next)).toEqual(["a"]);
      const result = await registry.reconcile(next);

      expect(result.replaced).toEqual(["a"]);
      expect(result.created.map((instance) => instance.instanceId)).toEqual(["a"]);
      expect(fake.disposed).toEqual(["a"]);
      expect(registry.get("a")).not.toBe(a);
      expect(registry.get("b")).toBe(b);
      // describe() keeps the configured order after a rebuild
      expect(registry.entries().map((entry) => entry.instanceId)).toEqual(["a", "b"]);
    });

    it("disposes removed instances and creates added ones", async () => {
      const fake = makeFakeDriver();
      const registry = new ProviderRegistry([fake.driver]);
      await registry.load({ a: { driver: "fake" }, gone: { driver: "fake" } });

      const result = await registry.reconcile({ a: { driver: "fake" }, fresh: { driver: "fake" } });

      expect(result.replaced).toEqual(["gone"]);
      expect(result.created.map((instance) => instance.instanceId)).toEqual(["fresh"]);
      expect(fake.disposed).toEqual(["gone"]);
      expect(registry.get("gone")).toBeNull();
      expect(registry.entries().map((entry) => entry.instanceId)).toEqual(["a", "fresh"]);
    });

    it("retries a shadow whose entry changed, and leaves an unchanged shadow alone", async () => {
      const fake = makeFakeDriver();
      const registry = new ProviderRegistry([fake.driver]);
      await registry.load({ broken: { driver: "fake", config: { bad: true } }, mystery: { driver: "later" } });
      expect(registry.get("broken")).toBeNull();

      const result = await registry.reconcile({ broken: { driver: "fake", config: { fixed: true } }, mystery: { driver: "later" } });

      expect(result.replaced).toEqual(["broken"]);
      expect(registry.get("broken")).not.toBeNull();
      expect(registry.entries().find((entry) => entry.instanceId === "mystery")?.shadow).toBeTruthy();
    });
  });

  it("disposeAll disposes every live instance and empties the registry", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" }, b: { driver: "fake" } });

    await registry.disposeAll();
    expect(fake.disposed.sort()).toEqual(["a", "b"]);
    expect(registry.entries()).toHaveLength(0);
    expect(registry.get("a")).toBeNull();
  });
});
