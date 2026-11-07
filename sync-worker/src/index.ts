// Every five minutes, each account's Durable Object fetches new mail into R2.
// One object per account means one IMAP session per account at a time.
import { DurableObject } from "cloudflare:workers";
import { connectImap } from "./socket.ts";
import { syncAccount, type Account, type Bucket, type SyncState } from "./sync.ts";

interface Env {
  MAIL: Bucket;
  SYNC: DurableObjectNamespace<MailboxSync>;
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
    const next = await syncAccount(account, connectImap(account.host ?? "imap.gmail.com"), this.env.MAIL, prior);
    await this.ctx.storage.put("state", next);
    await this.env.MAIL.put(`state/${address}/status.json`, JSON.stringify(next, null, 2));
    console.log(`${address}: fetched ${next.fetched}${next.lastError ? `; ${next.lastError}` : ""}`);
    return next;
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
