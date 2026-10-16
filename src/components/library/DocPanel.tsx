// The 资料库 detail panel (U5): level and current version, the text with
// 打开 / 下载 / 复制, the owner, the version history (each opens its text),
// what changed since the previous version, subscribers, and who still uses
// an older version (with 再提醒).
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Check, Copy, Download, ExternalLink, Lock, PanelRightClose, TriangleAlert, Upload, X } from "lucide-react";

import { BotAvatar } from "@/components/Avatar";
import { Button, Dialog, SidePanel } from "@/components/ui";
import { dayTimeLabel, shortWhen } from "@/lib/calendar-view";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { changeHunks, currentVersion, diffLines, downloadName, staleUsers, summaryOf, type DocLevel } from "@/lib/library-view";
import { readLibraryDoc } from "@/state/org-api";
import { useStore, type Bot } from "@/state/store";
import type { LibraryDoc } from "../../../shared/org-types";
import { downloadText, setLibrarySubscription } from "./library-actions";
import { DecisionTag, LevelTag } from "./LibraryTags";

function Label({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-[12px] font-semibold text-ink-secondary">
      {children}
      {right && <span className="ml-auto font-medium">{right}</span>}
    </div>
  );
}

function Count({ value, amber }: { value: number; amber?: boolean }) {
  return <span className={cn("inline-grid h-[18px] min-w-[18px] place-items-center rounded-full px-1.5 text-[11px] font-bold", amber ? "bg-warning/12 text-warning" : "bg-control/70 text-ink-secondary")}>{value}</span>;
}

