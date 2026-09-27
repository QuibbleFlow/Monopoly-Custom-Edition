const { database, noStore, parseBody, requireAccount, requireSameOrigin, sendError } = require('../../../lib/account');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

module.exports = async function shareBoard(req, res) {
  noStore(res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendError(res, 405, 'Method not allowed.');
  }
  if (!requireSameOrigin(req, res)) return;
  try {
    const account = await requireAccount(req, res);
    if (!account) return;
    const boardId = String(req.query.id || '');
    const { friendId } = parseBody(req);
    if (!UUID_PATTERN.test(boardId) || typeof friendId !== 'string' || !UUID_PATTERN.test(friendId)) {
      return sendError(res, 400, 'Board or friend ID is invalid.');
    }
    const rows = await database()`INSERT INTO custom_boards (owner_id, name, property_names, copied_from)
      SELECT ${friendId}, source.name, source.property_names, source.id
      FROM custom_boards source
      WHERE source.id = ${boardId} AND source.owner_id = ${account.id}
        AND EXISTS (
          SELECT 1 FROM friendships f
          WHERE f.account_low = LEAST(${account.id}::uuid, ${friendId}::uuid)
            AND f.account_high = GREATEST(${account.id}::uuid, ${friendId}::uuid)
        )
      RETURNING id, owner_id, name, property_names, copied_from, created_at, updated_at`;
    if (!rows[0]) return sendError(res, 404, 'Board or friend not found.');
    return res.status(201).json({ board: rows[0] });
  } catch (error) {
    console.error('Custom board share failed:', error);
    return sendError(res, 500, 'Could not share that board.');
  }
};