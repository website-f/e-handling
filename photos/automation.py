"""Reusable browser-interaction layer: one click per intended action, bounded retries, pacing,
request de-duplication, security-challenge detection and PII-safe logging.

Nothing here tries to hide automation: no random mouse paths, no proxy rotation, no CAPTCHA
solving. When a site shows a CAPTCHA, an access-denied page or a login wall, callers get a
SecurityChallenge and stop (or hand the challenge to a human, as the SPR lookup does).
"""

from __future__ import annotations

import asyncio
import logging
import random
import re
import time
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, TypeVar
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from settings import Settings

T = TypeVar("T")

# ---------------------------------------------------------------- PII redaction

# MyKad numbers (with or without dashes) and the other IDs the SPR form accepts. Applied to every
# log record, so an ID can't leak through an exception message either.
_IC_RE = re.compile(r"(?<![\d-])\d{6}-?\d{2}-?\d{4}(?!\d)")
_SERVICE_ID_RE = re.compile(r"\b(?:RFS?|T|G)\d{4,10}\b")


def redact(text: str) -> str:
    return _SERVICE_ID_RE.sub("[ID]", _IC_RE.sub("[IC]", text))


class RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if record.args:
            try:
                record.msg = record.getMessage()
            except Exception:  # noqa: BLE001 - leave a malformed record as it was
                return True
            record.args = None
        record.msg = redact(str(record.msg))
        return True


def install_redaction(logger: logging.Logger | None = None) -> None:
    target = logger or logging.getLogger()
    for h in target.handlers or logging.getLogger().handlers:
        if not any(isinstance(f, RedactingFilter) for f in h.filters):
            h.addFilter(RedactingFilter())


def mask_ic(ic: str) -> str:
    """990123125571 -> 990123****71 (enough for an operator to tell rows apart)."""
    return ic[:6] + "*" * max(0, len(ic) - 8) + ic[-2:] if len(ic) >= 8 else "*" * len(ic)


# ---------------------------------------------------------------- URLs and stats


def normalize_url(url: str) -> str:
    """Canonical form used for de-duplication: lower-case scheme/host, no default port, no
    fragment, sorted query."""
    u = urlsplit(url.strip())
    host = (u.hostname or "").lower()
    port = u.port
    if port and not ((u.scheme == "http" and port == 80) or (u.scheme == "https" and port == 443)):
        host = f"{host}:{port}"
    query = urlencode(sorted(parse_qsl(u.query, keep_blank_values=True)))
    return urlunsplit((u.scheme.lower(), host, u.path or "/", query, ""))


@dataclass
class RequestStats:
    """Observable request counters: totals per kind, retries, failures and cumulative duration."""

    counts: Counter = field(default_factory=Counter)
    retries: Counter = field(default_factory=Counter)
    failures: Counter = field(default_factory=Counter)
    dedup_hits: int = 0
    duration_ms: Counter = field(default_factory=Counter)

    def record(self, kind: str, ms: float, ok: bool, reason: str = "") -> None:
        self.counts[kind] += 1
        self.duration_ms[kind] += int(ms)
        if not ok:
            self.failures[f"{kind}:{reason or 'error'}"] += 1

    def snapshot(self) -> dict[str, Any]:
        return {
            "requests": dict(self.counts), "retries": dict(self.retries), "failures": dict(self.failures),
            "dedup_hits": self.dedup_hits, "duration_ms": dict(self.duration_ms),
        }


# ---------------------------------------------------------------- pacing


class Throttle:
    """Minimum gap between actions against the same host, drawn from [min, max] ms.

    Keeps the load on a site predictable. Concurrent callers queue behind one lock per host."""

    def __init__(self, min_ms: int, max_ms: int, clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], Awaitable[None]] = asyncio.sleep) -> None:
        self.min_ms, self.max_ms = min_ms, max(max_ms, min_ms)
        self._last: dict[str, float] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._clock, self._sleep = clock, sleep

    async def wait(self, key: str) -> None:
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            last = self._last.get(key)
            if last is not None:
                gap = random.uniform(self.min_ms, self.max_ms) / 1000
                remaining = last + gap - self._clock()
                if remaining > 0:
                    await self._sleep(remaining)
            self._last[key] = self._clock()


# ---------------------------------------------------------------- retries


