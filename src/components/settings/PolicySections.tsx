// Settings › Auto-review, › Reports & cadence and › Usage & billing. Rules
// come from where they live: the org config (saveOrg), the harness's built-in
// backstops (read-only) and each bot's own permissions (the bot PATCH).
import { useState, type ReactNode } from "react";
import { Bot as BotIcon, Building2, Clock, Lock, ShieldCheck, ShieldQuestion, Wallet, X } from "lucide-react";
import { api, useStore, type Bot, type BotAnnouncement } from "@/state/store";
import { useUsageSummary } from "@/state/org-api";
import { BotAvatar } from "@/components/Avatar";
import { Panel, Progress, Segmented } from "@/components/ui";
import { Switch } from "@/components/SettingsPrimitives";
import { LocalComputerAutoWarning } from "@/components/LocalComputerAutoWarning";
import { UsageSection } from "@/components/UsageSection";
import { cn } from "@/lib/cn";
import { formatNumber, msg, t } from "@/lib/i18n";
import { formatTokens } from "@/lib/usage";
import { rulesOf } from "./org-model";
import { reviewRules, type ReviewRule, type RuleSource } from "./review-model";
import { Checkbox, NumberField, SaveStatus, SectionHeader, Stepper } from "./parts";
import { useOrgEditor } from "./OrgSection";

const SOURCE_LABEL: Record<RuleSource, string> = {
  owner: msg("Set by you"),
  builtin: msg("Built in"),
  bot: msg("Bot Settings"),
  org: msg("Org rules"),
};

function SourceChip({ source, locked }: { source: RuleSource; locked: boolean }) {
  return (
    <span className="inline-flex h-[22px] shrink-0 items-center gap-1 rounded-[7px] bg-raised px-2 text-[11.5px] font-medium text-ink-secondary shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent)]">
      {locked && <Lock size={11} />}
      {t(SOURCE_LABEL[source])}
    </span>
  );
}

function RuleLine({ rule, right }: { rule: ReviewRule; right?: ReactNode }) {
  return (
    <div className={cn("flex items-start gap-2.5 py-2.5", "border-t border-hairline/30 first:border-t-0")}>
      <span
        className={cn(
          "grid size-7 shrink-0 place-items-center rounded-lg",
          rule.kind === "ask" ? "bg-warning/12 text-warning" : "bg-success/12 text-success",
        )}
      >
        {rule.locked ? <Lock size={14} /> : rule.kind === "ask" ? <ShieldQuestion size={15} /> : <ShieldCheck size={15} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-semibold text-ink">{t(rule.title)}</div>
        <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{t(rule.detail, rule.params)}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        {right}
        <SourceChip source={rule.source} locked={rule.locked} />
      </div>
    </div>
  );
}

/** One bot's permission row: auto mode, auto-review, ask-before-contacting
 * and the tools it may always use. */
function BotPermissionRow({ bot, onAskLocal }: { bot: Bot; onAskLocal: (bot: Bot) => void }) {
  const { state, dispatch } = useStore();
  const engine = state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
  const canReview = engine?.capabilities?.approvalReview === true;
  const canCoordinate = engine?.capabilities?.agentsMcp === true;
  const [error, setError] = useState<string | null>(null);
  const review = bot.autoReview === "shadow" || bot.autoReview === "enforce" ? bot.autoReview : "off";
  const grants = bot.alwaysAllow ?? [];
  const forget = async (key: string) => {
    setError(null);
    try {
      const result: { bot: BotAnnouncement } = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ alwaysAllow: grants.filter((grant) => grant !== key) }),
      });
      dispatch({ type: "botPatched", bot: result.bot });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <div className="grid grid-cols-[minmax(130px,1.2fr)_64px_minmax(150px,1fr)_76px_minmax(120px,1.2fr)] items-center gap-x-3 border-t border-hairline/30 py-2 text-[13px]">
      <span className="flex min-w-0 items-center gap-2">
        <BotAvatar bot={bot} size={22} />
        <span className="truncate font-medium text-ink">{bot.name}</span>
      </span>
      <span>
        <Switch
          checked={Boolean(bot.autoApprove)}
          aria-label={t("Auto mode for {name}", { name: bot.name })}
          onClick={() => {
            if (!bot.autoApprove && bot.computer === "local") onAskLocal(bot);
            else dispatch({ type: "updateBot", botId: bot.id, patch: { autoApprove: !bot.autoApprove } });
          }}
        />
      </span>
      <span>
        <Segmented
          size="sm"
          value={review}
          label={t("Auto-review for {name}", { name: bot.name })}
          onChange={(value) => dispatch({ type: "updateBot", botId: bot.id, patch: { autoReview: value } as Partial<Bot> })}
          options={[
            { value: "off", label: t("Off") },
            { value: "shadow", label: t("Watch"), disabled: !canReview },
            { value: "enforce", label: t("On"), disabled: !canReview },
          ]}
        />
      </span>
      <span>
        <Switch
          checked={Boolean(bot.approvePeerComms)}
          aria-label={t("Ask before {name} contacts other bots", { name: bot.name })}
          disabled={!bot.approvePeerComms && !canCoordinate}
          onClick={() => dispatch({ type: "updateBot", botId: bot.id, patch: { approvePeerComms: !bot.approvePeerComms } })}
        />
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-1">
        {grants.length === 0 && <span className="text-[12px] text-ink-secondary/70">—</span>}
        {grants.slice(0, 3).map((key) => (
          <span key={key} className="inline-flex h-[22px] max-w-full items-center gap-1 rounded-md bg-control/70 pr-1 pl-1.5 font-mono text-[11px] text-ink-secondary">
            <span className="truncate">{key}</span>
            <button type="button" onClick={() => void forget(key)} aria-label={t("Forget “{key}”", { key })} className="grid size-4 place-items-center rounded hover:bg-raised hover:text-danger">
              <X size={11} />
            </button>
          </span>
        ))}
        {grants.length > 3 && <span className="text-[11.5px] text-ink-secondary">+{grants.length - 3}</span>}
        {error && <span className="w-full text-[11.5px] text-danger">{error}</span>}
      </span>
    </div>
  );
}

