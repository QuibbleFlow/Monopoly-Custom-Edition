const { database, noStore, requireAccount, requireMethod, sendError } = require('../../lib/account');

module.exports = async function friends(req, res) {
  noStore(res);
  if (!requireMethod(req, res, 'GET')) return;
  try {
    const account = await requireAccount(req, res);
    if (!account) return;
    const rows = await database()`SELECT a.id, a.username, a.avatar_url,
      EXISTS (
        SELECT 1 FROM account_sessions s
        WHERE s.account_id = a.id AND s.expires_at > now()
          AND s.last_seen_at > now() - interval '2 minutes'
      ) AS online
      FROM friendships f
      JOIN accounts a ON a.id = CASE
        WHEN f.account_low = ${account.id} THEN f.account_high
        ELSE f.account_low
      END
      WHERE f.account_low = ${account.id} OR f.account_high = ${account.id}
      ORDER BY lower(a.username)`;
    return res.status(200).json({ friends: rows });
  } catch (error) {
    console.error('Friend list request failed:', error);
    return sendError(res, 500, 'Could not load friends.');
  }
};