import { addErrorHandler, registerApplication, start, navigateToUrl } from "single-spa";
import {
  constructApplications,
  constructRoutes,
  constructLayoutEngine,
} from "single-spa-layout";
import microfrontendLayoutTemplate from "./microfrontend-layout.html";
import layoutHeader from "./layout/layout-header.html";
import playgroundRoutes from "./layout/routes-playgrounds.html";
import dashboardRoute from "./layout/routes-dashboard.html";
import budgetPlansRoute from "./layout/routes-budget-plans.html";
import authRoute from "./layout/routes-auth.html";
import mgnKahootMiniRoute from "./layout/routes-mgn-kahoot-mini.html";
import destinationsRoute from "./layout/routes-destinations.html";
import experiencesRoute from "./layout/routes-experiences.html";
import defaultRoute from "./layout/routes-default.html";
import {
  applyI18nToDom,
  getStoredLocale,
  initI18nFromStorage,
  setLocale,
  setStoredLocale,
  type Locale,
} from "@mfe-sols/i18n";
import { initRootConfigShellUi } from "./root-config-shell-ui";
import {
  fetchCurrentUserCached,
  getCurrentUser,
  initAuthUserSync,
  isAuthenticated,
  subscribeAuthChange,
} from "@mfe-sols/auth";

const AUTH_ME_ENDPOINT = "/auth/me";

/** Escape HTML special chars to prevent XSS when building DOM strings. */
const escapeHtml = (str: string) =>
  str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Read CSP nonce from an existing script tag so dynamically injected scripts pass CSP. */
const getCspNonce = (): string | null => {
  const el = document.querySelector<HTMLScriptElement>("script[nonce]");
  return el?.nonce || el?.getAttribute("nonce") || null;
};

/** Guard to prevent cascading reloads. */
let reloadScheduled = false;
const safeReload = () => {
  if (reloadScheduled) return;
  reloadScheduled = true;
  window.location.reload();
};

const umdApps = {
  "@org/playground-vanilla": {
    url: "//localhost:9008/org-playground-vanilla.js",
    global: "playgroundVanilla",
  },
  "@org/dashboard-vue": {
    url: "//localhost:9004/dashboard-vue.js",
    global: "dashboardVue",
  },
} as const;

const umdLoads = new Map<string, Promise<void>>();

const isLocalhost = ["localhost", "127.0.0.1"].includes(window.location.hostname)
  || window.location.hostname.endsWith(".devtunnels.ms");

const resolveImportMapUrl = (name: string): string | null => {
  try {
    const systemAny = (window as any).System;
    if (systemAny && typeof systemAny.resolve === "function") {
      const resolved = systemAny.resolve(name);
      return typeof resolved === "string" ? resolved : null;
    }
  } catch {
    // Ignore and fall through to null; caller can use another strategy.
  }
  return null;
};

/** Toggle endpoint: always use same-origin API route. */
const toggleUrl = "/api/mfe-toggle";
const localAppUrls: Record<string, string> = {
  "@org/header-react": "http://localhost:9012/org-header-react.js",
  "@org/footer-react": "http://localhost:9013/org-footer-react.js",
  "@org/mfe-kahoot-mini-react": "http://localhost:19113/org-mfe-kahoot-mini-react.js",
  "@org/mfe-mgn-kahoot-mini-react": "http://localhost:19114/org-mfe-mgn-kahoot-mini-react.js",
  "@org/vr-res-react": "http://localhost:9014/org-vr-res-react.js",
  "@org/mfe-hero-discovery": "http://localhost:9017/org-mfe-hero-discovery.js",
  "@org/dashboard-vue": "http://localhost:9004/dashboard-vue.js",
  "@org/mfe-budget-plans": "http://localhost:9016/org-mfe-budget-plans.js",
  "@org/auth-angular": "http://localhost:9010/main.js",
  "@org/playground-angular": "http://localhost:9005/main.js",
  "@org/playground-vue": "http://localhost:9006/playground-vue.js",
  "@org/playground-react": "http://localhost:9007/org-playground.js",
  "@org/playground-vanilla": "http://localhost:9008/org-playground-vanilla.js",
  "@org/playground-svelte": "http://localhost:9011/org-playground-svelte.js",
};

const AUTH_LOGIN_PATH = "/auth/login";
const AUTH_RETURN_PARAM = "returnTo";
const AUTH_REQUIRED_PREFIXES = [
  "/budget-plans",
  "/playground-angular",
  "/playground-react",
  "/playground-vue",
  "/playground-vanilla",
  "/playground-svelte",
];
const ALWAYS_ON_APPS = new Set<string>();

type DisabledMode = "hide" | "placeholder";
type DisabledModeConfig =
  | DisabledMode
  | {
      default?: DisabledMode;
      apps?: Record<string, DisabledMode>;
    };
type ToggleState = {
  disabled: string[];
  disabledMode?: { default: DisabledMode; apps: Record<string, DisabledMode> };
};

const sanitizeDisabledApps = (names: Iterable<string>) =>
  new Set(Array.from(names).filter((name) => !ALWAYS_ON_APPS.has(name)));

