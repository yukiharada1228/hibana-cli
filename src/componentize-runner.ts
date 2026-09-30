// Run guest initialization in a child without the CLI's credentials.
import { componentize } from "@bytecodealliance/componentize-js";
import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { join } from "node:path";

const [source, wit, output] = process.argv.slice(2);
if (!source || !wit || !output) throw new Error("Missing componentization arguments");
const manifest = JSON.parse(await readFile(new URL("../assets/engine.json", import.meta.url), "utf8"));
const engine = gunzipSync(await readFile(new URL("../assets/starlingmonkey_embedding.wasm.gz", import.meta.url)), { maxOutputLength: 64 * 1024 * 1024 });
if (createHash("sha256").update(engine).digest("hex") !== manifest.sha256) throw new Error("JavaScript engine checksum mismatch");
const enginePath = join(process.cwd(), "engine.wasm");
await writeFile(enginePath, engine);
const result = await componentize({ sourcePath: source, witPath: wit, worldName: "http", engine: enginePath, env: {} });
await writeFile(output, result.component);
