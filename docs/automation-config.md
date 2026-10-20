# Automation configuration reference

Every setting is an environment variable read at start-up (put it in `.env`; `docker-compose.yml`
passes it to the right container). Timings are operational defaults for stability and politeness,
not ways to look less automated.

## Voter source and the MySPR lookup (`api`)

| Variable | Default | Meaning |
|---|---|---|
| `VOTER_SOURCE` | `demo` | `demo`: fictional register (seed rows + `DEMO_FALLBACK`). `spr`: every voter is confirmed on MySPR Semak; `/api/v1/voters/lookup` is disabled and `DEMO_FALLBACK` is forced off. |
| `SPR_INTERNAL_TOKEN` | (none) | Shared secret between `api` and `spr`. Required when `VOTER_SOURCE=spr`. `deploy/remote-up.sh` generates one. |
| `SPR_WORKER_URL` | `http://spr:8090` | Where the API reaches the lookup service (compose network only). |
| `SPR_REQUIRE_CANDIDATE_PHASE` | `true` | Lookups stay closed (`503 candidates_not_ready`) until the latest candidates phase is `completed` or `completed_with_warnings`. |
| `SPR_VOTER_RETENTION` | `24h` | SPR-confirmed voter rows with no survey response are deleted after this (hourly purge; their cache entries too). |
| `SPR_AUDIT_RETENTION` | `2160h` (90 days) | `spr_lookups` audit rows are deleted after this. |

## Lookup service (`spr`)

| Variable | Default | Meaning |
|---|---|---|
| `SPR_URL` | `https://mysprsemak.spr.gov.my/semakan/daftarPemilih` | The portal form. |
| `SPR_MAX_CONCURRENT_PAGES` | `3` | Voter sessions (isolated browser contexts) open at once. Extra voters wait up to `SPR_SLOT_WAIT_S`, then get "busy". |
| `SPR_SLOT_WAIT_S` | `15` | How long a new lookup waits for a free session slot. |
| `SPR_SESSION_TTL_S` | `240` | A session not finished within this is closed (`expired`). |
| `SPR_MAX_CAPTCHA_ATTEMPTS` | `3` | Wrong CAPTCHAs allowed per session before it ends (`too_many_attempts`). |
| `SPR_MAX_REFRESHES` | `5` | "Gambar lain" presses allowed per session. |
| `SPR_PORT` | `8090` | Internal listen port. |

## Browser (both `photos` and `spr`)

| Variable | Default | Spec name | Meaning |
|---|---|---|---|
| `BROWSER_HEADLESS` | `true` | `browser.headless` | The VPS has no display. Set `false` on a desktop to watch the browser. |
| `BROWSER_NAVIGATION_TIMEOUT_MS` | `30000` | `browser.navigation_timeout_ms` | Page loads. |
| `BROWSER_ACTION_TIMEOUT_MS` | `10000` | `browser.action_timeout_ms` | Waiting for an element to be visible/enabled, fills, clicks. |
| `BROWSER_WAIT_UNTIL` | `domcontentloaded` | `browser.default_wait_until` | Load state used for navigations. |
| `BROWSER_MAX_CONCURRENT_PAGES` | `1` | `browser.max_concurrent_pages` | Photo worker pages (it works one candidate at a time). The SPR service uses `SPR_MAX_CONCURRENT_PAGES`. |

## Execution

| Variable | Default | Spec name | Meaning |
|---|---|---|---|
| `EXEC_MIN_ACTION_INTERVAL_MS` | `500` | `execution.minimum_action_interval_ms` | Minimum gap between actions (page loads, submissions, CAPTCHA refreshes) against one host. |
| `EXEC_MAX_ACTION_INTERVAL_MS` | `1500` | `execution.maximum_action_interval_ms` | Upper bound of that gap. |
| `EXEC_MAX_RETRIES` | `2` | `execution.maximum_retries` | Extra attempts for **idempotent** work only (opening the portal form on 5xx/timeout). A submission is never retried. |
| `EXEC_RETRY_BACKOFF_MS` | `1500` | `execution.retry_backoff_ms` | First backoff; doubles each retry. |
| `EXEC_STOP_ON_AUTH_CHALLENGE` | `true` | `execution.stop_on_authentication_challenge` | Login walls stop the workflow. |
| `EXEC_STOP_ON_CAPTCHA` | `true` | `execution.stop_on_captcha` | Unexpected CAPTCHAs / bot checks stop the workflow (Bing: candidate re-queued after `PHOTO_CHALLENGE_COOLDOWN_MIN`). The SPR form's own CAPTCHA is expected and goes to the voter. |

## Requests

| Variable | Default | Spec name | Meaning |
|---|---|---|---|
| `REQUESTS_CACHE_ENABLED` | `true` | `requests.cache_enabled` | Cache results of de-duplicated requests. |
| `REQUESTS_DEDUPLICATE` | `true` | `requests.deduplicate_requests` | Identical in-flight requests (same workflow + normalized URL) share one call; a repeated SPR start for the same job reuses its session. |
| `REQUESTS_RESPECT_RETRY_AFTER` | `true` | `requests.respect_retry_after` | Honour `Retry-After` on 429/503. |
| `REQUESTS_MAX_RETRY_AFTER_S` | `60` | | A longer `Retry-After` stops the work instead of sleeping. |
| `REQUESTS_MAX_CONCURRENT` | `2` | `requests.maximum_concurrent_requests` | Reserved for parallel fetches; the photo worker is sequential today. |

## Images (`photos`)

| Variable | Default | Spec name | Meaning |
|---|---|---|---|
| `IMAGES_ENABLED` | `true` | `images.enabled` | |
| `IMAGES_ALLOWED_FORMATS` | `jpg,jpeg,png,webp` | `images.allowed_formats` | Checked against the file signature, not the extension. SVG is always refused. |
| `IMAGES_MAX_FILE_SIZE_MB` | `15` | `images.maximum_file_size_mb` | Checked against `Content-Length` and while streaming. |
| `IMAGES_DOWNLOAD_TIMEOUT_S` | `12` | | Per download. |
| `IMAGES_SAVE_METADATA` | `true` | `images.save_metadata` | Writes `<PHOTO_DIR>/meta/<uid>.json` (source URL, page, SHA-256, size, retrieval time, status). The gateway does not serve `/photos/meta/`. |
| `IMAGES_VERIFY_DOWNLOAD` | `true` | `images.verify_download` | Signature + type + size checks; truncated bodies (short of `Content-Length`) are discarded. |
| `PHOTO_CHALLENGE_COOLDOWN_MIN` | `30` | | Delay before retrying a candidate whose search hit a CAPTCHA/block page. |

Existing photo settings (`PHOTO_AUTO_APPROVE`, `PHOTO_PACE_SECONDS`, `PHOTO_SAME_FACE`) are described in the README.

## Job states

`pipeline_phases.status`: `pending`, `processing`, `completed`, `completed_with_warnings` (some
candidates ended without a photo, or a seat could not be loaded), `failed` (no seat could be loaded).

`spr_lookups.status`: `processing`, `awaiting_captcha`, `completed`, `not_registered`, `blocked`,
`unavailable`, `busy`, `unexpected_layout`, `too_many_attempts`, `expired`, `failed`.
