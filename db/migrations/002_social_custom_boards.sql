BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

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

COMMIT;