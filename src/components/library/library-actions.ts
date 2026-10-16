// Library writes the page needs beyond publishLibraryDoc (src/state/org-api.ts).
// Contract proposed to the org layer (agent A1): PATCH /api/library/:id with
// { subscribers: string[] } replaces who is told about new versions and
// returns the updated LibraryDoc.
import { refreshApi } from "@/state/org-api";
import type { LibraryDoc } from "../../../shared/org-types";

export async function setLibrarySubscribers(id: string, subscribers: string[]): Promise<LibraryDoc> {
  const res = await fetch(`/api/library/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subscribers }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((payload as { error?: string }).error || `${res.status}`);
  await refreshApi("/api/library");
  return payload as LibraryDoc;
}

/** Save a version's text as a Markdown file. */
export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