export function ReviewSection() {
  const { state, dispatch } = useStore();
  const { org, save, apply } = useOrgEditor();
  const rules = rulesOf(org);
  const all = reviewRules(state.bots, rules);
  const ask = all.filter((rule) => rule.kind === "ask");
  const allow = all.filter((rule) => rule.kind === "allow");
  const team = state.bots.filter((bot) => !bot.hidden);
  const [localWarning, setLocalWarning] = useState<Bot | null>(null);

  return (
    <>
      <SectionHeader
        title={t("Auto-review")}
        description={t("Whether a bot's step runs on its own or waits for you. Ask-first rules always beat approvals.")}
        right={<SaveStatus state={save.state} />}
      />
      <div className="flex flex-col gap-3.5">
        <Panel aria-label={t("Ask first")} className="px-[18px] pt-3 pb-1.5">
          <div className="mb-1 flex h-[30px] items-center gap-2.5">
            <b className="text-[15px] font-bold text-ink">{t("Ask first")}</b>
            <span className="text-[12px] text-ink-secondary">{t("These wait for you, even when auto mode is on")}</span>
          </div>
          {ask.map((rule) => (
            <RuleLine
              key={rule.id}
              rule={rule}
              right={
                rule.id === "external-publish" ? (
                  <span className="inline-flex items-center gap-1 text-[12px] whitespace-nowrap text-ink-secondary">
                    {t("Void after")}
                    <NumberField
                      label={t("Minutes before an unattended approval is voided")}
                      value={rules.unattendedExpiryMin}
                      min={1}
                      max={240}
                      width={40}
                      onCommit={(value) => value !== null && void apply({ rules: { ...rules, unattendedExpiryMin: value } })}
                    />
                    {t("min")}
                  </span>
                ) : rule.id === "over-budget" ? (
                  <button
                    type="button"
                    onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "usage" })}
                    className="text-[12px] font-semibold whitespace-nowrap text-accent-text hover:underline"
                  >
                    {t("Change the line")}
                  </button>
                ) : null
              }
            />
          ))}
        </Panel>

        <Panel aria-label={t("Approved automatically")} className="px-[18px] pt-3 pb-1.5">
          <div className="mb-1 flex h-[30px] items-center gap-2.5">
            <b className="text-[15px] font-bold text-ink">{t("Approved automatically")}</b>
            <span className="text-[12px] text-ink-secondary">{t("Runs without waiting, unless an ask-first rule above matches")}</span>
          </div>
          {allow.length === 0 && <div className="py-3 text-[12.5px] text-ink-secondary">{t("Nothing is approved automatically yet: every action waits for you.")}</div>}
          {allow.map((rule) => (
            <RuleLine key={rule.id} rule={rule} />
          ))}
        </Panel>

        <Panel aria-label={t("Per-bot permissions")} className="px-[18px] pt-3 pb-2">
          <div className="mb-1 flex h-[30px] items-center gap-2.5">
            <b className="text-[15px] font-bold text-ink">{t("Per-bot permissions")}</b>
            <span className="text-[12px] text-ink-secondary">{t("Saved on each bot; the same switches live in its settings panel")}</span>
          </div>
          <div className="grid grid-cols-[minmax(130px,1.2fr)_64px_minmax(150px,1fr)_76px_minmax(120px,1.2fr)] gap-x-3 pb-1.5 text-[11.5px] font-semibold text-ink-secondary/80">
            <span>{t("Bot name")}</span>
            <span>{t("Approve automatically")}</span>
            <span>{t("Second-look review")}</span>
            <span>{t("Ask before contacting bots")}</span>
            <span>{t("Always allowed")}</span>
          </div>
          <div className="max-h-[420px] overflow-y-auto">
            {team.map((bot) => (
              <BotPermissionRow key={bot.id} bot={bot} onAskLocal={setLocalWarning} />
            ))}
          </div>
        </Panel>
      </div>
      <LocalComputerAutoWarning
        open={localWarning !== null}
        onCancel={() => setLocalWarning(null)}
        onConfirm={() => {
          if (localWarning) dispatch({ type: "updateBot", botId: localWarning.id, patch: { autoApprove: true, acknowledgeLocalAuto: true } });
          setLocalWarning(null);
        }}
      />
    </>
  );
}

