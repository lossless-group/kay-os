// The slice of the Workers TCP sockets API this package uses.
// https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/
declare module "cloudflare:sockets" {
  interface SocketOptions {
    secureTransport?: "off" | "on" | "starttls";
    allowHalfOpen?: boolean;
  }
  interface Socket {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    opened: Promise<unknown>;
    closed: Promise<void>;
    close(): Promise<void>;
  }
  export function connect(address: { hostname: string; port: number }, options?: SocketOptions): Socket;
}
