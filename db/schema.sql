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

CREATE UNIQUE INDEX IF NOT EXISTS accounts_username_lower_unique
  ON accounts (lower(username));

CREATE TABLE IF NOT EXISTS account_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_sessions_expiry_idx
  ON account_sessions (expires_at);

ALTER TABLE account_sessions
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS friend_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  recipient_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ,
  CHECK (sender_id <> recipient_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS friend_requests_pending_pair_unique
  ON friend_requests (LEAST(sender_id, recipient_id), GREATEST(sender_id, recipient_id))
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS friend_requests_recipient_status_idx
  ON friend_requests (recipient_id, status, created_at DESC);

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

CREATE INDEX IF NOT EXISTS custom_boards_owner_updated_idx
  ON custom_boards (owner_id, updated_at DESC);

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

CREATE INDEX IF NOT EXISTS game_action_requests_game_created_idx
  ON game_action_requests (game_id, created_at DESC);

CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  host_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'WAITING' CHECK (status IN ('WAITING', 'ACTIVE', 'PAUSED', 'FINISHED')),
  invite_only BOOLEAN NOT NULL DEFAULT FALSE,
  selected_board_id UUID,
  resume_save_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS game_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  inviter_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  invitee_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ,
  CHECK (inviter_account_id <> invitee_account_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS game_invitations_game_invitee_unique
  ON game_invitations (game_id, invitee_account_id);
CREATE INDEX IF NOT EXISTS game_invitations_invitee_status_idx
  ON game_invitations (invitee_account_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS game_invitations_inviter_status_idx
  ON game_invitations (inviter_account_id, status, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'game_states_id_fkey' AND conrelid = 'game_states'::regclass) THEN
    ALTER TABLE game_states ADD CONSTRAINT game_states_id_fkey
      FOREIGN KEY (id) REFERENCES games(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'game_action_requests_game_id_fkey' AND conrelid = 'game_action_requests'::regclass) THEN
    ALTER TABLE game_action_requests ADD CONSTRAINT game_action_requests_game_id_fkey
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS game_players (
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  seat_index INTEGER NOT NULL CHECK (seat_index >= 0),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  returned_at TIMESTAMPTZ,
  results_seen_at TIMESTAMPTZ,
  PRIMARY KEY (game_id, account_id),
  UNIQUE (game_id, seat_index),
  CHECK (seat_index < 8)
);

CREATE INDEX IF NOT EXISTS game_players_account_idx
  ON game_players (account_id, game_id);

CREATE INDEX IF NOT EXISTS game_players_game_seat_idx
  ON game_players (game_id, seat_index);

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

CREATE TABLE IF NOT EXISTS game_results (
  game_id TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
  winner_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  placements JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS game_results_winner_idx
  ON game_results (winner_account_id);