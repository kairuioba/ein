#!/usr/bin/env node
// Localization coverage check.
//
//   node scripts/i18n-check.mjs            fail on missing translations
//   node scripts/i18n-check.mjs --report   also list likely-untranslated UI copy
//
// It finds every t("…") / tn(n, "…", "…") / tRich("…") / msg("…") call with
// literal sources under src/, server/, shared/ and electron/, then checks that
// the zh-CN dictionary has an entry for each source and that both sides use
// the same {placeholders}.
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { collectSources, listSourceFiles, placeholders } from "./i18n-scan.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dictionary = JSON.parse(readFileSync(join(root, "shared/i18n/zh-CN.json"), "utf8"));
const report = process.argv.includes("--report");
const files = listSourceFiles(root);
const { used, dynamicCalls } = collectSources(root, files);

const missing = [];
const mismatched = [];
for (const [source, where] of used) {
  if (!Object.hasOwn(dictionary, source)) {
    missing.push({ source, where });
    continue;
  }
  if (placeholders(source) !== placeholders(dictionary[source])) mismatched.push({ source, translated: dictionary[source], where });
}
const unused = Object.keys(dictionary).filter((source) => !used.has(source));

console.log(`i18n: ${used.size} sources in code, ${Object.keys(dictionary).length} dictionary entries`);
console.log(`  missing translations: ${missing.length}`);
console.log(`  placeholder mismatches: ${mismatched.length}`);
console.log(`  unused dictionary entries: ${unused.length}`);
console.log(`  non-literal t() calls: ${dynamicCalls.length}`);
for (const item of missing.slice(0, report ? 400 : 40)) console.log(`  MISSING ${JSON.stringify(item.source)} (${item.where[0]})`);
for (const item of mismatched.slice(0, 40)) console.log(`  PLACEHOLDERS ${JSON.stringify(item.source)} → ${JSON.stringify(item.translated)} (${item.where[0]})`);

if (report) {
  // Heuristic: English-looking JSX text and UI attributes not wrapped in t().
  const suspects = [];
  for (const file of files.filter((path) => path.endsWith(".tsx"))) {
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    lines.forEach((lineText, index) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(lineText)) return;
      const jsxText = lineText.match(/>([^<>{}]*[A-Za-z]{3,}[^<>{}]*)</);
      const attr = lineText.match(/\b(aria-label|title|placeholder|alt)="([^"]*[A-Za-z]{3,}[^"]*)"/);
      const bare = /^\s+[A-Z][a-z]+(\s+[a-zA-Z'’,.!?-]+)+\s*$/.test(lineText);
      if (jsxText || attr || bare) suspects.push(`${relative(root, file)}:${index + 1}: ${lineText.trim().slice(0, 110)}`);
    });
  }
  console.log(`\nlikely-untranslated UI copy: ${suspects.length}`);
  for (const line of suspects.slice(0, 300)) console.log(`  ${line}`);
  if (unused.length) console.log(`\nunused: ${unused.slice(0, 50).map((s) => JSON.stringify(s)).join(", ")}`);
}

process.exitCode = missing.length || mismatched.length ? 1 : 0;
