// The settings page's sections in nav order, and how the nav search matches
// them. Labels are English sources (msg) shown through t(); the keywords let
// a search typed in either language find a section by what lives inside it.
import type { AppSettingsSection } from "@/state/store";
import { msg, t } from "@/lib/i18n";

export interface SettingsSectionDef {
  id: AppSettingsSection;
  label: string;
  keywords: readonly string[];
}

export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  {
    id: "general",
    label: msg("General"),
    keywords: ["profile", "name", "email", "dispatch", "chief", "tool calls", "analytics", "diagnostics", "channel", "个人资料", "名字", "邮箱", "派发", "调度", "总控", "工具调用", "诊断", "群聊", "频道"],
  },
  {
    id: "appearance",
    label: msg("Appearance"),
    keywords: ["skin", "theme", "language", "dark", "fog", "midnight", "皮肤", "主题", "语言", "中文", "英文", "深色"],
  },
  {
    id: "org",
    label: msg("Organization"),
    keywords: ["department", "lead", "budget", "headcount", "isolated", "project", "rules", "decision", "部门", "主管", "预算", "编制", "隔离", "项目组", "规则", "拍板", "组织架构"],
  },
  {
    id: "engines",
    label: msg("Engines"),
    keywords: ["models", "claude", "grok", "codex", "kimi", "qwen", "providers", "cli", "workbuddy", "codebuddy", "tencent", "ollama", "strategy", "腾讯", "模型", "引擎", "推荐策略", "命令行"],
  },
  {
    id: "review",
    label: msg("Auto-review"),
    keywords: ["approval", "approve", "auto mode", "always allow", "ask first", "permissions", "审批", "自动批准", "先问", "权限", "总是允许"],
  },
  {
    id: "cadence",
    label: msg("Reports & cadence"),
    keywords: ["report", "daily", "brief", "escalate", "cadence", "汇报", "日报", "简报", "上报", "节奏"],
  },
  {
    id: "computer",
    label: msg("Computer"),
    keywords: ["vm", "virtual", "desktop", "cua", "虚拟机", "桌面"],
  },
  {
    id: "connections",
    label: msg("Connections"),
    keywords: ["keys", "api", "composio", "box", "xai", "vps", "transcription", "密钥", "转写", "云电脑"],
  },
  {
    id: "companion",
    label: msg("Mobile"),
    keywords: ["companion", "phone", "pair", "mobile", "iphone", "手机", "配对"],
  },
  {
    id: "usage",
    label: msg("Usage & billing"),
    keywords: ["tokens", "cost", "billing", "spend", "budget", "用量", "花费", "账单", "预算"],
  },
  {
    id: "experimental",
    label: msg("Experimental"),
    keywords: ["early", "preview", "teach", "skill", "browser", "profiles", "实验", "技能", "浏览器"],
  },
  {
    id: "updates",
    label: msg("Updates"),
    keywords: ["version", "update", "upgrade", "release", "版本", "升级"],
  },
  {
    id: "about",
    label: msg("About"),
    keywords: ["about", "version", "author", "github", "license", "open source", "关于", "版本", "作者", "开源", "协议"],
  },
];

/** Whether a section matches a (trimmed, lower-cased) nav search. Both the
 * English source and the shown translation of the label are searchable. */
export function sectionMatches(section: SettingsSectionDef, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [section.label, t(section.label), ...section.keywords].some((part) => part.toLowerCase().includes(q));
}

export function visibleSections(query: string): SettingsSectionDef[] {
  return SETTINGS_SECTIONS.filter((section) => sectionMatches(section, query));
}

export function sectionById(id: AppSettingsSection): SettingsSectionDef {
  return SETTINGS_SECTIONS.find((section) => section.id === id) ?? SETTINGS_SECTIONS[0]!;
}
