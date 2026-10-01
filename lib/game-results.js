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

  await tx`UPDATE games SET status = ${'FINISHED'}, finished_at = COALESCE(finished_at, now()), updated_at = now()
    WHERE id = ${gameId} AND (status <> ${'FINISHED'} OR finished_at IS NULL)`;

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

  return db.begin(async tx => {
    const games = await tx`SELECT id FROM games WHERE id = ${normalizedGameId} FOR UPDATE`;
    if (!games[0]) return err('GAME_NOT_FOUND', 'Game not found.', 404);
    const membership = await tx`SELECT 1 FROM game_players WHERE game_id = ${normalizedGameId} AND account_id = ${account.id}`;
    if (!membership[0]) return err('FORBIDDEN', 'You are not a player in this game.', 403);

    const rows = await tx`SELECT game_id, winner_account_id, placements, created_at FROM game_results WHERE game_id = ${normalizedGameId}`;
    const row = rows[0];
    if (!row) return err('RESULTS_NOT_FOUND', 'This game has not finished or has no recorded results yet.', 404);

    const placements = parsePlacements(row.placements);
    const results = [];
    for (const entry of placements) {
      let username = entry.name || null;
      let avatarUrl = null;
      if (entry.accountId) {
        const accountRows = await tx`SELECT username, avatar_url FROM accounts WHERE id = ${entry.accountId}`;
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

    await tx`UPDATE game_players SET results_seen_at = now()
      WHERE game_id = ${normalizedGameId} AND account_id = ${account.id}`;
    const acknowledgement = await tx`SELECT COUNT(*)::int AS total,
      COUNT(results_seen_at)::int AS seen
      FROM game_players WHERE game_id = ${normalizedGameId}`;
    if (Number(acknowledgement[0]?.total) > 0 &&
        Number(acknowledgement[0].seen) === Number(acknowledgement[0].total)) {
      await deleteGameRecords(tx, normalizedGameId);
      await tx`DELETE FROM games WHERE id = ${normalizedGameId} AND status = 'FINISHED'`;
    }

    return {
      ok: true,
      gameId: normalizedGameId,
      winnerAccountId: row.winner_account_id || null,
      results,
      createdAt: row.created_at || null,
    };
  });
}

async function cleanupExpiredFinishedGames(tx) {
  const expired = await tx`SELECT id FROM games
    WHERE status = 'FINISHED' AND updated_at < now() - interval '30 days' FOR UPDATE`;
  for (const game of expired) {
    await deleteGameRecords(tx, game.id);
    await tx`DELETE FROM games WHERE id = ${game.id} AND status = 'FINISHED'`;
  }
}

async function deleteGameRecords(tx, gameId) {
  await tx`DELETE FROM game_invitations WHERE game_id = ${gameId}`;
  await tx`DELETE FROM game_results WHERE game_id = ${gameId}`;
  await tx`DELETE FROM game_action_requests WHERE game_id = ${gameId}`;
  await tx`DELETE FROM game_states WHERE id = ${gameId}`;
  await tx`DELETE FROM game_players WHERE game_id = ${gameId}`;
}

module.exports = { persistFinalResultsIfNeeded, getFinalResults, cleanupExpiredFinishedGames, deleteGameRecords };
