import asyncio
import logging

import pytest

from automation import (
    ActionGuard, Deduper, RedactingFilter, RequestStats, SecurityChallenge, Throttle, TransientError, detect_challenge,
    mask_ic, normalize_url, parse_retry_after, redact, with_retries,
)


def run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------- single click


def test_action_runs_once_even_when_called_twice():
    guard = ActionGuard()
    clicks = []

    async def click():
        clicks.append(1)

    async def go():
        assert await guard.once("submit", click) is True
        assert await guard.once("submit", click) is False

    run(go())
    assert clicks == [1]
    assert guard.performed["submit"] == 1


def test_action_skipped_when_effect_already_visible():
    guard = ActionGuard()
    clicks = []

    async def click():
        clicks.append(1)

    async def done():
        return True

    assert run(guard.once("submit", click, already_done=done)) is False
    assert clicks == []


def test_failed_click_is_not_repeated_without_reset():
    guard = ActionGuard()
    calls = []

    async def boom():
        calls.append(1)
        raise TimeoutError("navigation")

    async def go():
        with pytest.raises(TimeoutError):
            await guard.once("submit", boom)
        assert await guard.once("submit", boom) is False  # outcome unknown: never click again
        guard.reset("submit")  # only after the caller verified a rejection
        with pytest.raises(TimeoutError):
            await guard.once("submit", boom)

    run(go())
    assert len(calls) == 2


def test_guard_lock_reports_busy():
    guard = ActionGuard()

    async def go():
        async with guard.lock:
            assert guard.busy()
        assert not guard.busy()

    run(go())


# ---------------------------------------------------------------- retries


def test_retries_are_bounded_with_exponential_backoff():
    sleeps, calls = [], []
    stats = RequestStats()

    async def fake_sleep(s):
        sleeps.append(s)

    async def flaky():
        calls.append(1)
        raise TransientError("503")

    with pytest.raises(TransientError):
        run(with_retries(flaky, retries=2, backoff_ms=1000, stats=stats, kind="open", sleep=fake_sleep))
    assert len(calls) == 3  # first try + 2 retries
    assert sleeps == [1.0, 2.0]
    assert stats.retries["open"] == 2


def test_retry_after_is_respected_and_long_ones_stop():
    sleeps = []

    async def fake_sleep(s):
        sleeps.append(s)

    attempts = []

    async def limited():
        attempts.append(1)
        if len(attempts) == 1:
            raise TransientError("429", retry_after=7)
        return "ok"

    assert run(with_retries(limited, retries=2, backoff_ms=1000, sleep=fake_sleep)) == "ok"
    assert sleeps == [7]

    async def very_limited():
        raise TransientError("429", retry_after=3600)

    with pytest.raises(TransientError):
        run(with_retries(very_limited, retries=2, backoff_ms=1000, max_retry_after_s=60, sleep=fake_sleep))
    assert sleeps == [7]  # did not sleep for an hour


def test_non_transient_errors_are_not_retried():
    calls = []

    async def fn():
        calls.append(1)
        raise SecurityChallenge("captcha")

    with pytest.raises(SecurityChallenge):
        run(with_retries(fn, retries=5, backoff_ms=1))
    assert calls == [1]


def test_parse_retry_after():
    assert parse_retry_after("12") == 12
    assert parse_retry_after(None) is None
    assert parse_retry_after("Wed, 21 Oct 2026 07:28:00 GMT") is None


# ---------------------------------------------------------------- dedup and pacing


def test_concurrent_identical_requests_collapse():
    calls = []
    stats = RequestStats()
    d = Deduper(stats=stats)

    async def fetch():
        calls.append(1)
        await asyncio.sleep(0.01)
        return "body"

    async def go():
        return await asyncio.gather(
            d.run("wf", "https://Example.com/a?b=2&a=1#x", fetch),
            d.run("wf", "https://example.com:443/a?a=1&b=2", fetch),
        )

    assert run(go()) == ["body", "body"]
    assert calls == [1]
    assert stats.dedup_hits == 1


def test_dedupe_is_scoped_by_workflow_and_cache_expires():
    now = [0.0]
    d = Deduper(ttl=10, clock=lambda: now[0])
    calls = []

    async def fetch():
        calls.append(1)
        return len(calls)

    async def go():
        assert await d.run("a", "https://x.test/", fetch) == 1
        assert await d.run("a", "https://x.test/", fetch) == 1  # cached
        assert await d.run("b", "https://x.test/", fetch) == 2  # other workflow
        now[0] = 11
        assert await d.run("a", "https://x.test/", fetch) == 3  # expired

    run(go())


def test_normalize_url():
    assert normalize_url("HTTPS://Ex.COM:443/p?b=1&a=2#frag") == "https://ex.com/p?a=2&b=1"
    assert normalize_url("http://ex.com:8080") == "http://ex.com:8080/"


def test_throttle_spaces_actions():
    now = [100.0]
    slept = []

    async def fake_sleep(s):
        slept.append(s)
        now[0] += s

    t = Throttle(500, 500, clock=lambda: now[0], sleep=fake_sleep)

    async def go():
        await t.wait("host")
        await t.wait("host")
        await t.wait("other")

    run(go())
    assert slept == [pytest.approx(0.5)]


# ---------------------------------------------------------------- challenges and redaction


@pytest.mark.parametrize("status,title,text,expected", [
    (403, "", "", "access_denied"),
    (429, "", "", "rate_limited"),
    (200, "Just a moment...", "", "bot_check"),
    (200, "", "Our systems have detected unusual traffic", "bot_check"),
    (200, "", '<div class="g-recaptcha">', "captcha"),
    (200, "", "Sila log masuk untuk teruskan", "authentication"),
    (200, "Semakan Daftar Pemilih", "Nama\tAHMAD", None),
])
def test_detect_challenge(status, title, text, expected):
    assert detect_challenge(status, title, text) == expected


def test_expected_captcha_form_is_not_a_challenge():
    assert detect_challenge(200, "MySPR Semak", "CAPTCHA  Aksara Captcha", expected_captcha=True) is None
    assert detect_challenge(200, "MySPR Semak", "CAPTCHA", expected_captcha=False) == "captcha"


def test_redaction_of_ids():
    assert redact("lookup 990123125571 failed") == "lookup [IC] failed"
    assert redact("ic=990123-12-5571 ok") == "ic=[IC] ok"
    assert redact("service RF123456 and T12345") == "service [ID] and [ID]"
    assert redact("job 5a7c3f0e-1111-2222-3333-444455556666 took 1234567890123 ms") == \
        "job 5a7c3f0e-1111-2222-3333-444455556666 took 1234567890123 ms"
    assert mask_ic("990123125571") == "990123****71"


def test_redacting_filter_covers_args_and_exceptions(caplog):
    logger = logging.getLogger("redact-test")
    logger.addFilter(RedactingFilter())
    with caplog.at_level(logging.INFO, logger="redact-test"):
        logger.info("start ic=%s", "990123125571")
        logger.warning("boom: %s", ValueError("bad 470621125137"))
    text = caplog.text
    assert "990123125571" not in text and "470621125137" not in text
    assert text.count("[IC]") == 2
