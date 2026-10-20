"""MySPR Semak voter lookup, driven through the portal's own public form.

The portal (https://mysprsemak.spr.gov.my/semakan/daftarPemilih) asks for an IC number and a
4-digit image CAPTCHA tied to the browser session. This service never reads or solves that
CAPTCHA: it opens the form in an isolated Camoufox context, fills in the IC the voter typed,
screenshots the portal's CAPTCHA image and hands it to the voter. Only after the voter types the
digits does it press "Semak", exactly once, and read the fields the portal shows.

Internal HTTP API (compose network only, X-Internal-Token required):

  POST   /sessions                {job_id, ic}   -> awaiting_captcha + captcha PNG (data URL)
  POST   /sessions/{id}/captcha   {answer}       -> found | not_registered | captcha_wrong | ...
  POST   /sessions/{id}/refresh                  -> new CAPTCHA image (portal's own refresh link)
  DELETE /sessions/{id}
  GET    /health, /stats

IC numbers live only in memory for the life of a session (a few minutes) and are never logged.
"""

from __future__ import annotations

import asyncio
import base64
import hmac
import logging
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any, Protocol
from urllib.parse import urlsplit

import settings as settings_mod
from automation import (
    ActionGuard, CamoufoxBrowser, RequestStats, SecurityChallenge, Throttle, TransientError, detect_challenge,
    install_redaction, parse_retry_after, wait_actionable, with_retries,
)

log = logging.getLogger("spr")

SPR_URL = os.environ.get("SPR_URL", "https://mysprsemak.spr.gov.my/semakan/daftarPemilih")
SESSION_TTL = float(os.environ.get("SPR_SESSION_TTL_S", "240"))
SLOT_WAIT = float(os.environ.get("SPR_SLOT_WAIT_S", "30"))
# Each voter gets a fresh context (empty cache), so skip what the lookup never needs: fonts, media,
# decorative images and third-party hosts. Kept: the portal's own pages, scripts and styles (styles
# decide what innerText shows), its CAPTCHA image, and jsDelivr (SweetAlert messages).
BLOCK_ASSETS = os.environ.get("SPR_BLOCK_ASSETS", "true").strip().lower() in ("1", "true", "yes")
_ALLOWED_HOSTS = {urlsplit(SPR_URL).hostname, "cdn.jsdelivr.net"}


def keep_request(url: str, resource_type: str) -> bool:
    if (urlsplit(url).hostname or "") not in _ALLOWED_HOSTS:
        return False
    if resource_type in ("font", "media"):
        return False
    if resource_type == "image":
        return "/captcha/" in url
    return True


async def _route_filter(route) -> None:
    req = route.request
    if keep_request(req.url, req.resource_type):
        await route.continue_()
    else:
        await route.abort()
MAX_CAPTCHA_ATTEMPTS = int(os.environ.get("SPR_MAX_CAPTCHA_ATTEMPTS", "3"))
MAX_REFRESHES = int(os.environ.get("SPR_MAX_REFRESHES", "5"))
INTERNAL_TOKEN = os.environ.get("SPR_INTERNAL_TOKEN", "")

# Verified against the live portal on 2026-10-20 (form#formSemak posts to /semakan/daftarPemilihPapar).
SEL_FORM = "form#formSemak"
SEL_IC = 'form#formSemak input[name="NoKp"]'
SEL_CAPTCHA_INPUT = 'form#formSemak input[name="captcha"]'
SEL_CAPTCHA_IMG = "#img_captcha img"
SEL_SUBMIT = 'form#formSemak input[type="submit"]'
SEL_REFRESH = '.captcha a[onclick*="refreshCaptcha"]'

IC_RE = re.compile(r"^\d{12}$")
ANSWER_RE = re.compile(r"^\d{3,6}$")


# ---------------------------------------------------------------- result parsing (pure)

LABELS: dict[str, tuple[str, ...]] = {
    "ic": ("no. kad pengenalan", "no kad pengenalan", "no. k/p", "no k/p", "kad pengenalan", "no. kp"),
    "name": ("nama", "nama pemilih"),
    "dob": ("tarikh lahir",),
    "gender": ("jantina",),
    "locality": ("lokaliti",),
    "polling_district": ("daerah mengundi",),
    "dun": ("dun", "dewan undangan negeri", "dewan undangan negeri (dun)"),
    "parliament": ("parlimen",),
    "state": ("negeri",),
    "polling_centre": ("pusat mengundi", "tempat mengundi"),
    "stream": ("saluran",),
    "voting_time": ("waktu mengundi", "masa mengundi"),
}
_LABEL_OF = {alias: key for key, aliases in LABELS.items() for alias in aliases}
REQUIRED = ("name", "parliament", "state")


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().rstrip(":").strip()).lower()


