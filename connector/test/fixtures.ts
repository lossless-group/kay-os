// A synthetic archive for the connector's tests: an index on node:sqlite (sync-worker's
// migrations), a memory bucket holding the .eml files, a test Ed25519 key standing in for
// id.didi.sh's, and a Deps wired to all three. Messages are indexed by a small stand-in for
// sync-worker/src/indexer.ts that keeps postal-mime's part numbering, which is what the
// connector's downloads depend on.
import { readFileSync } from "node:fs";
import { type Deps, handle } from "../src/app.ts";
import { base64urlEncode, JwksCache, type Jwk } from "../src/auth.ts";
import type { Db } from "../src/db.ts";
import { type GoogleConfig, type HttpFetch, TOKEN_URL } from "../src/google.ts";
import { bodyText, bytesOf, parse, sha256Hex } from "../src/mime.ts";
import type { ReadBucket } from "../src/store.ts";
import { LOG_MIGRATIONS, sqliteDb } from "./sqlite-db.ts";

export const ISSUER = "https://id.didi.sh";
export const RESOURCE = "https://mcp.kay-os.lol";
export const MICHAEL = "didi_michael";
export const ACCOUNT = "me@example.com";
export const NOW = Date.parse("2026-11-27T12:00:00Z");

const encoder = new TextEncoder();

// test_kaymail.deck_message(), written by mail/testdata/make_testdata.py.
export const deck = new Uint8Array(readFileSync(new URL("../../sync-worker/test/fixtures/deck.eml", import.meta.url)));

export function eml(headers: Record<string, string>, body: string): Uint8Array {
  const head = Object.entries({ "MIME-Version": "1.0", "Content-Type": "text/plain; charset=utf-8", ...headers })
    .map(([k, v]) => `${k}: ${v}`).join("\r\n");
  return encoder.encode(`${head}\r\n\r\n${body}`);
}

export function memoryBucket() {
  const objects = new Map<string, Uint8Array>();
  const bucket: ReadBucket & { put(key: string, value: Uint8Array): void } = {
    async get(key) {
      const v = objects.get(key);
      return v ? { arrayBuffer: async () => v.slice().buffer } : null;
    },
    async head(key) {
      const v = objects.get(key);
      return v ? { size: v.length } : null;
    },
    put(key, value) {
      objects.set(key, value);
    },
  };
  return { bucket, objects };
}

export interface Indexed {
  id: number;
  sha: string;
  attachments: { id: number; sha: string; part: number; filename: string | null }[];
}

/** Store a message in the bucket and index it the way the sync Worker would. */
export async function addMessage(
  db: Db, bucket: { put(key: string, v: Uint8Array): void }, raw: Uint8Array,
  opts: { account?: string; date?: string; threadId?: string | null; labels?: string; store?: boolean } = {},
): Promise<Indexed> {
  const account = opts.account ?? ACCOUNT;
  const sha = await sha256Hex(raw);
  if (opts.store !== false) bucket.put(`raw/${account}/${sha.slice(0, 2)}/${sha}.eml`, raw);
  const email = await parse(raw);
  const header = (k: string) => email.headers.find((h) => h.key === k)?.value ?? "";
  const kept = email.attachments
    .map((a, part) => ({ a, part }))
    .filter(({ a }) => a.disposition === "attachment" || a.filename || a.mimeType === "text/calendar"
      || (a.contentId && !a.mimeType.startsWith("text/")));
  const row = await db.prepare(`INSERT INTO messages (account, sha256, is_primary, message_id, thread_id, date, from_addr,
      to_addr, subject, labels, size, attachments, body) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(account, sha, header("message-id"), opts.threadId ?? null, opts.date ?? "2024-01-05T09:00:00+00:00",
      header("from"), header("to"), header("subject"), opts.labels ?? null, raw.length,
      kept.map(({ a }) => a.filename).filter(Boolean).join(", "), bodyText(email).slice(0, 20_000))
    .first<{ id: number }>();
  const id = row!.id;
  await db.prepare(`INSERT INTO messages_fts (rowid, subject, from_addr, to_addr, body, attachments)
      SELECT id, subject, from_addr, to_addr, body, attachments FROM messages WHERE id = ?`).bind(id).run();
  const attachments: Indexed["attachments"] = [];
  for (const { a, part } of kept) {
    const data = bytesOf(a.content);
    const partSha = await sha256Hex(data);
    const type = a.mimeType === "application/ics" ? "text/calendar" : a.mimeType;
    const kind = type.startsWith("image/") ? "image" : type === "text/calendar" ? "calendar" : "document";
    const noise = kind === "image" && (data.length < 10_000 || (a.disposition === "inline" && data.length < 50_000));
    await db.prepare(`INSERT INTO attachments (sha256, content_type, size, kind, is_noise, first_seen) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (sha256) DO NOTHING`).bind(partSha, type, data.length, kind, noise ? 1 : 0, opts.date ?? null).run();
    const att = await db.prepare("SELECT id FROM attachments WHERE sha256 = ?").bind(partSha).first<{ id: number }>();
    await db.prepare(`INSERT INTO message_attachments (message_id, part_index, attachment_id, filename, declared_type, disposition, content_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(id, part, att!.id, a.filename, a.mimeType, a.disposition, a.contentId ?? null).run();
    attachments.push({ id: att!.id, sha: partSha, part, filename: a.filename });
  }
  return { id, sha, attachments };
}

// ---- Tokens ----

export interface TestKey {
  privateKey: CryptoKey;
  jwk: Jwk;
}

export async function newKey(kid = "test-key"): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Jwk;
  return { privateKey: pair.privateKey, jwk: { kty: pub.kty, crv: pub.crv, x: pub.x, kid, alg: "EdDSA", use: "sig" } };
}

