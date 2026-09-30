// The small, portable WAC helper is built once for WASI; users do not need Rust.
import { WASI } from "node:wasi";
import { readFile } from "node:fs/promises";
const wasi = new WASI({
  version: "preview1",
  args: ["compose", ...process.argv.slice(2)],
  env: {},
  preopens: { "/work": process.cwd() },
  returnOnExit: true,
});
const module = await WebAssembly.compile(await readFile(new URL("../assets/compose.wasm", import.meta.url)));
const instance = await WebAssembly.instantiate(module, wasi.getImportObject() as WebAssembly.Imports);
process.exitCode = wasi.start(instance);
