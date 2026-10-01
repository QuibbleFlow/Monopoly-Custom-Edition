const assert = require('node:assert/strict');
const test = require('node:test');
const engine = require('./game-engine.js');

const { createGame, joinGame, leaveGame, deleteGame, startGame, pauseGame, getLobby, getMyGames } = require('./api-handlers/game/lifecycle.js');
const { resumeGame } = require('./api-handlers/game/saves.js');
const { ensureDatabaseRuntimeState } = require('./lib/account.js');
const { getGameState, handleGetGameStateRoute } = require('./api-handlers/game/state.js');
const { executeGameAction } = require('./api-handlers/game/action.js');
const { getFinalResults } = require('./lib/game-results.js');
const { makeDbState, makeDb } = require('./test-support/mock-db.js');
const apiRouter = require('./api/router.js');

test('database schema guard catches missing required tables before lobby creation', async () => {
  const sql = async () => [
    { table_name: 'accounts', column_name: 'id' },
    { table_name: 'account_sessions', column_name: 'token_hash' },
  ];

  await assert.rejects(
    () => ensureDatabaseRuntimeState(sql),
    /Database schema is incomplete\. Missing required objects: accounts\.username/
  );
});

test('consolidated router maps the hyphenated my-games URL to its handler', async () => {
  const response = {
    headers: {},
    statusCode: 200,
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };

  await apiRouter({
    method: 'GET',
    url: '/api/game/my-games',
    headers: { cookie: '' },
  }, response);

  assert.notEqual(response.statusCode, 404);
  assert.ok([401, 503].includes(response.statusCode));
});

test('consolidated router recognizes invitation, pause, and delete game endpoints', async () => {
  for (const [method, url] of [
    ['GET', '/api/game/invitations'],
    ['POST', '/api/game/invitations'],
    ['PATCH', '/api/game/invitations/30000000-0000-4000-8000-000000000001'],
    ['POST', '/api/game/pause'],
    ['POST', '/api/game/delete'],
  ]) {
    const response = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) { this.headers[name] = value; return this; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await apiRouter({ method, url, headers: { cookie: '' }, body: {} }, response);
    assert.ok([401, 503].includes(response.statusCode), `${method} ${url} should reach authentication`);
  }
});

async function createActiveGame() {
  const db = makeDb();
  const created = await createGame({ account: { id: 'account-a' }, db });
  await joinGame({ account: { id: 'account-b' }, gameId: created.gameId, db });
  await startGame({ account: { id: 'account-a' }, gameId: created.gameId, db });
  return { db, gameId: created.gameId };
}

function editStoredGameState(db, edit) {
  const state = engine.deserializeState(db.state.states[0].state);
  edit(state);
  db.state.states[0].state = engine.serializeState(state);
  return state;
}

test('authenticated account can create a lobby and the host is enrolled as the first player', async () => {
  const db = makeDb();
  const result = await createGame({ account: { id: 'account-a' }, db });

  assert.equal(result.ok, true);
  assert.equal(result.game.hostAccountId, 'account-a');
  assert.equal(result.players[0].accountId, 'account-a');
  assert.equal(result.status, 'WAITING');
});

test('joining a waiting lobby adds a deterministic seat and rejects duplicates or invalid IDs', async () => {
  const db = makeDb();
  const created = await createGame({ account: { id: 'account-a' }, db });

  const joined = await joinGame({ account: { id: 'account-b' }, gameId: created.gameId, db });
  assert.equal(joined.ok, true);
  assert.equal(joined.players[1].seatIndex, 1);

  const duplicate = await joinGame({ account: { id: 'account-b' }, gameId: created.gameId, db });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.players.length, 2);

  const invalid = await joinGame({ account: { id: 'account-c' }, gameId: '', db });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'INVALID_GAME_ID');
});

test('a waiting lobby supports up to eight seats and rejects the ninth player', async () => {
  const db = makeDb();
  const created = await createGame({ account: { id: 'account-a' }, db });

  for (const id of ['account-b', 'account-c', 'account-d', 'account-e', 'account-f', 'account-g', 'account-h']) {
    const result = await joinGame({ account: { id }, gameId: created.gameId, db });
    assert.equal(result.ok, true, `expected ${id} to join the lobby`);
  }

  const full = await joinGame({ account: { id: 'account-i' }, gameId: created.gameId, db });
  assert.equal(full.ok, false);
  assert.equal(full.error.code, 'GAME_FULL');
  assert.equal(db.state.players.filter(player => player.game_id === created.gameId).length, 8);
});

