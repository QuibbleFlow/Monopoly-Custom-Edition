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

async function getGameState({ account, gameId, db = database() }) {
  if (!account || !account.id) {
    return err('UNAUTHENTICATED', 'Sign in to continue.', 401);
  }

  const normalizedGameId = normalizeGameId(gameId);
  if (!normalizedGameId) {
    return err('INVALID_GAME_ID', 'A valid gameId is required.', 400);
  }

  // One statement gives a consistent snapshot of status, membership,
  // authoritative state, and the latest event payload. Active clients poll
  // this endpoint frequently, so avoiding a transaction plus four separate
  // round trips materially reduces server multiplayer latency.
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
      gs.state,
      gs.board,
      (
        SELECT ar.result_json
        FROM game_action_requests ar
        WHERE ar.game_id = g.id
        ORDER BY ar.created_at DESC
        LIMIT 1
      ) AS result_json
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
  if (row.state == null || row.version == null) {
    return err('GAME_NOT_FOUND', 'Game state not found.', 404);
  }

  const version = Number(row.version) || 1;
  const state = engine.deserializeState(row.state);
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
  const result = await getGameState({ account, gameId, db: deps.database ? deps.database() : database() });

  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }

  return res.status(200).json({
    ok: true,
    gameId: result.gameId,
    status: result.status,
    version: result.version,
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
