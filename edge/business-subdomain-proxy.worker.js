/*
  business-subdomain-proxy.worker.js — EDGE PROXY for vOpenWorld business subdomains.

  WHY THIS EXISTS
  ---------------
  *.vopenworld.com (acme.vopenworld.com, demo123.vopenworld.com, …) must serve the
  same Vercel app shell as app.vopenworld.com. We cannot point the wildcard straight
  at Vercel through Cloudflare because Vercel only has a TLS cert for app.vopenworld.com:
  a proxied wildcard makes Cloudflare present SNI = acme.vopenworld.com to Vercel, the
  handshake has no matching cert → HTTP 525. Fixing that with an Origin Rule SNI
  override requires a Cloudflare Enterprise plan.

  This Worker sidesteps the whole problem:
    - It fetches the app from ORIGIN = https://<project>.vercel.app
      (a *.vercel.app hostname that always has a valid cert, and lives OUTSIDE the
      vopenworld.com zone so the subrequest never loops back into this Worker).
    - It rewrites the upstream Host header to app.vopenworld.com so Vercel routes the
      request to the correct project/domain.
    - The browser URL stays acme.vopenworld.com, so the client-side businessSlug
      detection in org-root-config.ts keeps working unchanged.

  ROUTING (set up at deploy time — see edge/README.md)
  ----------------------------------------------------
    Route   : *.vopenworld.com/*        -> this Worker
    Exclude : api.vopenworld.com/*      -> no Worker (so the BFF backend is untouched)

  app.vopenworld.com and www.vopenworld.com also match the wildcard route and are
  proxied to the same Vercel app (correct behaviour). Only the API host must be
  excluded so it continues to reach the Droplet backend directly.

  cdn.vopenworld.com ALSO matches the wildcard route. It must NOT be proxied to
  Vercel (Vercel's SPA fallback would answer every static-asset request with
  index.html → MFE bundles load as text/html and single-spa cannot boot). Instead
  this Worker serves cdn.* straight from the DigitalOcean Spaces bucket so the JS
  bundles keep their correct content-type. (Same behaviour as the standalone
  cdn-spaces-proxy Worker, folded in here so the wildcard route cannot shadow it.)

  CONFIG (wrangler [vars])
  ------------------------
    ORIGIN = https://<app-project>.vercel.app
*/

const APP_HOST = "app.vopenworld.com";
const API_HOST = "api.vopenworld.com";
const TRAEFIK_HOST = "traefik.vopenworld.com";
const CDN_HOST = "cdn.vopenworld.com";
const CDN_ORIGIN = "https://vopenworld-mfe.sgp1.digitaloceanspaces.com";
const CDN_ORIGIN_HOST = "vopenworld-mfe.sgp1.digitaloceanspaces.com";

/**
 * CORS allowlist for CDN assets: only the app shell and *.vopenworld.com
 * business subdomains are legitimate cross-origin consumers of the MFE bundles.
 * Returns true for https origins on the vopenworld.com apex or any subdomain.
 * @param {string | null} origin
 */
const isAllowedCdnOrigin = (origin) => {
  if (!origin) return false;
  try {
    const { protocol, hostname } = new URL(origin);
    if (protocol !== "https:") return false;
    return hostname === "vopenworld.com" || hostname.endsWith(".vopenworld.com");
  } catch {
    return false;
  }
};

/**
 * Common reconnaissance / sensitive paths probed by automated scanners.
 * Matched (case-insensitive) against the URL pathname. Does NOT match the
 * legitimate /.well-known/ tree. Any hit returns an indistinguishable 404.
 */
const RECON_PATH =
  /(?:^|\/)(?:\.(?:env|git|svn|hg|aws|ssh|htaccess|htpasswd|ds_store|vscode|idea|bash_history|npmrc)\b|wp-admin|wp-login\.php|wp-content|wp-includes|xmlrpc\.php|phpmyadmin|phpinfo\.php)|\.(?:sql|bak|old|swp)(?:$|\?)/i;

/* ── Image resize allow-list (bounded Cloudflare Image Resizing via Worker) ───
   Requests to  cdn.vopenworld.com/i/<W>x<H>x<Q>/<srcKey>  are resized with the
   first-party engine, but W/H/Q are SNAPPED to a fixed ladder server-side, so
   the number of DISTINCT (billable, cached) transformations stays bounded no
   matter what a client — or an attacker — asks for. Arbitrary or oversized
   values collapse onto an existing ladder step instead of minting a new unique
   transformation. The source must be an on-zone object (served from Spaces via
   this same Worker), matching the zone's "This zone only" setting.

   This is the ONLY resize path the frontend references; the raw /cdn-cgi/image/
   endpoint is never advertised. It also gives us a stable image-URL contract we
   can later back with pre-generated upload variants without any frontend change. */
