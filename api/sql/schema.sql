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
