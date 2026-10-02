const assert = require('node:assert/strict');
const { test, before, beforeEach, after } = require('node:test');
const fs = require('node:fs');
const { PGlite } = require('@electric-sql/pglite');
const { createGame, joinGame, startGame, pauseGame, getMyGames, getLobby } = require('./api-handlers/game/lifecycle');
const { handleConnection, discoverMatches } = require('./api-handlers/game/connection');
const { loadGame, resumeGame, listSaves, saveGame } = require('./api-handlers/game/saves');
const { sendGameInvitation, respondToGameInvitation } = require('./api-handlers/game/invitations');
const { getGameState } = require('./api-handlers/game/state');
const { executeGameAction } = require('./api-handlers/game/action');
const snapshotRoute = require('./api-handlers/friends/snapshot');
const { removePlayer } = require('./lib/game-connections');
const engine = require('./game-engine');

const ids = Array.from({ length: 4 }, (_, index) => `20000000-0000-4000-8000-00000000000${index + 1}`);
const sessions = ids.map((_, index) => `tab-session-000000${index}`);
let pg, sql, now;
const realNow = Date.now;

function queryAdapter(client) {
  return async (strings, ...values) => {
    const text = strings.reduce((text, part, i) => text + part + (i < values.length ? `$${i + 1}` : ''), '');
    return (await client.query(text, values)).rows;
  };
}

