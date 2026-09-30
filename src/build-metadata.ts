// A custom section travels with the artifact, including through signing and upload.
// This is a build declaration, not proof of the code's behavior or a permission grant.
export const BUILD_METADATA_SECTION = "hibana:build";
export const MAX_BUILD_METADATA_BYTES = 32 * 1024;
const HEADER = Buffer.from([0, 97, 115, 109, 13, 0, 1, 0]);
// Keep a BOM visible to JSON.parse, which rejects it like the server does.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function leb(value) {
  const bytes: number[] = [];
  do {
    const next = value >>> 7;
    bytes.push((value & 127) | (next ? 128 : 0));
    value = next;
  } while (value);
  return Buffer.from(bytes);
}

// Only walk outer sections. Metadata inside a composed dependency does not
// describe the application. The server still validates the complete component.
function* sections(bytes) {
  if (!bytes.subarray(0, 8).equals(HEADER))
    throw new Error("Build metadata requires a WebAssembly Component");
  let offset = 8;
  function length(end = bytes.length) {
    let value = 0;
    for (let i = 0; i < 5 && offset < end; i++) {
      const byte = bytes[offset++];
      if (i === 4 && byte > 15) break;
      value += (byte & 127) * 2 ** (i * 7);
      if (!(byte & 128)) return value;
    }
    throw new Error("Malformed WebAssembly section length");
  }
  let found = false;
  while (offset < bytes.length) {
    const start = offset;
    const id = bytes[offset++];
    const size = length();
    const end = offset + size;
    if (end > bytes.length) throw new Error("Truncated WebAssembly section");
    let metadata = false;
    if (id === 0) {
      const nameSize = length(end);
      const nameEnd = offset + nameSize;
      if (nameEnd > end)
        throw new Error("Truncated WebAssembly custom section");
      metadata =
        bytes.subarray(offset, nameEnd).toString("utf8") ===
        BUILD_METADATA_SECTION;
      offset = nameEnd;
    }
    if (metadata) {
      if (found) throw new Error("Duplicate Hibana build metadata sections");
      found = true;
    }
    yield {
      start,
      end,
      data: metadata ? bytes.subarray(offset, end) : undefined,
    };
    offset = end;
  }
}

function parseMetadata(data) {
  if (data.length > MAX_BUILD_METADATA_BYTES)
    throw new Error("Build metadata exceeds 32 KiB");
  try {
    return JSON.parse(decoder.decode(data));
  } catch {
    throw new Error("Build metadata must be valid JSON");
  }
}

export function readBuildMetadata(bytes) {
  let metadata;
  for (const { data } of sections(bytes)) {
    if (data) metadata = data;
  }
  return metadata ? parseMetadata(metadata) : null;
}

export function withBuildMetadata(
  bytes,
  metadata,
  { preserveExisting = false } = {},
) {
  const parts = [preserveExisting ? bytes : HEADER];
  let existing;
  for (const { start, end, data } of sections(bytes)) {
    if (data) existing = data;
    else if (!preserveExisting) parts.push(bytes.subarray(start, end));
  }
  if (preserveExisting && existing) {
    parseMetadata(existing);
    return bytes;
  }
  const json = Buffer.from(JSON.stringify(metadata));
  if (json.length > MAX_BUILD_METADATA_BYTES)
    throw new Error("Build metadata exceeds 32 KiB");
  const name = Buffer.from(BUILD_METADATA_SECTION);
  const payload = Buffer.concat([leb(name.length), name, json]);
  return Buffer.concat([
    ...parts,
    Buffer.from([0]),
    leb(payload.length),
    payload,
  ]);
}
