// Indexes mail already in R2 that D1 doesn't have yet: what the laptop pushed, and what the Worker
// fetched before it indexed as it stored (C2). A batch per run, resumable, never writing to R2.
//
// Two phases, each keeping its place in `state` (Durable Object storage, saved after every page):
//   1. Once per account, read every meta/<account>/ JSON into D1's r2_meta, so a message the
//      Worker fetched keeps its mailbox, UID, labels and thread id.
//   2. Walk raw/<account>/ in key order and index each .eml that has no messages row. Mail with
//      no r2_meta row (the laptop's) is indexed from its headers alone, with NULL mailbox and UID.
import type { Db, DbStatement } from "./db.ts";
import { indexMessage, refreshNoise } from "./indexer.ts";
import type { Bucket } from "./sync.ts";

export interface BackfillState {
  /** Where the walk over raw/ resumes: the cursor of the page not yet finished. */
  cursor?: string;
  /** Every .eml under raw/ has been looked at. */
  done?: boolean;
  /** Every meta/ JSON is in r2_meta. */
  metaIndexed?: boolean;
  /** Where reading meta/ resumes, if a run ended partway through it. */
  metaCursor?: string;
}

export interface BackfillOptions {
  /** Messages to index this run (indexed or recorded as error). */
  budget?: number;
  /** meta/ files to read this run, so a large account's first read spans runs. */
  metaBudget?: number;
  /** Keys per R2 list() call; R2's own maximum is 1,000. */
  pageSize?: number;
  /** Persists the state after every page, so a killed run resumes where it was. */
  save?: (state: BackfillState) => Promise<void>;
}

export interface BackfillResult {
  state: BackfillState;
  /** Messages written to D1 this run, including those recorded as error. */
  indexed: number;
  /** Of those, how many couldn't be parsed or had attachments fail. */
  errors: number;
  lastError?: string;
}

const SHA = /^[0-9a-f]{64}$/;
const RAW_KEY = /\/([0-9a-f]{64})\.eml$/;
const IN_CHUNK = 90; // D1 allows 100 bound parameters a query; one goes to the account

interface MetaRow {
  sha256: string;
  mailbox: string;
  uidvalidity: number;
  uid: number;
  internal_date: string | null;
  flags: string | null;
  labels: string | null;
  thread_id: string | null;
}

const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((v) => typeof v === "string") ? value : null;
const parseList = (json: string | null): string[] | null => (json === null ? null : strings(JSON.parse(json)));

