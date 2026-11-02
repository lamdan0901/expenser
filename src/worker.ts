// Auth runs before route dispatch for every `/api/*` route except the two
// public entry points. Authenticated routes are dispatched below; anything
// unrecognised falls through to the JSON 404.
import { requireAuth } from "./auth";
import { handleInitialBalance, handleMe, handlePasscode } from "./setup";
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
        case "GET /api/templates":
          return handleListTemplates(env);
        case "POST /api/templates":
          return handleCreateTemplate(request, env);
      }

      const templateRoute = /^\/api\/templates\/(\d+)$/.exec(pathname);
      if (templateRoute !== null) {
        const id = Number(templateRoute[1]);

        if (request.method === "PATCH") return handlePatchTemplate(request, env, id);
        if (request.method === "DELETE") return handleDeleteTemplate(env, id);
      }

      return Response.json({ error: "not_found" }, { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },
};
