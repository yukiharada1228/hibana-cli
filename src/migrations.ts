// SQLite's public-domain complete.c statement-boundary state machine, with a
// tokenizer that preserves SQL text. SQL syntax/authorization remain server-side.
// https://github.com/sqlite/sqlite/blob/master/src/complete.c
const transitions = [
  [1, 0, 2, 3, 4, 2, 2, 2], [1, 1, 2, 3, 4, 2, 2, 2],
  [1, 2, 2, 2, 2, 2, 2, 2], [1, 3, 3, 2, 4, 2, 2, 2],
  [1, 4, 2, 2, 2, 4, 5, 2], [6, 5, 5, 5, 5, 5, 5, 5],
  [6, 6, 5, 5, 5, 5, 5, 7], [1, 7, 5, 5, 5, 5, 5, 5],
];
const keywords: Record<string, number> = { explain: 3, create: 4, temp: 5, temporary: 5, trigger: 6, end: 7 };
// Match Rust str::trim: JS trim() also removes BOMs, which changes the stored
// checksum of migrations previously applied by Hibana's native CLI.
const whitespace = /\p{White_Space}/u;
function trimSql(sql: string) {
  const start = sql.search(/\P{White_Space}/u);
  if (start < 0) return "";
  let end = sql.length;
  // An unanchored whitespace+end regex backtracks quadratically on long SQL
  // string literals. Scan only the edges, preserving native migration hashes.
  while (end > start && whitespace.test(sql[end - 1])) end--;
  return sql.slice(start, end);
}
function hasSql(text: string) {
  for (;;) {
    text = text.replace(/^\p{White_Space}+/u, "");
    if (text.startsWith("--")) {
      const end = text.indexOf("\n");
      text = end < 0 ? "" : text.slice(end + 1);
    } else if (text.startsWith("/*")) {
      const end = text.indexOf("*/", 2);
      text = end < 0 ? "" : text.slice(end + 2);
    } else if (text.startsWith(";")) text = text.slice(1);
    else return Boolean(text);
  }
}
export function migrationStatements(sql: string) {
  if (sql.includes("\0")) throw new Error("Migration must not contain NUL");
  const statements: { sql: string; params: never[] }[] = [];
  let state = 0, start = 0;
  const append = (piece: string) => {
    const text = trimSql(piece);
    if (hasSql(text)) statements.push({ sql: text, params: [] });
  };
  for (let i = 0; i < sql.length;) {
    let token = 2;
    const char = sql[i];
    if (/[ \r\t\n\f\uFEFF]/.test(char)) { i++; token = 1; }
    else if (sql.startsWith("--", i)) { const end = sql.indexOf("\n", i + 2); i = end < 0 ? sql.length : end + 1; token = 1; }
    else if (sql.startsWith("/*", i)) { const end = sql.indexOf("*/", i + 2); i = end < 0 ? sql.length : end + 2; token = 1; }
    else if (char === ";") { i++; token = 0; }
    else if (["'", '"', "`", "["].includes(char)) {
      const closing = char === "[" ? "]" : char;
      i++;
      while (i < sql.length) {
        if (sql[i++] === closing) {
          if (closing !== "]" && sql[i] === closing) { i++; continue; }
          break;
        }
      }
    } else if (/[A-Za-z0-9_$\u0080-\uffff]/.test(char)) {
      const begin = i++;
      while (i < sql.length && /[A-Za-z0-9_$\u0080-\uffff]/.test(sql[i])) i++;
      const word = sql.slice(begin, i).toLowerCase();
      token = Object.hasOwn(keywords, word) ? keywords[word] : 2;
    } else i++;
    state = transitions[state][token];
    if (token === 0 && state === 1) {
      append(sql.slice(start, i));
      start = i;
    }
  }
  append(sql.slice(start));
  return statements;
}
