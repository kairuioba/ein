import { afterEach, describe, expect, it } from "vitest";

import { setLocale } from "../shared/i18n.ts";
import { reasonLabel } from "./reason-labels.ts";

describe("reason labels", () => {
  afterEach(() => setLocale("en"));

  it("keeps the raw code in English, exactly as chips always showed it", () => {
    expect(reasonLabel("rate_limited")).toBe("rate_limited");
    expect(reasonLabel(" exit_before_result ")).toBe("exit_before_result");
    expect(reasonLabel(undefined)).toBe("");
  });

  it("puts known codes into words and passes an engine's own text through", () => {
    setLocale("zh-CN");
    expect(reasonLabel("rate_limited")).not.toBe("rate_limited");
    expect(reasonLabel("connection_reset")).not.toMatch(/_/);
    expect(reasonLabel("Model refused: context too long")).toBe("Model refused: context too long");
    expect(reasonLabel("constructor")).toBe("constructor");
    expect(reasonLabel("")).not.toBe("");
  });
});
