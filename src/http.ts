import http, { type ClientRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { Readable } from 'node:stream';
import { createBrotliDecompress, createUnzip } from 'node:zlib';
import { parseRequestBody, serializeRequestBody } from './wire.js';
import { REQUEST_LIMIT } from './capture.js';
import { eligible, type Runtime } from './runtime.js';
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
  return ((...received: RequestArgs) => {
    const args = [...received] as unknown[];
    const callback = typeof args.at(-1) === 'function' ? args.pop() as RequestCallback : undefined;
    const started = performance.now();
    const request = original(...args as RequestArgs);
    const capture = captureBody(request);
    const signal = cancellation(request, requestSignal(args));
    const emit = request.emit.bind(request);

    request.emit = ((event: string | symbol, ...values: unknown[]) => {
      if (event !== 'response') return emit(event, ...values);
      const response = values[0] as IncomingMessage;
      if (!eligible(response.statusCode ?? 0) || !runtime.api.enabled()) {
        return emit(event, ...values);
      }
      void handleResponse(runtime, request, response, protocol, capture.body(), signal, started)
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

async function handleResponse(runtime: Runtime, clientRequest: ClientRequest, incoming: IncomingMessage,
  protocol: string, body: { body: unknown; complete: boolean }, signal: AbortSignal, started: number): Promise<IncomingMessage> {
  const request = webRequest(clientRequest, protocol, body, signal);
  const response = webResponse(incoming, request.url);
  const healed = await runtime.handleResponse(request, response, body, performance.now() - started);
  return incomingResponse(healed, clientRequest);
}

function webRequest(request: ClientRequest, protocol: string, captured: { body: unknown; complete: boolean }, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const name of request.getHeaderNames()) {
    const value = request.getHeader(name);
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) headers.append(name, String(item));
    }
  }
  const authority = String(request.getHeader('host') ?? request.host);
  const url = new URL(request.path, `${protocol}//${authority}`);
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
