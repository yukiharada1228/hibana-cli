import { isApplicationName } from "./application-name.js";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { run } from "./process.js";
import { packageInfo } from "./package.js";

const templateSource =
  "import { Hono } from 'hono'\n\nconst app = new Hono()\n\napp.get('/', (c) => c.text('Hello from Hono on Hibana 🔥'))\n\nexport default app\n";
export const templates = ["hono", "react"];
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
  if (template === "hono") await writeFile(join(root, "src/index.ts"), templateSource);
  else await createReact(root, name);
  const config: Record<string, unknown> = {
    name,
    secrets: [],
    vars: {},
    limits: { memory_mb: 256, timeout_ms: 15000 },
  };
  const { name: cliName, version } = await packageInfo();
  if (template === "hono") config.main = "src/index.ts";
  else {
    for (const key of Object.keys(config)) if (key !== "name") delete config[key];
    config.assets = { directory: "dist" };
    config.build = { commands: [["npm", "run", "build"]] };
  }
  await writeFile(
    join(root, "package.json"),
    JSON.stringify(
      {
        name,
        private: true,
        type: "module",
        scripts: {
          dev: template === "react" ? "vite --host 127.0.0.1" : "hibana dev",
          build: template === "react" ? "tsc --noEmit && vite build" : "hibana build",
          ...(template === "react" ? { preview: "hibana dev" } : {}),
          deploy: "hibana deploy",
        },
        dependencies: template === "react" ? { react: "19.3.0", "react-dom": "19.3.0" } : { hono: "^4.6.0" },
        devDependencies: {
          ...(template === "react" ? { vite: "8.3.2", "@vitejs/plugin-react": "6.1.1", typescript: "5.9.3", "@types/react": "19.3.0", "@types/react-dom": "19.3.0" } : {}),
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
    "node_modules/\ndist/\n.hibana/\n.dev.vars\n.env.local\n.env.*.local\ntarget/\n*.wasm\n",
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

async function createReact(root: string, name: string) {
  const files = {
    "index.html": `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${name}</title></head>
<body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>
`,
    "vite.config.ts": `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({ plugins: [react()] })
`,
    "src/vite-env.d.ts": '/// <reference types="vite/client" />\n',
    "src/main.tsx": `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './style.css'

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
`,
    "src/App.tsx": `import { useState } from 'react'

export default function App() {
  const [count, setCount] = useState(0)
  return <main><p className="eyebrow">HIBANA</p><h1>Your next idea starts here.</h1><p>Edit src/App.tsx and see your changes.</p><button onClick={() => setCount(count + 1)}>Count: {count}</button></main>
}
`,
    "src/style.css": `:root { font-family: system-ui, sans-serif; color: #24312b; background: #f4f1e9; }
body { margin: 0; }
main { max-width: 48rem; margin: 15vh auto; padding: 2rem; }
.eyebrow { color: #a23f27; font-weight: 700; letter-spacing: .15em; }
h1 { font-size: clamp(2.5rem, 8vw, 5rem); line-height: 1.1; letter-spacing: -.05em; }
p { line-height: 1.7; }
button { font: inherit; padding: .8rem 1.4rem; border: 0; border-radius: .5rem; color: white; background: #254e3d; cursor: pointer; }
button:focus-visible { outline: 3px solid #a23f27; outline-offset: 4px; }
`,
    "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", lib: ["ES2022", "DOM", "DOM.Iterable"], module: "ESNext", moduleResolution: "Bundler", jsx: "react-jsx", strict: true, skipLibCheck: true, noEmit: true, isolatedModules: true }, include: ["src"] }, null, 2) + "\n",
    "README.md": `# ${name}

React + TypeScript + Vite on Hibana.

- \`npm run dev\`: Vite development server with hot reload.
- \`npm run build\`: type-check and build dist/.
- \`npm run preview\`: build and preview using Hibana SPA routing.
- \`npm run deploy\`: build and publish to your logged-in Hibana platform.
- \`npm exec -- hibana rollback\`: activate the previous deployment.

Values embedded in the frontend are public. Keep database bindings and secrets in a separate Hono API.
`,
  };
  for (const [path, contents] of Object.entries(files)) await writeFile(join(root, path), contents);
}
