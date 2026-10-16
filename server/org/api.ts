// HTTP routes for the company layer: /api/org, /api/org/events,
// /api/org/decisions, /api/brief, /api/usage/summary and /api/library.
// Contracts live in shared/org-types.ts; the app reads them through
// src/state/org-api.ts. Returns true when it answered the request.
import type { IncomingMessage, ServerResponse } from "node:http";

/** What the routes need from the server; wired in server/index.ts. */
export interface OrgApiDeps {
  json: (res: ServerResponse, status: number, body: unknown) => void;
  readBody: (req: IncomingMessage) => Promise<unknown>;
}

export async function handleOrgApi(
  _method: string,
  _path: string,
  _url: URL,
  _req: IncomingMessage,
  _res: ServerResponse,
  _deps: OrgApiDeps,
): Promise<boolean> {
  return false;
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
