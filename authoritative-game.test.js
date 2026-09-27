const assert = require('node:assert/strict');
const test = require('node:test');

const createAuthoritativeGame = require('./authoritative-game.js');

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function gameState(version, overrides = {}) {
  return {
    gameId: 'game-1',
    version,
    status: 'ACTIVE',
    state: { current: 0, dice: [0, 0], players: [], ...overrides },
    events: [],
  };
}

test('authoritative state accepts newer versions and ignores equal or older versions', async () => {
  const manager = createAuthoritativeGame({ fetch: async () => response({}) });
  const seen = [];
  manager.subscribe(snapshot => seen.push(snapshot.version));

  assert.equal(await manager.setAuthoritativeState(gameState(1)), true);
  assert.equal(await manager.applyAuthoritativeState(gameState(2)), true);
  assert.equal(await manager.applyAuthoritativeState(gameState(2, { dice: [1, 2] })), false);
  assert.equal(await manager.applyAuthoritativeState(gameState(1)), false);
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(manager.state.dice, [0, 0]);
});

test('PeerJS snapshots preserve authoritative roll fields but retain unrelated legacy state', async () => {
  const manager = createAuthoritativeGame({ fetch: async () => response({}) });
  await manager.setAuthoritativeState(gameState(3, {
    current: 1,
    turn: 4,
    phase: 'roll',
    dice: [4, 6],
    doubles: 0,
    rolledDouble: false,
    pendingMove: { playerId: 1, steps: 10, direction: 1, source: 'dice' },
    landingPending: false,
    players: [{ id: 0, pos: 0, money: 1500 }, { id: 1, pos: 10, money: 1300 }],
  }));

  const peerState = {
    current: 0,
    turn: 3,
    phase: 'after',
    dice: [1, 1],
    doubles: 1,
    rolledDouble: true,
    pendingMove: { playerId: 1, steps: 2, direction: 1, source: 'dice' },
    landingPending: true,
    players: [{ id: 0, pos: 8, money: 900 }, { id: 1, pos: 12, money: 800 }],
  };
  const merged = manager.preserveAuthoritativeTurnState(peerState);

  assert.equal(merged.current, 1);
  assert.equal(merged.turn, 4);
  assert.equal(merged.phase, 'roll');
  assert.deepEqual(merged.dice, [4, 6]);
  assert.equal(merged.doubles, 0);
  assert.equal(merged.rolledDouble, false);
  assert.deepEqual(merged.pendingMove, { playerId: 1, steps: 10, direction: 1, source: 'dice' });
  assert.equal(merged.landingPending, false);
  assert.equal(merged.players[0].pos, 0);
  assert.equal(merged.players[0].money, 1500);
  assert.equal(merged.players[1].pos, 10);
  assert.equal(merged.players[1].money, 1300);
  assert.equal(manager.version, 3);
});

test('action client generates a request ID and sends only the action contract', async () => {
  const requests = [];
  const manager = createAuthoritativeGame({
    crypto: { randomUUID: () => 'request-generated' },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return response({ gameId: 'game-1', version: 2, state: { dice: [3, 5] }, events: [] });
    },
  });
  await manager.setAuthoritativeState(gameState(1));

  const result = await manager.submitGameAction({
    gameId: 'game-1', expectedVersion: 1, action: { type: 'ROLL_DICE' },
  });

  assert.equal(result.requestId, 'request-generated');
  assert.equal(requests[0].url, '/api/game/action');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    gameId: 'game-1', requestId: 'request-generated', version: 1, action: { type: 'ROLL_DICE' },
  });
  assert.equal(manager.version, 2);
  assert.deepEqual(manager.state.dice, [3, 5]);
});

