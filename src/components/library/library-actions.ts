// Library writes the page needs beyond publishLibraryDoc (src/state/org-api.ts):
// POST /api/library/:id/subscribe {botId, on} → LibraryDoc (server/org/api.ts).
import { refreshApi } from "@/state/org-api";
import type { LibraryDoc } from "../../../shared/org-types";

export async function setLibrarySubscription(id: string, botId: string, on: boolean): Promise<LibraryDoc> {
  const res = await fetch(`/api/library/${encodeURIComponent(id)}/subscribe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ botId, on }),
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
