-- Source only. Applying this migration requires a separate owner LIVE gate.
CREATE TABLE continuation_action_audit (
  request_id TEXT PRIMARY KEY NOT NULL CHECK (length(request_id) BETWEEN 16 AND 128),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  campaign_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('CONTINUE', 'PAUSE')),
  actor_subject TEXT NOT NULL CHECK (length(actor_subject) BETWEEN 1 AND 512),
  actor_email TEXT,
  expected_main_sha TEXT NOT NULL CHECK (length(expected_main_sha) = 40),
  expected_revision TEXT NOT NULL CHECK (length(expected_revision) = 64),
  requested_at TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('CLAIMED', 'APPLIED', 'CONFLICT')),
  result_revision TEXT
);