test('a legacy waiting lobby fills a missing seat before start instead of colliding or shifting existing players', async () => {
  const initial = makeDbState();
  initial.games.push({ id: 'legacy-gap', host_account_id: 'account-a', status: 'WAITING', invite_only: false });
  initial.players.push(
    { game_id: 'legacy-gap', account_id: 'account-a', seat_index: 0 },
    { game_id: 'legacy-gap', account_id: 'account-c', seat_index: 2 },
  );
  const db = makeDb(initial);

  const joined = await joinGame({ account: { id: 'account-b' }, gameId: 'legacy-gap', db });
  assert.equal(joined.ok, true);
  assert.deepEqual(db.state.players.map(player => player.seat_index).sort(), [0, 1, 2]);

  const started = await startGame({ account: { id: 'account-a' }, gameId: 'legacy-gap', db });
  assert.equal(started.ok, true);
  assert.deepEqual(started.state.players.map(player => player.accountId), ['account-a', 'account-b', 'account-c']);
});

test('leaving preserves waiting games and exact player membership', async () => {
  const db = makeDb();
  const created = await createGame({ account: { id: 'account-a' }, db });
  await joinGame({ account: { id: 'account-b' }, gameId: created.gameId, db });

  const left = await leaveGame({ account: { id: 'account-a' }, gameId: created.gameId, db });
  assert.equal(left.ok, true);
  assert.equal(left.game.hostAccountId, 'account-a');
  assert.equal(left.membershipPreserved, true);
  assert.equal(db.state.players.filter(player => player.game_id === created.gameId).length, 2);

  const empty = await createGame({ account: { id: 'account-c' }, db });
  const emptied = await leaveGame({ account: { id: 'account-c' }, gameId: empty.gameId, db });
  assert.equal(emptied.deleted, undefined);
  assert.ok(db.state.games.some(game => game.id === empty.gameId));
  assert.ok(db.state.players.some(player => player.game_id === empty.gameId && player.account_id === 'account-c'));
});

test('leaving an ACTIVE match keeps its game state and original seat membership', async () => {
  const { db, gameId } = await createActiveGame();
  const left = await leaveGame({ account: { id: 'account-b' }, gameId, db });

  assert.equal(left.ok, true);
  assert.equal(left.status, 'ACTIVE');
  assert.equal(db.state.games[0].status, 'ACTIVE');
  assert.equal(db.state.players.find(player => player.account_id === 'account-b').seat_index, 1);
  assert.ok(db.state.states.some(state => state.id === gameId));
});

test('only the host can delete a game and deletion removes its dependent game records', async () => {
  const { db, gameId } = await createActiveGame();
  db.state.actionRequests.push({ game_id: gameId, request_id: 'old-request' });
  db.state.results.push({ game_id: gameId, placements: [] });

  const denied = await deleteGame({ account: { id: 'account-b' }, gameId, db });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'HOST_REQUIRED');
  assert.ok(db.state.games.some(game => game.id === gameId));

  const deleted = await deleteGame({ account: { id: 'account-a' }, gameId, db });
  assert.equal(deleted.ok, true);
  assert.equal(db.state.games.some(game => game.id === gameId), false);
  assert.equal(db.state.players.some(player => player.game_id === gameId), false);
  assert.equal(db.state.states.some(state => state.id === gameId), false);
  assert.equal(db.state.actionRequests.some(request => request.game_id === gameId), false);
  assert.equal(db.state.results.some(result => result.game_id === gameId), false);
});

test('finished games remain until every original player reads results, then clean up cascades', async () => {
  const { db, gameId } = await createActiveGame();
  db.state.games[0].status = 'FINISHED';
  db.state.games[0].finished_at = new Date().toISOString();
  db.state.results.push({
    game_id: gameId,
    winner_account_id: 'account-a',
    placements: [
      { accountId: 'account-a', placement: 1, money: 1500, netWorth: 1500 },
      { accountId: 'account-b', placement: 2, money: 1200, netWorth: 1200 },
    ],
    created_at: new Date().toISOString(),
  });
  db.state.actionRequests.push({ game_id: gameId, request_id: 'finished-action' });

  const firstView = await getFinalResults({ account: { id: 'account-a' }, gameId, db });
  assert.equal(firstView.ok, true);
  assert.ok(db.state.games.some(game => game.id === gameId));

  const secondView = await getFinalResults({ account: { id: 'account-b' }, gameId, db });
  assert.equal(secondView.ok, true);
  assert.equal(db.state.games.some(game => game.id === gameId), false);
  assert.equal(db.state.players.some(player => player.game_id === gameId), false);
  assert.equal(db.state.states.some(state => state.id === gameId), false);
  assert.equal(db.state.results.some(result => result.game_id === gameId), false);
  assert.equal(db.state.actionRequests.some(request => request.game_id === gameId), false);
});

