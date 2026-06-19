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

