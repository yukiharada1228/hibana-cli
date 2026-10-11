import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { iamCommand, githubAssertion } from "../dist/iam.js";
import { parseCommand } from "../dist/commands.js";

test("GitHub assertions go only to an approved HTTPS origin and never enter diagnostics", async () => {
  const env = { ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.actions.githubusercontent.com/job/idtoken?api-version=2.0", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "private-request-token" };
  const token = await githubAssertion("hibana:account", undefined, env, async (url, options) => {
    assert.equal(url.searchParams.get("audience"), "hibana:account");
    assert.equal(url.searchParams.get("api-version"), "2.0");
    assert.equal(options.headers.Authorization, "Bearer private-request-token");
    assert.equal(options.redirect, "error");
    return Response.json({ value: "private-assertion" });
  });
  assert.equal(token, "private-assertion");
  for (const url of ["http://pipelines.actions.githubusercontent.com/token", "https://actions.githubusercontent.com.attacker.invalid/token", "https://user:password@pipelines.actions.githubusercontent.com/token", "https://127.0.0.1/token"]) {
    await assert.rejects(githubAssertion("aud", undefined, { ...env, ACTIONS_ID_TOKEN_REQUEST_URL: url }, async () => assert.fail("unsafe request")), /HTTPS origin/);
  }
  await assert.rejects(githubAssertion("aud", undefined, env, async () => { throw new Error("private-request-token"); }), error => !error.message.includes("private-request-token"));
  await assert.rejects(githubAssertion("aud", undefined, env, async () => new Response("private-assertion", { status: 403 })), /HTTP 403/);
});

test("IAM CLI preserves policy JSON, paginates members, and saves only the exchanged session", async t => {
  const home = await mkdtemp(join(tmpdir(), "hibana-iam-"));
  const previous = Object.fromEntries(["HIBANA_CONFIG_HOME", "HIBANA_PROFILE", "HIBANA_TOKEN"].map(key => [key, process.env[key]]));
  Object.assign(process.env, { HIBANA_CONFIG_HOME: home, HIBANA_PROFILE: "", HIBANA_TOKEN: "" });
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    calls.push({ path: req.url, method: req.method, auth: req.headers.authorization, raw });
    res.setHeader("content-type", "application/json");
    if (req.url === "/iam/policies") { res.statusCode = 400; res.end('{}'); }
    else if (req.url.startsWith("/users?")) {
      const offset = new URL(req.url, "http://localhost").searchParams.get("offset");
      if (offset === "0") { res.setHeader("x-hibana-next-offset", "200"); res.end(JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ user_id: `user_${i}` })))); }
      else res.end(JSON.stringify([{ user_id: "user_200" }]));
    } else if (req.url === "/auth/workload/exchange") {
      res.statusCode = 201;
      res.end(JSON.stringify({ token: "new-private-session", expires_at: "2026-10-11T01:15:00Z" }));
    } else { res.statusCode = 204; res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(home, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const options = { url, token: "administrator-fixture" };
  const policyFile = join(home, "policy.json");
  const raw = '{"name":"ambiguous","document":{"Version":"2026-10-11","Statement":[{"Effect":"Deny","Effect":"Allow","Action":["*"],"Resource":["*"]}]}}';
  await writeFile(policyFile, raw);
  await assert.rejects(iamCommand(["policy", "create"], { ...options, file: policyFile }), /HTTP 400/);
  assert.equal(calls[0].raw, raw, "server must receive duplicate fields to reject ambiguity");
  assert.equal(calls[0].auth, "Bearer administrator-fixture");
  assert.equal((await iamCommand(["member", "list"], options)).length, 201);
  await iamCommand(["member", "set-roles", "user_1"], { ...options, roles: "rol_a,rol_b", yes: true });
  assert.deepEqual(JSON.parse(calls.at(-1).raw), { role_ids: ["rol_a", "rol_b"] });
  const assertionFile = join(home, "assertion.txt");
  await writeFile(assertionFile, "private-assertion");
  let output = ""; const original = console.log;
  console.log = (...args) => { output += args.join(" "); };
  try {
    await iamCommand(["login"], { url, profile: "ci", account: "ten_a", workload: "wrk_ci", audience: "hibana:ten_a", "oidc-token-file": assertionFile });
  } finally { console.log = original; }
  assert.equal(calls.at(-1).auth, undefined, "existing credentials must not accompany federation");
  assert.deepEqual(JSON.parse(calls.at(-1).raw), { tenant_id: "ten_a", workload_id: "wrk_ci", id_token: "private-assertion", duration_seconds: 900 });
  const profile = JSON.parse(await readFile(join(home, "profiles.json"), "utf8"));
  assert.equal(profile.profiles.ci.token, "new-private-session");
  assert.ok(!JSON.stringify(profile).includes("private-assertion"));
  assert.ok(!output.includes("private-assertion") && !output.includes("new-private-session"));
  if (process.platform !== "win32") assert.equal((await stat(join(home, "profiles.json"))).mode & 0o777, 0o600);
  for (const command of [
    ["iam", "policy", "create", "--file", "policy.json"],
    ["iam", "member", "set-roles", "user_1", "--roles", "rol_a", "--yes"],
    ["iam", "workload", "disable", "wrk_ci", "--yes"],
    ["iam", "login", "--account", "ten_a", "--workload", "wrk_ci", "--audience", "hibana:ten_a"],
  ]) assert.equal(parseCommand(command).command, "iam");
  assert.throws(() => parseCommand(["iam", "login", "--id-token", "secret"]), /Unknown option/);
});
