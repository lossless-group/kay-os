// Checks id.didi.sh access tokens. The connector is only a protected resource (RFC 9728): Claude
// signs Michael in at id.didi.sh, and every request here carries the access token it got back.
//
// A token is an EdDSA JWT (header typ at+jwt, RFC 9068) signed with the key in id.didi.sh's JWKS.
// Its aud is the *registered* resource (https://mcp.kay-os.lol), not the /mcp URL Claude asks for:
// id.didi.sh resolves a requested resource at or beneath a registered one to the registered URI
// (resolve_resource in lib/id_didi_sh/oauth.ex). So aud must equal RESOURCE exactly.

export interface Jwk {
  kty?: string;
  crv?: string;
  x?: string;
  kid?: string;
  alg?: string;
  use?: string;
}

export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export function base64urlDecode(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("not base64url");
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function base64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const JWKS_TTL_MS = 60 * 60 * 1000;
// An unknown kid triggers one refetch, but not more often than this, so junk tokens can't make the
// Worker hammer id.didi.sh.
const REFETCH_MIN_MS = 60 * 1000;

/** id.didi.sh's public keys, cached an hour, refetched once when a token names a kid we don't have. */
export class JwksCache {
  readonly #url: string;
  readonly #fetch: Fetcher;
  readonly #now: () => number;
  #keys = new Map<string, CryptoKey>();
  #fetchedAt = -Infinity;

  constructor(url: string, fetcher: Fetcher, now: () => number = Date.now) {
    this.#url = url;
    this.#fetch = fetcher;
    this.#now = now;
  }

  async #refresh(): Promise<void> {
    this.#fetchedAt = this.#now();
    const res = await this.#fetch(this.#url);
    if (!res.ok) throw new Error(`JWKS fetch failed (${res.status})`);
    const body = (await res.json()) as { keys?: Jwk[] };
    const keys = new Map<string, CryptoKey>();
    for (const jwk of body.keys ?? []) {
      if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x || (jwk.use && jwk.use !== "sig")) continue;
      // Only the public parts: WebCrypto is picky about alg values on Ed25519 JWKs.
      const key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x }, { name: "Ed25519" }, false, ["verify"]);
      keys.set(jwk.kid ?? "", key);
    }
    this.#keys = keys;
  }

  /** The key for `kid`, or the only key when the token names none. */
  async key(kid: string | undefined): Promise<CryptoKey | null> {
    if (this.#now() - this.#fetchedAt > JWKS_TTL_MS) await this.#refresh();
    let found = this.#pick(kid);
    // A rotated key: look once more, unless the keys were fetched just now anyway.
    if (!found && this.#now() - this.#fetchedAt > REFETCH_MIN_MS) {
      await this.#refresh();
      found = this.#pick(kid);
    }
    return found;
  }

  #pick(kid: string | undefined): CryptoKey | null {
    if (kid !== undefined) return this.#keys.get(kid) ?? null;
    return this.#keys.size === 1 ? [...this.#keys.values()][0] : null;
  }
}

export interface AuthConfig {
  issuer: string;
  resource: string;
  /** Michael's didi account id. Unset: nobody gets in, and the verified sub is reported. */
  allowedSub?: string;
  now?: () => number;
}

export type AuthResult =
  | { ok: true; sub: string }
  // `sub` is set only once the token is proven genuine, so a forged token can't put words in the log.
  | { ok: false; reason: string; sub?: string };

const fail = (reason: string, sub?: string): AuthResult => ({ ok: false, reason, ...(sub ? { sub } : {}) });

function parseJson(part: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(decoder.decode(base64urlDecode(part)));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** The bearer token in an Authorization header, or null. Never from the query string (MCP spec). */
export function bearerToken(header: string | null): string | null {
  const m = /^Bearer\s+([A-Za-z0-9._~+/-]+=*)\s*$/i.exec(header ?? "");
  return m ? m[1] : null;
}

export async function verifyAccessToken(token: string, config: AuthConfig, jwks: JwksCache): Promise<AuthResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return fail("malformed");
  const [h, p, s] = parts;
  const header = parseJson(h);
  const claims = parseJson(p);
  if (!header || !claims) return fail("malformed");
  if (header.alg !== "EdDSA") return fail("alg");
  const typ = typeof header.typ === "string" ? header.typ.toLowerCase() : "";
  if (typ !== "at+jwt" && typ !== "application/at+jwt") return fail("typ");

  let key: CryptoKey | null;
  try {
    key = await jwks.key(typeof header.kid === "string" ? header.kid : undefined);
  } catch {
    return fail("jwks-unavailable");
  }
  if (!key) return fail("unknown-key");
  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = base64urlDecode(s);
  } catch {
    return fail("malformed");
  }
  const valid = await crypto.subtle.verify({ name: "Ed25519" }, key, signature, encoder.encode(`${h}.${p}`));
  if (!valid) return fail("signature");

  if (claims.iss !== config.issuer) return fail("iss");
  const aud = claims.aud;
  if (!(aud === config.resource || (Array.isArray(aud) && aud.includes(config.resource)))) return fail("aud");
  const now = (config.now ?? Date.now)() / 1000;
  if (typeof claims.exp !== "number" || claims.exp <= now) return fail("expired");
  if (typeof claims.nbf === "number" && claims.nbf > now + 60) return fail("not-yet-valid");
  const sub = typeof claims.sub === "string" && claims.sub ? claims.sub : null;
  if (!sub) return fail("sub");

  if (!config.allowedSub) return fail("no-allowed-id", sub);
  if (sub !== config.allowedSub) return fail("wrong-sub", sub);
  return { ok: true, sub };
}
