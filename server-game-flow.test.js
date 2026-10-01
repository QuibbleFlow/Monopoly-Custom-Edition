const assert = require('node:assert/strict');
const test = require('node:test');
const engine = require('./game-engine.js');
const board = require('./game-board.js');
const { createGame, joinGame, startGame, pauseGame } = require('./api-handlers/game/lifecycle.js');
const { sendGameInvitation, respondToGameInvitation } = require('./api-handlers/game/invitations.js');
const { resumeGame } = require('./api-handlers/game/saves.js');
const { executeGameAction } = require('./api-handlers/game/action.js');
const { getGameState } = require('./api-handlers/game/state.js');
const { persistFinalResultsIfNeeded, getFinalResults } = require('./lib/game-results.js');
const { makeDbState, makeDb } = require('./test-support/mock-db.js');

const ids = [
  '40000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000002',
  '40000000-0000-4000-8000-000000000003',
  '40000000-0000-4000-8000-000000000004',
  '40000000-0000-4000-8000-000000000005',
];

test('four invited accounts start, pause, return to original seats, resume the same state, finish, and clean up', async () => {
  const initial = makeDbState();
  initial.accounts = Object.fromEntries(ids.map((id, index) => [id, {
    username: ['Host', 'PlayerB', 'PlayerC', 'PlayerD', 'Replacement'][index],
    avatar_url: null,
  }]));
  initial.friendships = ids.slice(1, 4).map(friendId => ({
    account_low: ids[0],
    account_high: friendId,
  }));
  const db = makeDb(initial);

  const created = await createGame({ account: { id: ids[0] }, inviteOnly: true, db });
  assert.equal(created.ok, true);
  assert.equal(db.state.games[0].status, 'WAITING');
  assert.equal(db.state.games[0].host_account_id, ids[0]);

  for (const friendId of ids.slice(1, 4)) {
    const invitation = await sendGameInvitation({
      account: { id: ids[0] }, gameId: created.gameId,
      inviteeAccountId: friendId, db,
    });
    assert.equal(invitation.ok, true);
    const accepted = await respondToGameInvitation({
      account: { id: friendId }, invitationId: invitation.invitation.id,
      action: 'accept', db,
    });
    assert.equal(accepted.ok, true);
  }

  const started = await startGame({ account: { id: ids[0] }, gameId: created.gameId, db });
  assert.equal(started.status, 'ACTIVE');
  assert.deepEqual(db.state.players.map(player => player.account_id), ids.slice(0, 4));
  assert.deepEqual(db.state.players.map(player => player.seat_index), [0, 1, 2, 3]);

  const firstPlayer = started.state.players[started.state.turnOrder[started.state.current]];
  const action = await executeGameAction({
    account: { id: firstPlayer.accountId }, gameId: created.gameId,
    action: { type: 'ROLL_DICE' }, version: 1, requestId: 'flow-roll', sql: db,
    random: () => 0.2,
  });
  assert.equal(action.ok, true);
  assert.equal(action.version, 2);
  const authoritativeSnapshot = engine.deserializeState(db.state.states[0].state);

  const paused = await pauseGame({ account: { id: ids[0] }, gameId: created.gameId, expectedVersion: 2, db });
  assert.equal(paused.status, 'PAUSED');
  assert.equal(db.state.games[0].id, created.gameId);
  assert.equal(db.state.states[0].version, 2);

  for (const returningId of [ids[0], ids[1], ids[3]]) {
    const returned = await joinGame({ account: { id: returningId }, gameId: created.gameId, db });
    assert.equal(returned.status, 'PAUSED');
  }
  const blocked = await resumeGame({ account: { id: ids[0] }, gameId: created.gameId, db });
  assert.equal(blocked.error.code, 'PLAYERS_MISSING');
  const replacement = await joinGame({ account: { id: ids[4] }, gameId: created.gameId, db });
  assert.equal(replacement.error.code, 'ORIGINAL_PLAYER_REQUIRED');

  await joinGame({ account: { id: ids[2] }, gameId: created.gameId, db });
  const resumed = await resumeGame({ account: { id: ids[0] }, gameId: created.gameId, db });
  assert.equal(resumed.gameId, created.gameId);
  assert.equal(resumed.version, 2);
  assert.deepEqual(resumed.state, authoritativeSnapshot);
  assert.deepEqual(resumed.players.map(player => player.seatIndex), [0, 1, 2, 3]);

  const clientStates = await Promise.all(ids.slice(0, 4).map(accountId =>
    getGameState({ account: { id: accountId }, gameId: created.gameId, db })
  ));
  assert.ok(clientStates.every(state => state.status === 'ACTIVE' && state.version === 2));
  assert.ok(clientStates.every(state => JSON.stringify(state.state) === JSON.stringify(clientStates[0].state)));

  const finalState = engine.deserializeState(db.state.states[0].state);
  finalState.over = true;
  finalState.winnerId = 0;
  finalState.eliminatedOrder = [3, 2, 1];
  db.state.states[0].state = engine.serializeState(finalState);
  await persistFinalResultsIfNeeded(db, created.gameId, finalState, board.spaces);
  assert.equal(db.state.games[0].status, 'FINISHED');

  for (const accountId of ids.slice(0, 3)) {
    const result = await getFinalResults({ account: { id: accountId }, gameId: created.gameId, db });
    assert.equal(result.ok, true);
    assert.ok(db.state.games.some(game => game.id === created.gameId));
  }
  const lastResults = await getFinalResults({ account: { id: ids[3] }, gameId: created.gameId, db });
  assert.equal(lastResults.ok, true);
  assert.equal(db.state.games.some(game => game.id === created.gameId), false);
  assert.equal(db.state.players.some(player => player.game_id === created.gameId), false);
  assert.equal(db.state.states.some(state => state.id === created.gameId), false);
  assert.equal(db.state.results.some(result => result.game_id === created.gameId), false);
});
