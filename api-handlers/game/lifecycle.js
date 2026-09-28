const { randomUUID } = require('node:crypto');
const engine = require('../../game-engine.js');
const boardData = require('../../game-board.js');
const { database, noStore, parseBody, requireAccount } = require('../../lib/account');

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
    status: row.status,
    selectedBoardId: row.selected_board_id || row.selectedBoardId || null,
    resumeSaveId: row.resume_save_id || row.resumeSaveId || null,
    createdAt: row.created_at || row.createdAt || null,
    startedAt: row.started_at || row.startedAt || null,
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

async function createGame({ account, selectedBoardId, db = database() }) {
  if (!account || !account.id) {
    return err('UNAUTHENTICATED', 'Sign in to continue.', 401);
  }
  const gameId = randomUUID();

  return db.begin(async tx => {
    await ensureBoardOwner(tx, account.id, selectedBoardId);

    await tx`INSERT INTO games (id, host_account_id, status, selected_board_id, created_at, started_at, updated_at)
      VALUES (${gameId}, ${account.id}, ${'WAITING'}, ${selectedBoardId || null}, now(), NULL, now())`;

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

  return db.begin(async tx => {
    const games = await tx`SELECT * FROM games WHERE id = ${normalizedGameId} FOR UPDATE`;
    const game = games[0];
    if (!game) {
      return err('GAME_NOT_FOUND', 'Game not found.', 404);
    }
    if (game.status !== 'WAITING') {
      return err('GAME_NOT_JOINABLE', 'This game is no longer joinable.', 409);
    }

    const already = await tx`SELECT * FROM game_players WHERE game_id = ${normalizedGameId} AND account_id = ${account.id}`;

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
      return err('ALREADY_IN_GAME', 'You are already a player in this game.', 409);
    }

    const total = await tx`SELECT COUNT(*)::int AS total FROM game_players WHERE game_id = ${normalizedGameId}`;
    const count = Number(total[0]?.total || 0);
    if (count >= 4) {
      return err('GAME_FULL', 'This game is full.', 409);
    }

    const nextSeat = count;
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
    if (game.status !== 'WAITING') {
      return err('GAME_STARTED', 'Players can only leave waiting lobbies.', 409);
    }

    const membership = await tx`SELECT * FROM game_players WHERE game_id = ${normalizedGameId} AND account_id = ${account.id}`;
    if (!membership[0]) {
      return err('NOT_IN_GAME', 'You are not a member of that game.', 403);
    }

    const remaining = await tx`SELECT * FROM game_players WHERE game_id = ${normalizedGameId} ORDER BY seat_index ASC`;
    const leavingWasHost = game.host_account_id === account.id;

    await tx`DELETE FROM game_players WHERE game_id = ${normalizedGameId} AND account_id = ${account.id}`;

    if (!remaining.length || remaining.length === 1) {
      await tx`DELETE FROM games WHERE id = ${normalizedGameId}`;
      await tx`DELETE FROM game_states WHERE id = ${normalizedGameId}`;
      return { ok: true, gameId: normalizedGameId, deleted: true, status: 'DELETED' };
    }

    const nextPlayers = await tx`SELECT * FROM game_players WHERE game_id = ${normalizedGameId} ORDER BY seat_index ASC`;
    const nextHost = leavingWasHost ? nextPlayers[0].account_id : game.host_account_id;

    if (leavingWasHost) {
      await tx`UPDATE games SET host_account_id = ${nextHost}, updated_at = now() WHERE id = ${normalizedGameId}`;
    }

    const refreshed = await tx`SELECT * FROM games WHERE id = ${normalizedGameId}`;
    const players = await tx`SELECT gp.game_id, gp.account_id, gp.seat_index, gp.joined_at, gp.returned_at, a.username, a.avatar_url
      FROM game_players gp
      JOIN accounts a ON a.id = gp.account_id
      WHERE gp.game_id = ${normalizedGameId}
      ORDER BY gp.seat_index ASC`;

    return {
      ok: true,
      gameId: normalizedGameId,
      game: serializeGameRow(refreshed[0]),
      players: players.map(serializePlayerRow),
      status: refreshed[0].status,
      hostChanged: leavingWasHost,
    };
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

    const players = await tx`SELECT gp.account_id, gp.seat_index, a.username
      FROM game_players gp
      JOIN accounts a ON a.id = gp.account_id
      WHERE gp.game_id = ${normalizedGameId}
      ORDER BY gp.seat_index ASC`;

    if (players.length < 2) {
      return err('NOT_ENOUGH_PLAYERS', 'A game requires at least two players to start.', 409);
    }

    const names = players.map(player => player.username);
    const accountIds = players.map(player => player.account_id);
    const state = engine.createState({ names, accountIds, boardSize: boardData.spaces.length, boardNames: {} });
    state.started = true;
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
      players: players.map(player => ({
        accountId: player.account_id,
        seatIndex: Number(player.seat_index),
        username: player.username,
      })),
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
    const canStart = game.status === 'WAITING' && game.host_account_id === account.id && (
      game.resume_save_id
        ? players.length >= 2 && players.every(player => player.returned_at)
        : players.length >= 2
    );

    return {
      ok: true,
      gameId: normalizedGameId,
      game: serializeGameRow(game),
      players: players.map(serializePlayerRow),
      canStart,
    };
  });

  return games;
}

async function getMyGames({ account, db = database() }) {
  if (!account || !account.id) {
    return err('UNAUTHENTICATED', 'Sign in to continue.', 401);
  }

  const rows = await db.begin(async tx => {
    const games = await tx`SELECT g.*, gp.account_id, gp.seat_index
      FROM game_players gp
      JOIN games g ON g.id = gp.game_id
      WHERE gp.account_id = ${account.id}
      ORDER BY g.updated_at DESC`;

    return games.map(game => ({
      gameId: game.id,
      hostAccountId: game.host_account_id,
      status: game.status,
      selectedBoardId: game.selected_board_id || null,
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
  startGame,
  getLobby,
  getMyGames,
  err,
};