/** The r2_meta row for one meta file, or null when it has no .eml (skipped) or isn't ours. */
function metaStatement(db: Db, account: string, text: string): DbStatement | null {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof m.sha256 !== "string" || !SHA.test(m.sha256) || m.skipped === true) return null;
  if (typeof m.mailbox !== "string" || !Number.isInteger(m.uidvalidity) || !Number.isInteger(m.uid)) return null;
  const flags = strings(m.flags);
  const labels = strings(m.gmailLabels);
  return db.prepare(`INSERT OR IGNORE INTO r2_meta
      (account, sha256, mailbox, uidvalidity, uid, internal_date, flags, labels, thread_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    account, m.sha256, m.mailbox, m.uidvalidity, m.uid,
    typeof m.internalDate === "string" ? m.internalDate : null,
    flags && JSON.stringify(flags), labels && JSON.stringify(labels),
    typeof m.gmailThreadId === "string" ? m.gmailThreadId : null,
  );
}

/**
 * Messages indexed before their meta file was read have no conversation id. Once the account's
 * meta is all in r2_meta (from the Worker's meta/ files, or pushed from the laptop by
 * mail/push_meta_to_d1.py), copy each known thread_id onto the rows still missing one.
 */
export async function fillThreadIds(db: Db, account: string): Promise<void> {
  await db.prepare(`UPDATE messages SET thread_id = (SELECT r.thread_id FROM r2_meta r
        WHERE r.account = messages.account AND r.sha256 = messages.sha256)
      WHERE account = ? AND (thread_id IS NULL OR thread_id = '')
        AND EXISTS (SELECT 1 FROM r2_meta r WHERE r.account = messages.account
                    AND r.sha256 = messages.sha256 AND r.thread_id IS NOT NULL)`).bind(account).run();
}

async function inChunks<T>(db: Db, sql: (marks: string) => string, account: string, shas: string[]): Promise<T[]> {
  const rows: T[] = [];
  for (let i = 0; i < shas.length; i += IN_CHUNK) {
    const chunk = shas.slice(i, i + IN_CHUNK);
    const { results } = await db.prepare(sql(chunk.map(() => "?").join(", "))).bind(account, ...chunk).all<T>();
    rows.push(...results);
  }
  return rows;
}

/**
 * Index up to `budget` messages from raw/<account>/ that D1 doesn't have. Never throws: a failure
 * ends the run with `lastError`, and the saved state resumes at the start of the page it was on.
 */
export async function backfillIndex(
  account: string, bucket: Bucket, db: Db, prior: BackfillState, options: BackfillOptions = {},
): Promise<BackfillResult> {
  const { budget = 500, metaBudget = 5000, pageSize = 1000, save = async () => {} } = options;
  const state: BackfillState = { ...prior };
  const result: BackfillResult = { state, indexed: 0, errors: 0 };
  try {
    let metaRead = 0;
    while (!state.metaIndexed) {
      if (metaRead >= metaBudget) return result; // the walk waits: without meta it would lose UIDs
      const page = await bucket.list({ prefix: `meta/${account}/`, cursor: state.metaCursor, limit: pageSize });
      const rows: DbStatement[] = [];
      for (const { key } of page.objects) {
        if (!key.endsWith(".json")) continue;
        const text = await (await bucket.get(key))?.text();
        metaRead++;
        const row = text === undefined ? null : metaStatement(db, account, text);
        if (row) rows.push(row);
      }
      for (let i = 0; i < rows.length; i += 100) await db.batch(rows.slice(i, i + 100));
      state.metaCursor = page.truncated ? page.cursor : undefined;
      if (!page.truncated) {
        state.metaIndexed = true;
        await fillThreadIds(db, account);
      }
      await save({ ...state });
    }

    while (!state.done && result.indexed < budget) {
      const page = await bucket.list({ prefix: `raw/${account}/`, cursor: state.cursor, limit: pageSize });
      const keys = new Map<string, string>(); // sha -> key
      for (const { key } of page.objects) {
        const sha = RAW_KEY.exec(key)?.[1];
        if (sha) keys.set(sha, key);
      }
      const shas = [...keys.keys()];
      const known = new Set((await inChunks<{ sha256: string }>(db, (marks) =>
        `SELECT DISTINCT sha256 FROM messages WHERE account = ? AND sha256 IN (${marks})`, account, shas))
        .map((r) => r.sha256));
      const todo = shas.filter((sha) => !known.has(sha));
      const meta = new Map((await inChunks<MetaRow>(db, (marks) =>
        `SELECT * FROM r2_meta WHERE account = ? AND sha256 IN (${marks})`, account, todo)).map((r) => [r.sha256, r]));

      let finishedPage = true;
      for (const sha of todo) {
        if (result.indexed >= budget) {
          finishedPage = false; // this page again next run; what's done by then is skipped
          break;
        }
        const object = await bucket.get(keys.get(sha)!);
        if (!object) continue; // gone since the listing
        const m = meta.get(sha);
        const outcome = await indexMessage(db, {
          account, sha256: sha, raw: new Uint8Array(await object.arrayBuffer()),
          mailbox: m?.mailbox ?? null, uidvalidity: m?.uidvalidity ?? null, uid: m?.uid ?? null,
          internalDate: m?.internal_date ?? null, flags: parseList(m?.flags ?? null),
          labels: parseList(m?.labels ?? null), threadId: m?.thread_id ?? null,
        });
        if (outcome.status === "exists") continue;
        result.indexed++;
        if (outcome.status === "error") result.errors++;
      }
      if (!finishedPage) break;
      state.cursor = page.truncated ? page.cursor : undefined;
      if (!page.truncated) state.done = true;
      await save({ ...state });
    }
  } catch (err) {
    result.lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.log(`backfill ${account}: stopped (${result.lastError})`);
  }
  // The repeated-logo rule scans every attachment link, so run it once the walk is done rather
  // than after every chunk; live sync runs it after each pass with new mail anyway.
  if (result.indexed && state.done) {
    await refreshNoise(db).catch((err) => console.log(`refresh noise ${account}: failed (${err?.name ?? "error"})`));
  }
  return result;
}
