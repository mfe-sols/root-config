import { navigateToUrl } from "single-spa";
import {
  getCurrentUser,
  isAuthenticated,
  subscribeAuthChange,
  writeAuthState,
} from "@mfe-sols/auth";

/** Escape HTML special chars to prevent XSS when building DOM strings. */
const escapeHtml = (str: string) =>
  str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Validate a URL string is safe (http/https or data:image for profile photos). */
const isSafeUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

const shellInitFlag = "__rootConfigShellUiInit";
const DISABLED_MODE_KEY = "mfe-disabled-mode";

const AUTH_REQUIRED_APPS = new Set([
  "@org/playground-angular",
  "@org/playground-react",
  "@org/playground-vue",
  "@org/playground-vanilla",
  "@org/playground-svelte",
]);
const ALWAYS_VISIBLE_APPS = new Set<string>();

type DisabledList = string[];

type PerfConfig = {
  position?: "bottom-left" | "bottom-right";
  draggable?: boolean;
  persist?: boolean;
};

declare global {
  interface Window {
    __rootConfigShellUiInit?: boolean;
    __perfPanelConfig?: PerfConfig;
    __mfeServerDisabled?: string[];
    __mfeDisabledMode?: DisabledModeConfig;
  }
}

const getElements = <T extends Element>(selector: string) =>
  Array.from(document.querySelectorAll<T>(selector));

