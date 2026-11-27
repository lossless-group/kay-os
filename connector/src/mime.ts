// Reading an original .eml with postal-mime, the parser the sync Worker indexes with (same pinned
// version), so part numbers and hashes agree with the index:
//   - message_attachments.part_index is the position in postal-mime's attachment list;
//   - attachments.sha256 is of postal-mime's decoded bytes (calendar parts come back as UTF-8 text).
// htmlToText and bytesOf are copied from sync-worker/src/indexer.ts.
import PostalMime, { type Attachment, type Email } from "postal-mime";

export const MAX_BODY_CHARS = 30_000; // as mail/kaymcp.py
/** A Worker isolate has 128 MB; postal-mime holds the message and its decoded parts at once. */
export const MAX_EML_BYTES = 50 * 1024 * 1024;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** kaymail.html_to_text: drop scripts, styles and tags, decode entities, squeeze whitespace. */
export function htmlToText(markup: string): string {
  const text = markup
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
      if (ref[0] !== "#") return ENTITIES[ref.toLowerCase()] ?? whole;
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    });
  return text.replace(/\s+/g, " ").trim();
}

export function bytesOf(content: Attachment["content"]): Uint8Array {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  return new TextEncoder().encode(content);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export const parse = (raw: ArrayBuffer | Uint8Array): Promise<Email> =>
  PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });

/** The body as the index makes it: plain text, else the HTML made text. */
export function bodyText(email: Email): string {
  return email.text ?? htmlToText(email.html ?? "");
}

export function cutBody(body: string, max = MAX_BODY_CHARS): string {
  if (body.length <= max) return body;
  const end = /[\ud800-\udbff]/.test(body[max - 1]) ? max - 1 : max;
  return body.slice(0, end) + `\n[... cut at ${max} characters]`;
}

/** The decoded bytes of part `index`, if it is there and hashes to `sha`. */
export async function partBytes(email: Email, index: number, sha: string): Promise<Uint8Array | null> {
  const part = email.attachments[index];
  if (!part) return null;
  const data = bytesOf(part.content);
  return (await sha256Hex(data)) === sha ? data : null;
}
