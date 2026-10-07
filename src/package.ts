import { readFile } from "node:fs/promises";
import validVersion from "semver/functions/valid.js";

export async function packageInfo() {
  return JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
}

export function releaseVersion(version) {
  if (typeof version !== "string" || validVersion(version) !== version)
    throw new Error("Version must be a release version such as 0.1.0");
  return version;
}

export function releaseBase(version) {
  return `https://github.com/yukiharada1228/hibana-cli/releases/download/runtime-v${releaseVersion(version)}/`;
}

// Runtime compatibility is independent of the CLI package version.
export const RUNTIME_VERSION = "0.3.0-rc.10";
