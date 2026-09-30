import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { x } from "tar";
import type { ExtensionPlan } from "./types.js";

interface Primitive { component: string; wit: string }
interface RuntimeManifest {
  version: string;
  modules: Record<string, string>;
  preload: string;
  components: Record<string, Primitive>;
}

/** These reviewed adapters are compiler assets, not user-installable plugins. */
export async function installNodeCompat(plan: ExtensionPlan, work: string) {
  const directory = join(work, "node-runtime");
  await mkdir(directory);
  await x({ file: fileURLToPath(new URL("../assets/node-runtime.tar.gz", import.meta.url)), cwd: directory, strip: 1 });
  const manifest: RuntimeManifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  const modules: string[] = [];
  plan.requireAliases ??= {};
  for (const [name, path] of Object.entries(manifest.modules)) {
    const standard = join(directory, path);
    const shared = plan.aliases[name] || plan.aliases[`node:${name}`];
    for (const alias of [name, `node:${name}`]) {
      if (!Object.hasOwn(plan.aliases, alias)) {
        plan.aliases[alias] = shared || standard;
        plan.requireAliases[alias] = shared || standard.replace(/\.mjs$/, ".cjs");
      }
    }
    if (!shared) modules.push(name);
  }
  plan.preload.unshift(join(directory, manifest.preload));
  const components = Object.entries(manifest.components).filter(([name]) => !plan.imports.includes(name));
  plan.imports.push(...components.map(([name]) => name));
  plan.metadata.node_compat = { version: manifest.version, modules };
  return (imports: string[]) => {
    const names = new Set(components.map(([name]) => name));
    plan.imports = plan.imports.filter(name => !names.has(name) || imports.includes(name));
    for (const [name, paths] of components) {
      if (!imports.includes(name)) continue;
      plan.components.push(join(directory, paths.component));
      plan.witDirectories.push(join(directory, paths.wit));
      if ((name.startsWith("hibana:tcp/") || name.startsWith("hibana:dns/")) && !plan.permissions.includes("outbound-network")) {
        plan.permissions.push("outbound-network");
      }
    }
  };
}
