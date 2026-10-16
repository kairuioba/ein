export interface ChiefTeamMember {
  id: string;
  name: string;
  title?: string;
  description?: string;
  busy?: boolean;
  hidden?: boolean;
  section?: string;
}

// The roster is interpolated into a TRUSTED bot's system prompt on every
// turn, and its inputs (name/title/description) are user-editable and — via
// team import — third-party-authored. Caps bound both the token spend and
// how much room an imported persona gets to talk to the Chief with system
// authority. agents-proxy applies the same discipline (120-char list_bots
// descriptions); these are the roster's own limits.
const ROSTER_MAX_BOTS = 40;
const ROSTER_NAME_MAX = 80;
const ROSTER_ROLE_MAX = 120;
const ROSTER_ABOUT_MAX = 200;

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

const sectionKey = (section?: string): string => section?.trim() || "";

/** Dynamic system context for a section's Chief of Staff.
 * It names the current team on every turn, while list_bots remains the
 * authoritative tool for IDs and live availability at delegation time. */
export interface ChiefDispatchOptions {
  /** submit_plan is mounted for this Chief. */
  enabled: boolean;
  /** The dispatcher may create specialists when nobody fits. */
  autoCreate: boolean;
  maxSubtasks: number;
}

export function chiefOfStaffSystemPrompt(
  chiefId: string,
  bots: ChiefTeamMember[],
  canDelegate: boolean,
  trustedOpenMausStatus = "",
  dispatch?: ChiefDispatchOptions,
  languageInstruction = "",
): string {
  const chief = bots.find((bot) => bot.id === chiefId);
  const chiefSection = sectionKey(chief?.section);
  const sectionName = chiefSection || "General";
  const team = bots.filter(
    (bot) => bot.id !== chiefId && !bot.hidden && sectionKey(bot.section) === chiefSection,
  );
  const listed = team.slice(0, ROSTER_MAX_BOTS);
  const overflow = team.length - listed.length;
  const roster = team.length
    ? listed
        .map((bot) => {
          const name = clip(bot.name, ROSTER_NAME_MAX);
          const role = clip(bot.title?.trim() || "General assistant", ROSTER_ROLE_MAX);
          const about = bot.description?.trim();
          const availability = bot.busy ? "working right now" : "available";
          return `- ${name} — ${role}${about ? `: ${clip(about, ROSTER_ABOUT_MAX)}` : ""} (${availability})`;
        })
        .join("\n") + (overflow > 0 ? `\n- …and ${overflow} more (use list_bots for the full roster).` : "")
    : "- No other visible bots are available yet.";

  const delegation = canDelegate
    ? [
        "Use list_bots to confirm the live roster and IDs. When assigning work to a teammate, use delegate_bot: it returns immediately, keeps you available to the user, and delivers the teammate's completed result back into this conversation automatically.",
        "After delegate_bot accepts the task, acknowledge the handoff and continue with any independent work or end your turn. Do not call wait_delegation or repeatedly poll check_delegation in the same turn.",
        "Use ask_bot only for a brief consultation whose answer you must have before writing your current response. Never use ask_bot for an assigned task, background work, or anything potentially long-running.",
        "When the user asks you to assemble a team, use create_bot for each genuinely useful specialist. Give each one a clear role and instructions, then use delegate_bot to assign its work. Do not create duplicate or unnecessary bots.",
        "Delegate with a clear, self-contained brief. Say that the task is assigned, not completed; only claim completion after the teammate's result has actually arrived.",
        "You may assign work to more than one teammate when the request genuinely benefits. Stay responsive while they work, then combine their returned results when the user asks for a synthesis.",
      ].join(" ")
    : "Your current engine cannot contact teammates. Be honest about that limitation and ask the user to choose a delegation-compatible engine before promising coordinated work.";

  const planning = canDelegate && dispatch?.enabled
    ? [
        "AUTOMATIC DISPATCH: whenever a request contains two or more distinct pieces of work, or would benefit from different specialists, do not do it all yourself and do not send several delegate_bot calls — call submit_plan ONCE with the whole plan.",
        "Break the goal into concrete subtasks with a self-contained brief each (the specialist cannot see this conversation), the role it needs, its needs and difficulty (these pick the model), and depends_on for any subtask that needs another's result.",
        dispatch.autoCreate
          ? "OpenMausBot assigns each subtask to the best-fitting teammate and creates a specialist with a recommended model when nobody fits, so describe roles precisely instead of creating bots yourself."
          : "Creating specialists is turned off: name an assignee from list_bots for any subtask your current team cannot obviously cover.",
        `Keep a plan to at most ${dispatch.maxSubtasks} subtasks. Handle a small, single-step request yourself without a plan.`,
        "After submit_plan succeeds, summarize the plan for the user in a few lines and end your turn. The subtasks run in the background; when they finish you will receive their results and must reply with one consolidated deliverable.",
      ].join(" ")
    : "";

  return [
    `You are the Chief of Staff for the ${sectionName} section. You are the user's primary contact for this section's team of bots.`,
    "Own the outcome: understand the request, decide what to handle yourself, coordinate the right specialists when useful, and return one concise consolidated answer.",
    "Do not delegate trivial work merely to appear busy. Never invent a teammate's progress or result. Normal permission and approval rules still apply.",
    delegation,
    planning,
    `Current ${sectionName} section team:`,
    roster,
    trustedOpenMausStatus,
    languageInstruction,
  ].filter(Boolean).join("\n");
}
