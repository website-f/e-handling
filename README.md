# e-Handling

Proof of concept: a voter checks their IC, sees their registered voting place and the parliamentary candidates, then answers two survey questions. Answers are stored and exposed through an admin API and dashboard.

Voter data is **fictional**; candidate data is real public data from ElectionData.MY.

## Run

```bash
cp .env.example .env      # then change the three secrets
docker compose up -d --build
```

| URL | What |
|---|---|
| http://localhost:8800 | Voter flow (mobile first) |
| http://localhost:8800/admin | Admin dashboard (sign in with `ADMIN_API_KEY` from `.env`) |
| http://localhost:8800/api/health | Health of DB + cache |
| `127.0.0.1:8805` | Postgres (local inspection only) |

Ports 8800-8809 are reserved for this project. Frontend hot-reload: `cd frontend && npm run dev` (port 8806, proxies `/api` to the stack on 8800).

### Demo ICs

| IC | Voter |
|---|---|
| 990123-12-5571 | MOHD FITRI BIN MANSOR, KG PETAGAS, P.173 PUTATAN |
| 470621-12-5137 | ABDUL RAHMAN BIN SALLEH (elderly persona) |
| 650812-12-5246 | SITI AMINAH BINTI MATSAH |
| 580304-12-5013 | LIM CHEE KONG, P.172 KOTA KINABALU |
| 720915-12-6288 | ROSALINE MOJUNTIN, P.174 PENAMPANG |

With `DEMO_FALLBACK=true` any other valid IC (real date, age 18+) gets a generated fictional voter, so a live demo never dead-ends. Date of birth and gender always come from the IC digits. Set it to `false` to return "not registered" instead.

## Live (VPS)

https://handling.oriondesk.space runs on 84.46.249.133 in `/opt/e-handling`. Orxies (`/opt/proxy-go`) terminates TLS and proxies to the gateway on `127.0.0.1:8800`; its site file is `/opt/proxy-go/sites/handling.oriondesk.space.yml`. Postgres and Redis are not published at all ([docker-compose.vps.yml](docker-compose.vps.yml)).

```bash
./deploy/deploy-vps.sh          # from this folder: ships source, rebuilds, waits for /api/health
```

The VPS keeps its own `.env` (created with random secrets on first deploy, never overwritten) and its Postgres volume. Admin key: `ssh -i ~/.ssh/vps_rizqmall root@84.46.249.133 "grep ADMIN_API_KEY /opt/e-handling/.env"`. Orxies dashboard: `ssh -L 8090:127.0.0.1:8090 root@84.46.249.133`, then http://localhost:8090.

## Stack

```
browser ──> gateway (nginx) ──> api (Go, N replicas) ──> PostgreSQL 17
             static SPA            stateless              └─> Redis 7 (cache)
             rate limits
             load balancing
```

| Layer | Choice | Why for high traffic |
|---|---|---|
| Frontend | React 19 + Vite + Tailwind v4 + shadcn/ui | Static files served by nginx with immutable caching; admin console is a separate lazy chunk |
| Gateway | nginx 1.29 | Per-IP rate limiting, keepalive pool to the API, `least_conn` balancing, auto-discovers scaled replicas through Docker DNS |
| API | Go (stdlib `net/http`, pgx, go-redis) | Low memory per request, tens of thousands of req/s per core, single static binary in a distroless image |
| Database | PostgreSQL 17 | One upsert per submission, indexed lookups, JSONB answers so questions can change without migrations |
| Cache | Redis 7 (LRU, no persistence) | Voter, candidate and question lookups cached 10 min; admin stats 5 s. A Redis outage degrades to Postgres reads instead of failing |

Measured on the dev PC (Docker Desktop, 2 API replicas): **about 19,000 lookups/s at 200 concurrent clients, p50 10 ms, 0 errors**.

Scale out: `API_REPLICAS=6 docker compose up -d` (the gateway picks up the new replicas without a reload). Keep `API_REPLICAS × DB_MAX_CONNS` under Postgres `max_connections` (300), or add PgBouncer.

## Candidate data (ElectionData.MY)

