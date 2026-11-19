import en from "../../../locales/en.json";

/** One resource on the public page. Never a uuid, server, domain or log. */
export interface StatusItem {
  name: string;
  /** running, degraded, stopped or deploying. */
  status: string;
  lastDeployAt: string | null;
  /** True for a deploy that succeeded, false for one that failed, null when unknown. */
  lastDeployOk: boolean | null;
  /** Percent, only when the Uptime plugin answers for this resource. */
  uptime?: number;
}

export interface StatusView {
  title: string;
  items: StatusItem[];
  generatedAt: string;
  /** When the cached status was fetched from Coolify, or null when never. */
  updatedAt?: string | null;
  /** The cache is older than 5 minutes, or empty. */
  stale?: boolean;
}

const P = en.statusPage.public;
const STATUS_WORDS: Record<string, string> = P.statuses;

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Text for HTML content and attribute values. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) =>
    escapeHtml(values[key] ?? ""),
  );
}

/** "2026-11-19 10:00 UTC", or null for a value that isn't a time. */
function when(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

const TONES: Record<string, string> = {
  running: "ok",
  degraded: "bad",
  stopped: "off",
  deploying: "busy",
};

const STYLE = `
:root{color-scheme:light dark;--bg:#f7f7f8;--card:#fff;--fg:#18181b;--muted:#71717a;--line:#e4e4e7;
--ok:#15803d;--bad:#b91c1c;--off:#52525b;--busy:#b45309;--warn-bg:#fef3c7;--warn-fg:#78350f}
@media (prefers-color-scheme:dark){:root{--bg:#09090b;--card:#18181b;--fg:#f4f4f5;--muted:#a1a1aa;
--line:#27272a;--ok:#4ade80;--bad:#f87171;--off:#a1a1aa;--busy:#fbbf24;--warn-bg:#422006;--warn-fg:#fde68a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px}
h1{font-size:22px;margin:0 0 4px}
.updated{color:var(--muted);margin:0 0 20px}
.stale{background:var(--warn-bg);color:var(--warn-fg);padding:10px 12px;margin:0 0 16px;border-radius:6px}
ul{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:8px;background:var(--card)}
li{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:12px 14px;border-top:1px solid var(--line)}
li:first-child{border-top:0}
.name{font-weight:600;overflow-wrap:anywhere}
.meta{color:var(--muted);font-size:12px}
.status{font-weight:600;white-space:nowrap}
.ok{color:var(--ok)}.bad{color:var(--bad)}.off{color:var(--off)}.busy{color:var(--busy)}
.empty{color:var(--muted);padding:14px}
`;

function itemHtml(item: StatusItem): string {
  const word = STATUS_WORDS[item.status] ?? STATUS_WORDS.stopped;
  const tone = TONES[item.status] ?? "off";
  const deployedAt = when(item.lastDeployAt);
  const meta: string[] = [];
  if (deployedAt) {
    let deploy = fill(P.lastDeploy, { time: deployedAt });
    if (item.lastDeployOk === true) deploy += ` · ${escapeHtml(P.deployOk)}`;
    if (item.lastDeployOk === false) {
      deploy += ` · ${escapeHtml(P.deployFailed)}`;
    }
    meta.push(deploy);
  } else {
    meta.push(escapeHtml(P.neverDeployed));
  }
  if (typeof item.uptime === "number" && Number.isFinite(item.uptime)) {
    const percent = String(Math.round(item.uptime * 100) / 100);
    meta.push(fill(P.uptime, { percent }));
  }
  return `<li><div><div class="name">${escapeHtml(item.name)}</div><div class="meta">${meta.join(" · ")}</div></div><span class="status ${tone}">${escapeHtml(word)}</span></li>`;
}

/**
 * The public status page: self-contained HTML with inline CSS, no scripts
 * and no outside resources, refreshed by a meta tag every 30 seconds. Every
 * value is escaped.
 */
export function renderStatusPage(view: StatusView): string {
  const updated = when(view.updatedAt ?? null);
  const list = view.items.length
    ? `<ul>${view.items.map(itemHtml).join("")}</ul>`
    : `<ul><li class="empty">${escapeHtml(P.noData)}</li></ul>`;
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    '<meta http-equiv="refresh" content="30">',
    `<title>${escapeHtml(view.title)}</title>`,
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    "<main>",
    `<h1>${escapeHtml(view.title)}</h1>`,
    updated
      ? `<p class="updated">${fill(P.updated, { time: updated })}</p>`
      : "",
    view.stale ? `<p class="stale">${escapeHtml(P.stale)}</p>` : "",
    list,
    "</main>",
    "</body>",
    "</html>",
  ].join("\n");
}
