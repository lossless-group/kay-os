// The slice of D1 the index writer (C2) and backfill (C3) need. Tests run it on node:sqlite
// (test/sqlite-db.ts) so no Cloudflare is involved.

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
  /** Runs the statements in order in one transaction: if any fails, none apply. */
  batch(statements: DbStatement[]): Promise<DbResult[]>;
}

// A D1 binding is a Db as it stands; this line is where tsc checks that it still is.
export const fromD1 = (d1: D1Database): Db => d1;