const SIZE_LADDER = [96, 160, 240, 320, 480, 640, 800, 1080, 1440, 1600, 2048, 2560, 4096];
const MAX_IMAGE_SIZE = 4096;
const QUALITY_STEPS = [60, 70, 78, 82, 85];

/** Snap a pixel size UP to the nearest ladder step (0 = auto/omit). */
const snapSize = (value) => {
  const target = Math.max(0, Math.round(Number(value) || 0));
  if (target === 0) return 0;
  for (const step of SIZE_LADDER) if (step >= target) return step;
  return MAX_IMAGE_SIZE;
};
/** Snap quality to the nearest canonical step. */
const snapQuality = (value) => {
  const target = Math.max(1, Math.min(100, Math.round(Number(value) || 0)));
  return QUALITY_STEPS.reduce((best, s) => (Math.abs(s - target) < Math.abs(best - target) ? s : best));
};

/**
 * Serve a bounded, resized image for /i/<W>x<H>x<Q>/<srcKey> on the CDN host.
 * @param {URL} url
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function handleImageResize(url, request) {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return new Response("method not allowed", { status: 405 });
  }
  // "/i/<opts>/<host>/<path…>" → split off the first segment as the options.
  const rest = url.pathname.slice(3); // strip "/i/"
  const slash = rest.indexOf("/");
  if (slash <= 0) return new Response("bad image request", { status: 400 });
  const optsPart = rest.slice(0, slash);
  const srcSpec = rest.slice(slash + 1).replace(/^\/+/, "");
  if (!srcSpec || srcSpec.includes("/cdn-cgi/") || srcSpec.includes("..")) {
    return new Response("bad image source", { status: 400 });
  }
  // Split "<host>/<path>" and hard allow-list the host to our own zone. This is
  // the SSRF guard: the Worker will only ever fetch same-zone objects, never an
  // attacker-supplied external host.
  const hostSlash = srcSpec.indexOf("/");
  if (hostSlash <= 0) return new Response("bad image source", { status: 400 });
  const srcHost = srcSpec.slice(0, hostSlash).toLowerCase();
  const srcPath = srcSpec.slice(hostSlash + 1);
  const sameZone = srcHost === "vopenworld.com" || srcHost.endsWith(".vopenworld.com");
  if (!sameZone || !srcPath) return new Response("bad image source", { status: 400 });
  // Never let the source loop back into this resize route.
  if (srcHost === CDN_HOST && srcPath.startsWith("i/")) {
    return new Response("bad image source", { status: 400 });
  }
  const m = /^(\d{1,5})x(\d{1,5})x(\d{1,3})$/.exec(optsPart);
  if (!m) return new Response("bad image options", { status: 400 });
  const width = snapSize(m[1]);
  const height = snapSize(m[2]);
  const quality = snapQuality(m[3]);
  const image = { quality, fit: "cover", format: "auto" };
  if (width) image.width = width;
  if (height) image.height = height;

  // On-zone source → satisfies the "This zone only" Transformations setting.
  const sourceURL = `https://${srcHost}/${srcPath}`;
  const accept = request.headers.get("Accept") || "image/avif,image/webp,image/*,*/*";
  const passthrough = () => fetch(sourceURL, { headers: { Accept: accept } });
  try {
    const resized = await fetch(sourceURL, {
      headers: { Accept: accept },
      cf: { image, cacheEverything: true, cacheTtl: 86400 },
    });
    // On any resize failure serve the original so an <img> never blanks.
    if (!resized.ok) return passthrough();
    const headers = new Headers(resized.headers);
    for (const name of [...headers.keys()]) {
      if (name.toLowerCase().startsWith("x-amz-")) headers.delete(name);
    }
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    const reqOrigin = request.headers.get("Origin");
    if (isAllowedCdnOrigin(reqOrigin)) {
      headers.set("Access-Control-Allow-Origin", reqOrigin);
      const varyTokens = new Set(
        (headers.get("Vary") || "").split(",").map((t) => t.trim()).filter(Boolean),
      );
      varyTokens.add("Origin");
      headers.set("Vary", [...varyTokens].join(", "));
    }
    return new Response(resized.body, { status: resized.status, statusText: resized.statusText, headers });
  } catch {
    return passthrough();
  }
}

