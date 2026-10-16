import { MessageSquareReply, X } from "lucide-react";

import { replyAuthor, replySnippet } from "@/lib/replies";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Message } from "@/state/store";
import { plainText } from "./chat/chat-model";

/** The quoted message a reply answers. `compact` is the quote inside a
 * bubble: it takes the bubble's own ink, so it reads on the black user
 * bubble and on the grey bot bubble alike. */
export function ReplyQuote({
  message,
  fallbackName,
  onJump,
  onClear,
  compact = false,
}: {
  message: Message;
  fallbackName?: string;
  onJump?: () => void;
  onClear?: () => void;
  compact?: boolean;
}) {
  const body = (
    <>
      <MessageSquareReply size={compact ? 12 : 14} className={cn("shrink-0", compact ? "opacity-70" : "text-accent")} />
      <span className="min-w-0 flex-1">
        <span className={cn("block text-[10.5px] font-semibold", compact ? "opacity-80" : "text-accent")}>
          {t("Replying to {name}", { name: replyAuthor(message, fallbackName) })}
        </span>
        <span className={cn("block truncate text-[11.5px]", compact ? "opacity-70" : "text-ink-secondary")}>
          {replySnippet(plainText(message.text ?? ""))}
        </span>
      </span>
    </>
  );
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-lg border-l-2 px-2.5 py-1.5",
        compact ? "border-current/40 bg-current/10" : "border-accent/60 bg-inset/70",
      )}
    >
      {onJump ? (
        <button type="button" onClick={onJump} className="flex min-w-0 flex-1 items-center gap-2 text-left" title={t("Jump to original message")}>
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">{body}</div>
      )}
      {onClear && (
        <button type="button" onClick={onClear} aria-label={t("Cancel reply")} className="shrink-0 rounded p-0.5 text-ink-secondary hover:bg-raised hover:text-ink">
          <X size={14} />
        </button>
      )}
    </div>
  );
}
