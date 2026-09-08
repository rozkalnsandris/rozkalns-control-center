ALTER TABLE rpi5_observation_replay_claims
ADD COLUMN claim_token TEXT NOT NULL DEFAULT ''
  CHECK (
    claim_token = ''
    OR (
      length(claim_token) = 32
      AND claim_token NOT GLOB '*[^0-9a-f]*'
    )
  );
