import { describe, expect, it } from "vitest";

import { needsCli, needsCredential, needsSignIn } from "./EngineSetup";
import type { InstanceInfo } from "@/state/store";

function instance(snapshot: InstanceInfo["snapshot"]): InstanceInfo {
  return {
    instanceId: "kimi",
    driverKind: "kimiAgent",
    displayName: "Kimi",
    models: { default: "kimi-code/k3", options: [] },
    snapshot,
  };
}

describe("needsCli / needsSignIn", () => {
  it("treats a missing binary as a CLI install, not a sign-in", () => {
    const missing = instance({ state: "unavailable", reason: "`kimi` CLI not found" });
    expect(needsCli(missing)).toBe(true);
    expect(needsSignIn(missing)).toBe(false);
  });

  it("lets Custom inject run when the CLI is installed but unsigned-in", () => {
    const unsigned = instance({ state: "available", authenticated: false, version: "0.36.1" });
    expect(needsCli(unsigned)).toBe(false);
    expect(needsSignIn(unsigned)).toBe(true);
  });

  it("is ready for inject when the CLI is present", () => {
    const ready = instance({ state: "available", authenticated: true, version: "0.36.1" });
    expect(needsCli(ready)).toBe(false);
    expect(needsSignIn(ready)).toBe(false);
  });

  it("recognizes an engine whose setup step is a saved API key", () => {
    const noKey = instance({
      state: "available",
      authenticated: false,
      credential: { target: "claudeApiKey", configured: false },
    });
    expect(needsCli(noKey)).toBe(false);
    expect(needsCredential(noKey)).toBe(true);
    expect(needsCredential(instance({ state: "available", authenticated: true }))).toBe(false);
  });
});
