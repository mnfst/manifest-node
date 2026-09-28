import { redact, redactUrl } from '@mnfst/http-redact';
import { isObject } from './wire.js';

/**
 * What of a failing request leaves the machine, masked by @mnfst/http-redact: credential
 * values are replaced in place by REDACTED, names and structure travel. `masks` lists each
 * replaced value (`in` + `at`: header name, query name, 1-based path segment index, or a
 * JSON Pointer into the body) so the retry can put the originals back.
 * What is masked: https://github.com/mnfst/http-redact#what-is-masked
 */
export const MASK = 'REDACTED';
const HEADER_VALUE_CAP = 1024;
// Never sent at all: cookies carry sessions, and fixing an API call does not need them.
const DROPPED_HEADERS = new Set(['cookie', 'set-cookie']);

export interface Mask { in: string; at: string }
export interface Masked { url: string; headers: Record<string, string>; body: unknown; masks: Mask[] }

// user:password@host never travels, not even masked: a retry refuses a URL that carries it.
const withoutUserinfo = (url: string) => url.replace(/^((?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\/)[^/?#]*@/, '$1');

export function maskRequest(method: string, url: string, headers: Headers, body: unknown): Masked {
  const flat: Record<string, string> = {};
  for (const [name, value] of headers) if (!DROPPED_HEADERS.has(name)) flat[name] = value;
  const encoded = body === null || body === undefined ? null : JSON.stringify(body);
  const out = redact({ method, url: withoutUserinfo(url), headers: flat, body: encoded, contentType: encoded === null ? null : 'application/json' });
  const sent: Record<string, string> = {};
  for (const [name, value] of Object.entries(out.request.headers)) sent[name.toLowerCase()] = String(value).slice(0, HEADER_VALUE_CAP);
  const masks = out.masked.map(m => m.in === 'header' ? { in: 'header', at: m.at.toLowerCase() } : { in: m.in, at: m.at });
  return { url: out.request.url, headers: sent, body: decoded(encoded, out.request.body), masks };
}

/** A response body (text, or JSON already parsed), masked. Responses are never retried. */
export function maskResponse(body: unknown): unknown {
  if (body === null || body === undefined) return body;
  const encoded = typeof body === 'string' ? body : JSON.stringify(body);
  const masked = redact({ method: 'GET', url: '/', response: encoded }).request.response;
  return typeof body === 'string' ? masked : decoded(encoded, masked);
}

/** A URL for a message or a callback: masked, without userinfo. */
export const maskUrl = (url: string): string => redactUrl(withoutUserinfo(url));

const at = (sent: Masked, where: string) => sent.masks.filter(m => m.in === where).map(m => m.at);

function decoded(encoded: string | null, redacted: string | null): unknown {
  if (encoded === null || redacted === null) return null;
  if (redacted === encoded) return JSON.parse(encoded);
  if (redacted === MASK) return MASK; // masked whole: its structure could not be proven safe
  try { return JSON.parse(redacted); } catch { return MASK; }
}

// ---- restore before a retry --------------------------------------------------------
// The healed request is authoritative. At each masked address, a value the heal left as
// it was sent (REDACTED, or a string masked partway) takes the original back; a masked
// value the heal left out of an object is put back; a value an operation changed stays.
// Lists, paths and repeated query names are restored only while their shape is
// unchanged. A mask anywhere else refuses the retry: REDACTED never reaches the API.

type Path = string[];
const pointer = (p: string): Path => p === '' ? [] : p.split('/').slice(1).map(s => s.replaceAll('~1', '/').replaceAll('~0', '~'));
const container = (v: unknown): v is Record<string, unknown> | unknown[] => Array.isArray(v) || isObject(v);
const has = (v: unknown, path: Path): boolean => {
  for (const key of path) { if (!container(v) || !Object.hasOwn(v, key)) return false; v = (v as Record<string, unknown>)[key]; }
  return true;
};
const get = (v: unknown, path: Path): unknown => path.reduce<unknown>((x, key) => container(x) ? (x as Record<string, unknown>)[key] : undefined, v);
function set(v: unknown, path: Path, value: unknown): unknown {
  if (!path.length) return value;
  const [key, ...rest] = path as [string, ...string[]];
  if (Array.isArray(v)) { const copy = [...v]; copy[Number(key)] = set(copy[Number(key)], rest, value); return copy; }
  if (isObject(v)) return { ...v, [key]: set(v[key], rest, value) };
  return v;
}

/** Every list on the way to `path` kept its length, and the element on the way is unchanged. */
function sameListElements(healed: unknown, sent: unknown, path: Path): boolean {
  for (let i = 0; i < path.length; i++) {
    const list = get(sent, path.slice(0, i));
    if (!Array.isArray(list)) continue;
    const healedList = has(healed, path.slice(0, i)) ? get(healed, path.slice(0, i)) : undefined;
    if (!Array.isArray(healedList) || healedList.length !== list.length) return false;
    const element = path.slice(0, i + 1);
    if (!has(healed, element) || JSON.stringify(get(healed, element)) !== JSON.stringify(get(sent, element))) return false;
  }
  return true;
}

/** A mask at an address where the original holds none: it would reach the API. */
function newMask(healed: unknown, original: unknown, path: Path = []): boolean {
  if (typeof healed === 'string') {
    if (!healed.includes(MASK)) return false;
    const was = has(original, path) ? get(original, path) : undefined;
    return !(typeof was === 'string' && was.includes(MASK));
  }
  if (container(healed)) return Object.entries(healed).some(([k, child]) => newMask(child, original, [...path, k]));
  return false;
}

/** The body to retry with, or `undefined` when the retry must be refused. */
export function restoreBody(original: unknown, sent: Masked, healed: unknown): unknown {
  if (sent.body === MASK && original !== MASK) return healed === MASK ? original : undefined;
  let body = healed;
  for (const p of at(sent, 'body')) {
    const path = pointer(p);
    if (!path.length || !has(original, path)) continue;
    if (!sameListElements(body, sent.body, path)) return undefined;
    const parent = path.slice(0, -1);
    const leftOut = !has(body, path) && has(body, parent) && isObject(get(body, parent));
    if (leftOut || (has(body, path) && get(body, path) === get(sent.body, path))) body = set(body, path, get(original, path));
  }
  return newMask(body, original) ? undefined : body;
}

const queryPairs = (query: string): [string, string | null][] =>
  query.split('&').filter(Boolean).map(part => { const eq = part.indexOf('='); return eq < 0 ? [part, null] : [part.slice(0, eq), part.slice(eq + 1)]; });
const decode = (s: string) => { try { return decodeURIComponent(s.replaceAll('+', ' ')); } catch { return s; } };

/** The healed URL with masked path segments and query values restored, or null to refuse. */
export function restoreUrl(original: string, healed: string, sent: Masked): string | null {
  const from = new URL(original), to = new URL(healed);
  const segments = to.pathname.split('/'), originals = from.pathname.split('/');
  const pathMasks = at(sent, 'path');
  if (pathMasks.length && segments.length !== originals.length) return null;
  for (const i of pathMasks.map(Number)) if (segments[i] === MASK && originals[i] !== undefined) segments[i] = originals[i]!;
  if (segments.some((s, i) => decode(s).includes(MASK) && !decode(originals[i] ?? '').includes(MASK))) return null;

  const byName = new Map<string, [string, string | null][]>();
  for (const pair of queryPairs(from.search.slice(1))) {
    const name = decode(pair[0]); byName.set(name, [...(byName.get(name) ?? []), pair]);
  }
  const healedPairs = queryPairs(to.search.slice(1));
  const counts = new Map<string, number>();
  for (const [name] of healedPairs) counts.set(decode(name), (counts.get(decode(name)) ?? 0) + 1);
  const masked = at(sent, 'query');
  // A masked name is restored by occurrence: if the heal changed how often it appears, which original goes where is unknown.
  if (masked.some(name => counts.has(name) && counts.get(name) !== (byName.get(name)?.length ?? 0))) return null;
  const seen = new Map<string, number>();
  const pairs: string[] = [];
  for (const [name, value] of healedPairs) {
    const key = decode(name), index = seen.get(key) ?? 0;
    seen.set(key, index + 1);
    let out = value;
    if (value !== null && decode(value) === MASK) {
      out = byName.get(key)?.[index]?.[1] ?? null;
      if (out === null) return null;
    } else if (value !== null && decode(value).includes(MASK) && !decode(byName.get(key)?.[index]?.[1] ?? '').includes(MASK)) {
      return null;
    }
    pairs.push(out === null ? name : `${name}=${out}`);
  }
  for (const [key, values] of byName) {
    if (!seen.has(key) && masked.includes(key)) for (const [name, value] of values) pairs.push(value === null ? name : `${name}=${value}`);
  }
  return `${to.origin}${segments.join('/')}${pairs.length ? '?' + pairs.join('&') : ''}`;
}

/**
 * The healed header changes to apply, with masked ones left as the original, or null to
 * refuse (a changed header still holding the mask cannot have its credential put back).
 */
export function restoreHeaders(healed: Record<string, unknown>, original: Headers, sent: Masked): Record<string, string | null> | null {
  const out: Record<string, string | null> = {};
  const masked = new Set(at(sent, 'header'));
  for (const [name, value] of Object.entries(healed)) {
    const lower = name.toLowerCase();
    if (value !== null && typeof value !== 'string') return null;
    if (value === MASK && !original.has(lower)) return null;
    if (value === MASK || (value !== null && masked.has(lower) && value === sent.headers[lower])) continue;
    if (value !== null && value.includes(MASK) && !(original.get(lower) ?? '').includes(MASK)) return null;
    out[name] = value;
  }
  return out;
}
