import { isApplicationName } from "./application-name.js";
import { cp, mkdir, readdir, writeFile } from "node:fs/promises";
import { resolve, join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./process.js";
import { packageInfo } from "./package.js";

const sdk = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const templates = ["hono"];
function shellPath(path) {
  return /^[a-zA-Z0-9_./-]+$/.test(path)
    ? path
    : `'${path.replaceAll("'", "'\\''")}'`;
}

export async function init(
  directory = ".",
  { template = "hono", install = true, cliPackage }: {template?: string; install?: boolean; cliPackage?: string} = {},
) {
  if (!templates.includes(template))
    throw new Error(`Supported templates: ${templates.join(", ")}`);
  const root = resolve(directory);
  const name = basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  if (!isApplicationName(name))
    throw new Error(
      "Choose a project directory containing ASCII letters or digits",
    );
  await mkdir(root, { recursive: true });
  if ((await readdir(root)).some((name) => name !== ".git"))
    throw new Error(
      `Directory is not empty: ${root}\nChoose a new directory, for example hibana init my-api.`,
    );
  await cp(join(sdk, "templates", template), root, { recursive: true });
  const config: Record<string, unknown> = {
    name,
    secrets: [],
    vars: template === "hono" ? {} : { GREETING: "Hello Hibana" },
    limits: { memory_mb: 256, timeout_ms: 15000 },
  };
  const javascript = template === "hono" || template === "javascript";
  const { name: cliName, version } = await packageInfo();
  if (javascript) {
    config.main = "src/index.ts";
    await writeFile(
      join(root, "package.json"),
      JSON.stringify(
        {
          name,
          private: true,
          type: "module",
          scripts: {
            dev: "hibana dev",
            build: "hibana build",
            deploy: "hibana deploy",
          },
          ...(template === "hono" ? { dependencies: { hono: "^4.6.0" } } : {}),
          devDependencies: {
            [cliName]: cliPackage ? `file:${resolve(cliPackage)}` : version,
          },
          engines: { node: ">=24" },
        },
        null,
        2,
      ) + "\n",
    );
  }

  await writeFile(
    join(root, "hibana.json"),
    JSON.stringify(config, null, 2) + "\n",
  );
  await writeFile(
    join(root, ".gitignore"),
    "node_modules/\n.hibana/\n.dev.vars\ntarget/\n*.wasm\n" +
      (template === "go" ? "# Generated WIT bindings\nbindings/\n" : ""),
  );
  console.log(`Created ${root}`);
  const changeDirectory =
    root === process.cwd() ? [] : [`cd ${shellPath(root)}`];
  if (javascript && install) {
    console.log("Installing project dependencies...");
    try {
      await run("npm", ["install"], { cwd: root });
    } catch (error) {
      throw new Error(
        `Project files are ready, but dependency installation failed: ${error.message}\nRetry from the project directory:\n${[...changeDirectory, "npm install", "npm run dev"].map((command) => `  ${command}`).join("\n")}`,
        { cause: error },
      );
    }
  }
  const next = [
    ...changeDirectory,
    ...(javascript && !install ? ["npm install"] : []),
    javascript ? "npm run dev" : `npx -y ${cliName}@${version} dev`,
  ];
  console.log(`\nNext:\n${next.map((command) => `  ${command}`).join("\n")}`);
  if (!javascript)
    console.log(
      template === "rust"
        ? "\nRequires Rust and the wasm32-wasip2 target (rustup target add wasm32-wasip2)."
        : "\nRequires Go; the project's componentize-go tool is installed by go tool on first use.",
    );
}
