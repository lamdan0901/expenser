// Task 1 stub: unknown `/api/*` routes get a JSON 404; everything else is
// served by the static assets binding. Auth and real endpoints arrive later.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },
};
