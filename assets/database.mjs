// D1-style subset. Transport is intercepted by Hibana's WASI HTTP host.
const names = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const reserved = new Set(["__proto__", "prototype", "constructor"]);
const safeNumber = (value) => {
  if (
    !Number.isFinite(value) ||
    (Number.isInteger(value) && !Number.isSafeInteger(value))
  ) {
    throw new TypeError(
      "SQL numbers must be finite; integers must be safe JavaScript integers",
    );
  }
  return value;
};
function parameter(value) {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "number") return safeNumber(value);
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
  if (ArrayBuffer.isView(value))
    return Array.from(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  if (
    Array.isArray(value) &&
    value.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)
  )
    return [...value];
  throw new TypeError(
    "SQL parameters must be strings, numbers, booleans, null or byte arrays",
  );
}
class PreparedStatement {
  constructor(database, sql, params = []) {
    this.database = database;
    this.sql = sql;
    this.params = params;
  }
  bind(...values) {
    return new PreparedStatement(
      this.database,
      this.sql,
      values.map(parameter),
    );
  }
  async all() {
    return (await this.database.batch([this]))[0];
  }
  async run() {
    return this.all();
  }
  async first(column) {
    const row = (await this.all()).results[0];
    if (!row) return null;
    if (column === undefined) return row;
    if (!Object.hasOwn(row, column))
      throw new Error("SQL result column does not exist");
    return row[column];
  }
}
export class Database {
  constructor(binding) {
    if (!names.test(binding) || reserved.has(binding))
      throw new TypeError("Invalid database binding");
    this.binding = binding;
  }
  prepare(sql) {
    if (typeof sql !== "string" || !sql.trim())
      throw new TypeError("SQL must be a nonempty string");
    return new PreparedStatement(this, sql);
  }
  async batch(statements) {
    if (
      !Array.isArray(statements) ||
      statements.length < 1 ||
      statements.length > 32 ||
      statements.some(
        (s) => !(s instanceof PreparedStatement) || s.database !== this,
      )
    ) {
      throw new TypeError(
        "A batch must contain 1..32 statements prepared by this database binding",
      );
    }
    const response = await fetch(
      `http://database.hibana.internal/${this.binding}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          statements: statements.map((s) => ({ sql: s.sql, params: s.params })),
        }),
      },
    );
    const payload = await response.json();
    if (!response.ok)
      throw new Error(
        `HIBANA_SQL_ERROR: ${payload.error?.message ?? payload.error ?? "Query failed"}`,
      );
    return payload.results;
  }
}
export function installDatabases(env, bindings) {
  for (const name of bindings)
    Object.defineProperty(env, name, {
      value: new Database(name),
      enumerable: true,
    });
}
