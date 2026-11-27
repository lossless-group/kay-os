// Download links for attachments. Claude's file transfer feature isn't open to custom connectors,
// so get_attachment hands back a link the Worker serves itself:
//   GET /files/<sha256>?t=<ticket>
// The ticket is base64url(payload).base64url(HMAC-SHA256(payload)) keyed by FILE_LINK_KEY, with
// payload {sha, sub, exp}. It names one file and lives 15 minutes. The file is decoded from an
// original .eml on request and checked against its SHA-256; nothing is cached or written.
import { base64urlDecode, base64urlEncode } from "./auth.ts";
import { MAX_EML_BYTES, parse, partBytes } from "./mime.ts";
import type { ReadOnlyIndex, ReadOnlyMail } from "./store.ts";

export const LINK_TTL_SECONDS = 15 * 60;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export interface TicketPayload {
  sha: string;
  sub: string;
  exp: number;
}

export async function signTicket(payload: TicketPayload, secret: string): Promise<string> {
  const body = base64urlEncode(encoder.encode(JSON.stringify(payload)));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body)));
  return `${body}.${base64urlEncode(mac)}`;
}

export type TicketCheck = { ok: true; payload: TicketPayload } | { ok: false; reason: "malformed" | "signature" | "expired" | "file" };

export async function verifyTicket(ticket: string, sha: string, secret: string, nowSeconds: number): Promise<TicketCheck> {
  const [body, mac, extra] = ticket.split(".");
  if (!body || !mac || extra !== undefined) return { ok: false, reason: "malformed" };
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = base64urlDecode(mac);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  // crypto.subtle.verify compares in constant time.
  if (!(await crypto.subtle.verify("HMAC", await hmacKey(secret), sig, encoder.encode(body)))) {
    return { ok: false, reason: "signature" };
  }
  let payload: TicketPayload;
  try {
    payload = JSON.parse(decoder.decode(base64urlDecode(body)));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) return { ok: false, reason: "expired" };
  if (payload.sha !== sha) return { ok: false, reason: "file" };
  return { ok: true, payload };
}

/** kaymail.safe_filename: a sender-chosen filename, reduced to one harmless path component. */
export function safeFilename(filename: string | null, fallback: string): string {
  const name = (filename ?? "").replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
  // Also drops quotes and semicolons, which would otherwise need escaping in Content-Disposition.
  const clean = name.replace(/[\x00-\x1f\x7f/"';]/g, "").replace(/^\.+/, "").trim().slice(0, 150);
  return clean || fallback;
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// Types a browser would render or run in this origin go out as plain bytes.
const ACTIVE = /^(text\/html|application\/xhtml|image\/svg|text\/xml|application\/xml|[a-z]+\/[a-z.+-]*\+xml|text\/javascript|application\/javascript)/i;

export function safeContentType(contentType: string | null): string {
  const type = (contentType ?? "").trim().toLowerCase();
  if (!type || ACTIVE.test(type) || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type)) return "application/octet-stream";
  return type;
}

const textResponse = (status: number, text: string) =>
  new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

export interface FileResult {
  response: Response;
  /** For the call log: never the filename. */
  outcome: { ok: boolean; error?: string; bytes?: number; sub?: string };
}

export async function serveFile(
  sha: string,
  ticket: string | null,
  deps: { index: ReadOnlyIndex; mail: ReadOnlyMail; secret: string | undefined; nowSeconds: number },
): Promise<FileResult> {
  if (!deps.secret) return { response: textResponse(503, "Downloads aren't set up on this connector."), outcome: { ok: false, error: "no-key" } };
  if (!/^[0-9a-f]{64}$/.test(sha) || !ticket) return { response: textResponse(404, "Not found."), outcome: { ok: false, error: "malformed" } };
  const check = await verifyTicket(ticket, sha, deps.secret, deps.nowSeconds);
  if (!check.ok) {
    const text = check.reason === "expired" ? "This link has expired. Ask Claude for a new one." : "Not found.";
    return { response: textResponse(check.reason === "expired" ? 410 : 404, text), outcome: { ok: false, error: check.reason } };
  }
  const sub = check.payload.sub;
  const att = await deps.index.first<{ id: number; content_type: string | null }>(
    "SELECT id, content_type FROM attachments WHERE sha256 = ?", sha);
  if (!att) return { response: textResponse(404, "Not found."), outcome: { ok: false, error: "no-attachment", sub } };

  const copies = await deps.index.all<{ part_index: number; account: string; sha256: string; filename: string | null }>(
    `SELECT ma.part_index, m.account, m.sha256, ma.filename FROM message_attachments ma
     JOIN messages m ON m.id = ma.message_id WHERE ma.attachment_id = ? ORDER BY m.is_primary DESC, m.date`, att.id);
  let tooBig = false;
  for (const copy of copies) {
    try {
      const size = await deps.mail.size(copy.account, copy.sha256);
      if (size === null) continue;
      if (size > MAX_EML_BYTES) {
        tooBig = true;
        continue;
      }
      const raw = await deps.mail.get(copy.account, copy.sha256);
      if (!raw) continue;
      const data = await partBytes(await parse(raw), copy.part_index, sha);
      if (!data) continue;
      const filename = safeFilename(copies.find((c) => c.filename)?.filename ?? null, `attachment-${att.id}`);
      return {
        response: new Response(data as Uint8Array<ArrayBuffer>, {
          headers: {
            "content-type": safeContentType(att.content_type),
            "content-disposition": contentDisposition(filename),
            "content-length": String(data.length),
            "x-content-type-options": "nosniff",
            "content-security-policy": "sandbox",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          },
        }),
        outcome: { ok: true, bytes: data.length, sub },
      };
    } catch {
      // A copy that won't parse: try the next one.
    }
  }
  const text = tooBig
    ? "This file's email is too large to open here (over 50 MB). Use kaymail on the laptop."
    : "The file isn't in any stored original.";
  return { response: textResponse(tooBig ? 413 : 404, text), outcome: { ok: false, error: tooBig ? "too-big" : "not-in-originals", sub } };
}
