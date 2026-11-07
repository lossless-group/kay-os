import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertReadOnly, AuthFailed, formatUidSet, ImapClient, ImapError, mailboxesToSync, tokenize,
  type FetchedMessage,
} from "../src/imap.ts";
import { fakeGmail, type FakeOptions } from "./fake-gmail.ts";

const encoder = new TextEncoder();

// Bodies that would break a parser reading by delimiter instead of by length:
// a closing paren, a fake literal marker, a lone CRLF, and bytes that aren't UTF-8.
const MAIL = new Map<number, Uint8Array>([
  [1, encoder.encode("From: alice@example.com\r\nSubject: Term sheet\r\n\r\nSee attached ) {5}\r\n.\r\n")],
  [2, new Uint8Array([...encoder.encode("Subject: binary\r\n\r\n"), 0xff, 0xfe, 0x00, 0x29, 0x0d, 0x0a])],
  [3, encoder.encode("Subject: third\r\n\r\nhello")],
]);

async function connected(options: FakeOptions = {}) {
  const fake = fakeGmail({ mail: MAIL, ...options });
  const client = await ImapClient.open(fake.transport, { timeoutMs: 2000 });
  await client.login("me@example.com", "app-password");
  return { client, commands: fake.commands };
}

async function fetchAll(client: ImapClient, uids: number[]): Promise<FetchedMessage[]> {
  const got: FetchedMessage[] = [];
  await client.uidFetch(uids, (m) => {
    got.push(m);
  });
  return got;
}

test("logs in and recognises Gmail", async () => {
  const { client } = await connected();
  assert.ok(client.isGmail);
  await client.logout();
});

test("a bad password is reported as AuthFailed, after one LOGIN", async () => {
  const fake = fakeGmail({ mail: MAIL });
  const client = await ImapClient.open(fake.transport, { timeoutMs: 2000 });
  await assert.rejects(client.login("me@example.com", "wrong"), AuthFailed);
  assert.equal(fake.commands.filter((c) => c.startsWith("LOGIN")).length, 1);
  client.close();
});

test("lists mailboxes, including a name sent as a literal", async () => {
  const { client } = await connected();
  const boxes = await client.list();
  assert.deepEqual(boxes.map((b) => b.name), ["INBOX", 'Odd "Name" )', "[Gmail]", "[Gmail]/All Mail", "[Gmail]/Trash"]);
  assert.deepEqual(boxes[3].flags, ["\\All", "\\HasNoChildren"]);
  await client.logout();
});

test("syncs only All Mail on Gmail, and every real folder elsewhere", async () => {
  const { client } = await connected();
  const boxes = await client.list();
  assert.deepEqual(mailboxesToSync(boxes, true), ["[Gmail]/All Mail"]);
  assert.deepEqual(mailboxesToSync(boxes, false), ["INBOX", 'Odd "Name" )', "[Gmail]/All Mail"]);
  assert.throws(() => mailboxesToSync(boxes.filter((b) => !b.flags.includes("\\All")), true), /Show in IMAP/);
  await client.logout();
});

test("examine reports UIDVALIDITY, UIDNEXT and the message count", async () => {
  const { client } = await connected();
  assert.deepEqual(await client.examine("[Gmail]/All Mail"), { exists: 3, uidvalidity: 7, uidnext: 4 });
  await client.logout();
});

test("searching from a UID drops the newest-message match below it", async () => {
  const { client } = await connected();
  await client.examine("[Gmail]/All Mail");
  assert.deepEqual(await client.uidSearch(), [1, 2, 3]);
  assert.deepEqual(await client.uidSearch(2), [2, 3]);
  assert.deepEqual(await client.uidSearch(10), []);
  await client.logout();
});

