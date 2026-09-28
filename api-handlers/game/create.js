const { database, noStore, parseBody, requireAccount } = require('../../lib/account');
const { createGame } = require('./lifecycle.js');

module.exports = async function createGameRoute(req, res) {
  noStore(res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const account = await requireAccount(req, res);
  if (!account) return;

  const body = parseBody(req);
  const result = await createGame({
    account,
    selectedBoardId: body.selectedBoardId || body.selected_board_id || null,
    db: database(),
  });

  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }

  return res.status(200).json({ ok: true, gameId: result.gameId, game: result.game, players: result.players, status: result.status });
};

module.exports.handleCreateGame = createGame;
