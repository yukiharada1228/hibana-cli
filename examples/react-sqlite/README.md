# React + Hono + SQLite notes

A small authenticated notes app: React calls a Hono API, and Hono reads/writes
SQLite through `env.DB`. The frontend and API are two Hibana applications.

## Create the project

Install the published CLI, then clone this public repository for the example files:

```sh
npm install -g @yukiharada1228/hibana@0.4.0-rc.4
git clone https://github.com/yukiharada1228/hibana-cli.git
cd hibana-cli
hibana init /tmp/hibana-notes/web --template react
cp -R examples/react-sqlite/web/. /tmp/hibana-notes/web/
cp -R examples/react-sqlite/api /tmp/hibana-notes/api
cd /tmp/hibana-notes/api
npm install
cp .dev.vars.example .dev.vars
```

Choose your own development `API_TOKEN` in `.dev.vars`. The all-zero DB ID in
`hibana.json` is a local placeholder; replace it before remote operations.
This example uses one shared application token, intended for a private demo.
Multi-user applications should add user authentication and per-user data access.

## Run locally

The CLI downloads its matching Worker automatically on macOS and Linux.
On Windows, run the API inside WSL2. No backend source checkout is needed.

In the API directory:

```sh
npm exec -- hibana db migrate DB --local --file migrations/0001_notes.sql
npm run dev
```

In another terminal:

```sh
cd /tmp/hibana-notes/web
npm run dev
```

Open **http://127.0.0.1:5173**, enter the same application token, and add, complete
or delete a note. The frontend defaults to API port 8787. Keep the frontend on
port 5173, matching `FRONTEND_ORIGIN` in the API configuration. To change ports,
update that origin and set `VITE_API_URL` in the frontend's `.env.local`.

The token is entered at runtime and kept in page memory. Do not embed tokens or
Hibana management credentials in `VITE_*` variables. `.dev.vars` is ignored by
git and is used only for local API development.

Stop the API before running `hibana db query ... --local` or another migration.
Data persists in `api/.hibana/databases/` across restarts.

## Deploy

Use a server with static hosting and managed SQLite enabled, and sign in as an
administrator. In the API directory:

```sh
npm exec -- hibana login --url https://api.example.com --tenant team
npm exec -- hibana db create notes
```

Replace `databases.DB` in the API's `hibana.json` with the returned ID. Give the
API and frontend distinct names. Then:

```sh
npm exec -- hibana db grant DB
npm exec -- hibana db migrate DB --remote --file migrations/0001_notes.sql
npm exec -- hibana secret put API_TOKEN < /path/to/private-token.txt
npm exec -- hibana secret allow-deploy API_TOKEN
npm run deploy
```

Use a strong application token in the private file and enter that token in the
frontend. Remote secrets are configured separately from local `.dev.vars`.

Set `VITE_API_URL` in `web/.env.local` to the API application's public URL printed
by deploy, without a trailing slash. In `web`, run `npm run deploy`. Set the
API's `vars.FRONTEND_ORIGIN` to the resulting frontend URL's origin (scheme and
hostname, no path or trailing slash), and redeploy the API. The browser will then
be allowed to call it. Changing `VITE_API_URL` requires rebuilding/redeploying
the frontend.

Migrations are separate from deploy. App rollback changes code/configuration;
it does not undo SQLite changes. Keep schema migrations compatible with the
previous application version.

## Automated check

From the CLI repository root, with `HIBANA_RUNTIME_BIN` pointing to the updated
worker, run `npm run test:apps`. It installs a fresh packed CLI into temporary
projects, builds this frontend/API, and checks SQLite CRUD, auth, CORS and writer
locking. It does not deploy to a remote server.
