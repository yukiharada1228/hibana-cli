import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./process.js";

export async function compose(input: string, components: string[], output: string, signal?: AbortSignal) {
  const work = join(dirname(output), "compose");
  await mkdir(work);
  await copyFile(input, join(work, "input.wasm"));
  for (const [index, path] of components.entries()) await copyFile(path, join(work, `${index}.wasm`));
  await run(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    fileURLToPath(new URL("./compose-runner.js", import.meta.url)),
    "/work/output.wasm", "/work/input.wasm",
    ...components.map((_, index) => `/work/${index}.wasm`),
  ], { cwd: work, signal, timeout: 120_000, env: {} });
  await copyFile(join(work, "output.wasm"), output);
}
