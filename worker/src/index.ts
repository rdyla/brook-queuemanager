export interface Env {
  ASSETS: { fetch: (req: Request) => Promise<Response>; }
  ZOOM_ACCOUNT_ID: string;
  ZOOM_CLIENT_ID: string;
  ZOOM_CLIENT_SECRET: string;

  // Optional: restrict who can hit the API before Cloudflare Access is added
  ADMIN_API_KEY?: string;
}

const ZOOM_API_BASE = "https://api.zoom.us/v2";
const ZOOM_TOKEN_URL = "https://zoom.us/oauth/token";

// In-memory token cache (per isolate)
let cachedAccessToken: string | null = null;
let cachedAccessTokenExpMs = 0;

function json(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(data, null, 2), { ...init, headers });
}

function badRequest(message: string, details?: unknown) {
  return json({ ok: false, error: "bad_request", message, details }, { status: 400 });
}

function unauthorized(message = "Unauthorized") {
  return json({ ok: false, error: "unauthorized", message }, { status: 401 });
}

function methodNotAllowed() {
  return json({ ok: false, error: "method_not_allowed" }, { status: 405 });
}

function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") || "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
    "access-control-allow-headers": "content-type, authorization, x-admin-api-key",
    "access-control-allow-credentials": "true",
  };
}

async function readJson(req: Request) {
  const ct = req.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return null;
  return await req.json();
}



/**
 * Minimal CSV parser with quoted-field support.
 * Good enough for admin CSV uploads without a library.
 */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (c === '"' && next === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      continue;
    }

    if (c === ",") {
      row.push(field.trim());
      field = "";
      continue;
    }

    if (c === "\n") {
      row.push(field.trim());
      field = "";
      if (row.some((x) => x.length > 0)) rows.push(row);
      row = [];
      continue;
    }

    if (c === "\r") continue;

    field += c;
  }

  row.push(field.trim());
  if (row.some((x) => x.length > 0)) rows.push(row);

  if (rows.length < 1) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => (obj[h] = (r[idx] ?? "").trim()));
    return obj;
  });
}

async function getZoomAccessToken(env: Env): Promise<string> {
  const now = Date.now();
  if (cachedAccessToken && now < cachedAccessTokenExpMs - 30_000) return cachedAccessToken;

  const basic = btoa(`${env.ZOOM_CLIENT_ID}:${env.ZOOM_CLIENT_SECRET}`);
  const url = new URL(ZOOM_TOKEN_URL);
  url.searchParams.set("grant_type", "account_credentials");
  url.searchParams.set("account_id", env.ZOOM_ACCOUNT_ID);

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Zoom token error ${res.status}: ${t}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedAccessToken = data.access_token;
  cachedAccessTokenExpMs = Date.now() + data.expires_in * 1000;
  return cachedAccessToken;
}

async function zoomFetch(env: Env, path: string, init: RequestInit = {}) {
  const token = await getZoomAccessToken(env);
  const url = `${ZOOM_API_BASE}${path.startsWith("/") ? path : `/${path}`}`;

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept", "application/json");

  // Only set JSON content-type when we have a body and caller didn't already set it.
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  const isJson = (res.headers.get("content-type") || "").includes("application/json");
  const body = isJson && text ? JSON.parse(text) : text;

  if (!res.ok) {
    return { ok: false, status: res.status, body };
  }
  return { ok: true, status: res.status, body };
}

function requireApiKey(req: Request, env: Env) {
  // Optional pre-Access lock: set ADMIN_API_KEY in Worker env and require header x-admin-api-key
  if (!env.ADMIN_API_KEY) return true;
  const key = req.headers.get("x-admin-api-key") || "";
  return key && key === env.ADMIN_API_KEY;
}

/** ---- Handlers ---- */

async function handleListQueues(req: Request, env: Env) {
  const url = new URL(req.url);
  const qs = new URLSearchParams();

  // Pass through common filters
  for (const k of ["channel", "channel_type", "page_size", "next_page_token"]) {
    const v = url.searchParams.get(k);
    if (v) qs.set(k, v);
  }

  const path = `/contact_center/queues${qs.toString() ? `?${qs.toString()}` : ""}`;
  const r = await zoomFetch(env, path, { method: "GET" });
  return json({ ok: r.ok, status: r.status, data: r.body }, { status: r.ok ? 200 : r.status });
}

