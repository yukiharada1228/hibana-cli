import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { parseCommand } from '../dist/commands.js';
import { databaseCommand } from '../dist/databases.js';
import { run } from '../dist/process.js';

const id = 'db_0123456789abcdef0123456789abcdef';
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hibana-conventions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'hibana.json');
  await writeFile(config, JSON.stringify({ name: 'notes', main: 'app.ts', databases: { DB: id } }));
  return { root, config };
}
test('nested database help and conventional options preserve Hibana names and legacy commands', () => {
  const args = ['db', 'migrations', 'apply', 'DB', '--local', '-y', '--cwd', '/tmp/project'];
  const parsed = parseCommand(args);
  assert.deepEqual(parsed.args, ['migrations', 'apply', 'DB']);
  assert.equal(parsed.values.yes, true);
  for (const action of ['create', 'list', 'apply']) {
    const path = ['db', 'migrations', action];
    const help = parseCommand([...path, '--help']).helpText;
    assert.match(help, new RegExp(`Usage: hibana db migrations ${action}`));
    assert.equal(help, parseCommand(['help', ...path]).helpText);
  }
  assert.match(parseCommand(['db', 'migrations']).helpText, /create/);
  assert.equal(parseCommand(['dev', '--local']).values.local, true);
  assert.equal(parseCommand(['init', 'app', '-y']).values.yes, true);
  assert.equal(parseCommand(['db', 'query', 'DB', '--local', '--sql', 'SELECT 1']).command, 'db');
  assert.equal(parseCommand(['db', 'migrate', 'DB', '--local', '--file', 'schema.sql']).command, 'db');
  for (const command of ['d1', 'pages', 'workers']) assert.throws(() => parseCommand([command]), /Unknown command/);
  assert.throws(() => parseCommand(['db', 'migrations', 'apply', 'DB', 'extra', '--local']), /Usage/);
});
test('SPA deploy --dry-run uses --cwd, produces an artifact and never authenticates or uploads', async t => {
  const f = await fixture(t); await mkdir(join(f.root, 'dist'));
  await writeFile(join(f.root, 'dist/index.html'), '<h1>preview</h1>');
  await writeFile(f.config, JSON.stringify({ name: 'notes', assets: { directory: 'dist' } }));
  const requests = []; const server = createServer((req, res) => { requests.push(req.url); res.writeHead(500).end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const result = await run(process.execPath, [cli, '--cwd', f.root, 'deploy', '--dry-run', '--outdir', 'package'], {
    capture: true, env: { ...process.env, HIBANA_URL: `http://127.0.0.1:${server.address().port}`, HIBANA_TOKEN: 'unused', HIBANA_CONFIG_HOME: join(f.root, 'profiles') }
  });
  assert.match(result.stdout, /Dry run complete/);
  assert.ok((await readFile(join(f.root, 'package/notes.tar'))).length);
  assert.deepEqual(requests, []);
});
test('execute rejects ambiguous input and invalid local targets before accessing runtime', async t => {
  const f = await fixture(t), options = { config: f.config, local: true, runtime: '/missing' };
  await assert.rejects(databaseCommand(['execute', 'DB'], { ...options, command: 'SELECT 1', file: 'schema.sql' }), /exactly one/);
  await assert.rejects(databaseCommand(['execute', 'DB'], { ...options, command: 'SELECT 1; SELECT 2', params: '[1]' }), /exactly one SQL/);
  await assert.rejects(databaseCommand(['execute', 'constructor'], { ...options, command: 'SELECT 1' }), /Binding is missing/);
  await assert.rejects(access(join(f.root, '.hibana')));
});
test('migration creation numbers files and never overwrites an existing migration', async t => {
  const f = await fixture(t), options = { config: f.config };
  const first = await databaseCommand(['migrations', 'create', 'DB', 'create_notes'], options);
  assert.equal(first.file, join(f.root, 'migrations/0001_create_notes.sql'));
  await writeFile(first.file, 'CREATE TABLE notes(id);');
  const second = await databaseCommand(['migrations', 'create', 'DB', 'add_title'], options);
  assert.equal(second.file, join(f.root, 'migrations/0002_add_title.sql'));
  assert.equal(await readFile(first.file, 'utf8'), 'CREATE TABLE notes(id);');
  await assert.rejects(databaseCommand(['migrations', 'create', 'DB', '../escape'], options), /Migration name/);
});
test('native migration lifecycle tracks partial success, checksums, draft files and separate persistence', { skip: !process.env.HIBANA_TEST_RUNTIME, timeout: 30000 }, async t => {
  const f = await fixture(t), options = { config: f.config, local: true, runtime: process.env.HIBANA_TEST_RUNTIME, 'persist-to': join(f.root, 'state'), yes: true };
  const one = await databaseCommand(['migrations', 'create', 'DB', 'create_notes'], { config: f.config });
  let listed = await databaseCommand(['migrations', 'list', 'DB'], options);
  assert.equal(listed.migrations[0].status, 'pending');
  await assert.rejects(databaseCommand(['migrations', 'apply', 'DB'], options), /1..32 statements/);
  await writeFile(one.file, 'CREATE TABLE notes(id INTEGER PRIMARY KEY); INSERT INTO notes VALUES(1);');
  const two = await databaseCommand(['migrations', 'create', 'DB', 'insert_more'], { config: f.config });
  await writeFile(two.file, 'INSERT INTO notes VALUES(2); INSERT INTO missing VALUES(3);');
  await assert.rejects(databaseCommand(['migrations', 'apply', 'DB'], options), /0002_insert_more.sql failed after 1 applied/);
  listed = await databaseCommand(['migrations', 'list', 'DB'], options);
  assert.deepEqual(listed.migrations.map(row => row.status), ['applied', 'pending']);
  const rows = await databaseCommand(['execute', 'DB'], { ...options, command: 'SELECT count(*) AS n FROM notes' });
  assert.equal(rows.results[0].results[0].n, 1);
  await writeFile(two.file, 'INSERT INTO notes VALUES(2);');
  assert.deepEqual((await databaseCommand(['migrations', 'apply', 'DB'], options)).applied, ['0002_insert_more.sql']);
  assert.deepEqual((await databaseCommand(['migrations', 'apply', 'DB'], options)).applied, []);
  await writeFile(one.file, 'CREATE TABLE modified(id);');
  await assert.rejects(databaseCommand(['migrations', 'list', 'DB'], options), /different checksum/);
  await assert.rejects(access(join(f.root, '.hibana/databases')));
});
