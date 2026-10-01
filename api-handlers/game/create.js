const { createGame } = require('./lifecycle.js');
const { database, ensureDatabaseRuntimeState, noStore, parseBody, requireAccount } = require('../../lib/account');

module.exports = async function createGameRoute(req, res) {
  noStore(res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    const account = await requireAccount(req, res);
    if (!account) return;

    const body = parseBody(req);
    const sql = database();
    await ensureDatabaseRuntimeState(sql);

    const result = await createGame({
      account,
      selectedBoardId: body.selectedBoardId || body.selected_board_id || null,
      db: sql,
    });

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }

    return res.status(200).json({ ok: true, gameId: result.gameId, game: result.game, players: result.players, status: result.status });
  } catch (error) {
    console.error('Create lobby failed:', {
      method: req?.method,
      url: req?.url,
      stack: error && error.stack ? error.stack : String(error),
    });

    return res.status(500).json({
      ok: false,
      error: {
        code: 'CREATE_GAME_FAILED',
        message: 'The server lobby could not be created. Check the Vercel function logs for the underlying database/schema error.',
      },
    });
  }
};

module.exports.handleCreateGame = createGame;
