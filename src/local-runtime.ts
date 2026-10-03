import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join, delimiter } from "node:path";
import { installedRuntime, installRuntime } from "./runtime.js";
import { run } from "./process.js";

export async function localRuntime(options, signal?: AbortSignal) {
  if (options.runtime || process.env.HIBANA_RUNTIME_BIN) return options.runtime || process.env.HIBANA_RUNTIME_BIN;
  const installed = await installedRuntime();
  if (installed) return installed;
  for (const directory of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, "hibana-worker");
    try { await access(candidate, constants.X_OK); return candidate; } catch {}
  }
  console.error("Local Hibana runtime not found. Downloading the compatible local runtime...");
  return installRuntime({}, { signal, log: console.error });
}

export async function requireManagedSql(runtime: string, signal?: AbortSignal, admin = false) {
  try {
    const result = await run(runtime, ["--capabilities"], { capture: true, signal, timeout: 10000 }) as { stdout: string };
    const capabilities = JSON.parse(result.stdout);
    if (capabilities.managed_sql === 1 && (!admin || capabilities.managed_sql_admin === 1)) return;
  } catch (error) { if (signal?.aborted) throw error; }
  throw new Error("This local runtime does not support the requested managed SQLite operation. Install a compatible runtime or set HIBANA_RUNTIME_BIN / --runtime to the updated hibana-worker.");
}
