ALTER TABLE game_players
  DROP CONSTRAINT IF EXISTS game_players_seat_index_check;

ALTER TABLE game_players
  ADD CONSTRAINT game_players_seat_index_check
  CHECK (seat_index >= 0 AND seat_index < 8);
