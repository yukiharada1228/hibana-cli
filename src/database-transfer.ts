import { openAsBlob } from "node:fs";
import { lstat, open, link, unlink } from "node:fs/promises";
import { dirname, basename, resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { apiClient } from "./api.js";
import { confirm } from "./confirm.js";
import { text } from "./output.js";
import { databaseContext, localOperation, selectTarget } from "./databases.js";
import { sameRevision } from "./file-snapshot.js";
const MAX = 600 * 1024 * 1024;

export async function importSql(target, options, signal?: AbortSignal) {
  selectTarget(options);
  if (options.command !== undefined) throw new Error("Choose exactly one of --command or --file");
  if (options.params !== undefined) throw new Error("--params requires --command");
  const path = resolve(options.file);
  const metadata = await lstat(path, { bigint: true });
  if (!metadata.isFile() || metadata.size < 1n || metadata.size > BigInt(MAX)) throw new Error("SQL file must be a regular file containing 1 byte to 600 MiB");
  const context = await databaseContext(target, options, signal);
  if (options.local) {
    if (!await confirm(`Import SQL into local database ${context.id}? Each file is one transaction.`, Boolean(options.yes), signal)) return;
    if (!sameRevision(metadata, await lstat(path, { bigint: true }))) throw new Error("SQL file changed before execution; review the file and try again");
    return localOperation(context, options, { import: path }, signal);
  }
  const api = await apiClient(options);
  const result = await api.request("/databases", { signal });
  const database = result.databases?.find(row => row.id === context.id && row.status !== "deleted");
  if (!database || typeof database.name !== "string") throw new Error("Database not found");
  console.error(`Database target: ${text(api.url)} · ${text(database.name)} (${context.id})`);
  if (!await confirm("Execute this SQL file? It may modify existing data. The file runs as one atomic transaction.", Boolean(options.yes), signal)) return;
  const body = new FormData(); body.set("confirmation", database.name);
  const blob = await openAsBlob(path, { type: "application/sql" });
  if (!sameRevision(metadata, await lstat(path, { bigint: true }))) throw new Error("SQL file changed before execution; review the file and try again");
  body.set("file", blob, basename(path));
  return api.request(`/databases/${context.id}/import`, { method: "POST", body, signal });
}
export async function exportSql(target, options, signal?: AbortSignal) {
  selectTarget(options);
  if (!options.output) throw new Error("--output is required");
  if (options["no-schema"] && options["no-data"]) throw new Error("--no-schema and --no-data cannot be combined");
  if (options.table !== undefined && (typeof options.table !== "string" || !options.table.length || Buffer.byteLength(options.table) > 1024 || options.table.includes("\0"))) throw new Error("Invalid table name");
  const output = resolve(options.output);
  try { await lstat(output); throw new Error("Export output already exists; choose a new file"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const context = await databaseContext(target, options, signal);
  const settings = { ...(options.table ? { table: options.table } : {}), no_schema: Boolean(options["no-schema"]), no_data: Boolean(options["no-data"]) };
  if (options.local) return localOperation(context, options, { export: { output, options: settings } }, signal);
  const params = new URLSearchParams(Object.entries(settings).map(([key, value]) => [key, String(value)]));
  const api = await apiClient(options);
  const response: Response = await api.request(`/databases/${context.id}/export?${params}`, { signal, stream: true });
  if (!response.body) throw new Error("Export returned no SQL file");
  const size = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX) { await response.body.cancel(); throw new Error("Invalid export size"); }
  const temporary = join(dirname(output), `.hibana-export-${randomUUID()}.sql`);
  let file;
  try { file = await open(temporary, "wx", 0o600); } catch (error) { await response.body.cancel().catch(() => {}); throw error; }
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      signal?.throwIfAborted(); bytes += chunk.length;
      if (bytes > MAX) throw new Error("Export exceeds 600 MiB");
      let written = 0;
      while (written < chunk.length) { const n = await file.write(chunk, written, chunk.length-written); if (!n.bytesWritten) throw new Error("Export write failed"); written += n.bytesWritten; }
    }
    if (bytes !== size) throw new Error("Export was interrupted; no output was published");
    await file.sync(); await file.close();
    // Publishing with a hard link is atomic and cannot replace an existing file.
    await link(temporary, output);
    return { output, bytes };
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}