test('My server games refresh removes only FINISHED matches older than thirty days', async () => {
  const db = makeDb();
  db.state.games.push(
    { id: 'expired-finished', host_account_id: 'account-a', status: 'FINISHED', updated_at: '2020-01-01T00:00:00.000Z' },
    { id: 'active-game', host_account_id: 'account-a', status: 'ACTIVE', finished_at: null },
    { id: 'waiting-game', host_account_id: 'account-a', status: 'WAITING', finished_at: null },
    { id: 'paused-game', host_account_id: 'account-a', status: 'PAUSED', finished_at: null },
  );

  const result = await getMyGames({ account: { id: 'account-a' }, db });

  assert.equal(result.ok, true);
  assert.deepEqual(db.state.games.map(game => game.id), ['active-game', 'waiting-game', 'paused-game']);
});

test('paused matches require every original account and resume the same state, version, and seats', async () => {
  const { db, gameId } = await createActiveGame();
  const originalState = engine.deserializeState(db.state.states[0].state);

  const nonHostPause = await pauseGame({ account: { id: 'account-b' }, gameId, expectedVersion: 1, db });
  assert.equal(nonHostPause.ok, false);
  assert.equal(nonHostPause.error.code, 'HOST_REQUIRED');

  const stalePause = await pauseGame({ account: { id: 'account-a' }, gameId, expectedVersion: 2, db });
  assert.equal(stalePause.ok, false);
  assert.equal(stalePause.error.code, 'STALE_VERSION');
  assert.equal(db.state.games[0].status, 'ACTIVE');
  assert.deepEqual(engine.deserializeState(db.state.states[0].state), originalState);

  const paused = await pauseGame({ account: { id: 'account-a' }, gameId, expectedVersion: 1, db });
  assert.equal(paused.ok, true);
  assert.equal(db.state.games[0].status, 'PAUSED');
  assert.equal(db.state.states[0].version, 1);
  assert.ok(db.state.players.every(player => player.returned_at === null));

  const earlyResume = await resumeGame({ account: { id: 'account-a' }, gameId, db });
  assert.equal(earlyResume.ok, false);
  assert.equal(earlyResume.error.code, 'PLAYERS_MISSING');

  const replacement = await joinGame({ account: { id: 'account-c' }, gameId, db });
  assert.equal(replacement.ok, false);
  assert.equal(replacement.error.code, 'ORIGINAL_PLAYER_REQUIRED');

  const hostReturned = await joinGame({ account: { id: 'account-a' }, gameId, db });
  assert.equal(hostReturned.status, 'PAUSED');
  await leaveGame({ account: { id: 'account-a' }, gameId, db });
  assert.equal(db.state.players.some(player => player.account_id === 'account-a' && player.game_id === gameId), true);
  assert.equal(db.state.players.find(player => player.account_id === 'account-a').returned_at, null);
  const stillMissing = await resumeGame({ account: { id: 'account-a' }, gameId, db });
  assert.equal(stillMissing.error.code, 'PLAYERS_MISSING');

  await joinGame({ account: { id: 'account-a' }, gameId, db });
  const playerReturned = await joinGame({ account: { id: 'account-b' }, gameId, db });
  assert.equal(playerReturned.players.map(player => player.accountId).join(','), 'account-a,account-b');
  assert.deepEqual(playerReturned.players.map(player => player.seatIndex), [0, 1]);

  const nonHostResume = await resumeGame({ account: { id: 'account-b' }, gameId, db });
  assert.equal(nonHostResume.error.code, 'HOST_REQUIRED');
  const resumed = await resumeGame({ account: { id: 'account-a' }, gameId, db });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.gameId, gameId);
  assert.equal(resumed.status, 'ACTIVE');
  assert.equal(resumed.version, 1);
  assert.deepEqual(resumed.state, originalState);
  assert.equal(db.state.games[0].status, 'ACTIVE');
  assert.deepEqual(db.state.players.map(player => player.seat_index), [0, 1]);
});

test('only the host can start a waiting lobby with enough players and the engine state is initialized', async () => {
  const db = makeDb();
  const created = await createGame({ account: { id: 'account-a' }, db });
  await joinGame({ account: { id: 'account-b' }, gameId: created.gameId, db });

  const notHost = await startGame({ account: { id: 'account-b' }, gameId: created.gameId, db });
  assert.equal(notHost.ok, false);
  assert.equal(notHost.error.code, 'HOST_REQUIRED');

  const started = await startGame({ account: { id: 'account-a' }, gameId: created.gameId, db });
  assert.equal(started.ok, true);
  assert.equal(started.status, 'ACTIVE');
  assert.equal(started.version, 1);
  assert.equal(started.state.players.length, 2);
  assert.equal(db.state.states[0].board.spaces.length, 40);
});