def _label(text: str) -> str | None:
    t = _norm(text)
    if t in _LABEL_OF:
        return _LABEL_OF[t]
    # The portal's name row is not labelled plain "Nama" (seen live 2026-10-20): accept "Nama ..."
    # variants such as "Nama Penuh" / "Nama Pemilih", but only short label-like text, not a value.
    # Someone else's name (a parent, spouse) or a place's name must never become the voter's.
    if len(t) <= 30 and re.fullmatch(r"nama(?: [a-z()/.]+){1,3}", t) and not re.search(
            r"\b(?:bapa|ayah|ibu|emak|suami|isteri|waris|penjaga|pusat|sekolah|tempat|tadika|dewan|jalan|kampung)\b", t):
        return "name"
    return None


def all_fields(lines: list[str]) -> list[dict[str, str]]:
    """Every label/value row on the result page, verbatim and in page order, recognised or not,
    so the stored record keeps whatever the portal showed (status, centre, notes...). Only goes
    to the API with a found result; never logged."""
    out: list[dict[str, str]] = []
    clean = [ln.strip() for ln in lines]
    for i, line in enumerate(clean):
        if not line:
            continue
        cells = [c.strip() for c in line.split("\t") if c.strip() and c.strip() != ":"]
        label = value = ""
        if len(cells) >= 2:
            label, value = cells[0], " ".join(cells[1:]).lstrip(": ").strip()
        elif ":" in line and line.split(":", 1)[1].strip():
            label, value = line.split(":", 1)[0].strip(), line.split(":", 1)[1].strip()
        elif _label(line):
            nxt = next((n for n in clean[i + 1:i + 3] if n and n != ":"), "")
            if nxt and not _label(nxt):
                label, value = line, nxt.lstrip(": ").strip()
        label = label.rstrip(":").strip()
        # Labels are short and self-contained; long text, or text cut at a colon inside brackets
        # ("Sila masukkan ... (cth: 98xx...)"), is a sentence on the page, not a field.
        if label and value and len(label) <= 40 and label.count("(") == label.count(")"):
            out.append({"label": label, "value": value[:300]})
    return out[:60]


def unknown_labels(lines: list[str]) -> list[str]:
    """Left-hand cells of label/value rows we do not recognise. Labels only (the value side is
    never included), and only short digit-free text, so no voter data reaches the logs."""
    out: list[str] = []
    for line in lines:
        cells = [c.strip() for c in line.split("\t") if c.strip() and c.strip() != ":"]
        if len(cells) >= 2:
            left = cells[0]
        elif ":" in line and line.split(":", 1)[1].strip():
            left = line.split(":", 1)[0]
        else:
            continue
        t = _norm(left)
        if t and not _label(t) and len(t) <= 40 and not re.search(r"\d", t) and t not in out:
            out.append(t)
    return out[:20]


def line_shapes(lines: list[str]) -> list[str]:
    """One token per non-empty line describing its shape, never its content: K:<field> for a
    recognised label (alone or with its value), else <tabs>t<colons>c[d if digits]<length>."""
    shapes = []
    for line in lines:
        ln = line.strip()
        if not ln:
            continue
        cells = [c.strip() for c in ln.split("\t") if c.strip() and c.strip() != ":"]
        key = _label(cells[0]) if cells else None
        if not key and ":" in ln:
            key = _label(ln.split(":", 1)[0])
        if key:
            shapes.append(f"K:{key}")
        else:
            digits = "d" if re.search(r"\d", ln) else ""
            shapes.append(f"{ln.count(chr(9))}t{ln.count(':')}c{digits}{len(ln)}")
    return shapes[:60]


def extract_fields(lines: list[str]) -> dict[str, str]:
    """Label -> value pairs from the result page's visible text.

    Handles the three shapes a label/value row can take in innerText: tab-separated table cells,
    "Label : Value" on one line, and the label on its own line followed by the value. The first
    occurrence of a label wins. Values are never guessed: a label without a value is skipped."""
    out: dict[str, str] = {}
    clean = [ln.strip() for ln in lines]
    for i, line in enumerate(clean):
        if not line:
            continue
        cells = [c.strip() for c in line.split("\t") if c.strip() and c.strip() != ":"]
        key = value = None
        if len(cells) >= 2 and _label(cells[0]):
            key, value = _label(cells[0]), " ".join(cells[1:]).lstrip(": ").strip()
        elif ":" in line and _label(line.split(":", 1)[0]) and line.split(":", 1)[1].strip():
            key, value = _label(line.split(":", 1)[0]), line.split(":", 1)[1].strip()
        elif _label(line):
            key = _label(line)
            for nxt in clean[i + 1:i + 3]:
                if not nxt or nxt == ":":
                    continue
                if not _label(nxt):
                    value = nxt.lstrip(": ").strip()
                break
        if key and value and key not in out:
            out[key] = value
    return out


