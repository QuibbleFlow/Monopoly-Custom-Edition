const { publicBoard } = require('../../lib/custom-boards');
const { randomInt, randomUUID } = require('node:crypto');
const engine = require('../../game-engine.js');
const boardData = require('../../game-board.js');
const { database, noStore, parseBody, requireAccount } = require('../../lib/account');
const { cleanupExpiredFinishedGames, deleteGameRecords } = require('../../lib/game-results.js');
const { initializeConnections, maintainConnections, cancelPausedReconnect } = require('../../lib/game-connections');
const { lockSaveOwner, trimSaveSlots } = require('../../lib/save-slots');

async function requireReturnInvitation(tx, game, account, membership) {
  if (game.host_account_id === account.id || membership?.returned_at) return null;
  const invitations = await tx`SELECT id, status FROM game_invitations
    WHERE game_id = ${game.id} AND invitee_account_id = ${account.id}
      AND status IN ('pending', 'accepted') FOR UPDATE`;
  if (!invitations[0]) return err('INVITATION_REQUIRED', 'Wait for the host to load the save and invite you.', 403);
  if (invitations[0].status === 'pending') await tx`UPDATE game_invitations SET status = ${'accepted'}, responded_at = now()
    WHERE id = ${invitations[0].id} AND status = 'pending'`;
  return null;
}

function err(code, message, status = 400) {
  return { ok: false, status, error: { code, message } };
}

function normalizeGameId(gameId) {
  if (typeof gameId !== 'string' || !gameId.trim()) return null;
  return gameId.trim();
}

function serializePlayerRow(row) {
  return {
    gameId: row.game_id || row.gameId,
    accountId: row.account_id || row.accountId,
    seatIndex: Number(row.seat_index ?? row.seatIndex ?? 0),
    username: row.username,
    avatarUrl: row.avatar_url || row.avatarUrl || null,
    joinedAt: row.joined_at || row.joinedAt || null,
    returnedAt: row.returned_at || row.returnedAt || null,
  };
}

function serializeGameRow(row) {
  return {
    gameId: row.id || row.gameId,
    hostAccountId: row.host_account_id || row.hostAccountId,
    name: row.name || 'Server game',
    status: row.status,
    selectedBoardId: row.selected_board_id || row.selectedBoardId || null,
    resumeSaveId: row.resume_save_id || row.resumeSaveId || null,
    inviteOnly: !!(row.invite_only ?? row.inviteOnly),
    createdAt: row.created_at || row.createdAt || null,
    startedAt: row.started_at || row.startedAt || null,
    pausedAt: row.paused_at || row.pausedAt || null,
    finishedAt: row.finished_at || row.finishedAt || null,
    updatedAt: row.updated_at || row.updatedAt || null,
  };
}


async function ensureBoardOwner(tx, accountId, selectedBoardId) {
  if (!selectedBoardId) return null;
  const rows = await tx`SELECT id, owner_id FROM custom_boards WHERE id = ${selectedBoardId}`;
  if (!rows[0]) {
    throw err('BOARD_NOT_FOUND', 'The selected board does not exist.', 404);
  }
  if (rows[0].owner_id !== accountId) {
    throw err('BOARD_NOT_OWNED', 'You can only select a board you own.', 403);
  }
  return rows[0];
}

async function createGame({ account, selectedBoardId, inviteOnly = false, name = 'Server game', db = database() }) {
  if (!account || !account.id) {
    return err('UNAUTHENTICATED', 'Sign in to continue.', 401);
  }
  const gameId = randomUUID();
  const gameName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : 'Server game';

  return db.begin(async tx => {
    await ensureBoardOwner(tx, account.id, selectedBoardId);

    await tx`INSERT INTO games (id, host_account_id, name, status, invite_only, selected_board_id, created_at, started_at, updated_at)
      VALUES (${gameId}, ${account.id}, ${gameName}, ${'WAITING'}, ${!!inviteOnly}, ${selectedBoardId || null}, now(), NULL, now())`;

    await tx`INSERT INTO game_players (game_id, account_id, seat_index, joined_at)
      VALUES (${gameId}, ${account.id}, ${0}, now())`;

    const games = await tx`SELECT * FROM games WHERE id = ${gameId}`;
    const players = await tx`SELECT gp.game_id, gp.account_id, gp.seat_index, gp.joined_at, gp.returned_at, a.username, a.avatar_url
      FROM game_players gp
      JOIN accounts a ON a.id = gp.account_id
      WHERE gp.game_id = ${gameId}
      ORDER BY gp.seat_index ASC`;

    return {
      ok: true,
      gameId,
      game: serializeGameRow(games[0]),
      players: players.map(serializePlayerRow),
      status: 'WAITING',
    };
  });
}