test('lobby reads are restricted to members and my-games lists the account memberships', async () => {
  const db = makeDb();
  const created = await createGame({ account: { id: 'account-a' }, db });
  await joinGame({ account: { id: 'account-b' }, gameId: created.gameId, db });

  const lobby = await getLobby({ account: { id: 'account-b' }, gameId: created.gameId, db });
  assert.equal(lobby.ok, true);
  assert.equal(lobby.game.gameId, created.gameId);

  const denied = await getLobby({ account: { id: 'account-z' }, gameId: created.gameId, db });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'NOT_IN_GAME');

  const mine = await getMyGames({ account: { id: 'account-b' }, db });
  assert.equal(mine.ok, true);
  assert.equal(mine.games[0].gameId, created.gameId);
});

test('state retrieval requires authentication and membership and returns the authoritative version', async () => {
  const db = makeDb();
  const created = await createGame({ account: { id: 'account-a' }, db });
  await joinGame({ account: { id: 'account-b' }, gameId: created.gameId, db });
  await startGame({ account: { id: 'account-a' }, gameId: created.gameId, db });

  const state = await getGameState({ account: { id: 'account-b' }, gameId: created.gameId, db });
  assert.equal(state.ok, true);
  assert.equal(state.gameId, created.gameId);
  assert.equal(state.version, 1);
  assert.ok(state.state && state.state.players);

  const denied = await getGameState({ account: { id: 'account-z' }, gameId: created.gameId, db });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'NOT_IN_GAME');

  const unauthenticated = await getGameState({ account: null, gameId: created.gameId, db });
  assert.equal(unauthenticated.ok, false);
  assert.equal(unauthenticated.error.code, 'UNAUTHENTICATED');
});

test('state route enforces authentication and membership and returns matching action events', async () => {
  const db = makeDb();
  const created = await createGame({ account: { id: 'account-a' }, db });
  await joinGame({ account: { id: 'account-b' }, gameId: created.gameId, db });
  await startGame({ account: { id: 'account-a' }, gameId: created.gameId, db });
  await executeGameAction({
    account: { id: 'account-a' },
    gameId: created.gameId,
    action: { type: 'ROLL_DICE' },
    version: 1,
    requestId: 'route-roll',
    sql: db,
    random: () => 0.5,
  });

  const routeRequest = { method: 'GET', url: `/api/game/state?gameId=${created.gameId}` };
  const makeResponse = () => ({
    headers: {},
    statusCode: 200,
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  });

  const unauthenticated = makeResponse();
  await handleGetGameStateRoute(routeRequest, unauthenticated, {
    currentAccount: async (req, res) => { res.status(401).json({ error: 'Sign in to continue.' }); return null; },
    database: () => db,
  });
  assert.equal(unauthenticated.statusCode, 401);

  const nonMember = makeResponse();
  await handleGetGameStateRoute(routeRequest, nonMember, {
    currentAccount: async () => ({ id: 'account-z' }),
    database: () => db,
  });
  assert.equal(nonMember.statusCode, 403);
  assert.equal(nonMember.body.error.code, 'NOT_IN_GAME');

  const member = makeResponse();
  await handleGetGameStateRoute(routeRequest, member, {
    currentAccount: async () => ({ id: 'account-b' }),
    database: () => db,
  });
  assert.equal(member.statusCode, 200);
  assert.equal(member.body.version, 2);
  assert.ok(member.body.state.players);
  assert.ok(member.body.events.some(event => event.type === 'DICE_ROLLED'));
});

test('stale versions are rejected and duplicate request IDs do not double execute', async () => {
  const db = makeDb();
  const created = await createGame({ account: { id: 'account-a' }, db });
  await joinGame({ account: { id: 'account-b' }, gameId: created.gameId, db });
  await startGame({ account: { id: 'account-a' }, gameId: created.gameId, db });

  const stale = await executeGameAction({
    account: { id: 'account-a' },
    gameId: created.gameId,
    action: { type: 'ROLL_DICE' },
    version: 1,
    requestId: 'req-stale',
    sql: db,
    random: () => 0.5,
  });
  assert.equal(stale.ok, true);
  assert.equal(stale.version, 2);

  const retries = await executeGameAction({
    account: { id: 'account-a' },
    gameId: created.gameId,
    action: { type: 'ROLL_DICE' },
    version: 1,
    requestId: 'req-stale',
    sql: db,
    random: () => 0.9,
  });
  assert.equal(retries.ok, true);
  assert.equal(retries.version, 2);
  assert.deepEqual(db.state.states[0].state.dice, [4, 4]);
  assert.equal(db.state.states[0].version, 2);

  const staleAttempt = await executeGameAction({
    account: { id: 'account-a' },
    gameId: created.gameId,
    action: { type: 'ROLL_DICE' },
    version: 1,
    sql: db,
    random: () => 0.9,
  });
  assert.equal(staleAttempt.ok, false);
  assert.equal(staleAttempt.error.code, 'STALE_VERSION');
});

