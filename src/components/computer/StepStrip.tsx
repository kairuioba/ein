// 步骤记录 under the live screen (U16): one thumbnail per step of the bot's
// latest work, the live one ringed in cobalt, failures counted in red, and a
// 回放 control that scrubs the main screen through the captured frames.
import { useEffect, useMemo, useState } from "react";
import { FileText, Globe, MousePointer2, Pause, Play, SquareTerminal } from "lucide-react";

import { clockTime } from "@/lib/calendar-view";
import { cn } from "@/lib/cn";
import type { ComputerStep } from "@/lib/computer-steps";
import { stepsSpan } from "@/lib/computer-steps";
import { t, tn } from "@/lib/i18n";

function Placeholder({ label }: { label: string }) {
  const Icon = /command|命令/i.test(label) ? SquareTerminal : /page|web|网页|搜/i.test(label) ? Globe : /click|type|scroll|computer|点|输入|滚动|电脑/i.test(label) ? MousePointer2 : FileText;
  return (
    <span className="grid h-full w-full place-items-center bg-inset text-ink-secondary/60">
      <Icon size={18} />
    </span>
  );
}

export function StepStrip({
  steps,
  replay,
  onReplay,
}: {
  steps: ComputerStep[];
  /** index into `steps` the main screen is showing, null = live */
  replay: number | null;
  onReplay: (index: number | null) => void;
}) {
  const [playing, setPlaying] = useState(false);
  const framed = useMemo(() => steps.map((step, index) => (step.frame ? index : -1)).filter((index) => index >= 0), [steps]);

  // play through the framed steps, one per beat, then stop on the last
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      const position = replay === null ? -1 : framed.indexOf(replay);
      const next = framed[position + 1];
      if (next === undefined) {
        setPlaying(false);
        return;
      }
      onReplay(next);
    }, 1100);
    return () => window.clearInterval(timer);
  }, [playing, replay, framed, onReplay]);

  if (!steps.length) return null;
  const progress = replay === null ? 1 : (framed.indexOf(replay) + 1) / Math.max(1, framed.length);
  const togglePlay = () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (framed.length < 2) return;
    if (replay === null || replay === framed[framed.length - 1]) onReplay(framed[0]!);
    setPlaying(true);
  };

  return (
    <section className="rounded-[14px] bg-raised px-3 pb-2.5 pt-3 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_45%,transparent)]" aria-label={t("Step log")}>
      <div className="mb-2.5 flex h-[26px] items-center gap-2">
        <b className="shrink-0 text-[13.5px]">{t("Step log")}</b>
        <span className="min-w-0 truncate text-[12px] text-ink-secondary">
          {[tn(steps.length, "{count} step", "{count} steps"), t("started {time}", { time: clockTime(steps[0]!.at) }), t("a screenshot at each step")].join(" · ")}
        </span>
        <span className="flex-1" />
        <span className="flex h-[30px] shrink-0 items-center gap-2 rounded-full bg-control/60 pl-1 pr-2.5">
          <button
            type="button"
            onClick={togglePlay}
            disabled={framed.length < 2}
            aria-label={playing ? t("Pause replay") : t("Replay")}
            className="grid size-[22px] place-items-center rounded-full bg-primary text-primary-ink disabled:opacity-40"
          >
            {playing ? <Pause size={11} fill="currentColor" /> : <Play size={11} fill="currentColor" className="ml-px" />}
          </button>
          <b className="text-[12.5px]">{t("Replay")}</b>
          <span className="h-1 w-[72px] overflow-hidden rounded-full bg-hairline/45"><i className="block h-full rounded-full bg-ink-secondary" style={{ width: `${progress * 100}%` }} /></span>
          <span className="font-mono text-[11px] text-ink-secondary">{stepsSpan(steps)}</span>
        </span>
      </div>
      <div className="flex gap-2.5">
        {steps.map((step, index) => {
          const showing = replay === index || (replay === null && step.live);
          return (
            <button
              key={step.id}
              type="button"
              onClick={() => {
                setPlaying(false);
                onReplay(step.live || !step.frame ? null : index);
              }}
              title={step.detail ? `${step.label} · ${step.detail}` : step.label}
              className="group relative min-w-0 flex-1 text-left"
            >
              <span
                className={cn(
                  "relative block h-16 overflow-hidden rounded-[9px] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_45%,transparent)]",
                  showing && "shadow-[0_0_0_2px_var(--color-select),0_0_0_5px_color-mix(in_srgb,var(--color-select)_16%,transparent)]",
                )}
              >
                {step.frame ? (
                  <img src={`data:${step.frame.mime};base64,${step.frame.png}`} alt="" className="h-full w-full object-cover object-top" draggable={false} />
                ) : (
                  <Placeholder label={step.label} />
                )}
                {step.live && (
                  <span className="absolute left-1.5 top-1.5 inline-flex h-4 items-center gap-1 rounded-[5px] bg-select px-1.5 text-[10px] font-bold text-white">
                    <i className="size-[5px] rounded-full bg-white" />{t("Live")}
                  </span>
                )}
              </span>
              <span className={cn("mt-1.5 flex min-w-0 items-center gap-1.5 text-[12px] whitespace-nowrap", showing || step.live ? "font-semibold text-accent-text" : "text-ink-secondary")}>
                <span className={cn("grid size-4 shrink-0 place-items-center rounded-full text-[10px] font-bold", showing || step.live ? "bg-select text-white" : "bg-control text-ink-secondary")}>{index + 1}</span>
                <span className="min-w-0 truncate">{step.label}</span>
                {step.failed > 0 && <span className="shrink-0 text-[11px] font-semibold text-danger">✕{step.failed}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
