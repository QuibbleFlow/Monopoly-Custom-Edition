const { syncGameAvatars } = require('../../lib/game-profiles');
const engine = require('../../game-engine.js');
const { database, noStore, requireAccount } = require('../../lib/account');

function err(code, message, status = 400) {
  return { ok: false, status, error: { code, message } };
}

function normalizeGameId(gameId) {
  if (typeof gameId !== 'string' || !gameId.trim()) return null;
  return gameId.trim();
}

function redactStateForAccount(state, accountId) {
  const copy = engine.cloneState(state);
  if (copy.trade && copy.trade.from !== undefined && copy.trade.to !== undefined &&
      copy.players[copy.trade.from]?.accountId !== accountId && copy.players[copy.trade.to]?.accountId !== accountId) {
    copy.trade = null;
  }
  return copy;
}

function redactEventsForAccount(events, state, accountId) {
  const participants = state.trade
    ? [state.trade.from, state.trade.to].map(id => state.players[id]?.accountId).filter(Boolean)
    : [];
  if (!participants.length || participants.includes(accountId)) return events;
  return events.filter(event => ![
    'TRADE_PROPOSED', 'TRADE_REJECTED', 'TRADE_CANCELLED', 'TRADE_DECLINED',
    'TRADE_POSTPONED',
  ].includes(event.type));
}

async function getGameState({ account, gameId, sinceVersion = null, sinceStatus = null, db = database() }) {
  if (!account || !account.id) {
    return err('UNAUTHENTICATED', 'Sign in to continue.', 401);
  }

  const normalizedGameId = normalizeGameId(gameId);
  if (!normalizedGameId) {
    return err('INVALID_GAME_ID', 'A valid gameId is required.', 400);
  }

  const knownVersion = Number.isInteger(Number(sinceVersion)) && Number(sinceVersion) > 0
    ? Number(sinceVersion)
    : null;
  const knownStatus = typeof sinceStatus === 'string' && sinceStatus.trim()
    ? sinceStatus.trim()
    : null;

  // Idle polls are the common case. When the caller already has this exact
  // version/status, Postgres returns only tiny metadata instead of serializing
  // the full JSON game state, board, and event payload five times per second.
  const rows = await db`
    SELECT
      g.status,
      EXISTS (
        SELECT 1
        FROM game_players gp
        WHERE gp.game_id = g.id
          AND gp.account_id = ${account.id}
      ) AS is_member,
      gs.version,
      CASE
        WHEN ${knownVersion}::int IS NULL OR gs.version <> ${knownVersion}::int
          THEN gs.state
        ELSE NULL
      END AS state,
      CASE
        WHEN ${knownVersion}::int IS NULL OR gs.version <> ${knownVersion}::int
          THEN gs.board
        ELSE NULL
      END AS board,
      CASE
        WHEN ${knownVersion}::int IS NULL OR gs.version <> ${knownVersion}::int
          THEN (
            SELECT ar.result_json
            FROM game_action_requests ar
            WHERE ar.game_id = g.id
            ORDER BY ar.created_at DESC
            LIMIT 1
          )
        ELSE NULL
      END AS result_json
    FROM games g
    LEFT JOIN game_states gs ON gs.id = g.id
    WHERE g.id = ${normalizedGameId}
  `;

  const row = rows[0];
  if (!row) {
    return err('GAME_NOT_FOUND', 'Game not found.', 404);
  }
  if (!row.is_member) {
    return err('NOT_IN_GAME', 'You are not a member of this game.', 403);
  }
  if (row.version == null) {
    return err('GAME_NOT_FOUND', 'Game state not found.', 404);
  }

  const version = Number(row.version) || 1;
  const unchanged = knownVersion === version && knownStatus === row.status;
  if (unchanged) {
    return {
      ok: true,
      gameId: normalizedGameId,
      status: row.status,
      version,
      unchanged: true,
    };
  }

  // A status-only transition, such as ACTIVE -> PAUSED, can keep the same
  // state version. The caller already owns that state, so there is no reason
  // to deserialize and resend it.
  if (row.state == null && knownVersion === version) {
    return {
      ok: true,
      gameId: normalizedGameId,
      status: row.status,
      version,
      unchanged: false,
    };
  }
  if (row.state == null) {
    return err('GAME_NOT_FOUND', 'Game state not found.', 404);
  }

  const state = engine.deserializeState(row.state);
  await syncGameAvatars(db, state);
  let events = [];
  let actionResult = row.result_json;
  if (typeof actionResult === 'string') {
    try { actionResult = JSON.parse(actionResult); } catch (error) { actionResult = null; }
  }
  if (Number(actionResult?.version) === version && Array.isArray(actionResult.events)) {
    events = actionResult.events;
  }

  const visibleState = redactStateForAccount(state, account.id);
  return {
    ok: true,
    gameId: normalizedGameId,
    status: row.status,
    version,
    unchanged: false,
    state: visibleState,
    events: redactEventsForAccount(events, state, account.id),
    board: row.board || {},
  };
}

async function handleGetGameStateRoute(req, res, deps = {}) {
  (deps.noStore || noStore)(res);
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const account = deps.currentAccount
    ? await deps.currentAccount(req, res)
    : await requireAccount(req, res);
  if (!account) return;

  const url = new URL(req.url, 'http://localhost');
  const gameId = url.searchParams.get('gameId') || url.searchParams.get('game_id');
  const sinceVersionValue = url.searchParams.get('sinceVersion') || url.searchParams.get('since_version');
  const sinceVersion = sinceVersionValue == null ? null : Number(sinceVersionValue);
  const sinceStatus = url.searchParams.get('sinceStatus') || url.searchParams.get('since_status');
  const result = await getGameState({
    account,
    gameId,
    sinceVersion,
    sinceStatus,
    db: deps.database ? deps.database() : database(),
  });

  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }

  return res.status(200).json({
    ok: true,
    gameId: result.gameId,
    status: result.status,
    version: result.version,
    unchanged: !!result.unchanged,
    state: result.state,
    events: result.events,
    board: result.board,
  });
}

module.exports = async function getGameStateRoute(req, res) {
  return handleGetGameStateRoute(req, res, {});
};

module.exports.handleGetGameState = getGameState;
module.exports.getGameState = getGameState;
module.exports.handleGetGameStateRoute = handleGetGameStateRoute;
module.exports.redactStateForAccount = redactStateForAccount;