def _rest(text: str, m: re.Match) -> str:
    return re.sub(r"^[\s\-–:.]+", "", text[m.end():]).strip()


def parse_parliament(v: str) -> dict[str, str] | None:
    m = re.match(r"^\s*P\s*\.?\s*(\d{1,3})\b", v, re.I) or re.match(r"^\s*(\d{3})\b", v)
    if not m:
        return None
    return {"code": m.group(1).zfill(3), "name": _rest(v, m)}


def parse_dun(v: str, par_code: str) -> dict[str, str]:
    m = re.match(r"^\s*N\s*\.?\s*(\d{1,2})\b", v, re.I)
    if m:
        return {"code": f"{par_code}/{m.group(1).zfill(2)}", "name": _rest(v, m)}
    m = re.match(r"^\s*(\d{3})\s*/\s*(\d{1,2})\b", v)
    if m:
        return {"code": f"{m.group(1)}/{m.group(2).zfill(2)}", "name": _rest(v, m)}
    # Federal territories have no state seat; the portal shows a dash or "TIADA".
    if re.fullmatch(r"\s*(-+|tiada|tidak berkenaan|n/?a)?\s*", v, re.I):
        return {"code": "", "name": ""}
    return {"code": "", "name": v.strip()}


def parse_district(v: str) -> dict[str, str]:
    m = re.match(r"^\s*(\d{3})\s*/\s*(\d{2})\s*/\s*(\d{2})\b", v) or re.match(r"^\s*(\d{3})(\d{2})(\d{2})\b", v)
    if not m:
        return {"code": "", "name": v.strip()}
    return {"code": "/".join(m.groups()), "name": _rest(v, m)}


def parse_locality(v: str) -> dict[str, str]:
    m = (re.match(r"^\s*(\d{3})\s*/\s*(\d{2})\s*/\s*(\d{2})\s*/\s*(\d{3})\b", v)
         or re.match(r"^\s*(\d{3})(\d{2})(\d{2})(\d{3})\b", v))
    if not m:
        return {"code": "", "name": v.strip()}
    return {"code": "/".join(m.groups()), "name": _rest(v, m)}


_MASK = "*xX•●#"


def ic_matches(value: str, ic: str) -> bool:
    """Does the IC shown on the result page belong to the IC that was submitted?

    The portal's value is not always the bare 12 digits: it can be dashed, carry an old IC or
    service number alongside ("990123125571 (A1234567)"), or be partly masked ("990123-12-****").
    Accept the submitted IC as a whole 12-digit group, or a masked group whose visible digits all
    agree with it (at least 6 of them). A different IC never matches."""
    for m in re.finditer(rf"(?<![\d{_MASK}])[\d{_MASK}]{{6}}-?[\d{_MASK}]{{2}}-?[\d{_MASK}]{{4}}(?![\d{_MASK}])", value):
        group = m.group(0).replace("-", "")
        visible = [(c, d) for c, d in zip(group, ic) if c.isdigit()]
        if len(visible) == 12 and group == ic:
            return True
        if 6 <= len(visible) < 12 and all(c == d for c, d in visible):
            return True
    return False


def value_shape(value: str) -> str:
    """'990123-12-5571 (A123)' -> 'dddddd-dd-dddd (Addd)': format without content, for diagnostics."""
    return "".join("d" if c.isdigit() else "A" if c.isalpha() else c for c in value)[:60]


def build_voter(fields: dict[str, str], ic: str) -> tuple[dict[str, Any] | None, str]:
    """Normalized voter record, or (None, reason). Missing fields stay empty, never inferred."""
    missing = [k for k in REQUIRED if not fields.get(k)]
    if missing:
        return None, "missing:" + ",".join(missing)
    if fields.get("ic") and not ic_matches(fields["ic"], ic):
        return None, "ic_mismatch"  # a stale or someone else's page must never be returned
    par = parse_parliament(fields["parliament"])
    if par is None:
        return None, "unparsed:parliament"
    voter = {
        "full_name": re.sub(r"\s+", " ", fields["name"]).strip().upper(),
        "state": fields["state"].strip().upper(),
        "parlimen": par,
        "dun": parse_dun(fields.get("dun", ""), par["code"]),
        "daerah_mengundi": parse_district(fields.get("polling_district", "")),
        "lokaliti": parse_locality(fields.get("locality", "")),
        "polling_centre": fields.get("polling_centre", ""),
        "stream": fields.get("stream", ""),
        "voting_time": fields.get("voting_time", ""),
    }
    for area in ("parlimen", "dun", "daerah_mengundi", "lokaliti"):
        voter[area]["name"] = voter[area]["name"].upper()
    return voter, ""


