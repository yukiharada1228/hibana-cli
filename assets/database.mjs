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
  async raw(options = {}) {
    const result = (await execute(this.database, [this], "rows"))[0];
    if (!Array.isArray(result.rows) || !Array.isArray(result.columns))
      throw new Error(
        "HIBANA_SQL_ERROR: raw() requires an updated Hibana runtime",
      );
    return options.columnNames ? [result.columns, ...result.rows] : result.rows;
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
    return (await execute(this, statements, "objects")).map(
      ({ success, results, meta }) => ({ success, results, meta }),
    );
  }
  async exec(sql) {
    if (typeof sql !== "string" || !sql.trim())
      throw new TypeError("SQL must be a nonempty string");
    // Match the documented D1 exec convention: one statement per line.
    const statements = sql
      .trim()
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => this.prepare(line));
    const results = await execute(this, statements, "none");
    return {
      count: results.length,
      duration: results.reduce(
        (total, result) => total + result.meta.duration,
        0,
      ),
    };
  }
}
async function execute(database, statements, format) {
  if (
    !Array.isArray(statements) ||
    statements.length < 1 ||
    statements.length > 32 ||
    statements.some(
      (s) => !(s instanceof PreparedStatement) || s.database !== database,
    )
  ) {
    throw new TypeError(
      "A batch must contain 1..32 statements prepared by this database binding",
    );
  }
  const response = await fetch(
    `http://database.hibana.internal/${database.binding}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(format === "objects" ? {} : { result_format: format }),
        statements: statements.map((s) => ({ sql: s.sql, params: s.params })),
      }),
    },
  );
  const payload = await response.json();
  if (!response.ok)
    throw new Error(
      `HIBANA_SQL_ERROR: ${payload.error?.message ?? payload.error ?? "Query failed"}`,
    );
  if (
    !Array.isArray(payload.results) ||
    payload.results.length !== statements.length ||
    payload.results.some((result) => !result.success)
  )
    throw new Error("HIBANA_SQL_ERROR: Invalid query response");
  return payload.results;
}

export function installDatabases(env, bindings) {
  for (const name of bindings)
    Object.defineProperty(env, name, {
      value: new Database(name),
      enumerable: true,
    });
}
