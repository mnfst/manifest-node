import http, { type ClientRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { urlToHttpOptions } from 'node:url';
import { Readable } from 'node:stream';
import { createBrotliDecompress, createUnzip } from 'node:zlib';
import { parseRequestBody, serializeRequestBody } from './wire.js';
import { REQUEST_LIMIT } from './capture.js';
import { eligible, type Runtime } from './runtime.js';
import { handled, isHandled } from './undici.js';
type RequestArgs = Parameters<typeof http.request>;
type RequestCallback = (response: IncomingMessage) => void;

export function installHttp(runtime: Runtime): void {
  const httpRequest = wrapRequest(http.request, 'http:', runtime);
  const httpsRequest = wrapRequest(https.request, 'https:', runtime);
  http.request = httpRequest;
  https.request = httpsRequest;
  http.get = wrapGet(httpRequest);
  https.get = wrapGet(httpsRequest);
  syncBuiltinESMExports();
}

function wrapGet(request: typeof http.request): typeof http.get {
  return ((...args: RequestArgs) => {
    const result = request(...args);
    result.end();
    return result;
  }) as typeof http.get;
}

function wrapRequest(original: typeof http.request, protocol: 'http:' | 'https:', runtime: Runtime): typeof http.request {
  const manifestOrigin = new URL(runtime.options.url).origin;
  return ((...received: RequestArgs) => {
    const args = [...received] as unknown[];
    const callback = typeof args.at(-1) === 'function' ? args.pop() as RequestCallback : undefined;
    const startedAt = Date.now();
    const started = performance.now();
    const request = original(...args as RequestArgs);
    const capture = captureBody(request);
    const signal = cancellation(request, requestSignal(args));
    const target = connectionTarget(args, protocol, request);
    const emit = request.emit.bind(request);

    request.emit = ((event: string | symbol, ...values: unknown[]) => {
      if (event !== 'response') return emit(event, ...values);
      // The SDK's own calls, and the calls it already handles, when fetch itself runs on node:http.
      if (isHandled() || target.origin === manifestOrigin) return emit(event, ...values);
      const urls = requestUrls(request, target);
      if (urls.length === 0 || urls.some(url => runtime.excluded(url.href))) return emit(event, ...values);
      const response = values[0] as IncomingMessage;
      const status = response.statusCode ?? 0;
      const web = eligible(status) && target.replayable && urls.length === 1 && runtime.api.canHeal()
        ? convertRequest(request, urls[0]!, capture, signal) : null;
      if (!web) {
        runtime.track(request.method, () => urls[0]!.href, status, startedAt, performance.now() - started);
        return emit(event, ...values);
      }
      void handled(() => handleResponse(runtime, web, request, response, started))
        .then(healed => emit('response', healed))
        .catch(error => {
          response.destroy();
          if (!request.destroyed) request.destroy(error instanceof Error ? error : undefined);
        });
      return true;
    }) as ClientRequest['emit'];

    if (callback) request.once('response', callback);
    return request;
  }) as typeof http.request;
}

interface Converted { request: Request; body: { body: unknown; complete: boolean } }

async function handleResponse(runtime: Runtime, converted: Converted, clientRequest: ClientRequest,
  incoming: IncomingMessage, started: number): Promise<IncomingMessage> {
  const response = webResponse(incoming, converted.request.url);
  const healed = await runtime.handleResponse(converted.request, response, converted.body, performance.now() - started);
  return incomingResponse(healed, clientRequest);
}

/**
 * The fetch Request a healable call is replayed from, or null when it cannot be built
 * (a method fetch refuses, such as TRACE): the caller then gets the original response.
 */
function convertRequest(request: ClientRequest, url: URL, capture: ReturnType<typeof captureBody>,
  signal: AbortSignal): Converted | null {
  try {
    const body = capture.body();
    return { request: webRequest(request, url, body, signal), body };
  } catch { return null; }
}

// Options a fetch replay cannot carry: a retry without them would reach another
// server, or the same one without the caller's certificate, proxy or socket.
const TRANSPORT_OPTIONS = ['socketPath', 'createConnection', 'lookup', 'localAddress', 'localPort',
  'ca', 'cert', 'key', 'pfx', 'passphrase', 'servername', 'checkServerIdentity', 'secureContext',
  'ciphers', 'minVersion', 'maxVersion', 'secureOptions', 'secureProtocol'];

const customTransport = (options: Record<string, unknown>) =>
  TRANSPORT_OPTIONS.some(name => options[name] !== undefined) || options.rejectUnauthorized === false;

/**
 * An agent a fetch replay loses nothing by skipping: node's own, or a keep-alive
 * subclass such as agentkeepalive (the OpenAI and Anthropic SDKs' default). A proxy
 * agent (agent-base's `connect`, a `proxy` field, its own `createSocket`) or one
 * built with TLS or socket options is not.
 */
function plainAgent(agent: http.Agent & { options?: Record<string, unknown> }): boolean {
  if (agent === http.globalAgent || agent === https.globalAgent) return true;
  const candidate = agent as unknown as Record<string, unknown>;
  return agent instanceof http.Agent && typeof candidate.connect !== 'function' && !('proxy' in candidate) &&
    candidate.createSocket === (http.Agent.prototype as unknown as Record<string, unknown>).createSocket &&
    !customTransport(agent.options ?? {});
}

/** Where the request really connects, and whether a fetch replay would reach it the same way. */
interface Target { origin: string | null; replayable: boolean }

function connectionTarget(args: unknown[], protocol: string, request: ClientRequest): Target {
  try {
    let options: Record<string, unknown> = {};
    for (const arg of args.slice(0, 2)) {
      if (typeof arg === 'string') options = { ...urlToHttpOptions(new URL(arg)) };
      else if (arg instanceof URL) options = { ...urlToHttpOptions(arg) };
      else if (arg && typeof arg === 'object') options = { ...options, ...arg as Record<string, unknown> };
    }
    if (options.socketPath !== undefined) return { origin: null, replayable: false };
    const agent = options.agent as (http.Agent & { options?: Record<string, unknown>; defaultPort?: number }) | false | undefined;
    const standardAgent = agent === undefined || agent === false || plainAgent(agent);
    const port = Number(options.port || options.defaultPort || (agent && agent.defaultPort) || (protocol === 'https:' ? 443 : 80));
    const host = request.host.includes(':') ? `[${request.host}]` : request.host;
    const origin = new URL(`${protocol}//${host}:${port}`).origin;
    return { origin, replayable: standardAgent && !customTransport(options) };
  } catch { return { origin: null, replayable: false }; }
}

/**
 * The URL the request connects to, then the one its Host header names when that differs.
 * Both are filtered; only a request whose two agree is healed, so a retry can never go
 * to the Host header's server while the original went to another.
 */
function requestUrls(request: ClientRequest, target: Target): URL[] {
  const urls: URL[] = [];
  try {
    if (target.origin) urls.push(new URL(request.path, target.origin));
    const header = request.getHeader('host');
    if (header !== undefined) {
      const named = new URL(request.path, `${new URL(target.origin ?? 'http://localhost').protocol}//${String(header)}`);
      if (!target.origin || named.origin !== target.origin) urls.push(named);
    }
  } catch { /* an unreadable address is neither filtered nor healed */ }
  return urls;
}

function webRequest(request: ClientRequest, url: URL, captured: { body: unknown; complete: boolean }, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const name of request.getHeaderNames()) {
    const value = request.getHeader(name);
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) headers.append(name, String(item));
    }
  }
  const method = request.method;
  return new Request(url, {
    method, headers, signal,
    body: ['GET', 'HEAD'].includes(method) || !captured.complete || captured.body === null
      ? undefined : serializeRequestBody(captured.body, headers.get('content-type')),
  });
}

