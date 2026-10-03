import { open, mkdir, opendir, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { basename, dirname, join } from "node:path";
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
const validId = (id: string) => typeof id === "string" && /^db_[a-f0-9]{32}$/.test(id);
const validName = (name: string) => typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name);
export async function migrationFile(path: string, noFollow = false) {
  const expected = noFollow ? await lstat(path, { bigint: true }) : undefined;
  if (expected && (!expected.isFile() || expected.isSymbolicLink())) throw new Error("Migration must be a regular file");
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK || 0) | (noFollow ? constants.O_NOFOLLOW || 0 : 0));
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) throw new Error("Migration must be a regular file");
    if (expected && !sameRevision(expected, before)) throw new Error("Migration changed while reading; retry with a stable file");
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

export async function databaseContext(target, options, signal?: AbortSignal) {
  const configPath = resolve(options.config || "hibana.json"), root = dirname(configPath);
  let config;
  try { config = await readConfigFile(configPath); }
  catch (error) {
    if (options.config || error.cause?.code !== "ENOENT") throw error;
    config = { name: "", databases: {} };
  }
  if (config.assets) throw new Error("Static sites cannot use database bindings; use a Hono API");
  const bindings = validateDatabases(config.databases, config.vars || {}, config.secrets || []);
  let id = Object.hasOwn(bindings, target) ? bindings[target] : validId(target) ? target : undefined;
  if (!id && options.remote && validName(target)) {
    const api = await apiClient(options);
    const result = await api.request("/databases", { signal });
    const rows = result.databases?.filter(row => row.name === target && row.status !== "deleted");
    if (rows?.length === 1 && validId(rows[0].id)) id = rows[0].id;
  }
  if (!id) throw new Error("Binding is missing from hibana.json databases; use a binding, database ID or remote database name");
  return { id, root, config };
}
export function selectTarget(options) {
  if (Boolean(options.local) === Boolean(options.remote)) throw new Error("Choose exactly one of --local or --remote");
  if (options.local && (options.profile || options.url)) throw new Error("Local SQL does not accept a remote profile or URL");
  if (options.remote && (options.runtime || options["persist-to"])) throw new Error("--runtime and --persist-to are only used with --local");
}
export async function localOperation(context, options, operation, signal?: AbortSignal) {
  const runtime = await localRuntime(options, signal);
  await requireManagedSql(runtime, signal, Boolean(operation.import || operation.export || operation.schema));
  const directory = resolve(options["persist-to"] || join(context.root, ".hibana/databases"));
  const input = JSON.stringify({ directory, id: context.id, ...operation });
  try {
    const result = await run(runtime, ["--dev-sql"], { input, capture: true, signal, timeout: operation.import || operation.export ? 120000 : 15000 }) as { stdout: string; stderr: string };
    return JSON.parse(result.stdout);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Local SQLite operation failed: ${text(error.stderr?.slice(0, 4096) || error.message)}. Stop hibana dev before local SQL operations.`, { cause: error });
  }
}
async function execute(context, options, query, signal?: AbortSignal) {
  validateQuery(query);
  if (options.local) return localOperation(context, options, { query }, signal);
  const api = await apiClient(options);
  console.error(`Database target: ${text(api.url)} · ${context.id}`);
  return api.request(`/databases/${context.id}/query`, { method: "POST", body: query, signal });
}
async function history(context, options, signal?: AbortSignal) {
  const rows = options.local ? await localOperation(context, options, { migrations: true }, signal)
    : await (await apiClient(options)).request(`/databases/${context.id}/migrations`, { signal });
  if (!Array.isArray(rows) || rows.length > 10000 || rows.some(row => !row || !validName(row.name) || !/^[a-f0-9]{64}$/.test(row.checksum))) throw new Error("Invalid migration history response");
  return new Map<string, any>(rows.map(row => [row.name, row]));
}
async function migrationFiles(directory, contents: boolean) {
  let before;
  try { before = await lstat(directory, { bigint: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("Migrations directory must be a regular directory");
  const files: { name: string; query?: any; checksum?: string }[] = [];
  let total = 0, entries = 0;
  for await (const entry of await opendir(directory)) {
    if (++entries > 4096) throw new Error("Too many entries in migrations directory");
    if (!entry.name.endsWith(".sql")) continue;
    if (!entry.isFile() || !validName(entry.name)) throw new Error("Migrations must be regular .sql files with simple filenames");
    if (files.length >= 1024) throw new Error("At most 1024 migration files are supported");
    const file: { name: string; query?: any; checksum?: string } = { name: entry.name };
    if (contents) {
      const sql = await migrationFile(join(directory, entry.name), true);
      total += Buffer.byteLength(sql);
      if (total > 8 * 1024 * 1024) throw new Error("Migrations exceed 8 MiB in total");
      file.query = { statements: migrationStatements(sql), migration: entry.name };
      if (file.query.statements.length) validateQuery(file.query);
      file.checksum = createHash("sha256").update(JSON.stringify(file.query.statements)).digest("hex");
    }
    files.push(file);
  }
  if (!sameRevision(before, await lstat(directory, { bigint: true }))) throw new Error("Migrations directory changed while reading; retry with stable files");
  return files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
async function migrations(args, options, signal?: AbortSignal) {
  const [action, target, name] = args;
  if (action !== "create") selectTarget(options);
  const context = await databaseContext(target, options, signal);
  const directory = resolve(context.root, options["migrations-dir"] || "migrations");
  if (action === "create") {
    if (!validName(name) || name.length > 110) throw new Error("Migration name must be 1..110 letters, digits, _, - or .");
    await mkdir(directory, { recursive: true });
    for (let attempt = 0; attempt < 10; attempt++) {
      const files = await migrationFiles(directory, false);
      const last = Math.max(0, ...files.map(file => Number(/^(\d+)_/.exec(file.name)?.[1] || 0)));
      if (!Number.isSafeInteger(last) || last >= 999999999) throw new Error("Migration sequence is exhausted");
      const filename = `${String(last + 1).padStart(4, "0")}_${name.replace(/\.sql$/, "")}.sql`;
      let file;
      try { file = await open(join(directory, filename), "wx", 0o600); }
      catch (error) { if (error.code === "EEXIST") continue; throw error; }
      try { await file.writeFile("-- Add SQL statements below. This file runs as one transaction.\n"); }
      finally { await file.close(); }
      return { file: join(directory, filename) };
    }
    throw new Error("Migrations directory is changing; retry creation");
  }
  const files = await migrationFiles(directory, true);
  if (action === "apply") for (const file of files) {
    try { validateQuery(file.query); } catch (error) { throw new Error(`${file.name}: ${error.message}`, { cause: error }); }
  }
  const applied = await history(context, options, signal);
  for (const file of files) {
    if (applied.has(file.name) && applied.get(file.name).checksum !== file.checksum) throw new Error(`Applied migration has a different checksum: ${file.name}`);
  }
  const pending = files.filter(file => !applied.has(file.name));
  if (action === "list") return { migrations: files.map(file => ({ name: file.name, status: applied.has(file.name) ? "applied" : "pending", ...(applied.has(file.name) ? { applied_at: applied.get(file.name).applied_at } : {}) })), applied_missing_locally: [...applied.keys()].filter(name => !files.some(file => file.name === name)) };
  if (action !== "apply") throw new Error("Unknown migration command");
  if (!pending.length) return { applied: [], message: "No pending migrations" };
  console.error(`Pending migrations (${options.local ? "local" : "remote"}, ${context.id}):\n${pending.map(file => `  ${file.name}`).join("\n")}`);
  if (!await confirm("Apply these migrations?", Boolean(options.yes), signal)) return;
  const completed: string[] = [];
  for (const file of pending) {
    signal?.throwIfAborted();
    try { await execute(context, options, file.query, signal); }
    catch (error) { throw new Error(`Migration ${file.name} failed after ${completed.length} applied file(s): ${error.message}`, { cause: error }); }
    completed.push(file.name);
  }
  return { applied: completed };
}
export async function databaseCommand(args, options, signal?: AbortSignal) {
  const [action, target] = args;
  if (action === "migrations") return migrations(args.slice(1), options, signal);
  if (action === "export" || (action === "execute" && options.file)) {
    const transfer = await import("./database-transfer.js");
    return action === "export" ? transfer.exportSql(target, options, signal) : transfer.importSql(target, options, signal);
  }
  if (action === "time-travel" || action === "insights") {
    const admin = await import("./database-admin.js");
    return action === "time-travel" ? admin.timeTravel(args.slice(1), options, signal) : admin.insights(target, options, signal);
  }
  if (action === "create" && !validName(target)) throw new Error("Invalid database name (1..128 letters, digits, _, - or .)");
  if (action === "create") return (await import("./database-create.js")).createDatabase(target, options, signal);
  if (["list", "create", "delete", "info"].includes(action)) {
    if (["delete", "info"].includes(action) && !validName(target)) throw new Error("Expected a database name, binding or ID");
    // Preserve cancellation before any request when the caller already has an ID.
    if (action === "delete" && validId(target) && !await confirm(`Delete database ${target}?`, Boolean(options.yes), signal)) return;
    const api = await apiClient(options);
    let id = target;
    if (action === "info" || (action === "delete" && !validId(target))) {
      const result = await api.request("/databases", { signal });
      let binding;
      try { const config = await readConfigFile(options.config); const bindings = validateDatabases(config.databases, config.vars || {}, config.secrets || []); binding = Object.hasOwn(bindings, target) ? bindings[target] : undefined; }
      catch (error) { if (options.config || error.cause?.code !== "ENOENT") throw error; }
      const requestedId = binding || (validId(target) ? target : undefined);
      const row = result.databases?.find(row => row.status !== "deleted" && (requestedId ? row.id === requestedId : row.name === target));
      if (!row) throw new Error("Database not found");
      if (action === "info") {
        if (!validId(row.id)) throw new Error("Invalid database ID response");
        try { return { ...row, schema: await api.request(`/databases/${row.id}/schema`, { signal }) }; }
        catch (error) { if (error instanceof ApiError && error.status === 403) return { ...row, schema_access: "Administrator access required" }; throw error; }
      }
      id = row.id;
      if (!validId(id)) throw new Error("Invalid database ID response");
      if (!validId(target) && !await confirm(`Delete database ${text(row.name)} (${id})?`, Boolean(options.yes), signal)) return;
    }
    return api.request(action === "delete" ? `/databases/${id}` : "/databases", {
      method: action === "list" ? "GET" : action === "create" ? "POST" : "DELETE",
      ...(action === "create" ? { body: { name: target } } : {}), signal,
    });
  }
  if (!["grant", "revoke"].includes(action)) selectTarget(options);
  const context = await databaseContext(target, options, signal);
  const { id, config } = context;
  if (["grant", "revoke"].includes(action)) {
    if (!config.name) throw new Error("An application configuration is required");
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
  let query;
  if (action === "migrate") {
    if (!options.file) throw new Error("--file is required");
    query = { statements: migrationStatements(await migrationFile(options.file)), migration: basename(options.file) };
  } else if (action === "execute") {
    if (Boolean(options.command) === Boolean(options.file)) throw new Error("Choose exactly one of --command or --file");
    if (options.file && options.params) throw new Error("--params requires --command");
    const statements = migrationStatements(options.file ? await migrationFile(options.file) : options.command);
    if (options.params) {
      if (statements.length !== 1) throw new Error("--params requires exactly one SQL statement");
      try { statements[0].params = JSON.parse(options.params); } catch { throw new Error("--params must be a JSON array"); }
    }
    query = { statements };
  } else if (action === "query") {
    if (!options.sql) throw new Error("--sql is required");
    let params;
    try { params = JSON.parse(options.params || "[]"); } catch { throw new Error("--params must be a JSON array"); }
    query = { statements: [{ sql: options.sql, params }] };
  } else throw new Error("Unknown database command");
  return execute(context, options, query, signal);
}
