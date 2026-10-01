const assert = require('node:assert/strict');
const test = require('node:test');
const engine = require('./game-engine.js');
const boardData = require('./game-board.js');

const { createGame, joinGame, startGame } = require('./api-handlers/game/lifecycle.js');
const { executeGameAction } = require('./api-handlers/game/action.js');
const { saveGame, listSaves, loadGame, resumeGame } = require('./api-handlers/game/saves.js');
const { getFinalResults } = require('./lib/game-results.js');
const { makeDb } = require('./test-support/mock-db.js');

async function createActiveGame(db = makeDb()) {
  const created = await createGame({ account: { id: 'account-a' }, db });
  await joinGame({ account: { id: 'account-b' }, gameId: created.gameId, db });
  await startGame({ account: { id: 'account-a' }, gameId: created.gameId, db });
  return { db, gameId: created.gameId };
}

function editStoredGameState(db, edit) {
  const state = engine.deserializeState(db.state.states[0].state);
  edit(state);
  db.state.states[0].state = state;
}

// Drives a real two-player game (account-a vs account-b) all the way to
// state.over === true through the same public action path the client
// uses: roll into a debt, confirm bankruptcy twice. Mirrors the identical
// setup already proven in lifecycle.test.js's bankruptcy test, since that
// is the only way state.over ever becomes true.
async function createFinishedGame() {
  const game = await createActiveGame();
  editStoredGameState(game.db, state => {
    state.players[0].pos = 35;
    state.players[0].money = 0;
    state.owners[37] = 1;
    state.houses[37] = 1;
    state.owners[39] = 0;
    state.owners[34] = 0;
    state.owners[32] = 0;
  });
  const dice = [0, 0];
  await executeGameAction({
    account: { id: 'account-a' }, gameId: game.gameId, action: { type: 'ROLL_DICE' }, version: 1, requestId: 'f-roll', sql: game.db,
    random: () => dice.shift(),
  });
  await executeGameAction({
    account: { id: 'account-a' }, gameId: game.gameId, action: { type: 'CONFIRM_BANKRUPTCY' }, version: 2, requestId: 'f-confirm', sql: game.db,
  });
  const final = await executeGameAction({
    account: { id: 'account-a' }, gameId: game.gameId, action: { type: 'CONFIRM_BANKRUPTCY' }, version: 3, requestId: 'f-final', sql: game.db,
  });
  return { ...game, result: final };
}

// ---------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------

test('saveGame requires authentication', async () => {
  const { db, gameId } = await createActiveGame();
  const result = await saveGame({ account: null, gameId, name: 'My save', db });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.error.code, 'UNAUTHENTICATED');
});

test('saveGame is host-only', async () => {
  const { db, gameId } = await createActiveGame();
  const result = await saveGame({ account: { id: 'account-b' }, gameId, name: 'My save', db });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.error.code, 'HOST_REQUIRED');
});

test('saveGame rejects a non-member and a game with no authoritative state', async () => {
  const { db, gameId } = await createActiveGame();
  const outsider = await saveGame({ account: { id: 'account-z' }, gameId, name: 'x', db });
  assert.equal(outsider.error.code, 'HOST_REQUIRED'); // account-z isn't host either; host check runs first

  const missingGame = await saveGame({ account: { id: 'account-a' }, gameId: 'no-such-game', name: 'x', db });
  assert.equal(missingGame.error.code, 'GAME_NOT_FOUND');
});

test('saveGame captures the exact authoritative snapshot and preserves exact original account IDs', async () => {
  const { db, gameId } = await createActiveGame();
  editStoredGameState(db, state => {
    state.players[0].money = 999;
    state.owners[1] = 0;
  });
  const result = await saveGame({ account: { id: 'account-a' }, gameId, name: 'Friday night', db });
  assert.equal(result.ok, true);
  assert.equal(result.save.name, 'Friday night');
  assert.equal(result.save.status, 'SAVED');
  assert.deepEqual(result.save.players.map(p => p.accountId), ['account-a', 'account-b']);
  assert.deepEqual(result.save.players.map(p => p.seatIndex), [0, 1]);

  const storedSave = db.state.saves.find(save => save.id === result.save.saveId);
  assert.equal(storedSave.state.players[0].money, 999);
  assert.equal(storedSave.state.owners[1], 0);
  assert.equal(storedSave.state.players[0].accountId, 'account-a');
  assert.equal(storedSave.state.players[1].accountId, 'account-b');
});

