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