async function joinGame({ account, gameId, db = database() }) {
  if (!account || !account.id) {
    return err('UNAUTHENTICATED', 'Sign in to continue.', 401);
  }
  const normalizedGameId = normalizeGameId(gameId);
  if (!normalizedGameId) {
    return err('INVALID_GAME_ID', 'A valid gameId is required.', 400);
  }
  await maintainConnections(db, normalizedGameId);

  return db.begin(async tx => {
    const games = await tx`SELECT * FROM games WHERE id = ${normalizedGameId} FOR UPDATE`;
    const game = games[0];
    if (!game) {
      return err('GAME_NOT_FOUND', 'Game not found.', 404);
    }
    const already = await tx`SELECT * FROM game_players WHERE game_id = ${normalizedGameId} AND account_id = ${account.id}`;

    if (game.status === 'PAUSED') {
      if (!already[0]) {
        return err('ORIGINAL_PLAYER_REQUIRED', 'Only an original player in this match can return.', 403);
      }
      const invitationError = await requireReturnInvitation(tx, game, account, already[0]);
      if (invitationError) return invitationError;
      await cancelPausedReconnect(tx, normalizedGameId, account.id);
      if (!already[0].returned_at) {
        await tx`UPDATE game_players SET returned_at = now() WHERE game_id = ${normalizedGameId} AND account_id = ${account.id}`;
      }
      const players = await tx`SELECT gp.game_id, gp.account_id, gp.seat_index, gp.joined_at, gp.returned_at, a.username, a.avatar_url
        FROM game_players gp JOIN accounts a ON a.id = gp.account_id
        WHERE gp.game_id = ${normalizedGameId} ORDER BY gp.seat_index ASC`;
      return {
        ok: true,
        gameId: normalizedGameId,
        game: serializeGameRow(game),
        players: players.map(serializePlayerRow),
        status: 'PAUSED',
        canStart: game.host_account_id === account.id && players.length >= 2 && players.every(player => player.returned_at),
      };
    }

    if (game.status !== 'WAITING') {
      return err('GAME_NOT_JOINABLE', 'This game is no longer joinable.', 409);
    }

    if (game.resume_save_id) {
      // Resume lobbies are pre-seeded (by loadGame) with one row per
      // original account/seat. Nobody new can join one: an account with
      // no seat here was never part of the saved game, so it is rejected
      // as a substitute rather than allowed to take an open slot. An
      // account that does have a seat is "returning", not joining, so we
      // only ever stamp returned_at on its existing row -- we never
      // insert a row or move it to a different seat, which is what keeps
      // another account from ever being able to occupy that seat.
      if (!already[0]) {
        return err('NOT_ORIGINAL_PLAYER', 'Only the original players from this save can return to it.', 403);
      }
      const invitationError = await requireReturnInvitation(tx, game, account, already[0]);
      if (invitationError) return invitationError;
      if (!already[0].returned_at) {
        await tx`UPDATE game_players SET returned_at = now() WHERE game_id = ${normalizedGameId} AND account_id = ${account.id}`;
      }

      const players = await tx`SELECT gp.game_id, gp.account_id, gp.seat_index, gp.joined_at, gp.returned_at, a.username, a.avatar_url
        FROM game_players gp
        JOIN accounts a ON a.id = gp.account_id
        WHERE gp.game_id = ${normalizedGameId}
        ORDER BY gp.seat_index ASC`;

      return {
        ok: true,
        gameId: normalizedGameId,
        game: serializeGameRow(game),
        players: players.map(serializePlayerRow),
        status: game.status,
      };
    }

    if (already[0]) {
      const players = await tx`SELECT gp.game_id, gp.account_id, gp.seat_index, gp.joined_at, gp.returned_at, a.username, a.avatar_url
        FROM game_players gp JOIN accounts a ON a.id = gp.account_id
        WHERE gp.game_id = ${normalizedGameId} ORDER BY gp.seat_index ASC`;
      return {
        ok: true,
        gameId: normalizedGameId,
        game: serializeGameRow(game),
        players: players.map(serializePlayerRow),
        status: game.status,
      };
    }

    if (game.invite_only) {
      const invitations = await tx`SELECT id, status FROM game_invitations
        WHERE game_id = ${normalizedGameId} AND invitee_account_id = ${account.id}
          AND status IN ('pending', 'accepted') FOR UPDATE`;
      if (!invitations[0]) {
        return err('INVITATION_REQUIRED', 'This lobby is invite-only.', 403);
      }
      if (invitations[0].status === 'pending') {
        await tx`UPDATE game_invitations SET status = ${'accepted'}, responded_at = now()
          WHERE id = ${invitations[0].id} AND status = 'pending'`;
      }
    }

    const occupiedRows = await tx`SELECT seat_index FROM game_players WHERE game_id = ${normalizedGameId} ORDER BY seat_index ASC FOR UPDATE`;
    const count = occupiedRows.length;
    const MAX_PLAYERS = 8;
    if (count >= MAX_PLAYERS) {
      return err('GAME_FULL', `This game is full. Maximum ${MAX_PLAYERS} players allowed.`, 409);
    }

    const occupiedSeats = new Set(occupiedRows.map(row => Number(row.seat_index)));
    let nextSeat = 0;
    while (occupiedSeats.has(nextSeat) && nextSeat < MAX_PLAYERS) nextSeat++;
    if (nextSeat >= MAX_PLAYERS) return err('GAME_FULL', `This game is full. Maximum ${MAX_PLAYERS} players allowed.`, 409);
    await tx`INSERT INTO game_players (game_id, account_id, seat_index, joined_at)
      VALUES (${normalizedGameId}, ${account.id}, ${nextSeat}, now())`;

    const players = await tx`SELECT gp.game_id, gp.account_id, gp.seat_index, gp.joined_at, gp.returned_at, a.username, a.avatar_url
      FROM game_players gp
      JOIN accounts a ON a.id = gp.account_id
      WHERE gp.game_id = ${normalizedGameId}
      ORDER BY gp.seat_index ASC`;

    return {
      ok: true,
      gameId: normalizedGameId,
      game: serializeGameRow(game),
      players: players.map(serializePlayerRow),
      status: game.status,
    };
  });
}

