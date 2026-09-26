/**
 * Calls that never reach Manifest: neither healed nor tracked. An entry is a domain
 * (`stripe.com`) or a domain with a path (`stripe.com/v1/charges`); the domain covers its
 * subdomains either way, and the path matches whole segments.
 */
export interface Rule { host: string; path: string | null }
/** `allow` is null when no allowlist was given; an allowlist of only bad entries still excludes. */
export interface UrlFilter { allow: Rule[] | null; deny: Rule[] }
export type RuleList = string[] | string | undefined;

const HOST = /^(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*|\[[0-9a-f:.]+\])$/;

/** One entry, normalized; `null` when it cannot be read. The scheme, port, query and fragment are ignored. */
export function parseRule(entry: string): Rule | null {
  const rest = entry.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[?#]/)[0] ?? '';
  const slash = rest.indexOf('/');
  const authority = (slash < 0 ? rest : rest.slice(0, slash)).toLowerCase();
  const path = slash < 0 ? '' : rest.slice(slash).replace(/\/+$/, '');
  const host = authority.replace(/^\*\./, '').replace(/:\d+$/, '').replace(/^\.+|\.+$/g, '');
  // `*` inside a path is reserved for a future segment wildcard, so it is refused today.
  if (!HOST.test(host) || path.includes('*')) return null;
  return { host: host.replace(/^\[|\]$/g, ''), path: path || null };
}

const entries = (value: RuleList) =>
  (typeof value === 'string' ? value.split(',') : value ?? []).map(e => String(e).trim()).filter(Boolean);

/**
 * An option beats its env var, like `key` and `url`; a blank one is unset and falls back to
 * it. `invalid` lists the entries that were dropped, for the caller to warn about.
 */
export function resolveFilter(options: { allowlist?: RuleList; denylist?: RuleList },
  env: Record<string, string | undefined>): { filter: UrlFilter; invalid: string[] } {
  const invalid: string[] = [];
  const pick = (option: RuleList, name: string) => {
    const given = entries(option).length > 0 ? entries(option) : entries(env[name]);
    const rules = given.map(e => parseRule(e) ?? (invalid.push(e), null)).filter((r): r is Rule => r !== null);
    return { given: given.length > 0, rules };
  };
  const allow = pick(options.allowlist, 'MNFST_ALLOWLIST');
  const deny = pick(options.denylist, 'MNFST_DENYLIST');
  return { filter: { allow: allow.given ? allow.rules : null, deny: deny.rules }, invalid };
}

const covers = (rule: Rule, host: string, path: string) =>
  (host === rule.host || host.endsWith('.' + rule.host)) &&
  (rule.path === null || path === rule.path || path.startsWith(rule.path + '/'));

/** A denied call is excluded; with an allowlist, so is every call not on it. An unreadable URL is not. */
export function isExcluded(filter: UrlFilter, url: string): boolean {
  let host: string; let path: string;
  try {
    const parsed = new URL(url);
    host = parsed.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
    path = parsed.pathname || '/';
  } catch { return false; }
  if (filter.deny.some(r => covers(r, host, path))) return true;
  return filter.allow !== null && !filter.allow.some(r => covers(r, host, path));
}
