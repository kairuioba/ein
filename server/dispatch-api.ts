// HTTP surface of the dispatch hub, kept out of index.ts so the harness only
// wires it in. Public routes serve the workbench; the internal routes are what
// a Chief's submit_plan / add_people tools call (index.ts has already checked
// the comms token for every /api/internal/* request before handing one over).
import type { IncomingMessage, ServerResponse } from "node:http";

import { t } from "../shared/i18n.ts";
import type { DispatchDiagnosis, DispatchRun } from "../shared/dispatch-types.ts";
import type { Dispatcher } from "./dispatch.ts";

export interface DispatchApiDeps {
  dispatcher: Dispatcher;
  readBody(req: IncomingMessage): Promise<any>;
  json(res: ServerResponse, status: number, body: unknown): void;
  /** Read-only delegation snapshot the Team map always served. */
  teamMapSnapshot(): unknown;
  /** True when `threadId` is one of `botId`'s conversations. */
  ownsThread(botId: string, threadId: string): boolean;
  botName(botId: string): string | undefined;
  modelLabel(botId: string): string | undefined;
  /** Rescan the engines (signed in? which models and levels?) before a
   * change that recommends or checks one: a plan, a pick, adding people. */
  refreshEngines?(): Promise<void>;
}

const RUN_ACTION = /^\/api\/dispatch\/runs\/([\w-]+)\/(approve|cancel|diagnose|amend)$/;
const RETRY = /^\/api\/dispatch\/runs\/([\w-]+)\/subtasks\/([\w-]+)\/retry$/;
/** PATCH: your pick of model and effort for a subtask that has not started. */
const SUBTASK = /^\/api\/dispatch\/runs\/([\w-]+)\/subtasks\/([\w-]+)$/;

const optionalNumber = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

