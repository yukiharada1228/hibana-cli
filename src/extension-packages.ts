import type { JsonObject, BuildOptions } from "./types.js";
// npm is an implementation detail of extension distribution. App dependencies
// are never installed or rewritten here; only .hibana/ and hibana-lock.json are used.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { run } from "./process.js";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isInside } from "./paths.js";
import {
  isExtensionArchive,
  managesExtensions,
  validateExtensionList,
} from "./extension-manifest.js";
import {
  isCompleteInstallation,
  publishInstallation,
} from "./extension-cache.js";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const manifest = (dependencies) => ({
  name: "hibana-application-extensions",
  version: "0.0.0",
  private: true,
  dependencies,
});

async function archiveDigest(path: string, signal?: AbortSignal, output?: import("node:fs/promises").FileHandle) {
  signal?.throwIfAborted();
  const limit = 128 * 1024 * 1024;
  const info = await stat(path);
  if (!info.isFile() || info.size > limit)
    throw new Error("Extension archives must be files of at most 128 MiB");
  const digest = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path, { signal })) {
    signal?.throwIfAborted();
    size += chunk.length;
    if (size > limit)
      throw new Error("Extension archives must be files of at most 128 MiB");
    digest.update(chunk);
    if (output) await output.writeFile(chunk);
  }
  signal?.throwIfAborted();
  return digest.digest("hex");
}

