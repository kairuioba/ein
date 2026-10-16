// 发布 / 发布新版本: a new document, or the next version of one, into the
// shared library through publishLibraryDoc (POST /api/library).
import { useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";

import { Button, Dialog } from "@/components/ui";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { publishLibraryDoc } from "@/state/org-api";
import type { Bot } from "@/state/store";
import type { LibraryDoc } from "../../../shared/org-types";

export interface PublishSeed {
  doc?: LibraryDoc;
  text?: string;
}

const FIELD =
  "w-full rounded-[10px] bg-stage px-3 py-2 text-[13px] text-ink shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_70%,transparent)] outline-none placeholder:text-ink-secondary/60 focus:shadow-[inset_0_0_0_1.5px_var(--color-select)]";

export function PublishDialog({
  seed,
  bots,
  sections,
  onClose,
  onPublished,
}: {
  seed: PublishSeed;
  bots: Bot[];
  sections: string[];
  onClose: () => void;
  onPublished: (doc: LibraryDoc) => void;
}) {
  const existing = seed.doc;
  const [title, setTitle] = useState(existing?.title ?? "");
  const [section, setSection] = useState(existing?.section ?? "");
  const [ownerBotId, setOwnerBotId] = useState(existing?.ownerBotId ?? "");
  const [text, setText] = useState(seed.text ?? "");
  const [note, setNote] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const first = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  // Dialog focuses its first control; start where the person types
  useEffect(() => first.current?.focus(), []);

  const submit = async () => {
    setWorking(true);
    setError("");
    try {
      const doc = await publishLibraryDoc({
        id: existing?.id,
        title: title.trim(),
        section: section.trim() || null,
        text,
        note: note.trim() || undefined,
        ownerBotId: ownerBotId || undefined,
      });
      onPublished(doc);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };
  const valid = title.trim() && text.trim();
  const nextVersion = existing ? Math.max(0, ...existing.versions.map((version) => version.version)) + 1 : 1;

  return (
    <Dialog open onClose={onClose} label={existing ? t("Publish a new version") : t("Publish to the library")} width={640} className="max-h-[92vh]">
      <div className="flex items-start justify-between gap-3 px-6 pb-1 pt-5">
        <div>
          <div className="text-[18px] font-bold text-ink">{existing ? t("Publish v{version} of “{title}”", { version: nextVersion, title: existing.title }) : t("Publish to the library")}</div>
          <div className="mt-0.5 text-[12.5px] text-ink-secondary">{t("Every document has a version and an owner; bots that use it are told when it changes.")}</div>
        </div>
        <button type="button" onClick={onClose} aria-label={t("Close")} className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-secondary hover:bg-raised-hover hover:text-ink"><X size={16} /></button>
      </div>
      <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-6 py-4">
        {!existing && (
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-semibold text-ink-secondary">{t("Title")}</span>
            <input ref={first as React.RefObject<HTMLInputElement>} value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("e.g. Price list")} className={FIELD} maxLength={80} />
          </label>
        )}
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-semibold text-ink-secondary">{t("Level")}</span>
            <select value={section} onChange={(event) => setSection(event.target.value)} className={FIELD} disabled={Boolean(existing)}>
              <option value="">{t("Company — everyone can read")}</option>
              {sections.map((name) => <option key={name} value={name}>{t("Department · {name}", { name })}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-semibold text-ink-secondary">{t("Owner")}</span>
            <select value={ownerBotId} onChange={(event) => setOwnerBotId(event.target.value)} className={FIELD}>
              <option value="">{t("You")}</option>
              {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
            </select>
          </label>
        </div>
        <label className="block">
          <span className="mb-1.5 block text-[12px] font-semibold text-ink-secondary">{t("Content")}</span>
          <textarea
            ref={existing ? (first as React.RefObject<HTMLTextAreaElement>) : undefined}
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={12}
            placeholder={t("Paste or write the document. Markdown is fine.")}
            className={cn(FIELD, "resize-y font-mono text-[12.5px] leading-relaxed")}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[12px] font-semibold text-ink-secondary">{existing ? t("What changed") : t("Note (optional)")}</span>
          <input value={note} onChange={(event) => setNote(event.target.value)} placeholder={existing ? t("e.g. Added the early-bird price") : t("e.g. First version")} className={FIELD} maxLength={120} />
        </label>
        {error && <div role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-hairline/30 px-6 py-3.5">
        <Button variant="ghost" onClick={onClose}>{t("Cancel")}</Button>
        <Button onClick={() => void submit()} disabled={!valid || working}>
          {working && <Loader2 size={14} className="animate-spin" />}
          {existing ? t("Publish v{version}", { version: nextVersion }) : t("Publish")}
        </Button>
      </div>
    </Dialog>
  );
}
