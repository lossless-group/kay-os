// Run the IMAP client against a real server from Node, read-only.
// Prints counts, UIDs and sizes, never subjects or contents.
//   IMAP_USER=you@gmail.com IMAP_PASSWORD=... node scripts/smoke.ts
import { once } from "node:events";
import { Duplex } from "node:stream";
import tls from "node:tls";
import { ImapClient, mailboxesToSync, type Transport } from "../src/imap.ts";

const host = process.env.IMAP_HOST ?? "imap.gmail.com";
const user = process.env.IMAP_USER;
const password = process.env.IMAP_PASSWORD;
if (!user || !password) throw new Error("set IMAP_USER and IMAP_PASSWORD");

const socket = tls.connect({ host, port: 993, servername: host });
await once(socket, "secureConnect");
const { readable, writable } = Duplex.toWeb(socket);
const transport: Transport = {
  readable: readable as ReadableStream<Uint8Array>,
  writable: writable as WritableStream<Uint8Array>,
  close: () => void socket.destroy(),
};

const client = await ImapClient.open(transport, { timeoutMs: 60_000 });
await client.login(user, password);
console.log(`logged in; gmail=${client.isGmail}; ${client.capabilities.size} capabilities`);

const boxes = await client.list();
const targets = mailboxesToSync(boxes, client.isGmail);
console.log(`${boxes.length} mailboxes; would sync: ${targets.join(", ")}`);

const status = await client.examine(targets[0]);
console.log(`examine: exists=${status.exists} uidvalidity=${status.uidvalidity} uidnext=${status.uidnext}`);

const recent = await client.uidSearch(Math.max(1, (status.uidnext ?? 1) - 200));
const newest = recent.slice(-2);
console.log(`search from uidnext-200: ${recent.length} uids; fetching ${newest.join(", ")}`);

const started = Date.now();
await client.uidFetch(newest, (m) => {
  console.log(
    `  uid=${m.uid} raw=${m.raw?.length ?? "skipped"}B size=${m.size} matches=${m.raw?.length === m.size}` +
      ` thread=${m.gmailThreadId ? "yes" : "no"} labels=${m.gmailLabels.length} flags=${m.flags.length}` +
      ` date=${m.internalDate ? "yes" : "no"}`,
  );
});
console.log(`fetch took ${Date.now() - started}ms`);
await client.logout();
