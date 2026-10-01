BEGIN;

ALTER TABLE games
  ADD COLUMN IF NOT EXISTS name TEXT;

UPDATE games
SET name = 'Server game'
WHERE name IS NULL OR btrim(name) = '';

ALTER TABLE games
  ALTER COLUMN name SET DEFAULT 'Server game',
  ALTER COLUMN name SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'games_name_length_check'
      AND conrelid = 'games'::regclass
  ) THEN
    ALTER TABLE games
      ADD CONSTRAINT games_name_length_check
      CHECK (char_length(name) BETWEEN 1 AND 80) NOT VALID;
  END IF;
END
$$;

ALTER TABLE games VALIDATE CONSTRAINT games_name_length_check;

COMMIT;
