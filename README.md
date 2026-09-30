# Hibana CLI

Build, run, and deploy WebAssembly apps with Hibana.

Start with a TypeScript/Hono app, develop locally with automatic reloads, and deploy
to a Hibana server from your terminal.

## Quick start

Requires Node.js 24 or newer and npm.

```sh
npm install -g @yukiharada1228/hibana@latest
hibana init my-api
cd my-api
npm run dev
```

Open **http://127.0.0.1:8787** and edit `src/index.ts`. The local runtime is downloaded
automatically on first use. Project settings live in `hibana.json`.

## Deploy

Sign in with your Hibana management API URL and tenant name:

```sh
hibana login --url https://api.example.com --tenant team
hibana deploy
```

Login saves your connection for subsequent commands. Deploy builds the app and
activates a new version. For CI, set `HIBANA_URL` and `HIBANA_TOKEN`.

## Commands

| Command | Purpose |
| --- | --- |
| `hibana build` | Build a WebAssembly component at `.hibana/build/app.wasm` |
| `hibana tail` | Stream live application logs |
| `hibana list` | List deployed apps |
| `hibana rollback` | Restore the previous version |
| `hibana secret` | Manage application secrets |
| `hibana profile` | Manage saved connections |

Run `hibana --help` for all commands or `hibana <command> --help` for options.

## Platforms

Building and deploying work on Linux, macOS, and Windows. Local development
(`hibana dev`) supports Linux and macOS on x64 and arm64; use WSL2 on Windows.

## Development

```sh
npm ci
npm run check
npm test
npm run test:package
```

Set `HIBANA_RUNTIME_BIN` to a compatible runtime executable to include local HTTP
and shutdown checks in `test:package`.

## License

[MIT](LICENSE). Bundled dependencies have their own licenses; see
[third-party notices](THIRD_PARTY_LICENSES.txt).