_NOT_REGISTERED = re.compile(r"tiada (?:dalam )?rekod|rekod tidak (?:dijumpai|ditemui)|tidak (?:berdaftar|dijumpai|ditemui)|"
                             r"bukan pemilih|belum (?:berdaftar|didaftarkan)|no record", re.I)
_CAPTCHA_MSG = re.compile(r"captcha|aksara", re.I)


def classify(snap: dict[str, Any], ic: str) -> dict[str, Any]:
    """Turn a page snapshot into an outcome. Order matters: security controls first, a parsed
    result next, then the portal's own messages. Anything else is an unexpected layout."""
    challenge = detect_challenge(snap.get("status"), snap.get("title", ""), snap.get("text", ""), expected_captcha=True)
    if challenge:
        return {"status": "blocked", "reason": challenge}

    lines = snap.get("text", "").split("\n")
    fields = extract_fields(lines)
    if fields.get("name") or fields.get("parliament"):
        voter, reason = build_voter(fields, ic)
        if voter:
            return {"status": "found", "voter": voter, "fields": sorted(fields), "raw_fields": all_fields(lines)}
        diag = diagnostics(snap, fields)
        if reason == "ic_mismatch":
            diag["ic_value_shape"] = value_shape(fields["ic"])
        return {"status": "unexpected_layout", "reason": reason, "diagnostics": diag}

    message = " ".join(m for m in snap.get("messages", []) if m).strip()
    if message and _CAPTCHA_MSG.search(message):
        return {"status": "captcha_wrong"}
    if _NOT_REGISTERED.search(message) or _NOT_REGISTERED.search(snap.get("text", "")[:4000]):
        return {"status": "not_registered"}
    if snap.get("has_form") and message:
        return {"status": "portal_message", "message": sanitize_message(message)}
    if snap.get("has_form"):
        # Back on the form with no explanation: the portal rejected the submission silently.
        return {"status": "captcha_wrong"}
    return {"status": "unexpected_layout", "reason": "no_result", "diagnostics": diagnostics(snap, fields)}


def sanitize_message(msg: str) -> str:
    from automation import redact

    return redact(re.sub(r"\s+", " ", msg))[:240]


def diagnostics(snap: dict[str, Any], fields: dict[str, str]) -> dict[str, Any]:
    """Structure only (which labels, how many lines, which path), never values."""
    lines = snap.get("text", "").split("\n")
    return {
        "labels_found": sorted(fields),
        "unknown_labels": unknown_labels(lines),
        "line_shapes": line_shapes(lines),
        "line_count": len([ln for ln in lines if ln.strip()]),
        "title": snap.get("title", "")[:120],
        "path": urlsplit(snap.get("url", "")).path,
        "has_form": bool(snap.get("has_form")),
        "message_count": len(snap.get("messages", [])),
    }


# ---------------------------------------------------------------- portal adapter


class Portal(Protocol):
    """Everything the session logic needs from the page. The Camoufox implementation is below;
    tests use a fake."""

    async def open(self) -> int | None: ...
    async def fill_ic(self, ic: str) -> None: ...
    async def captcha(self) -> tuple[str, bytes]: ...
    async def captcha_src(self) -> str: ...
    async def refresh_captcha(self, old_src: str) -> None: ...
    async def fill_answer(self, answer: str) -> None: ...
    async def submit(self) -> None: ...
    async def has_result(self) -> bool: ...
    async def snapshot(self) -> dict[str, Any]: ...
    async def close(self) -> None: ...


_SNAPSHOT_JS = """() => {
  const pick = (sel) => Array.from(document.querySelectorAll(sel)).map(e => (e.innerText || '').trim()).filter(Boolean);
  const scripts = Array.from(document.scripts).map(s => s.textContent || '')
    .filter(t => /Swal\\.fire|swal\\(/.test(t))
    .map(t => (t.match(/(?:title|text|html)\\s*:\\s*(['"`])([\\s\\S]*?)\\1/g) || []).join(' '));
  return {
    url: location.href,
    title: document.title,
    text: document.body ? document.body.innerText : '',
    has_form: !!document.querySelector('form#formSemak input[name="NoKp"]'),
    messages: [...pick('.swal2-popup .swal2-title, .swal2-popup .swal2-content, .swal2-popup .swal2-html-container'),
               ...pick('.invalid-feedback, .alert, .text-red-500, .error'), ...scripts.filter(Boolean)],
  };
}"""

