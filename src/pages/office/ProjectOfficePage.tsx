// 项目内协同工作台（正式页面）：手机优先全屏页，桌面居中卡片。
// 从上到下一句话结论 → 等你拍板 → 谁被谁卡住 → 团队 → 折叠的异常/最近动作。
// 数据只走 useProjectOfficeLive（GET /api/task-folders/:id/office，5s 轮询），
// 不依赖 store；拍板/打开对话等动作通过 props 回调交给外壳（路由/切换视图）。
import { useState } from "react";
import { AlertTriangle, ArrowLeft, ChevronDown, History, MessageSquare, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import {
  officeConclusion,
  useProjectOfficeLive,
  type OfficeConclusion,
  type ProjectOffice,
} from "@/lib/office";
import { clock } from "@/lib/workbench";

import { DecisionQueue } from "./DecisionQueue";
import { HandoffCards } from "./HandoffCards";
import { TeamStrip } from "./TeamStrip";
import { ViewSwitch } from "./ViewSwitch";
import { WaitChain } from "./WaitChain";

export interface ProjectOfficePageProps {
  /** task folder id（项目 id） */
  folderId: string;
  /** 项目名；数据未到时也用它在标题栏显示 */
  title: string;
  /** 手机全屏页的返回；不传则不显示返回键（桌面 tab 场景） */
  onClose?: () => void;
  /** 切到「对话」视图 / 「打开对话」按钮 */
  onOpenConversation?: () => void;
}

const TONE_CLASS: Record<OfficeConclusion["tone"], string> = {
  muted: "bg-control text-ink-secondary",
  danger: "bg-danger/[0.09] text-danger",
  warning: "bg-warning/[0.12] text-warning",
  ok: "bg-success/[0.1] text-success",
};

function conclusionText(conclusion: OfficeConclusion): string {
  switch (conclusion.kind) {
    case "loading":
      return t("Connecting to the project office…");
    case "error":
      return t("Could not load the project office.");
    case "decisions":
      return t("{count} decision(s) waiting for you", { count: conclusion.count });
    case "anomalies":
      return t("{count} thing(s) need a look", { count: conclusion.count });
    case "blocked":
      return t("Someone has been blocked for {minutes} minutes", { minutes: conclusion.minutes });
    case "clear":
      return t("Everything is under control right now");
  }
}

export function ProjectOfficePage({ folderId, title, onClose, onOpenConversation }: ProjectOfficePageProps) {
  const { office, loading, error, refresh } = useProjectOfficeLive(folderId);
  const conclusion = officeConclusion(office, { loading, error });
  const [detailsOpen, setDetailsOpen] = useState(false);
  const anomalies = office?.anomalies ?? [];
  const activity = office?.activity ?? [];

  return (
    <main className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-stage text-ink">
      <div className="relative mx-auto flex h-full min-h-0 w-full max-w-[860px] flex-col bg-card max-md:bg-stage md:my-6 md:h-[calc(100%-3rem)] md:rounded-2xl md:shadow-[0_18px_50px_-24px_rgb(16_24_40/0.45),inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent)]">
        {/* ── 顶部：返回 + 项目名 + 视图切换 + 打开对话 ── */}
        <header className="shrink-0 px-4 pt-3 pb-2 sm:px-5">
          <div className="flex min-h-9 items-center gap-1.5">
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label={t("Back")}
                className="-ml-1 grid size-9 shrink-0 place-items-center rounded-full text-ink-secondary hover:bg-control"
              >
                <ArrowLeft size={18} />
              </button>
            )}
            <h1 className="min-w-0 flex-1 truncate text-[18px] leading-tight font-bold tracking-[-0.2px]">{title}</h1>
            <ViewSwitch
              value="office"
              onChange={(next) => {
                if (next === "chat") onOpenConversation?.();
              }}
              className="max-sm:hidden"
            />
            {onOpenConversation && (
              <Button size="sm" variant="soft" className="ml-1 max-sm:h-9" onClick={onOpenConversation}>
                <MessageSquare size={13} />
                {t("Open chat")}
              </Button>
            )}
          </div>
          {/* 手机上视图切换单独一行，thumb 可点 */}
          <div className="mt-2 flex items-center gap-2 sm:hidden">
            <ViewSwitch
              value="office"
              onChange={(next) => {
                if (next === "chat") onOpenConversation?.();
              }}
              className="flex-1 [&>button]:flex-1"
            />
            <button
              type="button"
              aria-label={t("Refresh")}
              onClick={refresh}
              className="grid size-9 shrink-0 place-items-center rounded-full text-ink-secondary hover:bg-control"
            >
              <RefreshCw size={15} className={cn(loading && "animate-spin")} />
            </button>
          </div>

          {/* 一句话结论：没数据时是中性色，永远不是绿色 */}
          <div
            role="status"
            aria-live="polite"
            className={cn("mt-2.5 flex min-h-8 items-center rounded-lg px-2.5 py-1.5 text-[12.5px] font-semibold", TONE_CLASS[conclusion.tone])}
          >
            {conclusionText(conclusion)}
          </div>

          {error && office && (
            <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-lg bg-warning/[0.1] px-2.5 py-1.5 text-[11.5px] text-warning">
              <span className="min-w-0 flex-1">{t("Could not refresh")} · {t("Showing the last update")}</span>
              <button type="button" onClick={refresh} className="font-semibold underline underline-offset-2">
                {t("Retry")}
              </button>
            </div>
          )}
        </header>

        {/* ── 内容 ── */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(20px,env(safe-area-inset-bottom))] sm:px-5">
          {!office && loading && <PageSkeleton />}

          {!office && !loading && (
            <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
              <span className="grid size-9 place-items-center rounded-full bg-danger/10 text-danger">
                <AlertTriangle size={17} />
              </span>
              <b className="text-[14px]">{t("Could not load the project office.")}</b>
              <p className="max-w-[36ch] text-[12.5px] leading-relaxed text-ink-secondary">
                {t("Check that the harness is running, then try again.")}
              </p>
              <Button size="md" className="mt-1 max-sm:h-11" onClick={refresh}>
                <RefreshCw size={13} />
                {t("Retry")}
              </Button>
            </div>
          )}

          {office && (
            <div className="flex flex-col gap-3 pt-1">
              <DecisionQueue decisions={office.decisions ?? []} onResolved={refresh} />
              <WaitChain waiting={office.now?.waiting ?? []} />
              {/* 交接回执：接在「谁被谁卡住」之后；无交接时组件自己整块不渲染 */}
              <HandoffCards folderId={folderId} onChanged={refresh} />
              <TeamStrip departments={office.departments ?? []} />
              <DetailsFold
                office={office}
                anomalies={anomalies}
                open={detailsOpen}
                onToggle={() => setDetailsOpen((value) => !value)}
                activity={activity}
              />
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

/** 底部「异常 / 最近动作」折叠区。默认收起：老板先看拍板、卡住、团队。 */
function DetailsFold({
  office,
  anomalies,
  activity,
  open,
  onToggle,
}: {
  office: ProjectOffice;
  anomalies: ProjectOffice["anomalies"];
  activity: ProjectOffice["activity"];
  open: boolean;
  onToggle: () => void;
}) {
  const latest = activity[0];
  return (
    <section className="rounded-[14px] bg-raised shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent)]">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex min-h-11 w-full items-center gap-1.5 px-3.5 text-left text-[12.5px] font-semibold text-ink-secondary"
      >
        <History size={14} />
        <span className="min-w-0 flex-1 truncate">
          {t("Needs a look")}
          {anomalies.length > 0 && <span className="text-warning"> · {anomalies.length}</span>}
          {latest && (
            <span className="ml-1.5 font-normal text-ink-secondary/70">
              {t("Latest: {summary}", { summary: latest.summary })}
            </span>
          )}
        </span>
        <ChevronDown size={14} className={cn("shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="border-t border-hairline/25 px-3.5 pt-2 pb-3">
          {anomalies.length === 0 ? (
            <p className="text-[12px] text-ink-secondary">{t("No exceptions right now.")}</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {anomalies.slice(0, 6).map((anomaly) => (
                <li key={`${anomaly.subtaskId}-${anomaly.kind}`} className="rounded-lg bg-warning/[0.08] px-2.5 py-1.5 text-[12px] leading-relaxed text-ink-secondary">
                  <b className="text-ink">{anomaly.title}</b> · {anomaly.detail}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 text-[11.5px] font-semibold text-ink-secondary/80">{t("Recent activity")}</div>
          {activity.length === 0 ? (
            <p className="mt-1 text-[12px] text-ink-secondary">{t("No recent activity.")}</p>
          ) : (
            <ul className="mt-1 flex flex-col gap-1">
              {activity.slice(0, 8).map((entry, index) => (
                <li key={`${entry.at}-${index}`} className="flex items-baseline gap-2 text-[12px] leading-relaxed text-ink-secondary">
                  <span className="shrink-0 font-mono text-[11px] text-ink-secondary/70">{clock(entry.at)}</span>
                  <span className="min-w-0 flex-1">
                    <b className="font-medium text-ink">{entry.actor}</b> · {entry.summary}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {office.project?.leadName && (
            <p className="mt-2 text-[11.5px] text-ink-secondary/70">
              {t("Lead: {name}", { name: office.project.leadName })}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/** 首屏骨架：三块固定高度占位，避免加载时页面跳动。 */
function PageSkeleton() {
  return (
    <div aria-busy className="flex flex-col gap-3 pt-1">
      {[0, 1, 2].map((index) => (
        <div key={index} className="rounded-[14px] bg-raised px-3.5 py-3 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent)]">
          <div className="h-3.5 w-28 animate-pulse rounded bg-control" />
          <div className="mt-2.5 h-3 w-full animate-pulse rounded bg-control/70" />
          <div className="mt-1.5 h-3 w-4/5 animate-pulse rounded bg-control/70" />
        </div>
      ))}
    </div>
  );
}
