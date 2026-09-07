const secretNames = new Set(['api_key', 'apikey', 'api_token', 'key', 'token', 'access_token',
  'refresh_token', 'auth', 'authorization', 'signature', 'sig', 'secret', 'client_secret',
  'password', 'session', 'session_id', 'bearer', 'jwt', 'id_token', 'auth_token', 'pwd', 'passwd', 'private_key']);
const roots = ['auth', 'key', 'token', 'secret', 'session', 'password', 'passwd', 'cookie', 'signature', 'credential', 'bearer', 'jwt'];
const normalize = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replaceAll('-', '_').toLowerCase().replace(/^x_/, '');
export const isSecret = (name: string) => secretNames.has(normalize(name));
export const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function safeUrl(raw: string): string {
  const url = new URL(raw);
  url.username = ''; url.password = ''; url.hash = '';
  const pairs = [...url.searchParams].map(([key, value]) => [key, isSecret(key) ? 'REDACTED' : value]);
  url.search = new URLSearchParams(pairs as [string, string][]).toString();
  return url.toString();
}
export function safeHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries([...headers].map(([key, value]) => [key,
    isSecret(key) || roots.some(root => normalize(key).includes(root)) ? 'REDACTED' : value.slice(0, 1024)]));
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
export function errorBody(bytes: Uint8Array): unknown {
  const parsed = parseJson(bytes);
  const text = Buffer.from(bytes).toString('utf8');
  return parsed ?? new TextDecoder().decode(Buffer.from(text).subarray(0, 65536), { stream: true });
}
// Transport exception messages can contain arbitrary headers or body data.
// Send a fixed description rather than trying to scrub arbitrary exception prose.
export const TRANSPORT_ERROR = 'Upstream retry failed before an HTTP response';