_SETTLE_JS = """() => {
  const t = document.body ? document.body.innerText : '';
  return /Parlimen/i.test(t) && /Nama/i.test(t)
      || !!document.querySelector('.swal2-popup')
      || Array.from(document.querySelectorAll('.invalid-feedback')).some(e => e.innerText.trim());
}"""


class CamoufoxPortal:
    def __init__(self, ctx, page, s: settings_mod.Settings) -> None:
        self.ctx, self.page, self.s = ctx, page, s
        self.last_status: int | None = None

    async def open(self) -> int | None:
        resp = await self.page.goto(SPR_URL, wait_until=self.s.browser.default_wait_until)
        self.last_status = resp.status if resp else None
        if resp is not None and (resp.status >= 500 or resp.status == 429):
            raise TransientError(f"portal http {resp.status}", parse_retry_after(await resp.header_value("retry-after")))
        return self.last_status

    async def fill_ic(self, ic: str) -> None:
        box = self.page.locator(SEL_IC)
        await wait_actionable(box, self.s.browser.action_timeout_ms)
        if await box.input_value() != ic:  # state check: only type when the field differs
            await box.fill(ic)
        if await box.input_value() != ic:
            raise RuntimeError("ic field did not accept the value")

    async def captcha(self) -> tuple[str, bytes]:
        img = self.page.locator(SEL_CAPTCHA_IMG).first
        await img.wait_for(state="visible", timeout=self.s.browser.action_timeout_ms)
        await self.page.wait_for_function("img => img.complete && img.naturalWidth > 0", arg=await img.element_handle(),
                                          timeout=self.s.browser.action_timeout_ms)
        return await img.get_attribute("src") or "", await img.screenshot(type="png")

    async def captcha_src(self) -> str:
        img = self.page.locator(SEL_CAPTCHA_IMG).first
        return (await img.get_attribute("src", timeout=self.s.browser.action_timeout_ms)) or ""

    async def refresh_captcha(self, old_src: str) -> None:
        # The portal's refresh link calls jQuery, which it loads over plain http and browsers block
        # on this https page. Try the link briefly; otherwise reload the form (an idempotent GET).
        # The IC is typed again just before submitting, so a reloaded, empty form is fine.
        try:
            link = self.page.locator(SEL_REFRESH).first
            await wait_actionable(link, 2000)
            await link.click()
            await self.page.wait_for_function(
                "old => { const i = document.querySelector('#img_captcha img'); return i && i.getAttribute('src') !== old; }",
                arg=old_src, timeout=3000)
        except Exception:  # noqa: BLE001
            await self.open()

    async def fill_answer(self, answer: str) -> None:
        box = self.page.locator(SEL_CAPTCHA_INPUT)
        await wait_actionable(box, self.s.browser.action_timeout_ms)
        await box.fill(answer)
        if await box.input_value() != answer:
            raise RuntimeError("captcha field did not accept the value")

    async def submit(self) -> None:
        btn = self.page.locator(SEL_SUBMIT).first
        await wait_actionable(btn, self.s.browser.action_timeout_ms)
        async with self.page.expect_navigation(wait_until=self.s.browser.default_wait_until):
            await btn.click()
        try:  # a result table, a SweetAlert or a validation message: whichever comes first
            await self.page.wait_for_function(_SETTLE_JS, timeout=min(5000, self.s.browser.action_timeout_ms))
        except Exception:  # noqa: BLE001 - classify() decides what an unsettled page means
            pass

    async def has_result(self) -> bool:
        try:
            return bool(await self.page.evaluate(
                "() => /daftarPemilihPapar/.test(location.pathname) && /Parlimen/i.test(document.body.innerText)"))
        except Exception:  # noqa: BLE001
            return False

    async def snapshot(self) -> dict[str, Any]:
        snap = await self.page.evaluate(_SNAPSHOT_JS)
        snap["status"] = None  # navigation status was checked on open; post-submit pages are judged by content
        return snap

    async def close(self) -> None:
        pass  # the context is closed by the service, which also releases the page slot


# ---------------------------------------------------------------- sessions


@dataclass
class Session:
    id: str
    ic: str
    portal: Any
    ctx: Any = None
    created: float = field(default_factory=time.monotonic)
    touched: float = field(default_factory=time.monotonic)
    guard: ActionGuard = field(default_factory=ActionGuard)
    captcha_src: str = ""
    captcha_png: bytes = b""
    attempts: int = 0
    refreshes: int = 0
    finished: dict | None = None


