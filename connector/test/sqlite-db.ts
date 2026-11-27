// A Db on node:sqlite with a migrations directory applied, so the connector can be tested without D1.
// Copied from sync-worker/test/sqlite-db.ts; the index is built from sync-worker/migrations, the
// one source of its schema, and the call log from this folder's migrations.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Db, DbResult, DbStatement } from "../src/db.ts";

export const INDEX_MIGRATIONS = new URL("../../sync-worker/migrations/", import.meta.url);
export const LOG_MIGRATIONS = new URL("../migrations/", import.meta.url);

// D1 binds booleans as 0/1 and ArrayBuffers as blobs; node:sqlite takes neither as is.
function toSqlite(value: unknown): SQLInputValue {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value as SQLInputValue;
}

class SqliteStatement implements DbStatement {
  readonly #sqlite: DatabaseSync;
  readonly #sql: string;
  readonly #values: unknown[];

  constructor(sqlite: DatabaseSync, sql: string, values: unknown[] = []) {
    this.#sqlite = sqlite;
    this.#sql = sql;
    this.#values = values;
  }

  bind(...values: unknown[]): DbStatement {
    return new SqliteStatement(this.#sqlite, this.#sql, values);
  }

  // Prepared here, not in prepare(), so bad SQL rejects on use the way D1 does.
  execute<T = Record<string, unknown>>(): DbResult<T> {
    const stmt = this.#sqlite.prepare(this.#sql);
    const params = this.#values.map(toSqlite);
    if (stmt.columns().length === 0) {
      const { changes, lastInsertRowid } = stmt.run(...params);
      return { results: [], meta: { changes: Number(changes), last_row_id: Number(lastInsertRowid) } };
    }
    const results = stmt.all(...params).map((row) => ({ ...row }) as T); // plain objects, as D1 returns
    const { c, r } = this.#sqlite.prepare("SELECT changes() AS c, last_insert_rowid() AS r").get() as { c: number; r: number };
    return { results, meta: { changes: c, last_row_id: r } };
  }

  async first<T>(): Promise<T | null> {
    return this.execute<T>().results[0] ?? null;
  }

  async run<T>(): Promise<DbResult<T>> {
    return this.execute<T>();
  }

  async all<T>(): Promise<DbResult<T>> {
    return this.execute<T>();
  }
}

export function sqliteDb(migrations: URL = INDEX_MIGRATIONS): Db {
  const sqlite = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true }); // D1 enforces them
  for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
  }
  return {
    prepare: (sql) => new SqliteStatement(sqlite, sql),
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((s) => {
          if (!(s instanceof SqliteStatement)) throw new Error("batch takes statements from this Db");
          return s.execute();
        });
        sqlite.exec("COMMIT");
        return results;
      } catch (err) {
        sqlite.exec("ROLLBACK");
        throw err;
      }
    },
  };
}