async function readLock(path) {
  try {
    if ((await stat(path)).size > 4 * 1024 * 1024)
      throw new Error("hibana-lock.json exceeds 4 MiB");
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Cannot read hibana-lock.json: ${error.message}`, {
      cause: error,
    });
  }
}

async function commitLock(path, previous, lock, signal) {
  signal?.throwIfAborted();
  if (isDeepStrictEqual(previous, lock)) return;
  const directory = join(dirname(path), ".hibana");
  await mkdir(directory, { recursive: true });
  // mkdir serializes the comparison and publication across CLI processes.
  // Never steal a timed-out guard: its owner may still be writing the lock.
  const guard = join(directory, "lock-update");
  const deadline = performance.now() + 5000;
  for (;;) {
    signal?.throwIfAborted();
    try {
      await mkdir(guard);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (performance.now() >= deadline)
        throw new Error(
          "Timed out waiting to update hibana-lock.json. Retry after other Hibana commands finish. If no Hibana command is running, remove .hibana/lock-update and retry.",
        );
      await delay(25, undefined, { signal });
    }
  }
  try {
    signal?.throwIfAborted();
    const current = await readLock(path);
    if (isDeepStrictEqual(current, lock)) return;
    if (!isDeepStrictEqual(current, previous))
      throw new Error(
        "hibana-lock.json changed during extension installation. Retry the build.",
      );
    const candidate = join(guard, "hibana-lock.json");
    await writeFile(candidate, json(lock));
    signal?.throwIfAborted();
    await rename(candidate, path);
  } finally {
    await rm(guard, { recursive: true, force: true });
  }
}

function validateLock(lock, dependencies) {
  try {
    assert.equal(lock.schemaVersion, 1);
    assert.ok(managesExtensions(lock.sources));
    validateExtensionList(lock.sources);
    assert.ok(managesExtensions(lock.integrity));
    const archives = Object.keys(lock.sources).filter((name) =>
      isExtensionArchive(lock.sources[name]),
    );
    assert.deepEqual(Object.keys(lock.integrity).sort(), archives.sort());
    const lockedDependencies = Object.fromEntries(
      Object.entries(lock.sources).map(([name, source]) => {
        if (!isExtensionArchive(source)) return [name, source];
        assert.match(lock.integrity[name], /^[a-f0-9]{64}$/);
        return [name, `file:sources/${lock.integrity[name]}.tgz`];
      }),
    );
    assert.equal(lock.npm.lockfileVersion, 3);
    assert.equal(lock.npm.name, "hibana-application-extensions");
    assert.deepEqual(lock.npm.packages[""].dependencies, lockedDependencies);
    if (dependencies) assert.deepEqual(lockedDependencies, dependencies);
    for (const [path, pkg] of Object.entries<JsonObject>(lock.npm.packages)) {
      assert.ok(path === "" || /^node_modules\//.test(path));
      assert.ok(!path.includes("\\") && !path.split("/").includes(".."));
      assert.ok(!pkg.link);
      if (!path || pkg.inBundle) continue;
      assert.match(pkg.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
      if (pkg.resolved?.startsWith("file:")) {
        assert.match(pkg.resolved, /^file:sources\/[a-f0-9]{64}\.tgz$/);
        assert.ok(Object.values(lockedDependencies).includes(pkg.resolved));
      } else {
        const url = new URL(pkg.resolved);
        assert.equal(url.protocol, "https:");
        assert.ok(!url.username && !url.password);
      }
    }
  } catch (error) {
    throw new Error(
      "Invalid hibana-lock.json: extension dependencies must have pinned sources and integrity",
      { cause: error },
    );
  }
}

async function npm(command: string, directory: string, signal?: AbortSignal) {
  try {
    await run(
      "npm",
      [
        command,
        "--ignore-scripts",
        "--no-bin-links",
        "--no-audit",
        "--no-fund",
        "--omit=dev",
        "--workspaces=false",
      ],
      {
        cwd: directory,
        capture: true,
        signal,
        timeout: 120000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
  } catch (error) {
    throw new Error(
      `Could not install Hibana extensions: ${error.stderr?.trim() || error.message}`,
      { cause: error },
    );
  }
}

export async function installExtensionPackages(
  config,
  { frozenLockfile = false, signal }: BuildOptions = {},
) {
  signal?.throwIfAborted();
  const sources = Object.fromEntries(
    Object.entries<string>(config.extensions || {}).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
  );
  const project = await realpath(config.root);
  const dependencies = {},
    archives = new Map(),
    integrity = {};
  for (const [name, source] of Object.entries<string>(sources)) {
    if (isExtensionArchive(source)) {
      const path = await realpath(resolve(project, source));
      if (!isInside(project, path))
        throw new Error(
          "Extension archives must stay inside the project, including symlinks",
        );
      const digest = await archiveDigest(path, signal);
      const file = `sources/${digest}.tgz`;
      archives.set(file, { path, digest });
      integrity[name] = digest;
      dependencies[name] = `file:${file}`;
    } else dependencies[name] = source;
  }

  const lockPath = join(project, "hibana-lock.json");
  const previous = await readLock(lockPath);
  signal?.throwIfAborted();
  const empty = !Object.keys(sources).length;
  // Plain applications need no extension lock. Removing previously locked
  // extensions, however, must go through the same frozen check and lock update.
  if (empty && !previous) return { root: project, managed: true };
  const matches = previous && isDeepStrictEqual(previous.sources, sources);
  if (frozenLockfile && !matches)
    throw new Error(
      "hibana-lock.json is missing or differs from hibana.json. Run hibana build locally and commit hibana-lock.json.",
    );
  for (const [name, digest] of Object.entries(integrity)) {
    if (
      previous?.sources?.[name] === sources[name] &&
      previous.integrity?.[name] !== digest
    )
      throw new Error(
        `Extension archive integrity differs from hibana-lock.json for ${name}. Restore the archive, or use a new source path for an intentional update.`,
      );
  }
  if (previous) validateLock(previous, matches ? dependencies : undefined);
  if (matches) {
    if (!isDeepStrictEqual(previous.integrity, integrity))
      throw new Error(
        "Invalid hibana-lock.json: archive integrity does not match the extension sources",
      );
  }
  if (empty) {
    if (matches) return { root: project, managed: true };
    const { name, version } = manifest({});
    const lock = {
      schemaVersion: 1,
      sources: {},
      integrity: {},
      npm: {
        name,
        version,
        lockfileVersion: 3,
        requires: true,
        packages: { "": { name, version, dependencies: {} } },
      },
    };
    return {
      root: project,
      managed: true,
      commitLock: () => commitLock(lockPath, previous, lock, signal),
    };
  }
  const directory = join(project, ".hibana/extensions");
  await mkdir(directory, { recursive: true });
  if (matches) {
    const key = hash(json(previous)),
      cached = join(directory, key);
    const complete = await isCompleteInstallation(cached, key);
    signal?.throwIfAborted();
    if (complete) return { root: cached, managed: true };
  }

  const staging = await mkdtemp(join(directory, "staging-"));
  try {
    await mkdir(join(staging, "sources"));
    for (const [file, { path, digest }] of archives) {
      const output = await open(join(staging, file), "wx");
      try {
        // The source may change after hashing. npm reads only this verified copy.
        if ((await archiveDigest(path, signal, output)) !== digest)
          throw new Error(
            "Extension archive changed during installation. Retry the build.",
          );
      } finally {
        await output.close();
      }
    }
    await writeFile(
      join(staging, "package.json"),
      json(manifest(dependencies)),
    );
    // npm install applies source changes to the existing resolution. Starting
    // without it would also upgrade unrelated dependencies with version ranges.
    if (previous)
      await writeFile(join(staging, "package-lock.json"), json(previous.npm));
    console.error(
      matches
        ? "Restoring locked Hibana extensions..."
        : "Preparing Hibana extensions from hibana.json...",
    );
    await npm(matches ? "ci" : "install", staging, signal);
    for (const name of Object.keys(sources)) {
      const pkg = JSON.parse(
        await readFile(
          join(staging, "node_modules", name, "package.json"),
          "utf8",
        ),
      );
      if (pkg.name !== name)
        throw new Error(`Extension package name does not match ${name}`);
    }
    const lock = matches
      ? previous
      : {
          schemaVersion: 1,
          sources,
          integrity,
          npm: JSON.parse(
            await readFile(join(staging, "package-lock.json"), "utf8"),
          ),
        };
    validateLock(lock, dependencies);
    const key = hash(json(lock)),
      cached = join(directory, key);
    signal?.throwIfAborted();
    await publishInstallation(staging, cached, key);
    signal?.throwIfAborted();
    return {
      root: cached,
      managed: true,
      commitLock: () => commitLock(lockPath, previous, lock, signal),
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
