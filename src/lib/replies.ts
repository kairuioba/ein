import { t } from "@/lib/i18n";
import type { Message } from "@/state/store";

export function replySnippet(text: string, limit = 160): string {
  const clean = text
    .replace(/<attached-image\s+path="[^"]*"\s*\/>/g, t("[image]"))
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}
export function replyAuthor(message: Message, fallback = t("Assistant")): string {
  return message.role === "user" ? t("You") : (message.from?.name ?? fallback);
}