type CryptoKeyPair = { privateKey: CryptoKey; publicKey: CryptoKey };

export async function signToken(key: TestKey, claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const h = base64urlEncode(encoder.encode(JSON.stringify({ alg: "EdDSA", kid: key.jwk.kid, typ: "at+jwt", ...header })));
  const now = Math.floor(NOW / 1000);
  const body = {
    iss: ISSUER, sub: MICHAEL, aud: RESOURCE, iat: now, exp: now + 3600, jti: "jti-1",
    client_id: "dcr_test", scope: "profile offline_access", entity: { id: "e1", slug: "humain" }, ...claims,
  };
  const p = base64urlEncode(encoder.encode(JSON.stringify(body)));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, encoder.encode(`${h}.${p}`)));
  return `${h}.${p}.${base64urlEncode(sig)}`;
}

export function jwksFetcher(keys: () => Jwk[]) {
  const calls: string[] = [];
  const fetcher = async (url: string) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({ keys: keys() }) };
  };
  return { fetcher, calls };
}

// ---- A whole connector ----

export async function connector(options: {
  allowedSub?: string | null; fileLinkKey?: string | null; now?: number; myAddresses?: string[]; google?: GoogleConfig;
} = {}) {
  const index = sqliteDb();
  const log = sqliteDb(LOG_MIGRATIONS);
  const { bucket, objects } = memoryBucket();
  const key = await newKey();
  const { fetcher } = jwksFetcher(() => [key.jwk]);
  let now = options.now ?? NOW;
  const pending: Promise<unknown>[] = [];
  const deps: Deps = {
    index, mail: bucket, log,
    auth: { issuer: ISSUER, resource: RESOURCE, allowedSub: options.allowedSub === null ? undefined : (options.allowedSub ?? MICHAEL), now: () => now },
    jwks: new JwksCache(`${ISSUER}/.well-known/jwks.json`, fetcher, () => now),
    fileLinkKey: options.fileLinkKey === null ? undefined : (options.fileLinkKey ?? "test-file-link-key"),
    allowedOrigins: [RESOURCE, "https://claude.ai"],
    myAddresses: options.myAddresses ?? [ACCOUNT, ME_TOO],
    google: options.google,
    now: () => now,
    defer: (p) => pending.push(p),
  };
  const token = await signToken(key);
  const send = async (request: Request) => {
    const res = await handle(request, deps);
    await Promise.all(pending.splice(0));
    return res;
  };
  let nextId = 1;
  /** POST one JSON-RPC message to /mcp with Michael's token. */
  const rpc = async (method: string, params?: unknown, extra: { headers?: Record<string, string>; notification?: boolean } = {}) => {
    const message = { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }), ...(extra.notification ? {} : { id: nextId++ }) };
    return send(new Request(`${RESOURCE}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...extra.headers },
      body: JSON.stringify(message),
    }));
  };
  /** tools/call, returning the result's text and isError. */
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await rpc("tools/call", { name, arguments: args });
    const body = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
    return { text: body.result.content[0].text, isError: Boolean(body.result.isError) };
  };
  const logRows = async () => (await log.prepare("SELECT tool, args, ok, error, sub FROM calls ORDER BY id").all()).results;
  return {
    deps, index, log, bucket, objects, key, token, send, rpc, call, logRows,
    setNow: (ms: number) => (now = ms),
    add: (raw: Uint8Array, opts?: Parameters<typeof addMessage>[3]) => addMessage(index, bucket, raw, opts),
    addEvent: (event: CalendarEvent) => addEvent(index, event),
  };
}

/** The untrusted block of a tool result: its tag and what's between the markers. */
export function block(text: string): { tag: string; inside: string; before: string; after: string } {
  const open = /<<<MAIL DATA ([0-9a-f]{12})\n/.exec(text);
  if (!open) throw new Error("no opening marker");
  const tag = open[1];
  const close = `\nMAIL DATA ${tag}>>>`;
  const end = text.indexOf(close);
  if (end < 0) throw new Error("no closing marker");
  return { tag, inside: text.slice(open.index + open[0].length, end), before: text.slice(0, open.index), after: text.slice(end + close.length) };
}

/** The JSON at the start of a marked block (read_message puts the body after it). */
export function leadingJson(inside: string): unknown {
  const end = inside.indexOf("\n\n");
  return JSON.parse(end < 0 ? inside : inside.slice(0, end));
}

// ---- Calendars ----

/** Michael's second address in the tests. */
export const ME_TOO = "me@other.example";

export interface CalendarEvent {
  uid: string;
  summary: string;
  /** Occurrences: [start, end] in the stored format (UTC +00:00, or dates for all-day). */
  dates: [string, string | null][];
  source?: string;
  account?: string;
  calendar?: string;
  recurrenceId?: string;
  sequence?: number;
  status?: string;
  location?: string;
  description?: string;
  visibility?: string;
  allDay?: boolean;
  updatedAt?: string;
  importedAt?: string;
  /** [email, partstat, is_organizer] */
  attendees?: [string, string | null, boolean?][];
}

/** One calendar_events row with its people and dates, the way calendar/import_takeout.py writes them. */
export async function addEvent(db: Db, e: CalendarEvent): Promise<number> {
  const row = await db.prepare(`INSERT INTO calendar_events (source, account, calendar_id, calendar_name, uid, recurrence_id,
      sequence, status, summary, description, location, starts_at, ends_at, all_day, visibility, updated_at, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(e.source ?? "takeout", e.account ?? ACCOUNT, e.calendar ?? "Work", e.calendar ?? "Work", e.uid, e.recurrenceId ?? "",
      e.sequence ?? 0, e.status ?? "confirmed", e.summary, e.description ?? null, e.location ?? null, e.dates[0][0],
      e.dates[0][1], e.allDay ? 1 : 0, e.visibility ?? null, e.updatedAt ?? null, e.importedAt ?? "2026-11-27T08:00:00+00:00")
    .first<{ id: number }>();
  const id = row!.id;
  for (const [email, partstat, organizer] of e.attendees ?? []) {
    await db.prepare("INSERT INTO calendar_attendees (event_id, email, name, partstat, role, is_organizer) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, email, email.split("@")[0], partstat, "required", organizer ? 1 : 0).run();
  }
  for (const [start, end] of e.dates) {
    await db.prepare("INSERT INTO calendar_occurrences (event_id, starts_at, ends_at) VALUES (?, ?, ?)").bind(id, start, end).run();
  }
  return id;
}

/** A Google that refreshes tokens and creates events, recording every request. */
export function fakeGoogle(options: { tokens?: Record<string, string>; refuseToken?: boolean; refuseInsert?: boolean } = {}) {
  const requests: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
  let n = 0;
  const fetch: HttpFetch = async (url, init) => {
    requests.push({ url, ...init });
    const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
    if (url === TOKEN_URL) {
      return options.refuseToken ? reply(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." })
        : reply(200, { access_token: "access-token-1", expires_in: 3599, token_type: "Bearer" });
    }
    if (options.refuseInsert) return reply(403, { error: { code: 403, status: "PERMISSION_DENIED", message: "nope" } });
    const sent = JSON.parse(init.body) as Record<string, any>;
    n += 1;
    const id = `gev${n}`;
    const conference = String(url).includes("conferenceDataVersion=1");
    return reply(200, {
      id, iCalUID: `${id}@google.com`, htmlLink: `https://www.google.com/calendar/event?eid=${id}`, status: "confirmed",
      sequence: 0, summary: sent.summary, description: sent.description, location: sent.location,
      created: "2026-11-27T12:00:00.000Z", updated: "2026-11-27T12:00:00.000Z",
      start: sent.start, end: sent.end, organizer: { email: "me@example.com", self: true },
      ...(sent.attendees ? {
        attendees: [{ email: "me@example.com", organizer: true, self: true, responseStatus: "accepted" },
          ...sent.attendees.map((a: { email: string }) => ({ email: a.email, responseStatus: "needsAction" }))],
      } : {}),
      ...(conference ? { hangoutLink: "https://meet.google.com/abc-defg-hij" } : {}),
    });
  };
  const config: GoogleConfig = {
    clientJson: JSON.stringify({ installed: { client_id: "client-id-1.apps.googleusercontent.com", client_secret: "client-secret-1" } }),
    refreshTokens: JSON.stringify(options.tokens ?? { [ACCOUNT]: "refresh-token-1" }),
    fetch,
  };
  return { config, requests };
}
