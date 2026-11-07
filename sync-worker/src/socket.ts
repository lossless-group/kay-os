// Open a TLS connection to an IMAP server from inside a Cloudflare Worker.
import { connect } from "cloudflare:sockets";
import type { Transport } from "./imap.ts";

export function connectImap(hostname: string, port = 993): Transport {
  const socket = connect({ hostname, port }, { secureTransport: "on", allowHalfOpen: false });
  return {
    readable: socket.readable,
    writable: socket.writable,
    close: () => socket.close(),
  };
}