const normalizeDisabledModeConfig = (
  value: unknown
): ToggleState["disabledMode"] | undefined => {
  if (value === "hide" || value === "placeholder") {
    return { default: value, apps: {} };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const input = value as { default?: unknown; apps?: Record<string, unknown> };
  const apps: Record<string, DisabledMode> = {};
  if (input.apps && typeof input.apps === "object" && !Array.isArray(input.apps)) {
    Object.entries(input.apps)
      .sort(([a], [b]) => a.localeCompare(b))
      .forEach(([name, mode]) => {
        if (mode === "hide" || mode === "placeholder") {
          apps[name] = mode;
        }
      });
  }
  const defaultMode =
    input.default === "hide" || input.default === "placeholder"
      ? input.default
      : "hide";
  return { default: defaultMode, apps };
};

const getDisabledApps = () => {
  try {
    const raw = window.localStorage.getItem("mfe-disabled");
    if (!raw) {
      return new Set<string>();
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return new Set<string>();
    }
    return sanitizeDisabledApps(
      parsed.filter((name): name is string => typeof name === "string")
    );
  } catch {
    return new Set<string>();
  }
};

const getServerToggleState = (): Promise<ToggleState> => {
  return fetch(toggleUrl, { cache: "no-store" })
    .then((res) => (res.ok ? res.json() : { disabled: [] }))
    .then((data) => {
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return { disabled: [] };
      }
      const disabled = Array.isArray(data.disabled)
        ? Array.from(
            sanitizeDisabledApps(
              data.disabled.filter((name: unknown): name is string => typeof name === "string")
            )
          )
        : [];
      const disabledMode = normalizeDisabledModeConfig(
        (data as { disabledMode?: DisabledModeConfig }).disabledMode
      );
      return disabledMode ? { disabled, disabledMode } : { disabled };
    })
    .catch(() => ({ disabled: [] }));
};

const emitDisabledApps = (
  serverDisabledApps: Set<string>,
  localDisabledApps: Set<string>,
  serverDisabledMode?: ToggleState["disabledMode"]
) => {
  const safeServerDisabledApps = sanitizeDisabledApps(serverDisabledApps);
  const safeLocalDisabledApps = sanitizeDisabledApps(localDisabledApps);
  window.__mfeServerDisabled = Array.from(safeServerDisabledApps);
  window.__mfeDisabledMode = serverDisabledMode;
  if (serverDisabledMode) {
    try {
      window.localStorage.setItem("mfe-disabled-mode", JSON.stringify(serverDisabledMode));
    } catch {
      // ignore storage errors
    }
  }
  const disabledApps = sanitizeDisabledApps([
    ...Array.from(safeServerDisabledApps),
    ...Array.from(safeLocalDisabledApps),
  ]);
  window.dispatchEvent(
    new CustomEvent("mfe-toggle", {
      detail: {
        disabled: Array.from(disabledApps),
        disabledMode: serverDisabledMode,
      },
    })
  );
};

const isUrlAvailable = (url: string, timeoutMs = 700) => {
  // Validate URL protocol to prevent SSRF via unexpected schemes
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return Promise.resolve(false);
    }
  } catch {
    return Promise.resolve(false);
  }
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { method: "HEAD", mode: "no-cors", signal: controller.signal })
    .then((res) => res.ok || res.type === "opaque")
    .catch(() => false)
    .finally(() => window.clearTimeout(timeout));
};

const AVAILABILITY_CACHE_KEY = "mfe-availability-cache";
const AVAILABILITY_CACHE_TTL = 30000;

const readAvailabilityCache = () => {
  try {
    const raw = window.sessionStorage.getItem(AVAILABILITY_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const { timestamp, available, disabled, disabledMode } = parsed as {
      timestamp?: number;
      available?: string[];
      disabled?: string[];
      disabledMode?: ToggleState["disabledMode"];
    };
    if (typeof timestamp !== "number" || Date.now() - timestamp > AVAILABILITY_CACHE_TTL) {
      return null;
    }
    // Strictly filter to string-only values to prevent prototype pollution
    const safeAvailable = Array.isArray(available)
      ? available.filter((v): v is string => typeof v === "string")
      : [];
    const safeDisabled = Array.isArray(disabled)
      ? disabled.filter((v): v is string => typeof v === "string")
      : [];
    return {
      available: new Set(safeAvailable),
      disabled: new Set(safeDisabled),
      disabledMode: normalizeDisabledModeConfig(disabledMode),
    };
  } catch {
    return null;
  }
};

const writeAvailabilityCache = (
  available: Set<string>,
  disabled: Set<string>,
  disabledMode?: ToggleState["disabledMode"]
) => {
  try {
    window.sessionStorage.setItem(
      AVAILABILITY_CACHE_KEY,
      JSON.stringify({
        timestamp: Date.now(),
        available: Array.from(available),
        disabled: Array.from(disabled),
        disabledMode,
      })
    );
  } catch {
    // ignore
  }
};

const normalizePath = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed.length ? trimmed : "/";
};

const isAuthPath = (path: string) => normalizePath(path).startsWith("/auth");

const isProtectedPath = (path: string) => {
  const normalized = normalizePath(path);
  return AUTH_REQUIRED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
};

const buildLoginUrl = (returnTo: string) => {
  const url = new URL(AUTH_LOGIN_PATH, window.location.origin);
  url.searchParams.set(AUTH_RETURN_PARAM, returnTo);
  return `${url.pathname}${url.search}`;
};

const loadUmdScript = (url: string) => {
  const cacheKey = isLocalhost ? `${url}?t=${Date.now()}` : url;
  const cached = umdLoads.get(cacheKey);
  if (cached) {
    return cached;
  }

  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = cacheKey;
    if (!isLocalhost) {
      script.crossOrigin = "anonymous";
    }
    const nonce = getCspNonce();
    if (nonce) {
      script.nonce = nonce;
    }
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      script.remove();
      reject(new Error(`Failed to load ${escapeHtml(url)}`));
    };
    document.head.appendChild(script);
  });

  const trackedPromise = promise.catch((error) => {
    // Allow retries after transient failures (dev servers/HMR restarts).
    umdLoads.delete(cacheKey);
    throw error;
  });

  umdLoads.set(cacheKey, trackedPromise);
  return trackedPromise;
};

type ModuleFormat = "system" | "esm" | "umd" | "unknown";
const MODULE_FORMAT_CACHE_KEY = "mfe-module-format-cache";

/** Hydrate the in-memory format cache from sessionStorage so a full page reload
 * doesn't repeat the format-detection round-trip for every lazy app. Only stable
 * formats are persisted ("unknown" is never cached). */
