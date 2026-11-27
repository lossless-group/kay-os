// How an attachment is typed, sorted and judged noise. A line-for-line port of mail/kaymail.py
// (MAGIC, KINDS, NOISE_*, sniff_type, attachment_kind, is_noise), so the cloud index sorts
// files the way the laptop does. Both test suites read mail/testdata/attachment_rules.json;
// change a rule in both places or that shared test fails.

// Images this small, or inline in the body and under the larger limit, are logos,
// icons, and tracking pixels. So is any image that arrives on more than
// NOISE_REPEATS messages. Real screenshots pasted into a body are usually bigger.
export const NOISE_MAX_BYTES = 10_000;
export const NOISE_INLINE_MAX_BYTES = 50_000;
export const NOISE_REPEATS = 50;

// kaymail.ATTACHMENT_HINT: a message without any of these has no attachment parts to find.
export const ATTACHMENT_HINT = /filename|name=|text\/calendar|content-id/i;

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

export const MAGIC: [Uint8Array, string][] = [
  [ascii("%PDF"), "application/pdf"],
  [ascii("\x89PNG\r\n\x1a\n"), "image/png"],
  [ascii("\xff\xd8\xff"), "image/jpeg"],
  [ascii("GIF8"), "image/gif"],
  [ascii("BEGIN:VCALENDAR"), "text/calendar"],
  [ascii("PK\x03\x04"), "application/zip"],
  [ascii("\x1f\x8b"), "application/gzip"],
  [ascii("7z\xbc\xaf\x27\x1c"), "application/x-7z-compressed"],
];

export const KINDS: [string, string[], string[]][] = [
  ["calendar", ["text/calendar", "application/ics"], [".ics", ".vcs"]],
  ["image", ["image/"], [".png", ".jpg", ".jpeg", ".gif", ".heic", ".webp", ".tif", ".tiff", ".bmp"]],
  ["archive", ["application/zip", "application/gzip", "application/x-7z", "application/x-rar",
    "application/x-tar", "application/x-zip"], [".zip", ".gz", ".tgz", ".7z", ".rar", ".tar"]],
  ["document", ["application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument",
    "application/vnd.ms-", "application/vnd.oasis.opendocument", "application/rtf",
    "text/plain", "text/html", "text/markdown", "text/csv"],
  [".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".odt", ".ods", ".odp", ".rtf",
    ".txt", ".md", ".html", ".htm", ".csv", ".key", ".pages", ".numbers"]],
];

// Python's mimetypes.guess_type reads the system mime.types, so the laptop's answer depends on
// the machine. This is that table (NixOS mailcap 2.1.54) for the suffixes the rules care about
// and a few common ones; a suffix missing here falls through to the sniffed or declared type.
const TYPES_BY_SUFFIX: Record<string, string> = {
  ".pdf": "application/pdf", ".doc": "application/msword", ".dot": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".odt": "application/vnd.oasis.opendocument.text", ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation", ".rtf": "application/rtf",
  ".txt": "text/plain", ".md": "text/markdown", ".html": "text/html", ".htm": "text/html", ".csv": "text/csv",
  ".pages": "application/vnd.apple.pages", ".numbers": "application/vnd.apple.numbers",
  ".ics": "text/calendar", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".heic": "image/heic", ".webp": "image/webp", ".tif": "image/tiff",
  ".tiff": "image/tiff", ".bmp": "image/bmp", ".svg": "image/svg+xml", ".zip": "application/zip",
  ".rar": "application/vnd.rar", ".tar": "application/x-tar", ".eml": "message/rfc822",
  ".json": "application/json", ".xml": "text/xml", ".mp4": "video/mp4", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
};
// mimetypes.suffix_map and encodings_map: "deck.pdf.gz" guesses application/pdf.
const SUFFIX_MAP: Record<string, string> = {
  ".svgz": ".svg.gz", ".tgz": ".tar.gz", ".taz": ".tar.gz", ".tz": ".tar.gz", ".tbz2": ".tar.bz2", ".txz": ".tar.xz",
};
const ENCODINGS = new Set([".gz", ".Z", ".bz2", ".xz", ".br"]);

function splitext(name: string): [string, string] {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  // Leading dots don't start a suffix, as in os.path.splitext.
  if (dot <= 0 || /^\.+$/.test(base.slice(0, dot))) return [name, ""];
  const cut = name.length - base.length + dot;
  return [name.slice(0, cut), name.slice(cut)];
}

/** mimetypes.guess_type(filename)[0], on the table above. */
export function guessType(filename: string): string | null {
  let [base, ext] = splitext(filename);
  while (ext in SUFFIX_MAP) [base, ext] = splitext(base + SUFFIX_MAP[ext]);
  if (ENCODINGS.has(ext)) [base, ext] = splitext(base);
  return TYPES_BY_SUFFIX[ext] ?? TYPES_BY_SUFFIX[ext.toLowerCase()] ?? null;
}

/** pathlib.Path(filename).suffix.lower(). */
function suffix(filename: string): string {
  const name = filename.replace(/\/+$/, "").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot).toLowerCase();
}

function startsWith(data: Uint8Array, magic: Uint8Array): boolean {
  return data.length >= magic.length && magic.every((b, i) => data[i] === b);
}

/** Trust unmistakable file signatures over what the sender declared. (kaymail.sniff_type) */
export function sniffType(data: Uint8Array, declared: string | null, filename: string | null): string {
  const sniffed = MAGIC.find(([magic]) => startsWith(data, magic))?.[1] ?? null;
  if (sniffed && sniffed !== "application/zip") return sniffed;
  if (declared && declared !== "application/octet-stream") return declared; // docx, xlsx and pptx are zips too
  return guessType(filename ?? "") || sniffed || declared || "application/octet-stream";
}

/** kaymail.attachment_kind */
export function attachmentKind(contentType: string, filename: string | null): string {
  const ext = suffix(filename ?? "");
  for (const [kind, prefixes, suffixes] of KINDS) {
    if (prefixes.some((p) => contentType.startsWith(p)) || suffixes.includes(ext)) return kind;
  }
  return "other";
}

/** kaymail.is_noise: small images and small inline images. Repeats are refreshNoise's job. */
export function isNoise(kind: string, size: number, disposition: string | null, contentId: string | null): boolean {
  const inline = disposition === "inline" || Boolean(contentId);
  return kind === "image" && (size < NOISE_MAX_BYTES || (inline && size < NOISE_INLINE_MAX_BYTES));
}
