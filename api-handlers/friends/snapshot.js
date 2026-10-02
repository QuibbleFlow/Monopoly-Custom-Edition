const { database, noStore, requireAccount, requireMethod, sendError } = require('../../lib/account');

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }
  return [];
}

module.exports = async function socialSnapshot(req, res, deps = {}) {
  (deps.noStore || noStore)(res);
  if (!(deps.requireMethod || requireMethod)(req, res, 'GET')) return;

  try {
    const account = deps.currentAccount ? await deps.currentAccount(req, res) : await requireAccount(req, res);
    if (!account) return;
    const sql = deps.database ? deps.database() : database();

    // Friends, friend requests, and match invitations are read together so
    // the browser only needs one connection for its background social sync.
    const rows = await sql`
      SELECT
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', a.id,
              'username', a.username,
              'avatar_url', a.avatar_url,
              'currentGame', (
                SELECT jsonb_build_object('gameId', g.id, 'name', g.name, 'status', g.status)
                FROM game_players gp JOIN games g ON g.id = gp.game_id
                WHERE gp.account_id = a.id AND g.status IN ('WAITING', 'ACTIVE')
                ORDER BY g.updated_at DESC LIMIT 1
              ),
              'joinableGame', (
                SELECT jsonb_build_object('gameId', g.id, 'name', g.name)
                FROM game_players friend_seat
                JOIN games g ON g.id = friend_seat.game_id
                WHERE friend_seat.account_id = a.id AND g.status IN ('WAITING', 'PAUSED')
                  AND (
                    g.host_account_id = ${account.id} OR (
                      g.status = 'WAITING'
                      AND g.resume_save_id IS NULL
                      AND (SELECT COUNT(*) FROM game_players seats WHERE seats.game_id = g.id) < 8
                      AND (NOT g.invite_only OR EXISTS (
                        SELECT 1 FROM game_invitations invitation
                        WHERE invitation.game_id = g.id AND invitation.invitee_account_id = ${account.id}
                          AND invitation.status IN ('pending', 'accepted')
                      ))
                    ) OR EXISTS (
                      SELECT 1 FROM game_invitations invitation
                      WHERE invitation.game_id = g.id AND invitation.invitee_account_id = ${account.id}
                        AND invitation.status IN ('pending', 'accepted')
                        AND (g.status = 'WAITING' AND g.resume_save_id IS NULL OR EXISTS (
                          SELECT 1 FROM game_players me WHERE me.game_id = g.id AND me.account_id = ${account.id}
                        ))
                    )
                  )
                ORDER BY g.updated_at DESC LIMIT 1
              ),
              'online', EXISTS (
                SELECT 1 FROM account_sessions s
                WHERE s.account_id = a.id
                  AND s.expires_at > now()
                  AND s.last_seen_at > now() - interval '2 minutes'
              )
            )
            ORDER BY lower(a.username)
          )
          FROM friendships f
          JOIN accounts a ON a.id = CASE
            WHEN f.account_low = ${account.id} THEN f.account_high
            ELSE f.account_low
          END
          WHERE f.account_low = ${account.id} OR f.account_high = ${account.id}
        ), '[]'::jsonb) AS friends,
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', r.id,
              'status', r.status,
              'created_at', r.created_at,
              'direction', CASE WHEN r.recipient_id = ${account.id} THEN 'incoming' ELSE 'outgoing' END,
              'account_id', a.id,
              'username', a.username,
              'avatar_url', a.avatar_url
            )
            ORDER BY r.created_at DESC
          )
          FROM friend_requests r
          JOIN accounts a ON a.id = CASE
            WHEN r.recipient_id = ${account.id} THEN r.sender_id
            ELSE r.recipient_id
          END
          WHERE r.status = 'pending'
            AND (r.recipient_id = ${account.id} OR r.sender_id = ${account.id})
        ), '[]'::jsonb) AS requests,
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'invitationId', i.id,
              'gameId', i.game_id,
              'direction', CASE WHEN i.invitee_account_id = ${account.id} THEN 'incoming' ELSE 'outgoing' END,
              'hostUsername', host.username,
              'inviteeUsername', target.username,
              'gameStatus', g.status,
              'gameName', g.name,
              'boardName', COALESCE(b.name, 'Classic board'),
              'playerCount', (SELECT COUNT(*)::int FROM game_players gp WHERE gp.game_id = g.id),
              'createdAt', i.created_at
            )
            ORDER BY i.created_at DESC
          )
          FROM game_invitations i
          JOIN games g ON g.id = i.game_id
          JOIN accounts host ON host.id = g.host_account_id
          JOIN accounts target ON target.id = i.invitee_account_id
          LEFT JOIN custom_boards b ON b.id = g.selected_board_id
          WHERE i.status = 'pending'
            AND g.status IN ('WAITING', 'PAUSED')
            AND (i.invitee_account_id = ${account.id} OR i.inviter_account_id = ${account.id})
        ), '[]'::jsonb) AS invitations
    `;

    const row = rows[0] || {};
    return res.status(200).json({
      ok: true,
      friends: arrayValue(row.friends),
      requests: arrayValue(row.requests),
      invitations: arrayValue(row.invitations),
      syncedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Social snapshot failed:', error);
    return sendError(res, 500, 'Could not refresh friends and invitations.');
  }
};
