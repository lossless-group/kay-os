// The kay-os mail connector: a remote MCP server Claude reaches at https://mcp.kay-os.lol/mcp.
// Sign-in happens at id.didi.sh; this Worker checks the tokens and reads D1 and R2. Its one write
// outside the call log is create_event (Google Calendar, then the event's rows in the index).
// The routes and the protocol are in src/app.ts.
import { handle } from "./app.ts";
import { JwksCache, type Fetcher } from "./auth.ts";
import { fromD1 } from "./db.ts";

interface Env {
  /** The mail index (D1 kay-os-mail-index). Read only, by src/store.ts. */
  INDEX: D1Database;
  /** Raw mail (R2 kay-os-mail). Read only, by src/store.ts. */
  MAIL: R2Bucket;
  /** The call log (D1 kay-os-connector-log). The only database this Worker writes. */
  LOG?: D1Database;
  ISSUER: string;
  /** The registered id.didi.sh resource; every token's aud must equal it. */
  RESOURCE: string;
  /** Michael's didi account id. Unset: everyone is refused, and the id that tried is logged. */
  ALLOWED_DIDI_ID?: string;
  /** Secret that signs download links. Unset: get_attachment gives no link. */
  FILE_LINK_KEY?: string;
  /** Michael's own addresses, comma-separated (a var): left out of people lists and counts. */
  MY_ADDRESSES?: string;
  /** Secret: the Google OAuth client JSON kay-os's calendar grant was made with. */
  GOOGLE_OAUTH_CLIENT_JSON?: string;
  /** Secret: {"account": "refresh token"} for the accounts create_event may write to. */
  GCAL_REFRESH_TOKENS?: string;
  /** Comma-separated origins allowed in an Origin header, instead of the defaults below. */
  ALLOWED_ORIGINS?: string;
}

// One cache per isolate; it outlives requests, so the JWKS is fetched about once an hour.
let jwks: JwksCache | undefined;
let jwksFor: string | undefined;

const fetcher: Fetcher = (url) => fetch(url, { headers: { accept: "application/json" } });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const issuer = env.ISSUER.replace(/\/+$/, "");
    const resource = env.RESOURCE.replace(/\/+$/, "");
    if (!jwks || jwksFor !== issuer) {
      jwks = new JwksCache(`${issuer}/.well-known/jwks.json`, fetcher);
      jwksFor = issuer;
    }
    const allowedOrigins = env.ALLOWED_ORIGINS
      ? env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
      : [resource, "https://claude.ai", "https://claude.com"];
    return handle(request, {
      index: fromD1(env.INDEX),
      mail: env.MAIL,
      log: env.LOG && fromD1(env.LOG),
      auth: { issuer, resource, allowedSub: env.ALLOWED_DIDI_ID?.trim() || undefined },
      jwks,
      fileLinkKey: env.FILE_LINK_KEY || undefined,
      myAddresses: (env.MY_ADDRESSES ?? "").split(",").map((a) => a.trim().toLowerCase()).filter(Boolean),
      google: {
        clientJson: env.GOOGLE_OAUTH_CLIENT_JSON || undefined,
        refreshTokens: env.GCAL_REFRESH_TOKENS || undefined,
        fetch: (url, init) => fetch(url, init),
      },
      allowedOrigins,
      now: Date.now,
      defer: (p) => ctx.waitUntil(p),
    });
  },
};
