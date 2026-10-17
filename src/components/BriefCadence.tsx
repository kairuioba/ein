// 简报页的站会/周复盘：数字与固定文案全部来自服务端代码，不调模型。
import { useEffect, useState } from "react";
import { CalendarClock } from "lucide-react";

import { api } from "@/state/store";
import { t } from "@/lib/i18n";

interface Standup {
  lines: string[];
  counts: { running: number; blocked: number; waitingOwner: number };
}
interface Weekly {
  highlights: string[];
  warnings: string[];
}

export function BriefCadence() {
  const [standup, setStandup] = useState<Standup | null>(null);
  const [weekly, setWeekly] = useState<Weekly | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [s, b] = await Promise.all([
          api("/api/standup") as Promise<{ standup?: Standup }>,
          api("/api/office/brief") as Promise<{ weekly?: Weekly }>,
        ]);
        if (!alive) return;
        setStandup(s.standup ?? null);
        setWeekly(b.weekly ?? null);
      } catch {
        // cadence data is optional; hide rather than disturb the brief
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, []);
  if (!standup && !weekly) return null;
  return (
    <section className="mb-2 rounded-2xl bg-card p-3 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent)]">
      <div className="mb-1.5 flex items-center gap-2">
        <CalendarClock size={15} className="text-ink-secondary" />
        <b className="text-[13.5px] text-ink">{t("Standup and weekly review")}</b>
      </div>
      {standup && (
        <ul className="space-y-0.5 text-[12px] leading-relaxed text-ink-secondary">
          {standup.lines.slice(0, 4).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {weekly && (weekly.highlights.length > 0 || weekly.warnings.length > 0) && (
        <div className="mt-2 border-t border-hairline/25 pt-1.5 text-[11.5px] text-ink-secondary">
          <div className="mb-0.5 font-semibold text-ink">{t("Last week")}</div>
          {weekly.highlights.slice(0, 3).map((line) => <p key={line}>{line}</p>)}
          {weekly.warnings.slice(0, 3).map((line) => <p key={line} className="text-warning">{line}</p>)}
        </div>
      )}
    </section>
  );
}
