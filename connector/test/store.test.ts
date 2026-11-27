import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { ReadOnlyIndex, ReadOnlyMail } from "../src/store.ts";
import { memoryBucket } from "./fixtures.ts";
import { sqliteDb } from "./sqlite-db.ts";

test("the index wrapper runs one SELECT and refuses anything else", async () => {
  const index = new ReadOnlyIndex(sqliteDb());
  assert.deepEqual(await index.all("SELECT count(*) AS n FROM messages"), [{ n: 0 }]);
  for (const sql of [
    "INSERT INTO messages (account, sha256, is_primary) VALUES ('a', 'b', 1)",
    "DELETE FROM messages",
    "UPDATE attachments SET is_noise = 1",
    "WITH x AS (SELECT 1) INSERT INTO attachment_scans SELECT 1, 'ok' FROM x",
    "SELECT 1; DELETE FROM messages",
    "DROP TABLE messages",
    "PRAGMA writable_schema = 1",
  ]) {
    await assert.rejects(index.all(sql), /read-only/, sql);
    await assert.rejects(index.first(sql), /read-only/, sql);
  }
  assert.deepEqual(Object.getOwnPropertyNames(ReadOnlyIndex.prototype).sort(), ["all", "constructor", "first"]);
});

test("every statement in the connector's source that touches the index is a SELECT", () => {
  // The log's one INSERT is the only other statement, and it goes to LOG.
  const src = new URL("../src/", import.meta.url);
  for (const file of readdirSync(src).filter((f) => f.endsWith(".ts"))) {
    const text = readFileSync(new URL(file, src), "utf8");
    const writes = text.match(/\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE)\s+(INTO|FROM|TABLE|INDEX|\w+\s+SET)\b/g) ?? [];
    if (file === "log.ts") assert.deepEqual(writes, ["INSERT INTO"], file);
    else assert.deepEqual(writes, [], file);
  }
});

test("the mail wrapper can only get and head, at keys built from a messages row", async () => {
  const { bucket, objects } = memoryBucket();
  const sha = "ab".repeat(32);
  objects.set(`raw/me@example.com/ab/${sha}.eml`, new TextEncoder().encode("hi"));
  const mail = new ReadOnlyMail(bucket);
  assert.equal(await mail.size("me@example.com", sha), 2);
  assert.equal(new TextDecoder().decode(await mail.get("me@example.com", sha) as ArrayBuffer), "hi");
  assert.equal(await mail.get("me@example.com", "cd".repeat(32)), null);
  assert.deepEqual(Object.getOwnPropertyNames(ReadOnlyMail.prototype).sort(), ["constructor", "get", "size"]);
  assert.throws(() => ReadOnlyMail.key("me@example.com", "../../meta"), /not a stored message/);
  assert.throws(() => ReadOnlyMail.key("../x", sha), /not a stored message/);
  assert.throws(() => ReadOnlyMail.key("a/b", sha), /not a stored message/);
});
