"""Candidate photo worker.

Works the `candidate_photos` queue (rows are enqueued by the API whenever it serves a contest):

  1. Wikipedia (ms, then en): title must match the candidate's name and the article must mention
     their party or seat. Accurate and freely licensed, so it can be auto-approved.
  2. Otherwise a Camoufox (stealth Firefox) Bing Images search for `"name" party seat`.

Every download is validated (HTTP status, Content-Type, real file signature, size limit) and
hashed (SHA-256); a picture already used for a different candidate is never reused. Every image
is face-checked with OpenCV: no face, a tiny face or a crowd shot is rejected, and portraits are
cropped square around the face and saved as WebP. Web results are only ever `pending` (shown to
voters after an admin approves one) unless PHOTO_AUTO_APPROVE allows it. Each finished candidate
gets <PHOTO_DIR>/meta/<uid>.json with source URLs, checksums and retrieval times.

Resumable: rows left in `searching` by a crash go back to `queued` at start-up, and finished rows
(and their files) are never re-downloaded unless an admin presses "retry".

  python worker.py                    # run the queue forever
  python worker.py --test "Name" PARTY "Seat"   # dry run for one candidate, prints what it finds
"""

from __future__ import annotations

import asyncio
import hashlib
import html
import io
import ipaddress
import json
import logging
import os
import random
import re
import socket
import sys
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable
from urllib.parse import quote, quote_plus, urlparse

import cv2
import httpx
import numpy as np
import psycopg
from PIL import Image, ImageOps

import images
import settings as settings_mod
from automation import CamoufoxBrowser, SecurityChallenge, detect_challenge, normalize_url

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("photos")

DATABASE_URL = os.environ.get("DATABASE_URL", "")
PHOTO_DIR = os.environ.get("PHOTO_DIR", "/data/photos")
AUTO_APPROVE = os.environ.get("PHOTO_AUTO_APPROVE", "consensus")  # none | wikipedia | consensus | all
MODEL_DIR = os.environ.get("PHOTO_MODEL_DIR", "/app/models")
# SFace cosine score for "same person". OpenCV publishes 0.363; measured on our crops, different
# candidates reached 0.429 while same-person pairs sat at 0.49-0.98, so 0.50 it is.
SAME_FACE = float(os.environ.get("PHOTO_SAME_FACE", "0.50"))
PACE = float(os.environ.get("PHOTO_PACE_SECONDS", "6"))  # gap between candidates (polite to Bing)
BROWSER_IDLE_CLOSE = 300  # seconds; frees ~500 MB when the queue is empty
CHALLENGE_COOLDOWN_MIN = int(os.environ.get("PHOTO_CHALLENGE_COOLDOWN_MIN", "30"))
SETTINGS = settings_mod.load()
MAX_OPTIONS = 4
MAX_ATTEMPTS = 3
OUT_SIZE = 384

# Wikimedia asks for a descriptive UA; image hosts elsewhere get a normal browser UA.
WIKI_UA = "e-Handling-PoC/1.0 (candidate portrait lookup; contact via handling.oriondesk.space)"
WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0"

FACE = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")

# Honorifics and connectors that say nothing about who someone is.
NAME_STOP = {
    "bin", "binti", "bt", "bte", "b", "a/l", "a/p", "al", "ap", "anak", "ak", "@", "dr", "datuk", "dato", "datin",
    "seri", "sri", "tan", "haji", "hj", "hajah", "hjh", "ir", "ts", "prof", "tuan", "puan", "encik", "cik", "tun",
}


@dataclass
class Cand:
    uid: str
    name: str
    party: str
    seat: str  # "P.173 Putatan"
    state: str

    @property
    def seat_name(self) -> str:
        return self.seat.split(" ", 1)[1] if " " in self.seat else self.seat


@dataclass
class Option:
    path: str  # "/photos/<file>.webp" as served by the gateway
    source: str  # wikipedia | web
    source_url: str
    page_url: str
    title: str
    faces: int = 1
    score: float = 0.0
    agree: int = 0  # how many other sites carry the same face (0 = unconfirmed)
    sha256: str = ""  # of the original download (duplicate detection across candidates)
    width: int = 0
    height: int = 0
    retrieved_at: str = ""
    meta: dict = field(default_factory=dict)

    def as_json(self) -> dict:
        return {
            "path": self.path, "source": self.source, "source_url": self.source_url,
            "page_url": self.page_url, "title": self.title[:200], "faces": self.faces,
            "score": round(self.score, 2), "agree": self.agree, "sha256": self.sha256,
            "width": self.width, "height": self.height, "retrieved_at": self.retrieved_at,
        }


