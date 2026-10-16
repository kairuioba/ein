// Settings → Connections → WorkBuddy. Bots run on Tencent WorkBuddy through
// its CodeBuddy Code CLI; this card holds the optional API key and the
// edition (international, mainland China, Tencent iOA). Like every other key
// in Settings the value is write-only: the harness reports configured-or-not.
import { useEffect, useState } from "react";
import { Check, ExternalLink, Loader2 } from "lucide-react";

import { api, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { Card, CommandLine } from "./SettingsPrimitives";

type Edition = "international" | "internal" | "ioa";
type WorkBuddyStatus = { configured: boolean; environment?: Edition };
type StatusWithWorkBuddy = ConfigStatus & { workbuddy?: WorkBuddyStatus };

const INSTALL_COMMAND = "npm install -g @tencent-ai/codebuddy-code";

// Where each edition issues API keys (www.workbuddy.ai/docs/cli/iam).
const KEY_PAGES: Record<Edition, string> = {
  international: "https://www.codebuddy.ai/profile/keys",
  internal: "https://copilot.tencent.com/profile/",
  ioa: "https://tencent.sso.copilot.tencent.com/profile/keys",
};

function editionLabel(edition: Edition): string {
  if (edition === "internal") return t("China (mainland)");
  if (edition === "ioa") return t("Tencent iOA");
  return t("International");
}

export function WorkBuddySettings() {
  const { dispatch } = useStore();
  const [status, setStatus] = useState<WorkBuddyStatus>({ configured: false, environment: "international" });
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState<"key" | "edition" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = (next: StatusWithWorkBuddy) => {
    dispatch({ type: "configStatus", config: next });
    if (next.workbuddy) setStatus(next.workbuddy);
  };

  useEffect(() => {
    let alive = true;
    api("/api/config")
      .then((next: StatusWithWorkBuddy) => alive && next.workbuddy && setStatus(next.workbuddy))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const clearing = !key.trim() && status.configured;

  const saveKey = () => {
    if (saving || (!key.trim() && !status.configured)) return;
    setSaving("key");
    setError(null);
    const value = key.trim();
    const request: Promise<StatusWithWorkBuddy> = window.ogb?.setCredential
      ? window.ogb.setCredential("workbuddyApiKey", value)
      : api("/api/config", { method: "PUT", body: JSON.stringify({ workbuddy: { apiKey: value } }) });
    request
      .then((next) => {
        apply(next);
        setKey("");
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setSaving(null));
  };

  const saveEdition = (environment: Edition) => {
    if (saving || environment === (status.environment ?? "international")) return;
    setSaving("edition");
    setError(null);
    api("/api/config", { method: "PATCH", body: JSON.stringify({ workbuddy: { environment } }) })
      .then(apply)
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setSaving(null));
  };

  const edition = status.environment ?? "international";

  return (
    <Card
      title="WorkBuddy"
      subtitle={t("Run bots on Tencent WorkBuddy. Bots use its CodeBuddy Code engine; pick “WorkBuddy” as a bot's engine, or let automatic dispatch recommend it.")}
    >
      <div className="space-y-4">
        <div>
          <div className="mb-1.5 text-[13px] text-ink">{t("1. Install the engine")}</div>
          <CommandLine command={INSTALL_COMMAND} />
          <div className="mt-1.5 text-[12px] leading-relaxed text-ink-secondary">
            {t("Or with Homebrew: brew install Tencent-CodeBuddy/tap/codebuddy-code. Then run “codebuddy” once in Terminal and sign in with your WorkBuddy account — or paste an API key below instead.")}
          </div>
        </div>

        <div>
          <div className="mb-2 text-[13px] text-ink">{t("2. Edition")}</div>
          <div className="inline-flex rounded-xl bg-inset p-1" role="radiogroup" aria-label={t("Edition")}>
            {(["international", "internal", "ioa"] as const).map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={edition === option}
                disabled={saving !== null}
                onClick={() => saveEdition(option)}
                className={cn(
                  "flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[12.5px] transition-colors disabled:opacity-60",
                  edition === option ? "bg-raised text-ink shadow" : "text-ink-secondary hover:text-ink",
                )}
              >
                {saving === "edition" && edition !== option && <span className="sr-only">{t("Saving…")}</span>}
                {editionLabel(option)}
              </button>
            ))}
          </div>
          <div className="mt-1.5 text-[12px] leading-relaxed text-ink-secondary">
            {t("Use the edition your account was created in. Accounts registered in mainland China use the China edition.")}
          </div>
        </div>

        <div>
          <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
            <span className={cn("size-1.5 rounded-full", status.configured ? "bg-success" : "bg-raised-hover")} />
            <span className="text-ink">{t("3. API key")}</span>
            <span className="rounded bg-control px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-secondary">
              {t("Optional")}
            </span>
            {status.configured && <span className="text-[11px] text-success">{t("Connected")}</span>}
            <a
              href={KEY_PAGES[edition]}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto flex items-center gap-1 text-[12px] text-accent hover:underline"
            >
              {t("How to get a key")}
              <ExternalLink size={11} aria-hidden="true" />
            </a>
          </div>
          <div className="flex gap-2">
            <input
              type="password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && saveKey()}
              placeholder={status.configured ? t("••••••••  (paste to replace)") : t("Paste a CodeBuddy API key")}
              aria-label={t("WorkBuddy API key")}
              autoComplete="off"
              className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
            />
            <button
              type="button"
              onClick={saveKey}
              disabled={saving !== null || (!key.trim() && !status.configured)}
              title={clearing ? t("Remove the saved key") : t("Save")}
              className={cn(
                "flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-control py-2 text-[13px] hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50",
                clearing ? "text-danger" : "text-ink",
              )}
            >
              {saving === "key" ? (
                <Loader2 size={13} className="animate-spin" />
              ) : clearing ? (
                t("Clear")
              ) : (
                <>
                  <Check size={13} />
                  {t("Save")}
                </>
              )}
            </button>
          </div>
          <div className="mt-1.5 text-[12px] leading-relaxed text-ink-secondary">
            {t("Without a key the engine uses the account you signed in with in Terminal. A key is billed to its own account.")}
          </div>
        </div>
      </div>
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    </Card>
  );
}