test('listSaves requires authentication and never returns another account\'s saves', async () => {
  const unauth = await listSaves({ account: null, db: makeDb() });
  assert.equal(unauth.error.code, 'UNAUTHENTICATED');

  const { db, gameId } = await createActiveGame();
  await saveGame({ account: { id: 'account-a' }, gameId, name: 'Save A', db });

  const ownerList = await listSaves({ account: { id: 'account-a' }, db });
  assert.equal(ownerList.saves.length, 1);
  assert.equal(ownerList.saves[0].name, 'Save A');

  const strangerList = await listSaves({ account: { id: 'account-z' }, db });
  assert.equal(strangerList.saves.length, 0);
});

// ---------------------------------------------------------------------
// Load / Resume
// ---------------------------------------------------------------------

async function saveAndLoad() {
  const { db, gameId } = await createActiveGame();
  editStoredGameState(db, state => {
    state.players[0].money = 777;
    state.players[1].money = 333;
    state.owners[1] = 0;
    state.houses[1] = 1;
    state.current = 1;
    state.turnOrder = [1, 0];
  });
  const saved = await saveGame({ account: { id: 'account-a' }, gameId, name: 'Resume me', db });
  const loaded = await loadGame({ account: { id: 'account-a' }, saveId: saved.save.saveId, db });
  return { db, saved, loaded };
}

test('loadGame creates a WAITING resume lobby with the exact original seats and only the loader returned', async () => {
  const { db, loaded } = await saveAndLoad();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.status, 'WAITING');
  const game = db.state.games.find(entry => entry.id === loaded.gameId);
  assert.equal(game.status, 'WAITING');
  assert.equal(game.resume_save_id, loaded.save.saveId);

  const seats = db.state.players.filter(player => player.game_id === loaded.gameId).sort((a, b) => a.seat_index - b.seat_index);
  assert.deepEqual(seats.map(seat => seat.account_id), ['account-a', 'account-b']);
  assert.ok(seats[0].returned_at, 'the loading host is marked returned immediately');
  assert.equal(seats[1].returned_at, null, 'the other original player has not returned yet');
});

test('resume: the correct original account can return and gets recorded via returned_at', async () => {
  const { db, loaded } = await saveAndLoad();
  const result = await joinGame({ account: { id: 'account-b' }, gameId: loaded.gameId, db });
  assert.equal(result.ok, true);
  const seat = db.state.players.find(player => player.game_id === loaded.gameId && player.account_id === 'account-b');
  assert.ok(seat.returned_at);
});

test('resume: an account that was never in the saved game is rejected as a substitute', async () => {
  const { db, loaded } = await saveAndLoad();
  const result = await joinGame({ account: { id: 'account-z' }, gameId: loaded.gameId, db });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'NOT_ORIGINAL_PLAYER');
  assert.equal(result.status, 403);
  // and it never occupied a seat
  assert.equal(db.state.players.some(player => player.game_id === loaded.gameId && player.account_id === 'account-z'), false);
});

test('resume: an original account returning twice (duplicate call) is idempotent and never creates a second seat', async () => {
  const { db, loaded } = await saveAndLoad();
  await joinGame({ account: { id: 'account-b' }, gameId: loaded.gameId, db });
  const again = await joinGame({ account: { id: 'account-b' }, gameId: loaded.gameId, db });
  assert.equal(again.ok, true);
  const seats = db.state.players.filter(player => player.game_id === loaded.gameId && player.account_id === 'account-b');
  assert.equal(seats.length, 1);
});

test('resumeGame is blocked until every original account has returned', async () => {
  const { db, loaded, saved } = await saveAndLoad();
  const early = await resumeGame({ account: { id: 'account-a' }, gameId: loaded.gameId, db });
  assert.equal(early.ok, false);
  assert.equal(early.error.code, 'PLAYERS_MISSING');
  assert.equal(early.status, 409);

  await joinGame({ account: { id: 'account-b' }, gameId: loaded.gameId, db });
  const ready = await resumeGame({ account: { id: 'account-a' }, gameId: loaded.gameId, db });
  assert.equal(ready.ok, true);
  assert.equal(ready.status, 'ACTIVE');
});

test('resumeGame restores the exact saved authoritative state: money, properties, houses, turn order and current turn', async () => {
  const { db, loaded } = await saveAndLoad();
  await joinGame({ account: { id: 'account-b' }, gameId: loaded.gameId, db });
  const resumed = await resumeGame({ account: { id: 'account-a' }, gameId: loaded.gameId, db });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.state.players[0].money, 777);
  assert.equal(resumed.state.players[1].money, 333);
  assert.equal(resumed.state.owners[1], 0);
  assert.equal(resumed.state.houses[1], 1);
  assert.equal(resumed.state.current, 1);
  assert.deepEqual(resumed.state.turnOrder, [1, 0]);

  const storedState = db.state.states.find(entry => entry.id === loaded.gameId);
  assert.equal(storedState.state.players[0].money, 777);
});

// ---------------------------------------------------------------------
// Finished game status
// ---------------------------------------------------------------------