const loadPersistedModuleFormats = (): Map<string, ModuleFormat> => {
  const map = new Map<string, ModuleFormat>();
  try {
    const raw = window.sessionStorage.getItem(MODULE_FORMAT_CACHE_KEY);
    if (!raw) return map;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return map;
    Object.entries(parsed).forEach(([url, format]) => {
      if (format === "system" || format === "esm" || format === "umd") {
        map.set(url, format);
      }
    });
  } catch {
    // ignore malformed cache
  }
  return map;
};

const moduleFormatCache = loadPersistedModuleFormats();

const persistModuleFormat = (url: string, format: ModuleFormat) => {
  if (format === "unknown") return;
  try {
    const obj: Record<string, ModuleFormat> = {};
    moduleFormatCache.forEach((value, key) => {
      if (value !== "unknown") obj[key] = value;
    });
    obj[url] = format;
    window.sessionStorage.setItem(MODULE_FORMAT_CACHE_KEY, JSON.stringify(obj));
  } catch {
    // ignore storage quota/serialization errors
  }
};

const withCacheBust = (url: string) =>
  isLocalhost ? `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}` : url;

const fetchWithTimeout = (input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 2500) => {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  return fetch(input, { ...init, signal: controller.signal }).finally(() => {
    window.clearTimeout(timeoutId);
  });
};

/**
 * Detect the module format of a remote bundle.
 * Uses a Range request to fetch only the first 8 KB instead of the entire file,
 * which drastically reduces bandwidth for large bundles.
 * Falls back to a full fetch if the server does not support Range requests.
 */
const detectModuleFormat = (url: string) => {
  const cached = moduleFormatCache.get(url);
  if (cached) return Promise.resolve(cached);

  const bustUrl = withCacheBust(url);

  const analyzeSource = (head: string, tail: string, full?: string): ModuleFormat => {
    const hasSystemRegister =
      /^\s*(?:(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*(?:"use strict";\s*)?System\.register\(/.test(
        head
      );
    if (hasSystemRegister) return "system";

    const hasUmdWrapper =
      /typeof exports/.test(head) &&
      /define\.amd/.test(head) &&
      /module\.exports|exports\[/.test(head);
    if (hasUmdWrapper) return "umd";

    const source = full ?? head;
    const hasEsmSyntax =
      /^\s*(import|export)\s/m.test(source) ||
      source.includes("\nexport{") ||
      source.includes("\nexport {") ||
      tail.includes("export{") ||
      tail.includes("export {");
    if (hasEsmSyntax) return "esm";

    return "unknown";
  };

  // Try Range request first (only 8 KB)
  return fetchWithTimeout(bustUrl, {
    cache: "no-store",
    headers: { Range: "bytes=0-8191" },
  }, isLocalhost ? 1200 : 3000)
    .then((res) => {
      // 206 = partial content (Range supported), 200 = server ignored Range
      if (!res.ok && res.status !== 206) return "unknown" as ModuleFormat;

      if (res.status === 206) {
        // We only have the first 8 KB — enough for System.register & UMD detection.
        // ESM detection on tail is skipped but we handle that in the "unknown" fallback path.
        return res.text().then((head) => {
          const format = analyzeSource(head, "");
          if (format !== "unknown") {
            moduleFormatCache.set(url, format);
            persistModuleFormat(url, format);
            return format;
          }
          // If still unknown (might be ESM with exports at the end), do full fetch
          return fetchWithTimeout(bustUrl, { cache: "no-store" }, isLocalhost ? 2200 : 5000)
            .then((r) => (r.ok ? r.text() : ""))
            .then((full) => {
              const tail = full.slice(-4096);
              const fmt = analyzeSource(full.slice(0, 8192), tail, full);
              moduleFormatCache.set(url, fmt);
              persistModuleFormat(url, fmt);
              return fmt;
            });
        });
      }

      // Server returned 200 (full content) — analyse directly
      return res.text().then((source) => {
        const head = source.slice(0, 8192);
        const tail = source.slice(-4096);
        const format = analyzeSource(head, tail, source);
        moduleFormatCache.set(url, format);
        persistModuleFormat(url, format);
        return format;
      });
    })
    .catch(() => "unknown" as const);
};

const importByUrl = (url: string) => import(/* webpackIgnore: true */ url) as Promise<any>;
const systemImportByUrl = (url: string) =>
  window.System?.import
    ? (window.System.import(url) as Promise<any>)
    : importByUrl(url);

const createUnavailableApp = (name: string) => ({
  bootstrap: () => Promise.resolve(),
  mount: () => Promise.resolve(),
  unmount: () => Promise.resolve(),
});

/**
 * Keep disabled apps in the layout tree (so maintenance placeholders can render),
 * but short-circuit their runtime loading to no-op lifecycles.
 */
const runtimeDisabledApps = new Set<string>();
const setRuntimeDisabledApps = (disabled: Set<string>) => {
  runtimeDisabledApps.clear();
  disabled.forEach((name) => {
    if (!ALWAYS_ON_APPS.has(name)) {
      runtimeDisabledApps.add(name);
    }
  });
};


const watchServerToggle = () => {
  let last = "";
  let timer: number | null = null;
  let inFlight = false;
  const intervalMs = 5000;
  const hiddenIntervalMs = 15000;
  let applyState: ((nextState: ToggleState) => void) | null = null;

  const schedule = (ms: number) => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(poll, ms);
  };

  const poll = () => {
    if (inFlight) {
      schedule(intervalMs);
      return;
    }
    if (document.hidden) {
      schedule(hiddenIntervalMs);
      return;
    }
    inFlight = true;
    fetchWithTimeout(toggleUrl, { cache: "no-store" }, 1800)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data || typeof data !== "object") return;
        const next = JSON.stringify(data);
        if (last && next !== last && applyState) {
          applyState(
            normalizeDisabledModeConfig((data as { disabledMode?: DisabledModeConfig }).disabledMode)
              ? {
                  disabled: Array.isArray((data as { disabled?: unknown }).disabled)
                    ? (data as { disabled: unknown[] }).disabled.filter(
                        (name): name is string => typeof name === "string"
                      )
                    : [],
                  disabledMode: normalizeDisabledModeConfig(
                    (data as { disabledMode?: DisabledModeConfig }).disabledMode
                  ),
                }
              : {
                  disabled: Array.isArray((data as { disabled?: unknown }).disabled)
                    ? (data as { disabled: unknown[] }).disabled.filter(
                        (name): name is string => typeof name === "string"
                      )
                    : [],
                }
          );
        }
        last = next;
      })
      .catch(() => {
        // ignore
      })
      .finally(() => {
        inFlight = false;
        schedule(intervalMs);
      });
  };

  const onVisibility = () => {
    if (!document.hidden) {
      poll();
    }
  };

  document.addEventListener("visibilitychange", onVisibility);
  return {
    start(nextApplyState: (nextState: ToggleState) => void) {
      applyState = nextApplyState;
      poll();
    },
  };
};

