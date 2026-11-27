// One row per call in the LOG database (migrations/0001_log.sql). A log write that fails never
// fails the call it records.
import type { Db } from "./db.ts";

export interface LogEntry {
  tool: string;
  args: unknown;
  ok: boolean;
  error?: string;
  sub?: string;
}

const MAX_ARGS_CHARS = 2_000;

export async function logCall(db: Db | undefined, entry: LogEntry, now: Date): Promise<void> {
  if (!db) return;
  try {
    let args = JSON.stringify(entry.args ?? null);
    if (args.length > MAX_ARGS_CHARS) args = args.slice(0, MAX_ARGS_CHARS);
    await db.prepare("INSERT INTO calls (at, tool, args, ok, error, sub) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(now.toISOString().slice(0, 19) + "+00:00", entry.tool, args, entry.ok ? 1 : 0,
        entry.error?.slice(0, 500) ?? null, entry.sub ?? null)
      .run();
  } catch (err) {
    console.log(`call log write failed (${(err as Error)?.name ?? "error"})`);
  }
}
