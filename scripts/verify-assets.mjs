import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const sums = JSON.parse(await readFile(new URL("../assets/checksums.json", import.meta.url), "utf8"));
for (const [name, expected] of Object.entries(sums)) {
  const bytes = await readFile(new URL(`../assets/${name}`, import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), expected, `Bundled asset: ${name}`);
}
console.log(`Verified ${Object.keys(sums).length} bundled assets`);
