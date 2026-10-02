const { syncGameAvatars } = require('../../lib/game-profiles');
const { randomUUID } = require('node:crypto');
const engine = require('../../game-engine.js');
const boardData = require('../../game-board.js');
const { database, noStore, parseBody, requireAccount } = require('../../lib/account');
const { persistFinalResultsIfNeeded } = require('../../lib/game-results.js');
const { maintainConnections, initializeConnections } = require('../../lib/game-connections');
const { lockSaveOwner, trimSaveSlots, SAVE_LIMIT } = require('../../lib/save-slots');

function err(code, message, status = 400) {
  return { ok: false, status, error: { code, message } };
}

function normalizeId(value, field) {
  if (typeof value !== 'string' || !value.trim()) return err('INVALID_REQUEST', `A valid ${field} is required.`);
  return value.trim();
}

function normalizeName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return name && name.length <= 80 ? name : null;
}

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value); } catch (error) { return fallback; }
}

function validateSnapshot(snapshot, board) {
  let state;
  try { state = engine.deserializeState(snapshot); } catch (error) { return { error: err('INVALID_SAVE_STATE', 'The saved game state is invalid.') }; }
  const spaces = Array.isArray(board?.spaces) ? board.spaces : [];
  const ids = state.players.map(player => player.id);
  const MAX_SAVE_PLAYERS = 8;
  if (ids.length < 2 || ids.length > MAX_SAVE_PLAYERS || !Array.isArray(state.turnOrder) ||
      state.turnOrder.length !== ids.length || new Set(state.turnOrder).size !== ids.length ||
      !state.turnOrder.every(id => ids.includes(id)) || !Number.isInteger(state.current) ||
      state.current < 0 || state.current >= ids.length || !Number.isInteger(state.turn) || state.turn < 1 ||
      !Array.isArray(state.owners) || !Array.isArray(state.houses) || !Array.isArray(state.mortgaged) ||
      (spaces.length && (state.owners.length !== spaces.length || state.houses.length !== spaces.length || state.mortgaged.length !== spaces.length))) {
    return { error: err('INVALID_SAVE_STATE', 'The saved game state does not match the board or player contract.') };
  }
  return { state };
}

function serializeSave(row) {
  return {
    saveId: row.id || row.save_id,
    ownerId: row.owner_id || row.ownerId,
    sourceGameId: row.source_game_id || row.sourceGameId,
    name: row.name,
    status: row.status,
    version: Number(row.version),
    selectedBoardId: row.selected_board_id || row.selectedBoardId || null,
    players: parseJson(row.players, []),
    createdAt: row.created_at || row.createdAt || null,
    updatedAt: row.updated_at || row.updatedAt || null,
  };
}