async function leaveGame({ account, gameId, db = database() }) {
  if (!account || !account.id) {
    return err('UNAUTHENTICATED', 'Sign in to continue.', 401);
  }
  const normalizedGameId = normalizeGameId(gameId);
  if (!normalizedGameId) {
    return err('INVALID_GAME_ID', 'A valid gameId is required.', 400);
  }

  return db.begin(async tx => {
    const games = await tx`SELECT * FROM games WHERE id = ${normalizedGameId} FOR UPDATE`;
    const game = games[0];
    if (!game) {
      return err('GAME_NOT_FOUND', 'Game not found.', 404);
    }
    const membership = await tx`SELECT * FROM game_players WHERE game_id = ${normalizedGameId} AND account_id = ${account.id}`;
    if (!membership[0]) {
      return err('NOT_IN_GAME', 'You are not a member of that game.', 403);
    }
    if (game.status === 'PAUSED') {
      await tx`UPDATE game_players SET returned_at = NULL WHERE game_id = ${normalizedGameId} AND account_id = ${account.id}`;
    }
    const players = await tx`SELECT gp.game_id, gp.account_id, gp.seat_index, gp.joined_at, gp.returned_at, a.username, a.avatar_url
      FROM game_players gp
      JOIN accounts a ON a.id = gp.account_id
      WHERE gp.game_id = ${normalizedGameId}
      ORDER BY gp.seat_index ASC`;

    return {
      ok: true,
      gameId: normalizedGameId,
      game: serializeGameRow(game),
      players: players.map(serializePlayerRow),
      status: game.status,
      membershipPreserved: true,
    };
  });
}

