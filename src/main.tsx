import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applySkin, readSkin } from "./lib/skins";
import { getLocale } from "./lib/i18n";
import "./styles.css";

// Before the first paint, not inside a component: stamping the skin during
// render would show one frame of the default palette first.
applySkin(readSkin());
// The document language picks the CJK glyph variants (PingFang SC rather
// than a Japanese or Traditional form) and the screen reader's voice.
document.documentElement.lang = getLocale() === "zh-CN" ? "zh-CN" : "en";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