async function handleCreateQueue(req: Request, env: Env) {
  const body = await readJson(req);
  if (!body || typeof body !== "object") return badRequest("Expected JSON body.");

  // We intentionally do NOT over-validate here—Zoom will enforce schema.
  // But we do preserve `channel_types` because it may still be required. :contentReference[oaicite:8]{index=8}
  const r = await zoomFetch(env, `/contact_center/queues`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  return json({ ok: r.ok, status: r.status, data: r.body }, { status: r.ok ? 201 : r.status });
}

async function handlePatchQueue(req: Request, env: Env, queueId: string) {
  const body = await readJson(req);
  if (!body || typeof body !== "object") return badRequest("Expected JSON body.");
  const r = await zoomFetch(env, `/contact_center/queues/${encodeURIComponent(queueId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  return json({ ok: r.ok, status: r.status, data: r.body }, { status: r.ok ? 200 : r.status });
}

async function handleBulkCreate(req: Request, env: Env) {
  const ct = req.headers.get("content-type") || "";
  let csvText = "";

  if (ct.includes("text/csv")) {
    csvText = await req.text();
  } else if (ct.includes("application/json")) {
    const body = await req.json().catch(() => null) as any;
    csvText = String(body?.csv || "");
  } else {
    return badRequest("Send CSV as text/csv OR JSON { csv: \"...\" }");
  }

  const rows = parseCsv(csvText);
  if (!rows.length) return badRequest("CSV had no data rows.");

  // Basic mapping. You can extend columns as needed.
  // Required-ish: queue_name, channel_types (often), plus whatever your tenant requires.
  const tasks = rows.map((r, idx) => {
    const payload: any = {
      queue_name: r.queue_name || r.name,
      queue_description: r.queue_description || r.description || "",
      // common numeric fields:
      max_wait_time: r.max_wait_time ? Number(r.max_wait_time) : undefined,
      wrap_up_time: r.wrap_up_time ? Number(r.wrap_up_time) : undefined,
      max_engagement_in_queue: r.max_engagement_in_queue ? Number(r.max_engagement_in_queue) : undefined,
      // keep channel_types since it may still be required :contentReference[oaicite:9]{index=9}
      channel_types: (r.channel_types || "voice").split("|").map((s) => s.trim()).filter(Boolean),
    };

    // Remove undefined so PATCH/POST stays clean
    Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

    return { idx, payload };
  });

  // Throttle to be nice to Zoom rate limits (and avoid bursts).
  const concurrency = 4;
  const results: any[] = [];
  let cursor = 0;

  async function worker() {
    while (cursor < tasks.length) {
      const t = tasks[cursor++];
      if (!t.payload.queue_name) {
        results.push({ idx: t.idx, ok: false, error: "Missing queue_name" });
        continue;
      }

      const r = await zoomFetch(env, `/contact_center/queues`, {
        method: "POST",
        body: JSON.stringify(t.payload),
      });

      results.push({
        idx: t.idx,
        ok: r.ok,
        status: r.status,
        response: r.body,
        request: t.payload,
      });
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  results.sort((a, b) => a.idx - b.idx);

  return json(
    {
      ok: true,
      created: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    },
    { status: 200 },
  );
}

async function handleApi(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/api/queues" && req.method === "GET") {
    return await handleListQueues(req, env);
  }

  if (url.pathname === "/api/queues" && req.method === "POST") {
    return await handleCreateQueue(req, env);
  }

  if (url.pathname === "/api/queues/bulk" && req.method === "POST") {
    return await handleBulkCreate(req, env);
  }

  const m = url.pathname.match(/^\/api\/queues\/([^/]+)$/);
  if (m && req.method === "PATCH") {
    return await handlePatchQueue(req, env, m[1]);
  }

  return json({ ok: false, error: "api_not_found", path: url.pathname }, { status: 404 });

}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    console.log (url.pathname);
    // API always handled here, never by SPA assets
    if (url.pathname.startsWith("/api/")) {
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(req) });
      }
      if (!requireApiKey(req, env)) return withCors(req, unauthorized());
      return withCors(req, handleApi(req, env));
    }

    // Health
    if (url.pathname === "/health") {
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(req) });
      }
      return withCors(req, new Response("OK", { status: 200, headers: { "cache-control": "no-store" } }));

    }

    if (url.pathname === "/" || url.pathname.startsWith("/ui/")) {
    return withCors(req, env.ASSETS.fetch(req));
    }
    return new Response("Not Found", { status: 404 });

    // UI assets (SPA fallback allowed here)
    const res = await env.ASSETS.fetch(req);
    const h = new Headers(res.headers);
    if ((h.get("content-type") || "").includes("text/html")) {
      h.set("cache-control", "no-store");
    }
    return withCors(req, new Response(res.body, { ...res, headers: h }));

  },
};

function withCors(req: Request, p: Promise<Response> | Response) {
  return Promise.resolve(p).then((res) => {
    const headers = new Headers(res.headers);
    const cors = corsHeaders(req);
    headers.set("x-bqm-worker", "api");
    Object.entries(cors).forEach(([k, v]) => headers.set(k, v));
    return new Response(res.body, { ...res, headers });
  });
}
