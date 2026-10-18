// 任务下的组织层级：任务总控 → 项目负责人 → 一级部门（人数/在干什么）→ 员工（在干什么）。
// 部门/员工状态来自 GET /api/task-folders/:id/office（全部由派单事实推导）。
import { useEffect, useState } from "react";
import { Bot, ChevronDown, Users } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { api } from "@/state/store";
import type { TaskFolderView } from "../../shared/task-folders";

interface OfficeMember {
  botId: string;
  name: string;
  presence: "working" | "waiting" | "reviewing" | "blocked" | "idle";
  current?: string;
  waitingOn?: string;
}
interface OfficeDepartment {
  name: string;
  members: OfficeMember[];
}

const PRESENCE_LABEL: Record<OfficeMember["presence"], string> = {
  working: "工作中",
  waiting: "等别人",
  reviewing: "评审中",
  blocked: "受阻",
  idle: "空闲",
};
export function TaskHierarchy({ task, onOpenTask }: { task: TaskFolderView; onOpenTask: () => void }) {
  const [departments, setDepartments] = useState<OfficeDepartment[] | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const payload = (await api(`/api/task-folders/${task.id}/office`)) as { office?: { departments?: OfficeDepartment[] } };
        if (alive) setDepartments(payload.office?.departments ?? []);
      } catch {
        if (alive) setError(t("Could not load the team"));
      }
    };
    void load();
    return () => { alive = false; };
  }, [task.id]);
  const controller = task.conversationBotName ?? t("Not assigned yet");
  const lead = task.leadName && task.leadName !== task.conversationBotName ? task.leadName : t("Not assigned yet");
  const workOf = (department: OfficeDepartment): string => {
    const jobs = [...new Set(department.members.map((member) => member.current).filter(Boolean))] as string[];
    return jobs.length ? jobs.slice(0, 2).join("、") : t("No work assigned yet");
  };
  return (
    <div className="mb-1 ml-4 flex flex-col gap-0.5 border-l border-hairline/40 pl-2">
      {/* 任务总控：主要跟你沟通的那个 bot */}
      <button type="button" onClick={onOpenTask} className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-raised-hover/70">
        <Bot size={12} className="shrink-0 text-ink-secondary" />
        <span className="text-[11px] font-medium text-ink">{t("Task chief")}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-ink-secondary">{controller}</span>
      </button>
      {/* 项目负责人：总控跟他沟通，不直接指挥部门 */}
      <div className="flex min-w-0 items-center gap-1.5 px-1.5 py-0.5">
        <span className="text-[11px] text-ink-secondary">{t("Project lead")}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-ink">{lead}</span>
      </div>
      {error && <span className="px-1.5 text-[10.5px] text-ink-secondary/70">{error}</span>}
      {departments?.map((department) => {
        const expanded = open[department.name] ?? false;
        return (
          <div key={department.name} className="flex flex-col">
            <button
              type="button"
              onClick={() => setOpen((state) => ({ ...state, [department.name]: !expanded }))}
              className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-raised-hover/70"
            >
              <Users size={11} className="shrink-0 text-ink-secondary" />
              <span className="min-w-0 truncate text-[11px] text-ink">{department.name}</span>
              <span className="shrink-0 rounded-full bg-control px-1.5 text-[10px] text-ink-secondary">{t("{count} people", { count: department.members.length })}</span>
              <span className="min-w-0 flex-1 truncate text-right text-[10.5px] text-ink-secondary/75">{workOf(department)}</span>
              <ChevronDown size={11} className={cn("shrink-0 text-ink-secondary/60 transition-transform", expanded && "rotate-180")} />
            </button>
            {expanded && department.members.length > 0 && (
              <div className="mb-0.5 ml-4 flex flex-col gap-px border-l border-hairline/40 pl-2">
                {department.members.map((member) => (
                  <div key={member.botId} className="flex min-w-0 items-center gap-1.5 px-1 py-0.5">
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        member.presence === "working" && "bg-select",
                        member.presence === "waiting" && "bg-warning",
                        member.presence === "reviewing" && "bg-accent-text",
                        member.presence === "blocked" && "bg-danger",
                        member.presence === "idle" && "bg-hairline",
                      )}
                    />
                    <span className="shrink-0 text-[11px] text-ink">{member.name}</span>
                    <span className="min-w-0 flex-1 truncate text-[10.5px] text-ink-secondary/80">
                      {member.current ?? member.waitingOn ?? PRESENCE_LABEL[member.presence]}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {departments && departments.length === 0 && (
        <span className="px-1.5 pb-0.5 text-[10.5px] text-ink-secondary/70">{t("No departments yet — confirm a plan to staff this task.")}</span>
      )}
    </div>
  );
}
