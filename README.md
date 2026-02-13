# @mfe-sols/root-config

Single-spa root-config orchestrator — MFE shell that loads and coordinates all microfrontend modules.

## Architecture

```
root-config (:9000)
├── Import Map → map module name → URL
├── Layout Engine → mount modules vào DOM
├── Shell UI → theme toggle, locale, auth panel, perf monitor
└── Loads MFE modules:
    ├── @org/header-react     → :9012
    ├── @org/catalog          → :9001
    ├── @org/profile-vue      → :9002
    ├── @org/checkout-angular → :9003
    ├── @org/dashboard-vue    → :9004
    └── ... (các module khác)
```

## Prerequisites

- Node.js >= 18
- pnpm >= 8
- `NODE_AUTH_TOKEN` with `read:packages` for GitHub Packages (`@mfe-sols/*`)

## Setup

```bash
# 1. Export token for GitHub Packages
export NODE_AUTH_TOKEN=your_github_token

# 2. Install dependencies
pnpm install

# 3. (Optional) Create .env from template
cp .env.example .env

# 4. Start dev server
pnpm start
# → http://localhost:9000
```

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm start` | Start dev server on port 9000 (local mode) |
| `pnpm build` | Build for production (webpack + types) |
| `pnpm typecheck` | TypeScript type checking |
| `pnpm lint` | ESLint |
| `pnpm format` | Prettier format |

## Import Map

### Local Development

Import map được define trong `src/index.ejs`, auto-load khi `--env isLocal`:

```json
{
  "@org/header-react": "//localhost:9012/org-header-react.js",
  "@org/catalog": "//localhost:9001/org-catalog.js"
}
```

Mỗi MFE module chỉ cần serve đúng port → root-config tự nhận.

### Production

Sửa `public/importmap.prod.json`:

```json
{
  "imports": {
    "@org/header-react": "https://header-react.vercel.app/org-header-react.js"
  }
}
```

## Shared Libraries

Root-config bundles 2 shared libs (not external):

| Package | Usage |
|---------|-------|
| `@mfe-sols/auth` | Authentication, session sync |
| `@mfe-sols/i18n` | Internationalization |

## CSS Sync Strategy

- `public/root-config.css` is app-owned (do not auto-overwrite from ui-kit).
- `sync-ui-kit-css.js` only syncs `ui-kit.css` by default.
- If you intentionally need to migrate `root-config.css` from ui-kit, run:

```bash
SYNC_ROOT_CONFIG_CSS=true node sync-ui-kit-css.js
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `IMPORTMAP_PROD_URL` | `/importmap.prod.json` | URL to production import map |
| `MFE_TOGGLE_URL` | `/api/mfe-toggle` | URL to MFE toggle API |
| `AUTH_BASE_URL` | (empty) | Auth API base URL |

## Module Toggle

Disable/enable modules at runtime via `POST /api/mfe-toggle`:

```json
{
  "disabled": ["@org/playground-react"]
}
```

Legacy clients that still call `/mfe-toggle.json` are internally rewritten to `/api/mfe-toggle` on Vercel.

## Deploy

```bash
pnpm build
npx vercel --prod
```