const getAppName = (app: string | null) => (app ? app.replace(/^@org\//, "") : "");

type DisabledMode = "hide" | "placeholder";
type DisabledModeConfig =
  | DisabledMode
  | {
      default?: DisabledMode;
      apps?: Record<string, DisabledMode>;
    };

const DEFAULT_DISABLED_MODE_BY_APP: Partial<Record<string, DisabledMode>> = {
  "@org/header-react": "placeholder",
};

const getFallbackDisabledMode = (app: string, defaultMode?: DisabledMode): DisabledMode => {
  const appDefault = DEFAULT_DISABLED_MODE_BY_APP[app];
  if (appDefault === "hide" || appDefault === "placeholder") return appDefault;
  if (defaultMode === "hide" || defaultMode === "placeholder") return defaultMode;
  return "hide";
};

const normalizeDisabledModeConfig = (config?: DisabledModeConfig | null) => {
  if (!config) return { default: undefined, apps: {} as Record<string, DisabledMode> };
  if (config === "hide" || config === "placeholder") {
    return { default: config, apps: {} as Record<string, DisabledMode> };
  }
  const apps: Record<string, DisabledMode> = {};
  if (config.apps && typeof config.apps === "object") {
    Object.entries(config.apps).forEach(([key, value]) => {
      if (value === "hide" || value === "placeholder") {
        apps[key] = value;
      }
    });
  }
  const def = config.default === "hide" || config.default === "placeholder" ? config.default : undefined;
  return { default: def, apps };
};

const readDisabledModeConfig = (): { default?: DisabledMode; apps: Record<string, DisabledMode> } => {
  let storageConfig: DisabledModeConfig | null = null;
  try {
    const raw = window.localStorage.getItem(DISABLED_MODE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Only accept string or plain object, reject arrays and other types
      if (
        parsed === "hide" ||
        parsed === "placeholder" ||
        (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      ) {
        storageConfig = parsed as DisabledModeConfig;
      }
    }
  } catch {
    storageConfig = null;
  }
  const base = normalizeDisabledModeConfig(window.__mfeDisabledMode);
  const override = normalizeDisabledModeConfig(storageConfig);
  return {
    default: override.default ?? base.default,
    apps: { ...base.apps, ...override.apps },
  };
};

const writeDisabledModeConfig = (config: {
  default?: DisabledMode;
  apps: Record<string, DisabledMode>;
}) => {
  const normalized = normalizeDisabledModeConfig(config as DisabledModeConfig);
  const payload = {
    default: normalized.default === "placeholder" ? "placeholder" : "hide",
    apps: normalized.apps,
  };
  try {
    window.localStorage.setItem(DISABLED_MODE_KEY, JSON.stringify(payload));
  } catch {
    // ignore storage errors
  }
};

const applyIncomingDisabledModeConfig = (value: unknown) => {
  const normalized = normalizeDisabledModeConfig(
    (typeof value === "object" && value !== null && !Array.isArray(value)) ||
      value === "hide" ||
      value === "placeholder"
      ? (value as DisabledModeConfig)
      : undefined
  );
  const current = readDisabledModeConfig();
  const next = {
    default: normalized.default ?? current.default,
    apps: { ...current.apps, ...normalized.apps },
  };
  const currentKey = JSON.stringify({
    default: current.default ?? "hide",
    apps: current.apps,
  });
  const nextKey = JSON.stringify({
    default: next.default ?? "hide",
    apps: next.apps,
  });
  if (currentKey === nextKey) return;
  writeDisabledModeConfig(next);
};

const applyIncomingDisabledModeForApp = (app: unknown, mode: unknown) => {
  if (typeof app !== "string") return;
  if (mode !== "hide" && mode !== "placeholder") return;
  const current = readDisabledModeConfig();
  const next = {
    default: current.default ?? "hide",
    apps: { ...current.apps },
  };
  const fallbackMode = getFallbackDisabledMode(app, next.default);
  if (mode === fallbackMode) {
    delete next.apps[app];
  } else {
    next.apps[app] = mode;
  }
  writeDisabledModeConfig(next);
};

const resolveDisabledMode = (app: string, el: HTMLElement): DisabledMode => {
  const attr = el.getAttribute("data-disabled-mode");
  if (attr === "hide" || attr === "placeholder") return attr;
  const config = readDisabledModeConfig();
  const appMode = config.apps?.[app];
  if (appMode === "hide" || appMode === "placeholder") return appMode;
  return getFallbackDisabledMode(app, config.default);
};

const ensureBadge = (el: HTMLElement, className: string) => {
  let badge = el.querySelector<HTMLSpanElement>(`.${className}`);
  if (badge) return badge;
  badge = document.createElement("span");
  badge.className = className;
  el.appendChild(badge);
  return badge;
};

const formatMaintenanceTimestamp = () => {
  const now = new Date();
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(now);
  } catch {
    return now.toLocaleTimeString();
  }
};

const ensureMaintenancePanel = (el: HTMLElement, app: string, label?: string, detail?: string) => {
  let panel = el.querySelector<HTMLDivElement>(".app-maintenance");
  if (!panel) {
    panel = document.createElement("div");
    panel.className = "app-maintenance";
    panel.setAttribute("role", "status");
    panel.setAttribute("aria-live", "polite");
    const head = document.createElement("div");
    head.className = "app-maintenance__head";
    const pill = document.createElement("span");
    pill.className = "app-maintenance__pill";
    const appTag = document.createElement("span");
    appTag.className = "app-maintenance__app";
    head.appendChild(pill);
    head.appendChild(appTag);
    const content = document.createElement("div");
    content.className = "app-maintenance__content";
    const icon = document.createElement("span");
    icon.className = "app-maintenance__icon";
    icon.textContent = "!";
    icon.setAttribute("aria-hidden", "true");
    const copy = document.createElement("div");
    copy.className = "app-maintenance__copy";
    const title = document.createElement("div");
    title.className = "app-maintenance__title";
    const desc = document.createElement("div");
    desc.className = "app-maintenance__desc";
    const meta = document.createElement("div");
    meta.className = "app-maintenance__meta";
    const time = document.createElement("div");
    time.className = "app-maintenance__time";
    const actions = document.createElement("div");
    actions.className = "app-maintenance__actions";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "app-maintenance__btn";
    button.textContent = "Open status";
    button.setAttribute("aria-label", "Open status page");
    button.addEventListener("click", () => {
      navigateToUrl("/status.html");
    });
    copy.appendChild(title);
    copy.appendChild(desc);
    copy.appendChild(meta);
    actions.appendChild(button);
    content.appendChild(icon);
    content.appendChild(copy);
    content.appendChild(time);
    content.appendChild(actions);
    panel.appendChild(head);
    panel.appendChild(content);
    el.appendChild(panel);
  }
  const appTag = panel.querySelector<HTMLElement>(".app-maintenance__app");
  const pill = panel.querySelector<HTMLElement>(".app-maintenance__pill");
  const title = panel.querySelector<HTMLElement>(".app-maintenance__title");
  const desc = panel.querySelector<HTMLElement>(".app-maintenance__desc");
  const meta = panel.querySelector<HTMLElement>(".app-maintenance__meta");
  const time = panel.querySelector<HTMLElement>(".app-maintenance__time");
  const appTagText = `@${getAppName(app)}`;
  if (pill) {
    pill.textContent = "MAINTENANCE";
  }
  if (appTag) {
    appTag.textContent = appTagText;
  }
  if (title) {
    title.textContent = label || "Maintenance";
  }
  if (desc) {
    desc.textContent = detail || `${appTagText} is currently disabled. Please check status.`;
  }
  if (meta) {
    meta.textContent = `Service paused: ${appTagText}`;
  }
  if (time) {
    time.textContent = `Updated ${formatMaintenanceTimestamp()}`;
  }
};

const removeMaintenancePanel = (el: HTMLElement) => {
  const panel = el.querySelector(".app-maintenance");
  if (panel) {
    panel.remove();
  }
};

const hideAppContent = (el: HTMLElement) => {
  Array.from(el.children).forEach((child) => {
    if (!(child instanceof HTMLElement)) return;
    if (
      child.classList.contains("app-state-badge") ||
      child.classList.contains("app-name-badge") ||
      child.classList.contains("app-maintenance")
    ) {
      return;
    }
    if (!child.hasAttribute("data-prev-display")) {
      child.setAttribute("data-prev-display", child.style.display || "");
    }
    child.style.display = "none";
  });
};

const showAppContent = (el: HTMLElement) => {
  Array.from(el.children).forEach((child) => {
    if (!(child instanceof HTMLElement)) return;
    if (
      child.classList.contains("app-state-badge") ||
      child.classList.contains("app-name-badge") ||
      child.classList.contains("app-maintenance")
    ) {
      return;
    }
    if (child.hasAttribute("data-prev-display")) {
      const prev = child.getAttribute("data-prev-display") || "";
      child.style.display = prev;
      child.removeAttribute("data-prev-display");
    } else {
      child.style.display = "";
    }
  });
};

const normalizeDisabled = (list: unknown, knownApps: Set<string>) => {
  if (!Array.isArray(list)) return new Set<string>();
  return new Set(
    list.filter((name) => typeof name === "string" && knownApps.has(name)) as string[]
  );
};

const buildLoginUrl = (returnTo: string) => {
  if (typeof window === "undefined") return "/auth/login";
  const url = new URL("/auth/login", window.location.origin);
  url.searchParams.set("returnTo", returnTo);
  return `${url.pathname}${url.search}`;
};

const readDisabled = () => {
  const serverDisabled = Array.isArray(window.__mfeServerDisabled)
    ? window.__mfeServerDisabled.filter(
        (name) => typeof name === "string" && !ALWAYS_VISIBLE_APPS.has(name)
      )
    : [];
  try {
    const raw = window.localStorage.getItem("mfe-disabled");
    const parsed = raw ? JSON.parse(raw) : [];
    const localDisabled = Array.isArray(parsed)
      ? (parsed.filter(
          (name) => typeof name === "string" && !ALWAYS_VISIBLE_APPS.has(name)
        ) as string[])
      : [];
    if (localDisabled.length === 0 && serverDisabled.length === 0) {
      return [];
    }
    return Array.from(new Set([...localDisabled, ...serverDisabled]));
  } catch {
    return serverDisabled;
  }
};

const isTrustedOrigin = (origin: string) => {
  if (origin === window.location.origin) return true;
  // In localhost development, allow other localhost ports
  const isLocal =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1";
  if (!isLocal) return false;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(origin);
};

export const initRootConfigShellUi = () => {
  if (typeof window === "undefined") return;
  if ((window as any)[shellInitFlag]) return;
  (window as any)[shellInitFlag] = true;

  const UI = {
    themeToggle: document.getElementById("ds-theme-toggle") as HTMLButtonElement | null,
    perfFab: document.getElementById("mfe-perf-fab") as HTMLButtonElement | null,
    perfPanel: document.getElementById("mfe-perf-panel") as HTMLElement | null,
    perfList: document.getElementById("mfe-perf-list") as HTMLElement | null,
    perfRefresh: document.getElementById("mfe-perf-refresh") as HTMLButtonElement | null,
    profileWrap: document.getElementById("ds-profile") as HTMLDivElement | null,
    profileBtn: document.getElementById("ds-profile-btn") as HTMLButtonElement | null,
    profileImg: document.getElementById("ds-profile-img") as HTMLImageElement | null,
    profileInitials: document.getElementById("ds-profile-initials") as HTMLSpanElement | null,
    authLogout: document.getElementById("ds-auth-logout") as HTMLButtonElement | null,
  };

  const getAppElements = () => getElements<HTMLElement>("[data-app]");
  const getAppLinks = () => getElements<HTMLElement>("[data-app-link]");
  let appElements = getAppElements();
  let knownApps = new Set(
    appElements
      .map((el) => el.getAttribute("data-app"))
      .filter((name): name is string => Boolean(name))
  );
  let appLinks = getAppLinks();
  let appElementsKey = "";

  const refreshAppElements = () => {
    appElements = getAppElements();
    knownApps = new Set(
      appElements
        .map((el) => el.getAttribute("data-app"))
        .filter((name): name is string => Boolean(name))
    );
    appLinks = getAppLinks();
    appElementsKey = getAppElementsKey();
  };

  const getAppElementsKey = () =>
    appElements
      .map((el) => el.getAttribute("data-app") || "")
      .filter(Boolean)
      .sort()
      .join("|");

  const updatePlaygroundLinks = (disabled: DisabledList) => {
    if (!appLinks.length) return;
    const disabledSet = new Set(
      (Array.isArray(disabled) ? disabled : []).filter(
        (name) => typeof name === "string"
      )
    );
    appLinks.forEach((link) => {
      const name = link.getAttribute("data-app-link");
      if (!name) return;
      if (disabledSet.has(name)) {
        link.setAttribute("hidden", "true");
      } else {
        if (!link.hasAttribute("data-auth-hidden")) {
          link.removeAttribute("hidden");
        }
      }
    });
  };

  const updateAuthLocks = (locked: boolean) => {
    if (appLinks.length) {
      appLinks.forEach((link) => {
        const name = link.getAttribute("data-app-link");
        if (!name || !AUTH_REQUIRED_APPS.has(name)) return;
        const currentHref = link.getAttribute("href") || "/";
        if (locked) {
          const existing = link.getAttribute("data-auth-return");
          const returnTo = existing || currentHref;
          if (!existing) {
            link.setAttribute("data-auth-return", currentHref);
          }
          link.setAttribute("href", buildLoginUrl(returnTo));
          link.setAttribute("data-auth-locked", "true");
          link.setAttribute("aria-disabled", "true");
          link.setAttribute("title", "Sign in to access");
        } else {
          const original = link.getAttribute("data-auth-return");
          if (original) {
            link.setAttribute("href", original);
            link.removeAttribute("data-auth-return");
          }
          link.removeAttribute("data-auth-locked");
          link.removeAttribute("aria-disabled");
          link.removeAttribute("title");
        }
      });
    }

    if (appElements.length) {
      appElements.forEach((el) => {
        const name = el.getAttribute("data-app");
        if (!name || !AUTH_REQUIRED_APPS.has(name)) return;
        if (locked) {
          el.setAttribute("data-auth-locked", "true");
        } else {
          el.removeAttribute("data-auth-locked");
        }
      });
    }
  };

  const setAppState = (
    app: string,
    state: string | null,
    label?: string,
    detail?: string
  ) => {
    if (!app) return;
    appElements
      .filter((el) => el.getAttribute("data-app") === app)
      .forEach((el) => {
        const badge = ensureBadge(el, "app-state-badge");
        const nameBadge = ensureBadge(el, "app-name-badge");
    if (!state) {
      el.removeAttribute("data-app-state");
      el.removeAttribute("data-app-hidden");
      el.style.display = "";
      showAppContent(el);
      removeMaintenancePanel(el);
      badge.textContent = "";
      badge.removeAttribute("title");
      nameBadge.textContent = "";
      return;
    }
        el.setAttribute("data-app-state", state);
        badge.textContent = label || state;
        if (detail) {
          badge.title = detail;
        }
    const mode = resolveDisabledMode(app, el);
    el.setAttribute("data-app-hidden", "true");
    if (mode === "placeholder") {
      el.style.display = "";
      showAppContent(el);
      ensureMaintenancePanel(el, app, label, detail);
    } else {
      el.style.display = "none";
      hideAppContent(el);
      removeMaintenancePanel(el);
    }
    nameBadge.textContent = getAppName(app);
  });
};

  const applyDisabledCards = (disabled: DisabledList) => {
    const disabledSet = normalizeDisabled(disabled, knownApps);
    appElements.forEach((el) => {
      const app = el.getAttribute("data-app");
      if (!app) return;
      if (disabledSet.has(app)) {
        setAppState(app, "maintenance", "Maintenance");
      } else if (el.getAttribute("data-app-state") === "maintenance") {
        setAppState(app, null);
      }
    });
  };

  const isLocal =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1";
  let availableApps: Set<string> | null = isLocal ? new Set() : null;

  const applyCardVisibility = (disabled: DisabledList) => {
    const disabledSet = normalizeDisabled(disabled, knownApps);
    appElements.forEach((el) => {
      const app = el.getAttribute("data-app");
      const isDisabled = app ? disabledSet.has(app) : false;
      if (app && isDisabled) {
        setAppState(app, "maintenance", "Maintenance");
        return;
      }
      const isPinnedVisible = Boolean(app && ALWAYS_VISIBLE_APPS.has(app));
      const isAvailable = isPinnedVisible
        ? true
        : !isLocal || !app || !availableApps
        ? true
        : availableApps.has(app);
      if (!isAvailable) {
        el.style.display = "none";
        return;
      }
      if (app && el.getAttribute("data-app-state") === "maintenance") {
        setAppState(app, null);
      } else {
        el.style.display = "";
      }
    });
  };

  let lastDisabled: DisabledList = [];
  let lastDisabledKey = "";
  let lastDisabledModeKey = "";
  let lastAppElementsKey = "";
  const normalizeDisabledList = (list: DisabledList) => {
    const seen = new Set<string>();
    const next: string[] = [];
    list.forEach((name) => {
      if (typeof name !== "string") return;
      if (seen.has(name)) return;
      seen.add(name);
      next.push(name);
    });
    return next;
  };
  const getDisabledKey = (list: DisabledList) => JSON.stringify([...list].sort());
  const getDisabledModeKey = () => {
    const config = readDisabledModeConfig();
    const apps = Object.keys(config.apps || {})
      .sort()
      .map((key) => `${key}:${config.apps[key]}`)
      .join("|");
    return `${config.default || ""}|${apps}`;
  };
  const applyDisabledState = (disabled: DisabledList) => {
    const normalized = normalizeDisabledList(disabled);
    const nextKey = getDisabledKey(normalized);
    const modeKey = getDisabledModeKey();
    const elementsKey = appElementsKey || getAppElementsKey();
    if (
      nextKey === lastDisabledKey &&
      modeKey === lastDisabledModeKey &&
      elementsKey === lastAppElementsKey
    ) {
      return;
    }
    lastDisabledKey = nextKey;
    lastDisabledModeKey = modeKey;
    lastAppElementsKey = elementsKey;
    lastDisabled = normalized;
    applyDisabledCards(normalized);
    applyCardVisibility(normalized);
    updatePlaygroundLinks(normalized);
  };

  const applyAuthState = () => {
    const locked = !isAuthenticated();
    updateAuthLocks(locked);
    const user = getCurrentUser();
    const showProfile = !locked;
    if (UI.profileWrap) {
      if (!showProfile) {
        UI.profileWrap.setAttribute("hidden", "true");
      } else {
        UI.profileWrap.removeAttribute("hidden");
      }
    }
    if (showProfile) {
      const displayName = user?.displayName || user?.name || user?.email || "Signed in";
      if (UI.profileBtn) {
        UI.profileBtn.title = displayName;
      }
      if (UI.profileInitials) {
        if (!user) {
          UI.profileInitials.textContent = "ME";
        } else {
          const source = displayName.trim();
          const parts = source.split(/\s+/).filter(Boolean);
          const initials =
            parts.length >= 2
              ? `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`
              : (parts[0]?.slice(0, 2) ?? "");
          UI.profileInitials.textContent = initials.toUpperCase();
        }
      }
      if (UI.profileImg) {
        if (user?.photoURL && isSafeUrl(user.photoURL)) {
          UI.profileImg.src = user.photoURL;
          UI.profileImg.style.display = "block";
          if (UI.profileInitials) {
            UI.profileInitials.style.display = "none";
          }
          UI.profileImg.onerror = () => {
            UI.profileImg.style.display = "none";
            if (UI.profileInitials) {
              UI.profileInitials.style.display = "inline";
            }
          };
        } else {
          UI.profileImg.src = "";
          UI.profileImg.style.display = "none";
          if (UI.profileInitials) {
            UI.profileInitials.style.display = "inline";
          }
        }
      }
    }

    if (appLinks.length) {
      const disabledSet = new Set(
        (Array.isArray(lastDisabled) ? lastDisabled : []).filter(
          (name) => typeof name === "string"
        )
      );
      appLinks.forEach((link) => {
        const name = link.getAttribute("data-app-link");
        if (name !== "@org/auth-angular") return;
        const isDisabled = disabledSet.has(name);
        if (locked) {
          link.removeAttribute("data-auth-hidden");
          if (!isDisabled) {
            link.removeAttribute("hidden");
          }
        } else {
          link.setAttribute("data-auth-hidden", "true");
          link.setAttribute("hidden", "true");
        }
      });
    }
    if (UI.authLogout) {
      if (locked) {
        UI.authLogout.setAttribute("hidden", "true");
      } else {
        UI.authLogout.removeAttribute("hidden");
      }
    }
  };

  let visibilityScheduled = false;
  const scheduleVisibilityUpdate = () => {
    if (visibilityScheduled) return;
    visibilityScheduled = true;
    window.requestAnimationFrame(() => {
      visibilityScheduled = false;
      refreshAppElements();
      applyDisabledState(readDisabled());
      applyAuthState();
    });
  };

  applyDisabledState(readDisabled());
  applyAuthState();

  const visibilityObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (!mutation.addedNodes || mutation.addedNodes.length === 0) continue;
      for (const node of Array.from(mutation.addedNodes)) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches("[data-app], application")) {
          scheduleVisibilityUpdate();
          return;
        }
        if (node.querySelector("[data-app], application")) {
          scheduleVisibilityUpdate();
          return;
        }
      }
    }
  });
  visibilityObserver.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("single-spa:app-change", scheduleVisibilityUpdate);

  const handleSpaLinkClick = (event: MouseEvent) => {
    if (event.defaultPrevented) return;
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    const anchor = target?.closest("a[data-app-link]") as HTMLAnchorElement | null;
    if (!anchor) return;
    if (anchor.target && anchor.target !== "_self") return;
    const href = anchor.getAttribute("href");
    if (!href || href.startsWith("mailto:") || href.startsWith("tel:")) return;
    const resolved = new URL(href, window.location.href);
    if (resolved.origin !== window.location.origin) return;
    event.preventDefault();
    navigateToUrl(resolved.href);
  };

  document.addEventListener("click", handleSpaLinkClick);

  if (UI.themeToggle) {
    UI.themeToggle.addEventListener("click", () => {
      const root = document.documentElement;
      const isDark = root.getAttribute("data-theme") === "dark";
      if (isDark) {
        root.removeAttribute("data-theme");
      } else {
        root.setAttribute("data-theme", "dark");
      }
    });
  }

  if (UI.authLogout) {
    UI.authLogout.addEventListener("click", () => {
      writeAuthState(null);
      const url = new URL("/auth/login", window.location.origin);
      url.searchParams.set("returnTo", "/");
      window.location.assign(`${url.pathname}${url.search}`);
    });
  }

  window.addEventListener("storage", (event) => {
    if (event.key === "mfe-disabled") {
      applyDisabledState(readDisabled());
    }
    if (event.key === DISABLED_MODE_KEY) {
      applyDisabledState(readDisabled());
    }
  });

  // BroadcastChannel provides more reliable cross-tab sync than storage events.
  // status.html broadcasts on this channel whenever a module is toggled.
  try {
    const bc = new BroadcastChannel("mfe-disabled-sync");
    bc.onmessage = (event) => {
      const data = event.data as
        | {
            type?: string;
            disabled?: unknown;
            disabledMode?: unknown;
            app?: unknown;
            mode?: unknown;
          }
        | null;
      if (!data || typeof data !== "object") return;
      if (data.type === "mfe-disabled-mode") {
        applyIncomingDisabledModeForApp(data.app, data.mode);
      }
      if (data.type === "mfe-toggle") {
        if (Object.prototype.hasOwnProperty.call(data, "disabledMode")) {
          applyIncomingDisabledModeConfig(data.disabledMode);
        }
      }
      if (data.type === "mfe-toggle" || data.type === "mfe-disabled-mode") {
        refreshAppElements();
        applyDisabledState(readDisabled());
        applyAuthState();
      }
    };
  } catch {
    // BroadcastChannel not supported — storage event is the fallback
  }

  subscribeAuthChange(() => {
    applyAuthState();
  });

  window.addEventListener("message", (event) => {
    if (!isTrustedOrigin(event.origin)) return;
    const data = event.data as { type?: string; disabled?: unknown } | null;
    if (!data || data.type !== "mfe-toggle" || !Array.isArray(data.disabled)) return;
    // Strictly filter to string values only
    const safeDisabled = data.disabled.filter(
      (item: unknown): item is string => typeof item === "string"
    );
    applyDisabledState(safeDisabled);
  });

  window.addEventListener("mfe-toggle", (event) => {
    const detail = (
      event as CustomEvent<{ disabled?: DisabledList; disabledMode?: unknown }>
    ).detail;
    if (!detail || !Array.isArray(detail.disabled)) return;
    if (Object.prototype.hasOwnProperty.call(detail, "disabledMode")) {
      applyIncomingDisabledModeConfig(detail.disabledMode);
    }
    const safeDisabled = detail.disabled.filter(
      (item): item is string => typeof item === "string"
    );
    applyDisabledState(safeDisabled);
  });

  window.addEventListener("mfe-error", (event) => {
    const detail = (event as CustomEvent<{ name?: string; message?: string }>).detail || {};
    if (!detail.name || typeof detail.name !== "string" || !knownApps.has(detail.name)) return;
    const safeMessage =
      typeof detail.message === "string" ? detail.message.slice(0, 200) : "Module failed to load";
    setAppState(detail.name, "error", "Error", safeMessage);
  });

  window.addEventListener("mfe-availability", (event) => {
    const detail = (event as CustomEvent<{ available?: string[] }>).detail;
    if (!detail || !Array.isArray(detail.available)) return;
    const safeAvailable = detail.available.filter(
      (item): item is string => typeof item === "string"
    );
    availableApps = new Set(safeAvailable);
    scheduleVisibilityUpdate();
  });

  const formatMs = (value: number) => `${Math.round(value)}ms`;
  const perfPanelEl = UI.perfPanel;
  const perfListEl = UI.perfList;
  const defaultPerfConfig: PerfConfig = {
    position: "bottom-left",
    draggable: true,
    persist: true,
  };
  const perfConfig: PerfConfig = Object.assign(
    {},
    defaultPerfConfig,
    window.__perfPanelConfig || {}
  );
  const PERF_HIDDEN_KEY = "mfe-perf-panel-hidden";

  const readPerfHidden = () => {
    if (!perfConfig.persist) return null;
    try {
      const raw = window.localStorage.getItem(PERF_HIDDEN_KEY);
      if (raw === "true") return true;
      if (raw === "false") return false;
      return null;
    } catch {
      return null;
    }
  };

  const setPerfHidden = (hidden: boolean) => {
    if (!perfPanelEl) return;
    perfPanelEl.classList.toggle("mfe-perf-panel--hidden", hidden);
    if (UI.perfFab) {
      UI.perfFab.setAttribute("aria-pressed", hidden ? "false" : "true");
    }
  };

  const persistPerfHidden = (hidden: boolean) => {
    if (!perfConfig.persist) return;
    try {
      if (hidden) {
        window.localStorage.setItem(PERF_HIDDEN_KEY, "true");
      } else {
        window.localStorage.removeItem(PERF_HIDDEN_KEY);
      }
    } catch {
      // ignore storage errors
    }
  };

  const storedHidden = readPerfHidden();
  if (storedHidden !== null) {
    setPerfHidden(storedHidden);
  } else if (perfPanelEl) {
    setPerfHidden(perfPanelEl.classList.contains("mfe-perf-panel--hidden"));
  }

  const refreshPerf = () => {
    if (perfPanelEl?.classList.contains("mfe-perf-panel--hidden")) return;
    if (!perfListEl || typeof performance === "undefined") return;
    const measures = performance
      .getEntriesByType("measure")
      .filter((entry) => entry.name.startsWith("mfe:"));
    const byApp = new Map<string, Record<string, number>>();
    measures.forEach((entry) => {
      const parts = entry.name.split(":");
      const name = parts[1] || "unknown";
      const phase = parts[2] || "load";
      if (!byApp.has(name)) {
        byApp.set(name, {});
      }
      const target = byApp.get(name);
      if (target) {
        target[phase] = entry.duration;
      }
    });
    // Clear children safely instead of innerHTML
    while (perfListEl.firstChild) {
      perfListEl.removeChild(perfListEl.firstChild);
    }
    if (byApp.size === 0) {
      const empty = document.createElement("div");
      empty.className = "mfe-perf-item";
      const infoWrap = document.createElement("div");
      const infoTitle = document.createElement("div");
      infoTitle.textContent = "No metrics yet";
      const infoMeta = document.createElement("div");
      infoMeta.className = "mfe-perf-meta";
      infoMeta.textContent = "Interact with a module";
      infoWrap.appendChild(infoTitle);
      infoWrap.appendChild(infoMeta);
      const timeEl = document.createElement("div");
      timeEl.className = "mfe-perf-time";
      timeEl.textContent = "—";
      empty.appendChild(infoWrap);
      empty.appendChild(timeEl);
      perfListEl.appendChild(empty);
      return;
    }
    // Build perf items using safe DOM APIs instead of innerHTML to prevent XSS
    Array.from(byApp.entries()).forEach(([name, phases]) => {
      const item = document.createElement("div");
      item.className = "mfe-perf-item";
      const contentWrap = document.createElement("div");
      const nameDiv = document.createElement("div");
      nameDiv.className = "ds-helper";
      nameDiv.textContent = name;
      const metaDiv = document.createElement("div");
      metaDiv.className = "mfe-perf-meta";
      metaDiv.textContent = Object.entries(phases)
        .map(([key, val]) => `${key}: ${formatMs(val)}`)
        .join(" · ");
      contentWrap.appendChild(nameDiv);
      contentWrap.appendChild(metaDiv);
      const timeDiv = document.createElement("div");
      timeDiv.className = "mfe-perf-time";
      timeDiv.textContent = formatMs(Math.max(...Object.values(phases)));
      item.appendChild(contentWrap);
      item.appendChild(timeDiv);
      perfListEl.appendChild(item);
    });
  };

  if (UI.perfRefresh) {
    UI.perfRefresh.addEventListener("click", refreshPerf);
  }

  if (UI.perfFab) {
    UI.perfFab.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!perfPanelEl) return;
      const nextHidden = !perfPanelEl.classList.contains("mfe-perf-panel--hidden");
      setPerfHidden(nextHidden);
      persistPerfHidden(nextHidden);
    });
  }

  window.addEventListener("single-spa:app-change", () => {
    setTimeout(refreshPerf, 0);
  });
  setTimeout(refreshPerf, 500);

  const applyPerfPosition = (position?: "bottom-left" | "bottom-right") => {
    if (!perfPanelEl) return;
    perfPanelEl.classList.remove("mfe-perf-panel--right");
    perfPanelEl.style.left = "";
    perfPanelEl.style.right = "";
    perfPanelEl.style.top = "";
    perfPanelEl.style.bottom = "";
    if (position === "bottom-right") {
      perfPanelEl.classList.add("mfe-perf-panel--right");
    }
  };

  const storedPosition = (() => {
    if (!perfConfig.persist) return null;
    try {
      const raw = window.localStorage.getItem("mfe-perf-panel-pos");
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
      const { left, top } = parsed as { left?: number; top?: number };
      if (typeof left !== "number" || typeof top !== "number") return null;
      if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
      // Clamp to reasonable viewport bounds to prevent off-screen positioning
      return {
        left: Math.max(0, Math.min(left, window.innerWidth - 50)),
        top: Math.max(0, Math.min(top, window.innerHeight - 50)),
      };
    } catch {
      return null;
    }
  })();

  if (perfPanelEl) {
    if (perfConfig.draggable) {
      perfPanelEl.classList.add("mfe-perf-panel--draggable");
    }
    if (storedPosition) {
      perfPanelEl.style.left = `${storedPosition.left}px`;
      perfPanelEl.style.top = `${storedPosition.top}px`;
      perfPanelEl.style.right = "auto";
      perfPanelEl.style.bottom = "auto";
    } else {
      applyPerfPosition(perfConfig.position);
    }
  }

  const clamp = (value: number, min: number, max: number) =>
    Math.min(Math.max(value, min), max);

  const initPerfDrag = () => {
    if (!perfPanelEl || !perfConfig.draggable) return;
    if (typeof (window as any).PointerEvent === "undefined") return;
    const header = perfPanelEl.querySelector<HTMLElement>(".mfe-perf-header");
    if (!header || typeof header.setPointerCapture !== "function") return;

    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    let dragging = false;

    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) return;
      const deltaX = event.clientX - startX;
      const deltaY = event.clientY - startY;
      const nextLeft = originLeft + deltaX;
      const nextTop = originTop + deltaY;
      const maxLeft = window.innerWidth - perfPanelEl.offsetWidth - 8;
      const maxTop = window.innerHeight - perfPanelEl.offsetHeight - 8;
      perfPanelEl.style.left = `${clamp(nextLeft, 8, Math.max(8, maxLeft))}px`;
      perfPanelEl.style.top = `${clamp(nextTop, 8, Math.max(8, maxTop))}px`;
      perfPanelEl.style.right = "auto";
      perfPanelEl.style.bottom = "auto";
    };

    const onPointerUp = () => {
      if (!dragging) return;
      dragging = false;
      perfPanelEl.classList.remove("mfe-perf-panel--dragging");
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      if (perfConfig.persist) {
        const left = parseFloat(perfPanelEl.style.left || "0");
        const top = parseFloat(perfPanelEl.style.top || "0");
        try {
          window.localStorage.setItem(
            "mfe-perf-panel-pos",
            JSON.stringify({ left, top })
          );
        } catch {
          // ignore storage errors
        }
      }
    };

    header.addEventListener("pointerdown", (event) => {
      const pointerEvent = event as PointerEvent;
      dragging = true;
      perfPanelEl.classList.add("mfe-perf-panel--dragging");
      const rect = perfPanelEl.getBoundingClientRect();
      startX = pointerEvent.clientX;
      startY = pointerEvent.clientY;
      originLeft = rect.left;
      originTop = rect.top;
      header.setPointerCapture(pointerEvent.pointerId);
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    });
  };

  initPerfDrag();
};