Candidates come live from the [ElectionData.MY Open API](https://electiondata.my/openapi) (CC0), called **server-side only** with `ELECTIONDATA_API_KEY` (in `.env`, never sent to the browser). For a voter's parliament and DUN seat the API shows the **most recent contest**: full ballot with party (full Malay name), coalition, votes, share, result, and each candidate's career record; "Rekod penuh" opens their full history. Next-election candidates only exist after nomination day.

Caching, so a traffic spike never fans out upstream ([api/electiondata.go](api/electiondata.go)): seat/party/candidate reference lists in process memory for 24h (refreshed in the background), each seat's contest in Redis for 6h plus a 7-day stale copy used if the upstream is down, and concurrent misses collapsed into one call. Warm lookups answer in ~6 ms. If nothing is cached and the upstream is down, the voter still gets their details and the candidates screen offers a retry.

Seeded seat numbers (P.172-174, N.19-26 Sabah) are real, so live data lines up; voter names, polling districts and localities stay fictional. Note: the live `/v1/candidates?uid=` returns `{"results": [...]}`, not the bare array the docs describe.

## Candidate photos

[photos/worker.py](photos/worker.py) (container `photos`) fills candidate portraits from a queue the API feeds whenever it serves a contest (or all at once via admin **Foto Calon** > "Cari foto semua calon").

1. **Wikipedia** (ms, then en): the title must match the name *and* the article must mention the candidate's party or seat. Auto-approved.
2. **Camoufox + Bing Images** for `"name" party seat`: a result is kept only if its caption/page names the candidate (>= 50% of name tokens) *and* places them in politics (party, seat, state or words like calon/PRU/ADUN/election). Without that rule "Patrick Payne" matched a horse trainer.
3. Every image is face-checked with OpenCV (no face, tiny face, or more than 3 faces = rejected), cropped square around the face and stored as WebP in the `photos` volume, served by nginx at `/photos/`.

Web finds are **auto-approved only on consensus**: the same face (OpenCV SFace, cosine >= 0.50; different candidates measured up to 0.43) on photos from at least two different sites. Anything else stays **pending** until an admin approves one of up to 4 options (`PHOTO_AUTO_APPROVE`: none | wikipedia | consensus (default) | all). Only approved photos reach voters (the API refreshes its approved index every 20 s). Candidates with no confident match keep the party tile. The worker is paced (`PHOTO_PACE_SECONDS`, default 6 s + jitter) and closes the browser after 5 idle minutes.

Dry run for one candidate: `docker compose run --rm photos python worker.py --test "Name" PARTY "P.173 Putatan"`.

## Flow

1. **Semak**: IC entry with numeric keypad, auto dashes, digit counter, inline errors.
2. **Loading**: 3-step checklist and a skeleton of the next screen (minimum 2.4 s so it reads as deliberate).
3. **Maklumat**: MAKLUMAT PERIBADI PEMILIH + DAFTAR PEMILIH YANG TELAH DISAHKAN.
4. **Calon**: Parlimen / DUN tabs with the latest contest for each seat (ElectionData.MY), winner first, vote share, career record and full-history sheet.
5. **Tinjauan**: 2 questions, one per screen, A-D whole-card options. Resubmitting overwrites the previous answer (one row per IC).
6. **Terima kasih**: answer summary + reference number.

Made for older users: Atkinson Hyperlegible font (designed for low vision), 18px base text with an A / A+ / A++ text-size switch, 56-64px tap targets, AAA-contrast body text, the phone's Back button steps back one screen, light/dark follows the system setting, and reduced motion is respected.

## API

Public (rate limited 30 req/s per IP, burst 60):

```bash
curl -X POST localhost:8800/api/v1/voters/lookup -H 'Content-Type: application/json' \
  -d '{"ic":"990123125571"}'
curl -X POST localhost:8800/api/v1/responses -H 'Content-Type: application/json' \
  -d '{"ic":"990123125571","answers":{"q1":"A","q2":"B"}}'
```

Admin (header `X-API-Key: $ADMIN_API_KEY`, or `Authorization: Bearer ...`):

| Endpoint | Returns |
|---|---|
| `GET /api/admin/stats` | totals, answer counts per option, by parlimen / gender / age band |
| `GET /api/admin/responses?page=1&limit=25&q=&parlimen=` | paginated responses joined with full voter + locality details. `q` = IC prefix or name |
| `GET /api/admin/responses/{id}` | one response |
| `GET /api/admin/export.csv?q=&parlimen=` | streamed CSV (UTF-8 BOM, opens in Excel) |

Error shape: `{"error":"invalid_ic","message":"..."}` with Malay messages shown to users as-is.

## Changing data

Seed data lives in [api/sql/seed.sql](api/sql/seed.sql) and is applied on every API boot (upserts). Edit questions, candidates or localities there, then `docker compose up -d --build api`. Cached copies expire within 10 minutes (or `docker compose restart redis`).

## Before this goes anywhere real

- IC numbers + political opinions are sensitive personal data under PDPA 2010: add explicit consent, a retention policy, encryption at rest, and decide whether to store the IC or only a keyed hash.
- Put TLS in front (the shared Caddy/Orxies edge on the VPS) and lock `/api/admin` to known IPs.
- Remove `DEMO_FALLBACK`, connect a real voter register source, and add bot protection (Turnstile/hCaptcha) on lookup.
- Many Malaysian mobile users share CGNAT IPs: watch 429 rates and tune `limit_req` in [gateway/nginx.conf](gateway/nginx.conf).
- Postgres backups (pg_dump or WAL archiving) and a read replica for the dashboard at scale.

## Tests

```bash
cd api && go test ./...
cd frontend && npm run build   # type-check + build
```
