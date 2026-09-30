import { isApplicationName } from "./application-name.js";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { run } from "./process.js";
import { packageInfo } from "./package.js";

const templateSource =
  "import { Hono } from 'hono'\n\nconst app = new Hono()\n\napp.get('/', (c) => c.text('Hello from Hono on Hibana 🔥'))\n\nexport default app\n";
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
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/index.ts"), templateSource);
  const config: Record<string, unknown> = {
    name,
    secrets: [],
    vars: {},
    limits: { memory_mb: 256, timeout_ms: 15000 },
  };
  const { name: cliName, version } = await packageInfo();
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
        dependencies: { hono: "^4.6.0" },
        devDependencies: {
          [cliName]: cliPackage ? `file:${resolve(cliPackage)}` : version,
        },
        engines: { node: ">=24" },
      },
      null,
      2,
    ) + "\n",
  );

  await writeFile(
    join(root, "hibana.json"),
    JSON.stringify(config, null, 2) + "\n",
  );
  await writeFile(
    join(root, ".gitignore"),
    "node_modules/\n.hibana/\n.dev.vars\ntarget/\n*.wasm\n",
  );
  console.log(`Created ${root}`);
  const changeDirectory =
    root === process.cwd() ? [] : [`cd ${shellPath(root)}`];
  if (install) {
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
    ...(!install ? ["npm install"] : []),
    "npm run dev",
  ];
  console.log(`\nNext:\n${next.map((command) => `  ${command}`).join("\n")}`);
}