const watchAuthBuild = () => {
  if (!isLocalhost) return;
  const authBuildUrl = "http://localhost:9010/mfe-auth-dev.json";
  let lastBuildId: string | null = null;
  let timer: number | null = null;
  let inFlight = false;
  const intervalMs = 2000;
  const hiddenIntervalMs = 8000;

  const schedule = (ms: number) => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(poll, ms);
  };

  const poll = () => {
    if (inFlight) {
      schedule(intervalMs);
      return;
    }
    if (document.hidden) {
      schedule(hiddenIntervalMs);
      return;
    }
    inFlight = true;
    fetchWithTimeout(authBuildUrl, { cache: "no-store" }, 1200)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data || typeof data !== "object") return;
        const raw = data.buildId;
        const next =
          typeof raw === "number" ? String(raw) :
          typeof raw === "string" && /^\d+$/.test(raw) ? raw :
          null;
        if (!next) return;
        if (lastBuildId && next !== lastBuildId) {
          safeReload();
          return;
        }
        lastBuildId = next;
      })
      .catch(() => {
        // ignore
      })
      .finally(() => {
        inFlight = false;
        schedule(intervalMs);
      });
  };

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      poll();
    }
  });
  poll();
};

const watchLocalAvailability = () => {
  if (!isLocalhost) {
    return {
      start() {
        // no-op outside localhost
      },
    };
  }

  let timer: number | null = null;
  let inFlight = false;
  let checkAvailability: (() => void) | null = null;
  const intervalMs = 5000;
  const hiddenIntervalMs = 15000;

  const schedule = (ms: number) => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(poll, ms);
  };

  const poll = () => {
    if (!checkAvailability) return;
    if (inFlight) {
      schedule(intervalMs);
      return;
    }
    if (document.hidden) {
      schedule(hiddenIntervalMs);
      return;
    }

    inFlight = true;
    Promise.resolve()
      .then(() => checkAvailability?.())
      .finally(() => {
        inFlight = false;
        schedule(intervalMs);
      });
  };

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      poll();
    }
  });

  return {
    start(nextCheckAvailability: () => void, initialDelayMs = 0) {
      checkAvailability = nextCheckAvailability;
      if (initialDelayMs > 0) {
        // Already bootstrapped from cache: defer the first full re-probe so the
        // 14-app HEAD sweep doesn't compete with the home bundles still
        // downloading/parsing. The session cache stays valid in the meantime.
        schedule(initialDelayMs);
      } else {
        poll();
      }
    },
  };
};

const applyLayoutSection = (template: string, marker: string, content: string) => {
  const needle = `<!-- ${marker} -->`;
  if (!template.includes(needle)) return template;
  return template.split(needle).join(content.trim());
};

const microfrontendLayout = applyLayoutSection(
  [
    ["ROUTE_PLAYGROUNDS", playgroundRoutes],
    ["ROUTE_DASHBOARD", dashboardRoute],
    ["ROUTE_BUDGET_PLANS", budgetPlansRoute],
    ["ROUTE_AUTH", authRoute],
    ["ROUTE_MGN_KAHOOT_MINI", mgnKahootMiniRoute],
    ["ROUTE_DESTINATIONS", destinationsRoute],
    ["ROUTE_EXPERIENCES", experiencesRoute],
    ["ROUTE_DEFAULT", defaultRoute],
  ].reduce(
    (acc, [marker, content]) => applyLayoutSection(acc, marker, content),
    microfrontendLayoutTemplate
  ),
  "LAYOUT_HEADER",
  layoutHeader
);

// Prevent Safari from auto-scrolling on history.pushState calls (scrollRestoration
// defaults to 'auto' in WebKit, causing uncontrolled scroll jumps on SPA navigation).
if ("scrollRestoration" in history) {
  history.scrollRestoration = "manual";
}

const routes = constructRoutes(microfrontendLayout);
const systemFirstApps = new Set<string>([
  "@org/header-react",
  "@org/footer-react",
  "@org/mfe-kahoot-mini-react",
  "@org/mfe-mgn-kahoot-mini-react",
  "@org/vr-res-react",
  "@org/mfe-hero-discovery",
  "@org/mfe-budget-plans",
  "@org/playground-react",
  "@org/checkout-angular",
  "@org/auth-angular",
  "@org/playground-angular",
  "@org/playground-vue",
  "@org/playground-svelte",
]);
const forceSystemJsApps = new Set<string>([
  // Always-on shell apps and home-route apps are all built as SystemJS
  // (`System.register`) bundles. Listing them here skips the extra
  // `detectModuleFormat` round-trip so they start loading immediately —
  // most impactful for the always-on header, the first app users see.
  "@org/header-react",
  "@org/footer-react",
  "@org/mfe-kahoot-mini-react",
  "@org/mfe-mgn-kahoot-mini-react",
  "@org/vr-res-react",
  "@org/mfe-hero-discovery",
]);
const systemFirstUmdGlobals: Record<string, string> = {
  "@org/playground-vue": "playgroundVue",
};

