const { database, noStore, parseBody, requireAccount, requireSameOrigin } = require('../../lib/account');
const { serializePlayerRow, serializeGameRow, err } = require('./lifecycle.js');
const { cancelPausedReconnect, maintainConnections, connectionsDue, reconcileConnections, persistConnections } = require('../../lib/game-connections');
const engine = require('../../game-engine');

function normalize(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function sendGameInvitation({ account, gameId, inviteeAccountId, db = database() }) {
  if (!account?.id) return err('UNAUTHENTICATED', 'Sign in to continue.', 401);
  const normalizedGameId = normalize(gameId);
  const inviteeId = normalize(inviteeAccountId);
  if (!normalizedGameId || !inviteeId || !UUID_PATTERN.test(inviteeId)) return err('INVALID_REQUEST', 'A game and valid friend account are required.');
  if (inviteeId === account.id) return err('SELF_INVITE', 'You cannot invite yourself.');
  await maintainConnections(db, normalizedGameId);

  return db.begin(async tx => {
    const games = await tx`SELECT * FROM games WHERE id = ${normalizedGameId} FOR UPDATE`;
    const game = games[0];
    if (!game) return err('GAME_NOT_FOUND', 'Game not found.', 404);
    if (game.host_account_id !== account.id) return err('HOST_REQUIRED', 'Only the host can invite players.', 403);
    if (!['WAITING', 'PAUSED'].includes(game.status)) return err('GAME_NOT_WAITING', 'Invite friends from a lobby.', 409);
    const hostMembership = await tx`SELECT account_id FROM game_players
      WHERE game_id = ${normalizedGameId} AND account_id = ${account.id} FOR UPDATE`;
    if (!hostMembership[0]) return err('HOST_NOT_PLAYER', 'The host must occupy a player seat to invite friends.', 403);
    const members = await tx`SELECT account_id, seat_index, returned_at FROM game_players WHERE game_id = ${normalizedGameId} ORDER BY seat_index ASC FOR UPDATE`;
    const member = members.find(player => player.account_id === inviteeId);
    const returning = game.status === 'PAUSED' || !!game.resume_save_id;

    const friendship = await tx`SELECT 1 FROM friendships
      WHERE account_low = LEAST(${account.id}::uuid, ${inviteeId}::uuid)
        AND account_high = GREATEST(${account.id}::uuid, ${inviteeId}::uuid)
      FOR KEY SHARE`;
    if (!friendship[0] && !(returning && member)) return err('FRIEND_REQUIRED', 'You can only invite a friend or a remaining player from your save.', 403);

    if (returning && !member) return err('ORIGINAL_PLAYER_REQUIRED', 'Only remaining players from this save can be invited.', 403);
    if (member && (!returning || member.returned_at)) return err('ALREADY_IN_GAME', 'That friend is already in this lobby.', 409);
    if (!member && members.length >= 8) return err('GAME_FULL', 'This game is full. Maximum 8 players allowed.', 409);

    const existing = await tx`SELECT id, status FROM game_invitations
      WHERE game_id = ${normalizedGameId} AND invitee_account_id = ${inviteeId} FOR UPDATE`;
    if (existing[0] && ['pending', 'accepted'].includes(existing[0].status)) {
      return err('INVITATION_EXISTS', 'That invitation is already pending or accepted.', 409);
    }

    let rows;
    if (existing[0]) {
      rows = await tx`UPDATE game_invitations
        SET inviter_account_id = ${account.id}, status = ${'pending'}, created_at = now(), responded_at = NULL
        WHERE id = ${existing[0].id} RETURNING id, game_id, invitee_account_id, status, created_at`;
    } else {
      rows = await tx`INSERT INTO game_invitations (game_id, inviter_account_id, invitee_account_id)
        VALUES (${normalizedGameId}, ${account.id}, ${inviteeId})
        RETURNING id, game_id, invitee_account_id, status, created_at`;
    }

    return { ok: true, invitation: rows[0] };
  });
}

async function listGameInvitations({ account, db = database() }) {
  if (!account?.id) return err('UNAUTHENTICATED', 'Sign in to continue.', 401);
  const rows = await db`SELECT i.id, i.game_id, i.inviter_account_id, i.invitee_account_id, i.status, i.created_at,
      host.username AS host_username, target.username AS target_username, g.status AS game_status,
      g.name AS game_name, COALESCE(b.name, 'Classic board') AS board_name,
      (SELECT COUNT(*)::int FROM game_players gp WHERE gp.game_id = g.id) AS player_count
    FROM game_invitations i
    JOIN games g ON g.id = i.game_id
    JOIN accounts host ON host.id = g.host_account_id
    JOIN accounts target ON target.id = i.invitee_account_id
    LEFT JOIN custom_boards b ON b.id = g.selected_board_id
    WHERE i.status = 'pending' AND g.status IN ('WAITING', 'PAUSED')
      AND (i.invitee_account_id = ${account.id} OR i.inviter_account_id = ${account.id})
    ORDER BY i.created_at DESC`;
  return {
    ok: true,
    invitations: rows.map(row => ({
      invitationId: row.id,
      gameId: row.game_id,
      direction: row.invitee_account_id === account.id ? 'incoming' : 'outgoing',
      hostUsername: row.host_username,
      inviteeUsername: row.target_username,
      gameStatus: row.game_status,
      gameName: row.game_name,
      boardName: row.board_name,
      playerCount: Number(row.player_count),
      createdAt: row.created_at,
    })),
  };
}

async function respondToGameInvitation({ account, invitationId, action, db = database() }) {
  if (!account?.id) return err('UNAUTHENTICATED', 'Sign in to continue.', 401);
  const normalizedInvitationId = normalize(invitationId);
  if (!normalizedInvitationId || !['accept', 'decline'].includes(action)) {
    return err('INVALID_REQUEST', 'A valid invitation and accept/decline action are required.');
  }

  return db.begin(async tx => {
    const invitationRefs = await tx`SELECT game_id FROM game_invitations
      WHERE id = ${normalizedInvitationId} AND invitee_account_id = ${account.id}`;
    if (!invitationRefs[0]) return err('INVITATION_NOT_FOUND', 'Invitation not found.', 404);

    const games = await tx`SELECT * FROM games WHERE id = ${invitationRefs[0].game_id} FOR UPDATE`;
    const game = games[0];
    if (!game || !['WAITING', 'PAUSED'].includes(game.status)) return err('GAME_NOT_WAITING', 'This invitation is no longer joinable.', 409);
    if (game.status === 'PAUSED') {
      // Check the deadline while holding the game lock, before an invitation
      // can cancel a reserved player's reconnect window.
      const states = await tx`SELECT id, version, state, board FROM game_states WHERE id = ${game.id} FOR UPDATE`;
      if (states[0]) {
        const state = engine.deserializeState(states[0].state);
        if (connectionsDue(state, game.status)) {
          const members = await tx`SELECT * FROM game_players WHERE game_id = ${game.id} ORDER BY seat_index ASC`;
          const oldHost = game.host_account_id;
          const result = reconcileConnections(state, game, members);
          await persistConnections(tx, game, states[0], state, members, result, oldHost);
          if (game.status !== 'PAUSED') return err('GAME_NOT_WAITING', 'This invitation is no longer joinable.', 409);
        }
      }
    }

    const invitations = await tx`SELECT * FROM game_invitations
      WHERE id = ${normalizedInvitationId} AND invitee_account_id = ${account.id} FOR UPDATE`;
    const invitation = invitations[0];
    if (!invitation) return err('INVITATION_NOT_FOUND', 'Invitation not found.', 404);

    if (action === 'decline') {
      if (invitation.status !== 'pending') return err('INVITATION_NOT_PENDING', 'This invitation has already been answered.', 409);
      await tx`UPDATE game_invitations SET status = ${'declined'}, responded_at = now()
        WHERE id = ${normalizedInvitationId} AND status = 'pending'`;
      return { ok: true, invitationId: normalizedInvitationId, status: 'declined' };
    }

    const existingMembership = await tx`SELECT * FROM game_players WHERE game_id = ${game.id} AND account_id = ${account.id}`;
    if ((game.resume_save_id || game.status === 'PAUSED') && !existingMembership[0]) {
      return err('ORIGINAL_PLAYER_REQUIRED', 'Only remaining players from the save can return.', 403);
    }
    if (invitation.status === 'accepted' && existingMembership[0]) {
      const lobbyPlayers = await tx`SELECT gp.game_id, gp.account_id, gp.seat_index, gp.joined_at, gp.returned_at, a.username, a.avatar_url
        FROM game_players gp JOIN accounts a ON a.id = gp.account_id
        WHERE gp.game_id = ${game.id} ORDER BY gp.seat_index ASC`;
      return {
        ok: true,
        gameId: game.id,
        game: serializeGameRow(game),
        players: lobbyPlayers.map(serializePlayerRow),
        status: game.status,
        alreadyJoined: true,
      };
    }
    if (invitation.status !== 'pending') return err('INVITATION_NOT_PENDING', 'This invitation has already been answered.', 409);
    if (game.host_account_id !== invitation.inviter_account_id) return err('INVALID_INVITER', 'The game host changed after this invitation was sent.', 409);

    const players = await tx`SELECT account_id, seat_index FROM game_players WHERE game_id = ${game.id} ORDER BY seat_index ASC FOR UPDATE`;
    if (!existingMembership[0] && players.length >= 8) return err('GAME_FULL', 'This game is full. Maximum 8 players allowed.', 409);
    if (!existingMembership[0]) {
      const occupied = new Set(players.map(player => Number(player.seat_index)));
      let seatIndex = 0;
      while (occupied.has(seatIndex) && seatIndex < 8) seatIndex++;
      if (seatIndex >= 8) return err('GAME_FULL', 'This game is full. Maximum 8 players allowed.', 409);
      await tx`INSERT INTO game_players (game_id, account_id, seat_index, joined_at)
        VALUES (${game.id}, ${account.id}, ${seatIndex}, now())`;
    } else if (game.resume_save_id || game.status === 'PAUSED') {
      await tx`UPDATE game_players SET returned_at = now() WHERE game_id = ${game.id} AND account_id = ${account.id}`;
      if (game.status === 'PAUSED') await cancelPausedReconnect(tx, game.id, account.id);
    }
    await tx`UPDATE game_invitations SET status = ${'accepted'}, responded_at = now()
      WHERE id = ${normalizedInvitationId} AND status = 'pending'`;

    const lobbyPlayers = await tx`SELECT gp.game_id, gp.account_id, gp.seat_index, gp.joined_at, gp.returned_at, a.username, a.avatar_url
      FROM game_players gp JOIN accounts a ON a.id = gp.account_id
      WHERE gp.game_id = ${game.id} ORDER BY gp.seat_index ASC`;
    return {
      ok: true,
      gameId: game.id,
      game: serializeGameRow(game),
      players: lobbyPlayers.map(serializePlayerRow),
      status: game.status,
    };
  });
}

async function invitationsRoute(req, res) {
  noStore(res);
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  if (req.method === 'POST' && !requireSameOrigin(req, res)) return;
  const account = await requireAccount(req, res);
  if (!account) return;

  if (req.method === 'GET') {
    const result = await listGameInvitations({ account, db: database() });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.status(200).json({ ok: true, invitations: result.invitations });
  }

  const body = parseBody(req);
  const result = await sendGameInvitation({
    account,
    gameId: body.gameId || body.game_id,
    inviteeAccountId: body.inviteeAccountId || body.invitee_account_id,
    db: database(),
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  return res.status(201).json({ ok: true, invitation: result.invitation });
}

async function invitationRoute(req, res) {
  noStore(res);
  if (req.method !== 'PATCH') {
    res.setHeader('Allow', 'PATCH');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  if (!requireSameOrigin(req, res)) return;
  const account = await requireAccount(req, res);
  if (!account) return;
  const body = parseBody(req);
  const result = await respondToGameInvitation({
    account,
    invitationId: req.query.id,
    action: body.action,
    db: database(),
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  return res.status(200).json(result);
}

module.exports = invitationsRoute;
module.exports.sendGameInvitation = sendGameInvitation;
module.exports.listGameInvitations = listGameInvitations;
module.exports.respondToGameInvitation = respondToGameInvitation;
module.exports.invitationRoute = invitationRoute;