export default {
  /**
   * @param {Request} request
   * @param {{ ORIGIN?: string }} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    // Block common reconnaissance / scanner probes with an indistinguishable 404
    // so the infrastructure (stack, secrets, VCS metadata) is never disclosed.
    if (RECON_PATH.test(url.pathname)) {
      return new Response("Not Found", { status: 404 });
    }

    // Safety guard: never proxy the API host (it is excluded by a no-Worker route,
    // but if that route is ever missing we must not hijack backend traffic).
    if (url.hostname === API_HOST) {
      return new Response("api host is not served by this worker", { status: 404 });
    }

    if (url.hostname === TRAEFIK_HOST) {
      return new Response("traefik host is not served by this worker", { status: 404 });
    }

    // CDN host: serve static MFE bundles straight from DigitalOcean Spaces so they
    // keep their real content-type. Proxying these to Vercel would return the SPA
    // index.html for every path and break single-spa module loading.
    if (url.hostname === CDN_HOST) {
      // Bounded on-the-fly image resizing (allow-list ladder). This is the only
      // resize path the frontend uses; arbitrary dimensions are snapped so the
      // unique-transformation count (cost) can never be inflated.
      if (url.pathname.startsWith("/i/")) {
        return handleImageResize(url, request);
      }
      const cdnTarget = CDN_ORIGIN + url.pathname + url.search;
      const cdnHeaders = new Headers(request.headers);
      cdnHeaders.set("Host", CDN_ORIGIN_HOST);
      const method = request.method.toUpperCase();
      const cdnResp = await fetch(cdnTarget, {
        method,
        headers: cdnHeaders,
        redirect: "manual",
        body: method === "GET" || method === "HEAD" ? undefined : request.body,
      });
      // Allow cross-origin module loads only from the app shell and *.vopenworld.com
      // business subdomains. Reflect an allowlisted Origin instead of using "*".
      const outHeaders = new Headers(cdnResp.headers);
      // Strip origin fingerprinting headers so the S3/Spaces backend is not
      // disclosed to scanners (reduces reconnaissance surface).
      for (const name of [...outHeaders.keys()]) {
        if (name.toLowerCase().startsWith("x-amz-")) outHeaders.delete(name);
      }
      const reqOrigin = request.headers.get("Origin");
      if (isAllowedCdnOrigin(reqOrigin)) {
        outHeaders.set("Access-Control-Allow-Origin", reqOrigin);
      } else {
        outHeaders.delete("Access-Control-Allow-Origin");
      }
      // Cache must vary per Origin so the edge never serves one origin's ACAO to
      // another. Rebuild Vary as a deduplicated, comma-separated token list.
      const varyTokens = new Set(
        (outHeaders.get("Vary") || "")
          .split(",")
          .map((token) => token.trim())
          .filter(Boolean),
      );
      varyTokens.add("Origin");
      outHeaders.set("Vary", [...varyTokens].join(", "));
      return new Response(cdnResp.body, {
        status: cdnResp.status,
        statusText: cdnResp.statusText,
        headers: outHeaders,
      });
    }

    const origin = (env && env.ORIGIN ? String(env.ORIGIN) : "").replace(/\/+$/, "");
    if (!origin) {
      return new Response("proxy ORIGIN is not configured", { status: 500 });
    }

    const target = origin + url.pathname + url.search;

    const headers = new Headers(request.headers);
    headers.set("Host", APP_HOST);
    headers.set("X-Forwarded-Host", url.hostname);
    headers.set("X-Forwarded-Proto", "https");

    const method = request.method.toUpperCase();
    const resp = await fetch(target, {
      method,
      headers,
      redirect: "manual",
      body: method === "GET" || method === "HEAD" ? undefined : request.body,
    });

    // Keep the user on the business subdomain: rewrite redirects that point back
    // to the canonical app host.
    const loc = resp.headers.get("location");
    if (loc) {
      const rewritten = loc
        .replace(`https://${APP_HOST}`, `https://${url.hostname}`)
        .replace(`http://${APP_HOST}`, `https://${url.hostname}`);
      if (rewritten !== loc) {
        const h = new Headers(resp.headers);
        h.set("location", rewritten);
        return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
      }
    }

    return resp;
  },
};
