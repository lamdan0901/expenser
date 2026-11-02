// Thin fetch wrappers over the Worker's JSON API.
//
// Every helper rejects when the response is not ok. `ApiError` carries the
// status and parsed error body, so the gate can tell a wrong passcode (401)
// from a rate limit (429) without inspecting strings.

export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.error) || `request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function request(path, options = {}) {
  const res = await fetch(path, options);
  if (!res.ok) {
    let body = null;
    try {
      body = await res.json();
    } catch {
      // Non-JSON error bodies (for example an asset 404) still throw.
    }
    throw new ApiError(res.status, body);
  }

  return res;
}

/** Sends a JSON body and returns the parsed response, or `null` for 204. */
async function sendJson(method, path, body) {
  const res = await request(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  return res.status === 204 ? null : res.json();
}

/** `GET /api/me` — public. `{verified, setup_done}`. */
export function getMe() {
  return request("/api/me").then((res) => res.json());
}

/** `POST /api/passcode` — sets the signed cookie on success. */
export function verifyPasscode(passcode) {
  return sendJson("POST", "/api/passcode", { passcode });
}

/** `PUT /api/settings/initial` — `value` is full dong. */
export function setInitialBalance(value) {
  return sendJson("PUT", "/api/settings/initial", { value });
}

/** `GET /api/month/:ym` — the month sheet. */
export function getMonth(ym) {
  return request(`/api/month/${encodeURIComponent(ym)}`).then((res) => res.json());
}

/** `POST /api/month/:ym/entry` — body `{kind, name, amount, date, comment}`. */
export function createEntry(ym, entry) {
  return sendJson("POST", `/api/month/${encodeURIComponent(ym)}/entry`, entry);
}

/** `PATCH /api/entry/:id` — body carries only the fields being changed. */
export function patchEntry(id, fields) {
  return sendJson("PATCH", `/api/entry/${id}`, fields);
}

/** `DELETE /api/entry/:id`. */
export function deleteEntry(id) {
  return sendJson("DELETE", `/api/entry/${id}`);
}

/** `POST /api/month/:ym/reorder` — body `{kind, ids}`, ids bottom-up. */
export function reorderEntries(ym, kind, ids) {
  return sendJson("POST", `/api/month/${encodeURIComponent(ym)}/reorder`, { kind, ids });
}

/** `POST /api/fixed/:ym` — body `{kind, name, amount, comment}` (k scale). */
export function createFixedRow(ym, row) {
  return sendJson("POST", `/api/fixed/${encodeURIComponent(ym)}`, row);
}

/** `PATCH /api/fixed/:ym/:id` — body carries only the fields being changed. */
export function patchFixedRow(ym, id, fields) {
  return sendJson("PATCH", `/api/fixed/${encodeURIComponent(ym)}/${id}`, fields);
}

/** `DELETE /api/fixed/:ym/:id`. */
export function deleteFixedRow(ym, id) {
  return sendJson("DELETE", `/api/fixed/${encodeURIComponent(ym)}/${id}`);
}

/** URL for the CSV download of `ym`; the browser handles the fetch. */
export function exportMonthUrl(ym) {
  return `/api/month/${encodeURIComponent(ym)}/export`;
}
