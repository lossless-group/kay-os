// On each scheduled run (a few times a day), each account's Durable Object fetches new mail into R2.
// One object per account means one IMAP session per account at a time.
import { DurableObject } from "cloudflare:workers";
import { backfillIndex, type BackfillState } from "./backfill.ts";
import { fromD1, type Db } from "./db.ts";
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

export class MailboxSync extends DurableObject<Env> {
  #running?: Promise<SyncState>;

  sync(address: string): Promise<SyncState> {
    this.#running ??= this.#run(address).finally(() => (this.#running = undefined));
    return this.#running;
  }

  async #run(address: string): Promise<SyncState> {
    const account = accounts(this.env).find((a) => a.address === address);
    if (!account) throw new Error(`no account ${address}`);
    const prior = (await this.ctx.storage.get<SyncState>("state")) ?? { cursors: {} };
    const imap = connectImap(account.host ?? "imap.gmail.com");
    const index = this.env.INDEX && fromD1(this.env.INDEX);
    const next = await syncAccount(account, imap, this.env.MAIL, prior, undefined, index);
    await this.ctx.storage.put("state", next);
    const backfill = index ? await this.#backfill(address, index) : undefined;
    await this.env.MAIL.put(`state/${address}/status.json`, JSON.stringify({ ...next, backfill }, null, 2));
    console.log(`${address}: fetched ${next.fetched}${next.lastError ? `; ${next.lastError}` : ""}`
      + (backfill ? `; backfilled ${backfill.indexed}${backfill.done ? ", done" : ""}` : ""));
    return next;
  }

  /** Index a batch of mail already in R2. Its failures go in status.json, never into the sync's. */
  async #backfill(address: string, index: Db) {
    try {
      const prior = (await this.ctx.storage.get<BackfillState>("backfill")) ?? {};
      if (prior.done) return { indexed: 0, done: true };
      const save = (state: BackfillState) => this.ctx.storage.put("backfill", state);
      const result = await backfillIndex(address, this.env.MAIL, index, prior, { save });
      await save(result.state);
      return { indexed: result.indexed, errors: result.errors, done: !!result.state.done, lastError: result.lastError };
    } catch (err) {
      return { indexed: 0, done: false, lastError: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
    }
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