# ---------------------------------------------------------------- name matching


def name_tokens(text: str) -> set[str]:
    text = text.lower().replace("’", "'")
    toks = re.findall(r"[a-z0-9']+|@", text)
    return {t for t in toks if t not in NAME_STOP and len(t) > 1}


def name_score(name: str, text: str) -> float:
    """Share of the candidate's meaningful name tokens that appear in `text`."""
    want = name_tokens(name)
    if not want:
        return 0.0
    have = name_tokens(text)
    return len(want & have) / len(want)


def mentions(text: str, *needles: str) -> bool:
    t = text.lower()
    return any(n and re.search(r"(?<![a-z])" + re.escape(n.lower()) + r"(?![a-z])", t) for n in needles)


# ---------------------------------------------------------------- safe download


class RateLimited(RuntimeError):
    """Wikimedia throttled us. The candidate is retried later instead of losing its Wikipedia photo."""


def _public_host(host: str) -> bool:
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            return False
    return True


async def download(client: httpx.AsyncClient, url: str) -> tuple[bytes, images.Checked] | None:
    """Fetch an image from the public internet only (never the compose network) and validate it:
    200, an image Content-Type, an allowed file signature and the size limit."""
    cfg = SETTINGS.images
    max_bytes = cfg.max_bytes
    try:
        u = urlparse(url)
        if u.scheme not in ("http", "https") or not u.hostname:
            return None
        if not await asyncio.to_thread(_public_host, u.hostname):
            return None
        ua = WIKI_UA if u.hostname.endswith("wikimedia.org") else WEB_UA
        for attempt in range(2):
            async with client.stream("GET", url, headers={"User-Agent": ua, "Accept": "image/*"},
                                     timeout=cfg.download_timeout_s) as r:
                if r.status_code == 429:
                    ra = r.headers.get("retry-after", "")
                    wait = float(ra) if ra.isdigit() else 5.0
                    if attempt == 0 and wait <= SETTINGS.requests.maximum_retry_after_s:
                        await asyncio.sleep(wait)
                        continue
                    if u.hostname.endswith("wikimedia.org"):
                        raise RateLimited("wikipedia rate limited (429) on image")
                    return None
                ctype = r.headers.get("content-type", "")
                if r.status_code != 200 or not images.content_type_ok(ctype):
                    return None
                declared = r.headers.get("content-length", "")
                if declared.isdigit() and int(declared) > max_bytes:
                    return None
                buf = bytearray()
                async for chunk in r.aiter_bytes():
                    buf += chunk
                    if len(buf) > max_bytes:
                        return None
                # A dropped connection mid-body leaves a short file: never keep a truncated image.
                if declared.isdigit() and r.headers.get("content-encoding") is None and int(declared) != len(buf):
                    return None
                data = bytes(buf)
                if cfg.verify_download:
                    checked = images.check(data, ctype, cfg.allowed_formats, max_bytes)
                else:
                    checked = images.Checked(fmt=images.sniff(data) or "", sha256=images.sha256(data), size=len(data))
                return (data, checked) if checked else None
        return None
    except (httpx.HTTPError, ValueError):
        return None


# ---------------------------------------------------------------- face crop


def face_crop(data: bytes) -> tuple[bytes, int, int, int] | None:
    """Square crop around the largest face, as WebP, plus face count and original size.
    None if this isn't a usable portrait."""
    try:
        img = Image.open(io.BytesIO(data))
        img = ImageOps.exif_transpose(img).convert("RGB")
    except Exception:  # noqa: BLE001 - corrupt / unsupported image
        return None
    w, h = img.size
    if min(w, h) < 120:
        return None
    gray = cv2.cvtColor(np.asarray(img), cv2.COLOR_RGB2GRAY)
    min_face = max(40, min(w, h) // 10)
    faces = FACE.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=6, minSize=(min_face, min_face))
    if len(faces) == 0 or len(faces) > 3:  # no face, or a crowd/group shot
        return None
    x, y, fw, fh = max(faces, key=lambda f: f[2] * f[3])
    side = min(max(fw, fh) * 2.3, w, h)
    cx, cy = x + fw / 2, y + fh / 2 + fh * 0.18  # nudge down to keep the shoulders in frame
    left = int(min(max(cx - side / 2, 0), w - side))
    top = int(min(max(cy - side / 2, 0), h - side))
    crop = img.crop((left, top, left + int(side), top + int(side))).resize((OUT_SIZE, OUT_SIZE), Image.LANCZOS)
    out = io.BytesIO()
    crop.save(out, "WEBP", quality=82, method=5)
    return out.getvalue(), len(faces), w, h


