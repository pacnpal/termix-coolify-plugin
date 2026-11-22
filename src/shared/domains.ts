/** Letters, digits and hyphens only: one flat class, nothing to backtrack. */
const LABEL_CHARS = /^[a-z0-9-]+$/;
const MAX_HOSTNAME = 253;
const MAX_LABEL = 63;

/**
 * A DNS host name: at most 253 characters, at least two dot separated
 * labels of lowercase letters, digits and hyphens, each at most 63. Every
 * label but the last is at least one character and doesn't start or end
 * with a hyphen; the last is at least two, so a single label or an address
 * like 203.0.113.5 is refused. Checked label by label, with lengths first,
 * so no input can make it backtrack. DNS records and preview domains use it
 * alike.
 */
export function isHostname(text: string): boolean {
  if (text.length < 1 || text.length > MAX_HOSTNAME) return false;
  const labels = text.split(".");
  const last = labels.pop() ?? "";
  if (labels.length === 0) return false;
  if (last.length < 2 || last.length > MAX_LABEL) return false;
  if (!LABEL_CHARS.test(last)) return false;
  return labels.every(
    (label) =>
      label.length >= 1 &&
      label.length <= MAX_LABEL &&
      LABEL_CHARS.test(label) &&
      !label.startsWith("-") &&
      !label.endsWith("-"),
  );
}

/** A path without its trailing slashes, in one pass from the end. */
export function withoutTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === "/") end -= 1;
  return path.slice(0, end);
}

const SEGMENT = /^[A-Za-z0-9._~-]*$/;

/** An empty path, or "/" separated segments of URL-safe characters. */
function isSafePath(path: string): boolean {
  if (path === "") return true;
  if (!path.startsWith("/")) return false;
  return path
    .slice(1)
    .split("/")
    .every((segment) => SEGMENT.test(segment));
}

/** The most domains one list may hold. */
export const MAX_DOMAINS = 20;
/** The longest domain list, as text. */
export const MAX_DOMAINS_LENGTH = 2048;

export type DomainProblem =
  | "empty"
  | "too-long"
  | "too-many"
  | "scheme"
  | "credentials"
  | "query"
  | "not-url"
  | "host"
  | "path"
  | "duplicate";

export type DomainCheck =
  | { ok: true; domains: string[]; value: string }
  | { ok: false; reason: DomainProblem; entry?: string };

/** One entry of a domain list, normalized, or what is wrong with it. */
function checkOne(entry: string): string | DomainProblem {
  if (!/^https?:\/\//i.test(entry)) return "scheme";
  if (/[\s"'<>\\^`{}|]/.test(entry)) return "not-url";
  if (/^https?:\/\/[^/]*@/i.test(entry)) return "credentials";
  if (/[?#]/.test(entry)) return "query";
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    return "not-url";
  }
  if (url.username || url.password) return "credentials";
  if (!isHostname(url.hostname) || /^[\d.]+$/.test(url.hostname)) {
    return "host";
  }
  const path = withoutTrailingSlashes(url.pathname);
  if (!isSafePath(path)) return "path";
  return `${url.protocol}//${url.hostname}${portGiven(entry)}${path}`;
}

/**
 * A domain as Coolify lists it (portless, like `https://pr.example.com/api`)
 * with its port from Coolify's port overrides put back
 * (`https://pr.example.com:3000/api`), so an editor that starts from it and
 * saves unchanged keeps the port: Coolify replaces the overrides with what a
 * save sends. Overrides are keyed by the portless URL. A domain that names
 * its own port, or has no override, is left as it is.
 */
export function withPortOverride(
  domain: string,
  overrides: Readonly<Record<string, number>>,
): string {
  if (!Object.prototype.hasOwnProperty.call(overrides, domain)) return domain;
  const port = overrides[domain];
  const scheme = domain.indexOf("//");
  if (scheme < 0) return domain;
  const start = scheme + 2;
  const slash = domain.indexOf("/", start);
  const end = slash < 0 ? domain.length : slash;
  if (domain.slice(start, end).includes(":")) return domain;
  return `${domain.slice(0, end)}:${port}${domain.slice(end)}`;
}

/**
 * The port an entry names, as ":<number>", read from the text itself: the
 * URL parser drops a scheme's default port (:80, :443), but Coolify reads
 * any port given as an internal routing override, so it must stay. Called
 * once the entry parsed as a URL with a host name, no credentials, query or
 * fragment, so what follows the last colon of the authority is the port.
 */
function portGiven(entry: string): string {
  const rest = entry.slice(entry.indexOf("//") + 2);
  const slash = rest.indexOf("/");
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  const colon = authority.lastIndexOf(":");
  const digits = colon < 0 ? "" : authority.slice(colon + 1);
  return digits === "" ? "" : `:${Number(digits)}`;
}

/**
 * A comma separated list of preview or application domains as Coolify takes
 * them (`https://pr.example.com:3000,http://pr.example.com/api`), checked
 * before it is sent: each entry an http or https URL with a DNS host name,
 * an optional port and path, no credentials, query or fragment, no repeats.
 * The answer holds the entries normalized (lowercase host, no trailing
 * slash) and joined again.
 */
export function checkDomains(text: string): DomainCheck {
  if (text.length > MAX_DOMAINS_LENGTH)
    return { ok: false, reason: "too-long" };
  const entries = text
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (entries.length === 0) return { ok: false, reason: "empty" };
  if (entries.length > MAX_DOMAINS) return { ok: false, reason: "too-many" };
  const domains: string[] = [];
  for (const entry of entries) {
    const checked = checkOne(entry);
    if (!checked.includes("://")) {
      return { ok: false, reason: checked as DomainProblem, entry };
    }
    if (domains.includes(checked)) {
      return { ok: false, reason: "duplicate", entry };
    }
    domains.push(checked);
  }
  return { ok: true, domains, value: domains.join(",") };
}