async function deleteGame({ account, gameId, db = database() }) {
  if (!account || !account.id) return err('UNAUTHENTICATED', 'Sign in to continue.', 401);
  const normalizedGameId = normalizeGameId(gameId);
  if (!normalizedGameId) return err('INVALID_GAME_ID', 'A valid gameId is required.', 400);

  return db.begin(async tx => {
    const rows = await tx`SELECT * FROM games WHERE id = ${normalizedGameId} FOR UPDATE`;
    const game = rows[0];
    if (!game) return err('GAME_NOT_FOUND', 'Game not found.', 404);
    if (game.host_account_id !== account.id) return err('HOST_REQUIRED', 'Only the host can delete this game.', 403);

    await deleteGameRecords(tx, normalizedGameId);
    await tx`DELETE FROM games WHERE id = ${normalizedGameId}`;
    return { ok: true, gameId: normalizedGameId, deleted: true };
  });
}

async function startGame({ account, gameId, db = database() }) {
  if (!account || !account.id) {
    return err('UNAUTHENTICATED', 'Sign in to continue.', 401);
  }
  const normalizedGameId = normalizeGameId(gameId);
  if (!normalizedGameId) {
    return err('INVALID_GAME_ID', 'A valid gameId is required.', 400);
  }

  return db.begin(async tx => {
    const games = await tx`SELECT * FROM games WHERE id = ${normalizedGameId} FOR UPDATE`;
    const game = games[0];
    if (!game) {
      return err('GAME_NOT_FOUND', 'Game not found.', 404);
    }
    if (game.host_account_id !== account.id) {
      return err('HOST_REQUIRED', 'Only the host can start the game.', 403);
    }
    if (game.status !== 'WAITING') {
      return err('GAME_ALREADY_STARTED', 'This game has already started.', 409);
    }
    if (game.resume_save_id) {
      // A resume lobby's authoritative state comes only from resumeGame(),
      // which restores the exact saved snapshot. Routing it through the
      // normal startGame() would silently rebuild fresh players from
      // current lobby profiles and discard the saved money/properties/
      // turn state entirely, so it is refused here rather than allowed.
      return err('USE_RESUME_ENDPOINT', 'This lobby resumes a saved game; use the resume endpoint to start it.', 409);
    }

    const players = await tx`SELECT gp.account_id, gp.seat_index, a.username, a.avatar_url
      FROM game_players gp
      JOIN accounts a ON a.id = gp.account_id
      WHERE gp.game_id = ${normalizedGameId}
      ORDER BY gp.seat_index ASC`;

    if (!players.some(player => player.account_id === account.id)) {
      return err('HOST_NOT_PLAYER', 'The host must occupy an original player seat to start the game.', 403);
    }
    if (players.length < 2) {
      return err('NOT_ENOUGH_PLAYERS', 'A game requires at least two players to start.', 409);
    }
    if (players.some((player, seatIndex) => Number(player.seat_index) !== seatIndex)) {
      return err('SEATS_NOT_CONTIGUOUS', 'Open seats from an earlier lobby departure must be filled before the game can start.', 409);
    }

    const names = players.map(player => player.username);
    const accountIds = players.map(player => player.account_id);
    let boardNames = {};
    let cardDecks;
    if (game.selected_board_id) {
      const boards = await tx`SELECT property_names FROM custom_boards
        WHERE id = ${game.selected_board_id} AND owner_id = ${game.host_account_id}`;
      if (!boards[0]) {
        return err('BOARD_NOT_FOUND', 'The selected custom board is no longer available to the host.', 409);
      }
      const board = publicBoard(boards[0]);
      boardNames = board.property_names;
      cardDecks = board.card_decks;
    }
    let state = engine.createState({ names, accountIds, avatarUrls: players.map(player => player.avatar_url), boardSize: boardData.spaces.length, boardNames, cardDecks });
    initializeConnections(state);
    if (game.selected_board_id) {
      const boards = await tx`SELECT name FROM custom_boards WHERE id = ${game.selected_board_id}`;
      state.boardName = boards[0]?.name || 'Custom board';
    } else state.boardName = 'Classic board';

    // Match the original game's start flow, but choose the order on the
    // authoritative server so every browser receives the exact same result.
    const order = players.map((_, index) => index);
    for (let index = order.length - 1; index > 0; index--) {
      const swapIndex = randomInt(index + 1);
      [order[index], order[swapIndex]] = [order[swapIndex], order[index]];
    }
    const orderResult = engine.applyAction(state, { type: 'SET_TURN_ORDER', order }, { spaces: boardData.spaces });
    if (orderResult.error) {
      return err('START_ORDER_FAILED', orderResult.error, 500);
    }
    state = orderResult.state;
    state.log.push(`Game started. ${state.players[order[0]].name} goes first.`);
    const serialized = engine.serializeState(state);
    const board = { spaces: boardData.spaces };

    await tx`INSERT INTO game_states (id, owner_id, state, board, version)
      VALUES (${normalizedGameId}, ${account.id}, ${serialized}::jsonb, ${JSON.stringify(board)}::jsonb, ${1})
      ON CONFLICT (id) DO UPDATE SET owner_id = EXCLUDED.owner_id, state = EXCLUDED.state, board = EXCLUDED.board, version = EXCLUDED.version, updated_at = now()`;

    await tx`UPDATE games SET status = ${'ACTIVE'}, started_at = now(), updated_at = now() WHERE id = ${normalizedGameId}`;

    const updated = await tx`SELECT * FROM games WHERE id = ${normalizedGameId}`;
    return {
      ok: true,
      gameId: normalizedGameId,
      game: serializeGameRow(updated[0]),
      status: 'ACTIVE',
      version: 1,
      state,
      events: orderResult.events,
      players: players.map(player => ({
        accountId: player.account_id,
        seatIndex: Number(player.seat_index),
        username: player.username,
      })),
    };
  });
}

