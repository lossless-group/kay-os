import assert from "node:assert/strict";
import { test } from "node:test";
import { syncAccount, type Bucket } from "../src/sync.ts";
import { fakeGmail } from "./fake-gmail.ts";

const encoder = new TextEncoder();
const account = { address: "me@example.com", password: "app-password" };

function mail(n: number) {
  return new Map(Array.from({ length: n }, (_, i) => [i + 1, encoder.encode(`Subject: ${i + 1}\r\n\r\nbody ${i + 1}`)]));
}

function memoryBucket(seed: Record<string, string> = {}) {
  const objects = new Map<string, Uint8Array | string>(Object.entries(seed));
  const bucket: Bucket = {
    async get(key) {
      const v = objects.get(key);
      return v === undefined ? null : { text: async () => (typeof v === "string" ? v : new TextDecoder().decode(v)) };
    },
    async head(key) {
      return objects.has(key) ? {} : null;
    },
    async put(key, value) {
      objects.set(key, value);
    },
  };
  return { bucket, objects };
}

const rawKeys = (objects: Map<string, unknown>) => [...objects.keys()].filter((k) => k.startsWith("raw/"));

test("a first run with no seed starts from now and fetches nothing old", async () => {
  const { bucket, objects } = memoryBucket();
  const state = await syncAccount(account, fakeGmail({ mail: mail(3) }).transport, bucket, { cursors: {} });
  assert.equal(state.lastError, undefined);
  assert.equal(state.fetched, 0);
  assert.deepEqual(state.cursors["[Gmail]/All Mail"], { uidvalidity: 7, lastUid: 3 });
  assert.equal(rawKeys(objects).length, 0);
});

test("fetches past the laptop seed, at kaymail's paths, then resumes", async () => {
  const seed = { "state/me@example.com/seed.json": JSON.stringify({ "[Gmail]/All Mail": { uidvalidity: 7, lastUid: 1 } }) };
  const { bucket, objects } = memoryBucket(seed);
  const first = await syncAccount(account, fakeGmail({ mail: mail(4) }).transport, bucket, { cursors: {} }, 2);
  assert.equal(first.fetched, 2);
  assert.equal(first.cursors["[Gmail]/All Mail"].lastUid, 3);
  const second = await syncAccount(account, fakeGmail({ mail: mail(4) }).transport, bucket, first);
  assert.equal(second.fetched, 1);
  assert.equal(second.cursors["[Gmail]/All Mail"].lastUid, 4);

  const keys = rawKeys(objects);
  assert.equal(keys.length, 3);
  for (const key of keys) assert.match(key, /^raw\/me@example\.com\/([0-9a-f]{2})\/\1[0-9a-f]{62}\.eml$/);
  const meta = JSON.parse(objects.get("meta/me@example.com/%5BGmail%5D%2FAll%20Mail/7/4.json") as string);
  assert.equal(meta.uid, 4);
  assert.equal(meta.gmailThreadId, "99");
  assert.ok(keys.includes(`raw/me@example.com/${meta.sha256.slice(0, 2)}/${meta.sha256}.eml`));
});

test("a renumbered mailbox restarts from now instead of refetching", async () => {
  const { bucket } = memoryBucket();
  const state = await syncAccount(account, fakeGmail({ mail: mail(3) }).transport, bucket,
    { cursors: { "[Gmail]/All Mail": { uidvalidity: 1, lastUid: 0 } } });
  assert.equal(state.fetched, 0);
  assert.deepEqual(state.cursors["[Gmail]/All Mail"], { uidvalidity: 7, lastUid: 3 });
});

test("failures are recorded, and progress before them is kept", async () => {
  const seed = { "state/me@example.com/seed.json": JSON.stringify({ "[Gmail]/All Mail": { uidvalidity: 7, lastUid: 0 } }) };
  const { bucket } = memoryBucket(seed);
  const quota = await syncAccount(account, fakeGmail({ mail: mail(2), overquota: true }).transport, bucket, { cursors: {} });
  assert.match(quota.lastError!, /OVERQUOTA|bandwidth/);
  assert.equal(quota.cursors["[Gmail]/All Mail"].lastUid, 0);
  const auth = await syncAccount({ ...account, password: "wrong" }, fakeGmail({ mail: mail(2) }).transport, bucket, quota);
  assert.match(auth.lastError!, /AuthFailed/);
  assert.deepEqual(auth.cursors, quota.cursors);
});