async function saveGame({ account, gameId, name, saveId = null, db = database() }) {
  if (!account?.id) return err('UNAUTHENTICATED', 'Sign in to continue.', 401);
  const normalizedGameId = normalizeId(gameId, 'gameId');
  if (typeof normalizedGameId !== 'string') return normalizedGameId;
  const normalizedName = normalizeName(name);
  if (!normalizedName) return err('INVALID_SAVE_NAME', 'A save name between 1 and 80 characters is required.');

  return db.begin(async tx => {
    const games = await tx`SELECT * FROM games WHERE id = ${normalizedGameId} FOR UPDATE`;
    const game = games[0];
    if (!game) return err('GAME_NOT_FOUND', 'Game not found.', 404);
    if (game.host_account_id !== account.id) return err('HOST_REQUIRED', 'Only the host can save the game.', 403);
    if (!['ACTIVE', 'FINISHED'].includes(game.status)) return err('GAME_NOT_ACTIVE', 'Only an active or finished game can be saved.', 409);

    const membership = await tx`SELECT * FROM game_players WHERE game_id = ${normalizedGameId} AND account_id = ${account.id}`;
    if (!membership[0]) return err('NOT_IN_GAME', 'You are not a member of this game.', 403);
    const states = await tx`SELECT id, version, state, board FROM game_states WHERE id = ${normalizedGameId} FOR UPDATE`;
    const stateRow = states[0];
    if (!stateRow) return err('GAME_NOT_FOUND', 'Game state not found.', 404);
    const board = parseJson(stateRow.board, {});
    const checked = validateSnapshot(stateRow.state, board);
    if (checked.error) return checked.error;
    const version = Number(stateRow.version);
    if (!Number.isInteger(version) || version < 1) return err('INVALID_SAVE_STATE', 'The authoritative game version is invalid.');

    const players = await tx`SELECT gp.account_id, gp.seat_index, a.username, a.avatar_url
      FROM game_players gp JOIN accounts a ON a.id = gp.account_id
      WHERE gp.game_id = ${normalizedGameId} ORDER BY gp.seat_index ASC`;
    const metadata = players.map(player => ({
      accountId: player.account_id,
      seatIndex: Number(player.seat_index),
      username: player.username,
      avatarUrl: player.avatar_url || null,
    }));
    await lockSaveOwner(tx, account.id);
    let id = saveId;
    let existingSave = false;
    if (saveId) {
      const owned = await tx`SELECT id FROM game_saves WHERE id = ${saveId} AND owner_id = ${account.id} FOR UPDATE`;
      if (!owned[0]) return err('SAVE_NOT_FOUND', 'Save not found.', 404);
      existingSave = true;
    } else {
      // One match owns one canonical save slot. Repeated saves update it
      // instead of silently creating duplicate entries for the same match.
      const existing = await tx`SELECT id FROM game_saves
        WHERE source_game_id = ${normalizedGameId} AND owner_id = ${account.id}
        ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`;
      id = existing[0]?.id || randomUUID();
      existingSave = !!existing[0];
    }
    if (!existingSave) return err('USE_SAVE_AND_QUIT', 'Use Save & Quit to create the first save for this match.', 409);

    if (existingSave) {
      await tx`UPDATE game_saves SET name = ${normalizedName}, source_game_id = ${normalizedGameId}, status = ${'SAVED'}, version = ${version}, state = ${JSON.stringify(checked.state)}::jsonb, board = ${JSON.stringify(board)}::jsonb, players = ${JSON.stringify(metadata)}::jsonb, selected_board_id = ${game.selected_board_id || null}, updated_at = now() WHERE id = ${id} AND owner_id = ${account.id}`;
    } else {
      await tx`INSERT INTO game_saves (id, owner_id, source_game_id, name, status, version, state, board, players, selected_board_id)
        VALUES (${id}, ${account.id}, ${normalizedGameId}, ${normalizedName}, ${'SAVED'}, ${version}, ${JSON.stringify(checked.state)}::jsonb, ${JSON.stringify(board)}::jsonb, ${JSON.stringify(metadata)}::jsonb, ${game.selected_board_id || null})`;
    }
    await trimSaveSlots(tx, account.id);
    const saved = await tx`SELECT id, owner_id, source_game_id, name, status, version, players, selected_board_id, created_at, updated_at FROM game_saves WHERE id = ${id}`;
    return { ok: true, save: serializeSave(saved[0]) };
  });
}

async function listSaves({ account, db = database() }) {
  if (!account?.id) return err('UNAUTHENTICATED', 'Sign in to continue.', 401);
  const rows = await db.begin(async tx => {
    await lockSaveOwner(tx, account.id);
    await trimSaveSlots(tx, account.id);
    return tx`SELECT id, owner_id, source_game_id, name, status, version, players, selected_board_id, created_at, updated_at FROM game_saves WHERE owner_id = ${account.id} ORDER BY updated_at DESC`;
  });
  // Older builds could create multiple rows for the same match. Keep the
  // newest one visible without destructively deleting any historical data.
  const seenSourceGames = new Set();
  const saves = [];
  for (const row of rows) {
    const source = row.source_game_id || row.id;
    if (seenSourceGames.has(source)) continue;
    seenSourceGames.add(source);
    saves.push(serializeSave(row));
  }
  return { ok: true, saves, saveLimit: SAVE_LIMIT, slotsUsed: saves.length };
}