test('retry with the same request ID applies an idempotent response only once', async () => {
  const requestIds = [];
  const manager = createAuthoritativeGame({
    fetch: async (url, options) => {
      requestIds.push(JSON.parse(options.body).requestId);
      return response({ gameId: 'game-1', version: 2, state: { dice: [4, 6] }, events: [] });
    },
  });
  await manager.setAuthoritativeState(gameState(1));
  let updates = 0;
  manager.subscribe(() => { updates += 1; });

  await manager.submitGameAction({ gameId: 'game-1', expectedVersion: 1, requestId: 'retry-me', action: { type: 'ROLL_DICE' } });
  await manager.submitGameAction({ gameId: 'game-1', expectedVersion: 1, requestId: 'retry-me', action: { type: 'ROLL_DICE' } });

  assert.deepEqual(requestIds, ['retry-me', 'retry-me']);
  assert.equal(updates, 1);
  assert.equal(manager.version, 2);
});

test('stale version refreshes state without automatically resubmitting the action', async () => {
  const requests = [];
  const manager = createAuthoritativeGame({
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (options.method === 'POST') return response({ error: { code: 'STALE_VERSION', message: 'stale' } }, 409);
      return response(gameState(2, { dice: [2, 6] }));
    },
  });
  await manager.setAuthoritativeState(gameState(1));

  await assert.rejects(
    manager.submitGameAction({ gameId: 'game-1', expectedVersion: 1, requestId: 'stale-roll', action: { type: 'ROLL_DICE' } }),
    error => error.code === 'STALE_VERSION' && error.requestId === 'stale-roll',
  );

  assert.equal(requests.filter(request => request.options.method === 'POST').length, 1);
  assert.equal(requests.filter(request => !request.options.method).length, 1);
  assert.equal(manager.version, 2);
  assert.deepEqual(manager.state.dice, [2, 6]);
});

test('network retries can reuse the same request ID and do not invent a result', async () => {
  const requestIds = [];
  let shouldFail = true;
  const manager = createAuthoritativeGame({
    fetch: async (url, options) => {
      requestIds.push(JSON.parse(options.body).requestId);
      if (shouldFail) {
        shouldFail = false;
        throw new Error('offline');
      }
      return response({ gameId: 'game-1', version: 2, state: { dice: [1, 5] }, events: [] });
    },
  });
  await manager.setAuthoritativeState(gameState(1));

  await assert.rejects(
    manager.submitGameAction({ gameId: 'game-1', expectedVersion: 1, requestId: 'same-roll', action: { type: 'ROLL_DICE' } }),
    error => error.code === 'NETWORK_ERROR' && error.requestId === 'same-roll',
  );
  assert.equal(manager.version, 1);
  await manager.submitGameAction({ gameId: 'game-1', expectedVersion: 1, requestId: 'same-roll', action: { type: 'ROLL_DICE' } });

  assert.deepEqual(requestIds, ['same-roll', 'same-roll']);
  assert.equal(manager.version, 2);
});

test('polling is unique per game and skips overlapping requests', async () => {
  const timers = [];
  let resolvePoll;
  let stateRequests = 0;
  const document = {
    visibilityState: 'visible',
    listeners: new Map(),
    addEventListener(name, callback) { this.listeners.set(name, callback); },
    removeEventListener(name) { this.listeners.delete(name); },
  };
  const manager = createAuthoritativeGame({
    pollInterval: 2500,
    setTimeout(callback, delay) { const timer = { callback, delay, cleared: false }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
    root: { document },
    fetch: async url => {
      if (url.startsWith('/api/game/action')) return response({});
      stateRequests += 1;
      return new Promise(resolve => { resolvePoll = resolve; });
    },
  });
  await manager.setAuthoritativeState(gameState(1));
  manager.startPolling('game-1');
  manager.startPolling('game-1');
  assert.equal(timers.filter(timer => !timer.cleared).length, 1);

  const firstTimer = timers.find(timer => !timer.cleared);
  const firstPoll = firstTimer.callback();
  await Promise.resolve();
  manager.pollNow();
  const overlapTimer = timers.findLast(timer => !timer.cleared);
  await overlapTimer.callback();
  assert.equal(stateRequests, 1);

  resolvePoll(response(gameState(2)));
  await firstPoll;
  manager.stopPolling();
  assert.equal(document.listeners.has('visibilitychange'), false);
});