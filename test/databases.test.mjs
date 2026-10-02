import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RUNTIME_VERSION, releaseBase } from "../dist/package.js";
import { run } from "../dist/process.js";
import { loadConfig } from "../dist/config.js";
import { databaseCommand, migrationFile, validateQuery } from "../dist/databases.js";
import { migrationStatements } from "../dist/migrations.js";
import { parseCommand } from "../dist/commands.js";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

const id = "db_0123456789abcdef0123456789abcdef";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "hibana-databases-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, "hibana.json");
  await writeFile(config, JSON.stringify({ name: "db-app", main: "app.ts", databases: { DB: id } }));
  return { root, config };
}
test("database config rejects collisions, reserved names, excess bindings and non-ID targets", async t => {
  const f = await fixture(t);
  assert.deepEqual((await loadConfig(f.config)).databases, { DB: id });
  for (const invalid of [{ vars: { DB: "collision" } }, { secrets: ["DB"] }, { databases: { DB: "../escape" } }, { databases: { constructor: id } }, { databases: JSON.parse(`{"__proto__":"${id}"}`) }, { databases: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`DB${i}`, id])) }]) {
    await writeFile(f.config, JSON.stringify({ name: "db-app", main: "app.ts", databases: { DB: id }, ...invalid }));
    await assert.rejects(loadConfig(f.config));
  }
});
test("migration splitting preserves trigger bodies, quoted semicolons and comments", () => {
  const statements = migrationStatements(`; -- start\nCREATE TABLE t(n, text); CREATE TRIGGER dup AFTER INSERT ON t WHEN new.n=1 BEGIN INSERT INTO t VALUES(2,'a;''b'); UPDATE t SET text=CASE WHEN n=2 THEN ';END;' ELSE 'x' END; END; INSERT INTO t VALUES(1,'🔥'); /* tail */ -- eof`);
  assert.equal(statements.length, 3);
  assert.match(statements[1].sql, /UPDATE t/);
  assert.match(statements[1].sql, /END; END;$/);
  assert.deepEqual(migrationStatements("; /* comment */ -- tail"), []);
  assert.equal(migrationStatements('SELECT "a;b", [c;d], `e;f`; SELECT 2').length, 2);
  assert.equal(migrationStatements("SELECT 'unterminated; SELECT 2;").length, 1);
  assert.equal(migrationStatements("SELECT constructor, __proto__, toString FROM t;").length, 1);
  assert.equal(migrationStatements("\uFEFFCREATE TRIGGER a AFTER INSERT ON t BEGIN SELECT 1; SELECT 2; END;").length, 1);
  assert.throws(() => migrationStatements("SELECT 1\0;"), /NUL/);
});

