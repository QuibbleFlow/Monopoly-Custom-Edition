const { database, noStore, requireAccount, requireSameOrigin, sendError } = require('../../lib/account');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

module.exports = async function removeFriend(req, res) {
  noStore(res);
  if (req.method !== 'DELETE') {
    res.setHeader('Allow', 'DELETE');
    return sendError(res, 405, 'Method not allowed.');
  }
  if (!requireSameOrigin(req, res)) return;
  try {
    const account = await requireAccount(req, res);
    if (!account) return;
    const friendId = String(req.query.id || '');
    if (!UUID_PATTERN.test(friendId)) return sendError(res, 400, 'Friend account ID is invalid.');
    const rows = await database()`DELETE FROM friendships
      WHERE (account_low = ${account.id} AND account_high = ${friendId})
         OR (account_low = ${friendId} AND account_high = ${account.id})
      RETURNING account_low`;
    if (!rows[0]) return sendError(res, 404, 'Friendship not found.');
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Friend removal failed:', error);
    return sendError(res, 500, 'Could not remove that friend.');
  }
};