function webResponse(response: IncomingMessage, url: string): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) headers.append(name, String(item));
    }
  }
  const encoding = headers.get('content-encoding')?.toLowerCase();
  let body: Readable = response;
  if (encoding === 'gzip' || encoding === 'x-gzip' || encoding === 'deflate') {
    body = response.pipe(createUnzip());
    headers.delete('content-encoding');
    headers.delete('content-length');
  } else if (encoding === 'br') {
    body = response.pipe(createBrotliDecompress());
    headers.delete('content-encoding');
    headers.delete('content-length');
  }
  const converted = new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>,
    { status: response.statusCode, statusText: response.statusMessage, headers });
  Object.defineProperty(converted, 'url', { value: url });
  return converted;
}

function incomingResponse(response: Response, request: ClientRequest): IncomingMessage {
  const stream = response.body
    ? Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>)
    : Readable.from([]);
  const headers: IncomingHttpHeaders = {};
  for (const [name, value] of response.headers) headers[name] = value;
  if (['gzip', 'x-gzip', 'deflate', 'br'].includes(String(headers['content-encoding']).toLowerCase())) {
    delete headers['content-encoding'];
    delete headers['content-length'];
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  const rawHeaders = Object.entries(headers).flatMap(([name, value]) =>
    (Array.isArray(value) ? value : [value]).flatMap(item => item === undefined ? [] : [name, String(item)]));
  return Object.assign(stream, {
    statusCode: response.status,
    statusMessage: response.statusText,
    headers,
    rawHeaders,
    trailers: {},
    rawTrailers: [],
    httpVersion: '1.1',
    httpVersionMajor: 1,
    httpVersionMinor: 1,
    complete: true,
    req: request,
  }) as unknown as IncomingMessage;
}

function captureBody(request: ClientRequest) {
  let chunks: Buffer[] = [];
  let size = 0;
  let complete = true;
  const record = (chunk: unknown, encoding?: BufferEncoding) => {
    if (chunk === undefined || chunk === null || typeof chunk === 'function' || !complete) return;
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;
    if (size > REQUEST_LIMIT) { complete = false; chunks = []; return; }
    chunks.push(bytes);
  };
  const write = request.write;
  request.write = ((...args: unknown[]) => {
    record(args[0], typeof args[1] === 'string' ? args[1] as BufferEncoding : undefined);
    return Reflect.apply(write, request, args);
  }) as ClientRequest['write'];
  const end = request.end;
  request.end = ((...args: unknown[]) => {
    record(args[0], typeof args[1] === 'string' ? args[1] as BufferEncoding : undefined);
    return Reflect.apply(end, request, args);
  }) as ClientRequest['end'];
  return { body: () => {
    if (!complete) return { body: null, complete: false };
    const header = request.getHeader('content-type');
    const contentType = Array.isArray(header) ? header[0] : header === undefined ? undefined : String(header);
    const parsed = parseRequestBody(Buffer.concat(chunks, size), contentType);
    return { body: parsed.body, complete: parsed.valid };
  } };
}

function requestSignal(args: unknown[]): AbortSignal | undefined {
  for (const value of args.slice(0, 2)) {
    if (value && typeof value === 'object' && 'signal' in value && value.signal instanceof AbortSignal) return value.signal;
  }
}

function cancellation(request: ClientRequest, external?: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const destroy = request.destroy.bind(request);
  request.destroy = ((error?: Error) => {
    if (!controller.signal.aborted) controller.abort(error);
    return destroy(error);
  }) as ClientRequest['destroy'];
  return external ? AbortSignal.any([external, controller.signal]) : controller.signal;
}
