import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { list } from "tar";
import { init } from "../dist/init.js";
import { build } from "../dist/build.js";
import { deploy } from "../dist/api.js";
import { loadConfig } from "../dist/config.js";
import { staticHandler, snapshot } from "../dist/static-sites.js";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "hibana-static-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist/assets"), { recursive: true });
  await writeFile(join(root, "dist/index.html"), "<h1>SPA v1</h1>");
  await writeFile(join(root, "dist/assets/app.js"), "console.log('v1')");
  await writeFile(join(root, "hibana.json"), JSON.stringify({ name: "frontend", assets: { directory: "dist" } }));
  return await loadConfig(join(root, "hibana.json"));
}
test("React init generates a Vite app with a nonrecursive deployment build and public CLI pin", async t => {
  const root = await mkdtemp(join(tmpdir(), "hibana-react-init-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await init(root, { template: "react", install: false });
  const config = await loadConfig(join(root, "hibana.json"));
  const pkg = JSON.parse(await readFile(join(root, "package.json")));
  assert.deepEqual(config.assets, { directory: "dist" });
  assert.equal(config.resources, null);
  assert.deepEqual(config.build.commands, [["npm", "run", "build"]]);
  assert.equal(pkg.scripts.dev, "vite --host 127.0.0.1");
  assert.equal(pkg.scripts.build, "tsc --noEmit && vite build");
  assert.equal(pkg.scripts.deploy, "hibana deploy");
  assert.equal(pkg.scripts.preview, "hibana dev");
  for (const path of ["src/main.tsx", "src/App.tsx", "vite.config.ts", "tsconfig.json", "index.html"]) assert.ok((await readFile(join(root, path))).length);
  await assert.rejects(init(root, { template: "react", install: false }), /not empty/);
});
test("static config rejects ambiguous outputs, unsafe directories and all runtime fields", async t => {
  const config = await fixture(t);
  for (const extra of [{ main: "a.ts" }, { component: "a.wasm" }, { vars: {} }, { databases: {} }, { secrets: [] }, { limits: {} }, { extensions: [] }, { dev: {} }, ...[".", "../dist", "/tmp/dist", "C:\\dist", "dist\0"].map(directory => ({ assets: { directory } }))]) {
    await writeFile(config.path, JSON.stringify({ name: "frontend", assets: { directory: "dist" }, ...extra }));
    await assert.rejects(loadConfig(config.path));
  }
});
test("static build preserves long Unicode paths and immutable uploads across rebuilds", async t => {
  const config = await fixture(t);
  const unicode = "日本語".repeat(20) + ".txt";
  await writeFile(join(config.root, "dist", unicode), "日本語 🔥");
  const [first, parallel] = await Promise.all([build(config), build(config)]);
  assert.equal(first, parallel, "concurrent builds publish the same complete artifact");
  const expected = await readFile(first);
  const entries = [];
  await list({ file: first, onReadEntry: e => entries.push([e.path, e.type]) });
  assert.ok(entries.some(([path]) => path === unicode));
  assert.ok(entries.every(([, type]) => type === "File"));
  assert.equal(await build(config), first);
  await writeFile(join(config.root, "dist/index.html"), "v2");
  assert.notEqual(await build(config), first);
  const calls = [];
  await deploy({ request: async (path, options = {}) => {
    calls.push({ path, ...options });
    return path === "/components" ? [{ name: "frontend", component_id: "cmp" }] : {};
  } }, config, first, "spa-v1");
  const form = calls[1].body;
  assert.deepEqual(Buffer.from(await form.get("assets").arrayBuffer()), expected);
  for (const key of ["wasm", "vars", "secrets", "databases", "resource_limits"]) assert.equal(form.has(key), false, key);
  await writeFile(join(config.root, "dist/.env"), "private");
  await assert.rejects(build(config), /Invalid static asset path/);
  assert.deepEqual(await readFile(first), expected);
});
test("static builds reject linked outputs and files", { skip: process.platform === "win32" }, async t => {
  const config = await fixture(t);
  await symlink(join(config.root, "hibana.json"), join(config.root, "dist/leak.json"));
  await assert.rejects(build(config), /symlinks/);
  await rm(join(config.root, "dist/leak.json"));
  await rename(join(config.root, "dist"), join(config.root, "output"));
  await symlink(join(config.root, "output"), join(config.root, "dist"));
  await assert.rejects(build(config), /symlinks/);
});

test("static snapshots reject files modified while being read", async t => {
  const config = await fixture(t);
  const target = join(config.root, "dist/index.html");
  const originalOpen = fs.open;
  let changed = false;
  t.mock.method(fs, "open", async (...args) => {
    const file = await originalOpen(...args);
    if (String(args[0]).endsWith("/dist/index.html") || String(args[0]).endsWith("\\dist\\index.html")) {
      const read = file.read.bind(file);
      file.read = async (...args) => {
        const result = await read(...args);
        if (!changed && result.bytesRead) { changed = true; await writeFile(target, "changed during snapshot"); }
        return result;
      };
    }
    return file;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(snapshot(config), /changed while reading/);
  assert.ok(changed);
});

test("static snapshots reject a directory replaced by a symlink during traversal", { skip: process.platform === "win32" }, async t => {
  const config = await fixture(t);
  const outside = join(config.root, "private-output");
  await mkdir(outside); await writeFile(join(outside, "private.txt"), "private fixture, never publish");
  const originalLstat = fs.lstat;
  let replaced = false;
  t.mock.method(fs, "lstat", async (...args) => {
    const stat = await originalLstat(...args);
    if (!replaced && String(args[0]).endsWith("/dist/assets")) {
      replaced = true;
      await rename(join(config.root, "dist/assets"), join(config.root, "saved-assets"));
      await symlink(outside, join(config.root, "dist/assets"));
    }
    return stat;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(snapshot(config), /symlinks|changed while reading/);
  assert.ok(replaced);
});
test("static preview matches SPA routing, HEAD, ETag, cache policy and protected paths", async t => {
  const config = await fixture(t);
  const { files } = await snapshot(config);
  const server = createServer(staticHandler(files));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(url + "/users/alice.smith");
  assert.equal(await page.text(), "<h1>SPA v1</h1>");
  assert.equal(page.headers.get("cache-control"), "public, max-age=0, must-revalidate");
  const etag = page.headers.get("etag");
  assert.equal((await fetch(url, { headers: { "if-none-match": `W/${etag}` } })).status, 304);
  assert.equal(await (await fetch(url, { method: "HEAD" })).text(), "");
  assert.match((await fetch(url + "/assets/app.js")).headers.get("content-type"), /javascript/);
  assert.equal((await fetch(url + "/missing.js")).headers.get("content-type"), "text/html");
  for (const path of ["/.env", "/%2eenv", "/a//b", "/%252eenv"]) assert.equal((await fetch(url + path)).status, 404, path);
  assert.equal((await fetch(url + "/%ff")).status, 400);
  assert.equal((await fetch(url, { method: "POST" })).status, 405);
  const denied = await new Promise((resolve, reject) => {
    const req = request(url, { headers: { host: "attacker.example" } }, res => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject); req.end();
  });
  assert.equal(denied, 403);
  assert.equal((await fetch(url, { headers: { authorization: "Bearer test" } })).headers.get("cache-control"), null);
});
test("static dev starts without a runtime and atomically reloads replaced output", { timeout: 20000 }, async t => {
  const config = await fixture(t);
  const reserve = createServer();
  await new Promise(resolve => reserve.listen(0, "127.0.0.1", resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const child = spawn(process.execPath, [cli, "dev", "--port", String(port)], { cwd: config.root, env: { ...process.env, HIBANA_RUNTIME_BIN: "/missing-runtime" }, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise(resolve => child.once("exit", resolve));
  t.after(() => child.kill("SIGKILL"));
  let output = ""; child.stdout.on("data", data => output += data); child.stderr.on("data", data => output += data);
  async function waitFor(check) {
    for (let i = 0; i < 100; i++) { if (await check()) return; assert.equal(child.exitCode, null, output); await new Promise(resolve => setTimeout(resolve, 50)); }
    assert.fail(output);
  }
  await waitFor(() => output.includes("Static preview:"));
  const url = `http://127.0.0.1:${port}/route`;
  await mkdir(join(config.root, "replacement"));
  await writeFile(join(config.root, "replacement/index.html"), "replacement");
  await rm(join(config.root, "dist"), { recursive: true });
  await rename(join(config.root, "replacement"), join(config.root, "dist"));
  await waitFor(async () => await (await fetch(url)).text() === "replacement");
  await writeFile(join(config.root, "dist/.env"), "private");
  await waitFor(() => output.includes("Keeping previous static output"));
  assert.equal(await (await fetch(url)).text(), "replacement");
  child.kill("SIGTERM");
  assert.equal(await exited, process.platform === "win32" ? null : 0, output);
});

for (const { phase, watch } of [{ phase: "watch registration", watch: true }, { phase: "HTTP listener startup", watch: true }, { phase: "HTTP listener startup", watch: false }]) {
  test(`static preview honors ${watch ? "watch" : "--no-watch"} for output changed during ${phase}`, { timeout: 15000 }, async t => {
    const config = await fixture(t);
    const preload = join(config.root, "startup.mjs");
    // Complete an external build at the two startup boundaries where output
    // changes can otherwise be missed indefinitely.
    await writeFile(preload, `
      import http from 'node:http';
      import fs from 'node:fs';
      import { writeFile } from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      if (${JSON.stringify(phase)} === 'watch registration') {
        const watch = fs.watch;
        fs.watch = (...args) => {
          fs.writeFileSync(${JSON.stringify(join(config.root, "dist/index.html"))}, 'changed during startup');
          return watch(...args);
        };
      } else {
        const create = http.createServer;
        http.createServer = (...args) => {
          const server = create(...args), listen = server.listen;
          server.listen = function (...args) {
            const done = args.pop();
            return listen.call(this, ...args, async (...result) => {
              await writeFile(${JSON.stringify(join(config.root, "dist/index.html"))}, 'changed during startup');
              await new Promise(resolve => setTimeout(resolve, 300));
              done(...result);
            });
          };
          return server;
        };
      }
      syncBuiltinESMExports();
    `);
    const reserve = createServer();
    await new Promise(resolve => reserve.listen(0, "127.0.0.1", resolve));
    const port = reserve.address().port;
    await new Promise(resolve => reserve.close(resolve));
    const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, cli, "dev", "--port", String(port), ...(!watch ? ["--no-watch"] : [])], { cwd: config.root, stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise(resolve => child.once("exit", resolve));
    t.after(async () => { child.kill("SIGKILL"); await exited; });
    let output = "";
    child.stdout.on("data", data => output += data); child.stderr.on("data", data => output += data);
    for (let i = 0; i < 100 && !output.includes("Static preview:"); i++) {
      assert.equal(child.exitCode, null, output);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.match(output, /Static preview:/);
    const url = `http://127.0.0.1:${port}/route`;
    const expected = watch ? "changed during startup" : "<h1>SPA v1</h1>";
    let html;
    for (let i = 0; i < 40; i++) {
      html = await (await fetch(url)).text();
      if (html === expected) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(html, expected);
    child.kill("SIGTERM");
    assert.equal(await exited, process.platform === "win32" ? null : 0, output);
  });
}

test("static preview reloads a nested output replaced through a symlinked --config path", { skip: process.platform === "win32", timeout: 15000 }, async t => {
  const config = await fixture(t);
  await mkdir(join(config.root, "build"));
  await rename(join(config.root, "dist"), join(config.root, "build/dist"));
  await writeFile(config.path, JSON.stringify({ name: "frontend", assets: { directory: "build/dist" } }));
  const aliases = await mkdtemp(join(tmpdir(), "hibana-static-alias-"));
  t.after(() => rm(aliases, { recursive: true, force: true }));
  const alias = join(aliases, "project-link");
  await symlink(config.root, alias);
  const reserve = createServer();
  await new Promise(resolve => reserve.listen(0, "127.0.0.1", resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "dev", "--config", join(alias, "hibana.json"), "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", data => output += data); child.stderr.on("data", data => output += data);
  const exited = new Promise(resolve => child.once("exit", resolve));
  t.after(async () => { child.kill("SIGKILL"); await exited; });
  async function waitFor(check) {
    for (let i = 0; i < 80; i++) { if (await check()) return; assert.equal(child.exitCode, null, output); await new Promise(resolve => setTimeout(resolve, 50)); }
    assert.fail(output);
  }
  await waitFor(() => output.includes("Static preview:"));
  await mkdir(join(config.root, "replacement/dist"), { recursive: true });
  await writeFile(join(config.root, "replacement/dist/index.html"), "nested replacement");
  await rm(join(config.root, "build"), { recursive: true });
  await rename(join(config.root, "replacement"), join(config.root, "build"));
  await waitFor(async () => await (await fetch(`http://127.0.0.1:${port}/route`)).text() === "nested replacement");
  child.kill("SIGTERM");
  assert.equal(await exited, 0, output);
});
