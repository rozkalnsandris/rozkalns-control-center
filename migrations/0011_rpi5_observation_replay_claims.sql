CREATE TABLE IF NOT EXISTS rpi5_observation_replay_claims (
  replay_key TEXT PRIMARY KEY
    CHECK (length(replay_key) BETWEEN 2 AND 200),
  replay_expires_at_ms INTEGER NOT NULL
    CHECK (typeof(replay_expires_at_ms) = 'integer' AND replay_expires_at_ms > 0),
  claimed_at_ms INTEGER NOT NULL
    CHECK (typeof(claimed_at_ms) = 'integer' AND claimed_at_ms > 0),
  CHECK (replay_expires_at_ms > claimed_at_ms)
);

CREATE INDEX IF NOT EXISTS idx_rpi5_observation_replay_claims_expires_at_ms
  ON rpi5_observation_replay_claims(replay_expires_at_ms);
