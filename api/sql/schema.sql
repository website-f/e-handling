-- e-Handling schema. Idempotent: runs on every API boot under an advisory lock.

CREATE TABLE IF NOT EXISTS localities (
  code      text PRIMARY KEY,          -- 173/23/01/001 (parlimen/dun/daerah mengundi/lokaliti)
  state     text NOT NULL,
  par_code  text NOT NULL,             -- 173
  par_name  text NOT NULL,
  dun_code  text NOT NULL,             -- 173/23
  dun_name  text NOT NULL,
  dm_code   text NOT NULL,             -- 173/23/01
  dm_name   text NOT NULL,
  name      text NOT NULL
);
CREATE INDEX IF NOT EXISTS localities_par_idx ON localities (par_code);

CREATE TABLE IF NOT EXISTS voters (
  ic            text PRIMARY KEY CHECK (ic ~ '^[0-9]{12}$'),
  full_name     text NOT NULL,
  dob           date NOT NULL,
  gender        text NOT NULL CHECK (gender IN ('LELAKI', 'PEREMPUAN')),
  locality_code text NOT NULL REFERENCES localities (code),
  is_demo       boolean NOT NULL DEFAULT false,   -- generated on the fly by DEMO_FALLBACK
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Candidates come live from ElectionData.MY (electiondata.go); the old sample table is retired.
DROP TABLE IF EXISTS candidates;

CREATE TABLE IF NOT EXISTS survey_questions (
  id       text PRIMARY KEY,
  position smallint NOT NULL,
  prompt   text NOT NULL,
  options  jsonb NOT NULL,             -- [{"key":"A","label":"..."}]
  active   boolean NOT NULL DEFAULT true
);

-- One row per voter. A resubmission overwrites answers and bumps submit_count.
CREATE TABLE IF NOT EXISTS responses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ic           text NOT NULL UNIQUE REFERENCES voters (ic),
  par_code     text NOT NULL,
  answers      jsonb NOT NULL,
  submit_count integer NOT NULL DEFAULT 1,
  ip_hash      text,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS responses_updated_idx ON responses (updated_at DESC);
CREATE INDEX IF NOT EXISTS responses_par_idx ON responses (par_code);

-- Candidate portraits, keyed by ElectionData.MY candidate uid. The API enqueues; the photos
-- worker (photos/worker.py) searches, face-crops and fills `options`; an admin approves.
-- Only status='approved' rows are ever shown to voters.
CREATE TABLE IF NOT EXISTS candidate_photos (
  uid         text PRIMARY KEY,
  name        text NOT NULL,
  party       text NOT NULL DEFAULT '',
  seat        text NOT NULL DEFAULT '',
  state       text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued', 'searching', 'pending', 'approved', 'rejected', 'not_found', 'error')),
  source      text,                          -- wikipedia | web
  image_path  text,                          -- "/photos/<uid>-<hash>.webp", served by the gateway
  source_url  text,
  page_url    text,
  options     jsonb NOT NULL DEFAULT '[]',   -- [{path, source, source_url, page_url, title, faces, score}]
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text,
  queued_at   timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS candidate_photos_queue_idx ON candidate_photos (status, queued_at);

-- Where a voter row came from: 'seed' (demo data), 'demo' (DEMO_FALLBACK) or 'spr' (confirmed
-- on MySPR Semak by the voter themselves). SPR rows without a survey response are purged after
-- SPR_VOTER_RETENTION (spr_retention.go).
ALTER TABLE voters ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'seed';
ALTER TABLE voters ADD COLUMN IF NOT EXISTS verified_at timestamptz;
ALTER TABLE voters ADD COLUMN IF NOT EXISTS polling_centre text NOT NULL DEFAULT '';
ALTER TABLE voters ADD COLUMN IF NOT EXISTS stream text NOT NULL DEFAULT '';
ALTER TABLE voters ADD COLUMN IF NOT EXISTS voting_time text NOT NULL DEFAULT '';
UPDATE voters SET source = 'demo' WHERE is_demo AND source = 'seed';
CREATE INDEX IF NOT EXISTS voters_spr_idx ON voters (verified_at) WHERE source = 'spr';

-- Audit trail for MySPR lookups. Never the IC itself: a keyed hash (to bind a job to its IC) and
-- a masked form an operator can read. Purged after SPR_AUDIT_RETENTION.
CREATE TABLE IF NOT EXISTS spr_lookups (
  id               uuid PRIMARY KEY,
  ic_hash          text NOT NULL,
  ic_masked        text NOT NULL,
  operator         text NOT NULL DEFAULT 'voter',   -- self-service: the voter looks up their own IC
  ip_hash          text,
  status           text NOT NULL,
  reason           text,
  captcha_attempts integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz
);
CREATE INDEX IF NOT EXISTS spr_lookups_created_idx ON spr_lookups (created_at DESC);

-- Workflow phases. 'candidates' = one admin "scan" of every seat's candidates and their photos.
-- The SPR lookup stays closed until the latest candidates phase reaches a completed state.
CREATE TABLE IF NOT EXISTS pipeline_phases (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL,
  status      text NOT NULL
              CHECK (status IN ('pending', 'processing', 'completed', 'completed_with_warnings', 'failed')),
  total       integer NOT NULL DEFAULT 0,
  detail      jsonb NOT NULL DEFAULT '{}',
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS pipeline_phases_name_idx ON pipeline_phases (name, id DESC);
ALTER TABLE candidate_photos ADD COLUMN IF NOT EXISTS phase_id bigint;
CREATE INDEX IF NOT EXISTS candidate_photos_phase_idx ON candidate_photos (phase_id, status);