async function modifySave({ account, saveId, name, remove = false, db = database() }) {
  if (!account?.id) return err('UNAUTHENTICATED', 'Sign in to continue.', 401);
  const id = normalizeId(saveId, 'saveId');
  if (typeof id !== 'string') return id;
  if (!remove && !normalizeName(name)) return err('INVALID_SAVE_NAME', 'Enter a name between 1 and 80 characters.');
  return db.begin(async tx => {
    await lockSaveOwner(tx, account.id);
    if (remove) {
      const deleted = await tx`DELETE FROM game_saves WHERE id = ${id} AND owner_id = ${account.id} RETURNING id`;
      if (!deleted[0]) return err('SAVE_NOT_FOUND', 'Save not found.', 404);
      return { ok: true, deleted: true };
    }
    const rows = await tx`UPDATE game_saves SET name = ${normalizeName(name)}, updated_at = now()
      WHERE id = ${id} AND owner_id = ${account.id} RETURNING id, name`;
    return rows[0] ? { ok: true, saveId: rows[0].id, name: rows[0].name } : err('SAVE_NOT_FOUND', 'Save not found.', 404);
  });
}

async function loadGame({ account, saveId, db = database() }) {
  if (!account?.id) return err('UNAUTHENTICATED', 'Sign in to continue.', 401);
  const normalizedSaveId = normalizeId(saveId, 'saveId');
  if (typeof normalizedSaveId !== 'string') return normalizedSaveId;
  const sources = await db`SELECT source_game_id FROM game_saves WHERE id = ${normalizedSaveId} AND owner_id = ${account.id}`;
  if (sources[0]) await maintainConnections(db, sources[0].source_game_id);
  return db.begin(async tx => {
    if (sources[0]) await tx`SELECT * FROM games WHERE id = ${sources[0].source_game_id} FOR UPDATE`;
    const rows = await tx`SELECT * FROM game_saves WHERE id = ${normalizedSaveId} FOR UPDATE`;
    const save = rows[0];
    if (!save || save.owner_id !== account.id) return err('SAVE_NOT_FOUND', 'Save not found.', 404);
    const state = parseJson(save.state, null);
    const board = parseJson(save.board, {});
    const checked = validateSnapshot(state, board);
    if (checked.error) return checked.error;
    const players = parseJson(save.players, []);
    const remaining = checked.state.players.filter(player => !player.removed);
    if (!Array.isArray(players) || players.length !== remaining.length || players.some(player =>
      !remaining.some(saved => saved.accountId === player.accountId && saved.id === Number(player.seatIndex)))) {
      return err('INVALID_SAVE_STATE', 'The saved player identities do not match the authoritative state.');
    }

    // If the source match is still alive, reopen the real authoritative
    // match instead of cloning an older save snapshot into another lobby.
    // game_states already persists every accepted action, so this also makes
    // reconnecting after a browser/network failure recover the freshest
    // possible state without adding a save write to every turn.
    const liveGames = await tx`SELECT g.id, g.status
      FROM games g
      JOIN game_players gp ON gp.game_id = g.id
      WHERE g.id = ${save.source_game_id}
        AND g.host_account_id = ${account.id}
        AND gp.account_id = ${account.id}
        AND g.status IN ('ACTIVE', 'PAUSED')
      LIMIT 1
      FOR UPDATE OF g`;
    if (liveGames[0]) {
      await tx`UPDATE game_players SET returned_at = now() WHERE game_id = ${liveGames[0].id} AND account_id = ${account.id}`;
      const lobbyPlayers = await tx`SELECT gp.account_id, gp.seat_index, gp.returned_at, a.username, a.avatar_url
        FROM game_players gp
        JOIN accounts a ON a.id = gp.account_id
        WHERE gp.game_id = ${liveGames[0].id}
        ORDER BY gp.seat_index ASC`;
      return {
        ok: true,
        gameId: liveGames[0].id,
        save: serializeSave(save),
        status: liveGames[0].status,
        players: lobbyPlayers.map(player => ({
          accountId: player.account_id,
          seatIndex: Number(player.seat_index),
          username: player.username,
          avatarUrl: player.avatar_url || null,
          returnedAt: player.returned_at || null,
        })),
        reusedExistingGame: true,
      };
    }

    // Repeated clicks on Resume should reuse the same waiting resume lobby
    // instead of creating duplicate games for the same save.
    const pendingGames = await tx`SELECT id, status FROM games
      WHERE resume_save_id = ${normalizedSaveId}
        AND host_account_id = ${account.id}
        AND status = 'WAITING'
      ORDER BY updated_at DESC
      LIMIT 1
      FOR UPDATE`;
    if (pendingGames[0]) {
      await tx`UPDATE game_players SET returned_at = now()
        WHERE game_id = ${pendingGames[0].id} AND account_id = ${account.id} AND returned_at IS NULL`;
      const lobbyPlayers = await tx`SELECT gp.account_id, gp.seat_index, gp.returned_at, a.username, a.avatar_url
        FROM game_players gp
        JOIN accounts a ON a.id = gp.account_id
        WHERE gp.game_id = ${pendingGames[0].id}
        ORDER BY gp.seat_index ASC`;
      return {
        ok: true,
        gameId: pendingGames[0].id,
        save: serializeSave(save),
        status: 'WAITING',
        players: lobbyPlayers.map(player => ({
          accountId: player.account_id,
          seatIndex: Number(player.seat_index),
          username: player.username,
          avatarUrl: player.avatar_url || null,
          returnedAt: player.returned_at || null,
        })),
        reusedResumeLobby: true,
      };
    }

    const gameId = randomUUID();
    await tx`INSERT INTO games (id, host_account_id, name, status, invite_only, selected_board_id, resume_save_id, created_at, started_at, updated_at)
      VALUES (${gameId}, ${account.id}, ${save.name}, ${'WAITING'}, ${true}, ${save.selected_board_id || null}, ${normalizedSaveId}, now(), NULL, now())`;
    // Once opened, a resume lobby owns its checkpoint. Evicting an old save
    // slot cannot invalidate a lobby players have already been invited to.
    await tx`INSERT INTO game_states (id, owner_id, state, board, version)
      VALUES (${gameId}, ${account.id}, ${JSON.stringify(checked.state)}::jsonb, ${JSON.stringify(board)}::jsonb, ${Number(save.version)})`;
    for (const player of players) {
      await tx`INSERT INTO game_players (game_id, account_id, seat_index, joined_at, returned_at)
        VALUES (${gameId}, ${player.accountId}, ${Number(player.seatIndex)}, now(), ${player.accountId === account.id ? new Date() : null})`;
    }
    await tx`UPDATE game_saves SET status = ${'LOADED'}, updated_at = now() WHERE id = ${normalizedSaveId}`;
    return { ok: true, gameId, save: serializeSave(save), status: 'WAITING', players };
  });
}

