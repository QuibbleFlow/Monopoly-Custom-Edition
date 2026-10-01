const { database, noStore, parseBody, requireAccount, requireSameOrigin, sendError } = require('../../lib/account');

module.exports = async function renameGame(req, res) {
  noStore(res);
  if (req.method !== 'PATCH') {
    res.setHeader('Allow', 'PATCH');
    return sendError(res, 405, 'Method not allowed.');
  }
  if (!requireSameOrigin(req, res)) return;
  try {
    const account = await requireAccount(req, res);
    if (!account) return;
    const { gameId, name } = parseBody(req);
    const normalizedId = typeof gameId === 'string' ? gameId.trim() : '';
    const normalizedName = typeof name === 'string' ? name.trim() : '';
    if (!normalizedId || normalizedName.length < 1 || normalizedName.length > 80) {
      return sendError(res, 400, 'Enter a server game name between 1 and 80 characters.');
    }
    const rows = await database()`UPDATE games
      SET name = ${normalizedName}, updated_at = now()
      WHERE id = ${normalizedId} AND host_account_id = ${account.id}
      RETURNING id, name`;
    if (!rows[0]) return sendError(res, 404, 'Game not found, or only the host can rename it.');
    return res.status(200).json({ ok: true, gameId: rows[0].id, name: rows[0].name });
  } catch (error) {
    console.error('Rename game failed:', error);
    return sendError(res, 500, 'Could not rename that server game.');
  }
};
