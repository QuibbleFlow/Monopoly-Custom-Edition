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

  return db.begin(async tx => {
    const games = await tx`SELECT * FROM games WHERE id = ${normalizedGameId}`;
    const game = games[0];
    if (!game) {
      return err('GAME_NOT_FOUND', 'Game not found.', 404);
    }

    const membership = await tx`SELECT * FROM game_players WHERE game_id = ${normalizedGameId} AND account_id = ${account.id}`;
    if (!membership[0]) {
      return err('NOT_IN_GAME', 'You are not a member of this game.', 403);
    }

    const stateRows = await tx`SELECT id, version, state, board FROM game_states WHERE id = ${normalizedGameId}`;
    const stateRow = stateRows[0];
    if (!stateRow) {
      return err('GAME_NOT_FOUND', 'Game state not found.', 404);
    }

    const version = Number(stateRow.version) || 1;
    const state = engine.deserializeState(stateRow.state);
    const actionRows = await tx`SELECT result_json FROM game_action_requests
      WHERE game_id = ${normalizedGameId}
      ORDER BY created_at DESC
      LIMIT 1`;
    let events = [];
    if (actionRows[0] && actionRows[0].result_json) {
      let actionResult = actionRows[0].result_json;
      if (typeof actionResult === 'string') {
        try { actionResult = JSON.parse(actionResult); } catch (error) { actionResult = null; }
      }
      if (Number(actionResult?.version) === version && Array.isArray(actionResult.events)) {
        events = actionResult.events;
      }
    }

    const visibleState = redactStateForAccount(state, account.id);
    return {
      ok: true,
      gameId: normalizedGameId,
      status: game.status,
      version,
      state: visibleState,
      events: redactEventsForAccount(events, state, account.id),
      board: stateRow.board || {},
    };
  });
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
