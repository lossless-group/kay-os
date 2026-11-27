// Writes one stored message into the D1 index: its messages row, its full-text row, and its
// attachments, the way kaymail.py's record_message and record_attachments do on the laptop.
//
// Known differences from the laptop, all from parsing with postal-mime instead of Python's email:
//   - Attachments are postal-mime's list, kept only where kaymail's attachment_parts would keep
//     them. A text/plain or text/html part with a filename but no "attachment" disposition is
//     body text to postal-mime, so it isn't listed here; the laptop lists it.
//   - part_index is the position in postal-mime's attachment list, not in the MIME walk. It only
//     has to be stable for the same bytes and the same (pinned) postal-mime version.
//   - postal-mime hands calendar parts (text/calendar, application/ics) back as UTF-8 with \n
//     line ends, so their sha256 and size are of that text, not the bytes on the wire.
//   - Body text: postal-mime's plain text (all plain parts joined), else the HTML made text by a
//     port of kaymail.html_to_text. Laptop labels are IMAP's raw list; here each label is quoted.
import PostalMime, { decodeWords, type Attachment, type Email } from "postal-mime";
import type { Db, DbStatement } from "./db.ts";
import { ATTACHMENT_HINT, NOISE_REPEATS, attachmentKind, isNoise, sniffType } from "./rules.ts";

export const MAX_BODY_CHARS = 20_000; // laptop: 200,000; see migrations/0001_index.sql

export interface IndexInput {
  account: string;
  /** Null for mail the laptop fetched: R2 has no Gmail UID for it. */
  mailbox: string | null;
  uidvalidity: number | null;
  uid: number | null;
  sha256: string;
  raw: Uint8Array;
  /** IMAP INTERNALDATE, e.g. "05-Jan-2024 10:00:00 +0100". */
  internalDate: string | null;
  flags: string[] | null;
  labels: string[] | null;
  threadId: string | null;
}

export type IndexOutcome =
  | { status: "indexed"; primary: boolean; attachments: number }
  | { status: "exists" }
  | { status: "error" };

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** kaymail.to_utc: INTERNALDATE, else the Date header, as UTC ISO 8601 to the second. */
export function toUtc(internalDate: string | null, dateHeader: string | null): string | null {
  let ms = NaN;
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(internalDate?.trim() ?? "");
  const month = m ? MONTHS.indexOf(m[2].toLowerCase()) : -1;
  if (m && month >= 0) {
    const offset = (m[7] === "-" ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9]));
    ms = Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])) - offset * 60_000;
  } else if (dateHeader) {
    ms = Date.parse(dateHeader);
  }
  return Number.isNaN(ms) ? null : new Date(ms).toISOString().slice(0, 19) + "+00:00";
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** kaymail.html_to_text: drop scripts, styles and tags, decode entities, squeeze whitespace. */
export function htmlToText(markup: string): string {
  const text = markup
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
      if (ref[0] !== "#") return ENTITIES[ref.toLowerCase()] ?? whole; // the common ones only
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    });
  return text.replace(/\s+/g, " ").trim();
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = /[\ud800-\udbff]/.test(text[max - 1]) ? max - 1 : max; // don't split a surrogate pair
  return text.slice(0, end);
}

