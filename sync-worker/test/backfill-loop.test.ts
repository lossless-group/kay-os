import assert from "node:assert/strict";
import { test } from "node:test";
import { afterChunk, emptyStats, MAX_FAILURES, NEXT_CHUNK_MS, RETRY_BASE_MS, RETRY_MAX_MS } from "../src/backfill-loop.ts";

const now = Date.parse("2026-11-27T03:00:00Z");

test("a chunk that made progress re-arms quickly and adds to the totals", () => {
  const { stats, delay } = afterChunk({ ...emptyStats(), indexed: 100, chunks: 1 }, { indexed: 100, errors: 2, done: false }, now);
  assert.equal(delay, NEXT_CHUNK_MS);
  assert.deepEqual([stats.indexed, stats.errors, stats.chunks, stats.failures], [200, 2, 2, 0]);
  assert.equal(stats.nextChunkAt, new Date(now + NEXT_CHUNK_MS).toISOString());
});

test("the last chunk stops the loop without marking it stopped", () => {
  const { stats, delay } = afterChunk(emptyStats(), { indexed: 7, errors: 0, done: true }, now);
  assert.equal(delay, null);
  assert.equal(stats.done, true);
  assert.equal(stats.stopped, undefined);
});

test("failed chunks back off, cap at an hour, and stop after MAX_FAILURES", () => {
  let stats = emptyStats();
  const delays: (number | null)[] = [];
  for (let i = 0; i < MAX_FAILURES; i++) {
    const r = afterChunk(stats, { indexed: 0, errors: 0, done: false, lastError: "Error: D1 unavailable" }, now);
    stats = r.stats;
    delays.push(r.delay);
  }
  assert.equal(delays[0], RETRY_BASE_MS);
  assert.equal(delays[1], RETRY_BASE_MS * 2);
  assert.ok(delays.slice(0, -1).every((d) => d !== null && d <= RETRY_MAX_MS));
  assert.equal(delays.at(-1), null);
  assert.equal(stats.stopped, true);
});

test("progress after a failure resets the failure count", () => {
  const failed = afterChunk(emptyStats(), { indexed: 0, errors: 0, done: false, lastError: "Error: x" }, now).stats;
  const { stats, delay } = afterChunk(failed, { indexed: 50, errors: 0, done: false, lastError: "Error: x" }, now);
  assert.equal(stats.failures, 0);
  assert.equal(delay, NEXT_CHUNK_MS);
});