async function resumeGame({ account, gameId, db = database() }) {
  if (!account?.id) return err('UNAUTHENTICATED', 'Sign in to continue.', 401);
  const normalizedGameId = normalizeId(gameId, 'gameId');
  if (typeof normalizedGameId !== 'string') return normalizedGameId;
  await maintainConnections(db, normalizedGameId);
  return db.begin(async tx => {
    const games = await tx`SELECT * FROM games WHERE id = ${normalizedGameId} FOR UPDATE`;
    const game = games[0];
    if (!game) return err('GAME_NOT_FOUND', 'Game not found.', 404);
    if (game.host_account_id !== account.id) return err('HOST_REQUIRED', 'Only the host can resume the game.', 403);

    if (game.status === 'PAUSED' && !game.resume_save_id) {
      const players = await tx`SELECT account_id, seat_index, returned_at FROM game_players
        WHERE game_id = ${normalizedGameId} ORDER BY seat_index ASC FOR UPDATE`;
      if (!players.some(player => player.account_id === account.id)) {
        return err('HOST_NOT_PLAYER', 'The host must be an original player to continue this match.', 403);
      }
      if (players.length < 2 || players.some(player => !player.returned_at)) {
        return err('PLAYERS_MISSING', 'All original players must return before the game can resume.', 409);
      }

      const states = await tx`SELECT id, version, state, board FROM game_states WHERE id = ${normalizedGameId} FOR UPDATE`;
      const stateRow = states[0];
      if (!stateRow) return err('GAME_STATE_NOT_FOUND', 'The authoritative match state is unavailable.', 404);
      const state = engine.deserializeState(stateRow.state);
      if (state.over || state.players.filter(player => !player.removed).length !== players.length || players.some(member =>
        !state.players.some(player => !player.removed && player.accountId === member.account_id && player.id === Number(member.seat_index)))) {
        return err('PLAYER_ROSTER_MISMATCH', 'The saved state does not match the original player seats.', 409);
      }

      delete state.connections;
      initializeConnections(state);
      // Paused time does not consume the remaining turn/trade timer.
      const elapsed = Date.now() - new Date(game.paused_at || Date.now()).getTime();
      if (state.tradeTimerEnd) state.tradeTimerEnd += Math.max(0, elapsed);
      if (state.viewTrade?.expiresAt) state.viewTrade.expiresAt += Math.max(0, elapsed);
      await tx`UPDATE game_states SET state = ${JSON.stringify(state)}::jsonb, version = ${Number(stateRow.version) + 1}, updated_at = now() WHERE id = ${normalizedGameId}`;

      await tx`UPDATE games SET status = ${'ACTIVE'}, paused_at = NULL, updated_at = now()
        WHERE id = ${normalizedGameId} AND status = ${'PAUSED'}`;
      return {
        ok: true,
        gameId: normalizedGameId,
        status: 'ACTIVE',
        version: Number(stateRow.version) + 1,
        state,
        board: parseJson(stateRow.board, {}),
        players: players.map(player => ({ accountId: player.account_id, seatIndex: Number(player.seat_index) })),
      };
    }

    if (game.status !== 'WAITING' || !game.resume_save_id) return err('NOT_RESUME_LOBBY', 'This game is not a resume lobby.', 409);
    const players = await tx`SELECT account_id, seat_index, returned_at FROM game_players WHERE game_id = ${normalizedGameId} ORDER BY seat_index ASC`;
    if (players.some(player => !player.returned_at)) return err('PLAYERS_MISSING', 'Invite all remaining players before resuming.', 409);
    const saves = await tx`SELECT version, state, board FROM game_saves WHERE id = ${game.resume_save_id} AND owner_id = ${account.id} FOR UPDATE`;
    const save = saves[0] || (await tx`SELECT version, state, board FROM game_states WHERE id = ${normalizedGameId} FOR UPDATE`)[0];
    if (!save) return err('SAVE_NOT_FOUND', 'Save not found.', 404);
    const board = parseJson(save.board, {});
    const spaces = Array.isArray(board?.spaces) ? board.spaces : boardData.spaces;
    const checked = validateSnapshot(save.state, board);
    if (checked.error) return checked.error;
    if (players.length < 2 && !checked.state.over) return err('PLAYERS_MISSING', 'At least two remaining players are required.', 409);
    await syncGameAvatars(tx, checked.state);
    delete checked.state.connections;
    initializeConnections(checked.state);
    checked.state.tradeTimerEnd = checked.state.tradeTimerEnd ? Date.now() + 75000 : null;
    if (checked.state.viewTrade) checked.state.viewTrade.expiresAt = Date.now() + 10000;
    await tx`INSERT INTO game_states (id, owner_id, state, board, version)
      VALUES (${normalizedGameId}, ${account.id}, ${JSON.stringify(checked.state)}::jsonb, ${JSON.stringify(board)}::jsonb, ${Number(save.version)})
      ON CONFLICT (id) DO UPDATE SET owner_id = EXCLUDED.owner_id, state = EXCLUDED.state, board = EXCLUDED.board, version = EXCLUDED.version, updated_at = now()`;
    await tx`UPDATE games
      SET status = ${checked.state.over ? 'FINISHED' : 'ACTIVE'}, resume_save_id = NULL,
          started_at = COALESCE(started_at, now()), updated_at = now()
      WHERE id = ${normalizedGameId}`;
    // The resumed match continues using the same save slot. Clearing
    // resume_save_id makes later Save & Quit / Continue cycles behave like
    // a normal active match instead of getting stuck as a resume lobby.
    await tx`UPDATE game_saves
      SET source_game_id = ${normalizedGameId}, status = ${'SAVED'}, updated_at = now()
      WHERE id = ${game.resume_save_id} AND owner_id = ${account.id}`;
    // Covers the edge case of resuming a save taken after the game had
    // already ended: derives FINISHED/results from the restored state
    // itself, and is a no-op (via ON CONFLICT DO NOTHING) if a result row
    // already exists for this game id.
    await persistFinalResultsIfNeeded(tx, normalizedGameId, checked.state, spaces);
    return { ok: true, gameId: normalizedGameId, status: checked.state.over ? 'FINISHED' : 'ACTIVE', version: Number(save.version), state: checked.state, board };
  });
}