test('only the current authenticated player can roll and client-supplied dice are rejected', async () => {
  const { db, gameId } = await createActiveGame();
  let randomCalls = 0;

  const wrongTurn = await executeGameAction({
    account: { id: 'account-b' }, gameId, action: { type: 'ROLL_DICE' }, version: 1, requestId: 'wrong-turn', sql: db,
    random: () => { randomCalls += 1; return 0; },
  });
  assert.equal(wrongTurn.ok, false);
  assert.equal(wrongTurn.error.code, 'NOT_YOUR_TURN');

  const clientDice = await executeGameAction({
    account: { id: 'account-a' }, gameId, action: { type: 'ROLL_DICE', dice: [1, 1] }, version: 1, requestId: 'client-dice', sql: db,
    random: () => { randomCalls += 1; return 0; },
  });
  assert.equal(clientDice.ok, false);
  assert.equal(clientDice.error.code, 'CLIENT_DICE_REJECTED');
  assert.equal(randomCalls, 0);
  assert.equal(db.state.states[0].version, 1);
});

test('a paused match rejects stale-client actions without changing its stored version', async () => {
  const { db, gameId } = await createActiveGame();
  await pauseGame({ account: { id: 'account-a' }, gameId, expectedVersion: 1, db });

  const result = await executeGameAction({
    account: { id: 'account-a' },
    gameId,
    action: { type: 'ROLL_DICE' },
    version: 1,
    requestId: 'paused-action',
    sql: db,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'GAME_NOT_ACTIVE');
  assert.equal(db.state.states[0].version, 1);
});

test('authoritative roll moves across GO, pays salary, advances turn, and increments one version', async () => {
  const { db, gameId } = await createActiveGame();
  const state = engine.deserializeState(db.state.states[0].state);
  state.players[0].pos = 36;
  db.state.states[0].state = engine.serializeState(state);
  const dice = [0, 1 / 3];

  const result = await executeGameAction({
    account: { id: 'account-a' }, gameId, action: { type: 'ROLL_DICE' }, version: 1, requestId: 'go-roll', sql: db,
    random: () => dice.shift(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.version, 2);
  assert.deepEqual(result.state.dice, [1, 3]);
  assert.equal(result.state.players[0].pos, 0);
  assert.equal(result.state.players[0].money, 1700);
  assert.equal(result.state.current, 1);
  assert.ok(result.events.some(event => event.type === 'GO_SALARY_COLLECTED' && event.amount === 200));
  assert.ok(result.events.some(event => event.type === 'LANDING_NO_EFFECT' && event.position === 0));
  assert.ok(result.events.some(event => event.type === 'TURN_CHANGED' && event.playerId === 1));
  assert.equal(db.state.states[0].version, 2);
});

test('authoritative landing resolves rent and taxes before advancing the turn', async () => {
  const rentGame = await createActiveGame();
  const rentState = engine.deserializeState(rentGame.db.state.states[0].state);
  rentState.players[0].pos = 34;
  rentState.owners[37] = 1;
  rentGame.db.state.states[0].state = engine.serializeState(rentState);
  const rentDice = [0, 1 / 6];

  const rent = await executeGameAction({
    account: { id: 'account-a' }, gameId: rentGame.gameId, action: { type: 'ROLL_DICE' }, version: 1, requestId: 'rent-roll', sql: rentGame.db,
    random: () => rentDice.shift(),
  });

  assert.equal(rent.state.players[0].money, 1465);
  assert.equal(rent.state.players[1].money, 1535);
  assert.ok(rent.events.some(event => event.type === 'RENT_DUE' && event.amount === 35));
  assert.ok(rent.events.some(event => event.type === 'PAYMENT_SETTLED' && event.creditorId === 1 && event.amount === 35));
  assert.equal(rent.state.current, 1);
  assert.equal(rent.version, 2);

  const taxGame = await createActiveGame();
  const taxState = engine.deserializeState(taxGame.db.state.states[0].state);
  taxState.players[0].pos = 35;
  taxGame.db.state.states[0].state = engine.serializeState(taxState);
  const taxDice = [0, 1 / 6];

  const tax = await executeGameAction({
    account: { id: 'account-a' }, gameId: taxGame.gameId, action: { type: 'ROLL_DICE' }, version: 1, requestId: 'tax-roll', sql: taxGame.db,
    random: () => taxDice.shift(),
  });

  assert.equal(tax.state.players[0].pos, 38);
  assert.equal(tax.state.players[0].money, 1400);
  assert.ok(tax.events.some(event => event.type === 'TAX_DUE' && event.amount === 100));
  assert.ok(tax.events.some(event => event.type === 'PAYMENT_SETTLED' && event.amount === 100));
  assert.equal(tax.state.current, 1);
  assert.equal(tax.version, 2);
});

test('authoritative doubles retain the turn and a third double sends the player to jail', async () => {
  const doublesGame = await createActiveGame();
  const doublesState = engine.deserializeState(doublesGame.db.state.states[0].state);
  doublesState.players[0].pos = 18;
  doublesGame.db.state.states[0].state = engine.serializeState(doublesState);

  const doubles = await executeGameAction({
    account: { id: 'account-a' }, gameId: doublesGame.gameId, action: { type: 'ROLL_DICE' }, version: 1, requestId: 'double-roll', sql: doublesGame.db,
    random: () => 0,
  });

  assert.equal(doubles.state.current, 0);
  assert.equal(doubles.state.phase, 'roll');
  assert.equal(doubles.state.doubles, 1);
  assert.ok(doubles.events.some(event => event.type === 'DOUBLES_AGAIN'));
  assert.ok(!doubles.events.some(event => event.type === 'TURN_CHANGED'));
  assert.equal(doubles.version, 2);

  const jailGame = await createActiveGame();
  const jailState = engine.deserializeState(jailGame.db.state.states[0].state);
  jailState.players[0].pos = 8;
  jailState.doubles = 2;
  jailGame.db.state.states[0].state = engine.serializeState(jailState);

  const thirdDouble = await executeGameAction({
    account: { id: 'account-a' }, gameId: jailGame.gameId, action: { type: 'ROLL_DICE' }, version: 1, requestId: 'third-double', sql: jailGame.db,
    random: () => 0,
  });

  assert.equal(thirdDouble.state.players[0].pos, 10);
  assert.equal(thirdDouble.state.players[0].inJail, true);
  assert.equal(thirdDouble.state.current, 1);
  assert.ok(thirdDouble.events.some(event => event.type === 'THREE_DOUBLES_JAIL'));
  assert.ok(thirdDouble.events.some(event => event.type === 'TURN_CHANGED'));
  assert.equal(thirdDouble.version, 2);
});

test('property purchase is authorized, priced by the engine, idempotent, and stale writes are rejected', async () => {
  const { db, gameId } = await createActiveGame();
  editStoredGameState(db, state => {
    state.phase = 'buy';
    state.players[0].pos = 1;
  });

  const unauthorized = await executeGameAction({
    account: { id: 'account-b' }, gameId, action: { type: 'BUY_PROPERTY', position: 1 }, version: 1, sql: db,
  });
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.error.code, 'NOT_YOUR_TURN');

  const invalid = await executeGameAction({
    account: { id: 'account-a' }, gameId, action: { type: 'BUY_PROPERTY', position: 2 }, version: 1, sql: db,
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'ILLEGAL_ACTION');

  const bought = await executeGameAction({
    account: { id: 'account-a' }, gameId, action: { type: 'BUY_PROPERTY', position: 1 }, version: 1, requestId: 'buy-1', sql: db,
  });
  assert.equal(bought.ok, true);
  assert.equal(bought.state.owners[1], 0);
  assert.equal(bought.state.players[0].money, 1440);
  assert.ok(bought.events.some(event => event.type === 'PROPERTY_PURCHASED' && event.amount === 60));
  assert.equal(bought.version, 2);

  const retry = await executeGameAction({
    account: { id: 'account-a' }, gameId, action: { type: 'BUY_PROPERTY', position: 1 }, version: 1, requestId: 'buy-1', sql: db,
  });
  assert.equal(retry.version, 2);
  assert.equal(db.state.states[0].state.players[0].money, 1440);
  assert.equal(db.state.states[0].version, 2);

  const stale = await executeGameAction({
    account: { id: 'account-a' }, gameId, action: { type: 'BUY_PROPERTY', position: 1 }, version: 1, sql: db,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'STALE_VERSION');
});

test('auction actions follow the backend bidder, reject invalid bids, and assign the winning property', async () => {
  const { db, gameId } = await createActiveGame();
  editStoredGameState(db, state => {
    state.phase = 'auction';
    state.auction = { pos: 1, high: 0, highId: null, active: [1, 0], turn: 1 };
  });

  const wrongBidder = await executeGameAction({
    account: { id: 'account-a' }, gameId, action: { type: 'AUCTION_BID', amount: 50 }, version: 1, sql: db,
  });
  assert.equal(wrongBidder.ok, false);
  assert.equal(wrongBidder.error.code, 'NOT_YOUR_TURN');

  const invalidBid = await executeGameAction({
    account: { id: 'account-b' }, gameId, action: { type: 'AUCTION_BID', amount: 0 }, version: 1, sql: db,
  });
  assert.equal(invalidBid.ok, false);
  assert.equal(invalidBid.error.code, 'ILLEGAL_ACTION');

  const bid = await executeGameAction({
    account: { id: 'account-b' }, gameId, action: { type: 'AUCTION_BID', amount: 100 }, version: 1, requestId: 'bid-1', sql: db,
  });
  assert.equal(bid.state.auction.turn, 0);
  assert.equal(bid.state.auction.high, 100);
  assert.equal(bid.version, 2);

  const folded = await executeGameAction({
    account: { id: 'account-a' }, gameId, action: { type: 'AUCTION_FOLD' }, version: 2, requestId: 'fold-1', sql: db,
  });
  assert.equal(folded.state.auction, null);
  assert.equal(folded.state.owners[1], 1);
  assert.equal(folded.state.players[1].money, 1400);
  assert.ok(folded.events.some(event => event.type === 'AUCTION_ENDED' && event.winnerId === 1));
  assert.equal(folded.version, 3);
});

test('card draw and card movement are server-selected and returned with authoritative state', async () => {
  const { db, gameId } = await createActiveGame();
  const randomValues = [0, 0, 0.1];
  const cardRoll = await executeGameAction({
    account: { id: 'account-a' }, gameId, action: { type: 'ROLL_DICE' }, version: 1, requestId: 'chest-roll', sql: db,
    random: () => randomValues.shift(),
  });
  assert.equal(cardRoll.state.players[0].money, 1700);
  assert.equal(cardRoll.version, 2);
  assert.ok(cardRoll.events.some(event => event.type === 'CARD_DRAWN' && event.deck === 'chest' && event.text === 'Bank error in your favor. Collect $200.'));
  assert.ok(cardRoll.events.some(event => event.type === 'CARD_MONEY_COLLECTED' && event.amount === 200));

  const clientCard = await executeGameAction({
    account: { id: 'account-a' }, gameId, action: { type: 'APPLY_CARD', card: { action: 'money', value: 99999 } }, version: 2, sql: db,
  });
  assert.equal(clientCard.ok, false);
  assert.equal(clientCard.error.code, 'CLIENT_CARD_REJECTED');

  const movementGame = await createActiveGame();
  editStoredGameState(movementGame.db, state => { state.players[0].pos = 5; });
  const movementRandom = [0, 0, 0];
  const cardMovement = await executeGameAction({
    account: { id: 'account-a' }, gameId: movementGame.gameId, action: { type: 'ROLL_DICE' }, version: 1, requestId: 'chance-move', sql: movementGame.db,
    random: () => movementRandom.shift(),
  });
  assert.equal(cardMovement.state.players[0].pos, 0);
  assert.equal(cardMovement.state.players[0].money, 1700);
  assert.ok(cardMovement.events.some(event => event.type === 'CARD_MOVEMENT_REQUESTED' && event.target === 0));
  assert.ok(cardMovement.events.filter(event => event.type === 'PLAYER_MOVED').length > 2);
  assert.ok(cardMovement.events.some(event => event.type === 'GO_SALARY_COLLECTED'));
  assert.equal(cardMovement.version, 2);
});

test('debt blocks unrelated actions, permits debtor liquidation, and bankruptcy transfers assets once', async () => {
  const debtGame = await createActiveGame();
  editStoredGameState(debtGame.db, state => {
    state.players[0].pos = 35;
    state.players[0].money = 0;
    state.owners[37] = 1;
    state.houses[37] = 1;
    state.owners[3] = 0;
    state.owners[39] = 0;
    state.owners[34] = 0;
    state.owners[32] = 0;
  });
  const dice = [0, 0];
  const debt = await executeGameAction({
    account: { id: 'account-a' }, gameId: debtGame.gameId, action: { type: 'ROLL_DICE' }, version: 1, requestId: 'debt-roll', sql: debtGame.db,
    random: () => dice.shift(),
  });
  assert.equal(debt.state.phase, 'debt');
  assert.equal(debt.state.debt.pid, 0);
  assert.ok(debt.events.some(event => event.type === 'DEBT_CREATED'));
  assert.equal(debt.version, 2);

  const blockedRoll = await executeGameAction({
    account: { id: 'account-a' }, gameId: debtGame.gameId, action: { type: 'ROLL_DICE' }, version: 2, sql: debtGame.db,
  });
  assert.equal(blockedRoll.ok, false);
  assert.equal(blockedRoll.error.code, 'ILLEGAL_ACTION');

  const wrongDebtor = await executeGameAction({
    account: { id: 'account-b' }, gameId: debtGame.gameId, action: { type: 'MORTGAGE_PROPERTY', position: 1 }, version: 2, sql: debtGame.db,
  });
  assert.equal(wrongDebtor.ok, false);
  assert.equal(wrongDebtor.error.code, 'NOT_YOUR_TURN');

  const mortgaged = await executeGameAction({
    account: { id: 'account-a' }, gameId: debtGame.gameId, action: { type: 'MORTGAGE_PROPERTY', position: 3 }, version: 2, requestId: 'debt-mortgage', sql: debtGame.db,
  });
  assert.equal(mortgaged.state.players[0].money, 30);
  assert.equal(mortgaged.state.mortgaged[3], true);
  assert.equal(mortgaged.state.phase, 'debt');
  assert.equal(mortgaged.version, 3);

  const bankruptGame = await createActiveGame();
  editStoredGameState(bankruptGame.db, state => {
    state.players[0].pos = 35;
    state.players[0].money = 0;
    state.owners[37] = 1;
    state.houses[37] = 1;
    state.owners[39] = 0;
    state.owners[34] = 0;
    state.owners[32] = 0;
  });
  const bankruptDice = [0, 0];
  await executeGameAction({
    account: { id: 'account-a' }, gameId: bankruptGame.gameId, action: { type: 'ROLL_DICE' }, version: 1, requestId: 'bankrupt-roll', sql: bankruptGame.db,
    random: () => bankruptDice.shift(),
  });
  await executeGameAction({
    account: { id: 'account-a' }, gameId: bankruptGame.gameId, action: { type: 'CONFIRM_BANKRUPTCY' }, version: 2, requestId: 'bankrupt-confirm', sql: bankruptGame.db,
  });
  const bankrupt = await executeGameAction({
    account: { id: 'account-a' }, gameId: bankruptGame.gameId, action: { type: 'CONFIRM_BANKRUPTCY' }, version: 3, requestId: 'bankrupt-final', sql: bankruptGame.db,
  });
  assert.equal(bankrupt.state.players[0].bankrupt, true);
  assert.equal(bankrupt.state.owners[39], 1);
  assert.equal(bankrupt.state.owners[34], 1);
  assert.equal(bankrupt.state.owners[32], 1);
  assert.ok(bankrupt.events.some(event => event.type === 'PLAYER_BANKRUPT'));
  assert.equal(bankrupt.version, 4);

  const bankruptcyRetry = await executeGameAction({
    account: { id: 'account-a' }, gameId: bankruptGame.gameId, action: { type: 'CONFIRM_BANKRUPTCY' }, version: 3, requestId: 'bankrupt-final', sql: bankruptGame.db,
  });
  assert.equal(bankruptcyRetry.version, 4);
  assert.equal(bankruptGame.db.state.states[0].version, 4);
});

test('property management validates owners and allows consecutive house purchases plus mortgage cycles', async () => {
  const { db, gameId } = await createActiveGame();
  editStoredGameState(db, state => {
    state.phase = 'after';
    state.owners[1] = 0;
    state.owners[3] = 0;
  });

  const nonOwner = await executeGameAction({
    account: { id: 'account-b' }, gameId, action: { type: 'BUY_HOUSE', position: 1 }, version: 1, sql: db,
  });
  assert.equal(nonOwner.ok, false);
  assert.equal(nonOwner.error.code, 'NOT_YOUR_TURN');

  const first = await executeGameAction({
    account: { id: 'account-a' }, gameId, action: { type: 'BUY_HOUSE', position: 1 }, version: 1, requestId: 'house-1', sql: db,
  });
  const second = await executeGameAction({
    account: { id: 'account-a' }, gameId, action: { type: 'BUY_HOUSE', position: 1 }, version: 2, requestId: 'house-2', sql: db,
  });
  assert.equal(first.state.houses[1], 1);
  assert.equal(second.state.houses[1], 2);
  assert.equal(second.state.players[0].money, 1400);
  assert.equal(second.version, 3);

  const saleOne = await executeGameAction({ account: { id: 'account-a' }, gameId, action: { type: 'SELL_HOUSE', position: 1 }, version: 3, sql: db });
  const saleTwo = await executeGameAction({ account: { id: 'account-a' }, gameId, action: { type: 'SELL_HOUSE', position: 1 }, version: 4, sql: db });
  assert.equal(saleTwo.state.houses[1], 0);

  const mortgaged = await executeGameAction({ account: { id: 'account-a' }, gameId, action: { type: 'MORTGAGE_PROPERTY', position: 1 }, version: 5, sql: db });
  assert.equal(mortgaged.state.mortgaged[1], true);
  const unmortgaged = await executeGameAction({ account: { id: 'account-a' }, gameId, action: { type: 'UNMORTGAGE_PROPERTY', position: 1 }, version: 6, sql: db });
  assert.equal(unmortgaged.state.mortgaged[1], false);
  assert.equal(unmortgaged.version, 7);
  assert.ok(saleOne.ok);
});