/** Handle a dispatch route. Returns false when `path` is not one. */
export async function handleDispatchApi(
  method: string,
  path: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  deps: DispatchApiDeps,
  settings: () => unknown,
): Promise<boolean> {
  const { dispatcher, json } = deps;

  if (method === "GET" && path === "/api/dispatch/state") {
    // the workbench polls this: a squad's 30-minute review lands here too
    dispatcher.checkReviews();
    json(res, 200, {
      runs: dispatcher.list(),
      routes: dispatcher.routes(),
      settings: settings(),
      snapshot: deps.teamMapSnapshot(),
    });
    return true;
  }

  if (path === "/api/dispatch/routes") {
    if (method === "PUT") {
      const body = await deps.readBody(req);
      const fromBotId = String(body.fromBotId ?? "");
      const toBotId = String(body.toBotId ?? "");
      if (!fromBotId || !toBotId || typeof body.enabled !== "boolean") {
        json(res, 400, { error: t("fromBotId, toBotId and enabled are required") });
        return true;
      }
      const route = dispatcher.setRoute(fromBotId, toBotId, body.enabled);
      json(res, "error" in route ? 400 : 200, "error" in route ? route : { route });
      return true;
    }
    if (method === "DELETE") {
      const from = url.searchParams.get("from") ?? "";
      const to = url.searchParams.get("to") ?? "";
      if (!from || !to) {
        json(res, 400, { error: t("from and to are required") });
        return true;
      }
      dispatcher.resetRoute(from, to);
      json(res, 200, { ok: true });
      return true;
    }
  }

  const action = method === "POST" ? RUN_ACTION.exec(path) : null;
  if (action) {
    const [, runId, verb] = action;
    if (verb === "diagnose") {
      // body (optional): { add } = "add N people", { total } = "up to N people"
      const body = (await deps.readBody(req)) ?? {};
      const result = dispatcher.diagnose(runId!, { add: optionalNumber(body.add), total: optionalNumber(body.total) });
      json(res, "error" in result ? 404 : 200, result);
      return true;
    }
    if (verb === "amend") {
      // the owner's call from the workbench always goes through; when the
      // company plan's remaining work sits in departments' own plans, the
      // newcomers join those plans instead of being turned away
      const body = (await deps.readBody(req)) ?? {};
      await deps.refreshEngines?.();
      const result = dispatcher.amendFromWorkbench(runId!, Number(body.add));
      json(res, "error" in result ? 400 : 200, result);
      return true;
    }
    const result = verb === "approve" ? dispatcher.approve(runId!) : await dispatcher.cancel(runId!);
    json(res, "error" in result ? 400 : 200, "error" in result ? result : { run: result });
    return true;
  }

  const pick = method === "PATCH" ? SUBTASK.exec(path) : null;
  if (pick) {
    // body: { instanceId?, model?, effort? } — each a string, or null to
    // clear that part of the pick (the bot's own engine and model, or the
    // bot's own / automatic effort)
    const body = (await deps.readBody(req)) ?? {};
    await deps.refreshEngines?.();
    const text = (value: unknown): string | null | undefined =>
      value === null ? null : typeof value === "string" && value.trim() ? value.trim() : undefined;
    const result = dispatcher.chooseModel(pick[1]!, pick[2]!, {
      instanceId: text(body.instanceId),
      model: text(body.model),
      effort: text(body.effort),
    });
    json(res, "error" in result ? 400 : 200, "error" in result ? result : { run: result });
    return true;
  }

  const retry = method === "POST" ? RETRY.exec(path) : null;
  if (retry) {
    const result = dispatcher.retry(retry[1]!, retry[2]!);
    json(res, "error" in result ? 400 : 200, "error" in result ? result : { run: result });
    return true;
  }

  if (method === "POST" && path === "/api/internal/dispatch/plan") {
    const body = await deps.readBody(req);
    const fromBotId = String(body.fromBotId ?? "");
    const fromThreadId = String(body.fromThreadId ?? "");
    if (!deps.botName(fromBotId)) {
      json(res, 403, { error: "unknown sender" });
      return true;
    }
    if (!fromThreadId || !deps.ownsThread(fromBotId, fromThreadId)) {
      json(res, 403, { error: "source conversation does not belong to sender" });
      return true;
    }
    await deps.refreshEngines?.();
    const result = dispatcher.submitPlan(fromBotId, fromThreadId, { goal: body.goal, subtasks: body.subtasks });
    // 200 with an error body: the agent reads the message and fixes its plan
    if ("error" in result) {
      json(res, 200, { error: result.error });
      return true;
    }
    json(res, 200, planReceipt(result.run, new Set(result.created), deps));
    return true;
  }

  // add_people: a chief asks to speed up one of its own runs
  if (method === "POST" && path === "/api/internal/dispatch/amend") {
    const body = await deps.readBody(req);
    const fromBotId = String(body.fromBotId ?? "");
    if (!deps.botName(fromBotId)) {
      json(res, 403, { error: "unknown sender" });
      return true;
    }
    const named = String(body.runId ?? "").trim();
    const run = named
      ? dispatcher.get(named)
      : dispatcher.list().find((entry) => entry.chiefBotId === fromBotId && (entry.status === "running" || entry.status === "awaiting-approval"));
    if (!run || run.chiefBotId !== fromBotId) {
      json(res, 200, { error: named ? `Run ${named} is not one of your dispatch runs.` : "You have no dispatch run in progress." });
      return true;
    }
    const asked = optionalNumber(body.add);
    const diagnosis = dispatcher.diagnose(run.id, asked ? { add: asked } : {});
    if ("error" in diagnosis) {
      json(res, 200, { error: diagnosis.error });
      return true;
    }
    if (diagnosis.verdict !== "add-helps" || !diagnosis.suggestion) {
      json(res, 200, { error: `Adding people would not help: ${diagnosis.reason ?? ""}`.trim(), checks: checkLines(diagnosis) });
      return true;
    }
    await deps.refreshEngines?.();
    const result = dispatcher.amend(run.id, asked ?? diagnosis.suggestion.add, { by: "chief", botId: fromBotId });
    if ("error" in result) {
      json(res, 200, { error: result.error, checks: checkLines(diagnosis) });
      return true;
    }
    json(res, 200, {
      runId: run.id,
      squad: result.squad.name,
      added: result.added.map((id) => ({ name: deps.botName(id) ?? id, model: deps.modelLabel(id) })),
      moved: result.moved.length,
      etaBefore: result.squad.etaBefore,
      etaAfter: result.squad.etaAfter,
      checks: checkLines(diagnosis),
    });
    return true;
  }

  // the org chief's list_bots: who it can plan through
  if (method === "GET" && path === "/api/internal/dispatch/team") {
    const self = url.searchParams.get("self") ?? "";
    if (!deps.botName(self)) {
      json(res, 403, { error: "unknown sender" });
      return true;
    }
    json(res, 200, { orgChief: dispatcher.isOrgChief(self), ...dispatcher.chiefContext(self) });
    return true;
  }

  return false;
}

/** The four answers as plain lines for a planning model. */
function checkLines(diagnosis: DispatchDiagnosis): string[] {
  return diagnosis.checks.map((check) => `${check.ok ? "ok" : "PROBLEM"} ${check.id}: ${check.finding}${check.evidence ? ` (${check.evidence})` : ""}`);
}

/** What submit_plan reports back to the planning model. */
export function planReceipt(run: DispatchRun, created: Set<string>, deps: Pick<DispatchApiDeps, "botName" | "modelLabel">) {
  return {
    runId: run.id,
    status: run.status,
    assignments: run.subtasks.map((subtask) => ({
      id: subtask.id,
      title: subtask.title,
      assignee: deps.botName(subtask.assigneeBotId) ?? subtask.assigneeBotId,
      created: created.has(subtask.assigneeBotId),
      model: deps.modelLabel(subtask.assigneeBotId),
      dependsOn: subtask.dependsOn,
    })),
  };
}
