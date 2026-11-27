// Minimal types for the parts of the Workers runtime this worker uses.
// D1 is copied from sync-worker/src/cloudflare-workers.d.ts; R2 is only the read side.

interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: true;
  meta: { changes: number; last_row_id: number; [key: string]: unknown };
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

interface R2ObjectBody {
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  head(key: string): Promise<{ size: number } | null>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

// WebCrypto's key type. The runtime has it globally; tsc sees it through @types/node (tsconfig).
type CryptoKey = import("node:crypto").webcrypto.CryptoKey;
