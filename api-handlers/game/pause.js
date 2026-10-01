const { database, noStore, parseBody, requireAccount, requireSameOrigin } = require('../../lib/account');
const { pauseGame } = require('./lifecycle.js');

module.exports = async function pauseGameRoute(req, res) {
  noStore(res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  if (!requireSameOrigin(req, res)) return;

  const account = await requireAccount(req, res);
  if (!account) return;

  const body = parseBody(req);
  const result = await pauseGame({
    account,
    gameId: body.gameId || body.game_id || null,
    expectedVersion: body.version,
    db: database(),
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });

  return res.status(200).json({
    ok: true,
    gameId: result.gameId,
    status: result.status,
    version: result.version,
  });
};

module.exports.pauseGame = pauseGame;
