import { createHash } from "node:crypto";
import { constants, watch } from "node:fs";
import { lstat, realpath, opendir, open, mkdir, mkdtemp, writeFile, link, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve, relative, extname } from "node:path";
import { Header, Pax } from "tar";
import { isInside } from "./paths.js";
import { run } from "./process.js";
import type { BuildOptions } from "./types.js";
import type { BigIntStats } from "node:fs";
import { sameFile, sameRevision } from "./file-snapshot.js";

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 4096;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export function validAssetPath(path: string) {
  return Boolean(path) && Buffer.byteLength(path) <= 1024 && path.split("/").length <= 32 &&
    !/[\\%?#:\x00-\x1f\x7f-\x9f]/u.test(path) &&
    path.split("/").every(part => part && !part.startsWith("."));
}

async function outputDirectory(config) {
  const root = await realpath(config.root);
  const path = resolve(root, config.assets.directory);
  if (!isInside(root, path) || path === root) throw new Error("assets.directory must be a build output directory inside the project");
  const rootStat = await lstat(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Static output changed while reading");
  const parents = new Map<string, BigIntStats>([[root, rootStat]]);
  let current = root;
  for (const part of relative(root, path).split(/[\\/]/)) {
    current = join(current, part);
    const info = await lstat(current, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Static output directories must not contain symlinks");
    parents.set(current, info);
  }
  return { directory: path, parents };
}

// Snapshot bounded regular files before packing: no archive extraction, hidden
// paths, symlinks, devices or unbounded reads. Match hibana-assets' wire contract.
export async function snapshot(config, signal?: AbortSignal) {
  const { directory, parents } = await outputDirectory(config);
  const files = new Map<string, Buffer>();
  const observed = new Map<string, BigIntStats>();
  let bytes = 0, entries = 0;
  async function visit(folder: string, prefix: string) {
    const folderStat = await lstat(folder, { bigint: true });
    if (!folderStat.isDirectory() || folderStat.isSymbolicLink()) throw new Error("Static output directories must not contain symlinks");
    observed.set(folder, folderStat);
    const dir = await opendir(folder, { encoding: "utf8" });
    for await (const entry of dir) {
      signal?.throwIfAborted();
      if (++entries > MAX_FILES * 2) throw new Error("Too many static output entries");
      const path = prefix + entry.name;
      if (!validAssetPath(path)) throw new Error(`Invalid static asset path: ${path}`);
      const full = join(folder, entry.name);
      const info = await lstat(full, { bigint: true });
      if (info.isSymbolicLink()) throw new Error("Static output must not contain symlinks");
      if (info.isDirectory()) { await visit(full, path + "/"); continue; }
      if (!info.isFile()) throw new Error("Static output may contain only regular files");
      if (files.size >= MAX_FILES || info.size > BigInt(MAX_BYTES - bytes)) throw new Error("Static site exceeds 4096 files or 64 MiB");
      const file = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
      try {
        const opened = await file.stat({ bigint: true });
        if (!opened.isFile() || !sameRevision(info, opened)) throw new Error("Static output changed while reading");
        const chunks: Buffer[] = [];
        let size = 0;
        while (true) {
          signal?.throwIfAborted();
          const block = Buffer.alloc(Math.min(65536, MAX_BYTES - bytes - size + 1));
          const { bytesRead } = await file.read(block, 0, block.length, null);
          if (!bytesRead) break;
          size += bytesRead;
          if (bytes + size > MAX_BYTES) throw new Error("Static site exceeds 64 MiB");
          chunks.push(block.subarray(0, bytesRead));
        }
        if (BigInt(size) !== opened.size || !sameRevision(opened, await file.stat({ bigint: true }))) throw new Error("Static output changed while reading");
        observed.set(full, opened);
        bytes += size;
        files.set(path, Buffer.concat(chunks, size));
      } finally { await file.close(); }
    }
  }
  await visit(directory, "");
  // Recheck the whole traversal before publishing. O_NOFOLLOW protects the
  // final file only; parents can also be replaced while a build is running.
  for (const [path, before] of parents) {
    signal?.throwIfAborted();
    if (!sameFile(before, await lstat(path, { bigint: true }))) throw new Error("Static output changed while reading");
  }
  for (const [path, before] of observed) {
    signal?.throwIfAborted();
    if (!sameRevision(before, await lstat(path, { bigint: true }))) throw new Error("Static output changed while reading");
  }
  if (!files.get("index.html")?.length) throw new Error("Static site requires a nonempty index.html");
  return { directory, files };
}

export function packAssets(files: Map<string, Buffer>) {
  const chunks: Buffer[] = [];
  let size = 0;
  function add(bytes: Buffer) {
    size += bytes.length;
    if (size > MAX_BYTES) throw new Error("Static bundle exceeds 64 MiB including tar headers");
    chunks.push(bytes);
  }
  for (const path of [...files.keys()].sort()) {
    const bytes = files.get(path)!;
    const header = new Header({ path, type: "File", size: bytes.length, mode: 0o644, uid: 0, gid: 0, mtime: new Date(0) });
    if (header.encode()) add(new Pax({ path }).encode());
    add(header.block!);
    add(bytes);
    if (bytes.length % 512) add(Buffer.alloc(512 - bytes.length % 512));
  }
  add(Buffer.alloc(1024));
  return Buffer.concat(chunks, size);
}

export async function buildStatic(config, options: BuildOptions = {}) {
  for (const [command, ...args] of config.build?.commands || []) {
    options.signal?.throwIfAborted();
    await run(command, args, { cwd: config.root, signal: options.signal });
  }
  const { files } = await snapshot(config, options.signal);
  const bytes = packAssets(files);
  const directory = join(config.root, ".hibana/build/artifacts");
  await mkdir(directory, { recursive: true });
  const work = await mkdtemp(join(directory, "staging-"));
  const artifact = join(directory, `${hash(bytes)}.tar`);
  try {
    const candidate = join(work, "assets.tar");
    await writeFile(candidate, bytes);
    try { await link(candidate, artifact); } catch (error) { if (error.code !== "EEXIST") throw error; }
    return artifact;
  } finally { await rm(work, { recursive: true, force: true }); }
}

const mime: Record<string, string> = {
  ".html": "text/html", ".htm": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".map": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".avif": "image/avif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".otf": "font/otf", ".wasm": "application/wasm", ".txt": "text/plain", ".xml": "text/xml", ".pdf": "application/pdf",
  ".webmanifest": "application/manifest+json", ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg",
};
export function staticHandler(files: Map<string, Buffer>) {
  const indexed = new Map([...files].map(([path, bytes]) => [path, { bytes, etag: `"${hash(bytes)}"`, type: mime[extname(path).toLowerCase()] || "application/octet-stream" }]));
  return (request, response) => {
    const empty = (status: number) => { response.writeHead(status, { "cache-control": "no-store" }); response.end(); };
    // Keep localhost preview inaccessible through DNS rebinding.
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/i.test(request.headers.host || "")) return empty(403);
    if (!["GET", "HEAD"].includes(request.method)) { response.setHeader("allow", "GET, HEAD"); return empty(405); }
    let path: string;
    try { path = decodeURIComponent(request.url.split("?")[0]); } catch { return empty(400); }
    if (!path.startsWith("/")) return empty(400);
    const validated = path.slice(1).replace(/\/$/, "");
    if (path.includes("//") || (validated && !validAssetPath(validated))) return empty(404);
    const file = indexed.get(path.slice(1)) || indexed.get("index.html")!;
    const cached = (request.headers["if-none-match"] || "").split(",").some(tag => tag.trim() === "*" || tag.trim().replace(/^W\//, "") === file.etag);
    response.setHeader("etag", file.etag);
    response.setHeader("content-type", file.type);
    response.setHeader("x-content-type-options", "nosniff");
    if (!("authorization" in request.headers) && !("range" in request.headers)) response.setHeader("cache-control", "public, max-age=0, must-revalidate");
    if (!cached) response.setHeader("content-length", file.bytes.length);
    response.writeHead(cached ? 304 : 200);
    response.end(cached || request.method === "HEAD" ? undefined : file.bytes);
  };
}

export async function devStatic(config, options) {
  const port = Number(options.port || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port must be 1..65535");
  const controller = new AbortController();
  let server: ReturnType<typeof createServer> | undefined, watcher, timer, reload: Promise<void> | undefined;
  let handler, closed = false, dirty = false, initialized = false;
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  function stop() {
    closed = true; controller.abort(); clearTimeout(timer); watcher?.close();
    server?.close(); server?.closeAllConnections(); finish();
  }
  async function refresh() {
    do {
      dirty = false;
      try {
        const { files } = await snapshot(config, controller.signal);
        packAssets(files); // Validate the same aggregate limit as deployment.
        if (!closed) handler = staticHandler(files);
      } catch (error) { if (!closed) console.error(`Keeping previous static output: ${error.message}`); }
    } while (dirty && !closed);
  }
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    const root = await realpath(config.root);
    await buildStatic(config, { signal: controller.signal });
    if (closed) return;
    if (!options["no-watch"]) {
      // Subscribe before the first served snapshot: output can change while
      // the snapshot or HTTP listener is starting. Watch parents for renames.
      const directory = resolve(root, config.assets.directory);
      watcher = watch(root, { recursive: true }, (_, file) => {
        const changed = file ? resolve(root, String(file)) : root;
        if (!isInside(directory, changed) && !isInside(changed, directory)) return;
        if (!initialized || reload) { dirty = true; return; }
        clearTimeout(timer);
        timer = setTimeout(() => {
          reload = refresh().finally(() => { reload = undefined; });
        }, 150);
      });
      watcher.on("error", error => { console.error(error.message); process.exitCode = 1; stop(); });
    }
    const current = await snapshot(config, controller.signal);
    packAssets(current.files);
    handler = staticHandler(current.files);
    initialized = true;
    if (dirty && !closed) {
      reload = refresh().finally(() => { reload = undefined; });
      await reload;
    }
    if (closed) return;
    server = createServer((request, response) => handler(request, response));
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(port, "127.0.0.1", resolve); });
    server.on("error", error => { console.error(error.message); process.exitCode = 1; stop(); });
    console.log(`Static preview: http://127.0.0.1:${port} (rebuild frontend output to update; use npm run dev for React HMR)`);
    await done;
  } catch (error) { if (!closed) throw error; }
  finally { stop(); await reload; process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