const quoteLabel = (label: string) => `"${label.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

interface Part {
  index: number;
  filename: string | null;
  declared: string;
  disposition: string | null;
  contentId: string | null;
  data: Uint8Array;
}

function bytesOf(content: Attachment["content"]): Uint8Array {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  return new TextEncoder().encode(content);
}

/** postal-mime's attachments, kept where kaymail.attachment_parts would keep them. */
function attachmentParts(email: Email, raw: Uint8Array): Part[] {
  if (!ATTACHMENT_HINT.test(new TextDecoder().decode(raw))) return [];
  const parts: Part[] = [];
  email.attachments.forEach((a, index) => {
    const declared = a.mimeType;
    const contentId = a.contentId?.trim() || null;
    if (!(a.disposition === "attachment" || a.filename || declared === "text/calendar"
      || (contentId && !declared.startsWith("text/")))) return;
    const data = bytesOf(a.content);
    if (data.length) parts.push({ index, filename: a.filename, declared, disposition: a.disposition, contentId, data });
  });
  return parts;
}

function header(email: Email | null, key: string): string {
  const value = email?.headers.find((h) => h.key === key)?.value ?? "";
  try {
    return decodeWords(value);
  } catch {
    return value;
  }
}

/** The row kaymail.parse_message would give these bytes; an unparseable message keeps its size. */
function messageFields(email: Email | null, parts: Part[]) {
  const body = email ? (email.text ?? htmlToText(email.html ?? "")) : "";
  return {
    message_id: email?.headers.find((h) => h.key === "message-id")?.value.trim() ?? "",
    from_addr: header(email, "from"),
    to_addr: [header(email, "to"), header(email, "cc")].filter(Boolean).join(", "),
    subject: header(email, "subject"),
    date_header: email?.headers.find((h) => h.key === "date")?.value ?? null,
    attachments: parts.map((p) => p.filename).filter(Boolean).join(", "),
    body: cut(body, MAX_BODY_CHARS),
  };
}

// Statements in one batch can't read each other's RETURNING, so rows written earlier in the batch
// are found again by their natural keys. Only one primary row per (account, sha256) can exist:
// is_primary is 1 only when no row with those bytes was there, and each account's writes come
// from its one Durable Object, one at a time.
const PRIMARY_ID = "(SELECT id FROM messages WHERE account = ? AND sha256 = ? AND is_primary = 1)";

function scanStatement(db: Db, account: string, sha: string, status: "ok" | "error"): DbStatement {
  return db.prepare(`INSERT OR REPLACE INTO attachment_scans (message_id, status)
    SELECT id, ? FROM messages WHERE account = ? AND sha256 = ? AND is_primary = 1`).bind(status, account, sha);
}

/**
 * Index one message, all in one batch. Safe to rerun: a message already in the index is left
 * alone. Never throws: a failure is logged by account and sha and, if the message row got
 * written, recorded as attachment_scans 'error'.
 */
export async function indexMessage(db: Db, input: IndexInput): Promise<IndexOutcome> {
  const { account, sha256: sha } = input;
  let primary = false;
  try {
    // Mail with a UID is unique by it; mail without one by its bytes (see the migration). `=`, not
    // `IS`: a NULL UID must not match every other UID-less row.
    const known = await db.prepare(`SELECT
        EXISTS (SELECT 1 FROM messages WHERE account = ? AND mailbox = ? AND uidvalidity = ? AND uid = ?) AS indexed,
        EXISTS (SELECT 1 FROM messages WHERE account = ? AND sha256 = ?) AS seen`)
      .bind(account, input.mailbox, input.uidvalidity, input.uid, account, sha).first<{ indexed: number; seen: number }>();
    if (known?.indexed || (input.uid === null && known?.seen)) return { status: "exists" };
    primary = !known?.seen;

    let email: Email | null = null;
    let parts: Part[] | null = null;
    try {
      email = await PostalMime.parse(input.raw, { attachmentEncoding: "arraybuffer" });
      parts = attachmentParts(email, input.raw);
    } catch (err) {
      console.log(`index ${account} ${sha}: could not parse (${(err as Error)?.name ?? "error"})`);
    }
    const fields = messageFields(email, parts ?? []);
    const date = toUtc(input.internalDate, fields.date_header);

    const insertMessage = db.prepare(`INSERT OR IGNORE INTO messages (account, mailbox, uidvalidity, uid, sha256,
        is_primary, message_id, thread_id, date, from_addr, to_addr, subject, labels, flags, size, attachments, body)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      account, input.mailbox, input.uidvalidity, input.uid, sha, primary ? 1 : 0,
      fields.message_id, input.threadId, date, fields.from_addr, fields.to_addr, fields.subject,
      input.labels?.map(quoteLabel).join(" ") ?? null, input.flags?.join(" ") ?? null,
      input.raw.length, fields.attachments, fields.body,
    );
    // As on the laptop, only the first copy of some bytes is searchable and has attachments.
    if (!primary) {
      await db.batch([insertMessage]);
      return { status: "indexed", primary, attachments: 0 };
    }
    const head = [
      insertMessage,
      db.prepare(`INSERT INTO messages_fts (rowid, subject, from_addr, to_addr, body, attachments)
        SELECT id, subject, from_addr, to_addr, body, attachments FROM messages
        WHERE account = ? AND sha256 = ? AND is_primary = 1`).bind(account, sha),
    ];

    const attachments: DbStatement[] = [];
    for (const p of parts ?? []) {
      const partSha = await sha256Hex(p.data);
      const contentType = sniffType(p.data, p.declared, p.filename);
      const kind = attachmentKind(contentType, p.filename);
      const noise = isNoise(kind, p.data.length, p.disposition, p.contentId);
      attachments.push(
        // kaymail.record_attachments' upsert: noise is sticky, first_seen keeps the earliest date.
        db.prepare(`INSERT INTO attachments (sha256, content_type, size, kind, is_noise, first_seen) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (sha256) DO UPDATE SET
            is_noise = max(is_noise, excluded.is_noise),
            first_seen = CASE WHEN first_seen IS NULL OR excluded.first_seen < first_seen
                              THEN excluded.first_seen ELSE first_seen END`)
          .bind(partSha, contentType, p.data.length, kind, noise ? 1 : 0, date),
        db.prepare(`INSERT OR IGNORE INTO message_attachments
            (message_id, part_index, attachment_id, filename, declared_type, disposition, content_id)
          VALUES (${PRIMARY_ID}, ?, (SELECT id FROM attachments WHERE sha256 = ?), ?, ?, ?, ?)`)
          .bind(account, sha, p.index, partSha, p.filename, p.declared, p.disposition, p.contentId),
      );
    }

    if (parts) {
      try {
        await db.batch([...head, ...attachments, scanStatement(db, account, sha, "ok")]);
        return { status: "indexed", primary, attachments: parts.length };
      } catch (err) {
        console.log(`index ${account} ${sha}: attachments failed (${(err as Error)?.name ?? "error"}); indexing the message alone`);
      }
    }
    // The message is still worth finding; its attachments wait for a later scan.
    await db.batch([...head, scanStatement(db, account, sha, "error")]);
    return { status: "error" };
  } catch (err) {
    console.log(`index ${account} ${sha}: failed (${(err as Error)?.name ?? "error"})`);
    try {
      // Only this message's own row: a duplicate's scan would land on the first copy's.
      if (primary) await scanStatement(db, account, sha, "error").run();
    } catch {
      // The index is unreachable; the .eml is safe in R2 and C3's backfill will find it.
    }
    return { status: "error" };
  }
}

/** kaymail.refresh_noise: an image on dozens of messages is a logo, whatever its size. Once per pass. */
export async function refreshNoise(db: Db): Promise<void> {
  await db.prepare(`UPDATE attachments SET is_noise = 1 WHERE kind = 'image' AND is_noise = 0 AND id IN (
      SELECT attachment_id FROM message_attachments GROUP BY attachment_id
      HAVING count(DISTINCT message_id) > ?)`).bind(NOISE_REPEATS).run();
}
