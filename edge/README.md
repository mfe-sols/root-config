# Edge SEO prerender (Layer 2) — scaffold

`seo-prerender.worker.js` is a **Cloudflare Worker scaffold** that gives social
and search crawlers real `<head>` metadata for the experiences feature, because
the SPA renders content with JavaScript that crawlers don't run.

> Status: **not deployed**. It currently uses inline `MOCK_POSTS` / `MOCK_CREATORS`.
> Wire it to `bff-api` before going live.

## Two layers, one source of truth

| Layer | Where | Runs for | Source file |
| ----- | ----- | -------- | ----------- |
| 1 — client | `useSeo()` in the header MFE | real browsers (Google JS render, tab title, in-app share) | `apps/mfe-header-react/src/mvp/view/experiences/seo.ts` + `useSeo.ts` |
| 2 — edge | this Worker | non-JS crawlers (Facebook, Twitter/X, Slack, LinkedIn, Discord, Zalo, WhatsApp…) | `seo-prerender.worker.js` |

Both produce the **same `SeoMeta` shape** (title, description, canonical, OG,
Twitter, JSON-LD). Keep them in sync when fields change.

## How it works

For a crawler request to `/experiences/:slug` or `/experiences/creator/:id`:

1. detect crawler via `User-Agent`;
2. resolve the post/creator (mock now → `bff-api` later);
3. fetch the real shell HTML from origin;
4. rewrite `<head>` with `HTMLRewriter` (drop generic `<title>`, prepend SEO tags);
5. return the patched HTML.

Human/browser requests pass straight through, so the SPA is untouched.

## Deploy checklist (later)

1. **Proxy the app domain through Cloudflare** — `app.vopenworld.com` must be
   orange-clouded so a Worker route can intercept it (origin = Vercel).
2. Add a Worker route: `app.vopenworld.com/experiences/*`.
3. Replace `resolvePost()` / `resolveCreator()` with `fetch` calls to
   `bff-api` (e.g. `GET /experiences/:slug`, `GET /creators/:id`) and cache at
   the edge (`cf: { cacheEverything: true, cacheTtl: 300 }`).
4. Emit `/sitemap.xml` dynamically from the backend (replaces the static one in
   `public/sitemap.xml`).
5. Validate with the Facebook Sharing Debugger, X Card Validator, LinkedIn Post
   Inspector, and `curl -A "facebookexternalhit/1.1" https://app.vopenworld.com/experiences/<slug>`.

## Business subdomain routing

Business public pages use wildcard hosts:

```txt
*.vopenworld.com -> root-config frontend origin
```

Keep exact records separate:

```txt
app.vopenworld.com -> root-config frontend origin
api.vopenworld.com -> backend/API origin
```

The root-config runtime treats single-label, non-reserved wildcard hosts as
business pages. For example, `acme.vopenworld.com` mounts the business-page MFE
with `window.__vopenworldDomain.businessSlug = "acme"`. Reserved subdomains
such as `app`, `api`, `www`, `qr`, `admin`, `assets`, `cdn`, and `status` must
be rejected by backend slug validation too.