async function pauseGame({ account, gameId, expectedVersion, db = database() }) {
  if (!account?.id) return err('UNAUTHENTICATED', 'Sign in to continue.', 401);
  const normalizedGameId = normalizeGameId(gameId);
  if (!normalizedGameId) return err('INVALID_GAME_ID', 'A valid gameId is required.', 400);

  await maintainConnections(db, normalizedGameId);
  return db.begin(async tx => {
    const games = await tx`SELECT * FROM games WHERE id = ${normalizedGameId} FOR UPDATE`;
    const game = games[0];
    if (!game) return err('GAME_NOT_FOUND', 'Game not found.', 404);
    if (game.host_account_id !== account.id) return err('HOST_REQUIRED', 'Only the host can save and quit.', 403);
    if (game.status !== 'ACTIVE') return err('GAME_NOT_ACTIVE', 'Only an active match can be paused.', 409);

    const memberships = await tx`SELECT account_id, seat_index FROM game_players WHERE game_id = ${normalizedGameId} ORDER BY seat_index ASC FOR UPDATE`;
    if (!memberships.some(player => player.account_id === account.id)) {
      return err('NOT_IN_GAME', 'The host is not a member of this match.', 403);
    }
    const states = await tx`SELECT id, version, state, board FROM game_states WHERE id = ${normalizedGameId} FOR UPDATE`;
    const stateRow = states[0];
    if (!stateRow) return err('GAME_STATE_NOT_FOUND', 'The authoritative match state is unavailable.', 404);
    const version = Number(stateRow.version);
    if (expectedVersion != null && Number(expectedVersion) !== version) {
      return err('STALE_VERSION', `The match is at version ${version}; refresh before saving and quitting.`, 409);
    }

    const state = engine.deserializeState(stateRow.state);
    const remaining = state.players.filter(player => !player.removed);
    if (state.over || remaining.length !== memberships.length ||
        remaining.some(player => !memberships.some(member => member.account_id === player.accountId && Number(member.seat_index) === player.id))) {
      return err('PLAYER_ROSTER_MISMATCH', 'The authoritative state does not match the original player seats.', 409);
    }

    // The first Save & Quit creates the only save slot for this match.
    // Later pauses update it, preserving any name the host has chosen.
    await lockSaveOwner(tx, account.id);
    const saved = await tx`SELECT id, name FROM game_saves
      WHERE source_game_id = ${normalizedGameId} AND owner_id = ${account.id}
      ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`;
    const saveId = saved[0]?.id || randomUUID();
    const names = remaining.map(player => player.name);
    const fullName = `(${names.join(', ')})`;
    const nameBudget = Math.floor((78 - (names.length - 1) * 2) / names.length);
    const defaultName = fullName.length <= 80 ? fullName
      : `(${names.map(name => name.length > nameBudget ? name.slice(0, nameBudget - 1) + '…' : name).join(', ')})`;
    const saveName = saved[0]?.name && saved[0].name !== 'Server game' ? saved[0].name : defaultName;
    const metadata = remaining.map(player => ({
      accountId: player.accountId, seatIndex: player.id,
      username: player.name, avatarUrl: player.avatarUrl || null,
    }));
    if (saved[0]) {
      await tx`UPDATE game_saves SET name = ${saveName}, source_game_id = ${normalizedGameId}, status = ${'SAVED'}, version = ${version}, state = ${JSON.stringify(state)}::jsonb, board = ${JSON.stringify(stateRow.board || {})}::jsonb, players = ${JSON.stringify(metadata)}::jsonb, selected_board_id = ${game.selected_board_id || null}, updated_at = now() WHERE id = ${saveId} AND owner_id = ${account.id}`;
    } else {
      await tx`INSERT INTO game_saves (id, owner_id, source_game_id, name, status, version, state, board, players, selected_board_id)
        VALUES (${saveId}, ${account.id}, ${normalizedGameId}, ${saveName}, ${'SAVED'}, ${version}, ${JSON.stringify(state)}::jsonb, ${JSON.stringify(stateRow.board || {})}::jsonb, ${JSON.stringify(metadata)}::jsonb, ${game.selected_board_id || null})`;
    }

    await trimSaveSlots(tx, account.id);
    // Online players are going to a saved lobby, so their leases no longer
    // run. An already disconnected player's original deadline still applies.
    for (const connection of Object.values(state.connections?.players || {})) {
      if (connection.status === 'connected') { connection.status = 'paused'; connection.sessions = {}; }
    }
    await tx`UPDATE game_states SET state = ${JSON.stringify(state)}::jsonb, version = ${version}, updated_at = now() WHERE id = ${normalizedGameId}`;
    await tx`DELETE FROM game_invitations WHERE game_id = ${normalizedGameId}`;

    await tx`UPDATE game_players SET returned_at = NULL WHERE game_id = ${normalizedGameId}`;
    await tx`UPDATE games SET status = ${'PAUSED'}, paused_at = now(), updated_at = now()
      WHERE id = ${normalizedGameId} AND status = ${'ACTIVE'}`;
    return {
      ok: true,
      gameId: normalizedGameId,
      status: 'PAUSED',
      saveId,
      version,
      state,
      board: stateRow.board || {},
      players: memberships.map(player => ({ accountId: player.account_id, seatIndex: Number(player.seat_index) })),
    };
  });
}

