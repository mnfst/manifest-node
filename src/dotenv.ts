import { readFileSync } from "node:fs";
import path from "node:path";

export interface DotEnvValues {
  MNFST_KEY?: string;
  MNFST_URL?: string;
}

/** Next.js loads these into the app at boot; other frameworks reach for
 * `dotenv` or `node --env-file`. `.env.local` overrides `.env`, matching how
 * Next.js itself layers them. */
const FILES = [".env.local", ".env"] as const;

const LINE = /^\s*(?:export\s+)?(MNFST_KEY|MNFST_URL)\s*=(.*)$/;

/** A quoted value up to its closing quote; an unquoted one up to a ` #` comment. */
function value(raw: string): string {
  const trimmed = raw.trim();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    return end === -1 ? trimmed.slice(1) : trimmed.slice(1, end);
  }
  const hash = trimmed.indexOf(" #");
  return (hash === -1 ? trimmed : trimmed.slice(0, hash)).trim();
}

/** The MNFST_KEY and MNFST_URL a project keeps in its dotenv files. The doctor
 * runs on its own, outside the app that would normally load them, so it reads
 * them itself. Only plain `NAME=value` lines: nothing is evaluated or
 * expanded. */
export function readDotEnv(cwd: string): DotEnvValues {
  const found: DotEnvValues = {};
  for (const file of FILES) {
    let contents: string;
    try {
      contents = readFileSync(path.join(cwd, file), "utf8");
    } catch {
      continue;
    }
    for (const line of contents.split(/\r?\n/)) {
      const match = LINE.exec(line);
      if (!match) continue;
      const name = match[1] as keyof DotEnvValues;
      if (found[name] !== undefined) continue; // an earlier file wins
      const parsed = value(match[2] ?? "");
      if (parsed) found[name] = parsed;
    }
  }
  return found;
}
