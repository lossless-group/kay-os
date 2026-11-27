// How the backfill paces itself. A scheduled run only syncs new mail and starts the backfill; the
// backfill then runs in small chunks, each in its own Durable Object alarm, so no single invocation
// is long enough to be cut off before it records what it did. Each chunk re-arms the next until
// the account is done.

/** One chunk: small enough to finish well inside an alarm's limits, and to write status after. */
export const CHUNK = { budget: 100, metaBudget: 300, pageSize: 1000 };

/** Pause between chunks that went well. */
export const NEXT_CHUNK_MS = 2_000;
/** After a failed chunk, wait longer each time, up to an hour. */
export const RETRY_BASE_MS = 60_000;
export const RETRY_MAX_MS = 60 * 60_000;
/** Consecutive failed chunks before the loop stops and waits for the next scheduled run. */
export const MAX_FAILURES = 8;

export interface BackfillStats {
  /** Totals across every chunk so far. */
  indexed: number;
  errors: number;
  chunks: number;
  done: boolean;
  /** Failed chunks in a row; reset by any chunk that makes progress. */
  failures: number;
  /** The loop gave up after MAX_FAILURES; the next scheduled run starts it again. */
  stopped?: boolean;
  lastChunkAt?: string;
  nextChunkAt?: string;
  lastError?: string;
}

export const emptyStats = (): BackfillStats => ({ indexed: 0, errors: 0, chunks: 0, done: false, failures: 0 });

/**
 * Fold one chunk's result into the running stats and decide when the next chunk runs:
 * a delay in ms, or null for "don't re-arm" (finished, or stopped after repeated failures).
 */
export function afterChunk(
  stats: BackfillStats,
  chunk: { indexed: number; errors: number; done: boolean; lastError?: string },
  now: number,
): { stats: BackfillStats; delay: number | null } {
  // A chunk that indexed nothing and reported an error made no progress: back off.
  const failed = Boolean(chunk.lastError) && chunk.indexed === 0;
  const failures = failed ? stats.failures + 1 : 0;
  const next: BackfillStats = {
    indexed: stats.indexed + chunk.indexed,
    errors: stats.errors + chunk.errors,
    chunks: stats.chunks + 1,
    done: chunk.done,
    failures,
    lastChunkAt: new Date(now).toISOString(),
    lastError: chunk.lastError,
  };
  let delay: number | null;
  if (chunk.done) delay = null;
  else if (!failed) delay = NEXT_CHUNK_MS;
  else if (failures >= MAX_FAILURES) delay = null;
  else delay = Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS);
  if (delay === null && !chunk.done) next.stopped = true;
  if (delay !== null) next.nextChunkAt = new Date(now + delay).toISOString();
  return { stats: next, delay };
}
