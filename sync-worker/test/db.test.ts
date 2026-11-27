import assert from "node:assert/strict";
import { test } from "node:test";
import { sqliteDb } from "./sqlite-db.ts";

const message = {
  account: "me@example.com",
  sha256: "a".repeat(64),
  subject: "Acme term sheet",
  from_addr: "ada@example.com",
  to_addr: "me@example.com",
  body: "Please find the Series A term sheet attached.",
  attachments: "acme-term-sheet.pdf",
};

const insertMessage = `INSERT INTO messages (account, mailbox, uidvalidity, uid, sha256, is_primary, subject, from_addr, to_addr, body, attachments)
  VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?) RETURNING id`;
const insertFts = `INSERT INTO messages_fts (rowid, subject, from_addr, to_addr, body, attachments) VALUES (?, ?, ?, ?, ?, ?)`;

test("the migrations create the laptop's tables, and a message, attachment and link round-trip", async () => {
  const db = sqliteDb();
  const m = message;
  const row = await db.prepare(insertMessage)
    .bind(m.account, "[Gmail]/All Mail", 7, 1, m.sha256, m.subject, m.from_addr, m.to_addr, m.body, m.attachments)
    .first<{ id: number }>();
  assert.ok(row);
  await db.prepare(insertFts).bind(row.id, m.subject, m.from_addr, m.to_addr, m.body, m.attachments).run();
  const att = await db.prepare("INSERT INTO attachments (sha256, content_type, size, kind) VALUES (?, ?, ?, ?)")
    .bind("b".repeat(64), "application/pdf", 1234, "document").run();
  await db.prepare("INSERT INTO message_attachments (message_id, part_index, attachment_id, filename, disposition) VALUES (?, ?, ?, ?, ?)")
    .bind(row.id, 2, att.meta.last_row_id, "acme-term-sheet.pdf", "attachment").run();

  const linked = await db.prepare(
    `SELECT a.kind, a.extract_status, a.is_noise, ma.filename FROM message_attachments ma
     JOIN attachments a ON a.id = ma.attachment_id WHERE ma.message_id = ?`,
  ).bind(row.id).all();
  assert.deepEqual(linked.results, [{ kind: "document", extract_status: "pending", is_noise: 0, filename: "acme-term-sheet.pdf" }]);

  const hits = await db.prepare(
    `SELECT m.subject, snippet(messages_fts, 3, '[', ']', '…', 10) AS snip FROM messages_fts
     JOIN messages m ON m.id = messages_fts.rowid WHERE messages_fts MATCH ? ORDER BY rank`,
  ).bind('"term sheet"').all<{ subject: string; snip: string }>();
  assert.equal(hits.results.length, 1);
  assert.equal(hits.results[0].subject, "Acme term sheet");
  assert.match(hits.results[0].snip, /Series A \[term sheet\] attached/);
  assert.equal(await db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").bind("invoice").first(), null);
});

test("mail the laptop fetched indexes without a mailbox or UID", async () => {
  const db = sqliteDb();
  const add = (sha: string) => db.prepare(insertMessage)
    .bind(message.account, null, null, null, sha, "s", "f", "t", "b", null).run();
  await add("c".repeat(64));
  await add("d".repeat(64)); // NULLs don't collide in the UNIQUE, so (account, sha256) is the writer's job
  const { n } = (await db.prepare("SELECT count(*) AS n FROM messages WHERE uid IS NULL").first<{ n: number }>())!;
  assert.equal(n, 2);
});

test("a batch applies all its statements or none", async () => {
  const db = sqliteDb();
  const scan = (id: number, status: string | null) =>
    db.prepare("INSERT INTO attachment_scans (message_id, status) VALUES (?, ?)").bind(id, status);
  const row = await db.prepare(insertMessage)
    .bind(message.account, "INBOX", 1, 1, "e".repeat(64), "s", "f", "t", "b", null).first<{ id: number }>();

  await assert.rejects(db.batch([
    db.prepare(insertMessage).bind(message.account, "INBOX", 1, 2, "f".repeat(64), "s", "f", "t", "b", null),
    scan(row!.id, null), // status is NOT NULL
  ]));
  const count = async () => (await db.prepare("SELECT count(*) AS n FROM messages").first<{ n: number }>())!.n;
  assert.equal(await count(), 1);

  const results = await db.batch([
    db.prepare(insertMessage).bind(message.account, "INBOX", 1, 2, "f".repeat(64), "s", "f", "t", "b", null),
    scan(row!.id, "ok"),
  ]);
  assert.equal(results.length, 2);
  assert.equal(await count(), 2);
  assert.deepEqual(await db.prepare("SELECT status FROM attachment_scans").first(), { status: "ok" });
});

test("foreign keys are enforced, as on D1", async () => {
  const db = sqliteDb();
  await assert.rejects(db.prepare("INSERT INTO attachment_scans (message_id, status) VALUES (?, ?)").bind(999, "ok").run());
});
