# VopenWorld Domain Routing

## Production Domain Model

| Surface | Host | Owner | Behavior |
| --- | --- | --- | --- |
| Root app | `app.vopenworld.com` | root-config frontend | Single-spa shell, normal app navigation |
| Business pages | `*.vopenworld.com` | root-config frontend | Same shell, host-based business slug |
| API | `api.vopenworld.com` | backend/API gateway | Backend services only |
| Apex | `vopenworld.com` | marketing or redirect | Redirect to marketing site or `app.vopenworld.com` |

`*.vopenworld.com` is valid for business pages only if reserved subdomains are blocked:

```txt
app
api
www
qr
admin
assets
cdn
status
```

## DNS

Recommended records:

```txt
app.vopenworld.com      CNAME  <root-config-frontend-host>
*.vopenworld.com        CNAME  <root-config-frontend-host>
api.vopenworld.com      CNAME  <api-gateway-host>
www.vopenworld.com      CNAME  vopenworld.com
```

Exact DNS records take priority over the wildcard. `api.vopenworld.com` must not be served by the frontend wildcard route.

## Runtime Behavior

Root app access:

```txt
https://app.vopenworld.com/b/acme
```

Business subdomain access:

```txt
https://acme.vopenworld.com/
```

For business hosts, root-config serves a business-only layout and exposes:

```ts
window.__vopenworldDomain = {
  host: "acme.vopenworld.com",
  isRootAppHost: false,
  isApiHost: false,
  isVopenworldHost: true,
  isBusinessHost: true,
  businessSlug: "acme",
};
```

The business MFE should read `window.__vopenworldDomain.businessSlug` first, then fall back to `/b/:slug` for in-app navigation.

## Deployment Checklist

1. Attach `app.vopenworld.com` to the root-config frontend deployment.
2. Attach wildcard `*.vopenworld.com` to the same root-config frontend deployment.
3. Attach `api.vopenworld.com` to the backend/API deployment, not the frontend.
4. Issue TLS coverage for `app.vopenworld.com`, `api.vopenworld.com`, and `*.vopenworld.com`.
5. Deploy `@org/mfe-business-page` to `https://cdn.vopenworld.com/business-page/org-mfe-business-page.js`.
6. Keep `public/importmap.prod.json` pointed at that stable CDN URL.
7. Add backend validation so reserved subdomains cannot be created as business slugs.
8. Test:

```txt
https://app.vopenworld.com/b/acme       -> root app layout + business MFE
https://acme.vopenworld.com/            -> business-only layout + business MFE
https://api.vopenworld.com/health       -> backend response
https://app.vopenworld.com/             -> normal app home
```

## Cloudflare + Vercel wildcard (production)

Vercel **cannot issue a wildcard TLS certificate** for `*.vopenworld.com` while
the zone uses Cloudflare nameservers (wildcard certs need a DNS-01 ACME
challenge that only the DNS owner can answer). Attaching `*.vopenworld.com`
directly to the Vercel project therefore stays stuck on **"Invalid
Configuration"**.

The shipped solution is a **Cloudflare Worker** that sits in front of
`*.vopenworld.com` and reverse-proxies each business subdomain to the Vercel app
shell. This works because the business slug is resolved **client-side** from
`window.location.hostname` (see `src/org-root-config.ts`): the browser URL stays
`acme.vopenworld.com`, only the upstream request is rewritten.

### Why a Worker (not an Origin Rule)

An Origin Rule that rewrites only the **Host header** is not enough: with SSL
mode **Full (strict)**, Cloudflare also presents the original hostname as the
TLS **SNI** to Vercel. Vercel has no certificate for `acme.vopenworld.com`, so
the origin handshake fails with **HTTP 525**. Overriding the **SNI** in an
Origin Rule requires a **Cloudflare Enterprise** plan, which this zone does not
have. The Worker avoids the problem entirely by fetching a `*.vercel.app`
hostname (always a valid cert, and **outside** the `vopenworld.com` zone so the
subrequest never loops back through the route).

### Architecture

```txt
browser: https://acme.vopenworld.com/path
   -> Cloudflare edge (record `*` is Proxied/orange)
   -> Worker `vopenworld-business-subdomain-proxy`  (route *.vopenworld.com/*)
        fetch https://mfe-root-config.vercel.app/path
        with Host: app.vopenworld.com   (Vercel routes to the app project)
   -> app shell HTML; browser URL stays acme.vopenworld.com -> slug = "acme"
```

### Components

1. **DNS (Cloudflare):**

   ```txt
   app.vopenworld.com   CNAME  cname.vercel-dns.com   (Proxied)
   *.vopenworld.com     CNAME  cname.vercel-dns.com   (Proxied)   <- Worker runs only on Proxied records
   www.vopenworld.com   CNAME  cname.vercel-dns.com   (Proxied)   <- must be Proxied or it 000s (no Vercel cert)
   api.vopenworld.com   A      <backend-ip>           (Proxied)
   ```

2. **TLS:** Cloudflare Universal SSL covers the apex and one-level
   `*.vopenworld.com`. SSL/TLS mode = **Full (strict)**.

3. **Vercel:** keep **only** `app.vopenworld.com` attached (Valid Configuration).
   Remove `*.vopenworld.com` (never validates with external DNS). The Worker
   sends `Host: app.vopenworld.com`, so this domain MUST stay attached.

