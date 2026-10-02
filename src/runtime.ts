import type { CliOptions, RuntimeOptions } from "./types.js";
import { access, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { RUNTIME_VERSION, releaseBase, releaseVersion } from "./package.js";

const binaryLimit = 160 * 1024 * 1024;
export function runtimeTarget(
  platform = process.platform,
  arch = process.arch,
) {
  if (
    !["linux", "darwin"].includes(platform) ||
    !["x64", "arm64"].includes(arch)
  )
    throw new Error(
      `No local Hibana runtime for ${platform}/${arch}; remote deployment is still available`,
    );
  return `${platform}-${arch}`;
}
export function runtimePath(
  version,
  {
    home = process.env.HIBANA_RUNTIME_HOME ||
      join(
        process.env.XDG_DATA_HOME || join(homedir(), ".local/share"),
        "hibana/runtimes",
      ),
    target = runtimeTarget(),
  } = {},
) {
  return join(resolve(home), releaseVersion(version), target, "hibana-worker");
}
export async function installedRuntime() {
  const version = RUNTIME_VERSION;
  const path = runtimePath(version);
  try {
    await access(path, constants.X_OK);
    return path;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EACCES") return undefined;
    throw error;
  }
}
export function releaseChecksum(contents, name) {
  const entries = contents
    .split(/\r?\n/)
    .map((line) => /^([a-f0-9]{64})\s+\*?([^\s]+)$/.exec(line))
    .filter((match) => match && match[2] === name);
  if (entries.length !== 1)
    throw new Error(`Release checksum missing or duplicated for ${name}`);
  return entries[0][1];
}
async function downloadStream(url, limit, signal, fetcher) {
  for (let redirects = 0; redirects <= 5; redirects++) {
    const target = new URL(url);
    if (target.protocol !== "https:" || target.username || target.password)
      throw new Error(
        "Runtime downloads require HTTPS without URL credentials",
      );
    const response = await fetcher(target, { redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location)
        throw new Error("Runtime download redirect has no destination");
      url = new URL(location, target).href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Runtime release download: HTTP ${response.status}. This version may not be published yet; use --from FILE --sha256 HASH for offline installation`,
      );
    }
    if (Number(response.headers.get("content-length")) > limit) {
      await response.body?.cancel();
      throw new Error("Runtime download exceeds size limit");
    }
    return response.body ?? [];
  }
  throw new Error("Too many runtime download redirects");
}

async function* bounded(source, limit) {
  let size = 0;
  for await (const chunk of source) {
    size += chunk.length;
    if (size > limit) throw new Error("Runtime data exceeds size limit");
    yield chunk;
  }
}

export async function installRuntime(
  options: CliOptions = {},
  {
    fetcher = fetch,
    home,
    target = runtimeTarget(),
    signal: cancellation,
    log = console.log,
  }: RuntimeOptions = {},
) {
  cancellation?.throwIfAborted();
  const version = releaseVersion(
    options.version || RUNTIME_VERSION,
  );
  if (Boolean(options.from) !== Boolean(options.sha256))
    throw new Error(
      "Offline installation requires both --from FILE and --sha256 HASH",
    );
  const name = `hibana-worker-${version}-${target}`;
  let expected, url;
  let signal = cancellation;
  if (options.from) {
    expected = options.sha256;
    if (!/^[a-f0-9]{64}$/.test(expected))
      throw new Error(
        "--sha256 must contain 64 lowercase hexadecimal characters",
      );
    if ((await stat(options.from)).size > binaryLimit)
      throw new Error("Runtime file exceeds size limit");
  } else {
    const deadline = AbortSignal.timeout(180000);
    signal = cancellation
      ? AbortSignal.any([deadline, cancellation])
      : deadline;
    const base = releaseBase(version);
    const checksums = await downloadStream(
      base + "SHA256SUMS",
      64 * 1024,
      signal,
      fetcher,
    );
    expected = releaseChecksum(
      Buffer.concat(
        await Array.fromAsync(bounded(checksums, 64 * 1024)),
      ).toString("utf8"),
      name,
    );
    url = base + name;
  }
  signal?.throwIfAborted();
  const destination = runtimePath(version, { home, target });
  const directory = resolve(destination, "..");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o700);
    try {
      const source = options.from
        ? createReadStream(options.from, { signal })
        : await downloadStream(url, binaryLimit, signal, fetcher);
      const hash = createHash("sha256");
      let received = false;
      // Await each write before reading more. Only the small checksum manifest
      // is buffered; executable bytes share the same bounded path online/offline.
      for await (const chunk of bounded(source, binaryLimit)) {
        signal?.throwIfAborted();
        received ||= chunk.length > 0;
        hash.update(chunk);
        await file.writeFile(chunk);
      }
      if (!received || hash.digest("hex") !== expected)
        throw new Error(
          "Runtime checksum mismatch; existing installation was preserved",
        );
      await file.chmod(0o700);
    } finally {
      await file.close();
    }
    signal?.throwIfAborted();
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  log(
    `Installed hibana-worker ${version} (${target}) at ${destination}`,
  );
  return destination;
}
