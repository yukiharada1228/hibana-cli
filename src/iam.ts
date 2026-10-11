import { open } from "node:fs/promises";
import { apiClient } from "./api.js";
import { confirm } from "./confirm.js";
import { saveProfile } from "./profiles.js";
import { text } from "./output.js";
import type { CliOptions } from "./types.js";

function option(options: CliOptions, name: string): string {
  const value = options[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Specify --${name}`);
  return value;
}
function id(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("Expected a resource ID");
  return encodeURIComponent(value);
}
async function file(path: string, limit: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Expected a regular file");
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > limit) throw new Error(`File exceeds ${limit} bytes`);
    return buffer.subarray(0, size).toString("utf8");
  } finally { await handle.close(); }
}
async function responseJson(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty response");
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > limit) throw new Error("Response exceeds the size limit");
      parts.push(part.value);
    }
    try { return JSON.parse(Buffer.concat(parts).toString("utf8")); }
    catch { throw new Error("Invalid JSON response"); }
  } finally { await reader.cancel().catch(() => {}); }
}

export async function githubAssertion(audience: string, signal?: AbortSignal, env = process.env, fetcher = fetch): Promise<string> {
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
    throw new Error("Run in GitHub Actions with permissions: id-token: write, or use --oidc-token-file");
  let url: URL;
  try { url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL); }
  catch { throw new Error("Invalid GitHub OIDC request URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port ||
      !(url.hostname === "token.actions.githubusercontent.com" || url.hostname.endsWith(".actions.githubusercontent.com")))
    throw new Error("GitHub OIDC request URL must use the GitHub Actions HTTPS origin");
  url.searchParams.set("audience", audience);
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    });
  } catch { throw new Error("GitHub OIDC request failed"); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`GitHub OIDC request failed (HTTP ${response.status})`);
  }
  const result = await responseJson(response, 32768);
  if (typeof result?.value !== "string" || !result.value || result.value.length > 16384)
    throw new Error("GitHub returned an invalid OIDC assertion");
  return result.value;
}

async function login(options: CliOptions, signal?: AbortSignal) {
  if (process.env.HIBANA_TOKEN?.trim()) throw new Error("Unset HIBANA_TOKEN before workload login so subsequent commands use the new session");
  const account = id(option(options, "account"));
  const workload = id(option(options, "workload"));
  const audience = option(options, "audience");
  const duration = options.duration === undefined ? 900 : Number(options.duration);
  if (!Number.isInteger(duration) || duration < 60 || duration > 3600)
    throw new Error("--duration must be 60..3600 seconds (default: 900)");
  // Resolve the target before obtaining the provider assertion. It is never
  // printed, stored as a profile credential, or included in an error message.
  const api = await apiClient({ ...options, login: true });
  const assertion = options["oidc-token-file"]
    ? (await file(option(options, "oidc-token-file"), 16384)).trim()
    : await githubAssertion(audience, signal);
  const result = await api.request("/auth/workload/exchange", {
    method: "POST", auth: false, signal,
    body: { tenant_id: account, workload_id: workload, id_token: assertion, duration_seconds: duration },
  });
  if (typeof result?.token !== "string" || !result.token || typeof result.expires_at !== "string")
    throw new Error("Workload login returned an invalid session");
  await saveProfile(api.profile, { url: api.url, token: result.token });
  console.log(`Connected as ${text(workload)}\nSaved connection: ${text(api.profile)}\nExpires: ${text(result.expires_at)}`);
}

async function list(api: Awaited<ReturnType<typeof apiClient>>, path: string, signal?: AbortSignal) {
  const result: unknown[] = [];
  let offset = 0;
  let bytes = 0;
  for (let page = 0; page < 50; page++) {
    const response: Response = await api.request(`${path}?offset=${offset}&limit=200`, { signal, stream: true });
    const rows = await responseJson(response, 16 * 1024 * 1024);
    if (!Array.isArray(rows) || rows.length > 200) throw new Error("Invalid IAM list response");
    bytes += Buffer.byteLength(JSON.stringify(rows));
    if (bytes > 16 * 1024 * 1024) throw new Error("IAM listing exceeds 16 MiB");
    result.push(...rows);
    const next = response.headers.get("x-hibana-next-offset");
    if (next === null) return result;
    if (!/^\d+$/.test(next) || !Number.isSafeInteger(Number(next)) || Number(next) <= offset)
      throw new Error("Invalid IAM continuation");
    offset = Number(next);
  }
  throw new Error("IAM listing exceeds 10,000 entries");
}

export async function iamCommand(args: string[], options: CliOptions = {}, signal?: AbortSignal) {
  const [group, operation, target] = args;
  if (group === "login") return login(options, signal);
  const api = await apiClient(options);
  if (group === "session") return api.request("/auth/session", { signal });
  if (group === "audit" && operation === "list") return list(api, "/iam/audit", signal);
  if (group === "assume-role") {
    if (process.env.HIBANA_TOKEN?.trim()) throw new Error("Unset HIBANA_TOKEN before switching roles so subsequent commands use the new session");
    const roleId = id(option(options, "role"));
    await api.loginOidc({ roleId, switchRole: true, noBrowser: Boolean(options["no-browser"]), signal });
    return api.request("/auth/session", { signal });
  }
  if (group === "member") {
    if (operation === "list") return list(api, "/users", signal);
    if (operation === "invite") {
      const role = id(option(options, "role"));
      return api.request("/invitations", { method: "POST", body: { email: target, role: "custom", role_id: role }, signal });
    }
    if (operation !== "set-roles") throw new Error("Unknown IAM member operation");
    if (Boolean(options.clear) === Boolean(options.roles)) throw new Error("Specify --roles ID[,ID...] or --clear");
    const roles = options.clear ? [] : option(options, "roles").split(",").map(value => id(value));
    if (roles.length > 4 || new Set(roles).size !== roles.length) throw new Error("Specify at most four distinct role IDs");
    const user = id(target);
    if (!await confirm(`Replace roles for member ${text(user)}?`, Boolean(options.yes), signal)) return;
    await api.request(`/users/${user}/roles`, { method: "PUT", body: { role_ids: roles }, signal });
    return { updated: user, role_ids: roles };
  }
  const collection = { policy: "policies", role: "roles", workload: "workloads" }[group];
  if (!collection) throw new Error("Unknown IAM command");
  const path = `/iam/${collection}`;
  if (operation === "list") return list(api, path, signal);
  if (operation === "delete" || operation === "disable") {
    const targetId = id(target);
    if (!await confirm(`${operation === "disable" ? "Disable" : "Delete"} ${group} ${text(targetId)}?`, Boolean(options.yes), signal)) return;
    await api.request(`${path}/${targetId}`, { method: "DELETE", signal });
    return { [operation === "disable" ? "disabled" : "deleted"]: targetId };
  }
  if (operation !== "create" && operation !== "update") throw new Error("Unknown IAM operation");
  const rawJson = await file(option(options, "file"), 128 * 1024);
  try {
    const input = JSON.parse(rawJson);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error();
  } catch { throw new Error("IAM file must contain a JSON object"); }
  const targetPath = operation === "create" ? path : `${path}/${id(target)}`;
  if (operation === "update" && !await confirm(`Update ${group} ${text(target)}?`, Boolean(options.yes), signal)) return;
  // Preserve the original JSON, including duplicate fields, so the server can
  // reject ambiguous policies instead of silently normalizing them locally.
  const result = await api.request(targetPath, { method: operation === "create" ? "POST" : "PUT", rawJson, signal });
  return result ?? { updated: target };
}
