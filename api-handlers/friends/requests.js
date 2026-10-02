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
    const normalizedUsername = username.trim();

    const execute = async tx => {
      const targets = await tx`SELECT id, username FROM accounts
        WHERE lower(username) = lower(${normalizedUsername})
        LIMIT 1`;
      const target = targets[0];
      if (!target) return { status: 404, body: { error: 'That account was not found.' } };
      if (target.id === account.id) return { status: 400, body: { error: 'You cannot send a friend request to yourself.' } };

      const friends = await tx`SELECT 1 FROM friendships
        WHERE account_low = LEAST(${target.id}::uuid, ${account.id}::uuid)
          AND account_high = GREATEST(${target.id}::uuid, ${account.id}::uuid)`;
      if (friends[0]) {
        return { status: 200, body: { ok: true, alreadyFriends: true, message: 'You are already friends.' } };
      }

      const pendingRows = await tx`SELECT id, sender_id, recipient_id, status, created_at
        FROM friend_requests
        WHERE status = 'pending'
          AND LEAST(sender_id, recipient_id) = LEAST(${target.id}::uuid, ${account.id}::uuid)
          AND GREATEST(sender_id, recipient_id) = GREATEST(${target.id}::uuid, ${account.id}::uuid)
        FOR UPDATE`;
      const pending = pendingRows[0];

      if (pending) {
        if (pending.sender_id === account.id) {
          return {
            status: 200,
            body: { ok: true, alreadyPending: true, request: pending, message: 'Friend request already sent.' },
          };
        }

        // If both players try to add each other, turn the existing incoming
        // request into a friendship immediately instead of returning a
        // confusing duplicate/pending error.
        await tx`UPDATE friend_requests
          SET status = ${'accepted'}, responded_at = now()
          WHERE id = ${pending.id} AND status = 'pending'`;
        await tx`INSERT INTO friendships (account_low, account_high)
          VALUES (
            LEAST(${target.id}::uuid, ${account.id}::uuid),
            GREATEST(${target.id}::uuid, ${account.id}::uuid)
          )
          ON CONFLICT DO NOTHING`;
        return {
          status: 200,
          body: {
            ok: true,
            autoAccepted: true,
            request: { ...pending, status: 'accepted' },
            message: `You and ${target.username} are now friends.`,
          },
        };
      }

      const rows = await tx`INSERT INTO friend_requests (sender_id, recipient_id)
        VALUES (${account.id}, ${target.id})
        RETURNING id, sender_id, recipient_id, status, created_at`;
      return {
        status: 201,
        body: { ok: true, request: rows[0], message: `Friend request sent to ${target.username}.` },
      };
    };

    const outcome = typeof sql.begin === 'function'
      ? await sql.begin(execute)
      : await execute(sql);
    return res.status(outcome.status).json(outcome.body);
  } catch (error) {
    console.error('Friend request failed:', error);
    return sendError(res, 500, 'Could not update friend requests.');
  }
};