BEGIN;

ALTER TABLE games
  ADD COLUMN IF NOT EXISTS invite_only BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;

ALTER TABLE game_players
  ADD COLUMN IF NOT EXISTS results_seen_at TIMESTAMPTZ;

UPDATE games
SET finished_at = updated_at
WHERE status = 'FINISHED' AND finished_at IS NULL;

DO $$
DECLARE
  status_constraint RECORD;
BEGIN
  IF EXISTS (
    SELECT 1 FROM games
    WHERE status NOT IN ('WAITING', 'ACTIVE', 'PAUSED', 'FINISHED')
  ) THEN
    RAISE EXCEPTION 'Cannot extend game status constraint: games contains an unknown status. No rows were changed.';
  END IF;

  FOR status_constraint IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'games'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE games DROP CONSTRAINT %I', status_constraint.conname);
  END LOOP;

  ALTER TABLE games ADD CONSTRAINT games_status_check
    CHECK (status IN ('WAITING', 'ACTIVE', 'PAUSED', 'FINISHED')) NOT VALID;
END
$$;

ALTER TABLE games VALIDATE CONSTRAINT games_status_check;

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
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'game_states_id_fkey' AND conrelid = 'game_states'::regclass
  ) THEN
    ALTER TABLE game_states ADD CONSTRAINT game_states_id_fkey
      FOREIGN KEY (id) REFERENCES games(id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'game_action_requests_game_id_fkey' AND conrelid = 'game_action_requests'::regclass
  ) THEN
    ALTER TABLE game_action_requests ADD CONSTRAINT game_action_requests_game_id_fkey
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE NOT VALID;
  END IF;
END
$$;

ALTER TABLE game_states VALIDATE CONSTRAINT game_states_id_fkey;
ALTER TABLE game_action_requests VALIDATE CONSTRAINT game_action_requests_game_id_fkey;

COMMIT;
