// Shared scanner for the localization tools: finds t("…"), tn(n, "…", "…"),
// tRich("…") and msg("…") calls with literal sources in JS/TS files.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SKIP_DIRS = new Set(["node_modules", "vendor", "fixtures", "testing", "dist", "dist-server", "release"]);

/** Every non-test source file under the given top-level directories. */
export function listSourceFiles(root, dirs = ["src", "server", "shared", "electron"]) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(tsx?|mjs|cjs)$/.test(entry) && !/\.(test|node-test)\./.test(entry)) files.push(path);
    }
  };
  for (const dir of dirs) walk(join(root, dir));
  return files;
}

/** Read a JS string literal starting at `index` (which must be a quote). */
export function readLiteral(text, index) {
  const quote = text[index];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  let value = "";
  for (let i = index + 1; i < text.length; i += 1) {
    const char = text[i];
    if (char === "\\") {
      const next = text[i + 1];
      const escapes = { n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"', "'": "'", "`": "`" };
      if (next === "u" && text[i + 2] === "{") {
        const end = text.indexOf("}", i);
        value += String.fromCodePoint(parseInt(text.slice(i + 3, end), 16));
        i = end;
      } else if (next === "u") {
        value += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
        i += 5;
      } else {
        value += escapes[next] ?? next;
        i += 1;
      }
      continue;
    }
    if (quote === "`" && char === "$" && text[i + 1] === "{") return { dynamic: true, end: i };
    if (char === quote) return { value, end: i + 1 };
    value += char;
  }
  return null;
}

const skipSpace = (text, index) => {
  while (index < text.length && /\s/.test(text[index])) index += 1;
  return index;
};

const IMPLEMENTATION = new Set(["shared/i18n.ts", "src/lib/i18n.tsx", "electron/i18n.cjs"]);
/** Blank out comments (keeping offsets and line numbers) so documentation
 * examples are not mistaken for calls. String contents are left alone. */
export function stripComments(text) {
  let out = "";
  let i = 0;
  // One entry per open `${` inside a template literal: the brace depth of the
  // expression, so its closing `}` returns to template text.
  const templates = [];
  let lastSignificant = "";
  let lastWord = "";
  let word = "";
  const blank = (from, to) => text.slice(from, to).replace(/[^\n]/g, " ");
  const scanTemplateText = () => {
    // at the first character after "`" or after the "}" closing a ${…}
    while (i < text.length) {
      const char = text[i];
      if (char === "\\") {
        out += text.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (char === "`") {
        out += char;
        i += 1;
        lastSignificant = "`";
        return;
      }
      if (char === "$" && text[i + 1] === "{") {
        out += "${";
        i += 2;
        templates.push(0);
        lastSignificant = "{";
        return;
      }
      out += char;
      i += 1;
    }
  };
  while (i < text.length) {
    const char = text[i];
    const next = text[i + 1];
    if (char === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      out += blank(i, stop);
      i = stop;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += blank(i, stop);
      i = stop;
      continue;
    }
    if (
      char === "/" &&
      (lastSignificant === "" ||
        "(,=:[!&|?{};+-*%<>~^".includes(lastSignificant) ||
        (lastSignificant === "a" && /^(return|typeof|case|in|of|new|delete|void|throw|else|do|await|yield)$/.test(lastWord)))
    ) {
      // regex literal: copy through the closing slash, honoring [classes]
      let j = i + 1;
      let inClass = false;
      for (; j < text.length && text[j] !== "\n"; j += 1) {
        if (text[j] === "\\") {
          j += 1;
          continue;
        }
        if (text[j] === "[") inClass = true;
        else if (text[j] === "]") inClass = false;
        else if (text[j] === "/" && !inClass) break;
      }
      out += blank(i, j + 1);
      i = j + 1;
      lastSignificant = ")";
      continue;
    }
    if (char === '"' || char === "'") {
      const literal = readLiteral(text, i);
      const end = literal && !literal.dynamic ? literal.end : i + 1;
      out += text.slice(i, end);
      i = end;
      lastSignificant = ")";
      continue;
    }
    if (char === "`") {
      out += char;
      i += 1;
      scanTemplateText();
      continue;
    }
    if (templates.length && char === "{") templates[templates.length - 1] += 1;
    if (templates.length && char === "}") {
      if (templates[templates.length - 1] === 0) {
        templates.pop();
        out += char;
        i += 1;
        scanTemplateText();
        continue;
      }
      templates[templates.length - 1] -= 1;
    }
    out += char;
    i += 1;
    if (/[\w$]/.test(char)) {
      word += char;
      lastSignificant = "a";
      lastWord = word;
    } else {
      word = "";
      if (!/\s/.test(char)) lastSignificant = char;
    }
  }
  return out;
}

/** Collect literal sources: a Map of source → ["file:line", …] plus the
 * locations of calls whose source is not a literal. */
export function collectSources(root, files) {
  const used = new Map();
  const dynamicCalls = [];
  const addUse = (source, file, line) => {
    if (!used.has(source)) used.set(source, []);
    used.get(source).push(`${relative(root, file)}:${line}`);
  };
  for (const file of files) {
    if (IMPLEMENTATION.has(relative(root, file))) continue;
    const text = stripComments(readFileSync(file, "utf8"));
    const pattern = /(?<![\w.$])(t|tn|tRich|msg)\(/g;
    let match;
    while ((match = pattern.exec(text))) {
      const line = text.slice(0, match.index).split("\n").length;
      let cursor = skipSpace(text, match.index + match[0].length);
      if (match[1] === "tn") {
        // skip the count expression up to the first top-level comma
        let depth = 0;
        for (; cursor < text.length; cursor += 1) {
          const char = text[cursor];
          if ("([{".includes(char)) depth += 1;
          else if (")]}".includes(char)) depth -= 1;
          else if (char === "," && depth === 0) break;
        }
        cursor = skipSpace(text, cursor + 1);
        const singular = readLiteral(text, cursor);
        if (!singular || singular.dynamic) {
          dynamicCalls.push(`${relative(root, file)}:${line}`);
          continue;
        }
        cursor = skipSpace(text, singular.end);
        if (text[cursor] === ",") cursor = skipSpace(text, cursor + 1);
        const plural = readLiteral(text, cursor);
        addUse(singular.value, file, line);
        if (plural && !plural.dynamic) addUse(plural.value, file, line);
        continue;
      }
      const literal = readLiteral(text, cursor);
      if (!literal || literal.dynamic) {
        dynamicCalls.push(`${relative(root, file)}:${line}`);
        continue;
      }
      addUse(literal.value, file, line);
    }
  }
  return { used, dynamicCalls };
}

export const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
