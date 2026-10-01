const { database, noStore, parseBody, requireAccount, requireSameOrigin, sendError } = require('../../lib/account');

module.exports = async function friendRequests(req, res, deps = {}) {
  (deps.noStore || noStore)(res);
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return sendError(res, 405, 'Method not allowed.');
  }
  if (req.method === 'POST' && !(deps.requireSameOrigin || requireSameOrigin)(req, res)) return;
  try {
    const account = deps.currentAccount ? await deps.currentAccount(req, res) : await requireAccount(req, res);
    if (!account) return;
    const sql = deps.database ? deps.database() : database();
    if (req.method === 'GET') {
      const rows = await sql`SELECT r.id, r.status, r.created_at,
        CASE WHEN r.recipient_id = ${account.id} THEN 'incoming' ELSE 'outgoing' END AS direction,
        a.id AS account_id, a.username, a.avatar_url
        FROM friend_requests r
        JOIN accounts a ON a.id = CASE
          WHEN r.recipient_id = ${account.id} THEN r.sender_id
          ELSE r.recipient_id
        END
        WHERE r.status = 'pending'
          AND (r.recipient_id = ${account.id} OR r.sender_id = ${account.id})
        ORDER BY r.created_at DESC`;
      return res.status(200).json({ requests: rows });
    }

    const { username } = parseBody(req);
    if (typeof username !== 'string' || username.trim().length < 3 || username.trim().length > 24) {
      return sendError(res, 400, 'Enter a username between 3 and 24 characters.');
    }
    const rows = await sql`INSERT INTO friend_requests (sender_id, recipient_id)
      SELECT ${account.id}, target.id FROM accounts target
      WHERE lower(target.username) = lower(${username.trim()})
        AND target.id <> ${account.id}
        AND NOT EXISTS (
          SELECT 1 FROM friendships f
          WHERE f.account_low = LEAST(target.id, ${account.id}::uuid)
            AND f.account_high = GREATEST(target.id, ${account.id}::uuid)
        )
      ON CONFLICT DO NOTHING
      RETURNING id, recipient_id, status, created_at`;
    if (!rows[0]) return sendError(res, 409, 'That account was not found or already has a pending relationship.');
    return res.status(201).json({ request: rows[0] });
  } catch (error) {
    console.error('Friend request failed:', error);
    return sendError(res, 500, 'Could not update friend requests.');
  }
};