class TransientError(RuntimeError):
    """Safe to retry: the action is idempotent and the failure looked temporary."""

    def __init__(self, msg: str, retry_after: float | None = None) -> None:
        super().__init__(msg)
        self.retry_after = retry_after


class SecurityChallenge(RuntimeError):
    """CAPTCHA, access-denied or login wall. Never retried automatically."""

    def __init__(self, kind: str, detail: str = "") -> None:
        super().__init__(f"{kind}: {detail}" if detail else kind)
        self.kind = kind


async def with_retries(fn: Callable[[], Awaitable[T]], *, retries: int, backoff_ms: int, stats: RequestStats | None = None,
                       kind: str = "request", respect_retry_after: bool = True, max_retry_after_s: float = 60,
                       sleep: Callable[[float], Awaitable[None]] = asyncio.sleep) -> T:
    """Run `fn`, retrying only TransientError, at most `retries` extra times with exponential backoff.

    Use only for idempotent work (page loads, GETs). A Retry-After longer than `max_retry_after_s`
    is not slept through: the error propagates so the caller can stop and report."""
    attempt = 0
    while True:
        try:
            return await fn()
        except TransientError as e:
            if attempt >= retries:
                raise
            delay = backoff_ms / 1000 * (2 ** attempt)
            if respect_retry_after and e.retry_after is not None:
                if e.retry_after > max_retry_after_s:
                    raise
                delay = max(delay, e.retry_after)
            attempt += 1
            if stats is not None:
                stats.retries[kind] += 1
            await sleep(delay)


