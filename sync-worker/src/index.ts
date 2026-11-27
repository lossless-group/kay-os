// On each scheduled run (a few times a day), each account's Durable Object fetches new mail into R2.
// One object per account means one IMAP session per account at a time. Backfilling older mail into
// the index runs separately, in short Durable Object alarms that chain until it's done
// (src/backfill-loop.ts), so the scheduled run stays short and always records its status.
import { DurableObject } from "cloudflare:workers";
import { backfillIndex, type BackfillState } from "./backfill.ts";
import { afterChunk, CHUNK, emptyStats, type BackfillStats } from "./backfill-loop.ts";
import { fromD1 } from "./db.ts";
import { connectImap } from "./socket.ts";
import { syncAccount, type Account, type Bucket, type SyncState } from "./sync.ts";

interface Env {
  MAIL: Bucket;
  SYNC: DurableObjectNamespace<MailboxSync>;
  /** The mail index (D1): each fetched message is indexed as it's stored, and older mail backfilled. */
  INDEX?: D1Database;
  /** JSON list of {address, password, host?}; a wrangler secret. */
  ACCOUNTS: string;
}

function accounts(env: Env): Account[] {
  return JSON.parse(env.ACCOUNTS);
}

const errorText = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

export class MailboxSync extends DurableObject<Env> {
  #running?: Promise<SyncState>;

  sync(address: string): Promise<SyncState> {
    this.#running ??= this.#run(address).finally(() => (this.#running = undefined));
    return this.#running;
  }

  async #run(address: string): Promise<SyncState> {
    const account = accounts(this.env).find((a) => a.address === address);
    if (!account) throw new Error(`no account ${address}`);
    // The alarm handler has no other way to know which account this object belongs to.
    await this.ctx.storage.put("address", address);
    const prior = (await this.ctx.storage.get<SyncState>("state")) ?? { cursors: {} };
    const imap = connectImap(account.host ?? "imap.gmail.com");
    const index = this.env.INDEX && fromD1(this.env.INDEX);
    const next = await syncAccount(account, imap, this.env.MAIL, prior, undefined, index);
    await this.ctx.storage.put("state", next);

    // Start (or restart, after it stopped on failures) the backfill loop if there's work left.
    const stats = (await this.ctx.storage.get<BackfillStats>("backfillStats")) ?? emptyStats();
    if (index && !stats.done && (await this.ctx.storage.getAlarm()) === null) {
      if (stats.stopped) await this.ctx.storage.put("backfillStats", { ...stats, stopped: false, failures: 0 });
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
    }
    await this.#writeStatus(address);
    console.log(`${address}: fetched ${next.fetched}${next.lastError ? `; ${next.lastError}` : ""}`);
    return next;
  }

  /** One backfill chunk, then re-arm for the next one until the account is done. */
  async alarm(): Promise<void> {
    const address = await this.ctx.storage.get<string>("address");
    if (!address || !this.env.INDEX) return;
    const index = fromD1(this.env.INDEX);
    const stats = (await this.ctx.storage.get<BackfillStats>("backfillStats")) ?? emptyStats();
    const prior = (await this.ctx.storage.get<BackfillState>("backfill")) ?? {};
    if (prior.done) {
      await this.ctx.storage.put("backfillStats", { ...stats, done: true });
      await this.#writeStatus(address);
      return;
    }
    const save = (state: BackfillState) => this.ctx.storage.put("backfill", state);
    let chunk: { indexed: number; errors: number; done: boolean; lastError?: string };
    try {
      const result = await backfillIndex(address, this.env.MAIL, index, prior, { ...CHUNK, save });
      await save(result.state);
      chunk = { indexed: result.indexed, errors: result.errors, done: !!result.state.done, lastError: result.lastError };
    } catch (err) {
      chunk = { indexed: 0, errors: 0, done: false, lastError: errorText(err) };
    }
    const { stats: next, delay } = afterChunk(stats, chunk, Date.now());
    await this.ctx.storage.put("backfillStats", next);
    if (delay !== null) await this.ctx.storage.setAlarm(Date.now() + delay);
    await this.#writeStatus(address);
    console.log(`backfill ${address}: +${chunk.indexed}, total ${next.indexed}`
      + `${next.done ? ", done" : ""}${next.stopped ? ", stopped" : ""}${chunk.lastError ? `; ${chunk.lastError}` : ""}`);
  }

  /** status.json in R2: the last sync and the backfill's running totals, rewritten after each step. */
  async #writeStatus(address: string) {
    const sync = (await this.ctx.storage.get<SyncState>("state")) ?? { cursors: {} };
    const backfill = await this.ctx.storage.get<BackfillStats>("backfillStats");
    await this.env.MAIL.put(`state/${address}/status.json`, JSON.stringify({ ...sync, backfill }, null, 2));
  }
}

export default {
  async scheduled(_controller: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    ctx.waitUntil(Promise.allSettled(
      accounts(env).map((a) => env.SYNC.get(env.SYNC.idFromName(a.address)).sync(a.address)),
    ));
  },
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
};
