import { errorBody, parseJson } from './wire.js';
export const REQUEST_LIMIT = 262_144;
export const RESPONSE_LIMIT = 65_536;
const CAPTURE_MS = 1000;

type Read = ReadableStreamReadResult<Uint8Array>;
async function prefix(reader: ReadableStreamDefaultReader<Uint8Array>, limit: number, timeoutMs: number) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let pending: Promise<Read> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); });
  let complete = false;
  try {
    while (size <= limit) {
      pending = reader.read();
      const read = await Promise.race([pending, deadline]);
      if (read === null) break;
      pending = undefined;
      if (read.done) { complete = true; break; }
      chunks.push(read.value); size += read.value.byteLength;
    }
  } catch {
    // Retain the rejected read for the caller's stream, rather than hiding it.
  } finally { clearTimeout(timer); }
  return { chunks, complete, pending, bytes: Buffer.concat(chunks, size).subarray(0, limit) };
}

export async function captureRequest(request: Request): Promise<{ body: unknown; complete: boolean }> {
  if (!request.body) return { body: null, complete: true };
  const clone = request.clone();
  const reader = clone.body!.getReader();
  try {
    const result = await prefix(reader, REQUEST_LIMIT, CAPTURE_MS);
    return { body: result.complete ? parseJson(result.bytes) : null, complete: result.complete };
  } finally { void reader.cancel().catch(() => {}); }
}

function metadata(response: Response, original: Response): Response {
  const clone = response.clone.bind(response);
  Object.defineProperties(response, {
    url: { value: original.url }, redirected: { value: original.redirected }, type: { value: original.type },
    clone: { value: () => metadata(clone(), original) },
  });
  return response;
}

export async function captureResponse(original: Response, limit = RESPONSE_LIMIT, timeoutMs = CAPTURE_MS) {
  if (!original.body) return { response: original, body: null, truncated: false, complete: true };
  const reader = original.body.getReader();
  const captured = await prefix(reader, limit, timeoutMs);
  let index = 0;
  let pending = captured.pending;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (index < captured.chunks.length) { controller.enqueue(captured.chunks[index++]!); return; }
        const read = await (pending ?? reader.read()); pending = undefined;
        if (read.done) { reader.releaseLock(); controller.close(); } else controller.enqueue(read.value);
      } catch (error) { controller.error(error); }
    },
    async cancel(reason) { await reader.cancel(reason); },
  }, { highWaterMark: 0 });
  const response = metadata(new Response(stream, {
    status: original.status, statusText: original.statusText, headers: original.headers,
  }), original);
  return { response, body: errorBody(captured.bytes), truncated: !captured.complete || Buffer.byteLength(Buffer.from(captured.bytes).toString('utf8')) > limit, complete: captured.complete };
}
