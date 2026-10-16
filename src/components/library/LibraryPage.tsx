// 资料库 (U5): the company's shared documents — each with a version, an owner
// and subscribers — grouped by level (公司 / 部门 / 隔离区). The list warns
// when bots still use an older version; the detail panel shows the version
// history, what changed, and lets you publish a new version or (un)subscribe
// bots. Data: useLibrary / readLibraryDoc / publishLibraryDoc (/api/library,
// built by the org layer); until that answers, the page shows its empty state.
import { useMemo, useState } from "react";
import { ChevronDown, Check, Eye, Lock, Plus, Search, TriangleAlert } from "lucide-react";

import { BotAvatar } from "@/components/Avatar";
import { Button } from "@/components/ui";
import { shortWhen } from "@/lib/calendar-view";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { currentVersion, docLevel, oldestStaleVersion, staleUsers, type DocLevel } from "@/lib/library-view";
import { buildDepartments } from "@/lib/org";
import { useLibrary, useOrg } from "@/state/org-api";
import { LIBRARY_OPEN_EVENT, LIBRARY_OPEN_KEY, useHandOff, type LibraryOpen } from "@/lib/deep-links";
import { useStore } from "@/state/store";
import type { LibraryDoc } from "../../../shared/org-types";
import { DocPanel } from "./DocPanel";
import { DecisionTag, DocIcon, LevelTag } from "./LibraryTags";
import { PublishDialog, type PublishSeed } from "./PublishDialog";

type Filter = "all" | DocLevel["kind"];
const GRID = "grid grid-cols-[42px_minmax(120px,1.5fr)_minmax(96px,128px)_minmax(96px,1fr)_minmax(64px,0.9fr)_48px_minmax(150px,1.6fr)] items-center";

function EmptyLibrary({ unavailable, onPublish }: { unavailable: boolean; onPublish: () => void }) {
  return (
    <div className="mx-auto mt-16 flex max-w-[460px] flex-col items-center px-6 text-center">
      <div className="relative h-[72px] w-[120px]" aria-hidden>
        {[0, 1, 2].map((index) => (
          <span
            key={index}
            className="absolute top-0 grid h-[64px] w-[52px] place-items-center rounded-[10px] bg-raised shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_50%,transparent),0_10px_20px_-14px_rgb(16_24_40/0.4)]"
            style={{ left: 12 + index * 26, transform: `rotate(${(index - 1) * 8}deg) translateY(${index === 1 ? -4 : 2}px)`, zIndex: index === 1 ? 2 : 1 }}
          >
            <span className="flex w-7 flex-col gap-1.5">
              <i className="h-1 rounded-full bg-hairline/70" />
              <i className="h-1 w-5 rounded-full bg-hairline/50" />
              <i className={cn("h-1 rounded-full", index === 1 ? "bg-select/50" : "bg-hairline/50")} />
            </span>
          </span>
        ))}
      </div>
      <div className="mt-5 text-[16px] font-semibold text-ink">{t("The library is empty")}</div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">
        {t("Put the documents everyone relies on here — price lists, brand rules, product specs. Each gets a version and an owner, and bots that use it are told when it changes.")}
      </p>
      <Button className="mt-4" onClick={onPublish}><Plus size={15} strokeWidth={2.4} />{t("Publish the first document")}</Button>
      {unavailable && <p className="mt-3 text-[11.5px] text-ink-secondary/80">{t("The library service isn't running on this server yet; publishing works once it is.")}</p>}
    </div>
  );
}