4. **Worker** — code: `edge/business-subdomain-proxy.worker.js`,
   config: `edge/wrangler.toml` (`ORIGIN = https://mfe-root-config.vercel.app`).

   Routes (Cloudflare zone `vopenworld.com`):

   ```txt
   *.vopenworld.com/*    -> vopenworld-business-subdomain-proxy   (the Worker)
   api.vopenworld.com/*  -> (no Worker)                           (negates the wildcard so api stays on the backend)
   ```

   The Worker special-cases two hosts that also match the wildcard:
   - `api.vopenworld.com` → returns 404 (defence-in-depth; the no-Worker route
     already excludes it).
   - `cdn.vopenworld.com` → proxied **straight to the DigitalOcean Spaces bucket**
     (`vopenworld-mfe.sgp1.digitaloceanspaces.com`), NOT to Vercel. Without this,
     the wildcard would send `cdn.*` to Vercel, whose SPA fallback answers every
     static-asset path with `index.html` → MFE bundles load as `text/html` →
     single-spa hangs on "Loading system" (blank/white screen). See the gotcha
     below.

   All other hosts (`app`, `www`, business slugs) are proxied to the Vercel shell.

### Deploy / redeploy

```bash
cd apps/mfe-root-config/edge
npx wrangler login          # OAuth; or set CLOUDFLARE_API_TOKEN with Workers Scripts:Edit + Workers Routes:Edit
npx wrangler deploy         # creates/updates the Worker + the *.vopenworld.com/* route
```

The `api` exclusion is a one-time no-Worker route (omit `script`, do NOT send an
empty string — empty string errors with `10019`):

```bash
ZID="$(curl -fsS "https://api.cloudflare.com/client/v4/zones?name=vopenworld.com" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).result[0].id))')"
curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$ZID/workers/routes" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  --data '{"pattern":"api.vopenworld.com/*"}'
```

### Gotchas (hit during setup)

- **`routes` must precede `[vars]` in `wrangler.toml`.** Placed after `[vars]`,
  TOML nests it inside the table and wrangler treats it as a plain variable
  (`env.routes`) — the route is silently never created and business subdomains
  keep returning 525.
- **`www` returns `000` while DNS-only.** Set the `www` record to **Proxied** so
  the Worker route applies; otherwise it hits Vercel directly with no cert.
- **SNI override (Origin Rules) needs Enterprise** — confirmed unavailable on
  this plan; the Worker is the supported path.
- **The wildcard `*.vopenworld.com/*` route also captures `cdn.vopenworld.com`**
  and shadows the standalone `cdn-spaces-proxy` Worker's custom domain. Symptom:
  every `https://cdn.vopenworld.com/<mfe>/<bundle>.js` returns `200` with
  `content-type: text/html` (the Vercel SPA `index.html`, identifiable by the
  `x-vercel-id` / `x-vercel-cache` response headers), so SystemJS refuses to
  execute the module (`MIME type 'text/html' is not executable`,
  `SystemJS Error#3`) and the app stays on "Loading system". The file on Spaces
  is fine — verify with a cache-busting query:
  `curl -sI 'https://vopenworld-mfe.sgp1.digitaloceanspaces.com/header/org-header-react.js'`
  returns `text/javascript`. **Fix:** the Worker now detects `cdn.vopenworld.com`
  and serves it from the Spaces origin (folded into
  `business-subdomain-proxy.worker.js`), so the wildcard can no longer shadow it.
  (Alternative if you prefer to keep `cdn` on its own Worker: add a no-Worker
  route `cdn.vopenworld.com/*` exactly like the `api` exclusion.)

### Verify

```bash
for h in acme demo123 app www; do
  curl -s -o /dev/null -w "$h=%{http_code}\n" --max-time 15 https://$h.vopenworld.com/
done
curl -s -o /dev/null -w "api=%{http_code}\n" https://api.vopenworld.com/ready
# expect: acme/demo123/app/www = 200, api = 200

# cdn must serve real JS (content-type application/javascript / text/javascript),
# NOT text/html. Cache-bust to read the true origin:
ts=$(date +%s)
for p in header/org-header-react.js footer/org-footer-react.js \
         hero-discovery/org-mfe-hero-discovery.js vr-res/org-vr-res-react.js \
         auth-angular/main.js; do
  curl -s -o /dev/null -w "$p ct=%{content_type}\n" "https://cdn.vopenworld.com/$p?cb=$ts"
done
```

> Alternative: moving the zone to Vercel nameservers gives automatic wildcard
> TLS but drops Cloudflare (WAF / Workers / cache) — not used here.

## CORS for business subdomains (backend)

Business pages run on `https://<slug>.vopenworld.com` and call
`https://api.vopenworld.com`. The BFF (`apps/bff-api`) must allow those origins.
Use the `CORS_ORIGIN_WILDCARDS` env (CSV; `*` matches exactly one DNS label,
anchored) alongside the exact `CORS_ORIGIN` list:

```env
CORS_ORIGIN=https://app.vopenworld.com
CORS_ORIGIN_WILDCARDS=https://*.vopenworld.com
```

`*` matches a single label only, so `https://acme.vopenworld.com` is allowed
while `https://a.b.vopenworld.com` and
`https://acme.vopenworld.com.evil.com` are rejected.


