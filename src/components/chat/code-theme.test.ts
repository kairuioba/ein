import { describe, expect, it } from "vitest";

import { codeThemeForSkin, isDarkSkin } from "./code-theme";

describe("codeThemeForSkin", () => {
  it("uses the light theme on the daylight skins", () => {
    for (const skin of ["fog", "atelier", "lagoon"]) expect(codeThemeForSkin(skin)).toBe("github-light-default");
  });

  it("uses the dark theme on the dark skins", () => {
    for (const skin of ["midnight", "foundry"]) expect(codeThemeForSkin(skin)).toBe("github-dark-default");
  });

  it("falls back to the default skin, which is light", () => {
    expect(codeThemeForSkin(undefined)).toBe("github-light-default");
    expect(isDarkSkin("")).toBe(false);
  });
});