def save_photo(uid: str, webp: bytes) -> str:
    digest = hashlib.sha1(webp).hexdigest()[:10]
    fname = f"{uid}-{digest}.webp"
    path = os.path.join(PHOTO_DIR, fname)
    if not os.path.exists(path):
        tmp = path + ".tmp"
        with open(tmp, "wb") as f:
            f.write(webp)
        os.replace(tmp, path)
    return f"/photos/{fname}"


# async (sha256, uid) -> uid of another candidate already using this exact image, or None
OwnerOf = Callable[[str, str], Awaitable["str | None"]]


async def to_option(client: httpx.AsyncClient, cand: Cand, src: dict, seen: set[str],
                    owner_of: OwnerOf | None = None) -> Option | None:
    key = normalize_url(src["url"])
    if key in seen:  # same image URL reached through two results: download it once
        return None
    seen.add(key)
    got = await download(client, src["url"])
    if not got:
        return None
    data, checked = got
    if checked.sha256 in seen:  # same bytes behind two different URLs
        return None
    seen.add(checked.sha256)
    if owner_of is not None:
        other = await owner_of(checked.sha256, cand.uid)
        if other:  # never give one candidate another candidate's picture
            log.info("skip image already used by %s for uid=%s", other, cand.uid)
            return None
    cropped = await asyncio.to_thread(face_crop, data)
    if not cropped:
        return None
    webp, faces, w, h = cropped
    path = save_photo(cand.uid, webp)
    if path in seen:  # same crop reached through two results
        return None
    seen.add(path)
    return Option(path=path, source=src["source"], source_url=src["url"], page_url=src.get("page", ""),
                  title=src.get("title", ""), faces=faces, score=src.get("score", 0.0), sha256=checked.sha256,
                  width=w, height=h, retrieved_at=images.utcnow())


# ---------------------------------------------------------------- consensus (face recognition)

_models: tuple | None = None


def _face_models():
    global _models
    if _models is None:
        det = cv2.FaceDetectorYN.create(os.path.join(MODEL_DIR, "face_detection_yunet_2023mar.onnx"), "", (OUT_SIZE, OUT_SIZE), 0.8, 0.3, 50)
        rec = cv2.FaceRecognizerSF.create(os.path.join(MODEL_DIR, "face_recognition_sface_2021dec.onnx"), "")
        _models = (det, rec)
    return _models


def face_feature(photo_path: str):
    """SFace embedding of the main face in a saved crop, or None."""
    det, rec = _face_models()
    file = os.path.join(PHOTO_DIR, os.path.basename(photo_path))
    try:
        img = cv2.cvtColor(np.asarray(Image.open(file).convert("RGB")), cv2.COLOR_RGB2BGR)
    except Exception:  # noqa: BLE001
        return None
    det.setInputSize((img.shape[1], img.shape[0]))
    _, faces = det.detect(img)
    if faces is None or len(faces) == 0:
        return None
    face = max(faces, key=lambda f: f[2] * f[3])
    return rec.feature(rec.alignCrop(img, face))


def site_of(o: "Option") -> str:
    host = urlparse(o.page_url or o.source_url).hostname or ""
    parts = host.removeprefix("www.").split(".")
    # "www.sinardaily.my" -> "sinardaily.my", "news.malaymail.com" -> "malaymail.com"
    return ".".join(parts[-3:] if len(parts) > 2 and len(parts[-2]) <= 3 else parts[-2:])


def consensus(options: list["Option"]) -> list["Option"]:
    """Largest group of options showing the same face, from at least two different sites.

    Independent publishers agreeing on a face is strong evidence it is the named person; one
    unconfirmed picture is not, so it stays for human review."""
    _, rec = _face_models()
    feats = [face_feature(o.path) for o in options]
    best: list[int] = []
    for i, fi in enumerate(feats):
        if fi is None:
            continue
        group = [j for j, fj in enumerate(feats)
                 if fj is not None and (j == i or rec.match(fi, fj, cv2.FaceRecognizerSF_FR_COSINE) >= SAME_FACE)]
        if len({site_of(options[j]) for j in group}) >= 2 and len(group) > len(best):
            best = group
    sites = len({site_of(options[j]) for j in best})
    for j in best:
        options[j].agree = sites - 1
    return [options[j] for j in best]


