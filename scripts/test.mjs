import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
// POSIX signal delivery and the native local Worker are tested on Linux/macOS.
// Windows runs the same portable command, API, auth, build and package contracts.
const posix = new Set(["dev.test.mjs", "process.test.mjs", "lifecycle.test.mjs", "tail.test.mjs"]);
const files = (await readdir("test")).filter(name => name.endsWith(".test.mjs") && (process.platform !== "win32" || !posix.has(name)));
const child = spawn(process.execPath, ["--test", ...files.map(name => `test/${name}`)], {stdio: "inherit"});
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
