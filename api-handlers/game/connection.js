const { database, noStore, parseBody, requireAccount, requireSameOrigin } = require('../../lib/account');
const { maintainConnections, publicConnections } = require('../../lib/game-connections');

function describeMatch(result, accountId) {
  if (!result.state) return null;
  const own = result.state.connections?.players[accountId];
  if (!own || result.game.status !== 'ACTIVE') return null;
  return {
    gameId: result.game.id, name: result.game.name,
    boardName: result.state.boardName || 'Classic board',
    selectedBoardId: result.game.selected_board_id,
    serverTime: result.serverTime, reconnectUntil: own.reconnectUntil || own.leaseUntil + 120000,
    status: own.status, ...publicConnections(result.state, result.game),
  };
}

async function handleConnection({ account, gameId, action, sessionId, db = database() }) {
  if (!account?.id) return { error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } };
  if (!['rejoin', 'heartbeat', 'disconnect', 'leave'].includes(action) || typeof gameId !== 'string' || !gameId.trim() ||
      (action !== 'leave' && (typeof sessionId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(sessionId)))) {
    return { error: { code: 'INVALID_REQUEST', message: 'A valid match, action, and tab session are required.' } };
  }
  const result = await maintainConnections(db, gameId, { accountId: account.id, action, sessionId });
  if (!result.game || !result.state) return { error: { code: 'GAME_NOT_ACTIVE', message: 'This match is no longer active.' } };
  if (result.error) return { error: result.error };
  return { ok: true, gameId, status: result.game.status, match: describeMatch(result, account.id) };
}

async function discoverMatches({ account, db = database() }) {
  const games = await db`SELECT g.id FROM games g JOIN game_players gp ON gp.game_id = g.id
    WHERE gp.account_id = ${account.id} AND g.status = 'ACTIVE' ORDER BY g.updated_at DESC`;
  const matches = [];
  for (const game of games) {
    const result = await maintainConnections(db, game.id);
    const match = describeMatch(result, account.id);
    if (match) matches.push(match);
  }
  return { ok: true, matches };
}

module.exports = async function connection(req, res) {
  noStore(res);
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed.' });
  if (req.method === 'POST' && !requireSameOrigin(req, res)) return;
  const account = await requireAccount(req, res);
  if (!account) return;
  const db = database();
  const result = req.method === 'GET' ? await discoverMatches({ account, db })
    : await handleConnection({ account, ...parseBody(req), db });
  return res.status(result.error ? (result.error.code === 'INVALID_REQUEST' ? 400 : 409) : 200).json(result);
};
module.exports.handleConnection = handleConnection;
module.exports.discoverMatches = discoverMatches;
