import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Loads `scripts/demo.env` into `process.env` so the demo tools work in any
 * shell (PowerShell, cmd, or Bash) without `source`. Lines look like
 * `export NAME=value` or `NAME=value`; `#` starts a comment. Variables that are
 * already set in the environment win, so one-off overrides still work.
 */
export function loadDemoEnv(file = join(process.cwd(), "scripts", "demo.env")): string | null {
  if (!existsSync(file)) return null;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const [, name, rawValue] = match as unknown as [string, string, string];
    const value = rawValue.trim().replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[name] === undefined) process.env[name] = value;
  }
  return file;
}
