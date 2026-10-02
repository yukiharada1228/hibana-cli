import test from "node:test";
import assert from "node:assert/strict";
import { Database, installDatabases } from "../assets/database.mjs";

test("immutable parameters, result helpers, atomic batch transport and no credentials", async () => {
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, ...options });
    const statements = JSON.parse(options.body).statements;
    return Response.json({
      results: statements.map(() => ({
        success: true,
        results: [{ id: 1, name: "日本語" }],
        meta: { changes: 1 },
      })),
    });
  };
  const db = new Database("DB");
  const prepared = db.prepare("SELECT ? AS id");
  const bound = prepared.bind(1);
  assert.deepEqual(prepared.params, []);
  assert.equal(await bound.first("id"), 1);
  assert.equal((await bound.first()).name, "日本語");
  await assert.rejects(bound.first("missing"));
  const result = await db.batch([
    bound,
    prepared.bind(new Uint8Array([1, 255])),
  ]);
  assert.equal(result.length, 2);
  const req = requests.at(-1);
  assert.equal(req.url, "http://database.hibana.internal/DB");
  assert.equal(req.method, "POST");
  assert.deepEqual(req.headers, { "content-type": "application/json" });
  assert.deepEqual(JSON.parse(req.body).statements[1].params, [[1, 255]]);
});
test("invalid types, binding names and cross-database batches are rejected", async () => {
  const db = new Database("DB");
  for (const value of [
    undefined,
    {},
    NaN,
    Infinity,
    9007199254740992,
    [256],
    [-1],
  ])
    assert.throws(() => db.prepare("SELECT ?").bind(value));
  for (const name of ["__proto__", "constructor", "../DB", "DB?x", "DB/other"])
    assert.throws(() => new Database(name));
  await assert.rejects(db.batch([]));
  await assert.rejects(db.batch([new Database("OTHER").prepare("SELECT 1")]));
  const env = { NAME: "app" };
  installDatabases(env, ["DB"]);
  assert.ok(env.DB instanceof Database);
  assert.equal(env.NAME, "app");
  globalThis.fetch = async () =>
    Response.json({ error: "access denied" }, { status: 403 });
  await assert.rejects(db.prepare("SELECT 1").all(), /access denied/);
});