async function getLobby({ account, gameId, db = database() }) {
  if (!account || !account.id) {
    return err('UNAUTHENTICATED', 'Sign in to continue.', 401);
  }
  const normalizedGameId = normalizeGameId(gameId);
  if (!normalizedGameId) {
    return err('INVALID_GAME_ID', 'A valid gameId is required.', 400);
  }

  await maintainConnections(db, normalizedGameId);
  const games = await db.begin(async tx => {
    const rows = await tx`SELECT * FROM games WHERE id = ${normalizedGameId}`;
    const game = rows[0];
    if (!game) {
      return err('GAME_NOT_FOUND', 'Game not found.', 404);
    }

    const membership = await tx`SELECT * FROM game_players WHERE game_id = ${normalizedGameId} AND account_id = ${account.id}`;
    if (!membership[0]) {
      return err('NOT_IN_GAME', 'You are not a member of this game.', 403);
    }
    if ((game.status === 'PAUSED' || game.resume_save_id) && game.host_account_id !== account.id && !membership[0].returned_at) {
      return err('INVITATION_REQUIRED', 'Wait for the host to invite you back to the saved match.', 403);
    }

    const players = await tx`SELECT gp.game_id, gp.account_id, gp.seat_index, gp.joined_at, gp.returned_at, a.username, a.avatar_url
      FROM game_players gp
      JOIN accounts a ON a.id = gp.account_id
      WHERE gp.game_id = ${normalizedGameId}
      ORDER BY gp.seat_index ASC`;

    // canStart reflects, for the UI's convenience only, exactly the rule
    // the backend itself enforces: startGame() for a fresh lobby requires
    // 2+ seated players; resumeGame() for a resume lobby requires every
    // original seat's returned_at to be set. Neither the client nor this
    // flag is ever trusted to gate the actual transition -- startGame and
    // resumeGame re-check these conditions themselves.
    const finishedSnapshot = game.resume_save_id ? (await tx`SELECT state ->> 'over' AS game_over FROM game_states WHERE id = ${normalizedGameId}`)[0]?.game_over === 'true' : false;
    const canStart = game.status === 'WAITING' && game.host_account_id === account.id && (
      game.resume_save_id
        ? (players.length >= 2 || finishedSnapshot) && players.every(player => player.returned_at)
        : players.length >= 2
    );
    if (game.status === 'PAUSED' && game.host_account_id === account.id && !membership[0].returned_at) {
      await tx`UPDATE game_players SET returned_at = now()
        WHERE game_id = ${normalizedGameId} AND account_id = ${account.id} AND returned_at IS NULL`;
      const ownPlayer = players.find(player => player.account_id === account.id);
      if (ownPlayer) ownPlayer.returned_at = new Date();
    }

    const canResume = game.status === 'PAUSED' && game.host_account_id === account.id &&
      players.length >= 2 && players.every(player => player.returned_at);

    return {
      ok: true,
      gameId: normalizedGameId,
      game: serializeGameRow(game),
      players: players.map(serializePlayerRow),
      canStart,
      canResume,
    };
  });

  return games;
}

