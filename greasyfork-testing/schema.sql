-- The tables build-db.mjs creates in corpus.db. build-db.mjs runs this file
-- as is, so it is always the database's real schema. Table summaries are in
-- README.md ("Analysis database").

CREATE TABLE Scripts (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL,
  info_page      TEXT NOT NULL,
  script_url     TEXT NOT NULL,
  total_installs INTEGER,
  daily_installs INTEGER,
  ratings_good   INTEGER,
  ratings_ok     INTEGER,
  ratings_bad    INTEGER,
  created_date   TEXT,
  updated_date   TEXT,
  gone_as_of     TEXT,     -- when GreasyFork was found to no longer have it; NULL when it does
  size           INTEGER,  -- bytes on disk; NULL when the body wasn't downloaded
  local_filename TEXT      -- relative to the download root; NULL when absent
);

-- One row per distinct dependency URL. size/local_filename are NULL when the
-- file couldn't be fetched: a dead link, a blocked or unreachable host.
CREATE TABLE RequiresFiles (
  url            TEXT PRIMARY KEY,
  size           INTEGER,
  local_filename TEXT
);

CREATE TABLE ResourceFiles (
  url            TEXT PRIMARY KEY,
  size           INTEGER,
  local_filename TEXT
);

-- Join tables: which script pulls in which dependency. A script listing the
-- same URL twice is recorded once, so counts here are "scripts referencing".
CREATE TABLE ScriptRequiresFiles (
  script_id INTEGER NOT NULL REFERENCES Scripts(id),
  url       TEXT NOT NULL REFERENCES RequiresFiles(url),
  PRIMARY KEY (script_id, url)
);

CREATE TABLE ScriptResourcesFiles (
  script_id     INTEGER NOT NULL REFERENCES Scripts(id),
  url           TEXT NOT NULL REFERENCES ResourceFiles(url),
  resource_name TEXT NOT NULL,  -- the @resource name the script binds it to
  PRIMARY KEY (script_id, url, resource_name)
);

-- Every metadata-block line, in source order.
--   @description:ar → header_field 'description', suffix 'ar', full 'description:ar'
--   @grant          → header_field 'grant',       suffix '',   full 'grant'
CREATE TABLE ScriptHeaders (
  script_id           INTEGER NOT NULL REFERENCES Scripts(id),
  header_field        TEXT NOT NULL,
  header_field_full   TEXT NOT NULL,
  header_field_suffix TEXT NOT NULL,
  argument            TEXT NOT NULL
);

-- One row per @match / @include line, decomposed so the URL-targeting questions
-- are plain SQL. See classifyPattern() for what each column means.
CREATE TABLE ScriptMatches (
  script_id    INTEGER NOT NULL REFERENCES Scripts(id),
  header_field TEXT NOT NULL,     -- 'match' or 'include'
  pattern      TEXT NOT NULL,     -- the line's argument, trimmed
  shape        TEXT NOT NULL,     -- absolute | prefix-glob | inner-glob | regex | all-urls
                                  -- judged on host+path only; a wildcard scheme
                                  -- is tracked separately in scheme_glob
  scheme       TEXT NOT NULL,     -- '' when the pattern names none
  host_pattern TEXT NOT NULL,     -- host portion as written, e.g. '*.youtube.com'
  site         TEXT,              -- resolved hostname, NULL when it isn't one site
  scheme_glob  INTEGER NOT NULL,
  host_glob    INTEGER NOT NULL,
  path_glob    INTEGER NOT NULL
);

-- The findings recorded in corpus.json (see record-results.mjs), flattened for SQL.
-- One row per script that has any finding.
CREATE TABLE ScriptResults (
  script_id     INTEGER PRIMARY KEY REFERENCES Scripts(id),
  version       TEXT,  -- @version of the downloaded copy
  valid_status  TEXT,  -- ok | invalid | tool error; NULL when never validated
  valid_error   TEXT,
  valid_date    TEXT,
  test_status   TEXT,  -- pass | fail | inconclusive | n/a; NULL when never tried
  test_reason   TEXT,  -- why a test was n/a
  test_blame    TEXT,  -- what caused a failure
  test_date     TEXT,
  test_version  TEXT
);

-- Tags from both sources: 'validation' (derived by import-validation, e.g.
-- unsupported-grant:GM_cookie) and 'manual' (added while testing).
CREATE TABLE ScriptTags (
  script_id INTEGER NOT NULL REFERENCES Scripts(id),
  tag       TEXT NOT NULL,
  source    TEXT NOT NULL
);

-- Labels on corpus records, each with its rank under that label when it has one.
CREATE TABLE ScriptLabels (
  script_id INTEGER NOT NULL REFERENCES Scripts(id),
  label     TEXT NOT NULL,
  rank      INTEGER
);

CREATE TABLE ScriptNotes (
  script_id INTEGER NOT NULL REFERENCES Scripts(id),
  date      TEXT NOT NULL,
  version   TEXT,
  text      TEXT NOT NULL
);

CREATE INDEX idx_matches_script ON ScriptMatches(script_id);
CREATE INDEX idx_matches_site ON ScriptMatches(site);
CREATE INDEX idx_headers_script ON ScriptHeaders(script_id);
CREATE INDEX idx_headers_field ON ScriptHeaders(header_field);
CREATE INDEX idx_requires_url ON ScriptRequiresFiles(url);
CREATE INDEX idx_resources_url ON ScriptResourcesFiles(url);
