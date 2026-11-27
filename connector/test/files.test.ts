import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { safeContentType, safeFilename, signTicket } from "../src/files.ts";
import { MICHAEL, NOW, RESOURCE, block, connector, deck } from "./fixtures.ts";

async function linkFor(c: Awaited<ReturnType<typeof connector>>, id: number): Promise<string> {
  const b = block((await c.call("get_attachment", { id })).text);
  return (JSON.parse(b.before.slice(0, b.before.indexOf("\n\n"))) as { download_url: string }).download_url;
}

test("a download link returns the file, decoded from its .eml, with bytes matching its SHA-256", async () => {
  const c = await connector();
  const msg = await c.add(deck);
  const pdf = msg.attachments.find((a) => a.filename === "Acme Deck.pdf")!;
  const res = await c.send(new Request(await linkFor(c, pdf.id)));
  assert.equal(res.status, 200);
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.equal(createHash("sha256").update(bytes).digest("hex"), pdf.sha);
  assert.ok(Buffer.from(bytes).subarray(0, 4).toString() === "%PDF");
  assert.equal(res.headers.get("content-type"), "application/pdf");
  assert.equal(res.headers.get("content-disposition"), `attachment; filename="Acme Deck.pdf"; filename*=UTF-8''Acme%20Deck.pdf`);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("content-security-policy"), "sandbox");
  assert.equal(res.headers.get("cache-control"), "no-store");

  // The calendar part, which postal-mime hands back as text, matches too.
  const ics = msg.attachments.find((a) => a.filename === "invite.ics")!;
  const cal = await c.send(new Request(await linkFor(c, ics.id)));
  assert.equal(createHash("sha256").update(new Uint8Array(await cal.arrayBuffer())).digest("hex"), ics.sha);

  const rows = await c.logRows();
  assert.deepEqual(rows.filter((r) => r.tool === "download").map((r) => [r.ok, r.sub, JSON.parse(r.args as string).sha]),
    [[1, MICHAEL, pdf.sha], [1, MICHAEL, ics.sha]]);
});

test("a link fails after 15 minutes, with a changed byte, or for another file", async () => {
  const c = await connector();
  const msg = await c.add(deck);
  const [first, second] = msg.attachments;
  const url = await linkFor(c, first.id);

  c.setNow(NOW + 15 * 60_000 + 1000);
  const late = await c.send(new Request(url));
  assert.equal(late.status, 410);
  c.setNow(NOW);

  const t = new URL(url).searchParams.get("t")!;
  const flipped = t.slice(0, -2) + (t.at(-2) === "A" ? "B" : "A") + t.at(-1);
  assert.equal((await c.send(new Request(`${RESOURCE}/files/${first.sha}?t=${flipped}`))).status, 404);
  const [body, mac] = t.split(".");
  const otherBody = Buffer.from(JSON.stringify({ sha: second.sha, sub: MICHAEL, exp: 9e9 })).toString("base64url");
  assert.equal((await c.send(new Request(`${RESOURCE}/files/${second.sha}?t=${otherBody}.${mac}`))).status, 404);
  assert.equal((await c.send(new Request(`${RESOURCE}/files/${second.sha}?t=${body}.${mac}`))).status, 404, "a ticket names one file");
  assert.equal((await c.send(new Request(`${RESOURCE}/files/${first.sha}`))).status, 404);
  const forged = await signTicket({ sha: first.sha, sub: MICHAEL, exp: 9e9 }, "a guessed key");
  assert.equal((await c.send(new Request(`${RESOURCE}/files/${first.sha}?t=${forged}`))).status, 404);

  assert.equal((await c.send(new Request(url))).status, 200, "the real link still works");
  const errors = (await c.logRows()).filter((r) => r.tool === "download").map((r) => r.error);
  assert.deepEqual(errors, ["expired", "signature", "signature", "file", "malformed", "signature", null]);
});

test("a file whose bytes no longer match its hash isn't served", async () => {
  const c = await connector();
  const msg = await c.add(deck);
  const pdf = msg.attachments.find((a) => a.filename === "Acme Deck.pdf")!;
  await c.index.prepare("UPDATE attachments SET sha256 = ? WHERE id = ?").bind("f".repeat(64), pdf.id).run();
  const ticket = await signTicket({ sha: "f".repeat(64), sub: MICHAEL, exp: Math.floor(NOW / 1000) + 60 }, "test-file-link-key");
  const res = await c.send(new Request(`${RESOURCE}/files/${"f".repeat(64)}?t=${ticket}`));
  assert.equal(res.status, 404);
});

test("without FILE_LINK_KEY, downloads are off", async () => {
  const c = await connector({ fileLinkKey: null });
  assert.equal((await c.send(new Request(`${RESOURCE}/files/${"a".repeat(64)}?t=x.y`))).status, 503);
});

test("filenames and types are made safe to serve", () => {
  assert.equal(safeFilename("../../etc/passwd", "f"), "passwd");
  assert.equal(safeFilename('a"b;c\r\n.pdf', "f"), "abc.pdf");
  assert.equal(safeFilename("...", "fallback"), "fallback");
  assert.equal(safeFilename(null, "fallback"), "fallback");
  assert.equal(safeContentType("text/html"), "application/octet-stream");
  assert.equal(safeContentType("image/svg+xml"), "application/octet-stream");
  assert.equal(safeContentType("application/xhtml+xml"), "application/octet-stream");
  assert.equal(safeContentType("text/xml"), "application/octet-stream");
  assert.equal(safeContentType("application/pdf"), "application/pdf");
  assert.equal(safeContentType("bad type"), "application/octet-stream");
});
