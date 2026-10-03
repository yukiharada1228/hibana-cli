import { lstat, readFile, open, rename, unlink } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { apiClient } from "./api.js";
import { readConfigFile, validateDatabases } from "./config.js";
import { sameRevision } from "./file-snapshot.js";

export async function createDatabase(name, options, signal?: AbortSignal) {
  const binding = options.binding ?? "DB";
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(binding) || ["__proto__", "constructor", "prototype"].includes(binding)) throw new Error("Invalid database binding name");
  const path = resolve(options.config || "hibana.json");
  let config, before, original;
  if (options["update-config"]) {
    before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > 1024n * 1024n) throw new Error("Configuration must be a regular file up to 1 MiB");
    original = await readFile(path, "utf8");
    config = await readConfigFile(path);
    if (!sameRevision(before, await lstat(path, { bigint: true }))) throw new Error("Configuration changed while reading; retry");
    if (config.assets) throw new Error("Static sites cannot have database bindings; use an API project");
    if (Object.hasOwn(config.databases || {}, binding)) throw new Error(`Binding ${binding} already exists; existing bindings are never overwritten`);
    validateDatabases({ ...config.databases, [binding]: "db_00000000000000000000000000000000" }, config.vars || {}, config.secrets || []);
  }
  const row = await (await apiClient(options)).request("/databases", { method: "POST", body: { name }, signal });
  if (!/^db_[a-f0-9]{32}$/.test(row?.id)) throw new Error("Invalid database creation response; inspect hibana db list before retrying");
  const result = { ...row, binding, configuration: { databases: { [binding]: row.id } } };
  if (!options["update-config"]) return result;
  // A sibling lock serializes CLI edits; revision checks also detect editor changes.
  const lockPath = `${path}.hibana-lock`;
  let lock, temporary;
  try {
    lock = await open(lockPath, "wx", 0o600);
    if (!sameRevision(before, await lstat(path, { bigint: true })) || original !== await readFile(path, "utf8")) throw new Error("Configuration changed while the database was being created");
    config.databases = { ...config.databases, [binding]: row.id };
    temporary = join(dirname(path), `.hibana-config-${randomUUID()}.json`);
    const file = await open(temporary, "wx", Number(before.mode & 0o777n));
    try { await file.writeFile(JSON.stringify(config, null, 2) + "\n"); await file.sync(); } finally { await file.close(); }
    if (!sameRevision(before, await lstat(path, { bigint: true }))) throw new Error("Configuration changed before saving");
    await rename(temporary, path); temporary = undefined;
    return { ...result, config_updated: path };
  } catch {
    // Creation has already succeeded. Preserve that result and never retry it.
    return { ...result, config_updated: false, warning: "Database created, but configuration could not be safely updated. Add the returned configuration manually; do not repeat creation." };
  } finally {
    if (temporary) await unlink(temporary).catch(() => {});
    if (lock) { await lock.close(); await unlink(lockPath).catch(() => {}); }
  }
}
