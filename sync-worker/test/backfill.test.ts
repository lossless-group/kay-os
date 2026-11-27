import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { backfillIndex, type BackfillState } from "../src/backfill.ts";
import type { Db } from "../src/db.ts";
import { indexMessage, sha256Hex } from "../src/indexer.ts";
import { syncAccount, type Bucket } from "../src/sync.ts";
import { fakeGmail } from "./fake-gmail.ts";
import { memoryBucket } from "./memory-bucket.ts";
import { sqliteDb } from "./sqlite-db.ts";

const encoder = new TextEncoder();
const account = "me@example.com";
const deck = new Uint8Array(readFileSync(new URL("./fixtures/deck.eml", import.meta.url)));
const all = async (db: Db, sql: string, ...values: unknown[]) => (await db.prepare(sql).bind(...values).all()).results;

const message = (n: number) => encoder.encode(
  `From: sender${n}@example.com\r\nTo: ${account}\r\nSubject: note ${n}\r\nDate: Fri, 05 Jan 2024 10:00:00 -0000\r\n\r\nbody ${n}\r\n`);

const rawKey = (sha: string) => `raw/${account}/${sha.slice(0, 2)}/${sha}.eml`;

/** R2 as C3 finds it: 10 messages the Worker fetched before C2 (raw + meta), 20 the laptop pushed (raw only). */
async function archive() {
  const { bucket, objects } = memoryBucket();
  objects.set(`state/${account}/seed.json`, JSON.stringify({ "[Gmail]/All Mail": { uidvalidity: 7, lastUid: 0 } }));
  const fetched = new Map(Array.from({ length: 10 }, (_, i) => [i + 1, message(i + 1)]));
  const state = await syncAccount({ address: account, password: "app-password" }, fakeGmail({ mail: fetched }).transport,
    bucket, { cursors: {} }); // no index, as before C2
  assert.equal(state.fetched, 10);
  const laptop = Array.from({ length: 20 }, (_, i) => message(100 + i));
  for (const raw of laptop) objects.set(rawKey(await sha256Hex(raw)), raw);
  return { bucket, objects, fetchedShas: await Promise.all([...fetched.values()].map(sha256Hex)) };
}

test("30 messages, 10 with meta: budget 12 indexes 12, then 12, then the last 6, with no duplicates", async () => {
  const db = sqliteDb();
  const { bucket, fetchedShas } = await archive();
  const saved: BackfillState[] = [];
  const save = async (s: BackfillState) => void saved.push(s);
  let state: BackfillState = {};
  const counts: number[] = [];
  for (let run = 0; run < 3; run++) {
    const r = await backfillIndex(account, bucket, db, state, { budget: 12, pageSize: 7, save });
    assert.equal(r.lastError, undefined);
    assert.deepEqual(saved.at(-1), r.state, "the last save is the state handed back");
    counts.push(r.indexed);
    state = r.state;
    assert.equal(!!state.done, run === 2);
  }
  assert.deepEqual(counts, [12, 12, 6]);
  assert.ok(state.metaIndexed);
  assert.equal((await all(db, "SELECT * FROM r2_meta")).length, 10);

  const rows = await all(db, "SELECT sha256, mailbox, uidvalidity, uid, labels, thread_id, flags, date, is_primary FROM messages");
  assert.equal(rows.length, 30);
  assert.equal(new Set(rows.map((r) => r.sha256)).size, 30);
  assert.ok(rows.every((r) => r.is_primary === 1));
  const withMeta = rows.filter((r) => fetchedShas.includes(r.sha256 as string));
  assert.equal(withMeta.length, 10);
  for (const r of withMeta) {
    assert.equal(r.mailbox, "[Gmail]/All Mail");
    assert.equal(r.uidvalidity, 7);
    assert.ok(Number.isInteger(r.uid));
    assert.equal(r.labels, '"\\\\Inbox" "Deals" "Big Deals"');
    assert.equal(r.thread_id, "99");
    assert.equal(r.date, "2024-01-05T09:00:00+00:00", "INTERNALDATE, not the Date header");
  }
  assert.deepEqual(new Set(withMeta.map((r) => r.uid)), new Set(Array.from({ length: 10 }, (_, i) => i + 1)));
  for (const r of rows.filter((r) => !fetchedShas.includes(r.sha256 as string))) {
    assert.deepEqual([r.mailbox, r.uidvalidity, r.uid, r.labels, r.thread_id, r.flags], [null, null, null, null, null, null]);
    assert.equal(r.date, "2024-01-05T10:00:00+00:00", "the Date header");
  }
  assert.equal((await all(db, "SELECT * FROM messages_fts")).length, 30);

  const again = await backfillIndex(account, bucket, db, {}, { budget: 100 });
  assert.equal(again.indexed, 0, "a fresh walk finds nothing left to do");
});

