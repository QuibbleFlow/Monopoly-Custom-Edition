const { database, noStore, parseBody, requireAccount, requireSameOrigin, sendError } = require('../../../lib/account');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

module.exports = async function updateFriendRequest(req, res) {
  noStore(res);
  if (req.method !== 'PATCH') {
    res.setHeader('Allow', 'PATCH');
    return sendError(res, 405, 'Method not allowed.');
  }
  if (!requireSameOrigin(req, res)) return;
  try {
    const account = await requireAccount(req, res);
    if (!account) return;
    const id = String(req.query.id || '');
    const { action } = parseBody(req);
    if (!UUID_PATTERN.test(id) || !['accept', 'decline'].includes(action)) {
      return sendError(res, 400, 'Friend request action is invalid.');
    }
    const status = action === 'accept' ? 'accepted' : 'declined';
    const rows = await database()`WITH updated AS (
        UPDATE friend_requests SET status = ${status}, responded_at = now()
        WHERE id = ${id} AND recipient_id = ${account.id} AND status = 'pending'
        RETURNING id, sender_id, recipient_id, status
      ), linked AS (
        INSERT INTO friendships (account_low, account_high)
        SELECT LEAST(sender_id, recipient_id), GREATEST(sender_id, recipient_id)
        FROM updated WHERE status = 'accepted'
        ON CONFLICT DO NOTHING
        RETURNING account_low, account_high
      )
      SELECT updated.id, updated.status FROM updated LEFT JOIN linked ON true`;
    if (!rows[0]) return sendError(res, 404, 'Friend request not found.');
    return res.status(200).json({ request: rows[0] });
  } catch (error) {
    console.error('Friend request decision failed:', error);
    return sendError(res, 500, 'Could not update that friend request.');
  }
};