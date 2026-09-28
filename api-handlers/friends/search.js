const { database, noStore, requireAccount, requireMethod, sendError } = require('../../lib/account');

module.exports = async function searchFriends(req, res) {
  noStore(res);
  if (!requireMethod(req, res, 'GET')) return;
  try {
    const account = await requireAccount(req, res);
    if (!account) return;
    const query = String(req.query.q || '').trim();
    if (query.length < 2 || query.length > 24) return sendError(res, 400, 'Search with 2-24 username characters.');
    const rows = await database()`SELECT a.id, a.username, a.avatar_url,
      EXISTS (
        SELECT 1 FROM account_sessions s
        WHERE s.account_id = a.id AND s.expires_at > now()
          AND s.last_seen_at > now() - interval '2 minutes'
      ) AS online
      FROM accounts a
      WHERE a.id <> ${account.id} AND a.username ILIKE ${query + '%'}
        AND NOT EXISTS (
          SELECT 1 FROM friendships f
          WHERE f.account_low = LEAST(a.id, ${account.id}::uuid)
            AND f.account_high = GREATEST(a.id, ${account.id}::uuid)
        )
        AND NOT EXISTS (
          SELECT 1 FROM friend_requests r
          WHERE r.status = 'pending'
            AND LEAST(r.sender_id, r.recipient_id) = LEAST(a.id, ${account.id}::uuid)
            AND GREATEST(r.sender_id, r.recipient_id) = GREATEST(a.id, ${account.id}::uuid)
        )
      ORDER BY lower(a.username) LIMIT 25`;
    return res.status(200).json({ users: rows });
  } catch (error) {
    console.error('Friend search failed:', error);
    return sendError(res, 500, 'Could not search accounts.');
  }
};