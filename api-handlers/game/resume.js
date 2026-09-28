const { database, noStore, parseBody, requireAccount } = require('../../lib/account');
const { resumeGame } = require('./saves.js');

module.exports = async function resumeGameRoute(req, res) {
  noStore(res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const account = await requireAccount(req, res);
  if (!account) return;

  const body = parseBody(req);
  const result = await resumeGame({
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
    status: result.status,
    version: result.version,
    state: result.state,
    board: result.board,
  });
};

module.exports.handleResumeGame = resumeGame;
