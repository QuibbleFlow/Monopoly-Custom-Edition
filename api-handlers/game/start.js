const { database, noStore, parseBody, requireAccount } = require('../../lib/account');
const { startGame } = require('./lifecycle.js');

module.exports = async function startGameRoute(req, res) {
  noStore(res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const account = await requireAccount(req, res);
  if (!account) return;

  const body = parseBody(req);
  const result = await startGame({
    account,
    gameId: body.gameId || body.game_id || null,
    db: database(),
  });

  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }

  return res.status(200).json({
    ok: true,
    gameId: result.gameId,
    game: result.game,
    status: result.status,
    version: result.version,
    state: result.state,
    events: result.events || [],
    players: result.players,
  });
};

module.exports.handleStartGame = startGame;
