// A read-only IMAP client for Cloudflare Workers (and Node, for tests).
//
// It mirrors kaymail.py: mailboxes open with EXAMINE, bodies fetch with
// BODY.PEEK[], and every command passes assertReadOnly() before it is sent, so
// nothing here can mark, move, or delete mail on the server.

export interface Transport {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): void | Promise<void>;
}

export interface ClientOptions {
  /** How long to wait for the server before giving up on the connection. */
  timeoutMs?: number;
  /** Larger messages are read and dropped (raw: null) to stay inside Worker memory. */
  maxLiteralBytes?: number;
}

export class ImapError extends Error {
  /** Response code from the server, e.g. OVERQUOTA, or TIMEOUT / BYE / READONLY. */
  code: string | undefined;
  /** OK / NO / BAD for a tagged reply, when there was one. */
  status: string | undefined;

  constructor(message: string, options: { code?: string; status?: string } = {}) {
    super(message);
    this.name = "ImapError";
    this.code = options.code;
    this.status = options.status;
  }
}

export class AuthFailed extends ImapError {
  constructor(message: string) {
    super(message, { status: "NO" });
    this.name = "AuthFailed";
  }
}

/** Stands in for a literal that was too large to keep. */
export class Skipped {
  size: number;
  constructor(size: number) {
    this.size = size;
  }
}

export type Token = string | null | Uint8Array | Skipped | Token[];
type Part = string | Uint8Array | Skipped;

export interface Mailbox {
  name: string;
  flags: string[];
}

export interface MailboxStatus {
  exists: number;
  uidvalidity: number;
  uidnext: number | null;
}

