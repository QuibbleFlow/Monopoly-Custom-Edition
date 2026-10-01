const { database, noStore, requireAccount } = require('../../lib/account');
const { getLobby } = require('./lifecycle.js');

module.exports = async function lobbyRoute(req, res) {
  noStore(res);
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const account = await requireAccount(req, res);
  if (!account) return;

  const gameId = new URL(req.url, 'http://localhost').searchParams.get('gameId') || new URL(req.url, 'http://localhost').searchParams.get('game_id');
  const result = await getLobby({ account, gameId, db: database() });

  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }

  return res.status(200).json({ ok: true, gameId: result.gameId, game: result.game, players: result.players, canStart: result.canStart, canResume: result.canResume });
};

module.exports.handleGetLobby = getLobby;
