// Small tags shared by the library list and detail panel: the level chip
// (公司 teal · 部门 with its colour · 隔离区 hatched), the decision chip
// (◆ 源自决定 #n) and the document icon tile.
import { FileText, Lock } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { DocLevel } from "@/lib/library-view";

// level colours follow the org model (O2): company teal, isolated slate
const COMPANY = { bg: "color-mix(in srgb, #14B8A6 14%, var(--color-stage))", fg: "color-mix(in srgb, #0F766E 85%, var(--color-ink))" };
const HATCH = "repeating-linear-gradient(135deg, color-mix(in srgb, #475467 8%, var(--color-stage)) 0 4px, color-mix(in srgb, #475467 15%, var(--color-stage)) 4px 8px)";

export function LevelTag({ level }: { level: DocLevel }) {
  if (level.kind === "company") {
    return <span className="inline-flex h-[22px] shrink-0 items-center rounded-[7px] px-2 text-[12px] font-semibold whitespace-nowrap" style={{ background: COMPANY.bg, color: COMPANY.fg }}>{t("Company")}</span>;
  }
  if (level.kind === "isolated") {
    return (
      <span className="inline-flex h-[22px] shrink-0 items-center gap-1 rounded-[7px] px-2 text-[12px] font-semibold whitespace-nowrap text-ink" style={{ background: HATCH }}>
        <Lock size={11} />
        {t("Isolated zone")}
      </span>
    );
  }
  return (
    <span className="inline-flex h-[22px] min-w-0 items-center gap-[5px] rounded-[7px] bg-control/60 px-2 text-[12px] font-medium whitespace-nowrap text-ink-secondary">
      <i className="size-[7px] shrink-0 rounded-[2px]" style={{ background: level.color }} />
      <span className="truncate">{t("Department · {name}", { name: level.section })}</span>
    </span>
  );
}

export function DecisionTag({ id, className }: { id: number; className?: string }) {
  return (
    <span className={cn("inline-flex h-5 shrink-0 items-center gap-1 rounded-[6px] bg-control/60 px-1.5 text-[11.5px] font-medium whitespace-nowrap text-ink", className)}>
      <i className="inline-block size-1.5 rotate-45 rounded-[1px] bg-ink" />
      {t("From decision #{id}", { id })}
    </span>
  );
}

export function DocIcon({ level }: { level: DocLevel }) {
  const style =
    level.kind === "company"
      ? { background: COMPANY.bg, color: COMPANY.fg }
      : level.kind === "isolated"
        ? { background: HATCH, color: "var(--color-ink-secondary)" }
        : { background: `color-mix(in srgb, ${level.color} 13%, var(--color-stage))`, color: `color-mix(in srgb, ${level.color} 78%, var(--color-ink))` };
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-[9px]" style={style} aria-hidden>
      <FileText size={16} />
    </span>
  );
}
