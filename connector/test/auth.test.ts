import assert from "node:assert/strict";
import { test } from "node:test";
import { JwksCache, bearerToken, verifyAccessToken, type AuthConfig } from "../src/auth.ts";
import { ISSUER, MICHAEL, NOW, RESOURCE, jwksFetcher, newKey, signToken } from "./fixtures.ts";

const config = (over: Partial<AuthConfig> = {}): AuthConfig => ({ issuer: ISSUER, resource: RESOURCE, allowedSub: MICHAEL, now: () => NOW, ...over });

async function setup() {
  const key = await newKey();
  const { fetcher, calls } = jwksFetcher(() => [key.jwk]);
  return { key, calls, jwks: new JwksCache(`${ISSUER}/.well-known/jwks.json`, fetcher, () => NOW) };
}

test("a token id.didi.sh would issue for this connector, for Michael, is accepted", async () => {
  const { key, jwks } = await setup();
  assert.deepEqual(await verifyAccessToken(await signToken(key), config(), jwks), { ok: true, sub: MICHAEL });
});

test("wrong audience, wrong issuer, expired, and wrong sub are each refused", async () => {
  const { key, jwks } = await setup();
  const now = Math.floor(NOW / 1000);
  const cases: [Record<string, unknown>, string][] = [
    [{ aud: "https://memopop.didi.sh" }, "aud"],
    [{ aud: `${RESOURCE}/mcp` }, "aud"], // the audience is the registered resource, never the /mcp URL
    [{ iss: "https://evil.example" }, "iss"],
    [{ exp: now - 1 }, "expired"],
    [{ exp: undefined }, "expired"],
    [{ sub: "didi_someone_else" }, "wrong-sub"],
  ];
  for (const [claims, reason] of cases) {
    const result = await verifyAccessToken(await signToken(key, claims), config(), jwks);
    assert.equal(result.ok, false, JSON.stringify(claims));
    assert.equal(!result.ok && result.reason, reason, JSON.stringify(claims));
  }
  // The other sub is genuine, so it's reported (for the log); a forged one never is.
  const other = await verifyAccessToken(await signToken(key, { sub: "didi_someone_else" }), config(), jwks);
  assert.deepEqual(other, { ok: false, reason: "wrong-sub", sub: "didi_someone_else" });
});

test("an audience list naming this connector is accepted", async () => {
  const { key, jwks } = await setup();
  const result = await verifyAccessToken(await signToken(key, { aud: ["https://other.example", RESOURCE] }), config(), jwks);
  assert.equal(result.ok, true);
});

test("with no allowed id, everyone is refused and the genuine sub is reported", async () => {
  const { key, jwks } = await setup();
  const result = await verifyAccessToken(await signToken(key), config({ allowedSub: undefined }), jwks);
  assert.deepEqual(result, { ok: false, reason: "no-allowed-id", sub: MICHAEL });
});

test("a token signed by another key, an altered token, or the wrong header is refused, and names no sub", async () => {
  const { key, jwks } = await setup();
  const stranger = await newKey("test-key"); // same kid, different key
  const forged = await verifyAccessToken(await signToken(stranger), config(), jwks);
  assert.deepEqual(forged, { ok: false, reason: "signature" });

  const good = await signToken(key);
  const [h, , s] = good.split(".");
  const swapped = Buffer.from(JSON.stringify({ iss: ISSUER, sub: "x", aud: RESOURCE, exp: 9e9 })).toString("base64url");
  assert.deepEqual(await verifyAccessToken(`${h}.${swapped}.${s}`, config(), jwks), { ok: false, reason: "signature" });

  assert.equal((await verifyAccessToken(await signToken(key, {}, { typ: "JWT" }), config(), jwks) as { reason: string }).reason, "typ");
  assert.equal((await verifyAccessToken(await signToken(key, {}, { alg: "none" }), config(), jwks) as { reason: string }).reason, "alg");
  assert.equal((await verifyAccessToken("not.a.jwt!", config(), jwks) as { reason: string }).reason, "malformed");
  assert.equal((await verifyAccessToken("abc", config(), jwks) as { reason: string }).reason, "malformed");
});

test("the JWKS is fetched once and cached for an hour, and refetched once for an unknown kid", async () => {
  const first = await newKey("k1");
  const second = await newKey("k2");
  let keys = [first.jwk];
  const { fetcher, calls } = jwksFetcher(() => keys);
  let now = NOW;
  const jwks = new JwksCache("https://id.didi.sh/.well-known/jwks.json", fetcher, () => now);
  const cfg = config({ now: () => now });

  assert.equal((await verifyAccessToken(await signToken(first), cfg, jwks)).ok, true);
  assert.equal((await verifyAccessToken(await signToken(first), cfg, jwks)).ok, true);
  assert.equal(calls.length, 1);

  // A rotated key: the first token naming it causes one refetch (once the cache is a minute old).
  keys = [first.jwk, second.jwk];
  now += 2 * 60_000;
  assert.equal((await verifyAccessToken(await signToken(second), cfg, jwks)).ok, true);
  assert.equal(calls.length, 2);
  // Junk kids don't cause a refetch each.
  for (let i = 0; i < 5; i++) await verifyAccessToken(await signToken(await newKey(`junk${i}`)), cfg, jwks);
  assert.equal(calls.length, 2);
  // After an hour, the keys are fetched again.
  now += 61 * 60_000;
  await verifyAccessToken(await signToken(first), cfg, jwks);
  assert.equal(calls.length, 3);
});

test("bearer tokens come only from an Authorization: Bearer header", () => {
  assert.equal(bearerToken("Bearer abc.def.ghi"), "abc.def.ghi");
  assert.equal(bearerToken("bearer abc"), "abc");
  assert.equal(bearerToken("Basic abc"), null);
  assert.equal(bearerToken(null), null);
  assert.equal(bearerToken("Bearer a b"), null);
});
