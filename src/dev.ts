import { spawn } from "node:child_process";
import { readFile, writeFile, chmod, mkdir } from "node:fs/promises";
import { watch } from "node:fs";
import { parseEnv } from "node:util";
import { dirname, resolve, join } from "node:path";
import { loadConfig } from "./config.js";
import { isInside } from "./paths.js";
import { localRuntime, requireManagedSql } from "./local-runtime.js";
import { resolveExtensions } from "./extensions.js";
import {
  isLocalExtension,
  extensionNames,
  managesExtensions,
  isExtensionArchive,
} from "./extension-manifest.js";

export function shouldRebuild(config, file) {
  const path = resolve(config.root, file);
  if (path === config.path || path === join(config.root, ".dev.vars"))
    return true;
  if (path === join(config.root, "hibana-lock.json")) return true;
  if (
    managesExtensions(config.extensions) &&
    Object.values<string>(config.extensions).some(
      (source) =>
        isExtensionArchive(source) && path === resolve(config.root, source),
    )
  )
    return true;
  if (
    extensionNames(config.extensions).length &&
    [
      "package.json",
      "package-lock.json",
      "npm-shrinkwrap.json",
      "pnpm-lock.yaml",
      "yarn.lock",
    ].some((name) => path === join(config.root, name))
  )
    return true;
  if (
    file
      .split(/[\\/]/)
      .some((part) =>
        ["node_modules", ".hibana", ".git", "target", "vendor"].includes(part),
      )
  )
    return false;
  // Local extension sources and their dist/ outputs participate in reload even
  // when a native app restricts build.watch. Generated target/ stays ignored.
  if (
    extensionNames(config.extensions).some(
      (input) =>
        isLocalExtension(input) && isInside(resolve(config.root, input), path),
    )
  )
    return true;
  if (config.component && path === resolve(config.root, config.component))
    return !config.build;
  if (!config.build?.watch) return true;
  return config.build.watch.some((input) =>
    isInside(resolve(config.root, input), path),
  );
}

export async function dev(config, options, build) {
  if (config.assets) return (await import("./static-sites.js")).devStatic(config, options);
  const port = Number(options.port || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("port must be 1..65535");
  const builds = new AbortController();
  const extensionOptions = {
    signal: builds.signal,
    mode: "dev",
    frozenLockfile: Boolean(options["frozen-lockfile"]),
  };
  let runtime;
  const settings = join(config.root, ".hibana/dev-settings.json");
  let child, watcher, timer, childStopping, stopPromise, rebuildingTask;
  let stopping = false,
    rebuilding = false,
    dirty = false;
  function stopChild() {
    if (childStopping) return childStopping;
    const current = child;
    child = undefined;
    if (current && current.exitCode === null && current.signalCode === null) {
      childStopping = new Promise<void>((done) => {
        const killTimer = setTimeout(() => current.kill("SIGKILL"), 65000);
        current.once("exit", () => {
          clearTimeout(killTimer);
          done();
        });
        current.kill("SIGTERM");
      }).finally(() => {
        childStopping = undefined;
      });
    }
    return childStopping;
  }
  async function start() {
    builds.signal.throwIfAborted();
    const localNetwork = config.dev;
    const artifact = await build(config, extensionOptions);
    let local = {};
    try {
      local = parseEnv(await readFile(join(config.root, ".dev.vars"), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const name of Object.keys(config.databases || {}))
      if (Object.hasOwn(local, name)) throw new Error(`.dev.vars conflicts with database binding ${name}`);
    if (Object.keys(config.databases || {}).length) await requireManagedSql(runtime, builds.signal);
    if (stopping) return;
    await stopChild();
    await mkdir(dirname(settings), { recursive: true });
    await writeFile(
      settings,
      JSON.stringify({
        vars: { ...config.vars, ...local },
        resources: config.resources,
        // Keep non-database apps compatible with older strict settings decoders.
        ...(Object.keys(config.databases || {}).length ? {
          databases: config.databases,
          databases_dir: join(config.root, ".hibana/databases"),
        } : {}),
        ...(localNetwork.allow_outbound.length
          ? { net_allow_outbound: localNetwork.allow_outbound }
          : {}),
      }),
      { mode: 0o600 },
    );
    await chmod(settings, 0o600);
    // stop() can run during any of the awaits above, including the old child's drain.
    if (stopping) return;
    const current = spawn(
      runtime,
      [
        "--dev-component",
        artifact,
        "--dev-settings",
        settings,
        "--bind",
        `127.0.0.1:${port}`,
      ],
      { stdio: "inherit" },
    );
    child = current;
    current.once("error", (error) => {
      console.error(`Runtime: ${error.message}`);
      process.exitCode = 1;
      stop();
    });
    current.once("exit", (code, signal) => {
      // stopChild clears child before intentionally draining a runtime for a
      // rebuild. Any other exit must finish dev and close its watcher.
      if (stopping || child !== current) return;
      if (code !== 0) {
        console.error(`Runtime exited (${signal || code})`);
        process.exitCode = 1;
      }
      stop();
    });
  }
  async function rebuild() {
    if (stopping) return;
    if (rebuilding) {
      dirty = true;
      return;
    }
    rebuilding = true;
    try {
      const updated = await loadConfig(config.path);
      if (updated.assets) throw new Error("Restart hibana dev after switching to a static site");
      config = updated;
      await start();
    } catch (error) {
      if (!stopping) console.error(`Build failed: ${error.message}`);
    } finally {
      rebuilding = false;
      if (dirty) {
        dirty = false;
        await rebuild();
      }
    }
  }
  let finished;
  const completion = new Promise<void>((done) => {
    finished = done;
  });
  function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    builds.abort();
    clearTimeout(timer);
    watcher?.close();
    stopPromise = (async () => {
      await stopChild();
      await rebuildingTask;
      finished();
    })();
    return stopPromise;
  }
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    await resolveExtensions(config, extensionOptions);
    builds.signal.throwIfAborted();
    try { runtime = await localRuntime(options, builds.signal); }
    catch (error) {
      throw new Error(`Could not prepare the local runtime: ${error.message}\nCheck your connection and run hibana dev again.\nFor offline setup, run hibana runtime install --from FILE --sha256 HASH, or use --runtime PATH.`, { cause: error });
    }
    if (!stopping) await start();
    if (!stopping && !options["no-watch"]) {
      watcher = watch(config.root, { recursive: true }, (_, file) => {
        if (!file || !shouldRebuild(config, file)) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (rebuilding) dirty = true;
          else rebuildingTask = rebuild();
        }, 200);
      });
      watcher.on("error", (error) => {
        console.error(`Watcher: ${error.message}`);
        process.exitCode = 1;
        stop();
      });
      console.log(
        "Watching project files; rebuilds restart the Wasmtime server.",
      );
    }
    await completion;
  } catch (error) {
    if (!stopping) throw error;
  } finally {
    await stop();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
