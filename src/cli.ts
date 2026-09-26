import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { VERSION } from "./api.js";
import { isObject } from "./wire.js";

export type CheckStatus = "ok" | "fail" | "warn" | "skip";

export interface DoctorCheck {
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  ok: boolean;
}

export interface DoctorDeps {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  /** Overrides the version resolved from the project's `node_modules`. */
  sdkVersion?: string;
}

export interface DoctorOptions extends DoctorDeps {
  url?: string;
}

const DEFAULT_URL = "https://api.manifest.build";
const REQUEST_TIMEOUT_MS = 10_000;

const symbols: Record<CheckStatus, string> = {
  ok: "✅",
  fail: "❌",
  warn: "⚠️",
  skip: "➖",
};

/** Reveal a known key prefix and the last four characters, never the key. */
export function maskKey(key: string): string {
  const tail = key.slice(-4);
  if (key.length <= tail.length + 2) return "…";
  const prefix = /^(?:mnfst(?:_[a-z]+)*_)/i.exec(key)?.[0] ?? key.slice(0, 4);
  const head = prefix.length + tail.length < key.length ? prefix : "";
  return `${head}…${tail}`;
}

type ProbeResult =
  | { kind: "valid"; project?: string; requests?: number }
  | { kind: "invalid"; detail: string }
  | { kind: "error"; detail: string };

