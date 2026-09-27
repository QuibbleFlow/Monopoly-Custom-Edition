ALTER TABLE game_players
  ADD COLUMN IF NOT EXISTS returned_at TIMESTAMPTZ;

ALTER TABLE games
  ADD COLUMN IF NOT EXISTS resume_save_id UUID;

CREATE TABLE IF NOT EXISTS game_saves (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source_game_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  status TEXT NOT NULL DEFAULT 'SAVED' CHECK (status IN ('SAVED', 'LOADED')),
  version INTEGER NOT NULL CHECK (version >= 1),
  state JSONB NOT NULL,
  board JSONB NOT NULL DEFAULT '{}'::jsonb,
  players JSONB NOT NULL DEFAULT '[]'::jsonb,
  selected_board_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS game_saves_owner_updated_idx
  ON game_saves (owner_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS games_resume_save_idx
  ON games (resume_save_id);
