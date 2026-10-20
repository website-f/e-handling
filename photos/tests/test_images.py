import json
import os

from images import check, content_type_ok, sha256, sniff, write_metadata

JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
WEBP = b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"\x00" * 64
GIF = b"GIF89a" + b"\x00" * 64
HTML = b"<!doctype html><html>not an image</html>"
ALLOWED = ("jpg", "jpeg", "png", "webp")


def test_sniff_signatures():
    assert sniff(JPEG) == "jpeg"
    assert sniff(PNG) == "png"
    assert sniff(WEBP) == "webp"
    assert sniff(GIF) == "gif"
    assert sniff(HTML) is None


def test_check_requires_matching_signature_and_type():
    assert check(JPEG, "image/jpeg", ALLOWED, 1 << 20).fmt == "jpeg"
    # Content-Type says image but the bytes are an HTML error page
    assert check(HTML, "image/jpeg", ALLOWED, 1 << 20) is None
    # Real image served with a non-image type
    assert check(PNG, "text/html", ALLOWED, 1 << 20) is None
    # Format not in the allow list
    assert check(GIF, "image/gif", ALLOWED, 1 << 20) is None
    # SVG is never accepted (scriptable)
    assert not content_type_ok("image/svg+xml")
    # Too big
    assert check(JPEG, "image/jpeg", ALLOWED, 10) is None
    # Empty (interrupted download)
    assert check(b"", "image/jpeg", ALLOWED, 1 << 20) is None


def test_duplicate_content_has_same_hash():
    a = check(PNG, "image/png", ALLOWED, 1 << 20)
    b = check(bytes(PNG), "image/png; charset=binary", ALLOWED, 1 << 20)
    assert a.sha256 == b.sha256 == sha256(PNG)
    assert check(JPEG, "image/jpeg", ALLOWED, 1 << 20).sha256 != a.sha256


def test_metadata_is_written_atomically_with_safe_name(tmp_path):
    path = write_metadata(str(tmp_path), "../../etc/P123", {"download_status": "completed", "sha256": "abc"})
    assert os.path.dirname(path) == str(tmp_path)
    assert os.path.basename(path) == "etcP123.json"
    data = json.loads(open(path, encoding="utf-8").read())
    assert data == {"candidate_id": "../../etc/P123", "download_status": "completed", "sha256": "abc"}
    assert not any(f.endswith(".tmp") for f in os.listdir(tmp_path))