def parse_retry_after(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        return None  # HTTP-date form: treat as unknown and fall back to our own backoff


# ---------------------------------------------------------------- de-duplication


class Deduper:
    """Collapses concurrent identical requests and (optionally) caches results for `ttl` seconds.

    Keys are `(workflow, normalized url)` so the same resource fetched by two workflows with
    different needs is not wrongly shared."""

    def __init__(self, ttl: float = 300, enabled: bool = True, cache: bool = True, stats: RequestStats | None = None,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self.ttl, self.enabled, self.cache = ttl, enabled, cache
        self.stats = stats
        self._inflight: dict[tuple[str, str], asyncio.Future] = {}
        self._done: dict[tuple[str, str], tuple[float, Any]] = {}
        self._clock = clock

    async def run(self, workflow: str, url: str, fn: Callable[[], Awaitable[T]]) -> T:
        if not self.enabled:
            return await fn()
        key = (workflow, normalize_url(url))
        hit = self._done.get(key)
        if hit and self._clock() - hit[0] < self.ttl:
            self._hit()
            return hit[1]
        if key in self._inflight:
            self._hit()
            return await asyncio.shield(self._inflight[key])
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._inflight[key] = fut
        try:
            result = await fn()
        except BaseException as e:
            fut.set_exception(e)
            fut.exception()  # mark retrieved: waiters re-raise it, nobody else needs to
            raise
        else:
            fut.set_result(result)
            if self.cache:
                self._done[key] = (self._clock(), result)
            return result
        finally:
            self._inflight.pop(key, None)

    def _hit(self) -> None:
        if self.stats is not None:
            self.stats.dedup_hits += 1


# ---------------------------------------------------------------- security challenges

_CHALLENGE_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("access_denied", re.compile(r"access denied|forbidden|request blocked|you have been blocked|akses dinafikan", re.I)),
    ("bot_check", re.compile(r"attention required|just a moment\.\.\.|checking your browser|verify you are human|"
                             r"unusual traffic|are you a robot|cf-challenge|challenge-platform", re.I)),
    ("captcha", re.compile(r"g-recaptcha|hcaptcha|cf-turnstile|captcha", re.I)),
    ("authentication", re.compile(r"please (?:log|sign) ?in|sila log ?masuk|session expired", re.I)),
]


def detect_challenge(status: int | None, title: str, text: str, *, expected_captcha: bool = False) -> str | None:
    """Classify a page as a security control, or None if it looks like ordinary content.

    `expected_captcha` is for pages whose normal form includes a CAPTCHA the user solves
    themselves (the SPR portal); there a CAPTCHA is not a reason to stop."""
    if status in (401, 407):
        return "authentication"
    if status in (403, 451):
        return "access_denied"
    if status == 429:
        return "rate_limited"
    blob = f"{title}\n{text[:20000]}"
    for kind, pat in _CHALLENGE_PATTERNS:
        if kind == "captcha" and expected_captcha:
            continue
        if pat.search(blob):
            return kind
    return None


# ---------------------------------------------------------------- single-shot actions


class ActionGuard:
    """Per-page/per-form guard: one action at a time, and each named action performed once.

    `once()` first asks `already_done()` whether the effect is already visible on the page (for
    example, the result is shown), so a retry after an ambiguous failure never repeats a
    submission. Only `reset(name)`, called after verifying the previous attempt was rejected,
    allows the same action again."""

    def __init__(self) -> None:
        self.lock = asyncio.Lock()
        self.done: set[str] = set()
        self.performed: Counter = Counter()

    def busy(self) -> bool:
        return self.lock.locked()

    async def once(self, name: str, perform: Callable[[], Awaitable[Any]],
                   already_done: Callable[[], Awaitable[bool]] | None = None) -> bool:
        """True if the action ran now, False if it had already happened."""
        if name in self.done:
            return False
        if already_done is not None and await already_done():
            self.done.add(name)
            return False
        self.done.add(name)  # before performing: an exception mid-click must not allow a second click
        self.performed[name] += 1
        await perform()
        return True

    def reset(self, name: str) -> None:
        self.done.discard(name)


async def wait_actionable(locator, timeout_ms: int) -> None:
    """Visible and enabled, or raise. Playwright's own actionability checks run again on click."""
    await locator.wait_for(state="visible", timeout=timeout_ms)
    deadline = time.monotonic() + timeout_ms / 1000
    while not await locator.is_enabled():
        if time.monotonic() > deadline:
            raise TimeoutError("element stayed disabled")
        await asyncio.sleep(0.1)


# ---------------------------------------------------------------- browser


class CamoufoxBrowser:
    """One lazily launched Camoufox (Firefox) process, shared by every page of a service.

    The browser closes itself after `idle_close` seconds without use (and no open contexts) to
    give the memory back. Callers bound concurrency themselves (browser.max_concurrent_pages)."""

    def __init__(self, settings: Settings, idle_close: float = 300, locale: str = "en-US") -> None:
        self.settings = settings
        self.idle_close = idle_close
        self.locale = locale
        self._manager = None
        self._browser = None
        self._launch_lock = asyncio.Lock()
        self._open = 0
        self.last_used = 0.0

    async def _ensure(self):
        async with self._launch_lock:
            if self._browser is None:
                from camoufox.async_api import AsyncCamoufox

                logging.getLogger("automation").info("launching camoufox (headless=%s)", self.settings.browser.headless)
                self._manager = AsyncCamoufox(headless=self.settings.browser.headless, humanize=False, block_webrtc=True,
                                              locale=self.locale, i_know_what_im_doing=True)
                self._browser = await self._manager.__aenter__()
            return self._browser

    async def warm(self) -> None:
        """Launch now so the first user does not wait for Firefox to start."""
        await self._ensure()
        self.last_used = time.monotonic()

    async def new_context(self):
        """Fresh cookie jar (one per voter session). Caller must hold a slot and close it."""
        browser = await self._ensure()
        self.last_used = time.monotonic()
        ctx = await browser.new_context(locale=self.locale)
        ctx.set_default_navigation_timeout(self.settings.browser.navigation_timeout_ms)
        ctx.set_default_timeout(self.settings.browser.action_timeout_ms)
        self._open += 1
        return ctx

    async def close_context(self, ctx) -> None:
        try:
            await ctx.close()
        except Exception:  # noqa: BLE001 - already gone with the browser
            pass
        self._open = max(0, self._open - 1)
        self.last_used = time.monotonic()

    async def new_page(self):
        browser = await self._ensure()
        self.last_used = time.monotonic()
        page = await browser.new_page()
        page.set_default_navigation_timeout(self.settings.browser.navigation_timeout_ms)
        page.set_default_timeout(self.settings.browser.action_timeout_ms)
        return page

    async def close_if_idle(self) -> None:
        if self._browser is not None and self._open == 0 and time.monotonic() - self.last_used > self.idle_close:
            await self.close()

    async def close(self) -> None:
        if self._manager is not None:
            try:
                await self._manager.__aexit__(None, None, None)
            except Exception:  # noqa: BLE001
                pass
            logging.getLogger("automation").info("camoufox closed")
        self._manager = self._browser = None
        self._open = 0
