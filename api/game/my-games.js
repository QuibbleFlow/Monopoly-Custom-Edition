const { database, noStore, requireAccount } = require('../../lib/account');
const { getMyGames } = require('./lifecycle.js');

module.exports = async function myGamesRoute(req, res) {
  noStore(res);
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const account = await requireAccount(req, res);
  if (!account) return;

  const result = await getMyGames({ account, db: database() });
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }

  return res.status(200).json({ ok: true, games: result.games });
};

module.exports.handleGetMyGames = getMyGames;