function CadenceRow({ icon, title, sub, children }: { icon: ReactNode; title: ReactNode; sub: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 border-t border-hairline/30 py-[11px] first:border-t-0">
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-control/70 text-ink-secondary">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex min-h-7 flex-wrap items-center gap-x-1.5 gap-y-1 text-[13.5px] text-ink">{title}</div>
        <div className="mt-0.5 text-[12px] text-ink-secondary">{sub}</div>
      </div>
      {children}
    </div>
  );
}

export function CadenceSection() {
  const { org, save, apply } = useOrgEditor();
  const rules = rulesOf(org);
  const cadence = rules.reportCadence;
  const setCadence = (patch: Partial<typeof cadence>) => void apply({ rules: { ...rules, reportCadence: { ...cadence, ...patch } } });
  const [time, setTime] = useState(cadence.dailyBriefAt);
  return (
    <>
      <SectionHeader
        title={t("Reports & cadence")}
        description={t("When bots report up the chain, and when the Chief rolls it all into one screen for you.")}
        right={<SaveStatus state={save.state} />}
      />
      <div className="flex flex-col gap-3.5">
        <Panel aria-label={t("On a schedule")} className="px-[18px] pt-3 pb-1.5">
          <div className="mb-1 flex h-[30px] items-center gap-2.5">
            <b className="text-[15px] font-bold text-ink">{t("On a schedule")}</b>
          </div>
          <CadenceRow
            icon={<Clock size={15} />}
            title={
              <>
                {t("Leads report every")}
                <Stepper label={t("Hours between reports")} value={cadence.everyHours} min={1} max={24} onChange={(everyHours) => setCadence({ everyHours })} />
                {t("hours")}
              </>
            }
            sub={t("Each lead rolls its people's reports into one department update")}
          />
          <CadenceRow
            icon={<Building2 size={15} />}
            title={
              <>
                {t("Daily brief at")}
                <input
                  type="time"
                  aria-label={t("Daily brief time")}
                  value={time}
                  onChange={(event) => setTime(event.target.value)}
                  onBlur={() => time && time !== cadence.dailyBriefAt && setCadence({ dailyBriefAt: time })}
                  className="mx-0.5 h-7 rounded-lg bg-raised px-2 text-[13.5px] font-bold tabular-nums text-ink shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_75%,transparent)] focus:shadow-[inset_0_0_0_1.5px_var(--color-select)]"
                />
              </>
            }
            sub={t("The Chief turns every department's update into one screen in Brief")}
          />
        </Panel>
        <Panel aria-label={t("When something happens")} className="px-[18px] pt-3 pb-1.5">
          <div className="mb-1 flex h-[30px] items-center gap-2.5">
            <b className="text-[15px] font-bold text-ink">{t("When something happens")}</b>
          </div>
          <CadenceRow
            icon={<ShieldCheck size={15} />}
            title={
              <Checkbox checked={cadence.onDone} onChange={(onDone) => setCadence({ onDone })}>
                {t("Report as soon as a milestone is done")}
              </Checkbox>
            }
            sub={t("A finished job reports right away instead of waiting for the next round")}
          />
          <CadenceRow
            icon={<ShieldQuestion size={15} />}
            title={
              <Checkbox checked={cadence.onIncident} onChange={(onIncident) => setCadence({ onIncident })}>
                {t("Report failures and blocks immediately")}
              </Checkbox>
            }
            sub={t("A failed or stuck job tells its lead at once")}
          />
          <CadenceRow
            icon={<BotIcon size={15} />}
            title={
              <>
                {t("Escalate when stuck for")}
                <NumberField
                  label={t("Minutes before escalating")}
                  value={rules.escalateAfterMin}
                  min={1}
                  max={240}
                  onCommit={(value) => value !== null && void apply({ rules: { ...rules, escalateAfterMin: value } })}
                />
                {t("minutes per level")}
              </>
            }
            sub={t("Staff → lead → Chief → you; each level that can solve it keeps it")}
          />
        </Panel>
      </div>
    </>
  );
}