const finalizeLoadMetrics = (name: string) => {
  if (typeof performance !== "undefined" && performance.mark) {
    performance.mark(`mfe:${name}:load:end`);
    performance.measure(`mfe:${name}:load`, `mfe:${name}:load:start`, `mfe:${name}:load:end`);
  }
};

const allApplications = constructApplications({
  routes,
  loadApp({ name }) {
    if (typeof performance !== "undefined" && performance.mark) {
      performance.mark(`mfe:${name}:load:start`);
    }
    if (runtimeDisabledApps.has(name)) {
      return Promise.resolve(createUnavailableApp(name)).finally(() => finalizeLoadMetrics(name));
    }
    if (name in umdApps) {
      const app = umdApps[name as keyof typeof umdApps];
      const localUrl = localAppUrls[name] || app.url;
      const remoteUrl = resolveImportMapUrl(name);
      const umdUrl = isLocalhost ? localUrl : (remoteUrl || app.url);
      return loadUmdScript(umdUrl)
        .then(() => wrapModuleLifecycles(name, (window as any)[app.global]))
        .catch((error) => {
          console.error(`[root-config] Failed to load UMD app ${name} from ${umdUrl}`, error);
          return createUnavailableApp(name);
        })
        .finally(() => finalizeLoadMetrics(name));
    }
    if (systemFirstApps.has(name)) {
      const localUrl = localAppUrls[name];
      const preferredImport = isLocalhost && localUrl
        ? (() => {
            const importUrl = withCacheBust(localUrl);
            if (forceSystemJsApps.has(name)) {
              return systemImportByUrl(importUrl);
            }
            return detectModuleFormat(localUrl).then((format) => {
              if (format === "system") {
                return systemImportByUrl(importUrl);
              }
              if (format === "umd") {
                return loadUmdScript(importUrl).then(() => {
                  const globalName = systemFirstUmdGlobals[name] || name;
                  const mod = (window as any)[globalName] ?? (globalThis as any)[globalName];
                  if (!mod) {
                    throw new Error(
                      `[root-config] UMD app ${name} did not expose a global (${globalName})`
                    );
                  }
                  return mod;
                });
              }
              if (format === "esm") {
                return importByUrl(importUrl);
              }
              // Unknown format (often due to dev-server Range/CORS limitations): probe UMD global first,
              // then try native import, then SystemJS as the final fallback.
              return loadUmdScript(importUrl)
                .then(() => {
                  const globalName = systemFirstUmdGlobals[name] || name;
                  const mod = (window as any)[globalName] ?? (globalThis as any)[globalName];
                  if (mod) {
                    return mod;
                  }
                  throw new Error(`[root-config] Unknown-format app ${name} did not expose UMD global`);
                })
                .catch(() => importByUrl(importUrl).catch(() => systemImportByUrl(importUrl)));
            });
          })()
        : window.System?.import
          ? (window.System.import(name) as Promise<any>)
          : (import(/* webpackIgnore: true */ name) as Promise<any>);

      return preferredImport
        .then((mod) => wrapModuleLifecycles(name, mod))
        .catch((systemError) => {
          // Fallback to native dynamic import for environments where SystemJS resolution is incomplete.
          const localUrl = localAppUrls[name];
          const urlFallback = isLocalhost && localUrl ? importByUrl(withCacheBust(localUrl)) : null;
          return (urlFallback || (import(/* webpackIgnore: true */ name) as Promise<any>))
            .then((mod) => wrapModuleLifecycles(name, mod))
            .catch((nativeError) => {
              console.error(
                `[root-config] Failed to load app ${name} via SystemJS and native import`,
                systemError,
                nativeError
              );
              return createUnavailableApp(name);
            });
        })
        .finally(() => finalizeLoadMetrics(name));
    }
    return (import(/* webpackIgnore: true */ name) as Promise<any>)
      .then((mod) => wrapModuleLifecycles(name, mod))
      .catch((error) => {
        console.error(`[root-config] Failed to load app ${name}`, error);
        return createUnavailableApp(name);
      })
      .finally(() => finalizeLoadMetrics(name));
  },
});

const wrapModuleLifecycles = (appName: string, mod: any) => {
  const wrapLifecycle = (
    phase: "bootstrap" | "mount" | "unmount",
    lifecycle: any
  ) => {
    if (!lifecycle) return lifecycle;
    const wrapFn = (fn: any) => {
      return (...args: any[]) => {
        if (typeof performance !== "undefined" && performance.mark) {
          performance.mark(`mfe:${appName}:${phase}:start`);
        }
        return Promise.resolve()
          .then(() => (typeof fn === "function" ? fn(...args) : fn))
          .finally(() => {
            if (typeof performance !== "undefined" && performance.mark) {
              performance.mark(`mfe:${appName}:${phase}:end`);
              performance.measure(
                `mfe:${appName}:${phase}`,
                `mfe:${appName}:${phase}:start`,
                `mfe:${appName}:${phase}:end`
              );
            }
          });
      };
    };
    if (Array.isArray(lifecycle)) {
      return lifecycle.map((fn) => wrapFn(fn));
    }
    return wrapFn(lifecycle);
  };

  return {
    ...mod,
    bootstrap: wrapLifecycle("bootstrap", mod.bootstrap),
    mount: wrapLifecycle("mount", mod.mount),
    unmount: wrapLifecycle("unmount", mod.unmount),
  };
};