test("bounded migration parsing remains responsive for long internal whitespace", { timeout: 8000 }, async () => {
  const module = new URL("../dist/migrations.js", import.meta.url).href;
  const code = `import {migrationStatements} from ${JSON.stringify(module)}; const sql="SELECT '"+" ".repeat(60000)+"';"; const result=migrationStatements(Array(4).fill(sql).join(' ')); if(result.length!==4||result.some(s=>s.sql!==sql))process.exit(1);`;
  await run(process.execPath, ["--input-type=module", "-e", code], { capture: true, timeout: 3000, stopTimeoutMs: 1000 });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`database deletion confirmation responds to ${signal} without contacting the API`, { skip: process.platform === "win32", timeout: 8000 }, async t => {
    const f = await fixture(t);
    const preload = join(f.root, "tty.mjs");
    await writeFile(preload, `Object.defineProperty(process.stdin,'isTTY',{value:true});globalThis.fetch=async()=>{console.error('UNEXPECTED_API_CALL');return Response.json({});};`);
    const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    const child = spawn(process.execPath, ["--import", preload, cli, "db", "delete", id], { cwd: f.root, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => output += chunk);
    const finished = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
    t.after(async () => { child.kill("SIGKILL"); await finished; });
    for (let i = 0; !output.includes("[y/N]") && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.match(output, /\[y\/N\]/);
    child.kill(signal);
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    const result = await finished; clearTimeout(timer);
    assert.deepEqual(result, { code: signal === "SIGINT" ? 130 : 143, signal: null }, output);
    assert.doesNotMatch(output, /UNEXPECTED_API_CALL/);
  });
}
test("migration files and query payloads are bounded and validated before runtime or API access", async t => {
  const f = await fixture(t);
  for (const [name, bytes] of [["large.sql", Buffer.alloc(256 * 1024 + 1)], ["utf8.sql", Buffer.from([255])]]) {
    const file = join(f.root, name); await writeFile(file, bytes);
    await assert.rejects(databaseCommand(["migrate", "DB"], { config: f.config, local: true, runtime: "/missing", file }));
  }
  await assert.rejects(migrationFile(f.root), /regular file/);
  for (const params of [{}, [2 ** 53], [null, { bad: 1 }], [[256]], [Infinity]]) assert.throws(() => validateQuery({ statements: [{ sql: "SELECT ?", params }] }));
  await assert.rejects(databaseCommand(["query", "DB"], { config: f.config, sql: "SELECT 1" }), /exactly one/);
  await assert.rejects(databaseCommand(["query", "DB"], { config: f.config, local: true, remote: true, sql: "SELECT 1" }), /exactly one/);
  await assert.rejects(databaseCommand(["query", "DB"], { config: f.config, local: true, profile: "prod", sql: "SELECT 1" }), /profile or URL/);
  await assert.rejects(access(join(f.root, ".hibana")));
});

test("a migration changed during reading is rejected before SQL runs", async t => {
  const f = await fixture(t), filePath = join(f.root, "0001.sql");
  await writeFile(filePath, "CREATE TABLE t(n);");
  const originalOpen = fs.open;
  let changed = false;
  t.mock.method(fs, "open", async (...args) => {
    const file = await originalOpen(...args);
    if (String(args[0]) === filePath) {
      const read = file.read.bind(file);
      file.read = async (...args) => {
        const result = await read(...args);
        if (!changed && result.bytesRead) { changed = true; await writeFile(filePath, "SELECT 1;"); }
        return result;
      };
    }
    return file;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(migrationFile(filePath), /changed while reading/);
  assert.ok(changed);
  await assert.rejects(access(join(f.root, ".hibana")));
});
test("db command help and flags expose explicit local/remote operations", () => {
  for (const action of ["list", "create", "delete", "grant", "revoke", "query", "migrate"]) assert.match(parseCommand(["db", action, "--help"]).helpText, new RegExp(`hibana db ${action}`));
  assert.throws(() => parseCommand(["db", "list", "--local"]), /not supported/);
  assert.equal(parseCommand(["db", "query", "DB", "--local", "--sql", "SELECT 1"]).values.local, true);
});
test("remote DB commands use the selected API, correct grant body and atomic migration request", async t => {
  const f = await fixture(t), calls = [];
  let created = false;
  const server = createServer(async (req, res) => {
    let body = ""; for await (const bytes of req) body += bytes;
    calls.push({ path: req.url, method: req.method, body: body ? JSON.parse(body) : undefined });
    assert.equal(req.headers.authorization, "Bearer test-token");
    res.setHeader("content-type", "application/json");
    if (req.url === "/components" && req.method === "GET") return res.end(JSON.stringify(created ? [{ name: "db-app", component_id: "cmp" }] : []));
    if (req.url === "/components") { created = true; return res.end('{"component_id":"cmp"}'); }
    if (req.url.includes("/grants/")) return res.writeHead(204).end();
    res.end('{"results":[],"migration_applied":true}');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const options = { config: f.config, url: `http://127.0.0.1:${server.address().port}`, token: "test-token" };
  await databaseCommand(["grant", "DB"], { ...options, "read-only": true });
  assert.deepEqual(calls.at(-1), { path: `/databases/${id}/grants/cmp`, method: "PUT", body: { read_only: true } });
  const file = join(f.root, "0001.sql"); await writeFile(file, "CREATE TABLE notes(id INTEGER); INSERT INTO notes VALUES(1);");
  await databaseCommand(["migrate", "DB"], { ...options, remote: true, file });
  assert.equal(calls.at(-1).body.statements.length, 2);
  assert.equal(calls.at(-1).body.migration, "0001.sql");
  await databaseCommand(["revoke", "DB"], options);
  assert.equal(calls.at(-1).method, "DELETE");
});
test("local CLI uses the native managed engine for migration, rollback, restrictions and data isolation", { skip: !process.env.HIBANA_TEST_RUNTIME, timeout: 30000 }, async t => {
  const f = await fixture(t);
  const options = { config: f.config, local: true, runtime: process.env.HIBANA_TEST_RUNTIME };
  const file = join(f.root, "0001.sql");
  await writeFile(file, "CREATE TABLE t(n INTEGER UNIQUE); CREATE TRIGGER dup AFTER INSERT ON t WHEN new.n=1 BEGIN INSERT INTO t VALUES(2); END;");
  assert.equal((await databaseCommand(["migrate", "DB"], { ...options, file })).migration_applied, true);
  assert.equal((await databaseCommand(["migrate", "DB"], { ...options, file })).migration_applied, false);
  await databaseCommand(["query", "DB"], { ...options, sql: "INSERT INTO t VALUES(?)", params: "[1]" });
  const result = await databaseCommand(["query", "DB"], { ...options, sql: "SELECT n FROM t ORDER BY n" });
  assert.deepEqual(result.results[0].results, [{ n: 1 }, { n: 2 }]);
  await assert.rejects(databaseCommand(["query", "DB"], { ...options, sql: "ATTACH ':memory:' AS escape" }));
  const broken = join(f.root, "0002.sql"); await writeFile(broken, "INSERT INTO t VALUES(3); INSERT INTO missing VALUES(1);");
  await assert.rejects(databaseCommand(["migrate", "DB"], { ...options, file: broken }));
  assert.deepEqual((await databaseCommand(["query", "DB"], { ...options, sql: "SELECT n FROM t ORDER BY n" })).results[0].results, [{ n: 1 }, { n: 2 }]);
  await writeFile(file, "CREATE TABLE changed(n);");
  await assert.rejects(databaseCommand(["migrate", "DB"], { ...options, file }));
  // Rust's str::trim preserves UTF-8 BOMs. Seed the exact statement emitted by
  // the existing native CLI, then reapply the unchanged file through this CLI.
  const imported = "\uFEFFCREATE TABLE imported(n);";
  await run(options.runtime, ["--dev-sql"], {
    capture: true,
    input: JSON.stringify({ directory: join(f.root, ".hibana/databases"), id, query: { statements: [{ sql: imported, params: [] }], migration: "0003_imported.sql" } }),
  });
  const importedFile = join(f.root, "0003_imported.sql");
  await writeFile(importedFile, imported + "\n\u0085-- trailing comment");
  assert.equal((await databaseCommand(["migrate", "DB"], { ...options, file: importedFile })).migration_applied, false);
});

test("first local SQL installs a compatible runtime without contaminating JSON stdout", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t);
  const previous = { PATH: process.env.PATH, HIBANA_RUNTIME_BIN: process.env.HIBANA_RUNTIME_BIN, HIBANA_RUNTIME_HOME: process.env.HIBANA_RUNTIME_HOME };
  t.after(() => { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  process.env.PATH = f.root;
  process.env.HIBANA_RUNTIME_BIN = "";
  process.env.HIBANA_RUNTIME_HOME = join(f.root, "runtimes");
  const runtime = `#!${process.execPath}\nif(process.argv.includes('--capabilities'))console.log('{"managed_sql":1}');else{require('node:fs').readFileSync(0);console.log('{"results":[],"migration_applied":false}');}\n`;
  const hash = createHash("sha256").update(runtime).digest("hex");
  const name = `hibana-worker-${RUNTIME_VERSION}-${process.platform}-${process.arch}`;
  t.mock.method(globalThis, "fetch", async url => {
    if (String(url) === releaseBase(RUNTIME_VERSION) + "SHA256SUMS") return new Response(`${hash}  ${name}\n`);
    assert.equal(String(url), releaseBase(RUNTIME_VERSION) + name);
    return new Response(runtime);
  });
  const stdout = t.mock.method(console, "log", () => {});
  const stderr = t.mock.method(console, "error", () => {});
  assert.deepEqual(await databaseCommand(["query", "DB"], { config: f.config, local: true, sql: "SELECT 1" }), { results: [], migration_applied: false });
  assert.equal(stdout.mock.callCount(), 0, "only the CLI's final JSON result belongs on stdout");
  assert.ok(stderr.mock.calls.some(call => String(call.arguments[0]).includes("Installed hibana-worker")));
});
