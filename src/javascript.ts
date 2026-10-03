import { installNodeCompat } from "./node-compat.js";
import { prepareExtensionWit } from "./extensions.js";
import { isBuiltin } from "node:module";
import type { BuildOptions, ExtensionPlan } from "./types.js";
// Compile a JavaScript fetch handler into a WASI HTTP Component.
import { build as esbuild } from "esbuild";
import { run } from "./process.js";
import { extensionImports } from "./extension-imports.js";
import { writeFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// build.ts owns staging, cleanup and atomic publication for every language.
export async function compileJavaScript(config, out: string, extensions: ExtensionPlan & BuildOptions) {
  const work = dirname(out);
  const select = await installNodeCompat(extensions, work);
  const shim = join(work, "entry.js");
  await writeFile(
    shim,
    `
${(extensions.preload || []).map((path) => `import ${JSON.stringify(path)};`).join("\n")}
${Object.keys(config.databases || {}).length ? `import { installDatabases } from ${JSON.stringify(join(SDK_ROOT, "assets/database.mjs"))};` : ""}
import app from ${JSON.stringify(resolve(config.root, config.main))};
if (!app || typeof app.fetch !== "function") throw new Error("Default export must expose fetch(request, env, context); a Hono app can be exported directly");
function decodeEnv(value) {
  const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}
addEventListener("fetch", event => {
  event.respondWith((async () => {
    const incoming = event.request;
    const raw = incoming.headers.get("x-hibana-env");
    const env = raw ? decodeEnv(raw) : {};
    for (const key of Object.keys(globalThis.process.env)) delete globalThis.process.env[key];
    Object.assign(globalThis.process.env, env);
    ${Object.keys(config.databases || {}).length ? `installDatabases(env, ${JSON.stringify(Object.keys(config.databases))});` : ""}
    const headers = new Headers(incoming.headers);
    headers.delete("x-hibana-env"); headers.delete("x-hibana-event");
    const body = incoming.method === "GET" || incoming.method === "HEAD" ? undefined : await incoming.arrayBuffer();
    const request = new Request(incoming.url, { method: incoming.method, headers, body });
    const context = { waitUntil(promise) { event.waitUntil(Promise.resolve(promise)); } };
    return app.fetch(request, env, context);
  })());
});
`,
  );
  const bundle = join(work, "worker.js");
  const result = await esbuild({
    metafile: true,
    entryPoints: [shim],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    mainFields: ["module", "main"],
    conditions: ["import", "default"],
    outfile: bundle,
    logLevel: "warning",
    absWorkingDir: config.root,
    external: extensions.imports || [],
    plugins: [{
      name: "hibana-node-builtins",
      setup(builder) {
        builder.onResolve({filter: /^[^./]/}, args => {
          const path = (args.kind === "require-call" ? extensions.requireAliases?.[args.path] : undefined) || extensions.aliases[args.path];
          if (path) return {path};
          if (isBuiltin(args.path) || args.path.startsWith("node:")) return {errors: [{text: `Node.js API ${args.path} is not supported by Hibana's Wasm runtime`}]};
          return undefined;
        });
      },
    }, extensionImports(extensions.packages)],
  });
  select(Object.values(result.metafile.outputs).flatMap(output => output.imports.filter(i => i.external).map(i => i.path)));
  const wit = await prepareExtensionWit(extensions, work) || join(SDK_ROOT, "wit");
  const env: Record<string, string> = {};
  if (process.platform === "win32" && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  await run(process.execPath, [fileURLToPath(new URL("./componentize-runner.js", import.meta.url)), bundle, wit, out], {
    signal: extensions.signal, cwd: work, env, timeout: 600_000,
  });
}