# ---------------------------------------------------------------- source 1: Wikipedia


async def wikipedia_sources(client: httpx.AsyncClient, cand: Cand) -> list[dict]:
    out: list[dict] = []
    for lang in ("ms", "en"):
        api = f"https://{lang}.wikipedia.org/w/api.php"
        try:
            r = await client.get(api, params={"action": "query", "list": "search", "srsearch": cand.name,
                                              "srlimit": 5, "format": "json"}, headers={"User-Agent": WIKI_UA})
            if r.status_code == 429:
                # Throttled is not the same as "no article": retry this candidate later rather than
                # falling through to web search and losing an auto-approvable Wikipedia photo.
                raise RateLimited("wikipedia rate limited (429) on search")
            hits = r.json().get("query", {}).get("search", [])
        except (httpx.HTTPError, ValueError):
            continue
        for hit in hits:
            title = hit["title"]
            if name_score(cand.name, title) < 0.67:
                continue
            try:
                r = await client.get(api, params={
                    "action": "query", "titles": title, "prop": "pageimages|extracts", "piprop": "thumbnail", "pithumbsize": 640,
                    "exintro": 1, "explaintext": 1, "redirects": 1, "format": "json",
                }, headers={"User-Agent": WIKI_UA})
                page = next(iter(r.json()["query"]["pages"].values()))
            except (httpx.HTTPError, ValueError, KeyError, StopIteration):
                continue
            # The cached thumbnail, not the original: upload.wikimedia.org rate-limits (429) originals.
            img = page.get("thumbnail", {}).get("source")
            text = page.get("extract", "")
            # Same name is not enough: the article must tie them to this party or seat.
            if not img or not mentions(text, cand.party, cand.seat_name):
                continue
            out.append({"url": img, "source": "wikipedia", "title": title, "score": 1.0,
                        "page": f"https://{lang}.wikipedia.org/wiki/{quote(title.replace(' ', '_'))}"})
        if out:
            break
    return out


# ---------------------------------------------------------------- source 2: Camoufox + Bing Images


def Browser() -> CamoufoxBrowser:  # noqa: N802 - one shared Camoufox, closed when idle
    return CamoufoxBrowser(SETTINGS, idle_close=BROWSER_IDLE_CLOSE)


POLITICAL_TERMS = (
    "calon", "pru", "prn", "pilihan raya", "ahli parlimen", "adun", "dun", "parlimen", "bertanding", "kempen",
    "politik", "menteri", "kerajaan", "election", "candidate", "politician", "mp", "minister", "sabah", "sarawak",
)

_IUSC_TAG = re.compile(r"<a\b[^>]*\bclass=\"[^\"]*\biusc\b[^\"]*\"[^>]*>", re.I)
_M_ATTR = re.compile(r"\bm=\"([^\"]+)\"")


async def bing_sources(browser: CamoufoxBrowser, cand: Cand) -> list[dict]:
    query = f'"{cand.name}" {cand.party} {cand.seat_name}'
    url = "https://www.bing.com/images/search?" + "q=" + quote_plus(query) + "&qft=+filterui:face-portrait&form=IRFLTR"
    page = await browser.new_page()
    try:
        resp = await page.goto(url, wait_until=SETTINGS.browser.default_wait_until)
        # Results render after load; this is the page's own settle time, not an anti-bot delay.
        await page.wait_for_timeout(random.randint(1800, 3200))
        content = await page.content()
        if "iusc" not in content:  # no results grid: find out whether we were shown a block page
            challenge = detect_challenge(resp.status if resp else None, await page.title(),
                                         await page.evaluate("() => document.body ? document.body.innerText : ''"))
            if challenge:
                raise SecurityChallenge(challenge, "bing images")
    finally:
        await page.close()

    results = []
    for rank, tag in enumerate(_IUSC_TAG.findall(content)):
        m = _M_ATTR.search(tag)
        if not m:
            continue
        try:
            meta = json.loads(html.unescape(m.group(1)))
        except ValueError:
            continue
        murl, purl, title = meta.get("murl"), meta.get("purl", ""), meta.get("t", "")
        if not murl:
            continue
        context = " ".join([title, meta.get("desc", ""), purl.replace("-", " ").replace("/", " ").replace("_", " ")])
        # The caption or page must name the candidate...
        score = name_score(cand.name, context)
        if score < 0.5:
            continue
        # ...and place them in Malaysian politics. Name alone is not enough: "Patrick Payne"
        # also matches a horse trainer and an American CFO.
        if not mentions(context, cand.party, cand.seat_name, cand.state, *POLITICAL_TERMS):
            continue
        results.append({"url": murl, "page": purl, "title": title, "source": "web", "score": score, "rank": rank})
    results.sort(key=lambda r: (-r["score"], r["rank"]))
    return results[:12]