export interface FetchedMessage {
  uid: number;
  flags: string[];
  internalDate: string | null;
  size: number | null;
  gmailThreadId: string | null;
  gmailMessageId: string | null;
  gmailLabels: string[];
  /** The message exactly as the server holds it; null if it was over maxLiteralBytes. */
  raw: Uint8Array | null;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Everything this client may ever send. STORE, COPY, MOVE, EXPUNGE, APPEND and
// SELECT (which can clear \Recent) are absent on purpose.
const ALLOWED = /^(?:CAPABILITY|NOOP|LOGOUT|LOGIN |LIST |EXAMINE |UID SEARCH |UID FETCH )/i;
// Fetching BODY[], BINARY[] or RFC822 sets \Seen; only the .PEEK forms are safe.
const MARKS_SEEN = /BODY\[|BINARY\[|\bRFC822(?:\.TEXT|\.HEADER)?(?![.\w])/i;

export function assertReadOnly(command: string): void {
  const verb = command.split(" ", 2).join(" ");
  if (!ALLOWED.test(command)) {
    throw new ImapError(`refusing to send a command that could change the mailbox: ${verb}`, { code: "READONLY" });
  }
  if (/^UID FETCH /i.test(command) && MARKS_SEEN.test(command)) {
    throw new ImapError("refusing a fetch that would mark mail as read; use BODY.PEEK[]", { code: "READONLY" });
  }
}

export function quote(value: string): string {
  if (/[\r\n\0]|[^\x01-\x7f]/.test(value)) {
    throw new ImapError("can't send this value as a quoted string (non-ASCII or a line break)");
  }
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/** 1,2,3,5,8,9 -> "1:3,5,8:9". */
export function formatUidSet(uids: number[]): string {
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    while (i + 1 < sorted.length && sorted[i + 1] === sorted[i] + 1) i++;
    ranges.push(start === sorted[i] ? `${start}` : `${start}:${sorted[i]}`);
  }
  return ranges.join(",");
}

/** Gmail: All Mail only (every other label is a view of it). Elsewhere: every real folder. */
export function mailboxesToSync(boxes: Mailbox[], gmail: boolean): string[] {
  const has = (box: Mailbox, flag: string) => box.flags.some((f) => f.toLowerCase() === flag);
  if (gmail) {
    const allMail = boxes.filter((box) => has(box, "\\all")).map((box) => box.name);
    if (!allMail.length) {
      throw new ImapError('All Mail is hidden from IMAP. Enable "Show in IMAP" for it in Gmail settings > Labels.');
    }
    return allMail;
  }
  const skip = ["\\noselect", "\\trash", "\\junk", "\\drafts"];
  return boxes.filter((box) => !skip.some((flag) => has(box, flag))).map((box) => box.name);
}

/** Split one response (text pieces and literals) into atoms, strings, literals, NIL and lists. */
export function tokenize(parts: Part[]): Token[] {
  const root: Token[] = [];
  const stack: Token[][] = [root];
  for (const part of parts) {
    if (typeof part !== "string") {
      stack[stack.length - 1].push(part);
      continue;
    }
    let i = 0;
    while (i < part.length) {
      const c = part[i];
      const top = stack[stack.length - 1];
      if (c === " ") {
        i++;
      } else if (c === "(") {
        const list: Token[] = [];
        top.push(list);
        stack.push(list);
        i++;
      } else if (c === ")") {
        if (stack.length > 1) stack.pop();
        i++;
      } else if (c === '"') {
        let value = "";
        i++;
        while (i < part.length && part[i] !== '"') {
          if (part[i] === "\\" && i + 1 < part.length) i++;
          value += part[i++];
        }
        i++;
        top.push(value);
      } else {
        // An atom runs to a space or paren, except inside [...] (BODY[...] and response codes).
        let j = i;
        let depth = 0;
        while (j < part.length) {
          const d = part[j];
          if (d === "[") depth++;
          else if (d === "]") depth = Math.max(0, depth - 1);
          else if (depth === 0 && (d === " " || d === "(" || d === ")")) break;
          j++;
        }
        const atom = part.slice(i, j);
        top.push(atom.toUpperCase() === "NIL" ? null : atom);
        i = j;
      }
    }
  }
  return root;
}

function text(token: Token | undefined): string {
  if (typeof token === "string") return token;
  if (token instanceof Uint8Array) return decoder.decode(token);
  return "";
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ImapError(`no response from the server in ${ms / 1000}s`, { code: "TIMEOUT" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Buffers the byte stream so responses can be read as lines and exact-length literals.
class Reader {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #timeoutMs: number;
  #buf = new Uint8Array(64 * 1024);
  #start = 0;
  #end = 0;
  #scan = 0;

  constructor(stream: ReadableStream<Uint8Array>, timeoutMs: number) {
    this.#reader = stream.getReader();
    this.#timeoutMs = timeoutMs;
  }

  async #chunk(): Promise<Uint8Array> {
    const { value, done } = await withTimeout(this.#reader.read(), this.#timeoutMs);
    if (done || !value) throw new ImapError("the server closed the connection", { code: "BYE" });
    return value;
  }

  #append(chunk: Uint8Array): void {
    const held = this.#end - this.#start;
    if (this.#end + chunk.length > this.#buf.length) {
      const needed = held + chunk.length;
      if (needed * 2 <= this.#buf.length) {
        this.#buf.copyWithin(0, this.#start, this.#end);
      } else {
        const bigger = new Uint8Array(needed * 2);
        bigger.set(this.#buf.subarray(this.#start, this.#end));
        this.#buf = bigger;
      }
      this.#scan -= this.#start;
      this.#start = 0;
      this.#end = held;
    }
    this.#buf.set(chunk, this.#end);
    this.#end += chunk.length;
  }

  /** The next line, without its CRLF. */
  async line(): Promise<Uint8Array> {
    for (;;) {
      for (let i = Math.max(this.#scan, this.#start); i + 1 < this.#end; i++) {
        if (this.#buf[i] === 13 && this.#buf[i + 1] === 10) {
          const line = this.#buf.slice(this.#start, i);
          this.#start = this.#scan = i + 2;
          return line;
        }
      }
      this.#scan = Math.max(this.#start, this.#end - 1);
      this.#append(await this.#chunk());
    }
  }

  /** Exactly n bytes, read into one allocation so a large message isn't copied twice. */
  async bytes(n: number): Promise<Uint8Array> {
    const out = new Uint8Array(n);
    await this.#consume(n, (piece, offset) => out.set(piece, offset));
    return out;
  }

  /** Read and drop n bytes. */
  async skip(n: number): Promise<void> {
    await this.#consume(n, () => {});
  }

  async #consume(n: number, sink: (piece: Uint8Array, offset: number) => void): Promise<void> {
    const held = Math.min(n, this.#end - this.#start);
    sink(this.#buf.subarray(this.#start, this.#start + held), 0);
    this.#start = this.#scan = this.#start + held;
    let got = held;
    while (got < n) {
      const chunk = await this.#chunk();
      const used = Math.min(chunk.length, n - got);
      sink(chunk.subarray(0, used), got);
      got += used;
      if (used < chunk.length) this.#append(chunk.subarray(used));
    }
  }

  cancel(): void {
    this.#reader.cancel().catch(() => {});
  }
}

export class ImapClient {
  #transport: Transport;
  #reader: Reader;
  #writer: WritableStreamDefaultWriter<Uint8Array>;
  #maxLiteral: number;
  #tag = 0;
  capabilities = new Set<string>();

  private constructor(transport: Transport, options: ClientOptions) {
    this.#transport = transport;
    this.#reader = new Reader(transport.readable, options.timeoutMs ?? 120_000);
    this.#writer = transport.writable.getWriter();
    this.#maxLiteral = options.maxLiteralBytes ?? 48 * 1024 * 1024;
  }

  /** Read the server greeting. Call login() next. */
  static async open(transport: Transport, options: ClientOptions = {}): Promise<ImapClient> {
    const client = new ImapClient(transport, options);
    try {
      const greeting = text((await client.#response())[0]);
      if (!/^\* (OK|PREAUTH)\b/i.test(greeting)) {
        throw new ImapError(`unexpected greeting: ${greeting.slice(0, 200)}`);
      }
    } catch (err) {
      client.close();
      throw err;
    }
    return client;
  }

  get isGmail(): boolean {
    return this.capabilities.has("X-GM-EXT-1");
  }

  async login(user: string, password: string): Promise<void> {
    try {
      await this.#command(`LOGIN ${quote(user)} ${quote(password)}`);
    } catch (err) {
      if (err instanceof ImapError && err.status === "NO") throw new AuthFailed(`${user}: login failed: ${err.message}`);
      throw err;
    }
    await this.capability();
  }

  async capability(): Promise<Set<string>> {
    const found = new Set<string>();
    for (const unit of await this.#command("CAPABILITY")) {
      const line = text(unit[0]);
      if (/^\* CAPABILITY /i.test(line)) {
        for (const cap of line.slice(13).split(" ")) if (cap) found.add(cap.toUpperCase());
      }
    }
    this.capabilities = found;
    return found;
  }

  async list(): Promise<Mailbox[]> {
    const boxes: Mailbox[] = [];
    for (const unit of await this.#command('LIST "" "*"')) {
      const [star, verb, flags, , name] = tokenize(unit);
      if (star !== "*" || text(verb).toUpperCase() !== "LIST" || !Array.isArray(flags)) continue;
      boxes.push({ name: text(name), flags: flags.map(text) });
    }
    return boxes;
  }

  /** Open a mailbox read-only. */
  async examine(mailbox: string): Promise<MailboxStatus> {
    const status: MailboxStatus = { exists: 0, uidvalidity: 0, uidnext: null };
    for (const unit of await this.#command(`EXAMINE ${quote(mailbox)}`)) {
      const line = text(unit[0]);
      const exists = /^\* (\d+) EXISTS/i.exec(line);
      const validity = /\[UIDVALIDITY (\d+)\]/i.exec(line);
      const next = /\[UIDNEXT (\d+)\]/i.exec(line);
      if (exists) status.exists = Number(exists[1]);
      if (validity) status.uidvalidity = Number(validity[1]);
      if (next) status.uidnext = Number(next[1]);
    }
    if (!status.uidvalidity) throw new ImapError(`${mailbox}: the server sent no UIDVALIDITY`);
    return status;
  }

  /** UIDs in the open mailbox, ascending. With `from`, only UIDs >= from. */
  async uidSearch(from?: number): Promise<number[]> {
    const criteria = from === undefined ? "ALL" : `UID ${from}:*`;
    const uids: number[] = [];
    for (const unit of await this.#command(`UID SEARCH ${criteria}`)) {
      const line = text(unit[0]);
      if (!/^\* SEARCH\b/i.test(line)) continue;
      for (const n of line.slice(8).split(" ")) if (n) uids.push(Number(n));
    }
    // `n:*` always matches the newest message, even when it's below n.
    return uids.filter((uid) => from === undefined || uid >= from).sort((a, b) => a - b);
  }

  /**
   * Fetch whole messages by UID. onMessage runs as each one arrives, so a caller
   * can store it before the next is read; only one message is held at a time.
   */
  async uidFetch(uids: number[], onMessage: (message: FetchedMessage) => void | Promise<void>): Promise<void> {
    if (!uids.length) return;
    let attrs = "UID FLAGS INTERNALDATE RFC822.SIZE";
    if (this.isGmail) attrs += " X-GM-THRID X-GM-MSGID X-GM-LABELS";
    await this.#command(`UID FETCH ${formatUidSet(uids)} (${attrs} BODY.PEEK[])`, async (unit) => {
      const message = parseFetch(unit);
      if (message) await onMessage(message);
    });
  }

  async logout(): Promise<void> {
    try {
      await this.#command("LOGOUT");
    } catch {
      // Already gone is as good as logged out.
    } finally {
      this.close();
    }
  }

  close(): void {
    this.#reader.cancel();
    this.#writer.releaseLock();
    Promise.resolve()
      .then(() => this.#transport.close())
      .catch(() => {});
  }

  // One response: text up to CRLF, with any {n} literals read in by length.
  async #response(): Promise<Part[]> {
    const parts: Part[] = [];
    for (;;) {
      const line = decoder.decode(await this.#reader.line());
      const literal = /\{(\d+)\+?\}$/.exec(line);
      if (!literal) {
        parts.push(line);
        return parts;
      }
      parts.push(line.slice(0, literal.index));
      const size = Number(literal[1]);
      if (size > this.#maxLiteral) {
        await this.#reader.skip(size);
        parts.push(new Skipped(size));
      } else {
        parts.push(await this.#reader.bytes(size));
      }
    }
  }

  // Send one command and read until its tagged reply. Untagged responses go to
  // onUntagged if given, else are returned.
  async #command(command: string, onUntagged?: (unit: Part[]) => void | Promise<void>): Promise<Part[][]> {
    assertReadOnly(command);
    const tag = `K${++this.#tag}`;
    await this.#writer.write(encoder.encode(`${tag} ${command}\r\n`));
    const untagged: Part[][] = [];
    for (;;) {
      const unit = await this.#response();
      const head = text(unit[0]);
      if (head.startsWith(`${tag} `)) {
        const rest = head.slice(tag.length + 1);
        const status = rest.split(" ", 1)[0].toUpperCase();
        if (status === "OK") return untagged;
        const message = rest.slice(status.length + 1);
        const code = /^\[([A-Z0-9-]+)/i.exec(message)?.[1]?.toUpperCase();
        throw new ImapError(message || status, { code, status });
      }
      if (/^\* BYE\b/i.test(head) && !/^LOGOUT$/i.test(command)) {
        const code = /\[([A-Z0-9-]+)/i.exec(head)?.[1]?.toUpperCase() ?? "BYE";
        throw new ImapError(`the server closed the connection: ${head.slice(6)}`, { code });
      }
      if (head.startsWith("+")) throw new ImapError("the server asked for input this client never sends");
      if (onUntagged) await onUntagged(unit);
      else untagged.push(unit);
    }
  }
}

function parseFetch(unit: Part[]): FetchedMessage | null {
  const [star, , verb, attrs] = tokenize(unit);
  if (star !== "*" || text(verb).toUpperCase() !== "FETCH" || !Array.isArray(attrs)) return null;
  const message: FetchedMessage = {
    uid: 0, flags: [], internalDate: null, size: null,
    gmailThreadId: null, gmailMessageId: null, gmailLabels: [], raw: null,
  };
  let hasBody = false;
  for (let i = 0; i + 1 < attrs.length; i += 2) {
    const key = text(attrs[i]).toUpperCase();
    const value = attrs[i + 1];
    if (key === "UID") message.uid = Number(text(value));
    else if (key === "FLAGS" && Array.isArray(value)) message.flags = value.map(text);
    else if (key === "INTERNALDATE") message.internalDate = text(value) || null;
    else if (key === "RFC822.SIZE") message.size = Number(text(value));
    else if (key === "X-GM-THRID") message.gmailThreadId = text(value) || null;
    else if (key === "X-GM-MSGID") message.gmailMessageId = text(value) || null;
    else if (key === "X-GM-LABELS" && Array.isArray(value)) message.gmailLabels = value.map(text);
    else if (key === "BODY[]") {
      hasBody = true;
      if (value instanceof Uint8Array) message.raw = value;
      else if (typeof value === "string") message.raw = encoder.encode(value);
      else if (value instanceof Skipped) message.size ??= value.size;
    }
  }
  return message.uid && hasBody ? message : null;
}