test("a message C2 already indexed as it was fetched is skipped", async () => {
  const db = sqliteDb();
  const { bucket, objects } = memoryBucket();
  const sha = await sha256Hex(deck);
  objects.set(rawKey(sha), deck);
  await indexMessage(db, {
    account, mailbox: "INBOX", uidvalidity: 3, uid: 42, sha256: sha, raw: deck,
    internalDate: null, flags: [], labels: null, threadId: null,
  });
  const other = message(1);
  objects.set(rawKey(await sha256Hex(other)), other);

  const r = await backfillIndex(account, bucket, db, {});
  assert.equal(r.indexed, 1);
  assert.ok(r.state.done);
  const rows = await all(db, "SELECT uid FROM messages ORDER BY uid IS NULL, uid");
  assert.deepEqual(rows, [{ uid: 42 }, { uid: null }]);
  assert.equal((await all(db, "SELECT * FROM message_attachments")).length, 4, "the deck's parts, once");
});

test("a corrupt .eml is recorded as error and the walk goes on", async () => {
  const db = sqliteDb();
  const { bucket, objects } = memoryBucket();
  // Deeper than postal-mime's 256-level limit, so parsing throws.
  let deep = "From: x@example.com\r\nSubject: deep\r\n";
  for (let i = 0; i < 300; i++) deep += `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\n`;
  const corrupt = encoder.encode(deep + "Content-Type: text/plain\r\n\r\nbottom\r\n");
  for (const raw of [corrupt, deck, message(1), message(2)]) objects.set(rawKey(await sha256Hex(raw)), raw);

  const r = await backfillIndex(account, bucket, db, {});
  assert.deepEqual([r.indexed, r.errors, r.state.done, r.lastError], [4, 1, true, undefined]);
  const scans = await all(db, "SELECT m.sha256, s.status FROM attachment_scans s JOIN messages m ON m.id = s.message_id");
  assert.equal(scans.length, 4);
  assert.deepEqual(scans.filter((s) => s.status === "error").map((s) => s.sha256), [await sha256Hex(corrupt)]);
});

test("an error mid-page ends the run, and the next resumes from that page without gaps", async () => {
  const db = sqliteDb();
  const { bucket: inner } = await archive();
  let rawGets = 0;
  let failed = false;
  const flaky: Bucket = {
    ...inner,
    async get(key) {
      if (key.startsWith("raw/") && ++rawGets === 5 && !failed) {
        failed = true;
        throw new Error("R2 unavailable");
      }
      return inner.get(key);
    },
  };
  const saved: BackfillState[] = [];
  const save = async (s: BackfillState) => void saved.push(s);

  const first = await backfillIndex(account, flaky, db, {}, { budget: 100, pageSize: 8, save });
  assert.equal(first.lastError, "Error: R2 unavailable");
  assert.equal(first.indexed, 4);
  assert.equal(first.state.done, undefined);
  assert.equal(first.state.cursor, undefined, "still on the first page of raw/");
  assert.deepEqual(saved.at(-1), first.state);

  const second = await backfillIndex(account, flaky, db, saved.at(-1)!, { budget: 100, pageSize: 8, save });
  assert.equal(second.lastError, undefined);
  assert.equal(second.indexed, 26);
  assert.ok(second.state.done);
  const rows = await all(db, "SELECT sha256 FROM messages");
  assert.equal(rows.length, 30);
  assert.equal(new Set(rows.map((r) => r.sha256)).size, 30);
});

test("a first read of meta/ too large for one run spans runs, and the walk waits for it", async () => {
  const db = sqliteDb();
  const { bucket } = await archive();
  const first = await backfillIndex(account, bucket, db, {}, { metaBudget: 4, pageSize: 3 });
  assert.equal(first.indexed, 0);
  assert.equal(first.state.metaIndexed, undefined);
  assert.ok(first.state.metaCursor);
  const second = await backfillIndex(account, bucket, db, first.state, { metaBudget: 100, pageSize: 3 });
  assert.ok(second.state.metaIndexed);
  assert.equal(second.indexed, 30);
  assert.equal((await all(db, "SELECT * FROM messages WHERE uid IS NOT NULL")).length, 10);
});
