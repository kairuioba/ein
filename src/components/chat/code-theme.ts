// Code blocks follow the skin's brightness: a dark highlight theme on the
// dark skins, a light one on daylight skins — dark token colours on a light
// inset were close to unreadable. The block's own background stays the
// skin's `inset`; only the token colours change.
import { useSyncExternalStore } from "react";
import { DEFAULT_SKIN } from "@/lib/skins";

export type CodeTheme = "github-light-default" | "github-dark-default";

const DARK_SKINS = new Set(["midnight", "foundry"]);

export function isDarkSkin(skin: string | null | undefined): boolean {
  return DARK_SKINS.has(skin || DEFAULT_SKIN);
}

export function codeThemeForSkin(skin: string | null | undefined): CodeTheme {
  return isDarkSkin(skin) ? "github-dark-default" : "github-light-default";
}

function currentSkin(): string | undefined {
  return typeof document === "undefined" ? undefined : document.documentElement.dataset.skin;
}

function subscribe(onChange: () => void): () => void {
  if (typeof MutationObserver === "undefined" || typeof document === "undefined") return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-skin"] });
  return () => observer.disconnect();
}

/** The theme for the skin on screen, updating when the skin changes. */
export function useCodeTheme(): CodeTheme {
  const skin = useSyncExternalStore(subscribe, currentSkin, () => undefined);
  return codeThemeForSkin(skin);
}
