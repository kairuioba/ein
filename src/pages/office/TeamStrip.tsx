// 团队：按部门列出成员，每个成员一枚 chip（状态点 + 姓名 + 状态词）。
// 状态只能是服务端从子任务/交接/评审事实推导的 presence，不做 hover 才可见的
// 信息——手机上没有 hover。纯展示组件，数据通过 props 进来。
import { Users } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { OfficeMember, ProjectOffice } from "@/lib/office";

const PRESENCE: Record<OfficeMember["presence"], { label: string; dot: string; text: string }> = {
  working: { label: t("Working"), dot: "bg-select", text: "text-accent-text" },
  waiting: { label: t("Waiting on someone"), dot: "bg-warning", text: "text-warning" },
  reviewing: { label: t("Reviewing"), dot: "bg-[#8B5CF6]", text: "text-[#6D3FE0]" },
  blocked: { label: t("Blocked"), dot: "bg-danger", text: "text-danger" },
  idle: { label: t("Idle"), dot: "bg-hairline", text: "text-ink-secondary" },
};

export function TeamStrip({
  departments,
}: {
  departments: ProjectOffice["departments"];
}) {
  const total = departments.reduce((sum, department) => sum + department.members.length, 0);
  return (
    <section aria-label={t("The team")} className="rounded-[14px] bg-raised px-3.5 py-3 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent)]">
      <div className="flex items-center gap-1.5 text-[13px] font-semibold">
        <Users size={14} className="text-ink-secondary" />
        {t("The team")}
        {total > 0 && <span className="ml-auto text-[11.5px] font-medium text-ink-secondary/70">{t("{count} people", { count: total })}</span>}
      </div>
      {departments.length === 0 || total === 0 ? (
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-secondary">{t("No members are working in this project yet.")}</p>
      ) : (
        <div className="mt-2 flex flex-col gap-2.5">
          {departments.map((department) => (
            <div key={department.name}>
              <div className="mb-1 text-[11.5px] font-semibold text-ink-secondary/80">{department.name}</div>
              {department.members.length === 0 ? (
                <p className="text-[11.5px] text-ink-secondary/70">{t("No members are working in this project yet.")}</p>
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {department.members.map((member) => {
                    const presence = PRESENCE[member.presence] ?? PRESENCE.idle;
                    return (
                      <li
                        key={member.botId}
                        className="inline-flex min-h-8 items-center gap-1.5 rounded-full bg-inset pr-2.5 pl-2 text-[12px] text-ink"
                        title={member.current ?? presence.label}
                      >
                        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", presence.dot)} />
                        <span className="max-w-[10rem] truncate font-medium">{member.name}</span>
                        {/* 状态词常显：手机没有 hover */}
                        <span className={cn("shrink-0 text-[11px]", presence.text)}>{presence.label}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
