import test from "node:test";
import assert from "node:assert/strict";
import { Database, installDatabases } from "../assets/database.mjs";

test("sessions serialize concurrent batches, carry bookmarks and capture queued parameters", async () => {
  const db = new Database("DB");
  const session = db.withSession("first-primary");
  const seen = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async (_, options) => {
    const body = JSON.parse(options.body);
    seen.push(body);
    if (seen.length === 1) await gate;
    return Response.json({ bookmark: `hbs1.c${seen.length}.c2ln`, results: body.statements.map(() => ({
      success: true, results: [{ n: seen.length }], meta: {}, columns: ["n"], rows: [[seen.length]],
    })) });
  };
  assert.equal(session.getBookmark(), null);
  const first = session.prepare("SELECT 1 AS n").first("n");
  const statement = session.prepare("SELECT ? AS n").bind(2);
  const batch = [statement];
  const second = session.batch(batch);
  statement.params[0] = 99;
  batch.push(session.prepare("SELECT 3"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].session, "first-primary");
  release();
  assert.equal(await first, 1);
  assert.equal((await second)[0].results[0].n, 2);
  assert.equal(seen[1].session, "hbs1.c1.c2ln");
  assert.deepEqual(seen[1].statements[0].params, [2]);
  assert.equal(seen[1].statements.length, 1);
  assert.equal(session.getBookmark(), "hbs1.c2.c2ln");
  const next = db.withSession(session.getBookmark());
  assert.equal(next.getBookmark(), null);
  await next.prepare("SELECT 3").raw();
  assert.equal(seen[2].session, "hbs1.c2.c2ln");
  const unconstrained = db.withSession();
  await unconstrained.prepare("SELECT 4").run();
  assert.equal(seen[3].session, "first-unconstrained");
  await assert.rejects(session.batch([next.prepare("SELECT 1")]));
  assert.equal(session.exec, undefined);
});

test("failed session transport never retries or allows queued work with an old bookmark", async () => {
  const session = new Database("DB").withSession();
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("response lost after commit"); };
  const settled = await Promise.allSettled([
    session.prepare("UPDATE t SET n=n+1").run(), session.prepare("SELECT n FROM t").all(),
  ]);
  assert.ok(settled.every((r) => r.status === "rejected"));
  assert.equal(calls, 1);
  assert.equal(session.getBookmark(), null);
  await assert.rejects(session.prepare("SELECT 1").all(), /first-primary/);
  assert.equal(calls, 1);
  const invalid = new Database("DB").withSession();
  globalThis.fetch = async () => Response.json({results:[{success:true,results:[],meta:{}}]});
  await assert.rejects(invalid.prepare("SELECT 1").all(), /bookmark/);
  for (const value of [null, "", "a\nb", "x".repeat(2049), 3])
    assert.throws(() => new Database("DB").withSession(value));
});

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
