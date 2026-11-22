/**
 * A DNS host name: lowercase labels, at least two, the last one not all
 * digits short enough to be an address. DNS records and preview domains use
 * it alike.
 */
export const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

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

const PATH = /^(?:\/[A-Za-z0-9._~-]*)*$/;

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
  if (!HOSTNAME.test(url.hostname) || /^[\d.]+$/.test(url.hostname)) {
    return "host";
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (!PATH.test(path)) return "path";
  return `${url.protocol}//${url.host}${path}`;
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
