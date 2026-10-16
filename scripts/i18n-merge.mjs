#!/usr/bin/env node
// Merge translation fragments (shared/i18n/fragments/*.json) into the
// dictionary (shared/i18n/zh-CN.json), keeping keys sorted so diffs stay
// reviewable. Existing entries win unless --overwrite is passed; conflicting
// translations are reported. Merged fragments are removed unless --keep.
//
//   node scripts/i18n-merge.mjs [--overwrite] [--keep]
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dictionaryPath = join(root, "shared/i18n/zh-CN.json");
const fragmentsDir = join(root, "shared/i18n/fragments");
const overwrite = process.argv.includes("--overwrite");
const keep = process.argv.includes("--keep");

const dictionary = JSON.parse(readFileSync(dictionaryPath, "utf8"));
const fragments = existsSync(fragmentsDir)
  ? readdirSync(fragmentsDir).filter((name) => name.endsWith(".json")).sort()
  : [];
let added = 0;
const conflicts = [];
for (const name of fragments) {
  const path = join(fragmentsDir, name);
  let fragment;
  try {
    fragment = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`skipping ${name}: ${error.message}`);
    continue;
  }
  for (const [source, translated] of Object.entries(fragment)) {
    if (typeof translated !== "string" || !translated.trim()) continue;
    if (Object.hasOwn(dictionary, source)) {
      if (dictionary[source] !== translated) {
        conflicts.push({ source, kept: overwrite ? translated : dictionary[source], other: overwrite ? dictionary[source] : translated, from: name });
        if (overwrite) dictionary[source] = translated;
      }
      continue;
    }
    dictionary[source] = translated;
    added += 1;
  }
  if (!keep) rmSync(path);
}
const sorted = Object.fromEntries(Object.entries(dictionary).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
writeFileSync(dictionaryPath, `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`merged ${fragments.length} fragment(s): +${added} entries, ${Object.keys(sorted).length} total`);
for (const conflict of conflicts.slice(0, 50)) {
  console.log(`conflict (${conflict.from}): ${JSON.stringify(conflict.source)} kept ${JSON.stringify(conflict.kept)} over ${JSON.stringify(conflict.other)}`);
}
if (conflicts.length > 50) console.log(`…and ${conflicts.length - 50} more conflicts`);
