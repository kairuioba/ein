// 等你拍板：项目里所有需要老板点头的事。通过 → resolveInboxItem(approve)；
// 打回必须写一句原因 → resolveInboxItem(reject, note)。
// attemptId 必须原样透传（服务端用它做“这张卡还是你看到的那次尝试”的校验）。
// 组件不依赖 store：数据 props 进来，处理完通过 onResolved 让页面刷新。
import { useState } from "react";
import { CheckCircle2, Lock } from "lucide-react";

import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { resolveInboxItem } from "@/lib/inbox";
import type { ProjectOffice } from "@/lib/office";

/** 一张决策卡的拍板动作：单独导出便于测试「attemptId 始终透传」。
 * 打回必须带原因（页面上已禁用空原因提交）。 */
export async function resolveDecision(
  decision: ProjectOffice["decisions"][number],
  action: "approve" | "reject",
  note?: string,
): Promise<void> {
  await resolveInboxItem(
    decision.id,
    action,
    action === "reject" ? (note ?? "").trim() : undefined,
    decision.attemptId,
  );
}

export function DecisionQueue({
  decisions,
  onResolved,
}: {
  decisions: ProjectOffice["decisions"];
  onResolved?: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  // 处理成功后先本地藏起来，等服务端下一份快照确认（避免点完还闪一下旧卡）
  const [handled, setHandled] = useState<ReadonlySet<string>>(() => new Set());

  const act = async (decision: ProjectOffice["decisions"][number], action: "approve" | "reject") => {
    setBusy(decision.id);
    setError(null);
    try {
      await resolveDecision(decision, action, note);
      setHandled((current) => new Set(current).add(decision.id));
      setRejecting(null);
      setNote("");
      onResolved?.();
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t("Could not save your decision. Try again."));
    } finally {
      setBusy(null);
    }
  };

  const pending = decisions.filter((decision) => !handled.has(decision.id));
  return (
    <section aria-label={t("Waiting for your decision")} className="rounded-[14px] bg-raised px-3.5 py-3 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent)]">
      <div className="flex items-center gap-1.5 text-[13px] font-semibold">
        <Lock size={14} className="text-warning" />
        {t("Waiting for your decision")}
        <span className="ml-auto text-[11.5px] font-medium text-ink-secondary/70">{pending.length}</span>
      </div>

      {error && (
        <p role="alert" className="mt-2 rounded-lg bg-danger/[0.08] px-2.5 py-1.5 text-[12px] text-danger">
          {error}
        </p>
      )}

      {pending.length === 0 ? (
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-secondary">{t("Nothing is waiting for you in this project.")}</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {pending.map((decision) => (
            <li key={decision.id} className="rounded-xl bg-inset px-3 py-2.5">
              <b className="block text-[13.5px] leading-snug text-ink">{decision.title}</b>
              {decision.reason && (
                <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">{decision.reason}</p>
              )}
              {decision.risk && (
                <span className="mt-1.5 inline-flex h-5 items-center rounded-[6px] bg-warning/15 px-1.5 text-[11px] font-semibold text-warning">
                  {decision.risk}
                </span>
              )}
              {rejecting === decision.id ? (
                <div className="mt-2 flex flex-col gap-2">
                  <textarea
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder={t("What is wrong? One sentence is enough.")}
                    aria-label={t("What is wrong? One sentence is enough.")}
                    maxLength={500}
                    className="min-h-[64px] w-full resize-y rounded-[10px] bg-raised px-2.5 py-2 text-[13px] leading-relaxed text-ink shadow-[inset_0_0_0_1px_var(--color-hairline)] placeholder:text-ink-secondary/70 focus:shadow-[inset_0_0_0_1px_var(--color-select)] focus:outline-none"
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="md"
                      className="max-sm:h-11"
                      disabled={!note.trim() || busy !== null}
                      onClick={() => void act(decision, "reject")}
                    >
                      {t("Not good — fix it")}
                    </Button>
                    <Button
                      size="md"
                      variant="soft"
                      className="max-sm:h-11"
                      disabled={busy !== null}
                      onClick={() => {
                        setRejecting(null);
                        setNote("");
                      }}
                    >
                      {t("Cancel")}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    size="md"
                    className={cn("max-sm:h-11", busy === decision.id && "opacity-70")}
                    disabled={busy !== null}
                    onClick={() => void act(decision, "approve")}
                  >
                    <CheckCircle2 size={13} />
                    {t("Approve, go on")}
                  </Button>
                  <Button
                    size="md"
                    variant="soft"
                    className="max-sm:h-11"
                    disabled={busy !== null}
                    onClick={() => {
                      setRejecting(decision.id);
                      setNote("");
                    }}
                  >
                    {t("Not good — fix it")}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
