// The approval card (design U8): what the bot wants to do, shown the way a
// person judges it — a social post with its account and text, an email as a
// draft (recipients, subject, body), a command in monospace — the rule that
// sent it here, and the answers. This card is the primary place to answer;
// the composer only falls back to a compact strip while it is out of view.
//
// Deliberately not the lettered A/B/C list the onboarding card uses — an
// approval is a decision about one concrete action, and the buttons carry
// their own behavior instead of being matched by their label text.
import { useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { type AppState, type Bot, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { SkillRequestPreview } from "@/components/SkillRequestPreview";
import { msg, t } from "@/lib/i18n";
import { reviewedSkillSha256 } from "../../shared/skill-request";
import { approvalDecision, type Pending } from "./PendingApproval";
import { approvalPreview, previewTitle, type ApprovalPreview } from "./chat/approval-preview";
import { CardButton, CardInset, ChatCard, MetaDot, StatusPill } from "./chat/primitives";
import { IconClock, IconLock } from "./chat/icons";
import { useOptionalStore } from "./chat/use-optional-store";

interface ToolLabels {
  [tool: string]: string;
}

const ROUTINE_SETTLED_LABEL = {
  create: msg("Routine scheduled"),
  update: msg("Routine updated"),
  pause: msg("Routine paused"),
  resume: msg("Routine resumed"),
  run_now: msg("Routine run queued"),
  delete: msg("Routine deleted"),
} as const;

const SKILL_SETTLED_LABEL = {
  create: msg("Skill enabled"),
} as const;

/** The tool's own name is noise to a human: mcp__ogb__computer_batch is
 * "computer batch", Bash is "run a command". */
function toolLabel(tool?: string): string {
  if (!tool) return t("an action");
  const bare = tool.replace(/^mcp__[^_]+__/, "").replace(/_/g, " ");
  const nice: ToolLabels = {
    Bash: t("run a command"),
    Read: t("read a file"),
    Write: t("write a file"),
    Edit: t("edit a file"),
    WebFetch: t("fetch a web page"),
    WebSearch: t("search the web"),
    schedule_routine: t("schedule a routine"),
    manage_routine: t("change a routine"),
    stage_skill: t("enable a learned skill"),
  };
  return nice[tool] ?? bare;
}

/** The lock line — why this reached a person: the company layer's rule when
 * the server stamped one (already localized, e.g. 对外发布一律要你批), else
 * why auto mode stopped to ask, else the standing rule for this kind of ask. */
function ruleFor(card: NonNullable<Message["card"]>, asker?: Pick<Bot, "name" | "autoApprove">): string | undefined {
  if (card.rule?.trim()) return t("Rule: {rule}", { rule: card.rule.trim() });
  if (card.held) return card.held;
  if (card.approvalScope === "local-computer") return t("Rule: {rule}", { rule: t("Using this computer needs your OK") });
  if (asker && !asker.autoApprove) {
    return t("Rule: {rule}", { rule: t("{name} asks before actions that need permission", { name: asker.name }) });
  }
  return undefined;
}

/** Where an approval is answered: the thread that holds the card. */
function threadOf(state: AppState, messageId: string): string | undefined {
  for (const group of state.groups) if (group.messages.some((m) => m.id === messageId)) return group.threadId;
  for (const bot of state.bots) if (bot.messages.some((m) => m.id === messageId)) return bot.threadId;
  return undefined;
}

export function ApprovalCard({
  bot,
  message,
  threadId,
}: {
  /** who is asking — "always allow" is remembered against this bot */
  bot?: Bot;
  message: Message;
  /** the conversation that holds the card; looked up when omitted */
  threadId?: string;
}) {
  const store = useOptionalStore();
  const [deciding, setDeciding] = useState<"allow" | "always" | "deny" | null>(null);
  const card = message.card;
  if (!card) return null;
  const settled = card.answered;
  // the company layer voids an approval nobody answered in time while the
  // owner was away: it was denied for them and did not run
  const expired = settled === "expired";
  const open = !settled && !card.dismissed;
  const isRoutineRequest = Boolean(card.routineRequest);
  const isSkillRequest = Boolean(card.skillRequest);
  const routineAction = card.routineRequest?.operation.action;
  const skillAction = card.skillRequest?.action;
  const displayTool = isRoutineRequest
    ? routineAction === "create" ? "schedule_routine" : "manage_routine"
    : isSkillRequest
      ? "stage_skill"
      : card.tool;
  const preview = isRoutineRequest || isSkillRequest ? null : approvalPreview(card.tool, card.subtitle, card.approvalScope);
  const askerName = message.from?.name ?? bot?.name;
  const draft = preview?.kind === "email";

  const title =
    (preview && previewTitle(preview)) ??
    (askerName
      ? t("{name} wants to {action}", { name: askerName, action: toolLabel(displayTool) })
      : t("Wants to {action}", { action: toolLabel(displayTool) }));

  const settledLabel = expired
    ? t("Voided")
    : // the ask closed (its turn stopped) before any answer reached it
      settled === "unavailable"
      ? t("Closed")
      : settled === "allow"
      ? (skillAction ? t(SKILL_SETTLED_LABEL[skillAction]) : undefined) ??
        (routineAction ? t(ROUTINE_SETTLED_LABEL[routineAction]) : undefined) ??
        (isRoutineRequest ? t("Routine confirmed") : isSkillRequest ? t("Skill confirmed") : draft ? t("Approved to send") : t("Allowed"))
      : isRoutineRequest || isSkillRequest
        ? t("Cancelled")
        : draft
          ? t("Discarded")
          : t("Denied");
  const pill = settled ? (
    <StatusPill tone={settled === "allow" ? "green" : "grey"}>{settledLabel}</StatusPill>
  ) : card.dismissed ? (
    <StatusPill tone="grey">{t("Closed")}</StatusPill>
  ) : draft ? (
    <StatusPill tone="grey">{t("Draft")}</StatusPill>
  ) : (
    <StatusPill tone="amber">{isRoutineRequest || isSkillRequest ? t("Needs your OK") : t("Needs your approval")}</StatusPill>
  );

  // a draft says who drafted it; the generic "asks first" rule would only
  // repeat what the Draft pill already means (the design shows none there)
  const rule = isRoutineRequest || isSkillRequest ? undefined : ruleFor(card, draft ? undefined : bot);
  const meta: ReactNode[] = [];
  if (draft && askerName) meta.push(<span key="by">{t("Drafted by {name}", { name: askerName })}</span>);
  else if (preview && previewTitle(preview) && askerName) meta.push(<span key="by">{t("{name} asks", { name: askerName })}</span>);
  if (displayTool && !preview?.platform) {
    meta.push(
      <span key="tool" className="font-mono text-[11px]">
        {displayTool}
      </span>,
    );
  }
  if (expired) {
    // what happened outranks why it was asked
    meta.push(
      <span key="expired" className="inline-flex items-center gap-1">
        <IconClock size={12} />
        {t("Nobody approved it in time while unattended — it did not run")}
      </span>,
    );
  } else if (rule) {
    meta.push(
      <span key="rule" className="inline-flex items-center gap-1">
        <IconLock size={12} />
        {rule}
      </span>,
    );
  }

  // answering needs the store and the thread; a card rendered on its own
  // (static markup) just shows what was asked
  const answeringThread = threadId ?? (store ? threadOf(store.state, message.id) : undefined);
  const canAnswer = open && Boolean(store && answeringThread && card.requestId);
  const pending: Pick<Pending, "requestId" | "allowKey" | "message"> = {
    requestId: card.requestId ?? "",
    allowKey: card.allowKey,
    message,
  };
  const reviewedSha256 = card.skillRequest ? reviewedSkillSha256(card.skillRequest) : undefined;
  const decide = (behavior: "allow" | "deny", always = false) => {
    if (!store || !answeringThread || deciding) return;
    setDeciding(behavior === "deny" ? "deny" : always ? "always" : "allow");
    store.dispatch(
      approvalDecision(pending, answeringThread, behavior, {
        always,
        bot,
        onError: () => setDeciding(null),
      }),
    );
  };
  const spinner = (which: typeof deciding) => (deciding === which ? <Loader2 size={13} className="animate-spin" /> : null);

  const actions = open ? (
    isSkillRequest ? (
      <>
        <CardButton onClick={() => decide("allow")} disabled={!canAnswer || !reviewedSha256 || Boolean(deciding)}>
          {spinner("allow")}
          {t("Enable")}
        </CardButton>
        <CardButton variant="grey" onClick={() => decide("deny")} disabled={!canAnswer || Boolean(deciding)}>
          {spinner("deny")}
          {t("Deny")}
        </CardButton>
      </>
    ) : isRoutineRequest ? (
      <>
        <CardButton onClick={() => decide("allow")} disabled={!canAnswer || Boolean(deciding)}>
          {spinner("allow")}
          {t("Confirm")}
        </CardButton>
        <CardButton variant="grey" onClick={() => decide("deny")} disabled={!canAnswer || Boolean(deciding)}>
          {spinner("deny")}
          {t("Cancel")}
        </CardButton>
      </>
    ) : draft ? (
      <>
        <CardButton onClick={() => decide("allow")} disabled={!canAnswer || Boolean(deciding)}>
          {spinner("allow")}
          {t("Send")}
        </CardButton>
        <CardButton variant="grey" onClick={() => decide("deny")} disabled={!canAnswer || Boolean(deciding)}>
          {spinner("deny")}
          {t("Discard")}
        </CardButton>
      </>
    ) : (
      <>
        <CardButton onClick={() => decide("allow")} disabled={!canAnswer || Boolean(deciding)}>
          {spinner("allow")}
          {t("Allow once")}
        </CardButton>
        {bot && card.allowKey && (
          <CardButton
            variant="grey"
            onClick={() => decide("allow", true)}
            disabled={!canAnswer || Boolean(deciding)}
            title={t("Stop asking {name} about {key}", { name: bot.name, key: card.allowKey })}
          >
            {spinner("always")}
            {t("Always allow")}
          </CardButton>
        )}
        <CardButton variant="grey" onClick={() => decide("deny")} disabled={!canAnswer || Boolean(deciding)}>
          {spinner("deny")}
          {t("Deny")}
        </CardButton>
      </>
    )
  ) : null;

  return (
    <ChatCard
      label={title}
      title={title}
      pill={pill}
      live
      meta={meta.length ? meta.flatMap((part, index) => (index ? [<MetaDot key={`dot-${index}`} />, part] : [part])) : undefined}
      actions={actions}
      className={cn(!open && "opacity-90")}
    >
      {preview ? (
        <PreviewBlock preview={preview} raw={card.subtitle} />
      ) : (
        <CardInset className="p-0">
          <pre
            tabIndex={0}
            aria-label={isRoutineRequest ? t("Routine details") : isSkillRequest ? t("Skill details") : t("Approval details")}
            className="max-h-40 overflow-auto px-3 py-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words text-ink"
          >
            {card.subtitle}
          </pre>
        </CardInset>
      )}
      {card.skillRequest && <SkillRequestPreview request={card.skillRequest} />}
    </ChatCard>
  );
}

function PreviewBlock({ preview, raw }: { preview: ApprovalPreview; raw: string }) {
  if (preview.kind === "social") {
    return (
      <CardInset>
        <div className="mb-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[12px] text-ink-secondary">
          {preview.platform && <PlatformTag name={preview.platform} />}
          {preview.account && <b className="text-[12.5px] font-semibold text-ink">{preview.account}</b>}
          {preview.schedule && <span>· {t("Scheduled {time}", { time: preview.schedule })}</span>}
        </div>
        {preview.body && <p className="line-clamp-5 whitespace-pre-wrap break-words">{preview.body}</p>}
        {!!preview.tags?.length && (
          <div className="mt-1 flex flex-wrap gap-2 text-[12px] text-accent-text">
            {preview.tags.map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </div>
        )}
        {!preview.body && <RawDetail raw={raw} />}
      </CardInset>
    );
  }
  if (preview.kind === "email") {
    return (
      <CardInset>
        {preview.recipients && <MailRow label={t("To")} value={preview.recipients} />}
        {preview.subject && <MailRow label={t("Subject")} value={preview.subject} />}
        {preview.body ? (
          <p className="mt-1.5 line-clamp-4 whitespace-pre-wrap break-words text-ink-secondary">{preview.body}</p>
        ) : (
          !preview.recipients && !preview.subject && <RawDetail raw={raw} />
        )}
      </CardInset>
    );
  }
  if (preview.kind === "message") {
    return (
      <CardInset>
        <div className="mb-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[12px] text-ink-secondary">
          {preview.platform && <PlatformTag name={preview.platform} />}
          {preview.channel && <b className="text-[12.5px] font-semibold text-ink">{preview.channel}</b>}
        </div>
        {preview.body ? <p className="line-clamp-4 whitespace-pre-wrap break-words">{preview.body}</p> : <RawDetail raw={raw} />}
      </CardInset>
    );
  }
  return (
    <CardInset className="p-0">
      <pre
        tabIndex={0}
        aria-label={t("Approval details")}
        className="max-h-40 overflow-auto px-3 py-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words text-ink"
      >
        {preview.target ?? raw}
      </pre>
    </CardInset>
  );
}

function MailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2.5 border-b border-hairline/25 py-[3px] last:border-b-0">
      <span className="w-11 shrink-0 text-ink-secondary">{label}</span>
      <b className="min-w-0 flex-1 truncate font-semibold">{value}</b>
    </div>
  );
}

function PlatformTag({ name }: { name: string }) {
  const red = name === t("Xiaohongshu") || name === t("Douyin") || name === t("Weibo");
  return (
    <span
      className={cn(
        "inline-flex h-[18px] items-center rounded-[5px] px-1.5 text-[11px] font-bold",
        red ? "bg-danger/10 text-danger" : "bg-control text-ink-secondary",
      )}
    >
      {name}
    </span>
  );
}

function RawDetail({ raw }: { raw: string }) {
  return <pre className="max-h-32 overflow-auto font-mono text-[11.5px] whitespace-pre-wrap break-words text-ink-secondary">{raw}</pre>;
}
