// A local run of the connector with no Cloudflare: the handler over node:sqlite and a memory bucket
// holding the synthetic deck message, and a test key standing in for id.didi.sh. Sends initialize,
// tools/list and a search_mail call with a test token and prints the replies.
//   pnpm local
import { connector, deck } from "../test/fixtures.ts";

const c = await connector();
await c.add(deck, { threadId: "99" });

const show = async (label: string, res: Response) => {
  const body = res.status === 202 ? "" : await res.text();
  console.log(`--- ${label}: HTTP ${res.status}`);
  console.log(body.length > 1500 ? body.slice(0, 1500) + " ..." : body);
};

await show("initialize", await c.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "local", version: "0" } }));
await show("notifications/initialized", await c.rpc("notifications/initialized", undefined, { notification: true }));
await show("tools/list", await c.rpc("tools/list", undefined, { headers: { "mcp-protocol-version": "2025-11-25" } }));
await show("tools/call search_mail", await c.rpc("tools/call", { name: "search_mail", arguments: { query: "deck" } }, { headers: { "mcp-protocol-version": "2025-11-25" } }));
console.log("--- call log");
console.log(await c.logRows());
