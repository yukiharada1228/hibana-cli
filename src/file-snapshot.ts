import type { BigIntStats } from "node:fs";

export function sameFile(before: BigIntStats, after: BigIntStats) {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode;
}

// Ignore atime, which reading can update. Nanosecond timestamps detect writes
// of the same length as well as truncation, replacement and directory changes.
export function sameRevision(before: BigIntStats, after: BigIntStats) {
  return sameFile(before, after) && before.size === after.size &&
    before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}
