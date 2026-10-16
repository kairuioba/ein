// HTTP routes for the company layer: /api/org, /api/org/events,
// /api/org/decisions, /api/brief, /api/usage/summary and /api/library.
// Contracts live in shared/org-types.ts; the app reads them through
// src/state/org-api.ts. Returns true when it answered the request.
//
//   GET   /api/org                        → OrgConfig
//   PATCH /api/org  {chiefBotId?, departments?, projects?, rules?, decisionRights?}
//                                         → OrgConfig (arrays replace, rules merge)
//   GET   /api/org/events?since=<ms>      → { events }      oldest first
//   GET   /api/org/decisions              → { decisions }   newest first
//   GET   /api/brief?since=<ms>           → Brief
//   GET   /api/usage/summary              → UsageSummary
//   GET   /api/library                    → { docs }
//   GET   /api/library/:id[?version=n]    → { doc, text, version }
//   POST  /api/library {id?, title, section, text, note?, ownerBotId?, summary?, decisionId?}
//                                         → LibraryDoc
//   POST  /api/library/:id/subscribe {botId, on} → LibraryDoc
import type { IncomingMessage, ServerResponse } from "node:http";

import { OrgConfigError } from "./config.ts";
import type { OrgEventLog } from "./events.ts";
import type { OrgLayer } from "./layer.ts";
import { LibraryError } from "./library.ts";

/** What the routes need from the server; wired in server/index.ts. */
export interface OrgApiDeps {
  json: (res: ServerResponse, status: number, body: unknown) => void;
  readBody: (req: IncomingMessage) => Promise<unknown>;
  events: OrgEventLog;
  org: OrgLayer;
}

const DOC = /^\/api\/library\/([\w-]{1,64})$/;
const SUBSCRIBE = /^\/api\/library\/([\w-]{1,64})\/subscribe$/;

/** A millisecond timestamp query parameter; absent or junk reads as `fallback`. */
function millis(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export async function handleOrgApi(
  method: string,
  path: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  deps: OrgApiDeps,
): Promise<boolean> {
  const { org } = deps;
  const send = (status: number, body: unknown) => {
    deps.json(res, status, body);
    return true;
  };
  const notAllowed = () => send(405, { error: `${method} is not supported on ${path}` });
  try {
    if (path === "/api/org") {
      if (method === "GET") return send(200, org.org());
      if (method === "PATCH") return send(200, org.patchOrg(await deps.readBody(req)));
      return notAllowed();
    }
    if (path === "/api/org/events") {
      if (method !== "GET") return notAllowed();
      return send(200, { events: org.eventsSince(millis(url, "since", 0)) });
    }
    if (path === "/api/org/decisions") {
      if (method !== "GET") return notAllowed();
      return send(200, { decisions: org.decisionList() });
    }
    if (path === "/api/brief") {
      if (method !== "GET") return notAllowed();
      return send(200, org.brief(millis(url, "since", 0)));
    }
    if (path === "/api/usage/summary") {
      if (method !== "GET") return notAllowed();
      return send(200, org.usage());
    }
    if (path === "/api/library") {
      if (method === "GET") return send(200, { docs: org.libraryList() });
      if (method === "POST") return send(200, org.publishDoc(await deps.readBody(req)));
      return notAllowed();
    }
    const subscribe = SUBSCRIBE.exec(path);
    if (subscribe) {
      if (method !== "POST") return notAllowed();
      return send(200, org.subscribeDoc(subscribe[1]!, await deps.readBody(req)));
    }
    const doc = DOC.exec(path);
    if (doc) {
      if (method !== "GET") return notAllowed();
      const raw = url.searchParams.get("version");
      const version = raw === null ? undefined : Number(raw);
      if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
        return send(400, { error: "version must be a positive integer" });
      }
      const read = org.libraryRead(doc[1]!, version);
      return read ? send(200, read) : send(404, { error: "no such document or version" });
    }
    return false;
  } catch (error) {
    if (error instanceof OrgConfigError || error instanceof LibraryError) return send(error.status, { error: error.message });
    throw error;
  }
}

/** Paths this module owns; index.ts routes only these here. */
export function isOrgApiPath(path: string): boolean {
  return (
    path === "/api/org" ||
    path.startsWith("/api/org/") ||
    path === "/api/brief" ||
    path === "/api/usage/summary" ||
    path === "/api/library" ||
    path.startsWith("/api/library/")
  );
}