before(async () => {
  pg = new PGlite();
  await pg.exec(fs.readFileSync('db/schema.sql', 'utf8').replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', ''));
  sql = queryAdapter(pg);
  sql.begin = callback => pg.transaction(tx => callback(queryAdapter(tx)));
  Date.now = () => now;
});
beforeEach(async () => {
  now = realNow();
  await pg.exec('TRUNCATE accounts CASCADE');
  for (let i = 0; i < ids.length; i++) await sql`INSERT INTO accounts (id, username, password_hash) VALUES (${ids[i]}, ${['Goalie', 'QuibbleFlow', 'GamerGriffGG', 'Fourth'][i]}, ${'test'})`;
  for (let i = 1; i < ids.length; i++) await sql`INSERT INTO friendships (account_low, account_high) VALUES (${ids[0]}, ${ids[i]})`;
});
after(async () => { Date.now = realNow; await pg?.close(); });

async function connect(gameId, index, action = 'rejoin', sessionId = sessions[index]) {
  return handleConnection({ account: { id: ids[index] }, gameId, action, sessionId, db: sql });
}
async function activeMatch(count = 3) {
  const created = await createGame({ account: { id: ids[0] }, db: sql });
  for (let i = 1; i < count; i++) assert.equal((await joinGame({ account: { id: ids[i] }, gameId: created.gameId, db: sql })).ok, true);
  const started = await startGame({ account: { id: ids[0] }, gameId: created.gameId, db: sql });
  assert.equal(started.ok, true);
  for (let i = 0; i < count; i++) assert.equal((await connect(created.gameId, i)).ok, true);
  return created.gameId;
}
async function stored(gameId) { return (await sql`SELECT * FROM game_states WHERE id = ${gameId}`)[0]; }
async function setState(gameId, edit) {
  const row = await stored(gameId); const state = engine.deserializeState(row.state); edit(state);
  await sql`UPDATE game_states SET state = ${JSON.stringify(state)}::jsonb WHERE id = ${gameId}`;
}
async function advance(gameId, duration, connected = [0, 1, 2]) {
  for (let elapsed = 0; elapsed < duration;) {
    const step = Math.min(10000, duration - elapsed); now += step; elapsed += step;
    for (const index of connected) assert.equal((await connect(gameId, index, 'heartbeat')).ok, true);
  }
}
async function pause(gameId, index = 0) {
  return pauseGame({ account: { id: ids[index] }, gameId, expectedVersion: (await stored(gameId)).version, db: sql });
}
async function invite(gameId, index) {
  const sent = await sendGameInvitation({ account: { id: ids[0] }, gameId, inviteeAccountId: ids[index], db: sql });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const joined = await respondToGameInvitation({ account: { id: ids[index] }, invitationId: sent.invitation.id, action: 'accept', db: sql });
  assert.equal(joined.ok, true, JSON.stringify(joined));
}

test('abandon reserves exact game data, transfers host once, and rejoins the same seat at the final second', async () => {
  const gameId = await activeMatch();
  await setState(gameId, state => { state.players[0].money = 731; state.players[0].pos = 17; state.players[0].inJail = true; state.players[0].inventory = ['custom']; state.owners[1] = 0; state.houses[1] = 2; });
  const beforeState = (await stored(gameId)).state;
  const left = await connect(gameId, 0, 'disconnect');
  assert.equal(left.match.reconnectUntil, now + 120000);
  assert.equal(left.match.hostAccountId, ids[1]);
  const reserved = (await stored(gameId)).state;
  for (const field of ['players', 'owners', 'houses', 'mortgaged', 'turnOrder', 'current']) assert.deepEqual(reserved[field], beforeState[field]);
  await advance(gameId, 119999, [1, 2]);
  const rejoined = await connect(gameId, 0);
  assert.equal(rejoined.ok, true);
  assert.equal(rejoined.match.hostAccountId, ids[1]);
  assert.deepEqual((await stored(gameId)).state.players[0], beforeState.players[0]);
  assert.equal((await sql`SELECT seat_index FROM game_players WHERE game_id = ${gameId} AND account_id = ${ids[0]}`)[0].seat_index, 0);
});

test('refreshes never extend a deadline and multiple tabs do not duplicate or disconnect a live seat', async () => {
  const gameId = await activeMatch();
  await connect(gameId, 1, 'rejoin', 'second-tab-session-0001');
  const oneClosed = await connect(gameId, 1, 'disconnect');
  assert.equal(oneClosed.match.status, 'connected');
  assert.equal((await sql`SELECT COUNT(*)::int AS total FROM game_players WHERE game_id = ${gameId} AND account_id = ${ids[1]}`)[0].total, 1);
  const bothClosed = await connect(gameId, 1, 'disconnect', 'second-tab-session-0001');
  const deadline = bothClosed.match.reconnectUntil;
  await advance(gameId, 30000, [0, 2]);
  const repeated = await connect(gameId, 1, 'disconnect', 'refreshed-tab-session-0001');
  assert.equal(repeated.match.reconnectUntil, deadline);
  const heartbeat = await connect(gameId, 1, 'heartbeat');
  assert.equal(heartbeat.error.code, 'RECONNECT_REQUIRED');
});

test('lost connections use persisted lease deadlines and late rejoin requests cannot resurrect a removed player', async () => {
  const gameId = await activeMatch();
  const state = (await stored(gameId)).state;
  const deadline = state.connections.players[ids[1]].leaseUntil + 120000;
  await advance(gameId, 150001, [0, 2]);
  assert.ok(now > deadline);
  const late = await connect(gameId, 1);
  assert.equal(late.error.code, 'RECONNECT_EXPIRED');
  assert.equal((await stored(gameId)).state.players[1].removed, true);
  assert.equal((await sql`SELECT * FROM game_players WHERE game_id = ${gameId} AND account_id = ${ids[1]}`).length, 0);
  assert.equal((await discoverMatches({ account: { id: ids[1] }, db: sql })).matches.length, 0);
});

test('a disconnected turn waits without consuming its timer, then resumes with the same state', async () => {
  const gameId = await activeMatch();
  await setState(gameId, state => { state.turnOrder = [1, 2, 0]; state.current = 0; state.phase = 'after'; state.tradeTimerEnd = now + 1000; });
  await connect(gameId, 1, 'disconnect');
  await advance(gameId, 15000, [0, 2]);
  const row = await stored(gameId);
  const tick = await executeGameAction({ account: { id: ids[0] }, gameId, version: row.version, action: { type: 'GAME_TICK' }, sql });
  assert.equal(tick.ok, true);
  assert.equal(tick.state.current, 0);
  await connect(gameId, 1);
  assert.equal((await stored(gameId)).state.tradeTimerEnd, now + 1000);
});

test('expired and permanent departures release property and repair debt, jail, auction, trade, and turn order', async () => {
  const gameId = await activeMatch();
  await setState(gameId, state => {
    state.turnOrder = [1, 2, 0]; state.current = 0; state.players[1].inJail = true;
    state.owners[1] = 1; state.houses[1] = 3; state.mortgaged[1] = true;
    state.debt = { pid: 1, amount: 500, creditorId: 2 }; state.pendingMove = { playerId:1, steps:3 };
    state.trade = { from: 1, to: 2 }; state.auction = { pos:3, high:100, highId:1, turn:1, active:[1,2,0] };
  });
  const left = await connect(gameId, 1, 'leave');
  assert.equal(left.ok, true);
  const state = (await stored(gameId)).state;
  assert.equal(state.players[1].removed, true);
  assert.equal(state.owners[1], null); assert.equal(state.houses[1], 0); assert.equal(state.mortgaged[1], false);
  assert.equal(state.turnOrder[state.current], 2);
  for (const field of ['debt', 'auction', 'trade', 'pendingMove']) assert.equal(state[field], null);
  assert.deepEqual(state.players.filter(player => !player.removed).map(player => player.id), [0, 2]);
  const other = engine.createState({names:['a','b','c'],accountIds:ids});
  other.auction = { pos:3, high:100, highId:1, turn:1, active:[1,2,0] };
  other.debt = { pid:0, amount:100, creditorId:1 };
  removePlayer(other, ids[1]);
  assert.equal(other.debt.creditorId, null); assert.equal(other.auction.highId, null); assert.equal(other.auction.turn, 2);
});

test('saving during reconnection retains the deadline, removes expired players from the save, and requires fresh invitations', async () => {
  const gameId = await activeMatch();
  await connect(gameId, 2, 'disconnect');
  const saved = await pause(gameId);
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal((await joinGame({ account:{id:ids[1]},gameId,db:sql })).error.code, 'INVITATION_REQUIRED');
  assert.equal((await getLobby({ account:{id:ids[1]},gameId,db:sql })).error.code, 'INVITATION_REQUIRED');
  assert.equal((await getMyGames({ account:{id:ids[1]},db:sql })).games.length, 0);
  now += 120001;
  const loaded = await loadGame({ account:{id:ids[0]},saveId:saved.saveId,db:sql });
  assert.equal(loaded.ok, true);
  const checkpoint = (await sql`SELECT state, players FROM game_saves WHERE id = ${saved.saveId}`)[0];
  assert.equal(checkpoint.players.length, 2); assert.equal(checkpoint.state.players[2].removed, true);
  assert.equal((await sendGameInvitation({ account:{id:ids[0]},gameId,inviteeAccountId:ids[2],db:sql })).error.code, 'ORIGINAL_PLAYER_REQUIRED');
  await invite(gameId, 1);
  const resumed = await resumeGame({account:{id:ids[0]},gameId,db:sql});
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(resumed.state.players[2].removed, true);
});

test('guests cannot load saves or bypass invitations in a recovered lobby', async () => {
  const gameId = await activeMatch(); const saved = await pause(gameId);
  assert.equal((await loadGame({account:{id:ids[1]},saveId:saved.saveId,db:sql})).error.code, 'SAVE_NOT_FOUND');
  await sql`DELETE FROM games WHERE id = ${gameId}`;
  const loaded = await loadGame({account:{id:ids[0]},saveId:saved.saveId,db:sql});
  assert.equal(loaded.ok, true);
  assert.equal((await joinGame({account:{id:ids[1]},gameId:loaded.gameId,db:sql})).error.code, 'INVITATION_REQUIRED');
  assert.equal((await getLobby({account:{id:ids[1]},gameId:loaded.gameId,db:sql})).error.code, 'INVITATION_REQUIRED');
  await invite(loaded.gameId, 1); await invite(loaded.gameId, 2);
  assert.equal((await resumeGame({account:{id:ids[0]},gameId:loaded.gameId,db:sql})).ok, true);
});

test('saved invitations respect the exact reconnect deadline and preserve a timely return', async () => {
  for (const elapsed of [119999, 120000]) {
    const gameId = await activeMatch();
    await connect(gameId, 2, 'disconnect');
    const saved = await pause(gameId);
    const sent = await sendGameInvitation({ account: { id: ids[0] }, gameId, inviteeAccountId: ids[2], db: sql });
    assert.equal(sent.ok, true);
    now += elapsed;
    const returned = await respondToGameInvitation({ account: { id: ids[2] }, invitationId: sent.invitation.id, action: 'accept', db: sql });
    if (elapsed < 120000) {
      assert.equal(returned.ok, true, JSON.stringify(returned));
      assert.equal((await stored(gameId)).state.connections.players[ids[2]].reconnectUntil, null);
    } else {
      assert.equal(returned.error.code, 'ORIGINAL_PLAYER_REQUIRED');
      assert.equal((await sql`SELECT players FROM game_saves WHERE id = ${saved.saveId}`)[0].players.length, 2);
    }
  }
});

test('the third save evicts the oldest, repeated saves reuse a slot, and a started match creates no file', async () => {
  const saveIds = [];
  for (let i = 0; i < 3; i++) {
    const gameId = await activeMatch();
    assert.equal((await saveGame({account:{id:ids[0]},gameId,name:'Premature',db:sql})).error.code, 'USE_SAVE_AND_QUIT');
    const saved = await pause(gameId); assert.equal(saved.ok, true); saveIds.push(saved.saveId);
    await sql`UPDATE game_saves SET created_at = ${new Date(now - 3000 + i * 1000).toISOString()} WHERE id = ${saved.saveId}`;
  }
  const listed = await listSaves({account:{id:ids[0]},db:sql});
  assert.equal(listed.saves.length, 2); assert.equal(listed.saveLimit, 2);
  assert.ok(!listed.saves.some(save => save.saveId === saveIds[0]));
  const newest = listed.saves.find(save => save.saveId === saveIds[2]);
  await loadGame({account:{id:ids[0]},saveId:newest.saveId,db:sql});
  await invite(newest.sourceGameId,1); await invite(newest.sourceGameId,2);
  await resumeGame({account:{id:ids[0]},gameId:newest.sourceGameId,db:sql});
  const again = await pause(newest.sourceGameId);
  assert.equal(again.saveId, newest.saveId);
  assert.equal((await listSaves({account:{id:ids[0]},db:sql})).saves.length, 2);
});

test('host succession and all remaining host actions use the selected board and original state', async () => {
  const gameId = await activeMatch(4);
  await setState(gameId, state => { state.boardName='Custom Board'; state.boardNames[0]='Custom Start'; state.players[3].money=821; });
  await connect(gameId, 0, 'disconnect');
  assert.equal((await connect(gameId, 1, 'disconnect')).match.hostAccountId, ids[2]);
  const state = await getGameState({account:{id:ids[2]},gameId,db:sql});
  assert.equal(state.hostAccountId, ids[2]); assert.equal(state.state.boardNames[0], 'Custom Start');
  assert.equal(state.state.players[3].money, 821); assert.equal(state.state.connections, undefined);
  const saved = await pause(gameId,2); assert.equal(saved.ok, true);
  assert.equal((await listSaves({account:{id:ids[2]},db:sql})).saves.length, 1);
  assert.equal((await listSaves({account:{id:ids[0]},db:sql})).saves.length, 0);
});

test('host succession moves forward after the original host rejoins', async () => {
  const gameId = await activeMatch(4);
  await connect(gameId,0,'disconnect');
  await connect(gameId,0);
  assert.equal((await connect(gameId,1,'disconnect')).match.hostAccountId,ids[2]);
});

test('social snapshots distinguish current games and do not expose saved guest seats as joinable', async () => {
  const gameId = await activeMatch(); await pause(gameId);
  await sql`INSERT INTO account_sessions (token_hash,account_id,expires_at) VALUES (${'test-session'},${ids[0]},${new Date(realNow()+3600000).toISOString()})`;
  const res = { setHeader(){}, status(code){this.code=code;return this;}, json(body){this.body=body;return this;} };
  await snapshotRoute({method:'GET'},res,{currentAccount:async()=>({id:ids[1]}),database:()=>sql});
  assert.equal(res.code,200); assert.equal(res.body.friends[0].joinableGame,null);
  const sent=await sendGameInvitation({account:{id:ids[0]},gameId,inviteeAccountId:ids[1],db:sql}); assert.equal(sent.ok,true);
  await snapshotRoute({method:'GET'},res,{currentAccount:async()=>({id:ids[1]}),database:()=>sql});
  assert.equal(res.body.friends[0].joinableGame.gameId,gameId);
  assert.equal(res.body.invitations[0].boardName,'Classic board');
});
