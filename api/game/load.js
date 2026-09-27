const { database, noStore, parseBody, requireAccount } = require('../../lib/account');
const { loadGame } = require('./saves.js');

module.exports = async function loadGameRoute(req, res) {
  noStore(res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const account = await requireAccount(req, res);
  if (!account) return;

  const body = parseBody(req);
  const result = await loadGame({
    account,
    saveId: body.saveId || body.save_id || null,
    db: database(),
  });

  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }

  return res.status(200).json({
    ok: true,
    gameId: result.gameId,
    save: result.save,
    status: result.status,
    players: result.players,
  });
};

module.exports.handleLoadGame = loadGame;