for (const chunk of [4096, 1]) {
  test(`fetches exact bytes and Gmail metadata (replies in ${chunk}-byte pieces)`, async () => {
    const { client } = await connected({ chunk });
    await client.examine("[Gmail]/All Mail");
    const got = await fetchAll(client, [3, 1, 2]);
    assert.deepEqual(got.map((m) => m.uid), [1, 2, 3]);
    for (const m of got) {
      assert.deepEqual(m.raw, MAIL.get(m.uid), `uid ${m.uid} body`);
      assert.equal(m.size, MAIL.get(m.uid)!.length);
      assert.equal(m.gmailThreadId, "99");
      assert.equal(m.gmailMessageId, `1${m.uid}`);
      assert.deepEqual(m.gmailLabels, ["\\Inbox", "Deals", "Big Deals"]);
      assert.equal(m.internalDate, "05-Jan-2024 10:00:00 +0100");
    }
    assert.deepEqual(got[0].flags, ["\\Seen"]);
    assert.deepEqual(got[1].flags, []);
    await client.logout();
  });
}

test("a message over the size cap is dropped without losing the next one", async () => {
  const fake = fakeGmail({ mail: MAIL });
  const client = await ImapClient.open(fake.transport, { timeoutMs: 2000, maxLiteralBytes: 30 });
  await client.login("me@example.com", "app-password");
  const got = await fetchAll(client, [1, 2, 3]);
  assert.equal(got[0].raw, null);
  assert.equal(got[0].size, MAIL.get(1)!.length);
  assert.deepEqual(got[1].raw, MAIL.get(2));
  assert.deepEqual(got[2].raw, MAIL.get(3));
  await client.logout();
});

test("Gmail's bandwidth limit surfaces as code OVERQUOTA", async () => {
  const { client } = await connected({ overquota: true });
  await client.examine("[Gmail]/All Mail");
  await assert.rejects(fetchAll(client, [1]), (err: unknown) => err instanceof ImapError && err.code === "OVERQUOTA");
  await client.logout();
});

test("never sends anything that could change the mailbox", async () => {
  const { client, commands } = await connected();
  await client.list();
  await client.examine("[Gmail]/All Mail");
  await client.uidSearch(1);
  await fetchAll(client, [1, 2, 3]);
  await client.logout();
  for (const command of commands) assertReadOnly(command);
  const joined = commands.join("\n").toUpperCase();
  for (const word of ["SELECT", "STORE", "COPY", "MOVE", "EXPUNGE", "APPEND", "DELETE"]) {
    assert.ok(!joined.includes(word), `sent ${word}`);
  }
  assert.ok(commands.some((c) => c.includes("BODY.PEEK[]")));
});

test("assertReadOnly refuses writes and fetches that mark mail read", () => {
  for (const bad of ["SELECT INBOX", "UID STORE 1 +FLAGS (\\Deleted)", "EXPUNGE", "UID FETCH 1 (BODY[])",
    "UID FETCH 1 (RFC822)", "UID FETCH 1 (BINARY[1])", "UID MOVE 1 Trash"]) {
    assert.throws(() => assertReadOnly(bad), (err: unknown) => err instanceof ImapError && err.code === "READONLY", bad);
  }
  for (const ok of ["UID FETCH 1:3 (UID RFC822.SIZE BODY.PEEK[])", 'EXAMINE "INBOX"', "UID SEARCH ALL"]) {
    assert.doesNotThrow(() => assertReadOnly(ok), ok);
  }
});

test("formatUidSet folds runs into ranges", () => {
  assert.equal(formatUidSet([9, 1, 2, 3, 5, 8, 2]), "1:3,5,8:9");
  assert.equal(formatUidSet([42]), "42");
});

test("tokenize handles nesting, NIL, escapes and bracketed atoms", () => {
  const body = encoder.encode("x");
  assert.deepEqual(
    tokenize(['* 1 FETCH (BODY[HEADER.FIELDS (A B)] NIL FLAGS () X "a \\"q\\" \\\\b" (n (m)) BODY[] ', body, ")"]),
    ["*", "1", "FETCH", ["BODY[HEADER.FIELDS (A B)]", null, "FLAGS", [], "X", 'a "q" \\b', ["n", ["m"]], "BODY[]", body]],
  );
});