# ---------------------------------------------------------------- one candidate


async def find_photos(client: httpx.AsyncClient, browser: CamoufoxBrowser, cand: Cand,
                      owner_of: OwnerOf | None = None) -> tuple[list[Option], str]:
    seen: set[str] = set()
    for src in await wikipedia_sources(client, cand):
        opt = await to_option(client, cand, src, seen, owner_of)
        if opt:
            return [opt], "wikipedia"

    options: list[Option] = []
    web = await bing_sources(browser, cand)
    log.info("bing: %d relevant results for %r", len(web), cand.name)
    for src in web:
        opt = await to_option(client, cand, src, seen, owner_of)
        if opt:
            options.append(opt)
            if len(options) >= MAX_OPTIONS:
                break
    # Solo portraits before crops taken out of group photos.
    options.sort(key=lambda o: (o.faces > 1, -o.score))
    return options, "web"


# ---------------------------------------------------------------- queue


CLAIM_SQL = """
UPDATE candidate_photos SET status = 'searching', attempts = attempts + 1, updated_at = now()
WHERE uid = (
  SELECT uid FROM candidate_photos WHERE status = 'queued' AND queued_at <= now()
  ORDER BY queued_at LIMIT 1 FOR UPDATE SKIP LOCKED
)
RETURNING uid, name, party, seat, state, attempts
"""


# Every result write is guarded by status='searching': if an admin approved, rejected or
# re-queued the candidate while we were searching, their decision is kept.
def write_meta(cand: Cand, status: str, source: str | None, options: list[Option], error: str = "") -> None:
    """<PHOTO_DIR>/meta/<uid>.json: what was found, from where, with checksums (gateway never serves it)."""
    if not SETTINGS.images.save_metadata:
        return
    try:
        images.write_metadata(os.path.join(PHOTO_DIR, "meta"), cand.uid, {
            "name": cand.name, "party": cand.party, "seat": cand.seat, "download_status": status, "source": source,
            "error": error[:300], "updated_at": images.utcnow(),
            "images": [{**o.as_json(), "local_path": os.path.join(PHOTO_DIR, os.path.basename(o.path))} for o in options],
        })
    except OSError as e:
        log.warning("metadata write failed uid=%s: %s", cand.uid, e)


