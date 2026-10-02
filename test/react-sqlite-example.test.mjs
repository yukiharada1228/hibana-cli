import test from "node:test";
import assert from "node:assert/strict";
import app from "../examples/react-sqlite/api/src/index.ts";

const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
const env = { API_TOKEN: "test-token", FRONTEND_ORIGIN: "http://127.0.0.1:5173" };

test("notes API rejects malformed JSON and invalid titles without executing SQL", async t => {
  t.mock.method(console, "error", () => {});
  let queries = 0;
  const DB = { prepare() { queries++; throw new Error("Unexpected SQL"); } };
  for (const body of ["null", "{", "[]", "true", '"text"', "{}", '{"title":42}', '{"title":"  "}', JSON.stringify({ title: "x".repeat(201) })]) {
    const response = await app.request("/notes", { method: "POST", headers, body }, { ...env, DB });
    assert.equal(response.status, 400, body);
    assert.match(response.headers.get("content-type"), /application\/json/);
    assert.equal(typeof (await response.json()).error, "string");
  }
  assert.equal(queries, 0);
});

test("notes API trims a valid title and inserts it once using a bound parameter", async () => {
  const calls = [];
  const row = { id: 1, title: "Hello 日本語", completed: 0 };
  const DB = { prepare(sql) { return { bind(...params) { calls.push({ sql, params }); return { async first() { return row; } }; } }; } };
  const response = await app.request("/notes", { method: "POST", headers, body: JSON.stringify({ title: "  Hello 日本語  " }) }, { ...env, DB });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), row);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /VALUES \(\?\)/);
  assert.deepEqual(calls[0].params, [row.title]);
});