const bootstrap = () => {
  initRootConfigShellUi();
  initAuthUserSync({ endpoint: AUTH_ME_ENDPOINT });
  watchAuthBuild();
  let lastLoggedKey = "";
  const logAuthUser = () => {
    const user = getCurrentUser();
    if (!user) return false;
    const key =
      user.id ||
      user.email ||
      user.displayName ||
      user.name ||
      JSON.stringify(user);
    if (key === lastLoggedKey) return true;
    lastLoggedKey = key;
    console.log("[auth/me] user", user);
    return true;
  };
  const logAuthUserWhenReady = () => {
    if (logAuthUser()) return;
    void fetchCurrentUserCached({ endpoint: AUTH_ME_ENDPOINT, force: true, clearOnUnauthorized: false })
      .then(() => logAuthUser())
      .catch(() => undefined);
    let attempts = 0;
    const maxAttempts = 10;
    const timer = window.setInterval(() => {
      attempts += 1;
      if (logAuthUser() || attempts >= maxAttempts) {
        window.clearInterval(timer);
      }
    }, 400);
  };
  logAuthUserWhenReady();
  const getCurrentPath = () =>
    `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const getPathFromUrl = (url: string) => {
    const parsed = new URL(url, window.location.origin);
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  };
  let pendingAuthRedirectPath: string | null = null;
  const redirectToLogin = (returnTo: string) => {
    const nextPath = buildLoginUrl(returnTo);
    if (getCurrentPath() === nextPath || pendingAuthRedirectPath === nextPath) {
      return;
    }
    pendingAuthRedirectPath = nextPath;
    navigateToUrl(nextPath);
  };
  const ensureAuthForPath = (path: string) => {
    if (isAuthenticated()) return;
    if (isAuthPath(path)) return;
    if (!isProtectedPath(path)) return;
    redirectToLogin(path);
  };

  ensureAuthForPath(getCurrentPath());
  window.addEventListener("single-spa:before-routing-event", (event) => {
    const detail = (event as CustomEvent<{ newUrl?: string }>).detail;
    if (detail?.newUrl) {
      ensureAuthForPath(getPathFromUrl(detail.newUrl));
      return;
    }
    ensureAuthForPath(getCurrentPath());
  });
  subscribeAuthChange(() => {
    logAuthUser();
    if (isAuthenticated()) {
      pendingAuthRedirectPath = null;
      return;
    }
    if (!isAuthenticated()) {
      ensureAuthForPath(getCurrentPath());
    }
  });

  const baseTitle: Record<Locale, string> = {
    en: "Vtourist · Travel Social Network",
    vi: "Vtourist · Mạng xã hội du lịch",
  };
  const sectionTitleMap: Record<string, Record<Locale, string>> = {
    "/budget-plans": { en: "Budget Plans", vi: "Kế hoạch chi tiêu" },
    "/playground-angular": { en: "Playground Angular", vi: "Playground Angular" },
    "/playground-react": { en: "Playground React", vi: "Playground React" },
    "/playground-vue": { en: "Playground Vue", vi: "Playground Vue" },
    "/playground-vanilla": { en: "Playground Vanilla", vi: "Playground Vanilla" },
    "/playground-svelte": { en: "Playground Svelte", vi: "Playground Svelte" },
    "/dashboard": { en: "Dashboard", vi: "Bảng điều khiển" },
  };
  const resolveTitleLocale = (): Locale => {
    const current = getStoredLocale();
    return current === "vi" ? "vi" : "en";
  };
  const setTitleForPath = () => {
    const locale = resolveTitleLocale();
    const base = baseTitle[locale];
    const path = window.location.pathname.replace(/\/+$/, "");
    const section = sectionTitleMap[path];
    if (section) {
      document.title = `${section[locale]} · ${base}`;
      return;
    }
    // Let microfrontends manage their own titles when no shell title is mapped.
    const knownTitles = new Set([baseTitle.en, baseTitle.vi]);
    if (!document.title || knownTitles.has(document.title)) {
      document.title = base;
    }
  };
  window.addEventListener("single-spa:routing-event", setTitleForPath);
  window.addEventListener("single-spa:routing-event", () => {
    if (pendingAuthRedirectPath && getCurrentPath() === pendingAuthRedirectPath) {
      pendingAuthRedirectPath = null;
    }
  });
  window.addEventListener("popstate", setTitleForPath);
  setTitleForPath();

  // Scroll to top on SPA route change, but only when the pathname actually
  // changes (not for hash-only updates or same-path re-renders). Using
  // 'instant' avoids the smooth-scroll animation fighting with page transitions
  // and is required for correct Safari behavior after scrollRestoration='manual'.
  let _prevScrollPathname = window.location.pathname;
  window.addEventListener("single-spa:routing-event", () => {
    const next = window.location.pathname;
    if (next !== _prevScrollPathname) {
      const previous = _prevScrollPathname;
      _prevScrollPathname = next;
      const isVrResDetailTransition = previous.startsWith("/destinations/") || next.startsWith("/destinations/");
      const hasVrResScrollState = Boolean(history.state && typeof history.state === "object" && "vr-res:list-scroll-y" in history.state);
      // The header's "Đăng trải nghiệm" overlay lives on /experiences and is a
      // full-screen portal; keep the underlying page's scroll position intact
      // when it opens or closes.
      const isExperiencesTransition = previous.startsWith("/experiences") || next.startsWith("/experiences");
      if (isVrResDetailTransition || hasVrResScrollState || isExperiencesTransition) return;
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    }
  });

  const localeToggleButton = document.getElementById("ds-locale-toggle") as HTMLButtonElement | null;
  const getNextLocale = (locale: Locale): Locale => (locale === "en" ? "vi" : "en");
  const applyLocaleToggleButton = (locale: Locale) => {
    if (!localeToggleButton) return;
    const nextLocale = getNextLocale(locale);
    const label =
      nextLocale === "vi"
        ? "Switch language to Vietnamese"
        : "Chuyển ngôn ngữ sang tiếng Anh";
    localeToggleButton.textContent = locale.toUpperCase();
    localeToggleButton.setAttribute("data-locale-current", locale);
    localeToggleButton.setAttribute("data-locale-next", nextLocale);
    localeToggleButton.setAttribute("aria-label", label);
    localeToggleButton.setAttribute("title", label);
  };
  const applyLocale = (locale: Locale) => {
    setLocale(locale);
    document.documentElement.setAttribute("lang", locale);
    applyLocaleToggleButton(locale);
    applyI18nToDom(document);
    setTitleForPath();
  };
  const initialLocale = initI18nFromStorage();
  applyLocale(initialLocale);
  localeToggleButton?.addEventListener("click", () => {
    const currentLocale =
      (localeToggleButton.getAttribute("data-locale-current") as Locale | null) ||
      getStoredLocale();
    const nextLocale = getNextLocale(currentLocale);
    setStoredLocale(nextLocale, true);
    applyLocale(nextLocale);
  });
  window.addEventListener("app-locale-change", (event) => {
    const detail = (event as CustomEvent<{ locale?: Locale }>).detail;
    if (!detail?.locale) return;
    applyLocale(detail.locale);
  });
  window.addEventListener("storage", (event) => {
    if (event.key === "app-locale") {
      applyLocale(getStoredLocale());
    }
  });
  const scheduleI18n = (() => {
    let raf = 0;
    let running = false;
    return () => {
      if (running) return;
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        running = true;
        try {
          applyI18nToDom(document);
        } finally {
          running = false;
        }
      });
    };
  })();
  let i18nObserverScheduled = false;
  const i18nObserver = new MutationObserver(() => {
    if (i18nObserverScheduled) return;
    i18nObserverScheduled = true;
    requestAnimationFrame(() => {
      i18nObserverScheduled = false;
      scheduleI18n();
    });
  });
  i18nObserver.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("single-spa:app-change", scheduleI18n);

  const failedApps = new Set<string>();
  let currentAvailableApps: Set<string> | null = null;
  const emitAvailability = (available: Set<string>) => {
    window.dispatchEvent(
      new CustomEvent("mfe-availability", {
        detail: { available: Array.from(available) },
      })
    );
  };
  addErrorHandler((err) => {
    const appName =
      (err as any)?.appOrParcelName ||
      (err as any)?.appName ||
      (err as any)?.application?.name;
    if (!appName || failedApps.has(appName)) return;
    failedApps.add(appName);
    window.dispatchEvent(
      new CustomEvent("mfe-error", {
        detail: {
          name: appName,
          message: (err as any)?.message || "Module failed to load",
        },
      })
    );
    if (currentAvailableApps && currentAvailableApps.has(appName)) {
      currentAvailableApps.delete(appName);
      emitAvailability(currentAvailableApps);
    }
  });
  const setThemeMode = (mode: "light" | "dark", target = document.documentElement) => {
    const current = target.getAttribute("data-theme") === "dark" ? "dark" : "light";
    if (current === mode) return;
    if (mode === "dark") {
      target.setAttribute("data-theme", "dark");
    } else {
      target.removeAttribute("data-theme");
    }
  };
  const getSavedTheme = (storageKey = "ds-theme") => {
    if (typeof window === "undefined") return null;
    const saved = window.localStorage.getItem(storageKey);
    return saved === "dark" || saved === "light" ? saved : null;
  };
  const applySystemTheme = (target = document.documentElement, storageKey = "ds-theme") => {
    if (typeof window === "undefined") return;
    if (getSavedTheme(storageKey)) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => setThemeMode(media.matches ? "dark" : "light", target);
    apply();
    media.addEventListener?.("change", apply);
  };
  const persistThemeMode = (storageKey = "ds-theme", target = document.documentElement) => {
    if (typeof window === "undefined") return;
    const saved = getSavedTheme(storageKey);
    if (saved) {
      setThemeMode(saved, target);
    }
    const observer = new MutationObserver(() => {
      const mode = target.getAttribute("data-theme") === "dark" ? "dark" : "light";
      window.localStorage.setItem(storageKey, mode);
    });
    observer.observe(target, { attributes: true, attributeFilter: ["data-theme"] });
  };
  applySystemTheme();
  persistThemeMode();
  let applications = allApplications;
  const isAuthBootstrapPath = isAuthPath(window.location.pathname || "/");
  const localDisabledApps = getDisabledApps();
  const applyToggleState = (serverToggle: ToggleState) => {
    const latestLocalDisabledApps = getDisabledApps();
    const serverDisabledApps = new Set<string>(
      (serverToggle.disabled || []).filter((name): name is string => typeof name === "string")
    );
    const disabledApps = sanitizeDisabledApps([
      ...Array.from(serverDisabledApps),
      ...Array.from(latestLocalDisabledApps),
    ]);
    setRuntimeDisabledApps(disabledApps);
    emitDisabledApps(serverDisabledApps, latestLocalDisabledApps, serverToggle.disabledMode);
  };
  const serverToggleWatcher = watchServerToggle();
  const localAvailabilityWatcher = watchLocalAvailability();
  let hasBootstrappedLocalApps = false;
  let lastAvailabilitySnapshot: {
    available: Set<string>;
    disabled: Set<string>;
    disabledMode?: ToggleState["disabledMode"];
  } | null = null;

  const rememberAvailabilitySnapshot = (
    available: Set<string>,
    disabled: Set<string>,
    disabledMode?: ToggleState["disabledMode"]
  ) => {
    lastAvailabilitySnapshot = {
      available: new Set(available),
      disabled: new Set(disabled),
      disabledMode,
    };
  };

  const availabilitySnapshotChanged = (
    available: Set<string>,
    disabled: Set<string>,
    disabledMode?: ToggleState["disabledMode"]
  ) => {
    if (!lastAvailabilitySnapshot) return true;

    return (
      lastAvailabilitySnapshot.available.size !== available.size ||
      lastAvailabilitySnapshot.disabled.size !== disabled.size ||
      JSON.stringify(lastAvailabilitySnapshot.disabledMode || null) !==
        JSON.stringify(disabledMode || null) ||
      Array.from(lastAvailabilitySnapshot.available).some((name) => !available.has(name)) ||
      Array.from(lastAvailabilitySnapshot.disabled).some((name) => !disabled.has(name))
    );
  };

  // Cross-tab sync: listen for mfe-disabled changes from other tabs (e.g. status.html)
  // so that toggling a module in the status page triggers an immediate reload.
  // Must be registered on ALL environments (localhost + production).
  window.addEventListener("storage", (event) => {
    if (event.key === "mfe-disabled" || event.key === "mfe-disabled-mode") {
      if (isLocalhost) {
        safeReload();
        return;
      }
      void getServerToggleState().then(applyToggleState);
    }
  });
  try {
    const bc = new BroadcastChannel("mfe-disabled-sync");
    bc.onmessage = (event) => {
      const data = event.data;
      if (
        data &&
        typeof data === "object" &&
        (data.type === "mfe-toggle" || data.type === "mfe-disabled-mode")
      ) {
        if (isLocalhost) {
          safeReload();
          return;
        }
        void getServerToggleState().then(applyToggleState);
      }
    };
  } catch {
    // BroadcastChannel not supported — storage event is the fallback
  }

  if (!isLocalhost) {
    // Do not put the serverless toggle endpoint on the production critical
    // path. The shell and route bundles can start loading immediately while
    // the latest toggle state is refreshed in parallel.
    setRuntimeDisabledApps(localDisabledApps);
    emitDisabledApps(new Set<string>(), localDisabledApps);
    applications = allApplications;
    const layoutEngine = constructLayoutEngine({ routes, applications });
    applications.forEach((app) => registerApplication(app));
    layoutEngine.activate();
    start();

    getServerToggleState().then((serverToggle) => {
      const serverDisabledApps = (serverToggle.disabled || []).filter(
        (name): name is string => typeof name === "string"
      );
      const disabledApps = sanitizeDisabledApps([
        ...Array.from(localDisabledApps),
        ...serverDisabledApps,
      ]);
      setRuntimeDisabledApps(disabledApps);
      emitDisabledApps(
        new Set(serverDisabledApps),
        localDisabledApps,
        serverToggle.disabledMode
      );
      serverToggleWatcher.start(applyToggleState);
    });
    return;
  }

  if (isAuthBootstrapPath) {
    getServerToggleState().then((serverToggle) => {
      const serverDisabledApps = new Set<string>(
        (serverToggle.disabled || []).filter((name): name is string => typeof name === "string")
      );
      const disabledApps = sanitizeDisabledApps([
        ...Array.from(serverDisabledApps),
        ...Array.from(localDisabledApps),
      ]);
      setRuntimeDisabledApps(disabledApps);
      emitDisabledApps(serverDisabledApps, localDisabledApps, serverToggle.disabledMode);
      currentAvailableApps = null;
      applications = allApplications;
      const layoutEngine = constructLayoutEngine({ routes, applications });
      applications.forEach((app) => registerApplication(app));
      layoutEngine.activate();
      start();
      serverToggleWatcher.start(applyToggleState);
    });
    return;
  }

  const cached = readAvailabilityCache();
  if (cached) {
    const localDisabledApps = getDisabledApps();
    const disabledApps = sanitizeDisabledApps([
      ...Array.from(cached.disabled),
      ...Array.from(localDisabledApps),
    ]);
    setRuntimeDisabledApps(disabledApps);
    currentAvailableApps = cached.available;
    emitAvailability(cached.available);
    emitDisabledApps(cached.disabled, localDisabledApps, cached.disabledMode);
    applications = allApplications.filter(
      (app) =>
        ALWAYS_ON_APPS.has(app.name) ||
        cached.available.has(app.name)
    );
    const layoutEngine = constructLayoutEngine({ routes, applications });
    applications.forEach((app) => registerApplication(app));
    layoutEngine.activate();
    start();
    hasBootstrappedLocalApps = true;
    rememberAvailabilitySnapshot(cached.available, cached.disabled, cached.disabledMode);
    serverToggleWatcher.start(applyToggleState);
  }

  const runAvailabilityCheck = () => {
    Promise.all([
      Promise.all(
        Object.entries(localAppUrls).map(([name, url]) => {
          return isUrlAvailable(url).then((ok) => [name, ok] as const);
        })
      ),
      getServerToggleState(),
    ]).then(([availability, serverToggle]) => {
      const localDisabledApps = getDisabledApps();
      const availableApps = new Set(availability.filter(([, ok]) => ok).map(([name]) => name));
      const serverDisabledApps = new Set<string>(
        (serverToggle.disabled || []).filter((name): name is string => typeof name === "string")
      );
      const disabledApps = sanitizeDisabledApps([
        ...Array.from(serverDisabledApps),
        ...Array.from(localDisabledApps),
      ]);
      setRuntimeDisabledApps(disabledApps);
      writeAvailabilityCache(availableApps, serverDisabledApps, serverToggle.disabledMode);
      currentAvailableApps = availableApps;
      emitAvailability(availableApps);
      emitDisabledApps(serverDisabledApps, localDisabledApps, serverToggle.disabledMode);
      if (!hasBootstrappedLocalApps) {
        applications = allApplications.filter(
          (app) =>
            ALWAYS_ON_APPS.has(app.name) ||
            availableApps.has(app.name)
        );
        const layoutEngine = constructLayoutEngine({ routes, applications });
        applications.forEach((app) => registerApplication(app));
        layoutEngine.activate();
        start();
        hasBootstrappedLocalApps = true;
        rememberAvailabilitySnapshot(availableApps, serverDisabledApps, serverToggle.disabledMode);
        serverToggleWatcher.start(applyToggleState);
        return;
      }
      if (availabilitySnapshotChanged(availableApps, serverDisabledApps, serverToggle.disabledMode)) {
        rememberAvailabilitySnapshot(availableApps, serverDisabledApps, serverToggle.disabledMode);
        safeReload();
      }
    });
  };

  // Cross-tab sync listeners are now registered before the isLocalhost branch
  // (at the top of bootstrap) so they work on all environments.

  // When we already bootstrapped from the session availability cache, defer the
  // first full re-probe so it doesn't contend with the home bundles loading.
  // On a cold start (no cache) the probe must run immediately to bootstrap.
  localAvailabilityWatcher.start(
    runAvailabilityCheck,
    hasBootstrappedLocalApps ? 2500 : 0
  );
};

bootstrap();
