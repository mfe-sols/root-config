import { navigateToUrl } from "single-spa";

const MAINTENANCE_TAG = "mfe-maintenance-card";
const MAINTENANCE_CLASS = "app-maintenance";
const DEFAULT_STATUS_PATH = "/status.html";

type MaintenanceCardPayload = {
  app: string;
  label?: string;
  detail?: string;
  statusPath?: string;
};

const getAppName = (app: string | null) => (app ? app.replace(/^@org\//, "") : "");

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

const ensureNode = <T extends HTMLElement>(
  root: ParentNode,
  selector: string,
  tag: keyof HTMLElementTagNameMap,
  className: string
) => {
  let node = root.querySelector<T>(selector);
  if (node) return node;
  node = document.createElement(tag) as T;
  node.className = className;
  root.appendChild(node);
  return node;
};

const renderMaintenanceContent = (host: HTMLElement, payload: MaintenanceCardPayload) => {
  const appTagText = `@${getAppName(payload.app)}`;
  const statusPath = payload.statusPath || DEFAULT_STATUS_PATH;

  host.classList.add(MAINTENANCE_CLASS);
  host.setAttribute("role", "status");
  host.setAttribute("aria-live", "polite");

  const head = ensureNode<HTMLDivElement>(host, ".app-maintenance__head", "div", "app-maintenance__head");
  const pill = ensureNode<HTMLSpanElement>(
    head,
    ".app-maintenance__pill",
    "span",
    "app-maintenance__pill"
  );
  const appTag = ensureNode<HTMLSpanElement>(
    head,
    ".app-maintenance__app",
    "span",
    "app-maintenance__app"
  );

  const content = ensureNode<HTMLDivElement>(
    host,
    ".app-maintenance__content",
    "div",
    "app-maintenance__content"
  );
  const icon = ensureNode<HTMLSpanElement>(
    content,
    ".app-maintenance__icon",
    "span",
    "app-maintenance__icon"
  );
  const copy = ensureNode<HTMLDivElement>(
    content,
    ".app-maintenance__copy",
    "div",
    "app-maintenance__copy"
  );
  const title = ensureNode<HTMLDivElement>(
    copy,
    ".app-maintenance__title",
    "div",
    "app-maintenance__title"
  );
  const desc = ensureNode<HTMLDivElement>(
    copy,
    ".app-maintenance__desc",
    "div",
    "app-maintenance__desc"
  );
  const meta = ensureNode<HTMLDivElement>(
    copy,
    ".app-maintenance__meta",
    "div",
    "app-maintenance__meta"
  );
  const time = ensureNode<HTMLDivElement>(
    content,
    ".app-maintenance__time",
    "div",
    "app-maintenance__time"
  );
  const actions = ensureNode<HTMLDivElement>(
    content,
    ".app-maintenance__actions",
    "div",
    "app-maintenance__actions"
  );
  const button = ensureNode<HTMLButtonElement>(
    actions,
    ".app-maintenance__btn",
    "button",
    "app-maintenance__btn"
  );

  icon.textContent = "!";
  icon.setAttribute("aria-hidden", "true");

  pill.textContent = "MAINTENANCE";
  appTag.textContent = appTagText;
  title.textContent = payload.label || "Maintenance";
  desc.textContent = payload.detail || `${appTagText} is currently disabled. Please check status.`;
  meta.textContent = `Service paused: ${appTagText}`;
  time.textContent = `Updated ${formatMaintenanceTimestamp()}`;

  button.type = "button";
  button.textContent = "Open status";
  button.setAttribute("aria-label", "Open status page");
  button.onclick = () => {
    navigateToUrl(statusPath);
  };
};

class MfeMaintenanceCardElement extends HTMLElement {
  static get observedAttributes() {
    return ["app", "label", "detail", "status-path"];
  }

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback() {
    this.render();
  }

  private render() {
    const app = this.getAttribute("app") || "";
    if (!app) return;
    renderMaintenanceContent(this, {
      app,
      label: this.getAttribute("label") || undefined,
      detail: this.getAttribute("detail") || undefined,
      statusPath: this.getAttribute("status-path") || undefined,
    });
  }
}

export const defineMaintenanceCardElement = () => {
  if (typeof window === "undefined" || !window.customElements) return;
  if (!window.customElements.get(MAINTENANCE_TAG)) {
    window.customElements.define(MAINTENANCE_TAG, MfeMaintenanceCardElement);
  }
};

export const ensureMaintenanceCard = (
  container: HTMLElement,
  payload: MaintenanceCardPayload
) => {
  const hasCustomElements =
    typeof window !== "undefined" && typeof window.customElements !== "undefined";
  if (hasCustomElements) {
    defineMaintenanceCardElement();
  }
  let card = container.querySelector<HTMLElement>(`${MAINTENANCE_TAG}.${MAINTENANCE_CLASS}`);
  if (!card) {
    const legacyCard = container.querySelector<HTMLElement>(`.${MAINTENANCE_CLASS}`);
    if (legacyCard) {
      legacyCard.remove();
    }
    card = document.createElement(MAINTENANCE_TAG);
    card.classList.add(MAINTENANCE_CLASS);
    container.appendChild(card);
  }
  card.setAttribute("app", payload.app);
  if (payload.label) {
    card.setAttribute("label", payload.label);
  } else {
    card.removeAttribute("label");
  }
  if (payload.detail) {
    card.setAttribute("detail", payload.detail);
  } else {
    card.removeAttribute("detail");
  }
  card.setAttribute("status-path", payload.statusPath || DEFAULT_STATUS_PATH);

  if (!hasCustomElements) {
    renderMaintenanceContent(card, payload);
  }
};

export const removeMaintenanceCard = (container: HTMLElement) => {
  const card = container.querySelector(`.${MAINTENANCE_CLASS}`);
  if (card) {
    card.remove();
  }
};
