// The org editor's sheets: a department (new or edit), a project group and
// the 主 Bot picker. Membership and leads are saved on the bots (section and
// chiefOfStaff through the bot PATCH); everything else goes to the org config.
import { useMemo, useState, type ReactNode } from "react";
import { Check, Lock, Trash2, X } from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { chiefBot } from "@/lib/org";
import { BotAvatar } from "@/components/Avatar";
import { Button, Dialog, Segmented } from "@/components/ui";
import { Switch } from "@/components/SettingsPrimitives";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { DEPARTMENT_COLORS, type OrgConfig, type OrgDepartment, type OrgProject } from "../../../shared/org-types";
import { membershipPatches, newProject, nextDepartmentColor, renameDepartment, upsertDepartment, type DepartmentCard } from "./org-model";
import { FieldLabel, inputClass } from "./parts";
import { useAppCatalog } from "./app-catalog";

type OrgPatch = Partial<Omit<OrgConfig, "version" | "updatedAt">>;
type Apply = (patch: OrgPatch) => Promise<unknown>;

function SheetHeader({ title, sub, onClose }: { title: string; sub?: string; onClose: () => void }) {
  return (
    <div className="flex items-start gap-3 px-5 pt-4 pb-3">
      <div className="min-w-0 flex-1">
        <div className="text-[16px] font-bold text-ink">{title}</div>
        {sub && <div className="mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary">{sub}</div>}
      </div>
      <button type="button" onClick={onClose} aria-label={t("Close")} className="grid size-8 place-items-center rounded-lg text-ink-secondary hover:bg-control hover:text-ink">
        <X size={16} />
      </button>
    </div>
  );
}

function SheetFooter({ children, left }: { children: ReactNode; left?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-t border-hairline/30 px-5 py-3">
      {left}
      <span className="flex-1" />
      {children}
    </div>
  );
}