export function LibraryPage() {
  const { state } = useStore();
  const { data: org } = useOrg();
  const { data, loaded, error } = useLibrary();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"updated" | "name">("updated");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // a link elsewhere (⌘K, a meeting's sources, a decision) opened one doc
  const [linkedVersion, setLinkedVersion] = useState<{ docId: string; version?: number; nonce: number } | null>(null);
  useHandOff<LibraryOpen>(LIBRARY_OPEN_KEY, LIBRARY_OPEN_EVENT, (detail) => {
    if (!detail.docId) return;
    setSelectedId(detail.docId);
    setLinkedVersion({ docId: detail.docId, version: detail.version, nonce: Date.now() });
  });
  const [publish, setPublish] = useState<PublishSeed | null>(null);
  const visibleBots = state.bots.filter((bot) => !bot.hidden);
  const departments = useMemo(() => buildDepartments(visibleBots, org), [visibleBots, org]);
  const docs = data.docs;
  const levels = useMemo(() => new Map(docs.map((doc) => [doc.id, docLevel(doc, departments)])), [docs, departments]);
  const counts = useMemo(() => {
    const out: Record<Filter, number> = { all: docs.length, company: 0, department: 0, isolated: 0 };
    for (const doc of docs) out[levels.get(doc.id)!.kind] += 1;
    return out;
  }, [docs, levels]);
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return docs
      .filter((doc) => filter === "all" || levels.get(doc.id)!.kind === filter)
      .filter((doc) => {
        if (!needle) return true;
        const owner = doc.ownerBotId ? state.bots.find((bot) => bot.id === doc.ownerBotId)?.name ?? "" : "";
        const version = currentVersion(doc);
        return `${doc.title} ${doc.summary ?? ""} ${doc.section ?? ""} ${owner} v${version?.version ?? ""} ${version?.note ?? ""}`.toLowerCase().includes(needle);
      })
      .sort((a, b) => (sort === "name" ? a.title.localeCompare(b.title) : b.updatedAt - a.updatedAt));
  }, [docs, filter, query, sort, levels, state.bots]);
  const selected = docs.find((doc) => doc.id === selectedId) ?? null;
  const unavailable = loaded && Boolean(error);
  const everyone = visibleBots.length;

  const chips: Array<{ value: Filter; label: string; lock?: boolean }> = [
    { value: "all", label: t("All") },
    { value: "company", label: t("Company") },
    { value: "department", label: t("Department") },
    ...(counts.isolated ? [{ value: "isolated" as const, label: t("Isolated zone"), lock: true }] : []),
  ];

  const subscriberText = (doc: LibraryDoc) =>
    doc.subscribers.length === 0 ? "—" : everyone > 0 && doc.subscribers.length >= everyone ? t("Everyone subscribed") : t("{count} subscribed", { count: doc.subscribers.length });

  return (
    <main className="flex h-full min-w-0 flex-1 bg-stage">
      <section className="flex min-w-0 flex-1 flex-col" aria-label={t("Documents")}>
        <header className="flex min-h-[56px] shrink-0 flex-wrap items-center gap-2.5 px-6 pb-1 pt-[18px]">
          <h1 className="text-[22px] font-bold tracking-[-0.2px] text-ink">{t("Library")}</h1>
          <span className="ml-0.5 pt-1 text-[12.5px] text-ink-secondary">{t("The shared base · every document has a version and an owner")}</span>
          <span className="flex-1" />
          <label className="flex h-[34px] w-[236px] items-center gap-2 rounded-[10px] bg-inset px-3 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_45%,transparent)] focus-within:shadow-[inset_0_0_0_1.5px_var(--color-select)]">
            <Search size={16} className="shrink-0 text-ink-secondary" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("Search documents, versions, owners")} aria-label={t("Search documents, versions, owners")} className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-secondary/80" />
          </label>
          <Button onClick={() => setPublish({})}><Plus size={15} strokeWidth={2.4} />{t("Publish")}</Button>
        </header>

        {docs.length > 0 && (
          <div className="flex h-10 shrink-0 items-center gap-1.5 px-6">
            {chips.map((chip) => (
              <button
                key={chip.value}
                type="button"
                onClick={() => setFilter(chip.value)}
                aria-pressed={filter === chip.value}
                className={cn(
                  "inline-flex h-7 items-center gap-[5px] rounded-full px-3 text-[13px] whitespace-nowrap",
                  filter === chip.value ? "bg-ink font-semibold text-stage" : "bg-control/60 font-medium text-ink-secondary hover:bg-control hover:text-ink",
                )}
              >
                {chip.lock && <Lock size={12} />}
                {chip.label}
                <em className={cn("text-[11.5px] font-medium not-italic", filter === chip.value ? "text-stage/60" : "text-ink-secondary/70")}>{counts[chip.value]}</em>
              </button>
            ))}
            <span className="flex-1" />
            <button type="button" onClick={() => setSort((value) => (value === "updated" ? "name" : "updated"))} className="inline-flex items-center gap-0.5 text-[12.5px] text-ink-secondary hover:text-ink">
              {sort === "updated" ? t("By last update") : t("By name")}
              <ChevronDown size={13} />
            </button>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          {!loaded && docs.length === 0 ? (
            <div className="py-24 text-center text-[13px] text-ink-secondary">{t("Loading…")}</div>
          ) : docs.length === 0 ? (
            <EmptyLibrary unavailable={unavailable} onPublish={() => setPublish({})} />
          ) : (
            <>
              <div className={cn(GRID, "mt-2 h-[26px] border-b border-hairline/25 px-2.5 text-[11.5px] font-medium text-ink-secondary/80")}>
                <span />
                <span>{t("Name")}</span>
                <span>{t("Level")}</span>
                <span>{t("Doc owner")}</span>
                <span>{t("Subscribers")}</span>
                <span>{t("Updated")}</span>
                <span>{t("Status")}</span>
              </div>
              <div className="mt-1.5 flex flex-col gap-0.5">
                {shown.map((doc) => {
                  const level = levels.get(doc.id)!;
                  const version = currentVersion(doc);
                  const owner = doc.ownerBotId ? state.bots.find((bot) => bot.id === doc.ownerBotId) : undefined;
                  const stale = staleUsers(doc);
                  const oldest = oldestStaleVersion(doc);
                  const on = doc.id === selectedId;
                  return (
                    <button
                      key={doc.id}
                      type="button"
                      onClick={() => setSelectedId(on ? null : doc.id)}
                      aria-pressed={on}
                      className={cn(GRID, "h-14 rounded-xl px-2.5 text-left", on ? "bg-select/[0.06] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-select)_30%,transparent)]" : "hover:bg-raised-hover")}
                    >
                      <DocIcon level={level} />
                      <span className="flex min-w-0 flex-col gap-0.5 leading-tight">
                        <b className="flex min-w-0 items-center gap-1.5 text-[13.5px] font-semibold">
                          <span className="truncate">{doc.title}</span>
                          {version && <em className={cn("inline-grid h-[18px] shrink-0 place-items-center rounded-[5px] px-[5px] font-mono text-[11px] font-semibold not-italic", on ? "bg-select/15 text-accent-text" : "bg-control/70 text-ink-secondary")}>v{version.version}</em>}
                        </b>
                        <span className="truncate text-[11.5px] text-ink-secondary">{doc.summary || version?.note || t("{size} characters", { size: version?.size ?? 0 })}</span>
                      </span>
                      <span className="min-w-0"><LevelTag level={level} /></span>
                      <span className="flex min-w-0 items-center gap-[5px] text-[12.5px] text-ink-secondary">
                        {owner ? <BotAvatar bot={owner} size={18} /> : null}
                        <span className="truncate">{owner?.name ?? t("You")}</span>
                      </span>
                      <span className="truncate text-[12.5px] text-ink-secondary">{subscriberText(doc)}</span>
                      <span className="text-[12px] tabular-nums text-ink-secondary">{shortWhen(doc.updatedAt)}</span>
                      <span className="flex min-w-0 flex-col items-start gap-1">
                        {stale.length > 0 ? (
                          <span className="inline-flex min-w-0 items-center gap-[5px] text-[12px] font-semibold text-warning">
                            <TriangleAlert size={13} className="shrink-0" />
                            <span className="truncate">{t("{count} still on v{version}", { count: stale.length, version: oldest ?? 0 })}</span>
                          </span>
                        ) : level.kind === "isolated" ? (
                          <span className="inline-flex h-[22px] items-center gap-1 rounded-[7px] bg-control/70 px-2 text-[12px] font-semibold text-ink"><Lock size={11} />{t("Request only")}</span>
                        ) : level.kind === "department" ? (
                          <span className="inline-flex h-[22px] items-center gap-1 rounded-[7px] bg-control/60 px-2 text-[12px] text-ink-secondary"><Eye size={11} />{t("Department only")}</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[12px] text-ink-secondary"><Check size={12} className="text-success" />{t("Up to date")}</span>
                        )}
                        {version?.decisionId ? <DecisionTag id={version.decisionId} /> : null}
                      </span>
                    </button>
                  );
                })}
                {shown.length === 0 && <div className="py-12 text-center text-[13px] text-ink-secondary">{t("No documents match.")}</div>}
              </div>
            </>
          )}
        </div>
      </section>

      {selected && (
        <DocPanel
          key={linkedVersion?.docId === selected.id ? `${selected.id}:${linkedVersion.nonce}` : selected.id}
          initialVersion={linkedVersion?.docId === selected.id ? linkedVersion.version : undefined}
          doc={selected}
          level={levels.get(selected.id)!}
          bots={visibleBots}
          onClose={() => setSelectedId(null)}
          onPublishVersion={(text) => setPublish({ doc: selected, text })}
        />
      )}

      {publish && (
        <PublishDialog
          seed={publish}
          bots={visibleBots}
          sections={departments.map((department) => department.section)}
          onClose={() => setPublish(null)}
          onPublished={(doc) => setSelectedId(doc.id)}
        />
      )}
    </main>
  );
}
