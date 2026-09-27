const engine = require('../game-engine.js');

function err(code, message, status = 400) {
  return { ok: false, status, error: { code, message } };
}

function parsePlacements(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed : [];
}

// Transitions a game to FINISHED and persists its authoritative final
// results the moment the engine state reports state.over === true. Safe
// to call on every action/resume regardless of whether the game just
// ended or ended long ago: the games.status update is a no-op once the
// game is already FINISHED, and the game_results insert is a no-op once
// a row for this game already exists (ON CONFLICT DO NOTHING), so
// repeated calls (retries, replayed idempotent actions, resumes of an
// already-finished save) can never overwrite or duplicate a result.
// Must always be called from inside the same transaction that persisted
// the authoritative state, so the FINISHED status and the results row
// can never observably diverge from the state that produced them.
async function persistFinalResultsIfNeeded(tx, gameId, state, spaces) {
  if (!state || !state.over) return null;
  const results = engine.computeFinalResults(state, spaces);
  if (!results) return null;
  const winner = results.find(entry => entry.placement === 1) || null;

  await tx`UPDATE games SET status = ${'FINISHED'}, updated_at = now()
    WHERE id = ${gameId} AND status <> ${'FINISHED'}`;

  await tx`INSERT INTO game_results (game_id, winner_account_id, placements)
    VALUES (${gameId}, ${winner ? winner.accountId : null}, ${JSON.stringify(results)}::jsonb)
    ON CONFLICT (game_id) DO NOTHING`;

  return results;
}

// Read-only lookup for a finished game's stored results. Access is
// restricted to accounts that were players in this game (the game_players
// row is never removed when a game finishes), so one player's results are
// never exposed to an unrelated account. Usernames and avatars are read
// live from the accounts table rather than the snapshot stored at result
// time, so a later profile/avatar change is reflected automatically.
async function getFinalResults({ account, gameId, db }) {
  if (!account || !account.id) return err('UNAUTHENTICATED', 'Sign in to continue.', 401);
  if (typeof gameId !== 'string' || !gameId.trim()) return err('INVALID_REQUEST', 'A valid gameId is required.');
  const normalizedGameId = gameId.trim();

  const membership = await db`SELECT 1 FROM game_players WHERE game_id = ${normalizedGameId} AND account_id = ${account.id}`;
  if (!membership[0]) return err('FORBIDDEN', 'You are not a player in this game.', 403);

  const rows = await db`SELECT game_id, winner_account_id, placements, created_at FROM game_results WHERE game_id = ${normalizedGameId}`;
  const row = rows[0];
  if (!row) return err('RESULTS_NOT_FOUND', 'This game has not finished or has no recorded results yet.', 404);

  const placements = parsePlacements(row.placements);
  const results = [];
  for (const entry of placements) {
    let username = entry.name || null;
    let avatarUrl = null;
    if (entry.accountId) {
      const accountRows = await db`SELECT username, avatar_url FROM accounts WHERE id = ${entry.accountId}`;
      if (accountRows[0]) {
        username = accountRows[0].username;
        avatarUrl = accountRows[0].avatar_url || null;
      }
    }
    results.push({
      accountId: entry.accountId || null,
      placement: entry.placement,
      money: entry.money,
      netWorth: entry.netWorth,
      username,
      avatarUrl,
    });
  }

  return {
    ok: true,
    gameId: normalizedGameId,
    winnerAccountId: row.winner_account_id || null,
    results,
    createdAt: row.created_at || null,
  };
}

module.exports = { persistFinalResultsIfNeeded, getFinalResults };