export function DocPanel({
  doc,
  level,
  bots,
  onClose,
  onPublishVersion,
  initialVersion,
}: {
  doc: LibraryDoc;
  level: DocLevel;
  bots: Bot[];
  onClose: () => void;
  onPublishVersion: (text: string) => void;
  /** open on this version (a link to "价格表 v3"); the current one otherwise */
  initialVersion?: number;
}) {
  const { dispatch } = useStore();
  const current = currentVersion(doc);
  const versions = useMemo(() => [...doc.versions].sort((a, b) => b.version - a.version), [doc.versions]);
  // an older version picked from the history; null follows the current one,
  // so a newly published version takes over the panel
  const [picked, setPicked] = useState<number | null>(() =>
    initialVersion !== undefined && initialVersion !== current?.version && doc.versions.some((entry) => entry.version === initialVersion) ? initialVersion : null,
  );
  const shown = picked ?? current?.version ?? 0;
  const [texts, setTexts] = useState<Record<number, string>>({});
  const [loadError, setLoadError] = useState("");
  const [fullOpen, setFullOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editingSubs, setEditingSubs] = useState(false);
  const [subsError, setSubsError] = useState("");
  const [reminded, setReminded] = useState<number | null>(null);
  const previous = versions.find((version) => version.version < shown);
  const owner = doc.ownerBotId ? bots.find((bot) => bot.id === doc.ownerBotId) : undefined;
  const stale = staleUsers(doc);
  const subscribers = doc.subscribers.flatMap((id) => bots.find((bot) => bot.id === id) ?? []);
  const shownVersion = versions.find((version) => version.version === shown);

  // a reminder was about the version that was current then
  useEffect(() => setReminded(null), [current?.version]);

  useEffect(() => {
    setPicked(null);
    setTexts({});
    setEditingSubs(false);
    setReminded(null);
  }, [doc.id]);

  // the shown version's text, and the one before it for the diff
  useEffect(() => {
    let alive = true;
    const wanted = [shown, previous?.version].filter((version): version is number => typeof version === "number" && version > 0 && texts[version] === undefined);
    for (const version of wanted) {
      readLibraryDoc(doc.id, version)
        .then((result) => { if (alive) setTexts((currentTexts) => ({ ...currentTexts, [version]: result.text })); })
        .catch((cause) => { if (alive) setLoadError(cause instanceof Error ? cause.message : String(cause)); });
    }
    return () => { alive = false; };
    // texts is read only to skip versions already loaded
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, shown, previous?.version]);

  const text = texts[shown];
  const hunks = useMemo(() => (previous && text !== undefined && texts[previous.version] !== undefined ? changeHunks(diffLines(texts[previous.version]!, text)) : null), [previous, text, texts]);

  const copy = async () => {
    if (text === undefined) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_200);
    } catch {
      /* clipboard unavailable — 下载 still works */
    }
  };
  const remind = () => {
    for (const use of stale) {
      dispatch({
        type: "send",
        botId: use.botId,
        text: t("The library’s “{title}” is now v{version} (you used v{old}). Please switch to the new version.", { title: doc.title, version: current?.version ?? 0, old: use.version }),
      });
    }
    setReminded(Date.now());
  };
  const toggleSubscriber = async (botId: string) => {
    setSubsError("");
    try {
      await setLibrarySubscription(doc.id, botId, !doc.subscribers.includes(botId));
    } catch (cause) {
      setSubsError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const rule = level.kind === "company"
    ? t("Only the owner edits · everyone reads")
    : level.kind === "isolated"
      ? t("Only {section} can read; others request redacted answers", { section: level.section })
      : t("Only the owner edits · {section} reads", { section: level.section });

  return (
    <SidePanel
      width={370}
      label={t("Document details: {title}", { title: doc.title })}
      onBack={onClose}
      title={`${doc.title} v${current?.version ?? 0}`}
      actions={
        <button type="button" onClick={onClose} aria-label={t("Hide details")} className="grid size-8 place-items-center rounded-lg text-ink-secondary hover:bg-raised-hover hover:text-ink">
          <PanelRightClose size={17} />
        </button>
      }
    >
      <div className="flex flex-col gap-6 pb-2 pt-1">
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <LevelTag level={level} />
            <span className="inline-flex h-[22px] items-center rounded-[7px] bg-select/10 px-2 text-[12px] font-semibold text-accent-text">{t("Current v{version}", { version: current?.version ?? 0 })}</span>
            {current && <span className="ml-0.5 text-[12px] text-ink-secondary">{t("published {when}", { when: dayTimeLabel(current.at) })}</span>}
          </div>
          <p className="m-0 text-[13px] leading-[1.6] text-ink-secondary">{text === undefined ? (loadError ? t("Couldn't load this version: {error}", { error: loadError }) : t("Loading…")) : (shown === current?.version && doc.summary) || summaryOf(text, 140, doc.title) || t("This version is empty.")}</p>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" onClick={() => setFullOpen(true)} disabled={text === undefined}><ExternalLink size={13} />{t("Open")}</Button>
            <Button size="sm" variant="soft" onClick={() => text !== undefined && downloadText(downloadName(doc.title, shown), text)} disabled={text === undefined}><Download size={13} />{t("Download")}</Button>
            <Button size="sm" variant="soft" onClick={() => void copy()} disabled={text === undefined}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? t("Copied") : t("Copy text")}</Button>
          </div>
        </div>

        <section className="flex flex-col gap-2">
          <Label>{t("Doc owner")}</Label>
          <div className="flex items-center gap-2">
            {owner ? <BotAvatar bot={owner} size={24} /> : <span className="grid size-6 place-items-center rounded-[7px] bg-control text-[11px] font-bold text-ink-secondary">{t("You").slice(0, 1)}</span>}
            <span className="flex min-w-0 flex-col leading-tight">
              <b className="truncate text-[13.5px] font-semibold">{owner?.name ?? t("You")}</b>
              {owner?.title && <span className="truncate text-[11.5px] text-ink-secondary">{owner.title}</span>}
            </span>
            <span className="ml-auto inline-flex h-6 min-w-0 items-center gap-1 rounded-[7px] bg-control/60 px-2 text-[11.5px] text-ink-secondary"><Lock size={11} className="shrink-0" /><span className="truncate">{rule}</span></span>
          </div>
        </section>

        <section className="flex flex-col gap-1">
          <Label>{t("Version history")}</Label>
          <div className="relative flex flex-col">
            <span className="absolute bottom-3.5 left-[5px] top-3.5 w-[1.5px] bg-hairline/45" aria-hidden />
            {versions.map((version) => {
              const on = version.version === shown;
              return (
                <button key={version.version} type="button" onClick={() => setPicked(version.version === current?.version ? null : version.version)} className="relative flex h-[30px] items-center gap-2 text-left text-[12.5px]">
                  <i className={cn("size-[11px] shrink-0 rounded-full bg-stage", on ? "shadow-[inset_0_0_0_3.5px_var(--color-select)]" : "shadow-[inset_0_0_0_2px_color-mix(in_oklab,var(--color-hairline)_80%,transparent)]")} />
                  <b className={cn("w-[26px] shrink-0 font-mono text-[12px] font-bold", !on && "text-ink-secondary")}>v{version.version}</b>
                  <span className="w-[64px] shrink-0 truncate text-[12px] text-ink-secondary">{shortWhen(version.at)}</span>
                  {version.decisionId ? <DecisionTag id={version.decisionId} /> : <span className="min-w-0 truncate text-ink-secondary">{version.note ?? ""}</span>}
                  {version.version === current?.version && <span className="ml-auto shrink-0 text-[11.5px] font-semibold text-accent-text">{t("Current")}</span>}
                </button>
              );
            })}
          </div>
        </section>

        {previous && (
          <section className="flex flex-col gap-2">
            <Label right={shownVersion?.note}>
              {hunks === null ? `v${previous.version} → v${shown}` : t("v{from} → v{to}: {count} changes", { from: previous.version, to: shown, count: hunks.length })}
            </Label>
            {hunks === null ? (
              <div className="rounded-[10px] bg-inset px-3 py-2.5 text-[12px] text-ink-secondary">{t("Loading…")}</div>
            ) : hunks.length === 0 ? (
              <div className="rounded-[10px] bg-inset px-3 py-2.5 text-[12px] text-ink-secondary">{t("Same text as v{version}.", { version: previous.version })}</div>
            ) : (
              <div className="flex flex-col gap-1.5 rounded-[10px] bg-inset px-3 py-2.5 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_25%,transparent)]">
                {hunks.slice(0, 3).map((hunk, index) => (
                  <div key={index} className="flex min-w-0 flex-wrap items-center gap-1.5 text-[12.5px] tabular-nums">
                    {hunk.removed.slice(0, 1).map((line) => <s key="r" className="min-w-0 max-w-full truncate rounded-[5px] bg-danger/10 px-1.5 font-semibold text-danger decoration-[1.5px]">{line.trim() || "∅"}</s>)}
                    {hunk.removed.length > 0 && hunk.added.length > 0 && <ArrowRight size={13} className="shrink-0 text-ink-secondary" />}
                    {hunk.added.slice(0, 1).map((line) => <ins key="a" className="min-w-0 max-w-full truncate rounded-[5px] bg-success/12 px-1.5 font-bold text-success no-underline">{line.trim() || "∅"}</ins>)}
                  </div>
                ))}
                {hunks.length > 3 && <span className="text-[11.5px] text-ink-secondary">{t("and {count} more", { count: hunks.length - 3 })}</span>}
              </div>
            )}
          </section>
        )}

        <section className="flex flex-col gap-2">
          <Label right={<button type="button" onClick={() => setEditingSubs((value) => !value)} className="font-semibold text-accent-text hover:underline">{editingSubs ? t("Done") : t("Manage")}</button>}>
            {t("Subscribers")}
            <Count value={subscribers.length} />
          </Label>
          {subscribers.length > 0 ? (
            <>
              <div className="flex flex-wrap items-center gap-1">{subscribers.map((bot) => <BotAvatar key={bot.id} bot={bot} size={24} />)}</div>
              <div className="text-[11.5px] leading-relaxed text-ink-secondary">{subscribers.map((bot) => bot.name).join("、")}</div>
            </>
          ) : (
            <div className="text-[12px] text-ink-secondary">{t("Nobody is told about new versions yet.")}</div>
          )}
          {editingSubs && (
            <div className="max-h-48 overflow-y-auto rounded-[10px] bg-inset p-1.5">
              {bots.map((bot) => {
                const on = doc.subscribers.includes(bot.id);
                return (
                  <button key={bot.id} type="button" role="checkbox" aria-checked={on} onClick={() => void toggleSubscriber(bot.id)} className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[12.5px] hover:bg-raised-hover">
                    <BotAvatar bot={bot} size={20} />
                    <span className="min-w-0 flex-1 truncate">{bot.name}</span>
                    <span className={cn("grid size-4 place-items-center rounded-[5px]", on ? "bg-select text-white" : "shadow-[inset_0_0_0_1.5px_color-mix(in_oklab,var(--color-hairline)_80%,transparent)]")}>{on && <Check size={11} strokeWidth={3} />}</span>
                  </button>
                );
              })}
            </div>
          )}
          {subsError && <div className="rounded-lg bg-danger/10 px-2.5 py-1.5 text-[11.5px] text-danger">{subsError}</div>}
        </section>

        {stale.length > 0 && (
          <section className="flex flex-col gap-2">
            <Label>{t("Still on an old version")}<Count value={stale.length} amber /></Label>
            {stale.map((use) => {
              const bot = bots.find((candidate) => candidate.id === use.botId);
              return (
                <div key={use.botId} className="flex h-11 items-center gap-2 rounded-[10px] bg-warning/[0.07] pl-2 pr-2.5 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-warning)_30%,transparent)]">
                  {bot && <BotAvatar bot={bot} size={20} />}
                  <span className="flex min-w-0 flex-col leading-tight">
                    <b className="truncate text-[13px] font-semibold">{bot?.name ?? use.botId}</b>
                    {bot?.title && <span className="truncate text-[11.5px] text-ink-secondary">{bot.title}</span>}
                  </span>
                  <span className="ml-auto inline-flex h-[22px] shrink-0 items-center gap-1 rounded-[7px] bg-stage px-2 text-[12px] font-semibold text-warning shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-warning)_30%,transparent)]"><TriangleAlert size={12} />{t("uses v{version}", { version: use.version })}</span>
                </div>
              );
            })}
            <div className="mt-0.5 flex items-center gap-2.5">
              {reminded ? <span className="inline-flex items-center gap-1 text-[12px] text-ink-secondary">{t("Reminded {when}", { when: dayTimeLabel(reminded) })}<Check size={12} className="text-success" /></span> : <span className="text-[12px] text-ink-secondary">{t("They keep the old numbers until they switch.")}</span>}
              <span className="flex-1" />
              <Button size="sm" variant="ghost" onClick={remind}>{reminded ? t("Remind again") : t("Remind them")}</Button>
            </div>
          </section>
        )}

        <Button variant="soft" onClick={() => text !== undefined && onPublishVersion(texts[current?.version ?? 0] ?? text)} disabled={text === undefined} className="self-start">
          <Upload size={14} />{t("Publish a new version")}
        </Button>
      </div>

      <Dialog open={fullOpen} onClose={() => setFullOpen(false)} label={`${doc.title} v${shown}`} width={760} className="max-h-[88vh]">
        <div className="flex items-center gap-2 px-5 pb-2 pt-4">
          <b className="min-w-0 flex-1 truncate text-[16px]">{doc.title} <span className="font-mono text-[13px] text-ink-secondary">v{shown}</span></b>
          <Button size="sm" variant="soft" onClick={() => text !== undefined && downloadText(downloadName(doc.title, shown), text)}><Download size={13} />{t("Download")}</Button>
          <button type="button" onClick={() => setFullOpen(false)} aria-label={t("Close")} className="grid size-8 place-items-center rounded-lg text-ink-secondary hover:bg-raised-hover hover:text-ink"><X size={16} /></button>
        </div>
        <pre className="m-0 min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-5 pb-5 font-sans text-[13.5px] leading-relaxed text-ink">{text}</pre>
      </Dialog>
    </SidePanel>
  );
}
