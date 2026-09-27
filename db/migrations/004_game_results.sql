BEGIN;

CREATE TABLE IF NOT EXISTS game_results (
  game_id TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
  winner_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  placements JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS game_results_winner_idx
  ON game_results (winner_account_id);

COMMIT;
