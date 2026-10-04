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

test("raw preserves projection order, duplicate names and empty headers; exec discards rows", async () => {
  const db = new Database("DB");
  const requests = [];
  globalThis.fetch = async (_, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    return Response.json({
      results: request.statements.map((s) => ({
        success: true,
        results: [],
        columns: s.sql.includes("empty") ? ["empty"] : ["z", "a", "a", "blob"],
        ...(request.result_format === "rows"
          ? { rows: s.sql.includes("empty") ? [] : [[2, 1, 3, [0, 255]]] }
          : {}),
        meta: { duration: 1.5 },
      })),
    });
  };
  assert.deepEqual(
    await db
      .prepare("SELECT ?, 1, 3, X'00ff'")
      .bind(2)
      .raw({ columnNames: true }),
    [
      ["z", "a", "a", "blob"],
      [2, 1, 3, [0, 255]],
    ],
  );
  assert.deepEqual(requests[0].statements[0].params, [2]);
  assert.deepEqual(
    await db.prepare("SELECT empty WHERE 0").raw({ columnNames: true }),
    [["empty"]],
  );
  assert.deepEqual(await db.prepare("SELECT empty WHERE 0").raw(), []);
  assert.deepEqual(
    await db.exec("CREATE TABLE t(id);\r\nINSERT INTO t VALUES(1);"),
    { count: 2, duration: 3 },
  );
  assert.equal(requests.at(-1).result_format, "none");
  assert.equal(requests.at(-1).statements.length, 2);
  await assert.rejects(db.exec("SELECT 1\n".repeat(33)), /1..32/);
  globalThis.fetch = async () =>
    Response.json({ results: [{ success: true, results: [], meta: {} }] });
  await assert.rejects(db.prepare("SELECT 1").raw(), /updated Hibana runtime/);
  globalThis.fetch = async () => Response.json({ results: [] });
  await assert.rejects(db.exec("SELECT 1"), /Invalid query response/);
});