async function getMyGames({ account, db = database() }) {
  if (!account || !account.id) {
    return err('UNAUTHENTICATED', 'Sign in to continue.', 401);
  }

  // Sweep only this account's matches. Deadlines are checked on every read,
  // even when no browser remained open to poll the match at expiry.
  const memberships = await db`SELECT g.id FROM games g JOIN game_players gp ON gp.game_id = g.id
    WHERE gp.account_id = ${account.id} AND g.status IN ('ACTIVE', 'PAUSED')`;
  for (const game of memberships) await maintainConnections(db, game.id);
  const rows = await db.begin(async tx => {
    await cleanupExpiredFinishedGames(tx);
    const games = await tx`SELECT g.*, gp.account_id, gp.seat_index, gp.returned_at
      FROM game_players gp
      JOIN games g ON g.id = gp.game_id
      WHERE gp.account_id = ${account.id}
      ORDER BY g.updated_at DESC`;

    return games.filter(game => game.host_account_id === account.id ||
      (game.status !== 'PAUSED' && (!game.resume_save_id || game.returned_at))).map(game => ({
      gameId: game.id,
      hostAccountId: game.host_account_id,
      name: game.name || 'Server game',
      status: game.status,
      isHost: game.host_account_id === account.id,
      inviteOnly: !!game.invite_only,
      selectedBoardId: game.selected_board_id || null,
      resumeSaveId: game.resume_save_id || null,
      seatIndex: Number(game.seat_index),
      startedAt: game.started_at || null,
      updatedAt: game.updated_at || null,
    }));
  });

  return { ok: true, games: rows };
}

module.exports = {
  createGame,
  joinGame,
  leaveGame,
  deleteGame,
  startGame,
  pauseGame,
  getLobby,
  getMyGames,
  serializeGameRow,
  serializePlayerRow,
  err,
};
