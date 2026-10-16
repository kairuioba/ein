// Pure helpers for the 资料库 page (U5): a document's level (company /
// department / isolated department), its current version, who still uses an
// older one, and a small line diff between two versions.
import type { LibraryDoc, LibraryDocVersion, OrgDepartment } from "../../shared/org-types";

export type DocLevel =
  | { kind: "company" }
  | { kind: "department"; section: string; color: string }
  | { kind: "isolated"; section: string; color: string };

export function docLevel(
  doc: Pick<LibraryDoc, "section">,
  departments: ReadonlyArray<{ section: string; color: string; settings?: Pick<OrgDepartment, "isolated"> }>,
): DocLevel {
  const section = doc.section?.trim();
  if (!section) return { kind: "company" };
  const department = departments.find((candidate) => candidate.section === section);
  const color = department?.color ?? "#475467";
  return department?.settings?.isolated ? { kind: "isolated", section, color } : { kind: "department", section, color };
}

export function currentVersion(doc: Pick<LibraryDoc, "versions">): LibraryDocVersion | undefined {
  return [...doc.versions].sort((a, b) => b.version - a.version)[0];
}

/** Bots whose last use of the doc is older than its current version. */
export function staleUsers(doc: Pick<LibraryDoc, "versions" | "inUse">): Array<{ botId: string; version: number }> {
  const current = currentVersion(doc)?.version ?? 0;
  return doc.inUse.filter((use) => use.version < current).sort((a, b) => a.version - b.version);
}

/** Bots still on an older version, grouped by that version: "2 份稿子还在用 v3". */
export function oldestStaleVersion(doc: Pick<LibraryDoc, "versions" | "inUse">): number | undefined {
  return staleUsers(doc)[0]?.version;
}

export type DiffLine = { kind: "same" | "add" | "del"; text: string };

/** Line diff by longest common subsequence. Long texts fall back to a
 * prefix/suffix trim so the page never stalls on a big document. */
export function diffLines(before: string, after: string, limit = 1500): DiffLine[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const head = a.slice(0, start).map((text) => ({ kind: "same" as const, text }));
  const tail = a.slice(endA).map((text) => ({ kind: "same" as const, text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  let middle: DiffLine[];
  if (midA.length * midB.length > limit * limit) {
    middle = [...midA.map((text) => ({ kind: "del" as const, text })), ...midB.map((text) => ({ kind: "add" as const, text }))];
  } else {
    const table = Array.from({ length: midA.length + 1 }, () => new Array<number>(midB.length + 1).fill(0));
    for (let i = midA.length - 1; i >= 0; i -= 1) {
      for (let j = midB.length - 1; j >= 0; j -= 1) {
        table[i]![j] = midA[i] === midB[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
      }
    }
    middle = [];
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        middle.push({ kind: "same", text: midA[i]! });
        i += 1;
        j += 1;
      } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
        middle.push({ kind: "del", text: midA[i]! });
        i += 1;
      } else {
        middle.push({ kind: "add", text: midB[j]! });
        j += 1;
      }
    }
    while (i < midA.length) middle.push({ kind: "del", text: midA[i++]! });
    while (j < midB.length) middle.push({ kind: "add", text: midB[j++]! });
  }
  return [...head, ...middle, ...tail];
}

/** Consecutive removals/additions as one change: what "改了 N 处" counts. */
export function changeHunks(diff: readonly DiffLine[]): Array<{ removed: string[]; added: string[] }> {
  const hunks: Array<{ removed: string[]; added: string[] }> = [];
  let open: { removed: string[]; added: string[] } | null = null;
  for (const line of diff) {
    if (line.kind === "same") {
      open = null;
      continue;
    }
    if (!open) {
      open = { removed: [], added: [] };
      hunks.push(open);
    }
    if (line.kind === "del") open.removed.push(line.text);
    else open.added.push(line.text);
  }
  return hunks.filter((hunk) => hunk.removed.some((text) => text.trim()) || hunk.added.some((text) => text.trim()));
}

/** First paragraph of a document, for the detail panel's summary line. */
export function summaryOf(text: string, max = 140, title?: string): string {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((part) => part.replace(/^#+\s*/gm, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  // a first line that only repeats the title says nothing
  const paragraph = (title && paragraphs[0] === title.trim() ? paragraphs[1] : paragraphs[0]) ?? paragraphs[0] ?? "";
  return paragraph.length > max ? `${paragraph.slice(0, max - 1)}…` : paragraph;
}

/** A filename for downloading a version: "价格表-v4.md". */
export function downloadName(title: string, version: number): string {
  const safe = title.trim().replace(/[\\/:*?"<>|]+/g, "-").slice(0, 60) || "document";
  return `${safe}-v${version}.md`;
}
