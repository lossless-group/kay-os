import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Db } from "../src/db.ts";
import { htmlToText, indexMessage, refreshNoise, sha256Hex, toUtc, type IndexInput } from "../src/indexer.ts";
import { attachmentKind, isNoise, sniffType } from "../src/rules.ts";
import { syncAccount, type Bucket } from "../src/sync.ts";
import { fakeGmail } from "./fake-gmail.ts";
import { sqliteDb } from "./sqlite-db.ts";

const encoder = new TextEncoder();
const account = "me@example.com";
// test_kaymail.deck_message(), written by mail/testdata/make_testdata.py.
const deck = new Uint8Array(readFileSync(new URL("./fixtures/deck.eml", import.meta.url)));

async function input(raw: Uint8Array, uid: number | null, overrides: Partial<IndexInput> = {}): Promise<IndexInput> {
  return {
    account, mailbox: uid === null ? null : "[Gmail]/All Mail", uidvalidity: uid === null ? null : 7, uid,
    sha256: await sha256Hex(raw), raw, internalDate: "05-Jan-2024 10:00:00 +0100",
    flags: ["\\Seen"], labels: ["\\Inbox", "Big Deals"], threadId: "99", ...overrides,
  };
}

const all = async (db: Db, sql: string, ...values: unknown[]) => (await db.prepare(sql).bind(...values).all()).results;

