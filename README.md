# Hibana CLI

The public TypeScript CLI for building and deploying Hibana WebAssembly applications.
The executable remains `hibana`; the npm package remains `@yukiharada1228/hibana`.
The Hibana service and infrastructure are maintained separately in a private repository.

## Quick start

Requires Node.js 24 or newer and npm.

```sh
npm install -g @yukiharada1228/hibana@latest
hibana init my-api
cd my-api
npm run dev
```

Hono applications compile to a WASI HTTP Component. `hibana dev` installs a checksum-verified
local Worker on first use. `hibana build` produces `.hibana/build/app.wasm`.

```sh
hibana login --help
hibana deploy --help
hibana --help
```

Use connection profiles for remote deployments. Credentials stay in local profile storage;
application secrets are managed with `hibana secret`. Infrastructure administration commands
(`hibana platform ...`) belong to the private operator tools, and are not in this package.

## Platforms

| Capability | Linux | macOS | Windows |
| --- | --- | --- | --- |
| CLI, login, profiles, remote deployment | Yes | Yes | Yes |
| TypeScript/Hono component build | Yes | Yes | Yes |
| Native local Worker / `hibana dev` | x64, arm64 | x64, arm64 | Use WSL2 |

The CLI uses Node.js APIs and a bundled WASI composition helper. Users do not need Rust,
Docker, a shell script installer, or a separately installed `wac` binary to build applications.
Windows native Worker support is a separate runtime concern; TypeScript alone does not port
Wasmtime or the Worker to Windows. CI tests the public CLI and packed build on all three OSes.
POSIX process/signal and native Worker lifecycle tests run on Linux and macOS.

## Versions and migration

CLI `0.4.0-rc.2` is independently versioned and targets Worker `0.3.0-rc.5`.
Worker binaries are distributed from this repository's `runtime-v<version>` releases,
with `SHA256SUMS` and third-party license archives. These releases contain compiled runtimes,
not private backend source code. Public npm releases contain only the CLI, compiler assets,
WIT interfaces, templates, and notices.

Update existing applications with:

```sh
npm install --save-dev @yukiharada1228/hibana@latest
```

The previous Rust CLI's automatic runtime download points at the old repository. After that
repository becomes private, update the CLI before installing a new local runtime. Already
installed runtimes and `runtime install --from FILE --sha256 HASH` continue to work.
Backend versions, CLI releases and production deployments no longer trigger each other.

## Development

```sh
npm ci
npm run check
npm test
npm run test:package
```

Set `HIBANA_RUNTIME_BIN` to a compatible Worker executable when running `test:package` to
also check real HTTP responses and graceful shutdown. The packaged smoke test installs into
a fresh path containing spaces, builds Hono with `node:crypto`, and validates the component.

`src/` contains the TypeScript implementation. `tools/compose/` is a small WASI helper around
`wac-graph`; rebuild it with `cargo build --locked --release --target wasm32-wasip1
--manifest-path tools/compose/Cargo.toml` and copy the resulting `hibana_component_compose.wasm` to
`assets/compose.wasm`. Update `assets/checksums.json` when intentionally changing an asset.
The other assets are pinned compiler/runtime distribution artifacts imported from Hibana
0.3.0-rc.5. See `assets/engine.json`, `THIRD_PARTY_LICENSES.txt` and `licenses/` for provenance
and notices. The patched engine source inputs are in `tools/engine/`. These assets
do not contain service credentials or infrastructure configuration.

## Releasing

CI must pass on Linux, macOS and Windows. Bump package and lockfile versions together and
push `v<package version>`. `.github/workflows/release.yml` publishes the tested tarball using
npm trusted publishing (GitHub OIDC), then creates the CLI GitHub Release. The existing `latest` channel
continues to receive the current CLI candidate, so ordinary npx users migrate too. Runtime
tags never publish npm packages.
Configure the npm trusted publisher for owner `yukiharada1228`, repository `hibana-cli`,
workflow `release.yml` (no environment). No npm publishing token is stored in GitHub.
