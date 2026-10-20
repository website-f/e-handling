"""Image validation helpers: file-signature sniffing, checksums and the per-candidate metadata file."""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone

# format -> how to recognise it from the first bytes
_SIGNATURES = {
    "jpeg": lambda b: b[:3] == b"\xff\xd8\xff",
    "png": lambda b: b[:8] == b"\x89PNG\r\n\x1a\n",
    "webp": lambda b: b[:4] == b"RIFF" and b[8:12] == b"WEBP",
    "gif": lambda b: b[:6] in (b"GIF87a", b"GIF89a"),
}
_ALIASES = {"jpg": "jpeg"}


def sniff(data: bytes) -> str | None:
    """Real format from the file signature (never trust the extension or Content-Type alone)."""
    for fmt, test in _SIGNATURES.items():
        if test(data):
            return fmt
    return None


def allowed(fmt: str | None, allowed_formats: tuple[str, ...]) -> bool:
    if fmt is None:
        return False
    return fmt in {_ALIASES.get(f, f) for f in allowed_formats}


def content_type_ok(content_type: str) -> bool:
    ct = content_type.split(";", 1)[0].strip().lower()
    return ct.startswith("image/") and ct != "image/svg+xml"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@dataclass
class Checked:
    fmt: str
    sha256: str
    size: int


def check(data: bytes, content_type: str, allowed_formats: tuple[str, ...], max_bytes: int) -> Checked | None:
    """Validate a downloaded image: size, declared type and actual signature must all agree."""
    if not data or len(data) > max_bytes or not content_type_ok(content_type):
        return None
    fmt = sniff(data)
    if not allowed(fmt, allowed_formats):
        return None
    return Checked(fmt=fmt, sha256=sha256(data), size=len(data))


def utcnow() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def write_metadata(meta_dir: str, candidate_id: str, payload: dict) -> str:
    """<meta_dir>/<candidate_id>.json, written atomically. Returns the path."""
    os.makedirs(meta_dir, exist_ok=True)
    safe = "".join(c for c in candidate_id if c.isalnum() or c in "-_")[:64] or "unknown"
    path = os.path.join(meta_dir, f"{safe}.json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"candidate_id": candidate_id, **payload}, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)
    return path
