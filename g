[1mdiff --git a/api/game/action.js b/api/game/action.js[m
[1mindex 865cf2c..d297daf 100644[m
[1m--- a/api/game/action.js[m
[1m+++ b/api/game/action.js[m
[36m@@ -2,6 +2,7 @@[m [mconst engine = require('../../game-engine.js');[m
 const boardData = require('../../game-board.js');[m
 const cardData = require('../../game-cards.js');[m
 const { database, noStore, parseBody, requireAccount } = require('../../lib/account');[m
[32m+[m[32mconst { persistFinalResultsIfNeeded } = require('../../lib/game-results.js');[m
 [m
 function statusForError(code) {[m
   switch (code) {[m
[36m@@ -270,6 +271,7 @@[m [masync function executeGameAction({[m
         ok: true,[m
         gameId,[m
         version: nextVersion,[m
[32m+[m[32m        status: resolved.state.over ? 'FINISHED' : 'ACTIVE',[m
         state: resolved.state,[m
         events: resolved.events,[m
       };[m
[36m@@ -280,6 +282,11 @@[m [masync function executeGameAction({[m
             updated_at = now()[m
         WHERE id = ${gameId}`;[m
 [m
[32m+[m[32m      // Server-derived only: this reads resolved.state.over, which the[m
[32m+[m[32m      // engine alone can set (see declareBankruptcy in game-engine.js).[m
[32m+[m[32m      // Nothing here ever trusts a client-supplied status or result.[m
[32m+[m[32m      await persistFinalResultsIfNeeded(tx, gameId, resolved.state, spaces);[m
[32m+[m
       if (requestId) {[m
         const inserted = await tx`INSERT INTO game_action_requests (game_id, request_id, result_json)[m
           VALUES (${gameId}, ${requestId}, ${JSON.stringify(payload)}::jsonb)[m
[36m@@ -336,6 +343,7 @@[m [masync function handleGameAction(req, res, deps = {}) {[m
       ok: true,[m
       gameId: result.gameId,[m
       version: result.version,[m
[32m+[m[32m      status: result.status || 'ACTIVE',[m
       state: redactTradeState(result.state, account.id),[m
       events: result.events,[m
     });[m
[1mdiff --git a/api/game/lifecycle.js b/api/game/lifecycle.js[m
[1mindex 05fe88d..21489a4 100644[m
[1m--- a/api/game/lifecycle.js[m
[1m+++ b/api/game/lifecycle.js[m
[36m@@ -20,6 +20,7 @@[m [mfunction serializePlayerRow(row) {[m
     username: row.username,[m
     avatarUrl: row.avatar_url || row.avatarUrl || null,[m
     joinedAt: row.joined_at || row.joinedAt || null,[m
[32m+[m[32m    returnedAt: row.returned_at || row.returnedAt || null,[m
   };[m
 }[m
 [m
[36m@@ -29,12 +30,14 @@[m [mfunction serializeGameRow(row) {[m
     hostAccountId: row.host_account_id || row.hostAccountId,[m
     status: row.status,[m
     selectedBoardId: row.selected_board_id || row.selectedBoardId || null,[m
[32m+[m[32m    resumeSaveId: row.resume_save_id || row.resumeSaveId || null,[m
     createdAt: row.created_at || row.createdAt || null,[m
     startedAt: row.started_at || row.startedAt || null,[m
     updatedAt: row.updated_at || row.updatedAt || null,[m
   };[m
 }[m
 [m
[32m+[m
 async function ensureBoardOwner(tx, accountId, selectedBoardId) {[m
   if (!selectedBoardId) return null;[m
   const rows = await tx`SELECT id, owner_id FROM custom_boards WHERE id = ${selectedBoardId}`;[m
[36m@@ -63,7 +66,7 @@[m [masync function createGame({ account, selectedBoardId, db = database() }) {[m
       VALUES (${gameId}, ${account.id}, ${0}, now())`;[m
 [m
     const games = await tx`SELECT * FROM games WHERE id = ${gameId}`;[m
[31m-    const players = await tx`SELECT gp.game_id, gp.account_id, gp.seat_index, gp.joined_at, a.username, a.avatar_url[m
[32m+[m[32m    const players = await tx`SELECT gp.game_id, gp.account_id, gp.seat_index, gp.joined_at, gp.returned_at, a.username, a.avatar_url[m
       FROM game_players gp[m
       JOIN accounts a ON a.id = gp.account_id[m
       WHERE gp.game_id = ${gameId}[m
[36m@@ -99,6 +102,38 @@[m [masync function joinGame({ account, gameId, db = database() }) {[m
     }[m
 [m
     const already = await tx`SELECT * FROM game_players WHERE game_id = ${normalizedGameId} AND account_id = ${account.id}`;[m
[32m+[m
[32m+[m[32m    if (game.resume_save_id) {[m
[32m+[m[32m      // Resume lobbies are pre-seeded (by loadGame) with one row per[m
[32m+[m[32m      // original account/seat. Nobody new can join one: an account with[m
[32m+[m[32m      // no seat here was never part of the saved game, so it is rejected[m
[32m+[m[32m      // as a substitute rather than allowed to take an open slot. An[m
[32m+[m[32m      // account that does have a seat is "returning", not joining, so we[m
[32m+[m[32m      // only ever stamp returned_at on its existing row -- we never[m
[32m+[m[32m      // insert a row or move it to a different seat, which is what keeps[m
[32m+[m[32m      // another account from ever being able to occupy that seat.[m
[32m+[m[32m      if (!already[0]) {[m
[32m+[m[32m        return err('NOT_ORIGINAL_PLAYER', 'Only the original players from this save can return to it.', 403);[m
[32m+[m[32m      }[m
[32m+[m[32m      if (!already[0].returned_at) {[m
[32m+[m[32m        await tx`UPDATE game_players SET returned_at = now() WHERE game_id = ${normalizedGameId} AND account_id = ${account.id}`;[m
[32m+[m[32m      }[m
[32m+[m
[32m+[m[32m      const players = await tx`SELECT gp.game_id, gp.account_id, gp.seat_index, gp.joined_at, gp.returned_at, a.username, a.avatar_url[m
[32m+[m[32m        FROM game_players gp[m
[32m+[m[32m        JOIN accounts a ON a.id = gp.account_id[m
[32m+[m[32m        WHERE gp.game_id = ${normalizedGameId}[m
[32m+[m[32m        ORDER BY gp.seat_index ASC`;[m
[32m+[m
[32m+[m[32m      return {[m
[32m+[m[32m        ok: true,[m
[32m+[m[32m        gameId: normalizedGameId,[m
[32m+[m[32m        game: serializeGameRow(game),[m
[32m+[m[32m        players: players.map(serializePlayerRow),[m
[32m+[m[32m        status: game.status,[m
[32m+[m[32m      };[m
[32m+[m[32m    }[m
[32m+[m
     if (already[0]) {[m
       return err('ALREADY_IN_GAME', 'You are already a player in this game.', 409);[m
     }[m
[36m@@ -113,7 +148,7 @@[m [masync function joinGame({ account, gameId, db = database() }) {[m
     await tx`INSERT INTO game_players (game_id, account_id, seat_index, joined_at)[m
       VALUES (${normalizedGameId}, ${account.id}, ${nextSeat}, now())`;[m
 [m
[31m-    const players = await tx`SELECT gp.game_id, gp.account_id, gp.seat_index, gp.joined_at, a.username, a.avatar_url[m
[32m+[m[32m    const players = await tx`SELECT gp.game_id, gp.account_id, gp.seat_index, gp.joined_at, gp.returned_at, a.username, a.avatar_url[m
       FROM game_players gp[m
       JOIN accounts a ON a.id = gp.account_id[m
       WHERE gp.game_id = ${normalizedGameId}[m
[36m@@ -172,7 +207,7 @@[m [masync function leaveGame({ account, gameId, db = database() }) {[m
     }[m
 [m
     const refreshed = await tx`SELECT * FROM games WHERE id = ${normalizedGameId}`;[m
[31m-    const players = await tx`SELECT gp.game_id, gp.account_id, gp.seat_index, gp.joined_at, a.username, a.avatar_url[m
[32m+[m[32m    const players = await tx`SELECT gp.game_id, gp.account_id, gp.seat_index, gp.joined_at, gp.returned_at, a.username, a.avatar_url[m
       FROM game_players gp[m
       JOIN accounts a ON a.id = gp.account_id[m
       WHERE gp.game_id = ${normalizedGameId}[m
[36m@@ -210,6 +245,14 @@[m [masync function startGame({ account, gameId, db = database() }) {[m
     if (game.status !== 'WAITING') {[m
       return err('GAME_ALREADY_STARTED', 'This game has already started.', 409);[m
     }[m
[32m+[m[32m    if (game.resume_save_id) {[m
[32m+[m[32m      // A resume lobby's authoritative state comes only from resumeGame(),[m
[32m+[m[32m      // which restores the exact saved snapshot. Routing it through the[m
[32m+[m[32m      // normal startGame() would silently rebuild fresh players from[m
[32m+[m[32m      // current lobby profiles and discard the saved money/properties/[m
[32m+[m[32m      // turn state entirely, so it is refused here rather than allowed.[m
[32m+[m[32m      return err('USE_RESUME_ENDPOINT', 'This lobby resumes a saved game; use the resume endpoint to start it.', 409);[m
[32m+[m[32m    }[m
 [m
     const players = await tx`SELECT gp.account_id, gp.seat_index, a.username[m
       FROM game_players gp[m
[36m@@ -272,18 +315,30 @@[m [masync function getLobby({ account, gameId, db = database() }) {[m
       return err('NOT_IN_GAME', 'You are not a member of this game.', 403);[m
     }[m
 [m
[31m-    const players = await tx`SELECT gp.game_id, gp.account_id, gp.seat_index, gp.joined_at, a.username, a.avatar_url[m
[32m+[m[32m    const players = await tx`SELECT gp.game_id, gp.account_id, gp.seat_index, gp.joined_at, gp.returned_at, a.username, a.avatar_url[m
       FROM game_players gp[m
       JOIN accounts a ON a.id = gp.account_id[m
       WHERE gp.game_id = ${normalizedGameId}[m
       ORDER BY gp.seat_index ASC`;[m
 [m
[32m+[m[32m    // canStart reflects, for the UI's convenience only, exactly the rule[m
[32m+[m[32m    // the backend itself enforces: startGame() for a fresh lobby requires[m
[32m+[m[32m    // 2+ seated players; resumeGame() for a resume lobby requires every[m
[32m+[m[32m    // original seat's returned_at to be set. Neither the client nor this[m
[32m+[m[32m    // flag is ever trusted to gate the actual transition -- startGame and[m
[32m+[m[32m    // resumeGame re-check these conditions themselves.[m
[32m+[m[32m    const canStart = game.status === 'WAITING' && game.host_account_id === account.id && ([m
[32m+[m[32m      game.resume_save_id[m
[32m+[m[32m        ? players.length >= 2 && players.every(player => player.returned_at)[m
[32m+[m[32m        : players.length >= 2[m
[32m+[m[32m    );[m
[32m+[m
     return {[m
       ok: true,[m
       gameId: normalizedGameId,[m
       game: serializeGameRow(game),[m
       players: players.map(serializePlayerRow),[m
[31m-      canStart: game.status === 'WAITING' && game.host_account_id === account.id && players.length >= 2,[m
[32m+[m[32m      canStart,[m
     };[m
   });[m
 [m
[1mdiff --git a/api/game/saves.js b/api/game/saves.js[m
[1mindex b76c3d6..9b7df25 100644[m
[1m--- a/api/game/saves.js[m
[1m+++ b/api/game/saves.js[m
[36m@@ -1,7 +1,8 @@[m
 const { randomUUID } = require('node:crypto');[m
 const engine = require('../../game-engine.js');[m
 const boardData = require('../../game-board.js');[m
[31m-const { database } = require('../../lib/account');[m
[32m+[m[32mconst { database, noStore, parseBody, requireAccount } = require('../../lib/account');[m
[32m+[m[32mconst { persistFinalResultsIfNeeded } = require('../../lib/game-results.js');[m
 [m
 function err(code, message, status = 400) {[m
   return { ok: false, status, error: { code, message } };[m
[36m@@ -152,14 +153,69 @@[m [masync function resumeGame({ account, gameId, db = database() }) {[m
     const save = saves[0];[m
     if (!save) return err('SAVE_NOT_FOUND', 'Save not found.', 404);[m
     const board = parseJson(save.board, {});[m
[32m+[m[32m    const spaces = Array.isArray(board?.spaces) ? board.spaces : boardData.spaces;[m
     const checked = validateSnapshot(save.state, board);[m
     if (checked.error) return checked.error;[m
     await tx`INSERT INTO game_states (id, owner_id, state, board, version)[m
       VALUES (${normalizedGameId}, ${account.id}, ${JSON.stringify(checked.state)}::jsonb, ${JSON.stringify(board)}::jsonb, ${Number(save.version)})[m
       ON CONFLICT (id) DO UPDATE SET owner_id = EXCLUDED.owner_id, state = EXCLUDED.state, board = EXCLUDED.board, version = EXCLUDED.version, updated_at = now()`;[m
     await tx`UPDATE games SET status = ${checked.state.over ? 'FINISHED' : 'ACTIVE'}, started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = ${normalizedGameId}`;[m
[32m+[m[32m    // Covers the edge case of resuming a save taken after the game had[m
[32m+[m[32m    // already ended: derives FINISHED/results from the restored state[m
[32m+[m[32m    // itself, and is a no-op (via ON CONFLICT DO NOTHING) if a result row[m
[32m+[m[32m    // already exists for this game id.[m
[32m+[m[32m    await persistFinalResultsIfNeeded(tx, normalizedGameId, checked.state, spaces);[m
     return { ok: true, gameId: normalizedGameId, status: checked.state.over ? 'FINISHED' : 'ACTIVE', version: Number(save.version), state: checked.state, board };[m
   });[m
 }[m
 [m
[31m-module.exports = { saveGame, listSaves, loadGame, resumeGame, validateSnapshot, serializeSave };[m
[32m+[m[32masync function savesRoute(req, res) {[m
[32m+[m[32m  noStore(res);[m
[32m+[m
[32m+[m[32m  const account = await requireAccount(req, res);[m
[32m+[m[32m  if (!account) return;[m
[32m+[m
[32m+[m[32m  if (req.method === 'POST') {[m
[32m+[m[32m    const body = parseBody(req);[m
[32m+[m[32m    // Only ever the authenticated account, the gameId and name it typed,[m
[32m+[m[32m    // and the existing saveId to overwrite (if any) are taken from the[m
[32m+[m[32m    // client. Everything that matters -- host check, membership check,[m
[32m+[m[32m    // and the actual state snapshot -- is re-derived server-side inside[m
[32m+[m[32m    // saveGame() from the authoritative game_states row, never from[m
[32m+[m[32m    // anything the client could supply about its own state.[m
[32m+[m[32m    const result = await saveGame({[m
[32m+[m[32m      account,[m
[32m+[m[32m      gameId: body.gameId || body.game_id || null,[m
[32m+[m[32m      name: body.name,[m
[32m+[m[32m      saveId: body.saveId || body.save_id || null,[m
[32m+[m[32m      db: database(),[m
[32m+[m[32m    });[m
[32m+[m[32m    if (!result.ok) {[m
[32m+[m[32m      return res.status(result.status).json({ error: result.error });[m
[32m+[m[32m    }[m
[32m+[m[32m    return res.status(200).json({ ok: true, save: result.save });[m
[32m+[m[32m  }[m
[32m+[m
[32m+[m[32m  if (req.method === 'GET') {[m
[32m+[m[32m    // listSaves() itself filters by owner_id = account.id, so this can[m
[32m+[m[32m    // never return another account's saves regardless of what the[m
[32m+[m[32m    // request contains.[m
[32m+[m[32m    const result = await listSaves({ account, db: database() });[m
[32m+[m[32m    if (!result.ok) {[m
[32m+[m[32m      return res.status(result.status).json({ error: result.error });[m
[32m+[m[32m    }[m
[32m+[m[32m    return res.status(200).json({ ok: true, saves: result.saves });[m
[32m+[m[32m  }[m
[32m+[m
[32m+[m[32m  res.setHeader('Allow', 'GET, POST');[m
[32m+[m[32m  return res.status(405).json({ error: 'Method not allowed.' });[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32mmodule.exports = savesRoute;[m
[32m+[m[32mmodule.exports.saveGame = saveGame;[m
[32m+[m[32mmodule.exports.listSaves = listSaves;[m
[32m+[m[32mmodule.exports.loadGame = loadGame;[m
[32m+[m[32mmodule.exports.resumeGame = resumeGame;[m
[32m+[m[32mmodule.exports.validateSnapshot = validateSnapshot;[m
[32m+[m[32mmodule.exports.serializeSave = serializeSave;[m
[32m+[m[32mmodule.exports.handleSavesRoute = savesRoute;[m
[1mdiff --git a/db/schema.sql b/db/schema.sql[m
[1mindex 1622214..5b50003 100644[m
[1m--- a/db/schema.sql[m
[1m+++ b/db/schema.sql[m
[36m@@ -132,4 +132,14 @@[m [mCREATE INDEX IF NOT EXISTS game_saves_owner_updated_idx[m
   ON game_saves (owner_id, updated_at DESC);[m
 [m
 CREATE INDEX IF NOT EXISTS games_resume_save_idx[m
[31m-  ON games (resume_save_id);[m
\ No newline at end of file[m
[32m+[m[32m  ON games (resume_save_id);[m
[32m+[m
[32m+[m[32mCREATE TABLE IF NOT EXISTS game_results ([m
[32m+[m[32m  game_id TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,[m
[32m+[m[32m  winner_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,[m
[32m+[m[32m  placements JSONB NOT NULL,[m
[32m+[m[32m  created_at TIMESTAMPTZ NOT NULL DEFAULT now()[m
[32m+[m[32m);[m
[32m+[m
[32m+[m[32mCREATE INDEX IF NOT EXISTS game_results_winner_idx[m
[32m+[m[32m  ON game_results (winner_account_id);[m
\ No newline at end of file[m
[1mdiff --git a/game-engine.js b/game-engine.js[m
[1mindex 2bfa377..c95318b 100644[m
[1m--- a/game-engine.js[m
[1m+++ b/game-engine.js[m
[36m@@ -131,6 +131,51 @@[m
     return 0;[m
   }[m
 [m
[32m+[m[32m  // Authoritative net worth for a single player: cash on hand plus the[m
[32m+[m[32m  // value of every asset they own. Unmortgaged properties count at full[m
[32m+[m[32m  // board price; mortgaged properties count at their mortgage value[m
[32m+[m[32m  // (what the bank paid out for them) since that's the value actually[m
[32m+[m[32m  // backing the player's position; houses/hotels count at their full[m
[32m+[m[32m  // build cost. This is intentionally distinct from liquidationValue(),[m
[32m+[m[32m  // which is a private, in-turn "how much can this player raise right[m
[32m+[m[32m  // now" helper used only during forced asset sales.[m
[32m+[m[32m  function calculateNetWorth(state, spaces, playerId) {[m
[32m+[m[32m    const p = state.players[playerId];[m
[32m+[m[32m    if (!p) return 0;[m
[32m+[m[32m    let worth = p.money;[m
[32m+[m[32m    for (let index = 0; index < spaces.length; index++) {[m
[32m+[m[32m      if (state.owners[index] !== playerId) continue;[m
[32m+[m[32m      const space = spaces[index];[m
[32m+[m[32m      worth += (state.houses[index] || 0) * (space.houseCost || 0);[m
[32m+[m[32m      worth += state.mortgaged[index] ? mortgageValue(spaces, index) : (space.price || 0);[m
[32m+[m[32m    }[m
[32m+[m[32m    return worth;[m
[32m+[m[32m  }[m
[32m+[m
[32m+[m[32m  // Authoritative final placements for an ended game (state.over === true).[m
[32m+[m[32m  // 1st place is the surviving winner (state.winnerId); the rest are[m
[32m+[m[32m  // ranked by reverse bankruptcy order (the most recently eliminated[m
[32m+[m[32m  // player placed higher than one eliminated earlier). Money and net[m
[32m+[m[32m  // worth are read straight from authoritative state -- bankrupt players[m
[32m+[m[32m  // have already had their assets transferred away and money zeroed by[m
[32m+[m[32m  // declareBankruptcy, so they correctly show 0/0.[m
[32m+[m[32m  function computeFinalResults(state, spaces) {[m
[32m+[m[32m    if (!state.over) return null;[m
[32m+[m[32m    const eliminated = Array.isArray(state.eliminatedOrder) ? state.eliminatedOrder.slice().reverse() : [];[m
[32m+[m[32m    const ranked = state.winnerId == null ? eliminated : [state.winnerId, ...eliminated.filter(id => id !== state.winnerId)];[m
[32m+[m[32m    return ranked.map((playerId, index) => {[m
[32m+[m[32m      const p = state.players[playerId];[m
[32m+[m[32m      return {[m
[32m+[m[32m        playerId,[m
[32m+[m[32m        accountId: p ? p.accountId : null,[m
[32m+[m[32m        name: p ? p.name : null,[m
[32m+[m[32m        placement: index + 1,[m
[32m+[m[32m        money: p ? p.money : 0,[m
[32m+[m[32m        netWorth: calculateNetWorth(state, spaces, playerId),[m
[32m+[m[32m      };[m
[32m+[m[32m    });[m
[32m+[m[32m  }[m
[32m+[m
   function canManage(state) {[m
     return !state.over && ([m
       ['buy', 'after', 'debt'].includes(state.phase) ||[m
[36m@@ -844,5 +889,7 @@[m
     validateTrade,[m
     legalActions,[m
     applyAction,[m
[32m+[m[32m    calculateNetWorth,[m
[32m+[m[32m    computeFinalResults,[m
   };[m
 });[m
\ No newline at end of file[m
[1mdiff --git a/game-engine.test.js b/game-engine.test.js[m
[1mindex f56ccd6..5b2671c 100644[m
[1m--- a/game-engine.test.js[m
[1m+++ b/game-engine.test.js[m
[36m@@ -402,6 +402,48 @@[m [mtest('trades cannot include unowned properties or properties in a developed set'[m
   assert.equal(engine.validateTrade(state, trade, spaces).code, 'PROPERTY_NOT_TRADABLE');[m
 });[m
 [m
[32m+[m[32mtest('net worth counts cash plus unmortgaged property price, mortgage value, and full house cost', () => {[m
[32m+[m[32m  const state = newState();[m
[32m+[m[32m  assert.equal(engine.calculateNetWorth(state, spaces, 0), state.players[0].money);[m
[32m+[m
[32m+[m[32m  state.owners[1] = 0;[m
[32m+[m[32m  state.houses[1] = 2;[m
[32m+[m[32m  assert.equal(engine.calculateNetWorth(state, spaces, 0), state.players[0].money + 60 + 2 * 50);[m
[32m+[m
[32m+[m[32m  state.owners[3] = 0;[m
[32m+[m[32m  state.mortgaged[3] = true;[m
[32m+[m[32m  assert.equal(engine.calculateNetWorth(state, spaces, 0), state.players[0].money + 60 + 2 * 50 + 30);[m
[32m+[m
[32m+[m[32m  assert.equal(engine.calculateNetWorth(state, spaces, 99), 0);[m
[32m+[m[32m});[m
[32m+[m
[32m+[m[32mtest('final results rank the winner first and the rest by reverse bankruptcy order, with authoritative money and net worth', () => {[m
[32m+[m[32m  const state = newState();[m
[32m+[m[32m  state.over = true;[m
[32m+[m[32m  state.winnerId = 0;[m
[32m+[m[32m  // Player 2 went bankrupt before player 1 did, so player 1 (eliminated[m
[32m+[m[32m  // more recently) should place above player 2.[m
[32m+[m[32m  state.eliminatedOrder = [2, 1];[m
[32m+[m[32m  state.players[0].money = 1500;[m
[32m+[m[32m  state.owners[1] = 0;[m
[32m+[m[32m  state.players[1].money = 0;[m
[32m+[m[32m  state.players[2].money = 0;[m
[32m+[m
[32m+[m[32m  const results = engine.computeFinalResults(state, spaces);[m
[32m+[m[32m  assert.deepEqual(results.map(entry => entry.placement), [1, 2, 3]);[m
[32m+[m[32m  assert.deepEqual(results.map(entry => entry.playerId), [0, 1, 2]);[m
[32m+[m[32m  assert.deepEqual(results.map(entry => entry.accountId), ['account-a', null, 'account-c']);[m
[32m+[m[32m  assert.equal(results[0].money, 1500);[m
[32m+[m[32m  assert.equal(results[0].netWorth, 1500 + 60);[m
[32m+[m[32m  assert.equal(results[1].money, 0);[m
[32m+[m[32m  assert.equal(results[1].netWorth, 0);[m
[32m+[m[32m  assert.equal(results[2].money, 0);[m
[32m+[m[32m  assert.equal(results[2].netWorth, 0);[m
[32m+[m
[32m+[m[32m  const notOver = newState();[m
[32m+[m[32m  assert.equal(engine.computeFinalResults(notOver, spaces), null);[m
[32m+[m[32m});[m
[32m+[m
 const { handleGameAction, executeGameAction } = require('./api/game/action.js');[m
 [m
 function makeRes() {[m
[1mdiff --git a/index.html b/index.html[m
[1mindex df67ad0..d8babc2 100644[m
[1m--- a/index.html[m
[1m+++ b/index.html[m
[36m@@ -872,6 +872,8 @@[m [minput:focus-visible {[m
 .panel { background: var(--panel); color: var(--fg); border: 2px solid var(--border); border-radius: 10px; padding: var(--sp3); box-shadow: 0 4px 10px rgba(0,0,0,.12); }[m
 .panel h2 { margin: 0 0 var(--sp2); font-size: 1.05rem; font-weight: 800; }[m
 .tag { font-size: .75rem; background: var(--btn-alt); color: var(--btn-alt-fg); border-radius: 4px; padding: 0 var(--sp1); font-weight: 700; }[m
[32m+[m[32m.tag.ok { background: #00A650; color: #fff; }[m
[32m+[m[32m.tag.wait { background: #F57F1C; color: #fff; }[m
 .muted { color: var(--muted); font-size: .85rem; }[m
 [m
 /* Title deed card: always paper (parchment), like the real thing --[m
[36m@@ -2736,7 +2738,7 @@[m [mfunction buildShell() {[m
         🎵<input type="range" id="volSlider" min="0" max="100" step="1" oninput="setMusicVolume(this.value)">[m
       </label>[m
     </div>[m
[31m-    <div class="corner-tr"><span id="pauseBtnHolder"></span></div>[m
[32m+[m[32m    <div class="corner-tr"><span id="saveGameBtnHolder"></span><span id="pauseBtnHolder"></span></div>[m
     <div class="layout">[m
       <div class="side-left">[m
         <div class="hud"><div class="hud-pills" id="hudPills"></div><div class="hud-floats" id="hudFloats"></div></div>[m
[36m@@ -2943,6 +2945,7 @@[m [mfunction updateDock() {[m
     <div class="dock-group action">${primary}</div>`;[m
   $('turnLabel').innerHTML = game.over ? 'Game over' : `Turn ${game.turn || 1}<br>${esc(p.name)}'s turn`;[m
   updatePauseBtn();[m
[32m+[m[32m  updateSaveGameBtn();[m
 }[m
 // A postponed trade closes its own popup (see updateModal) so it doesn't[m
 // keep nagging the two people involved -- this button, sitting with the[m
[36m@@ -2962,6 +2965,46 @@[m [mfunction tradeTimerBadge() {[m
   const secs = Math.max(0, Math.ceil((game.tradeTimerEnd - Date.now()) / 1000));[m
   return `<span class="trade-timer ${secs <= 15 ? 'low' : ''}">THINKING TIME: ${secs}s</span>`;[m
 }[m
[32m+[m[32m// Only the backend-authoritative host ever sees the Save Game control --[m
[32m+[m[32m// this mirrors exactly the host check saveGame() itself enforces[m
[32m+[m[32m// server-side, so this is purely a UX convenience, never the real gate.[m
[32m+[m[32mfunction backendIsHostOfCurrentGame() {[m
[32m+[m[32m  return !!(isBackendAuthoritativeGame() && accountUser && backendLobby &&[m
[32m+[m[32m    window.authoritativeGame && backendLobby.gameId === window.authoritativeGame.gameId &&[m
[32m+[m[32m    backendLobby.game && backendLobby.game.hostAccountId === accountUser.id);[m
[32m+[m[32m}[m
[32m+[m[32mlet saveGameInFlight = false;[m
[32m+[m[32mfunction updateSaveGameBtn() {[m
[32m+[m[32m  const el = $('saveGameBtnHolder');[m
[32m+[m[32m  if (!el) return;[m
[32m+[m[32m  if (!game || game.over || !backendIsHostOfCurrentGame()) { el.innerHTML = ''; return; }[m
[32m+[m[32m  el.innerHTML = `<button class="btn alt" ${saveGameInFlight ? 'disabled' : ''} onclick="openSaveGameDialog()">${saveGameInFlight ? 'Saving...' : 'Save game'}</button>`;[m
[32m+[m[32m}[m
[32m+[m[32mfunction openSaveGameDialog() {[m
[32m+[m[32m  if (saveGameInFlight) return;[m
[32m+[m[32m  const name = window.prompt('Save name', `Save ${new Date().toLocaleString()}`);[m
[32m+[m[32m  if (name === null) return;[m
[32m+[m[32m  backendSaveGame(window.authoritativeGame.gameId, name);[m
[32m+[m[32m}[m
[32m+[m[32masync function backendSaveGame(gameId, name) {[m
[32m+[m[32m  if (!gameId || saveGameInFlight) return;[m
[32m+[m[32m  saveGameInFlight = true;[m
[32m+[m[32m  updateSaveGameBtn();[m
[32m+[m[32m  try {[m
[32m+[m[32m    await backendGameRequest('/api/game/saves', {[m
[32m+[m[32m      method: 'POST',[m
[32m+[m[32m      body: JSON.stringify({ gameId, name }),[m
[32m+[m[32m    });[m
[32m+[m[32m    setAccountStatus(`Saved "${name}".`);[m
[32m+[m[32m    await refreshBackendSaves();[m
[32m+[m[32m  } catch (error) {[m
[32m+[m[32m    setAccountStatus(`Save failed: ${error.message}`);[m
[32m+[m[32m  } finally {[m
[32m+[m[32m    saveGameInFlight = false;[m
[32m+[m[32m    updateSaveGameBtn();[m
[32m+[m[32m  }[m
[32m+[m[32m}[m
[32m+[m
 // Only the host (seat 0) ever sees a working pause control; guests and[m
 // local pass-and-play with nobody else connected don't get one at all.[m
 function updatePauseBtn() {[m
[36m@@ -3272,6 +3315,43 @@[m [mfunction introHTML() {[m
       <div class="rank ${r.fresh ? 'pop' : ''}">${r.shown ? ordinal(r.rank) : '...'}</div></div>`).join('')}</div>[m
     <button class="btn alt" onclick="skipIntro()">Skip</button></div>`;[m
 }[m
[32m+[m[32mlet backendFinalResults = null;[m
[32m+[m[32mlet backendFinalResultsGameId = null;[m
[32m+[m[32mlet backendFinalResultsInFlight = null;[m
[32m+[m[32m// The authoritative placements/money/net worth always come from GET[m
[32m+[m[32m// /api/game/results -- the client never computes or guesses them. Falls[m
[32m+[m[32m// back to the plain winner-only text (below, in updateModal) if the[m
[32m+[m[32m// fetch hasn't resolved yet or this isn't a backend-authoritative game.[m
[32m+[m[32masync function fetchBackendFinalResults(gameId) {[m
[32m+[m[32m  if (!gameId || backendFinalResultsGameId === gameId || backendFinalResultsInFlight === gameId) return;[m
[32m+[m[32m  backendFinalResultsInFlight = gameId;[m
[32m+[m[32m  try {[m
[32m+[m[32m    const result = await backendGameRequest(`/api/game/results?gameId=${encodeURIComponent(gameId)}`);[m
[32m+[m[32m    backendFinalResults = result;[m
[32m+[m[32m    backendFinalResultsGameId = gameId;[m
[32m+[m[32m    render();[m
[32m+[m[32m  } catch (error) {[m
[32m+[m[32m    console.warn('Could not load final results:', error);[m
[32m+[m[32m  } finally {[m
[32m+[m[32m    if (backendFinalResultsInFlight === gameId) backendFinalResultsInFlight = null;[m
[32m+[m[32m  }[m
[32m+[m[32m}[m
[32m+[m[32mfunction finalResultsHTML() {[m
[32m+[m[32m  const ordinalLabel = n => n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;[m
[32m+[m[32m  if (isBackendAuthoritativeGame() && window.authoritativeGame.gameId && backendFinalResultsGameId === window.authoritativeGame.gameId && backendFinalResults) {[m
[32m+[m[32m    const rows = backendFinalResults.results.map(entry => `[m
[32m+[m[32m      <div class="social-row" style="margin-bottom:8px">[m
[32m+[m[32m        <span class="tag">${ordinalLabel(entry.placement)}</span>[m
[32m+[m[32m        ${socialAvatar({ username: entry.username || 'Player', avatar_url: entry.avatarUrl })}[m
[32m+[m[32m        <span class="social-name">${esc(entry.username || 'Player')}</span>[m
[32m+[m[32m        <span class="muted" style="margin-left:auto">${fmt(entry.money)} cash</span>[m
[32m+[m[32m        <span class="muted">${fmt(entry.netWorth)} net worth</span>[m
[32m+[m[32m      </div>`).join('');[m
[32m+[m[32m    return `<h2>Final results</h2>${rows}<div class="row"><button class="btn" onclick="restart()">Play again</button></div>`;[m
[32m+[m[32m  }[m
[32m+[m[32m  const winner = game.players[game.winnerId];[m
[32m+[m[32m  return `<h2>${esc(winner ? winner.name : 'A player')} wins the game</h2><p>Everyone else went bankrupt.</p><div class="row"><button class="btn" onclick="restart()">Play again</button></div>`;[m
[32m+[m[32m}[m
 function updateModal() {[m
   let key = '', html = '', cls = '', extra = '';[m
   if (popup) {[m
[36m@@ -3285,7 +3365,7 @@[m [mfunction updateModal() {[m
   } else if (ui.intro) {[m
     key = 'intro'; html = introHTML(); cls = 'plain wide';[m
   } else if (game.over) {[m
[31m-    key = 'over'; html = `<h2>${esc(game.players[game.winnerId].name)} wins the game</h2><p>Everyone else went bankrupt.</p><div class="row"><button class="btn" onclick="restart()">Play again</button></div>`;[m
[32m+[m[32m    key = 'over'; html = finalResultsHTML();[m
   } else if (ui.viewingTrade && game.viewTrade) {[m
     key = 'viewtrade'; html = viewTradeHTML();[m
   } else if (ui.manage) {[m
[36m@@ -3967,22 +4047,38 @@[m [mfunction renderHostSetup() {[m
   }[m
   const h = hostState();[m
   if (!h.peer && !h.status) hostOpenLobby(h.lobbyId || hostSuggestLobbyId());[m
[32m+[m[32m  const isResumeLobby = !!(backendLobby && backendLobby.game && backendLobby.game.resumeSaveId);[m
   const serverLobbyPanel = backendLobby && backendLobby.gameId ? `[m
     <div class="panel acc-blue">[m
[31m-      <h2>Server lobby</h2>[m
[32m+[m[32m      <h2>Server lobby${isResumeLobby ? ' (resuming a save)' : ''}</h2>[m
       <p class="muted">${esc(backendLobby.gameId)}</p>[m
       <div class="row">[m
         <button class="btn" onclick="backendRefreshLobby('${esc(backendLobby.gameId)}')">Refresh</button>[m
         <button class="btn alt" onclick="backendLeaveGame('${esc(backendLobby.gameId)}')">Leave lobby</button>[m
       </div>[m
[31m-      ${backendLobbyPlayersHTML(backendLobby.players, 'Server roster')}[m
[31m-      ${backendLobby.canStart ? `<button class="btn" onclick="backendStartGame('${esc(backendLobby.gameId)}')">Start server lobby</button>` : ''}[m
[32m+[m[32m      ${backendLobbyPlayersHTML(backendLobby.players, isResumeLobby ? 'Original players' : 'Server roster', { isResume: isResumeLobby })}[m
[32m+[m[32m      ${backendLobby.canStart[m
[32m+[m[32m        ? (isResumeLobby[m
[32m+[m[32m          ? `<button class="btn" onclick="backendResumeGame('${esc(backendLobby.gameId)}')">Resume game</button>`[m
[32m+[m[32m          : `<button class="btn" onclick="backendStartGame('${esc(backendLobby.gameId)}')">Start server lobby</button>`)[m
[32m+[m[32m        : (isResumeLobby ? '<p class="muted">Waiting for every original player to return.</p>' : '')}[m
     </div>` : `[m
     <div class="panel acc-blue">[m
       <h2>Server lobby</h2>[m
       <p class="muted">The server keeps the authoritative lobby membership for signed-in players.</p>[m
       <button class="btn" onclick="backendCreateGame()">Create server lobby</button>[m
     </div>`;[m
[32m+[m[32m  const savedGamesPanel = accountUser ? `[m
[32m+[m[32m    <div class="panel acc-green">[m
[32m+[m[32m      <h2>Saved games</h2>[m
[32m+[m[32m      ${backendSaves.length ? backendSaves.map(save => `[m
[32m+[m[32m        <div class="social-row" style="margin-bottom:8px;flex-wrap:wrap;gap:6px">[m
[32m+[m[32m          <span class="social-name">${esc(save.name)}</span>[m
[32m+[m[32m          <span class="tag">${esc(new Date(save.updatedAt || save.createdAt || Date.now()).toLocaleString())}</span>[m
[32m+[m[32m          <span class="tag">${(save.players || []).length} players</span>[m
[32m+[m[32m          <button class="btn alt" onclick="backendResumeFromSave('${esc(save.saveId)}')">Resume</button>[m
[32m+[m[32m        </div>`).join('') : '<p class="muted">No saved games yet.</p>'}[m
[32m+[m[32m    </div>` : '';[m
   const serverGamesPanel = accountUser ? `[m
     <div class="panel acc-yellow">[m
       <h2>My server games</h2>[m
[36m@@ -4008,6 +4104,7 @@[m [mfunction renderHostSetup() {[m
         ${h.status ? `<p class="muted">${esc(h.status)}</p>` : ''}[m
       </div>[m
       ${serverLobbyPanel}[m
[32m+[m[32m      ${savedGamesPanel}[m
       ${serverGamesPanel}[m
       <div class="panel acc-yellow"><h2>Board</h2><p class="muted">${esc(selectedHostBoard ? selectedHostBoard.name : 'Classic board')}</p>[m
         <button class="btn alt" type="button" onclick="openBoardsScreen(true)">Choose board</button></div>[m
[36m@@ -4123,7 +4220,7 @@[m [mlet pendingAccountSettings = {};[m
 [m
 if (window.authoritativeGame) {[m
   window.authoritativeGame.subscribe(async snapshot => {[m
[31m-    if (!snapshot || !snapshot.gameId || !snapshot.state || snapshot.status !== 'ACTIVE') {[m
[32m+[m[32m    if (!snapshot || !snapshot.gameId || !snapshot.state || (snapshot.status !== 'ACTIVE' && snapshot.status !== 'FINISHED')) {[m
       if (!snapshot || !snapshot.gameId) authoritativeAppliedGameId = null;[m
       return;[m
     }[m
[36m@@ -4138,6 +4235,8 @@[m [mif (window.authoritativeGame) {[m
     if (isNewGame) attachGame();[m
     else render();[m
 [m
[32m+[m[32m    if (game.over && snapshot.gameId) fetchBackendFinalResults(snapshot.gameId);[m
[32m+[m
     const roll = snapshot.events.find(event => event.type === 'DICE_ROLLED');[m
     const eventKey = `${snapshot.gameId}:${snapshot.version}`;[m
     if (!roll || eventKey === lastAuthoritativeDiceEvent) return;[m
[36m@@ -4245,6 +4344,66 @@[m [masync function accountRequest(path, options = {}) {[m
 [m
 let backendLobby = null;[m
 let backendMyGames = [];[m
[32m+[m[32mlet backendSaves = [];[m
[32m+[m
[32m+[m[32masync function refreshBackendSaves() {[m
[32m+[m[32m  if (!accountUser) { backendSaves = []; return; }[m
[32m+[m[32m  try {[m
[32m+[m[32m    const result = await backendGameRequest('/api/game/saves');[m
[32m+[m[32m    backendSaves = Array.isArray(result.saves) ? result.saves : [];[m
[32m+[m[32m  } catch (error) {[m
[32m+[m[32m    backendSaves = [];[m
[32m+[m[32m    console.warn('Could not refresh saved games:', error);[m
[32m+[m[32m  }[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32m// Loading a save only creates the WAITING resume lobby server-side and[m
[32m+[m[32m// returns bare account IDs (no usernames/avatars/returned status) --[m
[32m+[m[32m// backendRefreshLobby immediately pulls the real lobby view (which does[m
[32m+[m[32m// have all of that, including per-seat returned_at) and renders it, the[m
[32m+[m[32m// same way joining an ordinary lobby does.[m
[32m+[m[32masync function backendResumeFromSave(saveId) {[m
[32m+[m[32m  if (!saveId) return;[m
[32m+[m[32m  try {[m
[32m+[m[32m    const result = await backendGameRequest('/api/game/load', {[m
[32m+[m[32m      method: 'POST',[m
[32m+[m[32m      body: JSON.stringify({ saveId }),[m
[32m+[m[32m    });[m
[32m+[m[32m    startBackendLobbyPolling(result.gameId);[m
[32m+[m[32m    await backendRefreshLobby(result.gameId);[m
[32m+[m[32m    await refreshBackendMyGames();[m
[32m+[m[32m  } catch (error) {[m
[32m+[m[32m    setAccountStatus(error.message);[m
[32m+[m[32m  }[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32m// Distinct from backendStartGame(): a resume lobby's authoritative state[m
[32m+[m[32m// comes only from POST /api/game/resume, which restores the exact saved[m
[32m+[m[32m// snapshot server-side. The backend independently refuses to let a resume[m
[32m+[m[32m// lobby go through the ordinary start endpoint (USE_RESUME_ENDPOINT), so[m
[32m+[m[32m// this is the only path that can ever bring one back to ACTIVE.[m
[32m+[m[32masync function backendResumeGame(gameId) {[m
[32m+[m[32m  if (!gameId) return;[m
[32m+[m[32m  try {[m
[32m+[m[32m    const result = await backendGameRequest('/api/game/resume', {[m
[32m+[m[32m      method: 'POST',[m
[32m+[m[32m      body: JSON.stringify({ gameId }),[m
[32m+[m[32m    });[m
[32m+[m[32m    if (window.authoritativeGame) {[m
[32m+[m[32m      await activateBackendGame({[m
[32m+[m[32m        gameId: result.gameId,[m
[32m+[m[32m        version: result.version || 1,[m
[32m+[m[32m        status: result.status || 'ACTIVE',[m
[32m+[m[32m        state: result.state || null,[m
[32m+[m[32m        events: [],[m
[32m+[m[32m      });[m
[32m+[m[32m    }[m
[32m+[m[32m    await refreshBackendMyGames();[m
[32m+[m[32m  } catch (error) {[m
[32m+[m[32m    setAccountStatus(error.message);[m
[32m+[m[32m  }[m
[32m+[m[32m}[m
[32m+[m
 [m
 function stopBackendLobbyPolling() {[m
   if (backendLobbyPollId) clearInterval(backendLobbyPollId);[m
[36m@@ -4284,6 +4443,7 @@[m [masync function backendGameRequest(path, options = {}) {[m
 async function refreshBackendMyGames() {[m
   if (!accountUser) {[m
     backendMyGames = [];[m
[32m+[m[32m    backendSaves = [];[m
     return;[m
   }[m
   try {[m
[36m@@ -4293,6 +4453,7 @@[m [masync function refreshBackendMyGames() {[m
     backendMyGames = [];[m
     console.warn('Could not refresh backend games:', error);[m
   }[m
[32m+[m[32m  await refreshBackendSaves();[m
 }[m
 [m
 async function backendCreateGame() {[m
[36m@@ -4420,13 +4581,18 @@[m [masync function backendStartGame(gameId) {[m
   }[m
 }[m
 [m
[31m-function backendLobbyPlayersHTML(players = [], title = 'Players') {[m
[32m+[m[32mfunction backendLobbyPlayersHTML(players = [], title = 'Players', options = {}) {[m
   if (!players.length) return `<div class="panel acc-orange"><h2>🧑‍🤝‍🧑 ${title}</h2><p class="muted">No one has joined this server lobby yet.</p></div>`;[m
[32m+[m[32m  const isResume = !!options.isResume;[m
   const rows = players.map(p => {[m
     const name = p.username || p.name || 'Player';[m
     const seat = Number(p.seatIndex ?? p.seat_index ?? 0) + 1;[m
     const avatar = p.avatarUrl || p.avatar_url;[m
[31m-    return `<div class="social-row">${socialAvatar({ username: name, avatar_url: avatar })}<span class="social-name">${esc(name)}</span><span class="tag">Seat ${seat}</span></div>`;[m
[32m+[m[32m    const returned = p.returnedAt || p.returned_at;[m
[32m+[m[32m    const statusTag = isResume[m
[32m+[m[32m      ? `<span class="tag ${returned ? 'ok' : 'wait'}">${returned ? 'Returned' : 'Waiting'}</span>`[m
[32m+[m[32m      : `<span class="tag">Seat ${seat}</span>`;[m
[32m+[m[32m    return `<div class="social-row">${socialAvatar({ username: name, avatar_url: avatar })}<span class="social-name">${esc(name)}</span>${statusTag}</div>`;[m
   }).join('');[m
   return `<div class="panel acc-orange"><h2>🧑‍🤝‍🧑 ${title}</h2>${rows}</div>`;[m
 }[m
[1mdiff --git a/lifecycle.test.js b/lifecycle.test.js[m
[1mindex 80eb97e..2532bfc 100644[m
[1m--- a/lifecycle.test.js[m
[1m+++ b/lifecycle.test.js[m
[36m@@ -5,192 +5,7 @@[m [mconst engine = require('./game-engine.js');[m
 const { createGame, joinGame, leaveGame, startGame, getLobby, getMyGames } = require('./api/game/lifecycle.js');[m
 const { getGameState, handleGetGameStateRoute } = require('./api/game/state.js');[m
 const { executeGameAction } = require('./api/game/action.js');[m
[31m-[m
[31m-function makeDbState() {[m
[31m-  return {[m
[31m-    games: [],[m
[31m-    players: [],[m
[31m-    states: [],[m
[31m-    accounts: {[m
[31m-      'account-a': { username: 'alice', avatar_url: null },[m
[31m-      'account-b': { username: 'bob', avatar_url: null },[m
[31m-      'account-c': { username: 'charlie', avatar_url: null },[m
[31m-      'account-d': { username: 'dana', avatar_url: null },[m
[31m-      'account-z': { username: 'zack', avatar_url: null },[m
[31m-    },[m
[31m-  };[m
[31m-}[m
[31m-[m
[31m-function makeDb(initial = makeDbState()) {[m
[31m-  const state = {[m
[31m-    games: initial.games.map(game => ({ ...game })),[m
[31m-    players: initial.players.map(player => ({ ...player })),[m
[31m-    states: initial.states.map(entry => ({ ...entry })),[m
[31m-    accounts: { ...initial.accounts },[m
[31m-  };[m
[31m-[m
[31m-  const tx = Object.assign(async function sql(strings, ...values) {[m
[31m-    const query = strings.reduce((result, part, index) => {[m
[31m-      const value = index < values.length ? `$${index + 1}` : '';[m
[31m-      return result + part + value;[m
[31m-    }, '').replace(/\s+/g, ' ').trim();[m
[31m-[m
[31m-    if (query.startsWith('SELECT * FROM games WHERE id = $1')) return state.games.filter(game => game.id === values[0]);[m
[31m-    if (query.startsWith('SELECT * FROM game_players WHERE game_id = $1 AND account_id = $2')) {[m
[31m-      return state.players.filter(player => player.game_id === values[0] && player.account_id === values[1]);[m
[31m-    }[m
[31m-    if (query.startsWith('SELECT gp.game_id, gp.account_id, gp.seat_index, gp.joined_at, a.username, a.avatar_url FROM game_players gp JOIN accounts a ON a.id = gp.account_id WHERE gp.game_id = $1 ORDER BY gp.seat_index ASC')) {[m
[31m-      return state.players.filter(player => player.game_id === values[0]).sort((a, b) => a.seat_index - b.seat_index).map(player => ({[m
[31m-        game_id: player.game_id,[m
[31m-        account_id: player.account_id,[m
[31m-        seat_index: player.seat_index,[m
[31m-        joined_at: player.joined_at,[m
[31m-        username: state.accounts[player.account_id]?.username || null,[m
[31m-        avatar_url: state.accounts[player.account_id]?.avatar_url || null,[m
[31m-      }));[m
[31m-    }[m
[31m-    if (query.startsWith('SELECT gp.account_id, gp.seat_index, a.username FROM game_players gp JOIN accounts a ON a.id = gp.account_id WHERE gp.game_id = $1 ORDER BY gp.seat_index ASC')) {[m
[31m-      return state.players.filter(player => player.game_id === values[0]).sort((a, b) => a.seat_index - b.seat_index).map(player => ({[m
[31m-        account_id: player.account_id,[m
[31m-        seat_index: player.seat_index,[m
[31m-        username: state.accounts[player.account_id]?.username || null,[m
[31m-      }));[m
[31m-    }[m
[31m-    if (query.startsWith('SELECT COUNT(*)::int AS total FROM game_players WHERE game_id = $1')) {[m
[31m-      return [{ total: state.players.filter(player => player.game_id === values[0]).length }];[m
[31m-    }[m
[31m-    if (query.startsWith('INSERT INTO games')) {[m
[31m-      state.games.push({[m
[31m-        id: values[0],[m
[31m-        host_account_id: values[1],[m
[31m-        status: values[2],[m
[31m-        selected_board_id: values[3],[m
[31m-        created_at: new Date().toISOString(),[m
[31m-        started_at: null,[m
[31m-        updated_at: new Date().toISOString(),[m
[31m-      });[m
[31m-      return [{ ok: true }];[m
[31m-    }[m
[31m-    if (query.startsWith('INSERT INTO game_players')) {[m
[31m-      state.players.push({[m
[31m-        game_id: values[0],[m
[31m-        account_id: values[1],[m
[31m-        seat_index: Number(values[2]),[m
[31m-        joined_at: new Date().toISOString(),[m
[31m-      });[m
[31m-      return [{ ok: true }];[m
[31m-    }[m
[31m-    if (query.startsWith('SELECT * FROM game_players WHERE game_id = $1 ORDER BY seat_index ASC')) {[m
[31m-      return state.players.filter(player => player.game_id === values[0]).sort((a, b) => a.seat_index - b.seat_index);[m
[31m-    }[m
[31m-    if (query.startsWith('DELETE FROM game_players WHERE game_id = $1 AND account_id = $2')) {[m
[31m-      state.players = state.players.filter(player => !(player.game_id === values[0] && player.account_id === values[1]));[m
[31m-      return [];[m
[31m-    }[m
[31m-    if (query.startsWith('DELETE FROM games WHERE id = $1')) {[m
[31m-      state.games = state.games.filter(game => game.id !== values[0]);[m
[31m-      return [];[m
[31m-    }[m
[31m-    if (query.startsWith('DELETE FROM game_states WHERE id = $1')) {[m
[31m-      state.states = state.states.filter(entry => entry.id !== values[0]);[m
[31m-      return [];[m
[31m-    }[m
[31m-    if (query.startsWith('UPDATE games SET host_account_id = $1, updated_at = now() WHERE id = $2')) {[m
[31m-      const game = state.games.find(entry => entry.id === values[1]);[m
[31m-      if (game) {[m
[31m-        game.host_account_id = values[0];[m
[31m-        game.updated_at = new Date().toISOString();[m
[31m-      }[m
[31m-      return [{ ok: true }];[m
[31m-    }[m
[31m-    if (query.startsWith('INSERT INTO game_states')) {[m
[31m-      state.states = state.states.filter(entry => entry.id !== values[0]);[m
[31m-      state.states.push({[m
[31m-        id: values[0],[m
[31m-        owner_id: values[1],[m
[31m-        state: typeof values[2] === 'string' ? JSON.parse(values[2]) : values[2],[m
[31m-        board: typeof values[3] === 'string' ? JSON.parse(values[3]) : values[3],[m
[31m-        version: Number(values[4]),[m
[31m-      });[m
[31m-      return [{ ok: true }];[m
[31m-    }[m
[31m-    if (query.startsWith('UPDATE games SET status = $1, started_at = now(), updated_at = now() WHERE id = $2')) {[m
[31m-      const game = state.games.find(entry => entry.id === values[1]);[m
[31m-      if (game) {[m
[31m-        game.status = values[0];[m
[31m-        game.started_at = new Date().toISOString();[m
[31m-        game.updated_at = new Date().toISOString();[m
[31m-      }[m
[31m-      return [{ ok: true }];[m
[31m-    }[m
[31m-    if (query.startsWith('SELECT g.*, gp.account_id, gp.seat_index FROM game_players gp JOIN games g ON g.id = gp.game_id WHERE gp.account_id = $1 ORDER BY g.updated_at DESC')) {[m
[31m-      return state.games.filter(game => state.players.some(player => player.game_id === game.id && player.account_id === values[0]))[m
[31m-        .map(game => ({[m
[31m-          ...game,[m
[31m-          account_id: values[0],[m
[31m-          seat_index: state.players.find(player => player.game_id === game.id && player.account_id === values[0])?.seat_index ?? 0,[m
[31m-        }));[m
[31m-    }[m
[31m-    if (query.startsWith('SELECT * FROM games WHERE id = $1')) {[m
[31m-      return state.games.filter(game => game.id === values[0]);[m
[31m-    }[m
[31m-    if (query.startsWith('SELECT * FROM game_states WHERE id = $1')) {[m
[31m-      return state.states.filter(entry => entry.id === values[0]);[m
[31m-    }[m
[31m-    if (query.startsWith('SELECT id, version, state, board FROM game_states WHERE id = $1')) {[m
[31m-      return state.states.filter(entry => entry.id === values[0]).map(entry => ({[m
[31m-        id: entry.id,[m
[31m-        version: entry.version,[m
[31m-        state: entry.state,[m
[31m-        board: entry.board,[m
[31m-      }));[m
[31m-    }[m
[31m-    if (query.startsWith('SELECT id, version, state, board FROM game_states WHERE id = $1 FOR UPDATE')) {[m
[31m-      return state.states.filter(entry => entry.id === values[0]).map(entry => ({[m
[31m-        id: entry.id,[m
[31m-        version: entry.version,[m
[31m-        state: entry.state,[m
[31m-        board: entry.board,[m
[31m-      }));[m
[31m-    }[m
[31m-    if (query.startsWith('UPDATE game_states SET state = $1::jsonb, version = $2, updated_at = now() WHERE id = $3')) {[m
[31m-      const gameState = state.states.find(entry => entry.id === values[2]);[m
[31m-      if (gameState) {[m
[31m-        gameState.state = typeof values[0] === 'string' ? JSON.parse(values[0]) : values[0];[m
[31m-        gameState.version = Number(values[1]);[m
[31m-      }[m
[31m-      return [{ ok: true }];[m
[31m-    }[m
[31m-    if (query.startsWith('INSERT INTO game_action_requests')) {[m
[31m-      const existing = state.actionRequests || [];[m
[31m-      const key = `${values[0]}::${values[1]}`;[m
[31m-      if (!state.actionRequests) state.actionRequests = [];[m
[31m-      if (!state.actionRequests.some(entry => entry.game_id === values[0] && entry.request_id === values[1])) {[m
[31m-        state.actionRequests.push({ game_id: values[0], request_id: values[1], result_json: JSON.parse(values[2]) });[m
[31m-      }[m
[31m-      return [{ result_json: JSON.parse(values[2]) }];[m
[31m-    }[m
[31m-    if (query.startsWith('SELECT result_json FROM game_action_requests WHERE game_id = $1 AND request_id = $2')) {[m
[31m-      const request = (state.actionRequests || []).find(entry => entry.game_id === values[0] && entry.request_id === values[1]);[m
[31m-      return request ? [{ result_json: request.result_json }] : [];[m
[31m-    }[m
[31m-    if (query.startsWith('SELECT result_json FROM game_action_requests WHERE game_id = $1 ORDER BY created_at DESC LIMIT 1')) {[m
[31m-      const requests = (state.actionRequests || []).filter(entry => entry.game_id === values[0]);[m
[31m-      const latest = requests[requests.length - 1];[m
[31m-      return latest ? [{ result_json: latest.result_json }] : [];[m
[31m-    }[m
[31m-    if (query.startsWith('SELECT * FROM games WHERE id = $1 FOR UPDATE')) {[m
[31m-      return state.games.filter(game => game.id === values[0]);[m
[31m-    }[m
[31m-    return [];[m
[31m-  }, {[m
[31m-    async begin(callback) {[m
[31m-      return callback(tx);[m
[31m-    },[m
[31m-  });[m
[31m-[m
[31m-  return { begin: async callback => callback(tx), state };[m
[31m-}[m
[32m+[m[32mconst { makeDbState, makeDb } = require('./test-support/mock-db.js');[m
 [m
 async function createActiveGame() {[m
   const db = makeDb();[m
[1mdiff --git a/package.json b/package.json[m
[1mindex 86b25dd..51ac5f7 100644[m
[1m--- a/package.json[m
[1m+++ b/package.json[m
[36m@@ -6,7 +6,7 @@[m
   },[m
   "scripts": {[m
     "db:check": "node scripts/check-db.js",[m
[31m-    "test": "node --test game-engine.test.js"[m
[32m+[m[32m    "test": "node --test *.test.js"[m
   },[m
   "dependencies": {[m
     "@neondatabase/serverless": "^1.0.2",[m
