// An in-memory IMAP server shaped like Gmail, for tests. It records every
// command it receives and can split its replies into tiny chunks.
import type { Transport } from "../src/imap.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface FakeOptions {
  password?: string;
  mail?: Map<number, Uint8Array>;
  /** Reply in pieces of this many bytes, to exercise buffering. */
  chunk?: number;
  gmail?: boolean;
  overquota?: boolean;
}

export interface Fake {
  transport: Transport;
  commands: string[];
}

function parseUidSet(set: string): number[] {
  const uids: number[] = [];
  for (const part of set.split(",")) {
    const [a, b] = part.split(":").map(Number);
    for (let u = a; u <= (b ?? a); u++) uids.push(u);
  }
  return uids;
}

export function fakeGmail(options: FakeOptions = {}): Fake {
  const { password = "app-password", mail = new Map(), chunk = 4096, gmail = true, overquota = false } = options;
  const toServer = new TransformStream<Uint8Array, Uint8Array>();
  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  const commands: string[] = [];
  const out = toClient.writable.getWriter();

  const send = async (data: string | Uint8Array) => {
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    for (let i = 0; i < bytes.length; i += chunk) await out.write(bytes.slice(i, i + chunk));
  };

  const labels = 'X-GM-LABELS ("\\\\Inbox" Deals {9}\r\nBig Deals)';
  const date = 'INTERNALDATE "05-Jan-2024 10:00:00 +0100"';

  async function handle(line: string): Promise<boolean> {
    const [tag, ...words] = line.split(" ");
    const rest = words.join(" ");
    commands.push(rest);
    const verb = rest.toUpperCase();
    if (verb.startsWith("CAPABILITY")) {
      await send(`* CAPABILITY IMAP4rev1 UIDPLUS${gmail ? " X-GM-EXT-1" : ""}\r\n`);
    } else if (verb.startsWith("LOGIN")) {
      if (!rest.includes(`"${password}"`)) {
        await send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n`);
        return true;
      }
    } else if (verb.startsWith("LIST")) {
      await send('* LIST (\\HasNoChildren) "/" "INBOX"\r\n');
      await send('* LIST (\\HasNoChildren) "/" {12}\r\nOdd "Name" )\r\n');
      await send('* LIST (\\HasChildren \\Noselect) "/" "[Gmail]"\r\n');
      await send('* LIST (\\All \\HasNoChildren) "/" "[Gmail]/All Mail"\r\n');
      await send('* LIST (\\HasNoChildren \\Trash) "/" "[Gmail]/Trash"\r\n');
    } else if (verb.startsWith("EXAMINE")) {
      const next = Math.max(0, ...mail.keys()) + 1;
      await send(`* FLAGS (\\Answered \\Seen)\r\n* ${mail.size} EXISTS\r\n* 0 RECENT\r\n`);
      await send(`* OK [UIDVALIDITY 7] UIDs valid.\r\n* OK [UIDNEXT ${next}] Predicted next UID.\r\n`);
      await send(`${tag} OK [READ-ONLY] [Gmail]/All Mail selected. (Success)\r\n`);
      return true;
    } else if (verb.startsWith("UID SEARCH")) {
      const floor = /UID (\d+):\*/.exec(rest);
      let uids = [...mail.keys()].sort((a, b) => a - b);
      if (floor) uids = uids.filter((u) => u >= Number(floor[1])).length ? uids.filter((u) => u >= Number(floor[1])) : uids.slice(-1);
      await send(`* SEARCH ${uids.join(" ")}\r\n`);
    } else if (verb.startsWith("UID FETCH")) {
      if (overquota) {
        await send(`${tag} NO [OVERQUOTA] Account exceeded command or bandwidth limits. (Failure)\r\n`);
        return true;
      }
      await send("* 99 EXISTS\r\n"); // unsolicited; must be ignored
      for (const uid of parseUidSet(words[2])) {
        const raw = mail.get(uid);
        if (!raw) continue;
        if (uid % 2) {
          // attributes before the literal
          await send(`* ${uid} FETCH (UID ${uid} FLAGS (\\Seen) ${date} RFC822.SIZE ${raw.length} X-GM-THRID 99 X-GM-MSGID 1${uid} ${labels} BODY[] {${raw.length}}\r\n`);
          await send(raw);
          await send(")\r\n");
        } else {
          // attributes after it
          await send(`* ${uid} FETCH (BODY[] {${raw.length}}\r\n`);
          await send(raw);
          await send(` UID ${uid} FLAGS () ${date} RFC822.SIZE ${raw.length} X-GM-THRID 99 X-GM-MSGID 1${uid} ${labels})\r\n`);
        }
      }
    } else if (verb.startsWith("LOGOUT")) {
      await send(`* BYE LOGOUT Requested\r\n${tag} OK 73 good day (Success)\r\n`);
      await out.close();
      return false;
    }
    await send(`${tag} OK Success\r\n`);
    return true;
  }

  (async () => {
    await send("* OK Gimap ready for requests\r\n");
    const reader = toServer.readable.getReader();
    let pending = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      pending += decoder.decode(value, { stream: true });
      let end;
      while ((end = pending.indexOf("\r\n")) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (!(await handle(line))) return;
      }
    }
  })().catch(() => {});

  return {
    transport: { readable: toClient.readable, writable: toServer.writable, close: () => {} },
    commands,
  };
}
