# Hibana CLI

Build, run, and deploy Hono APIs and React SPAs with Hibana.

Create an app, develop locally, and deploy to a Hibana server from your terminal.
Hono APIs run as WebAssembly; React SPAs are served as static files.

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

## React SPA

The React and database commands below are included in this source checkout. Until
the next npm release, build and pack this checkout (`npm ci && npm pack`), then
use `node dist/cli.js init my-web --template react --cli-package /absolute/path/to/hibana.tgz`
with the tarball path printed by `npm pack`.

```sh
hibana init my-web --template react
cd my-web
npm run dev
```

This creates a React + TypeScript + Vite app, including `hibana.json` and local
CLI scripts. `npm run dev` provides Vite hot reload. `npm run preview` builds once
and serves the output with SPA fallback at **http://127.0.0.1:8787**; rebuild the
frontend to update that preview. No Wasm runtime is needed for static sites.

Run `npm run deploy` after signing in. To use an existing frontend, add:

```json
{
  "name": "my-web",
  "assets": { "directory": "dist" },
  "build": { "commands": [["npm", "run", "build"]] }
}
```

Here `npm run build` must run your frontend build, such as `vite build`, not
`hibana build` itself. `main`, `component` and `assets` are mutually exclusive.
An empty `index.html`, hidden files, symlinks and files outside the project are
rejected. Bundles allow at most 4,096 files and 64 MiB including tar headers;
the server upload limit also applies (32 MiB by default).

Unmatched public routes return `index.html`. GET/HEAD, MIME types, ETags and
conditional requests work in local preview and on the server. Preview retains
the last valid snapshot if output is temporarily incomplete during a rebuild.
Static sites do not support runtime variables, secrets, database bindings, SSR,
or Hono code in the same application. Values in a frontend build are public.
Files or directories changed during a snapshot are rejected before publication;
finish the frontend build before retrying a failed deployment.

## Managed SQLite

Use database bindings in a Hono API, and call that API from React. The server must
have managed databases enabled. Create a database with an administrator account:

```sh
hibana db create notes
```

Add its returned ID to your API's `hibana.json`:

```json
{
  "name": "notes-api",
  "main": "src/index.ts",
  "databases": { "DB": "db_0123456789abcdef0123456789abcdef" }
}
```

```sh
hibana db grant DB
hibana db migrate DB --remote --file migrations/0001_notes.sql
hibana deploy
```

`grant` creates the application's metadata if necessary. Add `--read-only` for
read-only access; `hibana db revoke DB` revokes access for existing versions too.
`hibana db list` lists databases, and `hibana db delete ID` deletes an unreferenced
database after confirmation.

```ts
import { Hono } from 'hono'
import type { Database } from '@yukiharada1228/hibana/database'

const app = new Hono<{ Bindings: { DB: Database } }>()
app.get('/notes', async c => c.json(
  (await c.env.DB.prepare('SELECT id, title FROM notes WHERE completed = ?')
    .bind(false).all()).results
))
export default app
```

The binding supports `prepare`, `bind`, `all`, `first`, `run` and transactional
`batch`. Application authentication is separate from database grants; see the
[authenticated React + Hono + SQLite example](examples/react-sqlite/README.md).

For local development:

```sh
hibana db migrate DB --local --file migrations/0001_notes.sql
hibana db query DB --local --sql 'SELECT * FROM notes WHERE id = ?' --params '[1]'
hibana dev
```

Local SQLite uses the same engine as the server, in `.hibana/databases/`, with
independent data. Stop `hibana dev` before running local SQL. Query/migrate always
require exactly one of `--local` or `--remote`; remote SQL requires administrator
access and accepts `--profile NAME`.

The CLI automatically installs its matching Worker (0.3.0-rc.8), including local
SQLite support. Custom workers selected with `HIBANA_RUNTIME_BIN` or `--runtime`
must report `managed_sql: 1` from `--capabilities`; older workers are rejected
with an update hint.

Each migration file runs atomically; reapplying identical content is a no-op,
and changing an applied filename's SQL is rejected. Trigger bodies and quoted
semicolons are supported. A file modified while being read is rejected before
SQL execution. Do not include `BEGIN`/`COMMIT`. A migration allows
32 statements, 64 KiB per statement and 256 KiB per request. App rollback does
not restore database data or schema. SQL writes are not automatically retried.

Numeric query results use JavaScript numbers. For integers outside the safe
range (`±9007199254740991`), use `CAST(column AS TEXT)` in SQL to preserve the
exact value. Pass large integer parameters as strings.

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
| `hibana init NAME --template react` | Create a React + TypeScript + Vite SPA |
| `hibana build` | Build a WebAssembly component or static bundle |
| `hibana db` | Create databases, grant access, query and migrate |
| `hibana tail` | Stream live application logs |
| `hibana list` | List deployed apps |
| `hibana rollback` | Restore the previous version |
| `hibana secret` | Manage application secrets |
| `hibana profile` | Manage saved connections |

Run `hibana --help` for all commands or `hibana <command> --help` for options.

## Platforms

Building, deploying and static preview work on Linux, macOS, and Windows.
Local Wasm and SQLite development support Linux and macOS on x64 and arm64;
use WSL2 on Windows.

## Development

```sh
npm ci
npm run check
npm test
npm run test:package
npm run test:apps
```

Set `HIBANA_RUNTIME_BIN` to a compatible runtime executable to include local HTTP
and shutdown checks in `test:package`.
For `test:apps`, that worker must support managed SQLite; it then also verifies
native SQLite CRUD, authentication, CORS and local writer locking. Without it,
the test installs the packed CLI, initializes/builds/previews React, typechecks
public DB imports and builds the Hono API. Set `HIBANA_TEST_RUNTIME` to include
native SQLite migration/rollback tests in `npm test`.

## License

[MIT](LICENSE). Bundled dependencies have their own licenses; see
[third-party notices](THIRD_PARTY_LICENSES.txt).
