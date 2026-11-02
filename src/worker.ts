// Auth runs before route dispatch for every `/api/*` route except the two
// public entry points. Authenticated routes are dispatched below; anything
// unrecognised falls through to the JSON 404.
import { requireAuth } from "./auth";
import { handleInitialBalance, handleMe, handlePasscode } from "./setup";

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
      }

      return Response.json({ error: "not_found" }, { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },
};
