import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, PlugZap, RefreshCw } from "lucide-react";

import { api, type Message } from "@/state/store";
import { t } from "@/lib/i18n";
import { CardButton, ChatCard, StatusPill } from "./chat/primitives";

async function openConnectionPage(url: string) {
  if (window.ogb?.openExternal) {
    await window.ogb.openExternal(url);
    return;
  }
  const opened = window.open("", "_blank");
  if (!opened) throw new Error(t("Your browser blocked the connection page. Allow pop-ups, then try again."));
  opened.opener = null;
  opened.location.replace(url);
}

export function ConnectorCard({ botId, threadId, message }: { botId: string; threadId: string; message: Message }) {
  const connector = message.connector!;
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const polling = useRef(false);

  const endpoint = `/api/bots/${encodeURIComponent(botId)}/connector-cards/${encodeURIComponent(message.id)}`;
  const checkStatus = useCallback(async () => {
    const result = await api(`${endpoint}/status?threadId=${encodeURIComponent(threadId)}`);
    return Boolean(result.connected);
  }, [endpoint, threadId]);

  useEffect(() => {
    if (connector.status !== "authorizing" || connector.dismissed) return;
    polling.current = true;
    let tries = 0;
    const timer = setInterval(() => {
      if (!polling.current) return;
      void checkStatus()
        .then((connected) => {
          tries += 1;
          if (connected || tries >= 75) {
            polling.current = false;
            clearInterval(timer);
          }
        })
        .catch(() => {
          tries += 1;
          if (tries >= 75) clearInterval(timer);
        });
    }, 4_000);
    return () => {
      polling.current = false;
      clearInterval(timer);
    };
  }, [checkStatus, connector.dismissed, connector.status]);

  if (connector.dismissed) return null;

  const connect = async () => {
    setBusy(true);
    setLocalError(null);
    try {
      const result = await api(`${endpoint}/authorize`, {
        method: "POST",
        body: JSON.stringify({ threadId }),
      });
      await openConnectionPage(String(result.url));
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const resume = async () => {
    setBusy(true);
    setLocalError(null);
    try {
      await api(`${endpoint}/resume`, { method: "POST", body: JSON.stringify({ threadId }) });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const dismiss = () => {
    void api(`${endpoint}/dismiss`, { method: "POST", body: JSON.stringify({ threadId }) }).catch(() => {});
  };

  const connected = connector.status === "connected";
  const authorizing = connector.status === "authorizing";
  const error = localError ?? connector.error;

  return (
    <ChatCard
      label={connector.label}
      title={
        <span className="inline-flex items-center gap-1.5">
          <span className="grid size-[18px] shrink-0 place-items-center rounded-[5px] bg-raised text-[11px] font-bold text-ink">
            {connector.label.slice(0, 1).toUpperCase() || <PlugZap size={12} />}
          </span>
          {connector.label}
        </span>
      }
      pill={
        connected ? (
          <StatusPill tone="green">{t("Connected")}</StatusPill>
        ) : authorizing ? (
          <StatusPill tone="blue">{t("Waiting for sign-in…")}</StatusPill>
        ) : connector.status === "failed" ? (
          <StatusPill tone="red">{t("Failed")}</StatusPill>
        ) : (
          <StatusPill tone="amber">{t("Needs connecting")}</StatusPill>
        )
      }
      live
      meta={
        <>
          <span>
            {connected
              ? connector.resumed
                ? t("Connected securely. Your bot is continuing the task.")
                : t("Connected securely. Continue the paused task when you're ready.")
              : connector.description}
          </span>
          {!connected && (
            <span className="text-ink-secondary/90">
              {t("Sign in or enter the app key on the secure connection page — never in chat.")}
            </span>
          )}
        </>
      }
      actions={
        !connected ? (
          <>
            <CardButton onClick={() => void connect()} disabled={busy}>
              {busy || authorizing ? <Loader2 size={13} className="animate-spin" /> : <PlugZap size={13} />}
              {authorizing ? t("Open again") : connector.status === "failed" ? t("Try again") : t("Connect securely")}
            </CardButton>
            <CardButton variant="grey" onClick={dismiss}>
              {t("Not now")}
            </CardButton>
          </>
        ) : !connector.resumed ? (
          <CardButton onClick={() => void resume()} disabled={busy}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} {t("Continue task")}
          </CardButton>
        ) : (
          <span className="flex items-center gap-1 text-[12px] font-semibold text-success">
            <Check size={13} /> {t("Continuing")}
          </span>
        )
      }
    >
      {error && <p className="text-[12px] text-danger">{error}</p>}
    </ChatCard>
  );
}
