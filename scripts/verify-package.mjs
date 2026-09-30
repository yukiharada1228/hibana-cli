import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { run } from "../dist/process.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const { files } = JSON.parse(await readFile(new URL("../assets/engine.json", import.meta.url), "utf8"));
for (const [name, expected] of Object.entries(files)) {
  const bytes = await readFile(new URL(`../assets/${name}`, import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), expected, `Bundled asset: ${name}`);
}
const temporary = await mkdtemp(join(tmpdir(), "hibana packaged "));
let child;
try {
  const packed = JSON.parse((await run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary], {cwd: root, capture: true})).stdout)[0];
  assert.ok(packed.files.some(file => file.path === "dist/cli.js"));
  assert.ok(packed.files.some(file => file.path === "assets/compose.wasm"));
  for (const file of packed.files) assert.doesNotMatch(file.path, /(^|\/)(platform|infra|\.env|\.git|\.local|node_modules)(\/|$)/);
  const application = join(temporary, "hello app");
  await run(process.execPath, [join(root, "dist/cli.js"), "init", application, "--no-install", "--cli-package", join(temporary, packed.filename)]);
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {cwd: application});
  const cli = join(application, "node_modules/@yukiharada1228/hibana/dist/cli.js");
  await run(process.execPath, [cli, "--version"], {cwd: application});
  await writeFile(join(application, "src/index.ts"), `
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
const app = new Hono();
app.get('/', c => c.json({message: 'Hibana TypeScript CLI', hash: createHash('sha256').update('hibana').digest('hex')}));
export default app;
`);
  await run(process.execPath, [cli, "build"], {cwd: application, timeout: 600_000});
  const bytes = await readFile(join(application, ".hibana/build/app.wasm"));
  assert.deepEqual([...bytes.subarray(0, 8)], [0, 97, 115, 109, 13, 0, 1, 0]);
  const runtime = process.env.HIBANA_RUNTIME_BIN;
  if (runtime) {
    const listener = createServer();
    await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    child = spawn(process.execPath, [cli, "dev", "--no-watch", "--port", String(port), "--runtime", runtime], {cwd: application, stdio: "inherit"});
    let result;
    for (let i = 0; i < 180; i++) {
      if (child.exitCode !== null) throw new Error(`Local runtime exited with ${child.exitCode}`);
      try { result = await fetch(`http://127.0.0.1:${port}`, {signal: AbortSignal.timeout(2000)}); if (result.ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.ok(result?.ok, "Local runtime must serve the packed application");
    const payload = await result.json();
    assert.equal(payload.message, "Hibana TypeScript CLI");
    assert.match(payload.hash, /^[a-f0-9]{64}$/);
    child.kill("SIGTERM");
    const code = await new Promise(resolve => child.once("exit", resolve));
    assert.equal(code, 0, "Development server must shut down cleanly");
    child = undefined;
  }
  console.log(`PASS: fresh npm install, Hono + node:crypto component build${runtime ? ", HTTP and shutdown" : ""}`);
} finally {
  child?.kill("SIGKILL");
  await rm(temporary, {recursive: true, force: true});
}