async def process(conn, client: httpx.AsyncClient, browser: CamoufoxBrowser, row) -> None:
    uid, name, party, seat, state, attempts = row
    cand = Cand(uid, name, party, seat, state)
    t0 = time.monotonic()

    async def owner_of(sha: str, me: str) -> str | None:
        cur = await conn.execute(
            "SELECT uid FROM candidate_photos WHERE uid <> %s AND options @> %s::jsonb LIMIT 1",
            (me, json.dumps([{"sha256": sha}])))
        hit = await cur.fetchone()
        return hit[0] if hit else None

    try:
        options, source = await find_photos(client, browser, cand, owner_of)
    except SecurityChallenge as e:
        # Bing showed a CAPTCHA / block page: pause web search for this candidate instead of retrying now.
        log.warning("security challenge (%s) while searching uid=%s; retrying in %d min", e.kind, uid,
                    CHALLENGE_COOLDOWN_MIN)
        await browser.close()
        await conn.execute(
            "UPDATE candidate_photos SET status='queued', last_error=%s, attempts=attempts - 1,"
            " queued_at=now() + make_interval(mins => %s), updated_at=now() WHERE uid=%s AND status='searching'",
            (f"challenge: {e.kind}", CHALLENGE_COOLDOWN_MIN, uid))
        write_meta(cand, "queued", None, [], f"challenge: {e.kind}")
        return
    except Exception as e:  # noqa: BLE001 - one bad page must not stop the queue
        log.warning("search failed uid=%s name=%r: %s", uid, name, e)
        if not isinstance(e, RateLimited):
            await browser.close()  # a wedged browser is relaunched on the next candidate
        throttled = isinstance(e, RateLimited)
        status = "queued" if throttled or attempts < MAX_ATTEMPTS else "error"
        await conn.execute(
            "UPDATE candidate_photos SET status=%s, last_error=%s, attempts=attempts - %s,"
            " queued_at=now() + interval '10 minutes', updated_at=now() WHERE uid=%s AND status='searching'",
            (status, str(e)[:500], 1 if throttled else 0, uid))
        write_meta(cand, "failed" if status == "error" else "queued", None, [], str(e))
        return

    if not options:
        await conn.execute(
            "UPDATE candidate_photos SET status='not_found', options='[]', image_path=NULL, source=NULL, last_error=NULL,"
            " updated_at=now() WHERE uid=%s AND status='searching'",
            (uid,))
        write_meta(cand, "completed_with_warnings", None, [], "no usable image found")
        log.info("not found uid=%s name=%r (%.1fs)", uid, name, time.monotonic() - t0)
        return

    auto = AUTO_APPROVE == "all" or (AUTO_APPROVE in ("wikipedia", "consensus") and source == "wikipedia")
    best = options[0]
    if source == "web" and AUTO_APPROVE in ("consensus", "all"):
        agreed = await asyncio.to_thread(consensus, options)
        if agreed:
            auto = True
            # Agreeing photos first; within them, solo portraits before group-photo crops.
            best = min(agreed, key=lambda o: (o.faces > 1, -o.score))
            options.sort(key=lambda o: (o.agree == 0, o is not best, o.faces > 1))
    await conn.execute(
        """UPDATE candidate_photos SET status=%s, source=%s, image_path=%s, source_url=%s, page_url=%s,
           options=%s, last_error=NULL, updated_at=now()
           WHERE uid=%s AND status='searching'""",
        ("approved" if auto else "pending", source, best.path, best.source_url, best.page_url,
         json.dumps([o.as_json() for o in options]), uid))
    write_meta(cand, "completed", source, options)
    log.info("found uid=%s name=%r source=%s options=%d agree=%d status=%s (%.1fs)", uid, name, source, len(options),
             best.agree, "approved" if auto else "pending", time.monotonic() - t0)


async def run() -> None:
    os.makedirs(PHOTO_DIR, exist_ok=True)
    while True:
        try:
            conn = await psycopg.AsyncConnection.connect(DATABASE_URL, autocommit=True)
            await conn.execute("SELECT 1 FROM candidate_photos LIMIT 1")
            break
        except Exception as e:  # noqa: BLE001 - db or schema (created by the API) not ready yet
            log.info("waiting for database/schema: %s", e)
            await asyncio.sleep(3)

    # Rows left mid-search by a previous crash go back in the queue.
    await conn.execute("UPDATE candidate_photos SET status='queued' WHERE status='searching'")
    browser = Browser()
    log.info("photo worker ready (auto_approve=%s, pace=%ss)", AUTO_APPROVE, PACE)
    async with httpx.AsyncClient(follow_redirects=True, timeout=15) as client:
        while True:
            cur = await conn.execute(CLAIM_SQL)
            row = await cur.fetchone()
            if row is None:
                await browser.close_if_idle()
                await asyncio.sleep(5)
                continue
            await process(conn, client, browser, row)
            await asyncio.sleep(PACE + random.uniform(0, PACE / 2))


async def test(name: str, party: str, seat: str) -> None:
    global PHOTO_DIR
    PHOTO_DIR = "/tmp/photo-test"
    os.makedirs(PHOTO_DIR, exist_ok=True)
    browser = Browser()
    cand = Cand("TEST", name, party, seat, "")
    async with httpx.AsyncClient(follow_redirects=True, timeout=15) as client:
        wiki = await wikipedia_sources(client, cand)
        print("wikipedia sources:", json.dumps(wiki, indent=1)[:1500])
        opts, source = await find_photos(client, browser, cand)
        print("chosen source:", source, "options:", [o.as_json() for o in opts])
    await browser.close()


if __name__ == "__main__":
    if len(sys.argv) >= 5 and sys.argv[1] == "--test":
        asyncio.run(test(sys.argv[2], sys.argv[3], sys.argv[4]))
    else:
        asyncio.run(run())