export function UsageBillingSection() {
  const { state } = useStore();
  const { data: usage, loaded, error } = useUsageSummary();
  const { org, save, apply } = useOrgEditor();
  const rules = rulesOf(org);
  const budget = usage.budgetPerDay || rules.budgetPerDay;
  const spenders = usage.byBot
    .map((entry) => ({ ...entry, bot: state.bots.find((bot) => bot.id === entry.botId) }))
    .filter((entry): entry is typeof entry & { bot: Bot } => Boolean(entry.bot))
    .slice(0, 6);
  const missing = loaded && error !== null;
  return (
    <>
      <SectionHeader
        title={t("Usage & billing")}
        description={t("What each bot has spent, and how far today is from the budget line.")}
        right={<SaveStatus state={save.state} />}
      />
      <div className="flex flex-col gap-3.5">
        <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
          <Panel className="px-4 py-3.5">
            <div className="text-[12px] font-semibold text-ink-secondary">{t("Today")}</div>
            <div className="mt-1 text-[22px] leading-tight font-bold tabular-nums text-ink">
              ¥{formatNumber(usage.todayCost, { maximumFractionDigits: 2 })}
              <span className="ml-1 text-[13px] font-medium text-ink-secondary">/ ¥{formatNumber(budget)}</span>
            </div>
            <Progress className="mt-2" value={usage.todayCost} total={budget} tone={usage.todayCost > budget ? "red" : usage.todayCost > budget * 0.8 ? "amber" : "blue"} />
          </Panel>
          <Panel className="px-4 py-3.5">
            <div className="text-[12px] font-semibold text-ink-secondary">{t("This week")}</div>
            <div className="mt-1 text-[22px] leading-tight font-bold tabular-nums text-ink">{usage.weekPercent === null ? "—" : `${Math.round(usage.weekPercent)}%`}</div>
            <div className="mt-1.5 text-[12px] text-ink-secondary">{t("of the week's budget")}</div>
          </Panel>
          <Panel className="px-4 py-3.5">
            <div className="flex items-center gap-1.5 text-[12px] font-semibold text-ink-secondary">
              <Wallet size={13} />
              {t("Daily budget line")}
            </div>
            <div className="mt-1 flex items-center gap-1 text-[13.5px] text-ink">
              ¥
              <NumberField label={t("Daily budget line")} value={rules.budgetPerDay} min={0} max={100000} width={64} onCommit={(value) => value !== null && void apply({ rules: { ...rules, budgetPerDay: value } })} />
              {t("per day")}
            </div>
            <div className="mt-1.5 text-[12px] text-ink-secondary">{t("Inside it the Chief may act; over it, it asks you")}</div>
          </Panel>
        </div>
        {missing && (
          <div className="rounded-xl bg-inset px-3 py-2 text-[12.5px] text-ink-secondary">
            {t("Today's spending summary isn't available from the server yet; the per-bot totals below are counted on this computer.")}
          </div>
        )}
        {spenders.length > 0 && (
          <Panel aria-label={t("Who spent the most today")} className="px-[18px] pt-3 pb-2">
            <div className="mb-1 flex h-[30px] items-center gap-2.5">
              <b className="text-[15px] font-bold text-ink">{t("Who spent the most today")}</b>
              {usage.unpricedTokens > 0 && (
                <span className="text-[12px] text-ink-secondary">{t("{tokens} tokens from engines without a price count as ¥0", { tokens: formatTokens(usage.unpricedTokens) })}</span>
              )}
            </div>
            {spenders.map((entry) => (
              <div key={entry.botId} className="flex h-9 items-center gap-2.5 border-t border-hairline/30 text-[13px]">
                <BotAvatar bot={entry.bot} size={22} />
                <span className="min-w-0 flex-1 truncate font-medium text-ink">{entry.bot.name}</span>
                <span className="w-24 text-right tabular-nums text-ink-secondary">{formatTokens(entry.tokens)}</span>
                <span className="w-20 text-right font-semibold tabular-nums text-ink">¥{formatNumber(entry.cost, { maximumFractionDigits: 2 })}</span>
              </div>
            ))}
          </Panel>
        )}
        <UsageSection />
      </div>
    </>
  );
}
