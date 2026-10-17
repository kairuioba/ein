import { useState, type FormEvent } from "react";
import { Check, ExternalLink, KeyRound, Loader2, LockKeyhole, RefreshCw } from "lucide-react";

import { credentialConfigPatch, credentialResumeOutcome } from "../../shared/credential-request";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { api, useStore, type ConfigStatus, type Message } from "@/state/store";
import { CardButton, ChatCard, RING, StatusPill } from "./chat/primitives";
import { IconLock } from "./chat/icons";

export function SecretRequestCard({
  botId,
  threadId,
  message,
}: {
  botId: string;
  threadId: string;
  message: Message;
}) {
  const { dispatch } = useStore();
  const secret = message.secret!;
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedLocally, setSavedLocally] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const endpoint = `/api/bots/${encodeURIComponent(botId)}/secret-cards/${encodeURIComponent(message.id)}`;
  const error = localError ?? secret.error;
  const outcome = credentialResumeOutcome(secret);
  const provided = outcome === "provided";
  const declined = outcome === "dismissed";
  const description = provided
    ? secret.resumed
      ? t("Saved securely. Your bot is continuing the task.")
      : t("Saved securely. Your bot will continue when its current turn settles.")
    : declined
      ? t("You chose not to provide this credential. Ein could not resume the bot yet.")
      : secret.description;
  const footerLabel = declined
    ? t("Continuing without this credential failed")
    : secret.resumed
      ? t("Bot resumed without seeing the key")
      : error
        ? t("The key is safe; resuming failed")
        : t("Waiting to resume safely");

  // A successful decline has no durable card to show. If its continuation
  // failed, bring the card back with the same retry affordance as a saved key.
  if (declined && (secret.resumed || !error)) return null;

  const notifyProvided = async () => {
    await api(`${endpoint}/provided`, {
      method: "POST",
      body: JSON.stringify({ threadId }),
    });
  };

  const retryResume = async () => {
    if (saving) return;
    setSaving(true);
    setLocalError(null);
    try {
      await api(`${endpoint}/resume`, {
        method: "POST",
        body: JSON.stringify({ threadId }),
      });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    if (saving || (!value.trim() && !savedLocally)) return;
    setSaving(true);
    setLocalError(null);
    try {
      if (!savedLocally) {
        const next = value.trim();
        const status: ConfigStatus = window.ogb?.setCredential
          ? await window.ogb.setCredential(secret.target, next)
          : await api("/api/config", {
              method: "PUT",
              body: JSON.stringify(credentialConfigPatch(secret.target, next)),
            });
        dispatch({ type: "configStatus", config: status });
        setValue("");
        setSavedLocally(true);
      }
      await notifyProvided();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const dismiss = () => {
    void api(`${endpoint}/dismiss`, {
      method: "POST",
      body: JSON.stringify({ threadId }),
    }).catch(() => {});
  };

  const open = !provided && !declined;
  return (
    <ChatCard
      label={secret.label}
      title={
        <span className="inline-flex items-center gap-1.5">
          <KeyRound size={14} className="shrink-0 text-ink-secondary" />
          {secret.label}
        </span>
      }
      pill={
        provided ? (
          <StatusPill tone="green">{t("Saved")}</StatusPill>
        ) : declined ? (
          <StatusPill tone="red">{t("Not provided")}</StatusPill>
        ) : (
          <StatusPill tone="amber">{t("Waiting for you")}</StatusPill>
        )
      }
      live
      meta={
        <>
          <span>{description}</span>
          {open && (
            <span className="inline-flex items-center gap-1 text-ink-secondary/90">
              <IconLock size={11} /> {t("Stored securely by Ein and never added to chat.")}
            </span>
          )}
        </>
      }
    >
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      {open && (
        <form onSubmit={(event) => void save(event)} className="mt-1 flex flex-col gap-2">
          <input
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={secret.placeholder}
            disabled={saving || savedLocally}
            aria-label={secret.label}
            className={cn(
              "min-w-0 rounded-[10px] bg-raised px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-secondary/60 focus:inset-ring-[1.5px] focus:inset-ring-select disabled:opacity-60",
              RING,
            )}
          />
          <div className="flex flex-wrap items-center gap-2">
            <CardButton type="submit" disabled={saving || (!value.trim() && !savedLocally)}>
              {saving ? <Loader2 size={13} className="animate-spin" /> : <LockKeyhole size={13} />}
              {savedLocally ? t("Continue task") : t("Save securely")}
            </CardButton>
            <CardButton variant="grey" onClick={dismiss}>
              {t("Not now")}
            </CardButton>
            <a
              href={secret.helpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto inline-flex items-center gap-1 text-[12px] font-semibold text-accent-text hover:underline"
            >
              {t("Where to get this key")} <ExternalLink size={11} />
            </a>
          </div>
        </form>
      )}
      {!open && (
        <div className={cn("mt-0.5 flex items-center justify-between gap-2 text-[12px]", declined ? "text-danger" : "text-success")}>
          <span className="flex items-center gap-1.5">
            {secret.resumed ? <Check size={12} /> : error ? <KeyRound size={12} /> : <Loader2 size={12} className="animate-spin" />}
            {footerLabel}
          </span>
          {!secret.resumed && error && (
            <CardButton onClick={() => void retryResume()} disabled={saving}>
              {saving ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} {t("Try again")}
            </CardButton>
          )}
        </div>
      )}
    </ChatCard>
  );
}
