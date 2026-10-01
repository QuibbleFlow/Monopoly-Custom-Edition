BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_url TEXT,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS friend_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  recipient_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ,
  CHECK (sender_id <> recipient_id)
);

CREATE TABLE IF NOT EXISTS friendships (
  account_low UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  account_high UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_low, account_high),
  CHECK (account_low < account_high)
);

CREATE TABLE IF NOT EXISTS custom_boards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  property_names JSONB NOT NULL DEFAULT '{}'::jsonb,
  copied_from UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  host_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'WAITING' CHECK (status IN ('WAITING', 'ACTIVE', 'FINISHED')),
  selected_board_id UUID,
  resume_save_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS game_players (
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  seat_index INTEGER NOT NULL CHECK (seat_index >= 0 AND seat_index < 8),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  returned_at TIMESTAMPTZ,
  PRIMARY KEY (game_id, account_id),
  UNIQUE (game_id, seat_index)
);

CREATE TABLE IF NOT EXISTS game_states (
  id TEXT PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  board JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS game_action_requests (
  game_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  result_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, request_id)
);

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

CREATE TABLE IF NOT EXISTS game_results (
  game_id TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
  winner_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  placements JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Add columns introduced after the initial account/social/game schemas.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS avatar_url TEXT,
  ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE account_sessions
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE custom_boards
  ADD COLUMN IF NOT EXISTS property_names JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS copied_from UUID,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE games
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'WAITING',
  ADD COLUMN IF NOT EXISTS selected_board_id UUID,
  ADD COLUMN IF NOT EXISTS resume_save_id UUID,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE game_players
  ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS returned_at TIMESTAMPTZ;

ALTER TABLE game_states
  ADD COLUMN IF NOT EXISTS state JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS board JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE game_saves
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'SAVED',
  ADD COLUMN IF NOT EXISTS board JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS players JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS selected_board_id UUID,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Refuse to change the seat constraint if existing multiplayer rows are invalid.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM game_players
    WHERE seat_index < 0 OR seat_index >= 8
  ) THEN
    RAISE EXCEPTION 'Cannot apply 8-seat constraint: game_players contains seat_index values outside 0..7. No rows were changed.';
  END IF;

  ALTER TABLE game_players DROP CONSTRAINT IF EXISTS game_players_seat_index_check;
  ALTER TABLE game_players ADD CONSTRAINT game_players_seat_index_check
    CHECK (seat_index >= 0 AND seat_index < 8);

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'friend_requests_status_check' AND conrelid = 'friend_requests'::regclass) THEN
    ALTER TABLE friend_requests ADD CONSTRAINT friend_requests_status_check
      CHECK (status IN ('pending', 'accepted', 'declined')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'friend_requests_check' AND conrelid = 'friend_requests'::regclass) THEN
    ALTER TABLE friend_requests ADD CONSTRAINT friend_requests_check
      CHECK (sender_id <> recipient_id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'friendships_check' AND conrelid = 'friendships'::regclass) THEN
    ALTER TABLE friendships ADD CONSTRAINT friendships_check
      CHECK (account_low < account_high) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'custom_boards_name_check' AND conrelid = 'custom_boards'::regclass) THEN
    ALTER TABLE custom_boards ADD CONSTRAINT custom_boards_name_check
      CHECK (char_length(name) BETWEEN 1 AND 40) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'games_status_check' AND conrelid = 'games'::regclass) THEN
    ALTER TABLE games ADD CONSTRAINT games_status_check
      CHECK (status IN ('WAITING', 'ACTIVE', 'FINISHED')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'game_saves_name_check' AND conrelid = 'game_saves'::regclass) THEN
    ALTER TABLE game_saves ADD CONSTRAINT game_saves_name_check
      CHECK (char_length(name) BETWEEN 1 AND 80) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'game_saves_status_check' AND conrelid = 'game_saves'::regclass) THEN
    ALTER TABLE game_saves ADD CONSTRAINT game_saves_status_check
      CHECK (status IN ('SAVED', 'LOADED')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'game_saves_version_check' AND conrelid = 'game_saves'::regclass) THEN
    ALTER TABLE game_saves ADD CONSTRAINT game_saves_version_check
      CHECK (version >= 1) NOT VALID;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS accounts_username_lower_unique
  ON accounts (lower(username));
