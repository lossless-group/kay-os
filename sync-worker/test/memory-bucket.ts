// An in-memory stand-in for the R2 bucket binding: keys listed in order, a page at a time.
import type { Bucket } from "../src/sync.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function memoryBucket(seed: Record<string, Uint8Array | string> = {}) {
  const objects = new Map<string, Uint8Array | string>(Object.entries(seed));
  const bucket: Bucket = {
    async get(key) {
      const v = objects.get(key);
      if (v === undefined) return null;
      const bytes = typeof v === "string" ? encoder.encode(v) : v;
      return {
        text: async () => (typeof v === "string" ? v : decoder.decode(v)),
        arrayBuffer: async () => bytes.slice().buffer,
      };
    },
    async head(key) {
      return objects.has(key) ? {} : null;
    },
    async put(key, value) {
      objects.set(key, value);
    },
    // Like R2: keys in lexicographic order, at most `limit` (default 1,000) a page, and an opaque
    // cursor to continue. Here the cursor is the page's last key, so keys added later still show.
    async list({ prefix, cursor, limit = 1000 }) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix) && (cursor === undefined || k > cursor)).sort();
      const page = keys.slice(0, limit);
      const truncated = keys.length > page.length;
      return { objects: page.map((key) => ({ key })), truncated, ...(truncated ? { cursor: page.at(-1) } : {}) };
    },
  };
  return { bucket, objects };
}
