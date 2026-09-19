const secretNames = new Set(['api_key', 'apikey', 'api_token', 'key', 'token', 'access_token',
  'refresh_token', 'auth', 'authorization', 'signature', 'sig', 'secret', 'client_secret',
  'password', 'session', 'session_id', 'bearer', 'jwt', 'id_token', 'auth_token', 'pwd', 'passwd', 'private_key']);
const roots = ['auth', 'key', 'token', 'secret', 'session', 'password', 'passwd', 'cookie', 'signature', 'credential', 'bearer', 'jwt'];
const normalize = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replaceAll('-', '_').toLowerCase().replace(/^x_/, '');
export const isSecret = (name: string) => secretNames.has(normalize(name));
/** A name the SDK masks on the wire: an exact credential name or one built on a credential root. */
export const isSecretName = (name: string) => isSecret(name) || roots.some(root => normalize(name).includes(root));
/** What the SDK writes in place of a credential; never put back on the wire when served back. */
export const MASK = 'REDACTED';
export const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function safeUrl(raw: string): string {
  const url = new URL(raw);
  url.username = ''; url.password = ''; url.hash = '';
  const pairs = [...url.searchParams].map(([key, value]) => [key, isSecret(key) ? MASK : value]);
  url.search = new URLSearchParams(pairs as [string, string][]).toString();
  return url.toString();
}
export function safeHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries([...headers].map(([key, value]) => [key,
    isSecretName(key) ? MASK : value.slice(0, 1024)]));
}
export function travelingBody(body: unknown): unknown {
  return isObject(body) ? Object.fromEntries(Object.entries(body).filter(([key]) => !isSecret(key))) : body;
}
export function mergeBody(original: unknown, healed: unknown): unknown {
  if (!isObject(original) || !isObject(healed)) return healed;
  return { ...Object.fromEntries(Object.entries(original).filter(([key]) => isSecret(key) && !Object.hasOwn(healed, key))), ...healed };
}
export function boundedJson(value: unknown): boolean {
  const stack: [unknown, number][] = [[value, 0]];
  let count = 0;
  while (stack.length) {
    const [item, depth] = stack.pop()!;
    if (++count > 100_000 || depth > 64) return false;
    if (item !== null && typeof item === 'object') {
      for (const child of Object.values(item)) stack.push([child, depth + 1]);
    }
  }
  return true;
}
export function parseJson(bytes: Uint8Array): unknown {
  try { const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); return boundedJson(value) ? value : null; }
  catch { return null; }
}
const unsafeFormKeys = new Set(['__proto__', 'constructor', 'prototype']);
const arrayIndex = (value: string) => /^(0|[1-9]\d*)$/.test(value) && Number(value) <= 100_000;
const formEncoded = (contentType?: string | null) =>
  contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'application/x-www-form-urlencoded';

function formPath(key: string): string[] | null {
  const bracket = key.indexOf('[');
  const root = bracket === -1 ? key : key.slice(0, bracket);
  if (!root || root.includes(']')) return null;
  const path = [root];
  let offset = root.length;
  while (offset < key.length) {
    if (key[offset] !== '[') return null;
    const end = key.indexOf(']', offset + 1);
    if (end === -1) return null;
    const part = key.slice(offset + 1, end);
    if (part.includes('[')) return null;
    path.push(part); offset = end + 1;
  }
  return path.length <= 64 && path.every(part => !unsafeFormKeys.has(part)) ? path : null;
}

