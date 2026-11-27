// The slice of D1 the connector needs. Copied from sync-worker/src/db.ts, so tests can run it on
// node:sqlite (test/sqlite-db.ts) and no Cloudflare is involved.

export interface DbResult<T = Record<string, unknown>> {
  results: T[];
  meta: { changes: number; last_row_id: number };
}

export interface DbStatement {
  bind(...values: unknown[]): DbStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<DbResult<T>>;
  all<T = Record<string, unknown>>(): Promise<DbResult<T>>;
}

export interface Db {
  prepare(sql: string): DbStatement;
  batch(statements: DbStatement[]): Promise<DbResult[]>;
}

// A D1 binding is a Db as it stands; this line is where tsc checks that it still is.
export const fromD1 = (d1: D1Database): Db => d1;