/** Bots to pick from, as rows with a checkbox; `extra` renders on the right. */
function BotChecklist({
  bots,
  chosen,
  onToggle,
  extra,
  sectionOf,
}: {
  bots: Bot[];
  chosen: ReadonlySet<string>;
  onToggle: (id: string) => void;
  extra?: (bot: Bot) => ReactNode;
  sectionOf?: (bot: Bot) => string | undefined;
}) {
  return (
    <div className="max-h-[220px] overflow-y-auto rounded-xl px-1 py-1 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent)]">
      {bots.length === 0 && <div className="px-2 py-3 text-[12.5px] text-ink-secondary">{t("No bots to choose from yet.")}</div>}
      {bots.map((bot) => {
        const on = chosen.has(bot.id);
        const where = sectionOf?.(bot);
        return (
          <div key={bot.id} className={cn("flex h-9 items-center gap-2 rounded-lg px-2", on && "bg-select/[0.06]")}>
            <button type="button" role="checkbox" aria-checked={on} onClick={() => onToggle(bot.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
              <span className={cn("grid size-4 shrink-0 place-items-center rounded-[5px] text-white", on ? "bg-select" : "bg-raised shadow-[inset_0_0_0_1.5px_color-mix(in_oklab,var(--color-hairline)_85%,transparent)]")}>
                {on && <Check size={11} strokeWidth={3} />}
              </span>
              <BotAvatar bot={bot} size={20} />
              <span className="truncate text-[13px] font-medium text-ink">{bot.name}</span>
              {where && <span className="truncate text-[11.5px] text-ink-secondary">{where}</span>}
            </button>
            {extra?.(bot)}
          </div>
        );
      })}
    </div>
  );
}

export function DepartmentDialog({
  mode,
  section,
  org,
  cards,
  onApply,
  onClose,
}: {
  mode: "new" | "edit";
  section?: string;
  org: OrgConfig;
  cards: DepartmentCard<Bot>[];
  onApply: Apply;
  onClose: () => void;
}) {
  const { state, dispatch } = useStore();
  const card = mode === "edit" ? cards.find((entry) => entry.section === section) : undefined;
  const settings: OrgDepartment | undefined = org.departments.find((dep) => dep.section.trim() === section);
  const chief = chiefBot(state.bots, org);
  const pool = useMemo(
    () => state.bots.filter((bot) => !bot.hidden && bot.id !== chief?.id).sort((a, b) => Number((b.section ?? "") === section) - Number((a.section ?? "") === section)),
    [state.bots, chief?.id, section],
  );
  const { apps } = useAppCatalog();

  const [name, setName] = useState(section ?? "");
  const [color, setColor] = useState(card?.color ?? nextDepartmentColor(org.departments, cards.length));
  const [members, setMembers] = useState<Set<string>>(() => new Set(card ? [card.lead, ...card.members].filter(Boolean).map((bot) => bot!.id) : []));
  const [leadId, setLeadId] = useState<string | undefined>(card?.lead?.id);
  const [headcount, setHeadcount] = useState(settings?.headcount !== undefined ? String(settings.headcount) : "");
  const [budget, setBudget] = useState(settings?.budgetPerDay !== undefined ? String(settings.budgetPerDay) : "");
  const [folder, setFolder] = useState(settings?.privateFolder ?? "");
  const [isolated, setIsolated] = useState(settings?.isolated === true);
  const [allApps, setAllApps] = useState(settings?.allowedApps === undefined);
  const [allowed, setAllowed] = useState<Set<string>>(() => new Set(settings?.allowedApps ?? []));
  const [error, setError] = useState<string | null>(null);

  const toggleMember = (id: string) =>
    setMembers((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
        if (leadId === id) setLeadId(undefined);
      } else next.add(id);
      return next;
    });

  const moveBot = (botId: string, nextSection: string) => {
    const bot = state.bots.find((candidate) => candidate.id === botId);
    // a lead leaving its department gives up the role, so it can never take
    // over the unsectioned chief (the main bot) on the way out
    dispatch({ type: "updateBot", botId, patch: bot?.chiefOfStaff ? { section: nextSection, chiefOfStaff: false } : { section: nextSection } });
  };

  const save = () => {
    const nextName = name.trim();
    if (!nextName) return setError(t("Give the department a name."));
    if (nextName.length > 60) return setError(t("Keep the name under 60 characters."));
    const renamed = mode === "edit" && nextName !== section;
    if ((mode === "new" || renamed) && cards.some((entry) => entry.section === nextName)) return setError(t("There is already a department called “{name}”.", { name: nextName }));
    if (!members.size) return setError(t("Pick at least one bot for this department."));
    const parse = (value: string) => (value.trim() ? Math.max(0, Math.round(Number(value))) : undefined);
    const nextHeadcount = parse(headcount);
    const nextBudget = parse(budget);
    if ((nextHeadcount !== undefined && !Number.isFinite(nextHeadcount)) || (nextBudget !== undefined && !Number.isFinite(nextBudget))) return setError(t("Headcount and budget must be whole numbers."));

    // people: leavers drop out first, then everyone chosen moves in
    if (mode === "edit" && section) {
      for (const bot of state.bots) if ((bot.section?.trim() ?? "") === section && !members.has(bot.id)) moveBot(bot.id, "");
    }
    // (a rename moves everyone chosen too: none of them is in the new name yet)
    for (const patch of membershipPatches(state.bots, nextName, [...members])) if (patch.section !== null) moveBot(patch.botId, patch.section);
    if (leadId && members.has(leadId)) dispatch({ type: "updateBot", botId: leadId, patch: { section: nextName, chiefOfStaff: true } });

    const base = renamed && section ? renameDepartment(org.departments, section, nextName) : org.departments;
    const department: OrgDepartment = {
      section: nextName,
      color,
      ...(nextHeadcount !== undefined ? { headcount: nextHeadcount } : {}),
      ...(nextBudget !== undefined ? { budgetPerDay: nextBudget } : {}),
      ...(isolated ? { isolated: true } : {}),
      ...(allApps ? {} : { allowedApps: [...allowed] }),
      ...(folder.trim() ? { privateFolder: folder.trim() } : {}),
    };
    void onApply({ departments: upsertDepartment(base, department) });
    onClose();
  };

  const dissolve = () => {
    if (!section) return;
    if (!window.confirm(t("Dissolve “{name}”? Its bots stay, outside any department.", { name: section }))) return;
    for (const bot of state.bots) if ((bot.section?.trim() ?? "") === section) moveBot(bot.id, "");
    void onApply({ departments: org.departments.filter((dep) => dep.section.trim() !== section) });
    onClose();
  };

  return (
    <Dialog open onClose={onClose} label={mode === "new" ? t("New department") : t("Edit {name}", { name: section ?? "" })} width={600}>
      <SheetHeader
        title={mode === "new" ? t("New department") : t("Edit {name}", { name: section ?? "" })}
        sub={t("A department is a sidebar section: its bots share a lead, private files and a budget line.")}
        onClose={onClose}
      />
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 pb-4">
        <div className="grid grid-cols-[1fr_auto] gap-4">
          <label className="block">
            <FieldLabel>{t("Name")}</FieldLabel>
            <input autoFocus value={name} maxLength={60} onChange={(event) => setName(event.target.value)} placeholder={t("e.g. Marketing")} className={inputClass} />
          </label>
          <div>
            <FieldLabel>{t("Colour")}</FieldLabel>
            <div className="flex h-[38px] items-center gap-1.5" role="radiogroup" aria-label={t("Colour")}>
              {DEPARTMENT_COLORS.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  role="radio"
                  aria-checked={swatch.toUpperCase() === color.toUpperCase()}
                  aria-label={swatch}
                  onClick={() => setColor(swatch)}
                  className={cn("size-5 rounded-full", swatch.toUpperCase() === color.toUpperCase() && "ring-2 ring-offset-2 ring-offset-raised")}
                  style={{ background: swatch, ["--tw-ring-color" as string]: swatch }}
                />
              ))}
            </div>
          </div>
        </div>

        <div>
          <FieldLabel hint={t("Tick the bots in it; pick one as its lead")}>{t("People")}</FieldLabel>
          <BotChecklist
            bots={pool}
            chosen={members}
            onToggle={toggleMember}
            sectionOf={(bot) => (bot.section && bot.section !== section ? bot.section : undefined)}
            extra={(bot) =>
              members.has(bot.id) ? (
                <button
                  type="button"
                  onClick={() => setLeadId(bot.id)}
                  aria-pressed={leadId === bot.id}
                  className={cn(
                    "h-6 shrink-0 rounded-full px-2.5 text-[11.5px] font-semibold",
                    leadId === bot.id ? "bg-primary text-primary-ink" : "bg-control text-ink-secondary hover:text-ink",
                  )}
                >
                  {leadId === bot.id ? t("Head") : t("Make lead")}
                </button>
              ) : null
            }
          />
        </div>

        <div className="grid grid-cols-3 gap-4">
          <label className="block">
            <FieldLabel>{t("Headcount")}</FieldLabel>
            <input inputMode="numeric" value={headcount} onChange={(event) => setHeadcount(event.target.value.replace(/[^\d]/g, ""))} placeholder={t("No limit")} className={inputClass} />
          </label>
          <label className="block">
            <FieldLabel>{t("Budget line (¥/day)")}</FieldLabel>
            <input inputMode="numeric" value={budget} onChange={(event) => setBudget(event.target.value.replace(/[^\d]/g, ""))} placeholder={t("Not set")} className={inputClass} />
          </label>
          <label className="block">
            <FieldLabel>{t("Private files")}</FieldLabel>
            <input value={folder} maxLength={40} onChange={(event) => setFolder(event.target.value)} placeholder={t("e.g. Research notes")} className={inputClass} />
          </label>
        </div>

        <div className="flex items-center gap-3 rounded-xl px-3 py-2.5 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-hairline)_55%,transparent)]">
          <Lock size={15} className="shrink-0 text-ink-secondary" />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold text-ink">{t("Isolated")}</div>
            <div className="text-[11.5px] text-ink-secondary">{t("Other departments can only ask, and get redacted results. Seeing its data needs you.")}</div>
          </div>
          <Switch checked={isolated} aria-label={t("Isolated")} onClick={() => setIsolated((value) => !value)} />
        </div>

        <div>
          <FieldLabel
            right={
              <Segmented
                size="sm"
                value={allApps ? "all" : "some"}
                onChange={(value) => setAllApps(value === "all")}
                options={[
                  { value: "all", label: t("All connected apps") },
                  { value: "some", label: t("Only these") },
                ]}
                label={t("Allowed apps")}
              />
            }
          >
            {t("Allowed apps")}
          </FieldLabel>
          {!allApps && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {apps.length === 0 && <span className="text-[12px] text-ink-secondary">{t("Loading the app list…")}</span>}
              {apps.slice(0, 24).map((app) => {
                const on = allowed.has(app.slug);
                return (
                  <button
                    key={app.slug}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setAllowed((current) => {
                        const next = new Set(current);
                        if (next.has(app.slug)) next.delete(app.slug);
                        else next.add(app.slug);
                        return next;
                      })
                    }
                    className={cn(
                      "inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] font-medium",
                      on ? "bg-select/12 text-accent-text shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-select)_35%,transparent)]" : "bg-control/70 text-ink-secondary hover:text-ink",
                    )}
                  >
                    {on && <Check size={12} />}
                    {app.label}
                    {app.connected && <span className="size-1.5 rounded-full bg-success" aria-label={t("Connected")} />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {error && <div role="alert" className="text-[12.5px] text-danger">{error}</div>}
      </div>
      <SheetFooter
        left={
          mode === "edit" ? (
            <Button variant="danger" size="sm" onClick={dissolve}>
              <Trash2 size={13} />
              {t("Dissolve department")}
            </Button>
          ) : null
        }
      >
        <Button variant="ghost" onClick={onClose}>
          {t("Cancel")}
        </Button>
        <Button onClick={save}>{mode === "new" ? t("Create department") : t("Save")}</Button>
      </SheetFooter>
    </Dialog>
  );
}

export function ProjectDialog({ org, projectId, onApply, onClose }: { org: OrgConfig; projectId?: string; onApply: Apply; onClose: () => void }) {
  const { state } = useStore();
  const project = org.projects.find((entry) => entry.id === projectId);
  const pool = state.bots.filter((bot) => !bot.hidden);
  const [name, setName] = useState(project?.name ?? "");
  const [leadId, setLeadId] = useState(project?.leadBotId ?? "");
  const [members, setMembers] = useState<Set<string>>(() => new Set(project?.memberBotIds ?? []));
  const [until, setUntil] = useState(project?.until ?? "");
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    if (!name.trim()) return setError(t("Give the project group a name."));
    if (!members.size) return setError(t("Pick at least one member."));
    const next: OrgProject = project
      ? { ...project, name: name.trim(), leadBotId: leadId || undefined, memberBotIds: [...members], until: until || undefined }
      : newProject({ name, leadBotId: leadId || undefined, memberBotIds: [...members], until }, org.projects);
    const projects = project ? org.projects.map((entry) => (entry.id === project.id ? next : entry)) : [...org.projects, next];
    void onApply({ projects });
    onClose();
  };

  const remove = () => {
    if (!project) return;
    void onApply({ projects: org.projects.filter((entry) => entry.id !== project.id) });
    onClose();
  };

  return (
    <Dialog open onClose={onClose} label={project ? t("Edit {name}", { name: project.name }) : t("New project group")} width={560}>
      <SheetHeader
        title={project ? t("Edit {name}", { name: project.name }) : t("New project group")}
        sub={t("A temporary group across departments. Members keep their department and report to the project lead on a dotted line until it dissolves.")}
        onClose={onClose}
      />
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 pb-4">
        <label className="block">
          <FieldLabel>{t("Name")}</FieldLabel>
          <input autoFocus value={name} maxLength={60} onChange={(event) => setName(event.target.value)} placeholder={t("e.g. Landing page sprint")} className={inputClass} />
        </label>
        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <FieldLabel>{t("Project lead")}</FieldLabel>
            <select value={leadId} onChange={(event) => setLeadId(event.target.value)} className={inputClass}>
              <option value="">{t("No lead")}</option>
              {pool.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <FieldLabel>{t("Dissolves on")}</FieldLabel>
            <input type="date" value={until} onChange={(event) => setUntil(event.target.value)} className={inputClass} />
          </label>
        </div>
        <div>
          <FieldLabel>{t("Members")}</FieldLabel>
          <BotChecklist
            bots={pool}
            chosen={members}
            onToggle={(id) =>
              setMembers((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            sectionOf={(bot) => bot.section}
          />
        </div>
        {error && <div role="alert" className="text-[12.5px] text-danger">{error}</div>}
      </div>
      <SheetFooter
        left={
          project ? (
            <Button variant="danger" size="sm" onClick={remove}>
              <Trash2 size={13} />
              {t("Dissolve now")}
            </Button>
          ) : null
        }
      >
        <Button variant="ghost" onClick={onClose}>
          {t("Cancel")}
        </Button>
        <Button onClick={save}>{project ? t("Save") : t("Create project group")}</Button>
      </SheetFooter>
    </Dialog>
  );
}

export function ChiefPickerDialog({ org, onApply, onClose }: { org: OrgConfig; onApply: Apply; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const current = chiefBot(state.bots, org);
  const [chosen, setChosen] = useState(current?.id ?? "");
  const pool = state.bots.filter((bot) => !bot.hidden);
  const save = () => {
    const bot = pool.find((candidate) => candidate.id === chosen);
    if (!bot) return onClose();
    // An unsectioned chief of staff is the main bot even without the org
    // service; a bot inside a department is named through the org config.
    if (!bot.section?.trim() && !bot.chiefOfStaff) dispatch({ type: "updateBot", botId: bot.id, patch: { chiefOfStaff: true } });
    void onApply({ chiefBotId: bot.id });
    onClose();
  };
  return (
    <Dialog open onClose={onClose} label={t("Choose the main bot")} width={460}>
      <SheetHeader title={t("Choose the main bot")} sub={t("The bot you talk to first. It is starred and pinned, splits your requests and hands them to departments.")} onClose={onClose} />
      <div className="max-h-[360px] overflow-y-auto px-4 pb-3" role="radiogroup" aria-label={t("Main bot")}>
        {pool.map((bot) => (
          <button
            key={bot.id}
            type="button"
            role="radio"
            aria-checked={chosen === bot.id}
            onClick={() => setChosen(bot.id)}
            className={cn("flex h-11 w-full items-center gap-2.5 rounded-xl px-2.5 text-left", chosen === bot.id ? "bg-select/[0.08] shadow-[inset_0_0_0_1.5px_var(--color-select)]" : "hover:bg-control/60")}
          >
            <BotAvatar bot={bot} size={26} crown={bot.id === current?.id} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-semibold text-ink">{bot.name}</span>
              <span className="block truncate text-[11.5px] text-ink-secondary">{[bot.title, bot.section].filter(Boolean).join(" · ") || t("No department")}</span>
            </span>
            {chosen === bot.id && <Check size={15} className="text-accent-text" />}
          </button>
        ))}
      </div>
      <SheetFooter>
        <Button variant="ghost" onClick={onClose}>
          {t("Cancel")}
        </Button>
        <Button onClick={save} disabled={!chosen}>
          {t("Make main bot")}
        </Button>
      </SheetFooter>
    </Dialog>
  );
}
