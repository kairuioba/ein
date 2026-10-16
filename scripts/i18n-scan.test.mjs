// The localization scanner must see every literal t()/tn()/tRich()/msg()
// source — a call it misses is a string that silently ships in English.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { collectSources, placeholders, stripComments } from "./i18n-scan.mjs";

let dir;
const scan = (name, text) => {
  dir = mkdtempSync(join(tmpdir(), "omb-i18n-scan-"));
  const file = join(dir, name);
  writeFileSync(file, text);
  return collectSources(dir, [file]);
};
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

describe("i18n scanner", () => {
  it("finds every call form, including plurals and markers", () => {
    const { used } = scan(
      "a.ts",
      `t("One"); tn(n, "{count} bot", "{count} bots"); tRich("Press <kbd>K</kbd>", {}); const L = msg("Label");`,
    );
    expect([...used.keys()].sort()).toEqual(["One", "Press <kbd>K</kbd>", "Label", "{count} bot", "{count} bots"].sort());
  });

  it("is not fooled by JSX slashes before a call on the same line", () => {
    const { used } = scan(
      "b.tsx",
      [
        `const a = <span><Icon size={13} /> {t("Alpha")}</span>;`,
        `const b = <p><b>{t("Beta")}</b> and {t("Gamma")} <i>x</i> {t("Delta")}</p>;`,
        `const c = <span>{done} / {total} {t("Epsilon")}</span>;`,
      ].join("\n"),
    );
    expect([...used.keys()].sort()).toEqual(["Alpha", "Beta", "Delta", "Epsilon", "Gamma"]);
  });

  it("still skips real regex literals and comments", () => {
    const { used } = scan(
      "c.ts",
      [
        `const d = text.replace(/t\\("Nope"\\)/g, "") + t("Zeta");`,
        `const e = (s) => /re/.test(s) ? t("Eta") : t("Theta");`,
        `// t("Commented out")`,
        `/* t("Also commented") */`,
        "const f = `${t(\"Inside template\")} text t(\"not a call\")`;",
      ].join("\n"),
    );
    expect([...used.keys()].sort()).toEqual(["Eta", "Inside template", "Theta", "Zeta"]);
  });

  it("reports calls whose source is not a literal", () => {
    const { dynamicCalls } = scan("d.ts", `t(label); t(\`\${prefix} done\`);`);
    expect(dynamicCalls.length).toBe(2);
  });

  it("keeps offsets when blanking comments", () => {
    const text = `a // note\nb /* x */ c`;
    expect(stripComments(text)).toHaveLength(text.length);
  });

  it("compares placeholders regardless of order", () => {
    expect(placeholders("{b} of {a}")).toBe(placeholders("{a}，{b}"));
  });
});
