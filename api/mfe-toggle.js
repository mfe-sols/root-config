/**
 * Vercel Serverless Function – /api/mfe-toggle
 *
 * Proxies toggle state to the central API server so that disabling a module
 * in one browser is visible to every other browser / device.
 *
 * Primary: forwards to the API server (AUTH_BASE_URL / API_BASE_URL)
 * Fallback: Upstash Redis REST API (if KV_REST_API_URL is set)
 *
 * GET  /api/mfe-toggle → { disabled: string[], disabledMode?: object|string }
 * POST /api/mfe-toggle → body { disabled: string[], disabledMode?: object|string }
 */

const API_BASE = process.env.AUTH_BASE_URL || process.env.API_BASE_URL || "";
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const REDIS_DISABLED_KEY = "mfe-toggle:disabled";
const REDIS_MODE_KEY = "mfe-toggle:disabled-mode";

const isMode = (value) => value === "hide" || value === "placeholder";

const normalizeDisabledList = (value) => {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(value.filter((name) => typeof name === "string"))
  );
};

const normalizeDisabledMode = (value) => {
  if (isMode(value)) return { default: value, apps: {} };
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const apps = {};
  if (value.apps && typeof value.apps === "object" && !Array.isArray(value.apps)) {
    Object.entries(value.apps)
      .sort(([a], [b]) => a.localeCompare(b))
      .forEach(([name, mode]) => {
        if (typeof name === "string" && isMode(mode)) {
          apps[name] = mode;
        }
      });
  }

  const defaultMode = isMode(value.default) ? value.default : "hide";
  return { default: defaultMode, apps };
};

// ── Redis helpers (raw REST, no SDK) ────────────────────────────────────────

async function kvGetDisabled() {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const res = await fetch(`${KV_URL}/get/${REDIS_DISABLED_KEY}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    const data = await res.json();
    return data.result ? normalizeDisabledList(JSON.parse(data.result)) : [];
  } catch {
    return null;
  }
}

async function kvGetMode() {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const res = await fetch(`${KV_URL}/get/${REDIS_MODE_KEY}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    const data = await res.json();
    return data.result ? normalizeDisabledMode(JSON.parse(data.result)) : null;
  } catch {
    return null;
  }
}

async function kvSetDisabled(value) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    const res = await fetch(KV_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KV_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(["SET", REDIS_DISABLED_KEY, JSON.stringify(value)]),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function kvSetMode(value) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    const res = await fetch(KV_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KV_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(["SET", REDIS_MODE_KEY, JSON.stringify(value)]),
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
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    return {
      disabled: normalizeDisabledList(data.disabled),
      disabledMode: normalizeDisabledMode(data.disabledMode),
    };
  } catch {
    return null;
  }
}

async function apiPost(disabled, disabledMode) {
  if (!API_BASE) return false;
  try {
    const payload = { disabled };
    if (disabledMode) {
      payload.disabledMode = disabledMode;
    }
    const res = await fetch(`${API_BASE}/api/mfe-toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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
      // Priority: API server for disabled list, merge mode from API/KV.
      const [apiResult, kvDisabled, kvMode] = await Promise.all([
        apiGet(),
        kvGetDisabled(),
        kvGetMode(),
      ]);

      if (apiResult !== null || kvDisabled !== null || kvMode !== null) {
        const disabled = apiResult?.disabled ?? kvDisabled ?? [];
        const disabledMode = apiResult?.disabledMode ?? kvMode ?? null;
        return res.json(
          disabledMode
            ? { disabled, disabledMode }
            : { disabled }
        );
      }
      return res.json({ disabled: [] });
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
      const disabled = normalizeDisabledList(body.disabled);
      const hasDisabledMode = Object.prototype.hasOwnProperty.call(body, "disabledMode");
      const disabledMode = hasDisabledMode ? normalizeDisabledMode(body.disabledMode) : null;

      // Write to API server (primary) and KV (backup) in parallel.
      const writes = [apiPost(disabled, disabledMode), kvSetDisabled(disabled)];
      if (disabledMode) {
        writes.push(kvSetMode(disabledMode));
      }
      const [apiOk] = await Promise.all(writes);
      if (!apiOk) console.warn("[api/mfe-toggle] API server write failed, KV used as fallback");

      return res.json(
        disabledMode
          ? { disabled, disabledMode }
          : { disabled }
      );
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[api/mfe-toggle] error:", err);
    return res.status(500).json({ disabled: [] });
  }
};
