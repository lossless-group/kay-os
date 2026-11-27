// Read-only access to the index and the raw mail (spec rule 2). Neither binding can be made
// read-only in wrangler.jsonc, so the connector reaches them only through these wrappers: the
// index runs single SELECT statements and nothing else, and the bucket only gets and heads keys
// built from a D1 row, never from tool input. test/store.test.ts holds them to that.
import type { Db } from "./db.ts";

const SELECT_ONLY = /^\s*SELECT\b/i;

export class ReadOnlyIndex {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  static check(sql: string): void {
    // One statement, starting with SELECT. (SQLite's WITH can front an INSERT, so it isn't allowed.)
    if (!SELECT_ONLY.test(sql) || sql.includes(";")) throw new Error("the index is read-only: one SELECT only");
  }

  async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    ReadOnlyIndex.check(sql);
    return (await this.#db.prepare(sql).bind(...params).all<T>()).results;
  }

  async first<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | null> {
    ReadOnlyIndex.check(sql);
    return this.#db.prepare(sql).bind(...params).first<T>();
  }
}

/** The slice of an R2 bucket binding the connector may use. */
export interface ReadBucket {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  head(key: string): Promise<{ size?: number } | null>;
}

const SHA = /^[0-9a-f]{64}$/;

export class ReadOnlyMail {
  readonly #bucket: ReadBucket;

  constructor(bucket: ReadBucket) {
    this.#bucket = bucket;
  }

  /** kaymail.raw_path: raw/<account>/<sha[:2]>/<sha>.eml, from a messages row. */
  static key(account: string, sha: string): string {
    if (!SHA.test(sha) || !account || /[/\\]|\.\./.test(account)) throw new Error("not a stored message");
    return `raw/${account}/${sha.slice(0, 2)}/${sha}.eml`;
  }

  async size(account: string, sha: string): Promise<number | null> {
    const head = await this.#bucket.head(ReadOnlyMail.key(account, sha));
    return head ? (head.size ?? 0) : null;
  }

  async get(account: string, sha: string): Promise<ArrayBuffer | null> {
    const obj = await this.#bucket.get(ReadOnlyMail.key(account, sha));
    return obj ? obj.arrayBuffer() : null;
  }
}