async function savesRoute(req, res) {
  noStore(res);

  const account = await requireAccount(req, res);
  if (!account) return;

  if (['PATCH', 'DELETE'].includes(req.method)) {
    const { requireSameOrigin } = require('../../lib/account');
    if (!requireSameOrigin(req, res)) return;
    const body = parseBody(req);
    const result = await modifySave({ account, saveId: body.saveId, name: body.name, remove: req.method === 'DELETE', db: database() });
    return res.status(result.ok ? 200 : result.status).json(result);
  }

  if (req.method === 'POST') {
    const body = parseBody(req);
    // Only ever the authenticated account, the gameId and name it typed,
    // and the existing saveId to overwrite (if any) are taken from the
    // client. Everything that matters -- host check, membership check,
    // and the actual state snapshot -- is re-derived server-side inside
    // saveGame() from the authoritative game_states row, never from
    // anything the client could supply about its own state.
    const result = await saveGame({
      account,
      gameId: body.gameId || body.game_id || null,
      name: body.name,
      saveId: body.saveId || body.save_id || null,
      db: database(),
    });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    return res.status(200).json({ ok: true, save: result.save });
  }

  if (req.method === 'GET') {
    // listSaves() itself filters by owner_id = account.id, so this can
    // never return another account's saves regardless of what the
    // request contains.
    const result = await listSaves({ account, db: database() });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    return res.status(200).json({ ok: true, saves: result.saves, saveLimit: result.saveLimit, slotsUsed: result.slotsUsed });
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
  return res.status(405).json({ error: 'Method not allowed.' });
}

module.exports = savesRoute;
module.exports.saveGame = saveGame;
module.exports.listSaves = listSaves;
module.exports.loadGame = loadGame;
module.exports.resumeGame = resumeGame;
module.exports.validateSnapshot = validateSnapshot;
module.exports.serializeSave = serializeSave;
module.exports.modifySave = modifySave;
module.exports.handleSavesRoute = savesRoute;
