const { database, noStore, requireAccount } = require('../../lib/account');
const { getFinalResults } = require('../../lib/game-results.js');

module.exports = async function resultsRoute(req, res) {
  noStore(res);
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const account = await requireAccount(req, res);
  if (!account) return;

  const gameId = new URL(req.url, 'http://localhost').searchParams.get('gameId')
    || new URL(req.url, 'http://localhost').searchParams.get('game_id');

  const result = await getFinalResults({ account, gameId, db: database() });

  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }

  return res.status(200).json({
    ok: true,
    gameId: result.gameId,
    winnerAccountId: result.winnerAccountId,
    results: result.results,
    createdAt: result.createdAt,
  });
};

module.exports.handleGetResults = getFinalResults;