def _data_url(png: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(png).decode()


def _is_timeout(e: BaseException) -> bool:
    return isinstance(e, (asyncio.TimeoutError, TimeoutError)) or type(e).__name__ == "TimeoutError"


class SprService:
    """Session state machine. One isolated browser context per voter; at most
    browser.max_concurrent_pages open at once; every submission happens once per CAPTCHA."""

    def __init__(self, s: settings_mod.Settings, open_portal, release=None, clock=time.monotonic) -> None:
        self.s = s
        self.sessions: dict[str, Session] = {}
        self.stats = RequestStats()
        self.throttle = Throttle(s.execution.minimum_action_interval_ms, s.execution.maximum_action_interval_ms)
        self.slots = asyncio.Semaphore(s.browser.max_concurrent_pages)
        self._open_portal = open_portal  # async () -> (portal, ctx)
        self._release = release  # async (ctx) -> None
        self._clock = clock
        self._starting: dict[str, asyncio.Future] = {}
        self.capacity = s.browser.max_concurrent_pages
        self.waiting = 0  # lookups queued for a free browser slot

    # -- lifecycle

    async def start(self, job_id: str, ic: str) -> dict[str, Any]:
        if not IC_RE.match(ic or ""):
            return {"status": "invalid_input"}
        existing = self.sessions.get(job_id)
        if existing is not None:  # duplicate start: return the session we already have, open nothing new
            self.stats.dedup_hits += 1
            return existing.finished or self._awaiting(existing)
        if job_id in self._starting:
            self.stats.dedup_hits += 1
            return await asyncio.shield(self._starting[job_id])
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._starting[job_id] = fut
        try:
            res = await self._start(job_id, ic)
            fut.set_result(res)
            return res
        except BaseException as e:
            fut.set_exception(e)
            fut.exception()
            raise
        finally:
            self._starting.pop(job_id, None)

    async def _start(self, job_id: str, ic: str) -> dict[str, Any]:
        self.waiting += 1
        try:
            await asyncio.wait_for(self.slots.acquire(), timeout=SLOT_WAIT)
        except asyncio.TimeoutError:
            self.stats.failures["start:busy"] += 1
            return {"status": "busy"}
        finally:
            self.waiting -= 1
        t0 = self._clock()
        portal = ctx = None
        try:
            portal, ctx = await self._open_portal()
            host = urlsplit(SPR_URL).hostname or "spr"

            async def load():
                await self.throttle.wait(host)
                try:
                    return await portal.open()
                except TransientError:
                    raise
                except Exception as e:  # noqa: BLE001
                    if _is_timeout(e):
                        raise TransientError("navigation timeout") from e
                    raise

            status = await with_retries(load, retries=self.s.execution.maximum_retries,
                                        backoff_ms=self.s.execution.retry_backoff_ms, stats=self.stats, kind="open",
                                        respect_retry_after=self.s.requests.respect_retry_after,
                                        max_retry_after_s=self.s.requests.maximum_retry_after_s)
            snap = await portal.snapshot()
            snap["status"] = status
            challenge = detect_challenge(status, snap.get("title", ""), snap.get("text", ""), expected_captcha=True)
            if challenge:
                raise SecurityChallenge(challenge)
            if not snap.get("has_form"):
                raise LookupError("form_missing")
            await portal.fill_ic(ic)
            src, png = await portal.captcha()
        except SecurityChallenge as e:
            self.stats.record("open", (self._clock() - t0) * 1000, False, e.kind)
            await self._abort_start(portal, ctx)
            return {"status": "blocked", "reason": e.kind}
        except TransientError as e:
            self.stats.record("open", (self._clock() - t0) * 1000, False, "unavailable")
            await self._abort_start(portal, ctx)
            log.warning("portal unavailable: %s", e)
            return {"status": "unavailable"}
        except LookupError:
            self.stats.record("open", (self._clock() - t0) * 1000, False, "layout")
            await self._abort_start(portal, ctx)
            return {"status": "unexpected_layout", "reason": "form_missing"}
        except Exception as e:  # noqa: BLE001 - selector missing, element never visible, crashed page
            reason = "timeout" if _is_timeout(e) else "layout"
            self.stats.record("open", (self._clock() - t0) * 1000, False, reason)
            await self._abort_start(portal, ctx)
            log.warning("portal open failed (%s): %s", reason, e)
            return {"status": "unexpected_layout" if reason == "layout" else "unavailable", "reason": reason}
        self.stats.record("open", (self._clock() - t0) * 1000, True)
        s = Session(id=job_id, ic=ic, portal=portal, ctx=ctx, created=self._clock(), touched=self._clock(),
                    captcha_src=src, captcha_png=png)
        self.sessions[job_id] = s
        return self._awaiting(s)

    def _awaiting(self, s: Session, status: str = "awaiting_captcha") -> dict[str, Any]:
        return {"status": status, "captcha": _data_url(s.captcha_png), "attempts_left": MAX_CAPTCHA_ATTEMPTS - s.attempts,
                "expires_in": max(0, int(SESSION_TTL - (self._clock() - s.created)))}

    async def answer(self, job_id: str, answer: str) -> dict[str, Any]:
        s = self.sessions.get(job_id)
        if s is None:
            return {"status": "expired"}
        if s.finished:
            return s.finished  # the lookup already completed: never press Semak again
        if not ANSWER_RE.match(answer or ""):
            return self._awaiting(s, "invalid_answer")
        if s.guard.busy():
            return {"status": "in_progress"}
        async with s.guard.lock:
            s.touched = self._clock()
            return await self._answer(s, answer)

    async def _answer(self, s: Session, answer: str) -> dict[str, Any]:
        p = s.portal
        t0 = self._clock()
        try:
            # The portal swaps its CAPTCHA every 120 s. If the image changed since the voter saw it,
            # their digits are for a dead CAPTCHA: show the new one instead of submitting.
            if await p.captcha_src() != s.captcha_src:
                s.captcha_src, s.captcha_png = await p.captcha()
                return self._awaiting(s, "captcha_expired")
            await p.fill_ic(s.ic)
            await p.fill_answer(answer)
            await self.throttle.wait(urlsplit(SPR_URL).hostname or "spr")
            s.attempts += 1
            await s.guard.once("submit", p.submit, already_done=p.has_result)
            snap = await p.snapshot()
        except Exception as e:  # noqa: BLE001
            # The outcome of the submission is unknown. Do not resubmit; end the session.
            reason = "timeout" if _is_timeout(e) else "layout"
            self.stats.record("submit", (self._clock() - t0) * 1000, False, reason)
            log.warning("submit failed (%s): %s", reason, e)
            return await self._finish(s, {"status": "unavailable" if reason == "timeout" else "unexpected_layout",
                                          "reason": reason})

        outcome = classify(snap, s.ic)
        st = outcome["status"]
        self.stats.record("submit", (self._clock() - t0) * 1000, st in ("found", "not_registered"), st)
        if st in ("captcha_wrong", "portal_message"):
            # Verified rejection: the portal is back on its form, so a new attempt is safe.
            if s.attempts >= MAX_CAPTCHA_ATTEMPTS:
                return await self._finish(s, {"status": "too_many_attempts"})
            s.guard.reset("submit")
            try:
                if not snap.get("has_form"):
                    await p.open()
                s.captcha_src, s.captcha_png = await p.captcha()
            except Exception as e:  # noqa: BLE001
                log.warning("could not reload captcha: %s", e)
                return await self._finish(s, {"status": "unavailable", "reason": "reload"})
            res = self._awaiting(s, st)
            if st == "portal_message":
                res["message"] = outcome.get("message", "")
            return res
        ic = s.ic
        final = await self._finish(s, outcome)
        if st == "found":
            # The IC goes back to the API once, with the result, so it can bind the record to the
            # job; the copy kept for repeated requests has no IC.
            return {**final, "ic": ic}
        return final

    async def refresh(self, job_id: str) -> dict[str, Any]:
        s = self.sessions.get(job_id)
        if s is None:
            return {"status": "expired"}
        if s.finished:
            return s.finished
        if s.refreshes >= MAX_REFRESHES:
            return self._awaiting(s, "refresh_limit")
        if s.guard.busy():
            return {"status": "in_progress"}
        async with s.guard.lock:
            s.touched = self._clock()
            try:
                await self.throttle.wait(urlsplit(SPR_URL).hostname or "spr")
                await s.portal.refresh_captcha(s.captcha_src)
                s.captcha_src, s.captcha_png = await s.portal.captcha()
                s.refreshes += 1
                self.stats.record("refresh", 0, True)
            except Exception as e:  # noqa: BLE001
                self.stats.record("refresh", 0, False, "timeout" if _is_timeout(e) else "layout")
                return await self._finish(s, {"status": "unavailable", "reason": "refresh"})
            return self._awaiting(s)

    async def cancel(self, job_id: str) -> None:
        s = self.sessions.get(job_id)
        if s is not None:
            await self._finish(s, s.finished or {"status": "cancelled"})
            self.sessions.pop(job_id, None)

    async def _finish(self, s: Session, outcome: dict[str, Any]) -> dict[str, Any]:
        """Terminal outcome: close the browser context now, keep the outcome briefly so a repeated
        request gets the same answer instead of a second lookup."""
        if s.finished is None:
            s.finished = outcome
            portal, ctx = s.portal, s.ctx
            s.portal = s.ctx = None
            s.ic = ""  # nothing sensitive stays in memory once the lookup is over
            try:
                await self._discard(portal, ctx)
            finally:
                self.slots.release()
        return s.finished

    async def _abort_start(self, portal, ctx) -> None:
        try:
            await self._discard(portal, ctx)
        finally:
            self.slots.release()

    async def _discard(self, portal, ctx) -> None:
        try:
            if portal is not None:
                await portal.close()
        finally:
            if ctx is not None and self._release is not None:
                await self._release(ctx)

    async def sweep(self) -> None:
        now = self._clock()
        for sid, s in list(self.sessions.items()):
            if s.finished is None and now - s.created > SESSION_TTL:
                await self._finish(s, {"status": "expired"})
            if s.finished is not None and now - s.touched > 60:
                self.sessions.pop(sid, None)


# ---------------------------------------------------------------- HTTP server


def make_app(service: SprService):
    from aiohttp import web

    @web.middleware
    async def auth(request, handler):
        if request.path != "/health":
            got = request.headers.get("X-Internal-Token", "")
            if not INTERNAL_TOKEN or not hmac.compare_digest(got, INTERNAL_TOKEN):
                return web.json_response({"status": "unauthorized"}, status=401)
        return await handler(request)

    async def body(request) -> dict:
        try:
            data = await request.json()
            return data if isinstance(data, dict) else {}
        except Exception:  # noqa: BLE001
            return {}

    async def start(request):
        data = await body(request)
        job = str(data.get("job_id", ""))
        if not re.fullmatch(r"[0-9a-f-]{36}", job):
            return web.json_response({"status": "invalid_input"}, status=400)
        return web.json_response(await service.start(job, str(data.get("ic", ""))))

    async def answer(request):
        data = await body(request)
        return web.json_response(await service.answer(request.match_info["id"], str(data.get("answer", ""))))

    async def refresh(request):
        return web.json_response(await service.refresh(request.match_info["id"]))

    async def cancel(request):
        await service.cancel(request.match_info["id"])
        return web.json_response({"status": "cancelled"})

    async def health(_):
        return web.json_response({"status": "ok"})

    async def stats(_):
        open_sessions = sum(1 for s in service.sessions.values() if s.finished is None)
        return web.json_response({"open_sessions": open_sessions, "capacity": service.capacity,
                                  "in_use": service.capacity - service.slots._value, "waiting": service.waiting,
                                  **service.stats.snapshot()})

    app = web.Application(middlewares=[auth], client_max_size=4096)
    app.router.add_post("/sessions", start)
    app.router.add_post("/sessions/{id}/captcha", answer)
    app.router.add_post("/sessions/{id}/refresh", refresh)
    app.router.add_delete("/sessions/{id}", cancel)
    app.router.add_get("/health", health)
    app.router.add_get("/stats", stats)
    return app


async def main() -> None:
    from aiohttp import web

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    install_redaction()
    if not INTERNAL_TOKEN:
        # Demo deployments run this container too; without a token every request is refused.
        log.warning("SPR_INTERNAL_TOKEN not set: lookups disabled")
    s = settings_mod.load("SPR_MAX_CONCURRENT_PAGES", 12)
    # Launching Firefox costs ~6-10 s, so keep it warm: launch at start-up, close only after a long idle.
    browser = CamoufoxBrowser(s, idle_close=float(os.environ.get("SPR_BROWSER_IDLE_CLOSE_S", "1800")), locale="ms-MY")

    async def open_portal():
        ctx = await browser.new_context()
        if BLOCK_ASSETS:
            await ctx.route("**/*", _route_filter)
        page = await ctx.new_page()
        return CamoufoxPortal(ctx, page, s), ctx

    service = SprService(s, open_portal, release=browser.close_context)
    runner = web.AppRunner(make_app(service), access_log=None)  # paths carry no IC, but keep logs quiet
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", int(os.environ.get("SPR_PORT", "8090"))).start()
    try:
        await browser.warm()
    except Exception as e:  # noqa: BLE001 - the first lookup will launch it instead
        log.warning("browser warm-up failed: %s", e)
    log.info("spr lookup service ready (pages=%d, ttl=%ss, headless=%s, block_assets=%s)", s.browser.max_concurrent_pages,
             SESSION_TTL, s.browser.headless, BLOCK_ASSETS)
    while True:
        await asyncio.sleep(10)
        await service.sweep()
        await browser.close_if_idle()


if __name__ == "__main__":
    asyncio.run(main())