test('the database game transitions to FINISHED only once authoritative state reports state.over, and it is idempotent', async () => {
  const { db, gameId, result } = await createFinishedGame();
  assert.equal(result.state.over, true);
  const game = db.state.games.find(entry => entry.id === gameId);
  assert.equal(game.status, 'FINISHED');

  // A client cannot request FINISHED directly -- executeGameAction/action.js
  // exposes no status field on its action contract at all, so there is no
  // path for a client-supplied status to ever reach this update.
  const replay = await executeGameAction({
    account: { id: 'account-a' }, gameId, action: { type: 'CONFIRM_BANKRUPTCY' }, version: 3, requestId: 'f-final', sql: db,
  });
  assert.equal(replay.version, result.version);
  const gameAfterReplay = db.state.games.find(entry => entry.id === gameId);
  assert.equal(gameAfterReplay.status, 'FINISHED');
});

// ---------------------------------------------------------------------
// Final results
// ---------------------------------------------------------------------

test('final results are computed and persisted server-side with the correct winner, placement, money and net worth', async () => {
  const { db, gameId } = await createFinishedGame();
  const row = db.state.results.find(entry => entry.game_id === gameId);
  assert.ok(row, 'a game_results row was persisted');
  assert.equal(row.winner_account_id, 'account-b');
  assert.equal(row.placements.length, 2);
  const winner = row.placements.find(entry => entry.placement === 1);
  const loser = row.placements.find(entry => entry.placement === 2);
  assert.equal(winner.accountId, 'account-b');
  assert.equal(loser.accountId, 'account-a');
  assert.equal(loser.money, 0);
  assert.equal(loser.netWorth, 0);
  assert.equal(typeof winner.money, 'number');
  assert.ok(winner.money >= 0);
  assert.equal(typeof winner.netWorth, 'number');
  assert.ok(winner.netWorth >= 0);
});

test('final result persistence is idempotent: repeated GAME_OVER-causing processing never creates a second or conflicting row', async () => {
  const { db, gameId } = await createFinishedGame();
  const before = db.state.results.filter(entry => entry.game_id === gameId);
  assert.equal(before.length, 1);
  const originalPlacements = JSON.stringify(before[0].placements);

  // Re-run the exact same idempotent action request again.
  await executeGameAction({
    account: { id: 'account-a' }, gameId, action: { type: 'CONFIRM_BANKRUPTCY' }, version: 3, requestId: 'f-final', sql: db,
  });
  const after = db.state.results.filter(entry => entry.game_id === gameId);
  assert.equal(after.length, 1, 'still exactly one results row for this game');
  assert.equal(JSON.stringify(after[0].placements), originalPlacements, 'the stored placements were never overwritten');
});

test('a client cannot forge a winner or final results: nothing in the action contract accepts one, and results only ever come from persisted authoritative state', async () => {
  const { db, gameId } = await createActiveGame();
  // Even a maximally hostile payload that tries to smuggle result fields
  // onto an ordinary action is simply ignored by executeGameAction, which
  // only ever reads action.type and the specific fields each action type
  // legally uses; it never looks at, or persists, a client-supplied
  // winner/placement/money/netWorth/status.
  const attempt = await executeGameAction({
    account: { id: 'account-a' }, gameId, action: { type: 'ROLL_DICE', winnerId: 0, status: 'FINISHED', placements: [{ accountId: 'account-a', placement: 1 }] },
    version: 1, requestId: 'forge-attempt', sql: db, random: () => 0.1,
  });
  assert.equal(attempt.ok, true);
  assert.equal(db.state.results.some(entry => entry.game_id === gameId), false);
  const game = db.state.games.find(entry => entry.id === gameId);
  assert.equal(game.status, 'ACTIVE');
});

test('results retrieval: an authorized player can fetch results, an unrelated account cannot, and an unfinished game has none yet', async () => {
  const { db, gameId } = await createFinishedGame();

  const authorized = await getFinalResults({ account: { id: 'account-a' }, gameId, db });
  assert.equal(authorized.ok, true);
  assert.equal(authorized.results.length, 2);
  assert.equal(authorized.results.find(entry => entry.accountId === 'account-b').username, 'bob');

  const unauthorized = await getFinalResults({ account: { id: 'account-z' }, gameId, db });
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.status, 403);
  assert.equal(unauthorized.error.code, 'FORBIDDEN');

  const unauthenticated = await getFinalResults({ account: null, gameId, db });
  assert.equal(unauthenticated.status, 401);

  const { db: freshDb, gameId: activeGameId } = await createActiveGame();
  const notFinishedYet = await getFinalResults({ account: { id: 'account-a' }, gameId: activeGameId, db: freshDb });
  assert.equal(notFinishedYet.ok, false);
  assert.equal(notFinishedYet.error.code, 'RESULTS_NOT_FOUND');
});
