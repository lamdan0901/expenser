// Auth runs before route dispatch for every `/api/*` route except the two
// public entry points. Authenticated routes are dispatched below; anything
// unrecognised falls through to the JSON 404.
import { requireAuth } from "./auth";
import {
  handleCreateDebtEntry,
  handleDeleteDebtEntry,
  handleInitialDebt,
  handlePatchDebtEntry,
  handleReorderDebtEntries,
} from "./debt";
import {
  handleCreateEntry,
  handleDeleteEntry,
  handlePatchEntry,
  handleReorderEntries,
} from "./entries";
import {
  handleCreateFixedRow,
  handleDeleteFixedRow,
  handlePatchFixedRow,
  handleReorderFixedRows,
} from "./fixed-rows";
import { handleGetMonth } from "./month";
import {
  handleGetCollapsed,
  handleInitialBalance,
  handleMe,
  handlePasscode,
  handleSetCollapsed,
} from "./setup";
import { handleExportMonth, handleGetSummary } from "./summary";
import {
  handleCreateTemplate,
  handleDeleteTemplate,
  handleListTemplates,
  handlePatchTemplate,
} from "./templates";

const PUBLIC_API_ROUTES = new Set(["POST /api/passcode", "GET /api/me"]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/api" || pathname.startsWith("/api/")) {
      const route = `${request.method.toUpperCase()} ${pathname}`;

      if (!PUBLIC_API_ROUTES.has(route)) {
        const unauthorized = await requireAuth(request, env.PASSCODE);
        if (unauthorized) return unauthorized;
      }

      switch (route) {
        case "POST /api/passcode":
          return handlePasscode(request, env);
        case "GET /api/me":
          return handleMe(request, env);
        case "PUT /api/settings/initial":
          return handleInitialBalance(request, env);
        case "PUT /api/settings/initial-debt":
          return handleInitialDebt(request, env);
        case "GET /api/settings/collapsed":
        case "GET /api/settings/collapsed-sections":
          return handleGetCollapsed(env);
        case "PUT /api/settings/collapsed":
        case "PUT /api/settings/collapsed-sections":
        case "PATCH /api/settings/collapsed":
        case "PATCH /api/settings/collapsed-sections":
          return handleSetCollapsed(request, env);
        case "GET /api/templates":
          return handleListTemplates(env);
        case "POST /api/templates":
          return handleCreateTemplate(request, env);
      }

      const monthRoute = /^\/api\/month\/([^/]+)$/.exec(pathname);
      if (monthRoute !== null && request.method === "GET") {
        return handleGetMonth(env, monthRoute[1]);
      }

      const summaryRoute = /^\/api\/summary\/([^/]+)$/.exec(pathname);
      if (summaryRoute !== null && request.method === "GET") {
        return handleGetSummary(env, summaryRoute[1]);
      }

      const exportRoute = /^\/api\/month\/([^/]+)\/export$/.exec(pathname);
      if (exportRoute !== null && request.method === "GET") {
        return handleExportMonth(env, exportRoute[1]);
      }

      const entryRoute = /^\/api\/month\/([^/]+)\/entry$/.exec(pathname);
      if (entryRoute !== null && request.method === "POST") {
        return handleCreateEntry(request, env, entryRoute[1]);
      }

      const debtRoute = /^\/api\/month\/([^/]+)\/debt$/.exec(pathname);
      if (debtRoute !== null && request.method === "POST") {
        return handleCreateDebtEntry(request, env, debtRoute[1]);
      }

      const debtReorderRoute = /^\/api\/month\/([^/]+)\/debt\/reorder$/.exec(pathname);
      if (debtReorderRoute !== null && request.method === "POST") {
        return handleReorderDebtEntries(request, env, debtReorderRoute[1]);
      }

      const debtIdRoute = /^\/api\/debt\/(\d+)$/.exec(pathname);
      if (debtIdRoute !== null) {
        const id = Number(debtIdRoute[1]);

        if (request.method === "PATCH") return handlePatchDebtEntry(request, env, id);
        if (request.method === "DELETE") return handleDeleteDebtEntry(env, id);
      }

      const reorderRoute = /^\/api\/month\/([^/]+)\/reorder$/.exec(pathname);
      if (reorderRoute !== null && request.method === "POST") {
        return handleReorderEntries(request, env, reorderRoute[1]);
      }

      const entryIdRoute = /^\/api\/entry\/(\d+)$/.exec(pathname);
      if (entryIdRoute !== null) {
        const id = Number(entryIdRoute[1]);

        if (request.method === "PATCH") return handlePatchEntry(request, env, id);
        if (request.method === "DELETE") return handleDeleteEntry(env, id);
      }

      const templateRoute = /^\/api\/templates\/(\d+)$/.exec(pathname);
      if (templateRoute !== null) {
        const id = Number(templateRoute[1]);

        if (request.method === "PATCH") return handlePatchTemplate(request, env, id);
        if (request.method === "DELETE") return handleDeleteTemplate(env, id);
      }

      const fixedRoute = /^\/api\/fixed\/([^/]+)$/.exec(pathname);
      if (fixedRoute !== null && request.method === "POST") {
        return handleCreateFixedRow(request, env, fixedRoute[1]);
      }

      const fixedReorderRoute = /^\/api\/fixed\/([^/]+)\/reorder$/.exec(pathname);
      if (fixedReorderRoute !== null && request.method === "POST") {
        return handleReorderFixedRows(request, env, fixedReorderRoute[1]);
      }

      const fixedIdRoute = /^\/api\/fixed\/([^/]+)\/(\d+)$/.exec(pathname);
      if (fixedIdRoute !== null) {
        const ym = fixedIdRoute[1];
        const id = Number(fixedIdRoute[2]);

        if (request.method === "PATCH") return handlePatchFixedRow(request, env, ym, id);
        if (request.method === "DELETE") return handleDeleteFixedRow(env, ym, id);
      }

      return Response.json({ error: "not_found" }, { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },
};