function memoryBucket() {
  const objects = new Map<string, Uint8Array | string>();
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

test("the deck message: four parts, the document and invite listed, the logo noise", async () => {
  const db = sqliteDb();
  assert.deepEqual(await indexMessage(db, await input(deck, 4)), { status: "indexed", primary: true, attachments: 4 });

  const [m] = await all(db, "SELECT * FROM messages");
  assert.equal(m.is_primary, 1);
  assert.equal(m.from_addr, "founder@acme.example");
  assert.equal(m.subject, "Our deck");
  assert.equal(m.date, "2024-01-05T09:00:00+00:00");
  assert.equal(m.labels, '"\\\\Inbox" "Big Deals"');
  assert.equal(m.flags, "\\Seen");
  assert.equal(m.thread_id, "99");
  assert.equal(m.size, deck.length);
  assert.equal(m.attachments, "Acme Deck.pdf, logo.png, invite.ics");
  assert.match(m.body as string, /^Deck attached, and an invite for Tuesday\./);

  const parts = await all(db, `SELECT ma.part_index, ma.filename, ma.disposition, ma.content_id, a.kind, a.is_noise, a.content_type
    FROM message_attachments ma JOIN attachments a ON a.id = ma.attachment_id ORDER BY ma.part_index`);
  assert.equal(parts.length, 4, "deck, logo, the inline invite and invite.ics");
  const listed = parts.filter((p) => !p.is_noise);
  assert.deepEqual(new Set(listed.map((p) => p.kind)), new Set(["document", "calendar"]));
  assert.equal(listed.find((p) => p.kind === "document")!.filename, "Acme Deck.pdf");
  assert.ok(listed.filter((p) => p.kind === "calendar").every((p) => p.content_type === "text/calendar"));
  const logo = parts.find((p) => p.kind === "image")!;
  assert.deepEqual([logo.is_noise, logo.disposition, logo.content_id], [1, "inline", "<logo@acme.example>"]);
  assert.equal((await all(db, "SELECT id FROM attachments")).length, 3, "both invites are one file");
  assert.deepEqual(await all(db, "SELECT status FROM attachment_scans"), [{ status: "ok" }]);

  const hits = await all(db, "SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'invite'");
  assert.deepEqual(hits, [{ rowid: m.id }]);
});

test("the same bytes twice: one primary message, one row per attachment, and reruns are no-ops", async () => {
  const db = sqliteDb();
  await indexMessage(db, await input(deck, 4));
  assert.deepEqual(await indexMessage(db, await input(deck, 5)), { status: "indexed", primary: false, attachments: 0 });
  assert.deepEqual(await indexMessage(db, await input(deck, 5)), { status: "exists" });
  // Laptop-fetched copies have no UID, so their bytes are their key.
  assert.deepEqual(await indexMessage(db, await input(deck, null)), { status: "exists" });

  assert.deepEqual(await all(db, "SELECT uid, is_primary FROM messages ORDER BY uid"), [{ uid: 4, is_primary: 1 }, { uid: 5, is_primary: 0 }]);
  assert.equal((await all(db, "SELECT id FROM attachments")).length, 3);
  assert.equal((await all(db, "SELECT * FROM message_attachments")).length, 4);
  // A full scan of messages_fts reads its content table, so ask the index itself.
  assert.equal((await all(db, "SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'deck'")).length, 1);
});

test("a message seen first without a UID is indexed by its bytes", async () => {
  const db = sqliteDb();
  const raw = encoder.encode("From: ada@example.com\r\nSubject: Hi\r\nDate: Tue, 2 Jan 2024 08:30:00 -0500\r\n\r\nhello");
  const outcome = await indexMessage(db, await input(raw, null, { internalDate: null, flags: null, labels: null, threadId: null }));
  assert.deepEqual(outcome, { status: "indexed", primary: true, attachments: 0 });
  const [m] = await all(db, "SELECT mailbox, uid, date, labels, flags FROM messages");
  assert.deepEqual(m, { mailbox: null, uid: null, date: "2024-01-02T13:30:00+00:00", labels: null, flags: null });
  assert.deepEqual(await indexMessage(db, await input(raw, null)), { status: "exists" });
});

// Deeper than postal-mime's 256-level limit, so parsing throws.
function tooDeep(): Uint8Array {
  let raw = "From: x@example.com\r\nSubject: deep\r\n";
  for (let i = 0; i < 300; i++) raw += `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\n`;
  return encoder.encode(raw + "Content-Type: text/plain\r\n\r\nbottom\r\n");
}

test("a malformed message: the sync completes, R2 has it, and its scan says error", async () => {
  const db = sqliteDb();
  const { bucket, objects } = memoryBucket();
  objects.set(`state/${account}/seed.json`, JSON.stringify({ "[Gmail]/All Mail": { uidvalidity: 7, lastUid: 0 } }));
  const mail = new Map([[1, tooDeep()], [2, deck]]);
  const state = await syncAccount({ address: account, password: "app-password" }, fakeGmail({ mail }).transport,
    bucket, { cursors: {} }, 200, db);

  assert.equal(state.lastError, undefined);
  assert.equal(state.fetched, 2);
  const shas = await Promise.all([...mail.values()].map(sha256Hex));
  for (const sha of shas) assert.ok(objects.has(`raw/${account}/${sha.slice(0, 2)}/${sha}.eml`));
  const scans = await all(db, "SELECT m.uid, s.status FROM attachment_scans s JOIN messages m ON m.id = s.message_id ORDER BY m.uid");
  assert.deepEqual(scans, [{ uid: 1, status: "error" }, { uid: 2, status: "ok" }]);
  assert.equal((await all(db, "SELECT * FROM message_attachments")).length, 4);
});

test("without an index the sync stores to R2 only, as before", async () => {
  const { bucket, objects } = memoryBucket();
  objects.set(`state/${account}/seed.json`, JSON.stringify({ "[Gmail]/All Mail": { uidvalidity: 7, lastUid: 0 } }));
  const state = await syncAccount({ address: account, password: "app-password" },
    fakeGmail({ mail: new Map([[1, deck]]) }).transport, bucket, { cursors: {} });
  assert.equal(state.fetched, 1);
});

test("an image on more than 50 messages becomes noise on the next refresh", async () => {
  const db = sqliteDb();
  const banner = "\x89PNG\r\n\x1a\n" + "x".repeat(20_000);
  for (let uid = 1; uid <= 51; uid++) {
    const raw = encoder.encode([
      "From: news@example.com", `Subject: issue ${uid}`, 'Content-Type: multipart/mixed; boundary="b"', "",
      "--b", "Content-Type: text/plain", "", `issue ${uid}`,
      "--b", "Content-Type: image/png", 'Content-Disposition: attachment; filename="banner.png"',
      "Content-Transfer-Encoding: base64", "", btoa(banner), "--b--", "",
    ].join("\r\n"));
    await indexMessage(db, await input(raw, uid));
  }
  assert.deepEqual(await all(db, "SELECT kind, is_noise FROM attachments"), [{ kind: "image", is_noise: 0 }]);
  await refreshNoise(db);
  assert.deepEqual(await all(db, "SELECT kind, is_noise FROM attachments"), [{ kind: "image", is_noise: 1 }]);
});

test("dates and HTML bodies come out as on the laptop", () => {
  assert.equal(toUtc(" 5-Jan-2024 10:00:00 +0100", null), "2024-01-05T09:00:00+00:00");
  assert.equal(toUtc(null, "Fri, 05 Jan 2024 10:00:00 -0000"), "2024-01-05T10:00:00+00:00");
  assert.equal(toUtc(null, "not a date"), null);
  assert.equal(htmlToText("<p>Revenue <b>grew</b></p><style>.hidden{color:red}</style>&amp; &#8364;5"), "Revenue grew & €5");
});

test("the attachment rules pass the cases the Python suite checks", () => {
  const url = new URL("../../mail/testdata/attachment_rules.json", import.meta.url);
  const cases = JSON.parse(readFileSync(url, "utf8"));
  assert.ok(cases.length > 20);
  for (const c of cases) {
    const data = Uint8Array.from(Buffer.from(c.first_bytes_hex, "hex"));
    const contentType = sniffType(data, c.declared_type, c.filename);
    const kind = attachmentKind(contentType, c.filename);
    const noise = isNoise(kind, c.size, c.disposition, c.content_id);
    assert.deepEqual({ content_type: contentType, kind, is_noise: noise }, c.expected, c.name);
  }
});
