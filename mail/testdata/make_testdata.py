#!/usr/bin/env python3
"""Regenerate the test data the Worker shares with the laptop, from the Python code itself.

    python3 mail/testdata/make_testdata.py

Writes mail/testdata/attachment_rules.json (expected values from kaymail's sniff_type,
attachment_kind and is_noise) and sync-worker/test/fixtures/deck.eml (test_kaymail's
deck_message()). Rerun after changing a rule; both test suites read the results.
"""

import json
import sys
from pathlib import Path

here = Path(__file__).resolve().parent
sys.path.insert(0, str(here.parent))
import kaymail  # noqa: E402
from test_kaymail import deck_message  # noqa: E402

PDF, PNG, JPEG, GIF = b"%PDF-1.7\n", b"\x89PNG\r\n\x1a\n\x00\x00", b"\xff\xd8\xff\xe0", b"GIF89a"
ICS, ZIP, GZIP, SEVENZ = b"BEGIN:VCALENDAR\r\n", b"PK\x03\x04\x14\x00", b"\x1f\x8b\x08\x00", b"7z\xbc\xaf\x27\x1c\x00"
TEXT = b"Quarterly notes\n"
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
OCTET = "application/octet-stream"

# (name, first bytes, declared type, filename, size, disposition, content_id)
CASES = [
    ("pdf signature", PDF, "application/pdf", "Acme Deck.pdf", 120_000, "attachment", None),
    ("png signature", PNG, "image/png", "chart.png", 200_000, "attachment", None),
    ("attached 1 MB photo", JPEG, "image/jpeg", "IMG_2041.jpg", 1_000_000, "attachment", None),
    ("gif tracking pixel", GIF, OCTET, None, 43, None, None),
    ("calendar signature under a wrong type", ICS, "text/plain", None, 900, None, None),
    ("docx declared over a zip signature", ZIP, DOCX, "memo.docx", 40_000, "attachment", None),
    ("xlsx declared over a zip signature", ZIP, XLSX, "model.xlsx", 80_000, "attachment", None),
    ("plain zip", ZIP, "application/zip", "files.zip", 500_000, "attachment", None),
    ("zip as octet-stream with a pptx name", ZIP, OCTET, "deck.pptx", 3_000_000, "attachment", None),
    ("zip as octet-stream with no name", ZIP, OCTET, None, 5_000, "attachment", None),
    ("gzip signature", GZIP, "application/x-gzip", "logs.tar.gz", 70_000, "attachment", None),
    ("7z signature", SEVENZ, OCTET, "backup.7z", 70_000, "attachment", None),
    ("signature beats declared image type", PDF, "image/jpeg", "scan.jpg", 300_000, "attachment", None),
    ("octet-stream with a known extension", TEXT, OCTET, "notes.txt", 2_000, "attachment", None),
    ("octet-stream with an upper-case extension", TEXT, OCTET, "SCAN.PDF", 2_000, "attachment", None),
    ("octet-stream with a compressed extension", TEXT, OCTET, "report.pdf.gz", 2_000, "attachment", None),
    ("octet-stream tarball", TEXT, OCTET, "site.tgz", 2_000, "attachment", None),
    ("octet-stream with an unknown extension", TEXT, OCTET, "blob.bin", 2_000, "attachment", None),
    ("octet-stream with no name", TEXT, OCTET, None, 2_000, "attachment", None),
    ("keynote: unknown type, document by extension", TEXT, OCTET, "Pitch.key", 900_000, "attachment", None),
    ("no declared type at all", TEXT, None, None, 2_000, None, None),
    ("calendar by type", b"METHOD:REQUEST\r\n", "text/calendar", None, 1_200, None, None),
    ("calendar by .ics", b"METHOD:CANCEL\r\n", OCTET, "invite.ics", 1_200, "attachment", None),
    ("calendar declared application/ics", b"METHOD:REPLY\r\n", "application/ics", "reply.ics", 1_200, "attachment", None),
    ("small attached image", PNG, "image/png", "logo.png", 400, "attachment", None),
    ("inline 30 KB image by content-id", PNG, "image/png", "logo.png", 30_000, None, "<logo@acme.example>"),
    ("inline 30 KB image by disposition", JPEG, "image/jpeg", "banner.jpg", 30_000, "inline", None),
    ("attached 30 KB image", PNG, "image/png", "diagram.png", 30_000, "attachment", None),
    ("inline 300 KB screenshot", PNG, "image/png", "image001.png", 300_000, "inline", "<image001@mail>"),
    ("heic photo with no signature", b"\x00\x00\x00\x18ftypheic", "image/heic", "IMG_1.HEIC", 2_000_000, "attachment", None),
]


def rule_cases():
    out = []
    for name, data, declared, filename, size, disposition, content_id in CASES:
        content_type = kaymail.sniff_type(data, declared, filename)
        kind = kaymail.attachment_kind(content_type, filename)
        out.append({
            "name": name,
            "first_bytes_hex": data.hex(),
            "declared_type": declared,
            "filename": filename,
            "size": size,
            "disposition": disposition,
            "content_id": content_id,
            "expected": {
                "content_type": content_type,
                "kind": kind,
                "is_noise": bool(kaymail.is_noise(kind, size, disposition, content_id)),
            },
        })
    return out


if __name__ == "__main__":
    (here / "attachment_rules.json").write_text(json.dumps(rule_cases(), indent=2) + "\n")
    (here.parent.parent / "sync-worker" / "test" / "fixtures" / "deck.eml").write_bytes(deck_message())
