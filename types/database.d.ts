/** Hibana's supported D1-style subset. Each batch is one atomic transaction. */
export interface DatabaseResult<T = Record<string, unknown>> {
  success: true;
  results: T[];
  meta: { changes: number; last_row_id: number; duration: number };
}
export type DatabaseValue =
  | string
  | number
  | boolean
  | null
  | ArrayBuffer
  | ArrayBufferView
  | number[];
export interface DatabaseStatement {
  bind(...values: DatabaseValue[]): DatabaseStatement;
  all<T = Record<string, unknown>>(): Promise<DatabaseResult<T>>;
  run<T = Record<string, unknown>>(): Promise<DatabaseResult<T>>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  raw<T = unknown[]>(options: {
    columnNames: true;
  }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options: {
    columnNames: boolean;
  }): Promise<(T | string[])[]>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  first<T = unknown>(column: string): Promise<T | null>;
}
export interface Database {
  prepare(sql: string): DatabaseStatement;
  /** One SQL statement per line; the entire call is atomic (up to 32 statements). */
  exec(sql: string): Promise<{ count: number; duration: number }>;
  batch<T = Record<string, unknown>>(
    statements: DatabaseStatement[],
  ): Promise<DatabaseResult<T>[]>;
}