function normalizeBase(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url.toString();
  } catch {
    return null;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    return text.length > 1_000_000 ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

function projectName(body: unknown): string | undefined {
  if (!isObject(body)) return undefined;
  const candidate =
    body.project ?? body.projectName ?? body.project_name ?? body.name;
  if (typeof candidate === "string" && candidate.trim())
    return candidate.trim();
  if (
    isObject(candidate) &&
    typeof candidate.name === "string" &&
    candidate.name.trim()
  )
    return candidate.name.trim();
  return undefined;
}

function requestCount(body: unknown): number | undefined {
  if (!isObject(body)) return undefined;
  const candidate =
    body.requests ??
    body.requestCount ??
    body.requestsCount ??
    body.requests_count ??
    body.request_count;
  if (typeof candidate === "number") return candidate;
  if (isObject(candidate) && typeof candidate.total === "number")
    return candidate.total;
  return undefined;
}

function headers(key: string): Record<string, string> {
  return {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    "user-agent": `mnfst-node/${VERSION}`,
  };
}

/** One round trip against the handshake endpoint: the only check that tells a
 * good key from a revoked one, which both look like silence otherwise. */
async function probe(
  url: string,
  key: string,
  doFetch: typeof globalThis.fetch
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await doFetch(new URL("v1/hello", url), {
      method: "POST",
      headers: headers(key),
      // `probe` marks this a key check, not a boot: the server answers but
      // records no install. Without it, running doctor from a laptop makes
      // the dashboard claim the app is connected — while doctor is printing
      // "manifest is not installed in this project" two lines above.
      body: JSON.stringify({ probe: true }),
      signal: controller.signal,
      redirect: "error",
    });
    const body = await readJson(response);
    if (response.status === 200)
      return {
        kind: "valid",
        project: projectName(body),
        requests: requestCount(body),
      };
    if (response.status === 401)
      return { kind: "invalid", detail: "the key was rejected (401)" };
    if (response.status === 403)
      return {
        kind: "invalid",
        detail:
          isObject(body) && body.error === "project_disabled"
            ? "the key is valid but the project is disabled (403)"
            : "the key was rejected (403)",
      };
    return {
      kind: "error",
      detail: `unexpected response (${response.status})`,
    };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    return {
      kind: "error",
      detail: `${timedOut ? "timed out" : "could not be reached"} at ${url}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function installedVersion(cwd: string): string | undefined {
  try {
    const entry = createRequire(path.join(cwd, "package.json")).resolve(
      "manifest"
    );
    let dir = path.dirname(entry);
    while (true) {
      const manifest = path.join(dir, "package.json");
      if (existsSync(manifest)) {
        const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === "manifest" && pkg.version) return pkg.version;
      }
      const parent = path.dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  } catch {
    return undefined;
  }
}

async function nearestPackage(
  cwd: string
): Promise<{ dir: string; pkg: Record<string, unknown> } | undefined> {
  let dir = path.resolve(cwd);
  while (true) {
    const file = path.join(dir, "package.json");
    if (existsSync(file)) {
      try {
        return {
          dir,
          pkg: JSON.parse(await readFile(file, "utf8")) as Record<
            string,
            unknown
          >,
        };
      } catch {
        return undefined;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const instrumentationFiles = [
  "instrumentation.ts",
  "instrumentation.js",
  "instrumentation.mjs",
  "src/instrumentation.ts",
  "src/instrumentation.js",
  "src/instrumentation.mjs",
];

async function loadCheck(cwd: string): Promise<DoctorCheck> {
  const label = "Loads before your app";
  const found = await nearestPackage(cwd);
  if (!found)
    return {
      label,
      status: "warn",
      detail: "no package.json found; cannot tell how Manifest loads",
    };
  const scripts = isObject(found.pkg.scripts) ? found.pkg.scripts : {};
  const values = Object.values(scripts).filter(
    (value): value is string => typeof value === "string"
  );
  if (values.some((value) => value.includes("manifest/register")))
    return {
      label,
      status: "ok",
      detail: "a script preloads manifest/register",
    };

  const dependencies = {
    ...(isObject(found.pkg.dependencies) ? found.pkg.dependencies : {}),
    ...(isObject(found.pkg.devDependencies) ? found.pkg.devDependencies : {}),
  };
  if ("next" in dependencies) {
    for (const relative of instrumentationFiles) {
      const file = path.join(found.dir, relative);
      if (!existsSync(file)) continue;
      if (/manifest/.test(await readFile(file, "utf8")))
        return {
          label,
          status: "ok",
          detail: `${relative} installs Manifest before the app runs`,
        };
    }
    return {
      label,
      status: "fail",
      detail:
        'package.json "start" relies on Next.js with no NODE_OPTIONS and no instrumentation file — Manifest will not load',
    };
  }

  // Manifest is normally installed by a `manifest()` call in the entry file,
  // which this cannot see without reading the app's source. So an install it
  // cannot find is unproven, not broken: it warns, and "Requests received"
  // below is what settles the question. Only Next.js above can fail here,
  // because there the absent instrumentation file IS the proof.
  const start = scripts.start;
  if (typeof start === "string" && start.trim())
    return {
      label,
      status: "warn",
      detail: "cannot tell from here whether manifest() runs; check Requests received",
    };
  return {
    label,
    status: "warn",
    detail:
      "no start script found; cannot confirm Manifest loads before your app",
  };
}

function sdkCheck(cwd: string, injected?: string): DoctorCheck {
  const label = "SDK installed";
  const version = injected ?? installedVersion(cwd);
  if (!version)
    return {
      label,
      status: "fail",
      detail: "manifest is not installed in this project",
    };
  return { label, status: "ok", detail: `manifest ${version}` };
}

/** Every check `manifest doctor` runs, as data, so it can be tested and
 * rendered without a terminal. */
export async function runDoctor(
  options: DoctorOptions = {}
): Promise<DoctorReport> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const doFetch = options.fetch ?? globalThis.fetch;
  const checks: DoctorCheck[] = [sdkCheck(cwd, options.sdkVersion)];

  const rawUrl = options.url ?? env.MNFST_URL ?? DEFAULT_URL;
  const url = normalizeBase(rawUrl);
  const key = env.MNFST_KEY;

  if (!key) {
    checks.push({
      label: "MNFST_KEY set",
      status: "fail",
      detail: "MNFST_KEY is not set",
    });
  } else {
    checks.push({ label: "MNFST_KEY set", status: "ok", detail: maskKey(key) });
  }

  let requests: number | undefined;
  if (!url) {
    checks.push({
      label: "Key valid",
      status: "fail",
      detail: `invalid Manifest URL: ${rawUrl}`,
    });
  } else if (!key) {
    checks.push({ label: "Key valid", status: "skip", detail: "" });
  } else {
    const result = await probe(url, key, doFetch);
    if (result.kind === "valid") {
      requests = result.requests;
      checks.push({
        label: "Key valid",
        status: "ok",
        detail: result.project
          ? `project "${result.project}"`
          : "the server accepted the key",
      });
    } else {
      checks.push({
        label: "Key valid",
        status: "fail",
        detail: result.detail,
      });
    }
  }

  checks.push(await loadCheck(cwd));

  if (requests !== undefined) {
    checks.push({
      label: "Requests received",
      status: requests > 0 ? "ok" : "warn",
      detail:
        requests > 0
          ? `${requests} request${requests === 1 ? "" : "s"} received`
          : "no requests received yet",
    });
  }

  return { checks, ok: checks.every((check) => check.status !== "fail") };
}

function wrap(text: string, width: number): string[] {
  if (!text) return [""];
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function render(report: DoctorReport): string {
  const width = Math.max(
    20,
    ...report.checks.map((check) => check.label.length)
  );
  const lines: string[] = [];
  for (const check of report.checks) {
    const left = `  ${symbols[check.status]} ${check.label.padEnd(width)}`;
    const detail = wrap(check.detail, Math.max(24, 96 - left.length - 2));
    lines.push(`${left}  ${detail[0] ?? ""}`.trimEnd());
    for (const extra of detail.slice(1))
      lines.push(`${" ".repeat(left.length + 2)}${extra}`);
  }
  lines.push("");
  lines.push("Runtime coverage");
  lines.push(
    "  Node.js runtime   fetch, http.request, https.request, http.get are patched; undici is tracked"
  );
  lines.push(
    "  Edge runtime      not supported — middleware.ts and Edge route handlers are never covered"
  );
  return `${lines.join("\n")}\n`;
}

interface Args {
  command?: string;
  url?: string;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { help: false, version: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "-h" || arg === "--help") args.help = true;
    else if (arg === "-v" || arg === "--version") args.version = true;
    else if (arg === "--url") {
      const value = argv[++index];
      if (!value) throw new Error("--url needs a value");
      args.url = value;
    } else if (arg.startsWith("--url=")) args.url = arg.slice("--url=".length);
    else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    else if (args.command === undefined) args.command = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  return args;
}

const HELP = `Usage: manifest <command> [options]

Commands
  doctor              Check that this project is wired up to Manifest

Options
  --url <url>         Manifest API base URL (default: $MNFST_URL)
  -h, --help          Show this help
  -v, --version       Print the SDK version

Examples
  npx manifest doctor
  npx manifest doctor --url=https://api.manifest.build
`;

export async function main(
  argv: string[] = process.argv.slice(2)
): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(HELP);
    return 1;
  }
  if (args.version) {
    console.log(VERSION);
    return 0;
  }
  if (args.help || !args.command) {
    console.log(HELP);
    return 0;
  }
  if (args.command !== "doctor") {
    console.error(`Unknown command: ${args.command}`);
    console.error(HELP);
    return 1;
  }
  const report = await runDoctor({ url: args.url });
  process.stdout.write(render(report));
  return report.ok ? 0 : 1;
}
