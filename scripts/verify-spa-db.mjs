import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { run } from "../dist/process.js";
const root = fileURLToPath(new URL("..", import.meta.url));
const folder = await mkdtemp(join(tmpdir(), "hibana-spa-db-"));
const children = new Set();
async function port() {
  const server = createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
async function start(cli, cwd, number, runtime) {
  const child = spawn(process.execPath, [cli, "dev", "--no-watch", "--port", String(number), ...(runtime ? ["--runtime", runtime] : [])], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child); let output = "";
  child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => output += chunk);
  child.completion = new Promise(resolve => child.once("exit", resolve));
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null) throw new Error(output);
    try { await fetch(`http://127.0.0.1:${number}/`, { signal: AbortSignal.timeout(1000) }); return child; } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Preview did not start: ${output}`);
}
try {
  const packed = JSON.parse((await run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", folder], { cwd: root, capture: true })).stdout)[0];
  for (const path of ["types/database.d.ts", "assets/database.mjs", "dist/static-sites.js"]) assert.ok(packed.files.some(file => file.path === path), path);
  const archive = join(folder, packed.filename), web = join(folder, "web"), api = join(folder, "api");
  await run(process.execPath, [join(root, "dist/cli.js"), "init", web, "--template", "react", "--no-install", "--cli-package", archive]);
  await cp(join(root, "examples/react-sqlite/web"), web, { recursive: true });
  await cp(join(root, "examples/react-sqlite/api"), api, { recursive: true });
  const pkg = JSON.parse(await readFile(join(api, "package.json"))); pkg.devDependencies["@yukiharada1228/hibana"] = `file:${archive}`;
  await writeFile(join(api, "package.json"), JSON.stringify(pkg));
  for (const cwd of [web, api]) await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd, timeout: 180000 });
  const cli = join(web, "node_modules/@yukiharada1228/hibana/dist/cli.js");
  await run("npm", ["run", "check"], { cwd: api });
  await run(process.execPath, [cli, "build"], { cwd: web, timeout: 120000 });
  const number = await port(); await start(cli, web, number);
  const response = await fetch(`http://127.0.0.1:${number}/notes/42`); assert.equal(response.status, 200);
  const html = await response.text();
  const js = /src="([^" ]+\.js)"/.exec(html)?.[1]; assert.ok(js);
  const script = await fetch(`http://127.0.0.1:${number}${js}`); assert.match(script.headers.get("content-type"), /javascript/); assert.ok((await script.text()).length);
  const runtime = process.env.HIBANA_RUNTIME_BIN;
  if (runtime) {
    const command = args => run(process.execPath, [cli, ...args], { cwd: api, capture: true, timeout: 600000 });
    await writeFile(join(api, ".dev.vars"), "API_TOKEN=local-test-token\n");
    await command(["db", "migrate", "DB", "--local", "--file", "migrations/0001_notes.sql", "--runtime", runtime]);
    const apiPort = await port(), child = await start(cli, api, apiPort, runtime);
    const url = `http://127.0.0.1:${apiPort}/notes`, headers = { authorization: "Bearer local-test-token", "content-type": "application/json", origin: "http://127.0.0.1:5173" };
    assert.equal((await fetch(url)).status, 401);
    const preflight = await fetch(url, { method: "OPTIONS", headers: { origin: headers.origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" } });
    assert.equal(preflight.headers.get("access-control-allow-origin"), headers.origin);
    for (const body of ["null", "{"]) {
      const invalid = await fetch(url, { method: "POST", headers, body });
      assert.equal(invalid.status, 400);
      assert.equal(typeof (await invalid.json()).error, "string");
    }
    assert.deepEqual(await (await fetch(url, { headers })).json(), []);
    const created = await fetch(url, { method: "POST", headers, body: JSON.stringify({ title: "React → Hono → SQLite 日本語" }) });
    assert.equal(created.status, 201); const row = await created.json();
    assert.equal((await (await fetch(url, { headers })).json())[0].title, row.title);
    assert.equal((await (await fetch(`${url}/${row.id}`, { method: "PATCH", headers })).json()).completed, 1);
    await assert.rejects(command(["db", "query", "DB", "--local", "--sql", "SELECT 1", "--runtime", runtime]), /failed/);
    assert.equal((await fetch(`${url}/${row.id}`, { method: "DELETE", headers })).status, 204);
    child.kill("SIGTERM"); assert.equal(await child.completion, 0); children.delete(child);
    const local = JSON.parse((await command(["db", "query", "DB", "--local", "--sql", "SELECT count(*) AS n FROM notes", "--runtime", runtime])).stdout);
    assert.equal(local.results[0].results[0].n, 0);
  } else {
    await run(process.execPath, [cli, "build"], { cwd: api, timeout: 600000 });
    console.log("SKIP native SQLite HTTP checks: set HIBANA_RUNTIME_BIN to a managed-SQL-capable worker");
  }
  console.log("PASS: packed CLI, React init/typecheck/build/SPA routes, public DB types and Hono" + (runtime ? " + native SQLite CRUD/auth/CORS/writer lock" : " build"));
} finally {
  for (const child of children) { child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 5000); await child.completion; clearTimeout(timer); }
  await rm(folder, { recursive: true, force: true });
}
