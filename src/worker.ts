// Auth runs before route dispatch for every `/api/*` route except the two
// public entry points. Task 3 fills in the real route bodies; until then
// authenticated requests still fall through to the JSON 404.
import { requireAuth } from "./auth";

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

      return Response.json({ error: "not_found" }, { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },
};