CREATE INDEX IF NOT EXISTS account_sessions_expiry_idx
  ON account_sessions (expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS friend_requests_pending_pair_unique
  ON friend_requests (LEAST(sender_id, recipient_id), GREATEST(sender_id, recipient_id))
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS friend_requests_recipient_status_idx
  ON friend_requests (recipient_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS custom_boards_owner_updated_idx
  ON custom_boards (owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS game_players_account_idx
  ON game_players (account_id, game_id);
CREATE INDEX IF NOT EXISTS game_players_game_seat_idx
  ON game_players (game_id, seat_index);
CREATE INDEX IF NOT EXISTS game_action_requests_game_created_idx
  ON game_action_requests (game_id, created_at DESC);
CREATE INDEX IF NOT EXISTS game_saves_owner_updated_idx
  ON game_saves (owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS games_resume_save_idx
  ON games (resume_save_id);
CREATE INDEX IF NOT EXISTS game_results_winner_idx
  ON game_results (winner_account_id);

-- Add missing foreign keys without deleting or rewriting existing rows.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_sessions_account_id_fkey' AND conrelid = 'account_sessions'::regclass) THEN
    ALTER TABLE account_sessions ADD CONSTRAINT account_sessions_account_id_fkey
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'friend_requests_sender_id_fkey' AND conrelid = 'friend_requests'::regclass) THEN
    ALTER TABLE friend_requests ADD CONSTRAINT friend_requests_sender_id_fkey
      FOREIGN KEY (sender_id) REFERENCES accounts(id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'friend_requests_recipient_id_fkey' AND conrelid = 'friend_requests'::regclass) THEN
    ALTER TABLE friend_requests ADD CONSTRAINT friend_requests_recipient_id_fkey
      FOREIGN KEY (recipient_id) REFERENCES accounts(id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'custom_boards_owner_id_fkey' AND conrelid = 'custom_boards'::regclass) THEN
    ALTER TABLE custom_boards ADD CONSTRAINT custom_boards_owner_id_fkey
      FOREIGN KEY (owner_id) REFERENCES accounts(id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'friendships_account_low_fkey' AND conrelid = 'friendships'::regclass) THEN
    ALTER TABLE friendships ADD CONSTRAINT friendships_account_low_fkey
      FOREIGN KEY (account_low) REFERENCES accounts(id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'friendships_account_high_fkey' AND conrelid = 'friendships'::regclass) THEN
    ALTER TABLE friendships ADD CONSTRAINT friendships_account_high_fkey
      FOREIGN KEY (account_high) REFERENCES accounts(id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'games_host_account_id_fkey' AND conrelid = 'games'::regclass) THEN
    ALTER TABLE games ADD CONSTRAINT games_host_account_id_fkey
      FOREIGN KEY (host_account_id) REFERENCES accounts(id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'game_players_game_id_fkey' AND conrelid = 'game_players'::regclass) THEN
    ALTER TABLE game_players ADD CONSTRAINT game_players_game_id_fkey
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'game_players_account_id_fkey' AND conrelid = 'game_players'::regclass) THEN
    ALTER TABLE game_players ADD CONSTRAINT game_players_account_id_fkey
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'game_states_owner_id_fkey' AND conrelid = 'game_states'::regclass) THEN
    ALTER TABLE game_states ADD CONSTRAINT game_states_owner_id_fkey
      FOREIGN KEY (owner_id) REFERENCES accounts(id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'game_saves_owner_id_fkey' AND conrelid = 'game_saves'::regclass) THEN
    ALTER TABLE game_saves ADD CONSTRAINT game_saves_owner_id_fkey
      FOREIGN KEY (owner_id) REFERENCES accounts(id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'game_results_game_id_fkey' AND conrelid = 'game_results'::regclass) THEN
    ALTER TABLE game_results ADD CONSTRAINT game_results_game_id_fkey
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'game_results_winner_account_id_fkey' AND conrelid = 'game_results'::regclass) THEN
    ALTER TABLE game_results ADD CONSTRAINT game_results_winner_account_id_fkey
      FOREIGN KEY (winner_account_id) REFERENCES accounts(id) ON DELETE SET NULL NOT VALID;
  END IF;
END
$$;

ALTER TABLE account_sessions VALIDATE CONSTRAINT account_sessions_account_id_fkey;
ALTER TABLE friend_requests VALIDATE CONSTRAINT friend_requests_sender_id_fkey;
ALTER TABLE friend_requests VALIDATE CONSTRAINT friend_requests_recipient_id_fkey;
ALTER TABLE friend_requests VALIDATE CONSTRAINT friend_requests_status_check;
ALTER TABLE friend_requests VALIDATE CONSTRAINT friend_requests_check;
ALTER TABLE friendships VALIDATE CONSTRAINT friendships_account_low_fkey;
ALTER TABLE friendships VALIDATE CONSTRAINT friendships_account_high_fkey;
ALTER TABLE friendships VALIDATE CONSTRAINT friendships_check;
ALTER TABLE custom_boards VALIDATE CONSTRAINT custom_boards_owner_id_fkey;
ALTER TABLE custom_boards VALIDATE CONSTRAINT custom_boards_name_check;
ALTER TABLE games VALIDATE CONSTRAINT games_host_account_id_fkey;
ALTER TABLE games VALIDATE CONSTRAINT games_status_check;
ALTER TABLE game_players VALIDATE CONSTRAINT game_players_game_id_fkey;
ALTER TABLE game_players VALIDATE CONSTRAINT game_players_account_id_fkey;
ALTER TABLE game_players VALIDATE CONSTRAINT game_players_seat_index_check;
ALTER TABLE game_states VALIDATE CONSTRAINT game_states_owner_id_fkey;
ALTER TABLE game_saves VALIDATE CONSTRAINT game_saves_owner_id_fkey;
ALTER TABLE game_saves VALIDATE CONSTRAINT game_saves_name_check;
ALTER TABLE game_saves VALIDATE CONSTRAINT game_saves_status_check;
ALTER TABLE game_saves VALIDATE CONSTRAINT game_saves_version_check;
ALTER TABLE game_results VALIDATE CONSTRAINT game_results_game_id_fkey;
ALTER TABLE game_results VALIDATE CONSTRAINT game_results_winner_account_id_fkey;

COMMIT;
