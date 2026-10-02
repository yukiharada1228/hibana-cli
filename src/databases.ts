import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, join } from "node:path";
import { apiClient, ApiError, findComponent } from "./api.js";
import { readConfigFile, validateDatabases } from "./config.js";
import { resolve } from "node:path";
import { confirm } from "./confirm.js";
import { migrationStatements } from "./migrations.js";
import { run } from "./process.js";
import { localRuntime, requireManagedSql } from "./local-runtime.js";
import { text } from "./output.js";
import { sameRevision } from "./file-snapshot.js";

const MAX_BYTES = 256 * 1024;
const validId = (id: string) => /^db_[a-f0-9]{32}$/.test(id);
const validName = (name: string) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name);
export async function migrationFile(path: string) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK || 0));
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) throw new Error("Migration must be a regular file");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await file.read(bytes, total, bytes.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > MAX_BYTES) throw new Error("Migration exceeds 256 KiB");
    if (BigInt(total) !== before.size || !sameRevision(before, await file.stat({ bigint: true }))) throw new Error("Migration changed while reading; retry with a stable file");
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, total)); }
    catch { throw new Error("Migration must contain valid UTF-8"); }
  } finally { await file.close(); }
}
export function validateQuery(query) {
  if (query.statements.length < 1 || query.statements.length > 32) throw new Error("A batch must contain 1..32 statements");
  for (const statement of query.statements) {
    if (typeof statement.sql !== "string" || !statement.sql.trim() || statement.sql.includes("\0") || Buffer.byteLength(statement.sql) > 65536 || !Array.isArray(statement.params) || statement.params.length > 100)
      throw new Error("SQL must be 1..65536 bytes with at most 100 parameters");
    for (const value of statement.params) {
      if (value === null || typeof value === "string" || typeof value === "boolean") continue;
      if (typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) continue;
      if (Array.isArray(value) && value.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) continue;
      throw new Error("Parameters must be strings, finite numbers (safe integers), booleans, null or byte arrays");
    }
  }
  if (query.migration !== undefined && !validName(query.migration)) throw new Error("Invalid migration filename");
  if (Buffer.byteLength(JSON.stringify(query)) > MAX_BYTES) throw new Error("SQL request exceeds 256 KiB");
  return query;
}

export async function databaseCommand(args, options, signal?: AbortSignal) {
  const [action, target] = args;
  if (action === "create" && !validName(target)) throw new Error("Invalid database name (1..128 letters, digits, _, - or .)");
  if (action === "delete" && !validId(target)) throw new Error("Expected a database ID");
  if (["list", "create", "delete"].includes(action)) {
    if (action === "delete" && !await confirm(`Delete database ${target}?`, Boolean(options.yes), signal)) return;
    const api = await apiClient(options);
    return api.request(action === "delete" ? `/databases/${target}` : "/databases", {
      method: action === "list" ? "GET" : action === "create" ? "POST" : "DELETE",
      ...(action === "create" ? { body: { name: target } } : {}), signal,
    });
  }
  const configPath = resolve(options.config || "hibana.json");
  const config = await readConfigFile(configPath);
  const bindings = validateDatabases(config.databases, config.vars || {}, config.secrets || []);
  if (config.assets) throw new Error("Static sites cannot use database bindings; use a Hono API");
  if (!Object.hasOwn(bindings, target)) throw new Error("Binding is missing from hibana.json databases");
  const id = bindings[target];
  if (["grant", "revoke"].includes(action)) {
    const api = await apiClient(options);
    let component = await findComponent(api, config.name, { signal });
    if (!component && action === "grant") {
      try { component = await api.request("/components", { method: "POST", body: { name: config.name }, signal }); }
      catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409) throw error;
        component = await findComponent(api, config.name, { signal });
        if (!component) throw error;
      }
    }
    if (!component) throw new Error("Application does not exist");
    return api.request(`/databases/${id}/grants/${encodeURIComponent(component.component_id)}`, {
      method: action === "grant" ? "PUT" : "DELETE", signal,
      ...(action === "grant" ? { body: { read_only: Boolean(options["read-only"]) } } : {}),
    });
  }
  if (!["query", "migrate"].includes(action)) throw new Error("Unknown database command");
  if (Boolean(options.local) === Boolean(options.remote)) throw new Error("Choose exactly one of --local or --remote");
  if (options.local && (options.profile || options.url)) throw new Error("Local SQL does not accept a remote profile or URL");
  if (options.remote && options.runtime) throw new Error("--runtime is only used with --local");
  let query;
  if (action === "migrate") {
    if (!options.file) throw new Error("--file is required");
    query = { statements: migrationStatements(await migrationFile(options.file)), migration: basename(options.file) };
  } else {
    if (!options.sql) throw new Error("--sql is required");
    let params;
    try { params = JSON.parse(options.params || "[]"); } catch { throw new Error("--params must be a JSON array"); }
    query = { statements: [{ sql: options.sql, params }] };
  }
  validateQuery(query);
  if (options.local) {
    const runtime = await localRuntime(options, signal);
    await requireManagedSql(runtime, signal);
    const input = JSON.stringify({ directory: join(configPath, "..", ".hibana/databases"), id, query });
    try {
      const result = await run(runtime, ["--dev-sql"], { input, capture: true, signal, timeout: 15000 }) as { stdout: string; stderr: string };
      return JSON.parse(result.stdout);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(`Local SQLite operation failed: ${text(error.stderr?.slice(0, 4096) || error.message)}. Stop hibana dev before local SQL operations.`, { cause: error });
    }
  }
  const api = await apiClient(options);
  console.error(`Database target: ${text(api.url)} · ${id}`);
  return api.request(`/databases/${id}/query`, { method: "POST", body: query, signal });
}
