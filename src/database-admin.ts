import { setTimeout as sleep } from "node:timers/promises";
import { apiClient } from "./api.js";
import { confirm } from "./confirm.js";
import { text } from "./output.js";
import { databaseContext } from "./databases.js";

export function insightParameters(options) {
  const period = options["time-period"] || "1d";
  if (!["1h", "6h", "24h", "1d", "7d"].includes(period)) throw new Error("--time-period must be 1h, 6h, 1d, 24h or 7d");
  const sort = options["sort-by"] || "time", type = options["sort-type"] || "sum";
  const fields = { time: { sum: "total_duration", avg: "average_duration", max: "max_duration" }, count: { sum: "executions" }, errors: { sum: "errors" }, rows_returned: { sum: "rows_returned" }, rows_written: { sum: "rows_changed" } };
  if (!Object.hasOwn(fields, sort) || !Object.hasOwn(fields[sort], type)) throw new Error("--sort-by accepts time, count, errors, rows_returned, rows_written. --sort-type accepts sum, or avg/max for time");
  const direction = String(options["sort-direction"] || "DESC").toLowerCase();
  if (!["asc", "desc"].includes(direction)) throw new Error("--sort-direction must be ASC or DESC");
  const limit = String(options.limit || "5");
  if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100) throw new Error("--limit must be 1..100");
  return new URLSearchParams({ time_period: period === "1d" ? "24h" : period, sort_by: fields[sort][type], sort_direction: direction, limit });
}
export function recoveryParameters(options, restoring = false) {
  if (options.timestamp && options.bookmark) throw new Error("Choose --timestamp or --bookmark, not both");
  if (restoring && !options.timestamp && !options.bookmark) throw new Error("Restoration requires --timestamp or --bookmark");
  const params = new URLSearchParams();
  if (options.bookmark) {
    if (!/^db_[a-f0-9]{32}:[a-f0-9]{16}$/.test(options.bookmark)) throw new Error("Invalid Hibana recovery bookmark");
    params.set("bookmark", options.bookmark);
  }
  if (options.timestamp) {
    const value = String(options.timestamp);
    const unix = /^\d+(\.\d+)?$/.test(value);
    if (!unix && !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) throw new Error("--timestamp must be Unix seconds or RFC3339 with a timezone");
    const date = new Date(unix ? Number(value) * 1000 : value);
    if (!Number.isFinite(date.valueOf()) || date.valueOf() > Date.now() || date.valueOf() < Date.now()-24*3600*1000) throw new Error("--timestamp must be within the past 24 hours");
    params.set("timestamp", date.toISOString());
  }
  return params;
}
export async function insights(target, options, signal?: AbortSignal) {
  const params = insightParameters(options);
  const context = await databaseContext(target, { ...options, remote: true }, signal);
  return (await apiClient(options)).request(`/databases/${context.id}/insights?${params}`, { signal });
}
export async function timeTravel(args, options, signal?: AbortSignal) {
  const [action, target] = args;
  if (!["info", "restore"].includes(action)) throw new Error("Unknown time-travel command");
  const params = recoveryParameters(options, action === "restore");
  const context = await databaseContext(target, { ...options, remote: true }, signal);
  const api = await apiClient(options), base = `/databases/${context.id}`;
  if (action === "info") {
    const history = await api.request(`${base}/recoveries`, { signal });
    try { return { ...history, point: await api.request(`${base}/time-travel?${params}`, { signal }) }; }
    catch (error) {
      if (!options.timestamp && !options.bookmark && [409, 503].includes(error.status)) return { ...history, point: null, message: "Recovery point unavailable while backups are pending or a restore is running. Retry later." };
      throw error;
    }
  }
  const point = await api.request(`${base}/time-travel?${params}`, { signal });
  if (!/^db_[a-f0-9]{32}:[a-f0-9]{16}$/.test(point?.bookmark)) throw new Error("Invalid recovery point response");
  const list = await api.request("/databases", { signal });
  const database = list.databases?.find(db => db.id === context.id && db.status !== "deleted");
  if (!database || typeof database.name !== "string") throw new Error("Database not found");
  console.error(`Recovery target: ${text(api.url)} · ${text(database.name)} (${context.id})\nVerified backup: ${text(point.timestamp)}`);
  if (!await confirm("Restore this database? Writes after this point will be lost. SQL is unavailable during recovery.", Boolean(options.yes), signal)) return;
  const job = await api.request(`${base}/time-travel`, { method: "POST", body: { bookmark: point.bookmark, confirmation: database.name }, signal });
  if (!/^db_[a-f0-9]{32}$/.test(job?.id)) throw new Error("Invalid recovery job response; inspect database recovery history before retrying");
  console.error(`Recovery started: ${job.id}. It continues if this command is interrupted. Check with hibana db time-travel info ${context.id}.`);
  if (options["no-wait"]) return job;
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(2000, undefined, { signal });
    const history = await api.request(`${base}/recoveries`, { signal });
    const current = history.recoveries?.find(item => item.id === job.id);
    if (current?.status === "completed") return current;
    if (current?.status === "failed") throw new Error("Recovery failed. The original database was retained. Inspect backup availability before starting another restore.");
  }
  throw new Error(`Recovery is still pending. Check hibana db time-travel info ${context.id}; do not start a second restore.`);
}
