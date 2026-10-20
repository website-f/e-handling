"""Browser, request and image settings shared by the photo worker and the SPR lookup service.

Every value comes from an environment variable so docker-compose / .env stay the single source of
truth. The timing values are operational defaults (politeness and stability), not a way to look
less like automation. See docs/automation-config.md for the full reference.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    return default if v is None or v == "" else v.strip().lower() in ("1", "true", "yes", "on")


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "") or default)
    except ValueError:
        return default


def _list(name: str, default: tuple[str, ...]) -> tuple[str, ...]:
    v = os.environ.get(name, "")
    return tuple(x.strip().lower() for x in v.split(",") if x.strip()) or default


@dataclass(frozen=True)
class BrowserSettings:
    headless: bool = True  # the VPS has no display; set false on a desktop to watch the browser
    navigation_timeout_ms: int = 30000
    action_timeout_ms: int = 10000
    default_wait_until: str = "domcontentloaded"
    max_concurrent_pages: int = 1


@dataclass(frozen=True)
class ExecutionSettings:
    minimum_action_interval_ms: int = 500
    maximum_action_interval_ms: int = 1500
    maximum_retries: int = 2
    retry_backoff_ms: int = 1500
    stop_on_authentication_challenge: bool = True
    stop_on_captcha: bool = True


@dataclass(frozen=True)
class RequestSettings:
    cache_enabled: bool = True
    deduplicate_requests: bool = True
    respect_retry_after: bool = True
    maximum_concurrent_requests: int = 2
    maximum_retry_after_s: int = 60  # a longer Retry-After means "stop for now", not "sleep inline"


@dataclass(frozen=True)
class ImageSettings:
    enabled: bool = True
    allowed_formats: tuple[str, ...] = ("jpg", "jpeg", "png", "webp")
    maximum_file_size_mb: float = 15
    download_timeout_s: float = 12
    save_metadata: bool = True
    verify_download: bool = True

    @property
    def max_bytes(self) -> int:
        return int(self.maximum_file_size_mb * (1 << 20))


@dataclass(frozen=True)
class Settings:
    browser: BrowserSettings = field(default_factory=BrowserSettings)
    execution: ExecutionSettings = field(default_factory=ExecutionSettings)
    requests: RequestSettings = field(default_factory=RequestSettings)
    images: ImageSettings = field(default_factory=ImageSettings)


def load(prefix_pages: str = "BROWSER_MAX_CONCURRENT_PAGES", default_pages: int = 1) -> Settings:
    """Read settings from the environment. `prefix_pages` lets each service size its own page pool."""
    return Settings(
        browser=BrowserSettings(
            headless=_bool("BROWSER_HEADLESS", True),
            navigation_timeout_ms=_int("BROWSER_NAVIGATION_TIMEOUT_MS", 30000),
            action_timeout_ms=_int("BROWSER_ACTION_TIMEOUT_MS", 10000),
            default_wait_until=os.environ.get("BROWSER_WAIT_UNTIL", "domcontentloaded"),
            max_concurrent_pages=max(1, _int(prefix_pages, default_pages)),
        ),
        execution=ExecutionSettings(
            minimum_action_interval_ms=_int("EXEC_MIN_ACTION_INTERVAL_MS", 500),
            maximum_action_interval_ms=_int("EXEC_MAX_ACTION_INTERVAL_MS", 1500),
            maximum_retries=max(0, _int("EXEC_MAX_RETRIES", 2)),
            retry_backoff_ms=_int("EXEC_RETRY_BACKOFF_MS", 1500),
            stop_on_authentication_challenge=_bool("EXEC_STOP_ON_AUTH_CHALLENGE", True),
            stop_on_captcha=_bool("EXEC_STOP_ON_CAPTCHA", True),
        ),
        requests=RequestSettings(
            cache_enabled=_bool("REQUESTS_CACHE_ENABLED", True),
            deduplicate_requests=_bool("REQUESTS_DEDUPLICATE", True),
            respect_retry_after=_bool("REQUESTS_RESPECT_RETRY_AFTER", True),
            maximum_concurrent_requests=max(1, _int("REQUESTS_MAX_CONCURRENT", 2)),
            maximum_retry_after_s=_int("REQUESTS_MAX_RETRY_AFTER_S", 60),
        ),
        images=ImageSettings(
            enabled=_bool("IMAGES_ENABLED", True),
            allowed_formats=_list("IMAGES_ALLOWED_FORMATS", ("jpg", "jpeg", "png", "webp")),
            maximum_file_size_mb=_float("IMAGES_MAX_FILE_SIZE_MB", 15),
            download_timeout_s=_float("IMAGES_DOWNLOAD_TIMEOUT_S", 12),
            save_metadata=_bool("IMAGES_SAVE_METADATA", True),
            verify_download=_bool("IMAGES_VERIFY_DOWNLOAD", True),
        ),
    )
