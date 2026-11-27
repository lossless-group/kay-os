// kay-os's own Google Calendar grant (calendar/gcal_grant.py), used by create_event and nothing
// else. The OAuth client comes from the GOOGLE_OAUTH_CLIENT_JSON secret, each account's refresh
// token from GCAL_REFRESH_TOKENS (a JSON map, account -> token). Neither is ever logged or returned:
// errors name the account and Google's HTTP status and error code, nothing more.

export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

export interface HttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type HttpFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<HttpResponse>;

export interface GoogleConfig {
  /** The OAuth client JSON as Google hands it out ({"installed": {...}} or {"web": {...}}). */
  clientJson?: string;
  /** {"michael@learnstart.vc": "<refresh token>", ...} */
  refreshTokens?: string;
  fetch: HttpFetch;
}

/** A failure whose message is safe to show Claude and to log. */
export class GoogleError extends Error {}

function tokens(config: GoogleConfig | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!config?.refreshTokens) return map;
  let parsed: unknown;
  try {
    parsed = JSON.parse(config.refreshTokens);
  } catch {
    console.log("GCAL_REFRESH_TOKENS isn't JSON; no account can be written to");
    return map;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const [account, token] of Object.entries(parsed)) {
      if (typeof token === "string" && token) map.set(account.trim().toLowerCase(), token);
    }
  }
  return map;
}

/** The accounts create_event may write to: the ones with a refresh token. */
export function writableAccounts(config: GoogleConfig | undefined): string[] {
  return [...tokens(config).keys()].sort();
}

function client(config: GoogleConfig): { id: string; secret: string } {
  try {
    const data = JSON.parse(config.clientJson ?? "") as Record<string, Record<string, string> | undefined>;
    const c = data.installed ?? data.web;
    if (c?.client_id && c.client_secret) return { id: c.client_id, secret: c.client_secret };
  } catch {
    // fall through
  }
  throw new GoogleError("the connector's Google OAuth client isn't set up (GOOGLE_OAUTH_CLIENT_JSON)");
}

async function errorCode(res: HttpResponse): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    const e = body?.error;
    const code = typeof e === "string" ? e : (e && typeof e === "object" ? (e as { status?: unknown }).status : undefined);
    return typeof code === "string" && /^[\w.-]{1,60}$/.test(code) ? `, ${code}` : "";
  } catch {
    return "";
  }
}

/** A fresh access token for one account, from its refresh token. */
export async function accessToken(config: GoogleConfig, account: string): Promise<string> {
  const refresh = tokens(config).get(account.toLowerCase());
  if (!refresh) throw new GoogleError(`no Google grant for ${account}`);
  const { id, secret } = client(config);
  const res = await config.fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: "refresh_token" }).toString(),
  });
  if (!res.ok) throw new GoogleError(`Google refused to refresh ${account}'s grant (HTTP ${res.status}${await errorCode(res)})`);
  const body = (await res.json()) as { access_token?: unknown };
  if (typeof body.access_token !== "string") throw new GoogleError("Google's token reply had no access token");
  return body.access_token;
}

export interface GoogleTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

/** The parts of a Calendar API Event resource kay-os reads back. */
export interface GoogleEvent {
  id: string;
  iCalUID?: string;
  htmlLink?: string;
  hangoutLink?: string;
  status?: string;
  sequence?: number;
  summary?: string;
  description?: string;
  location?: string;
  visibility?: string;
  transparency?: string;
  created?: string;
  updated?: string;
  start?: GoogleTime;
  end?: GoogleTime;
  organizer?: { email?: string; displayName?: string };
  attendees?: { email?: string; displayName?: string; responseStatus?: string; optional?: boolean; organizer?: boolean }[];
}

/** events.insert on the account's primary calendar. */
export async function insertEvent(
  config: GoogleConfig, token: string, event: Record<string, unknown>,
  options: { sendUpdates: "all" | "none"; conferenceData: boolean },
): Promise<GoogleEvent> {
  const query = new URLSearchParams({ sendUpdates: options.sendUpdates });
  if (options.conferenceData) query.set("conferenceDataVersion", "1");
  const res = await config.fetch(`${CALENDAR_API}/calendars/primary/events?${query}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(event),
  });
  if (!res.ok) throw new GoogleError(`Google didn't create the event (HTTP ${res.status}${await errorCode(res)})`);
  const created = (await res.json()) as GoogleEvent;
  if (!created || typeof created.id !== "string") throw new GoogleError("Google's reply had no event id");
  return created;
}
