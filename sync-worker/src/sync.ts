// One pass of new-mail sync for one account: fetch everything past the saved
// cursor, read-only, and write it to R2 at the same paths kaymail uses.
import { ImapClient, mailboxesToSync, type FetchedMessage, type Transport } from "./imap.ts";

export interface Account {
  address: string;
  password: string;
  host?: string;
}

export interface Cursor {
  uidvalidity: number;
  lastUid: number;
}

export interface SyncState {
  cursors: Record<string, Cursor>;
  lastRun?: string;
  fetched?: number;
  lastError?: string;
}

/** The slice of an R2 bucket binding this file uses. */
export interface Bucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  head(key: string): Promise<unknown>;
  put(key: string, value: Uint8Array | string): Promise<unknown>;
}

const BATCH = 50;

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Where the laptop archive left off, uploaded once so the cloud doesn't refetch it. */
async function readSeed(bucket: Bucket, address: string): Promise<Record<string, Cursor>> {
  const object = await bucket.get(`state/${address}/seed.json`);
  return object ? JSON.parse(await object.text()) : {};
}

async function store(bucket: Bucket, address: string, mailbox: string, uidvalidity: number, m: FetchedMessage) {
  let sha: string | null = null;
  if (m.raw) {
    sha = await sha256(m.raw);
    const key = `raw/${address}/${sha.slice(0, 2)}/${sha}.eml`;
    if (!(await bucket.head(key))) await bucket.put(key, m.raw);
  }
  const { raw, ...meta } = m;
  const record = { account: address, mailbox, uidvalidity, ...meta, sha256: sha, skipped: raw === null };
  await bucket.put(`meta/${address}/${encodeURIComponent(mailbox)}/${uidvalidity}/${m.uid}.json`, JSON.stringify(record));
}

/**
 * Fetch up to `limit` new messages. Progress is kept even when the pass fails
 * partway, so the next run picks up after the last message stored.
 */
export async function syncAccount(
  account: Account, transport: Transport, bucket: Bucket, prior: SyncState, limit = 200,
): Promise<SyncState> {
  const state: SyncState = { cursors: { ...prior.cursors }, lastRun: new Date().toISOString(), fetched: 0 };
  let client: ImapClient | undefined;
  try {
    client = await ImapClient.open(transport, { timeoutMs: 60_000 });
    await client.login(account.address, account.password);
    const seed = await readSeed(bucket, account.address);
    for (const mailbox of mailboxesToSync(await client.list(), client.isGmail)) {
      const status = await client.examine(mailbox);
      let cursor = state.cursors[mailbox] ?? seed[mailbox];
      // No history, or the server renumbered the mailbox: start from now and
      // leave the past to the laptop sync.
      if (!cursor || cursor.uidvalidity !== status.uidvalidity) {
        cursor = { uidvalidity: status.uidvalidity, lastUid: (status.uidnext ?? 1) - 1 };
      }
      state.cursors[mailbox] = cursor;
      const lastUid = cursor.lastUid;
      const uids = (await client.uidSearch(lastUid + 1)).slice(0, limit - state.fetched!);
      for (let i = 0; i < uids.length; i += BATCH) {
        await client.uidFetch(uids.slice(i, i + BATCH), async (m) => {
          await store(bucket, account.address, mailbox, status.uidvalidity, m);
          cursor.lastUid = Math.max(cursor.lastUid, m.uid);
          state.fetched!++;
        });
      }
      if (state.fetched! >= limit) break;
    }
    await client.logout();
  } catch (err) {
    client?.close();
    state.lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
  return state;
}
