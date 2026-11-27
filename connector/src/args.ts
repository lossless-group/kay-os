// Tool arguments, checked the way kaymcp.py checks them, and the refusal every tool throws.

/** A tool's refusal: shown to Claude as `Error: ...` with isError, as kaymcp.py does. */
export class ToolError extends Error {}

export type Args = Record<string, unknown>;

export function str(args: Args, name: string): string | null {
  const v = args[name];
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw new ToolError(`${name} must be a string`);
  return v;
}

export function int(args: Args, name: string, fallback?: number): number | null {
  const v = args[name];
  if (v === undefined || v === null) {
    if (fallback === undefined) return null;
    return fallback;
  }
  const n = typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : v; // kaymcp.py's int() takes "5" too
  if (typeof n !== "number" || !Number.isInteger(n)) throw new ToolError(`${name} must be an integer`);
  return n;
}

export function required(args: Args, name: string): number {
  const n = int(args, name);
  if (n === null) throw new ToolError(`${name} is required`);
  return n;
}

export const bool = (args: Args, name: string) => Boolean(args[name]);
export const limitOf = (args: Args, fallback: number, max: number) => Math.max(0, Math.min(int(args, "limit", fallback)!, max));
export const json = (value: unknown) => JSON.stringify(value, null, 1);
