#!/usr/bin/env node
// Runs Vitest from the properly cased working directory. On Windows, a shell whose
// working directory has a lowercase drive letter (c:\ instead of C:\) makes Vitest load
// itself twice and fail with "failed to find the current suite".
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";

const cwd = realpathSync.native(process.cwd());
const cli = join(cwd, "node_modules", "vitest", "vitest.mjs");
const result = spawnSync(process.execPath, [cli, "run", ...process.argv.slice(2)], { cwd, stdio: "inherit" });
process.exit(result.status ?? 1);
