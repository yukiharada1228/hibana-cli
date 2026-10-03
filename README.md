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

React SPA and managed SQLite workflows are available in CLI `0.4.0-rc.5`.

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
hibana db migrations apply DB --remote
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
hibana db migrations apply DB --local
hibana db execute DB --local --command 'SELECT * FROM notes WHERE id = ?' --params '[1]'
hibana dev
```

Local SQLite uses the same engine as the server, in `.hibana/databases/`, with
independent data. Stop `hibana dev` before running local SQL. SQL execution and migration listing/application always
require exactly one of `--local` or `--remote`; remote SQL requires administrator
access and accepts `--profile NAME`.

The CLI automatically installs its matching Worker (0.3.0-rc.9), including local
SQLite support. Custom workers selected with `HIBANA_RUNTIME_BIN` or `--runtime`
must report `managed_sql: 1` from `--capabilities`; older workers are rejected
with an update hint.

Create and inspect numbered migrations with:

```sh
hibana db migrations create DB create_notes
# Edit migrations/0001_create_notes.sql with your schema.
hibana db migrations list DB --local
hibana db migrations apply DB --local
hibana db execute DB --remote --file seed.sql
hibana db info DB
```

`migrations apply` shows the pending files and asks for confirmation; use `--yes`
in CI. Files are applied in filename order, with one transaction per file. If a
later file fails, earlier successful files remain applied. `list` checks recorded
checksums and shows applied files missing from the current checkout. Empty draft
files can be listed but must contain SQL before application. The default directory
is `migrations/` beside `hibana.json`; override it with `--migrations-dir`.
Migration sets are limited to 1,024 files and 8 MiB in total.

`execute` takes either `--command SQL` or `--file FILE`. A file or multi-statement
command runs as one transaction without recording migration history. `--params`
applies to a single `--command` statement. Bindings and database IDs work locally;
remote operations also accept database names. To use custom local storage, pass
`--persist-to ./state` to both `dev` and local database commands.

The existing `db query --sql` and `db migrate --file` forms remain supported.

Each migration file runs atomically; reapplying identical content is a no-op,
and changing an applied filename's SQL is rejected. Trigger bodies and quoted
semicolons are supported. A file modified while being read is rejected before
SQL execution. Do not include `BEGIN`/`COMMIT`. A migration allows
32 statements, 64 KiB per statement and 256 KiB per request. App rollback does
not restore database data or schema. SQL writes are not automatically retried.

Numeric query results use JavaScript numbers. For integers outside the safe
range (`±9007199254740991`), use `CAST(column AS TEXT)` in SQL to preserve the
exact value. Pass large integer parameters as strings.

## Database administration

The console provides SQL execution/results, table/schema browsing and row editing,
app access grants, SQL import/export, query insights and point-in-time recovery.
The CLI uses the following corresponding commands:

```sh
hibana db create notes --binding DB --update-config
hibana db export DB --remote --output backup.sql
hibana db export DB --local --table notes --no-data --output schema.sql
hibana db execute DB --remote --file backup.sql --yes
hibana db insights DB --time-period 1d --sort-by time --sort-type sum --limit 5
hibana db time-travel info DB
hibana db time-travel info DB --timestamp 2026-10-04T00:00:00Z
hibana db time-travel restore DB --bookmark db_0123456789abcdef0123456789abcdef:0000000000000012
```

`create --update-config` adds the binding to an existing API project's `hibana.json`
and preserves other settings. Existing bindings are never overwritten. Omit
`--update-config` to receive a configuration snippet. If the file changes during
creation, the database is still created and the CLI explains how to add it manually.

SQL exports support `--table`, `--no-schema` and `--no-data`. Downloads publish a
complete file without overwriting an existing path. Dumps preserve binary values,
row IDs, generated columns, triggers and autoincrement sequences; internal migration
history is excluded. `execute --file` accepts regular UTF-8 SQL files up to 600 MiB,
3 MiB per statement and one million statements. Each file runs atomically within
40 seconds. Common `BEGIN`/`COMMIT` wrappers are handled, but PRAGMA and filesystem
operations remain restricted. Import a full dump into an empty database to avoid
conflicts with existing schema. SELECT/RETURNING results include one-based statement
numbers and are bounded to 1 MiB/10,000 rows; exceeding those limits rolls back the file.

Recovery uses verified retained backup boundaries within the past **24 hours**.
Timestamps accept RFC3339 or Unix seconds; bookmarks pin a database and backup
position. Confirmed restoration creates and verifies a new physical generation,
then activates it under the same logical database ID. Queries pause during recovery;
the original generation is retained. `time-travel info` includes recovery history,
and `restore --no-wait` returns after acceptance. The normal command polls completion;
interruption does not cancel a durable recovery job. Do not automatically retry writes.
Recovery does not roll back application code. Retention/replication limits apply:
this is not Cloudflare's 30-day service or read-replica implementation.

Insights retain seven days of hourly aggregates with literals and parameters
redacted. Supported periods are `1h`, `6h`, `1d` and `7d`; sorting supports `time`,
`count`, `errors`, `rows_returned` and `rows_written`, with `sum`/`avg`/`max` for time.
These row counts describe returned/changed rows, not scanned rows. Failed atomic
batches count once; SQL file imports count as one sample including upload time.
The server caps query shapes at 64 per hour per database plus an overflow group.

The server currently permits 32 recovery history entries per logical database and
64 retained physical files across the service. Older generations require operator
archival when capacity is reached. SQL transfers and recovery require a server and
local runtime version that supports the administrative database protocol.

## Command conventions

SPA and API projects share `hibana init`, `hibana dev` and `hibana deploy`.
Database operations use `hibana db`; Cloudflare product names are not aliases.
The command structure follows familiar [Wrangler conventions](https://developers.cloudflare.com/workers/wrangler/commands/)
for supported operations, while configuration and platform capabilities belong to Hibana.

```sh
hibana init my-api --yes
hibana dev --local
hibana deploy --dry-run --outdir ./package
hibana --cwd ./my-api db migrations list DB --local
hibana whoami
```

`deploy --dry-run` builds and validates without contacting the server or requiring
credentials. `--outdir` saves that artifact and requires `--dry-run`. `--cwd` changes
the base directory for relative paths. `init --yes` accepts the noninteractive
scaffold defaults. `dev --local` makes the existing local mode explicit.
Cloudflare-specific services and unsupported options are rejected.

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
| `hibana db` | Manage databases, SQL, migrations, import/export, recovery and insights |
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
