// HTTP surface of the dispatch hub, kept out of index.ts so the harness only
// wires it in. Public routes serve the workbench; the internal route is what
// a Chief's submit_plan tool calls (index.ts has already checked the comms
// token for every /api/internal/* request before handing one over).
import type { IncomingMessage, ServerResponse } from "node:http";

import { t } from "../shared/i18n.ts";
import type { DispatchRun } from "../shared/dispatch-types.ts";
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
}

const RUN_ACTION = /^\/api\/dispatch\/runs\/([\w-]+)\/(approve|cancel)$/;
const RETRY = /^\/api\/dispatch\/runs\/([\w-]+)\/subtasks\/([\w-]+)\/retry$/;

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
    const result = verb === "approve" ? dispatcher.approve(runId!) : await dispatcher.cancel(runId!);
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
    const result = dispatcher.submitPlan(fromBotId, fromThreadId, { goal: body.goal, subtasks: body.subtasks });
    // 200 with an error body: the agent reads the message and fixes its plan
    if ("error" in result) {
      json(res, 200, { error: result.error });
      return true;
    }
    json(res, 200, planReceipt(result.run, new Set(result.created), deps));
    return true;
  }

  return false;
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
