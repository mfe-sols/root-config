/**
 * Vercel Serverless Function – /api/mfe-toggle
 *
 * Proxies toggle state to the central API server so that disabling a module
 * in one browser is visible to every other browser / device.
 *
 * Primary: forwards to the API server (AUTH_BASE_URL / API_BASE_URL)
 * Fallback: Upstash Redis REST API (if KV_REST_API_URL is set)
 *
 * GET  /api/mfe-toggle → { disabled: string[] }
 * POST /api/mfe-toggle → body { disabled: string[] } → { disabled: string[] }
 */

const API_BASE = process.env.AUTH_BASE_URL || process.env.API_BASE_URL || "";
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const REDIS_KEY = "mfe-toggle:disabled";

// ── Redis helpers (raw REST, no SDK) ────────────────────────────────────────

async function kvGet() {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const res = await fetch(`${KV_URL}/get/${REDIS_KEY}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    const data = await res.json();
    return data.result ? JSON.parse(data.result) : [];
  } catch {
    return null;
  }
}

async function kvSet(value) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    const res = await fetch(KV_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KV_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(["SET", REDIS_KEY, JSON.stringify(value)]),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── API server proxy ────────────────────────────────────────────────────────

async function apiGet() {
  if (!API_BASE) return null;
  try {
    const res = await fetch(`${API_BASE}/api/mfe-toggle`, {
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.disabled) ? data.disabled : [];
  } catch {
    return null;
  }
}

async function apiPost(disabled) {
  if (!API_BASE) return false;
  try {
    const res = await fetch(`${API_BASE}/api/mfe-toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabled }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Handler ─────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  // CORS — allow status.html and root-config from any origin
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {
    if (req.method === "GET") {
      // Priority: API server → KV → fallback
      const apiResult = await apiGet();
      if (apiResult !== null) return res.json({ disabled: apiResult });

      const kvResult = await kvGet();
      if (kvResult !== null) return res.json({ disabled: kvResult });

      return res.json({ disabled: [] });
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
      const disabled = Array.isArray(body.disabled)
        ? body.disabled.filter((n) => typeof n === "string")
        : [];

      // Write to API server (primary) and KV (backup) in parallel
      const [apiOk] = await Promise.all([apiPost(disabled), kvSet(disabled)]);
      if (!apiOk) console.warn("[api/mfe-toggle] API server write failed, KV used as fallback");

      return res.json({ disabled });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[api/mfe-toggle] error:", err);
    return res.status(500).json({ disabled: [] });
  }
};
