// 项目视图切换：`协同 | 对话`。受控组件，职责只有渲染；点哪边由调用方决定
// 怎么切（路由、隐藏/挂载、保留草稿……）。样式与设置页的 Segmented 同语汇，
// 但单独成文件：它要被项目工作台和聊天窗口共用，且手机上要能拉满整行。
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

export type ProjectView = "office" | "chat";

export function ViewSwitch({
  value,
  onChange,
  className,
}: {
  value: ProjectView;
  onChange: (next: ProjectView) => void;
  className?: string;
}) {
  const items: Array<{ value: ProjectView; label: string }> = [
    { value: "office", label: t("Collaborate") },
    { value: "chat", label: t("Chat") },
  ];
  return (
    <div
      role="tablist"
      aria-label={t("Project view")}
      className={cn("inline-flex h-10 shrink-0 items-center gap-0.5 rounded-[10px] bg-track p-0.5 sm:h-9", className)}
    >
      {items.map((item) => {
        const active = value === item.value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(item.value)}
            className={cn(
              "inline-flex h-9 min-w-[62px] items-center justify-center rounded-lg px-3 text-[13px] font-semibold whitespace-nowrap transition-colors sm:h-8",
              active ? "bg-raised text-ink shadow-[0_1px_2px_rgb(16_24_40/0.12)]" : "text-ink-secondary hover:text-ink",
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