function putFormValue(root: Record<string, unknown>, path: string[], value: string): boolean {
  let current: Record<string, unknown> | unknown[] = root;
  for (let index = 0; index < path.length; index++) {
    const part = path[index]!;
    const last = index === path.length - 1;
    if (Array.isArray(current)) {
      if (part !== '' && !arrayIndex(part)) return false;
      const position = part === '' ? current.length : Number(part);
      if (last) {
        const existing = Object.hasOwn(current, position) ? current[position] : undefined;
        if (existing === undefined) current[position] = value;
        else if (typeof existing === 'string') current[position] = [existing, value];
        else if (Array.isArray(existing) && existing.every(item => typeof item === 'string')) existing.push(value);
        else return false;
        continue;
      }
      const next = path[index + 1]!;
      const needsArray = next === '' || arrayIndex(next);
      const existing = Object.hasOwn(current, position) ? current[position] : undefined;
      if (existing === undefined) current[position] = needsArray ? [] : {};
      else if (typeof existing !== 'object' || existing === null || Array.isArray(existing) !== needsArray) return false;
      current = current[position] as Record<string, unknown> | unknown[];
      continue;
    }
    if (!part) return false;
    if (last) {
      const existing = Object.hasOwn(current, part) ? current[part] : undefined;
      if (existing === undefined) current[part] = value;
      else if (typeof existing === 'string') current[part] = [existing, value];
      else if (Array.isArray(existing) && existing.every(item => typeof item === 'string')) existing.push(value);
      else return false;
      continue;
    }
    const next = path[index + 1]!;
    const needsArray = next === '' || arrayIndex(next);
    const existing = Object.hasOwn(current, part) ? current[part] : undefined;
    if (existing === undefined) current[part] = needsArray ? [] : {};
    else if (typeof existing !== 'object' || existing === null || Array.isArray(existing) !== needsArray) return false;
    current = current[part] as Record<string, unknown> | unknown[];
  }
  return true;
}

function parseForm(bytes: Uint8Array): { body: unknown; valid: boolean } {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const body: Record<string, unknown> = {};
    let fields = 0;
    for (const pair of text.split('&')) {
      if (!pair) continue;
      if (++fields > 100_000) return { body: null, valid: false };
      const separator = pair.indexOf('=');
      const rawKey = separator === -1 ? pair : pair.slice(0, separator);
      const rawValue = separator === -1 ? '' : pair.slice(separator + 1);
      const key = decodeURIComponent(rawKey.replaceAll('+', ' '));
      const value = decodeURIComponent(rawValue.replaceAll('+', ' '));
      const path = formPath(key);
      if (!path || !putFormValue(body, path, value)) return { body: null, valid: false };
    }
    return boundedJson(body) ? { body, valid: true } : { body: null, valid: false };
  } catch { return { body: null, valid: false }; }
}

export function parseRequestBody(bytes: Uint8Array, contentType?: string | null): { body: unknown; valid: boolean } {
  return formEncoded(contentType) ? parseForm(bytes) : { body: parseJson(bytes), valid: true };
}

export function serializeRequestBody(body: unknown, contentType?: string | null): string | undefined {
  if (!formEncoded(contentType)) return JSON.stringify(body);
  if (!isObject(body)) throw new TypeError('Form body must be an object');
  const params = new URLSearchParams();
  let fields = 0;
  const append = (value: unknown, key: string, depth: number): void => {
    if (++fields > 100_000 || depth > 64) throw new TypeError('Form body exceeds structural limits');
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        if (Object.hasOwn(value, index)) append(value[index], `${key}[${index}]`, depth + 1);
      }
    } else if (isObject(value)) {
      for (const [name, child] of Object.entries(value)) {
        if (unsafeFormKeys.has(name)) throw new TypeError('Form body contains an unsafe key');
        append(child, key ? `${key}[${name}]` : name, depth + 1);
      }
    } else if (value === null) params.append(key, '');
    else if (typeof value === 'string' || typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))) params.append(key, String(value));
    else throw new TypeError('Form body contains an unsupported value');
  };
  for (const [key, value] of Object.entries(body)) {
    if (unsafeFormKeys.has(key)) throw new TypeError('Form body contains an unsafe key');
    append(value, key, 1);
  }
  return params.toString();
}
export function errorBody(bytes: Uint8Array): unknown {
  const parsed = parseJson(bytes);
  const text = Buffer.from(bytes).toString('utf8');
  return parsed ?? new TextDecoder().decode(Buffer.from(text).subarray(0, 65536), { stream: true });
}
// Transport exception messages can contain arbitrary headers or body data.
// Send a fixed description rather than trying to scrub arbitrary exception prose.
export const TRANSPORT_ERROR = 'Upstream retry failed before an HTTP response';
