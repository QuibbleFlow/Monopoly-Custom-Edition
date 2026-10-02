const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { createServerLobbyController } = require('./server-lobby-ui.js');

function makeHarness({ request, isSignedIn = true } = {}) {
  const state = {
    screen: '',
    lobby: null,
    pollIds: [],
    requests: [],
    refreshCount: 0,
    renderCount: 0,
    renderedScreens: [],
    renderedInFlight: [],
  };

  let controller;
  controller = createServerLobbyController({
    request: request || (async (path, options) => {
      state.requests.push({ path, options });
      return { gameId: 'game-123', game: { status: 'WAITING' }, players: [] };
    }),
    isSignedIn: () => isSignedIn,
    setScreen: screen => { state.screen = screen; },
    setLobby: lobby => { state.lobby = lobby; },
    startPolling: gameId => { state.pollIds.push(gameId); },
    refreshMyGames: async () => { state.refreshCount++; },
    render: () => {
      state.renderCount++;
      state.renderedScreens.push(state.screen);
      state.renderedInFlight.push(controller.inFlight);
    },
  });

  return { state, controller };
}

test('creating a server game stores its returned ID, enters the lobby, and starts polling', async () => {
  const { state, controller } = makeHarness();

  assert.equal(await controller.create('board-9'), true);
  assert.equal(state.requests[0].path, '/api/game/create');
  assert.equal(state.requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(state.requests[0].options.body), { selectedBoardId: 'board-9', inviteOnly: true });
  assert.equal(state.lobby.gameId, 'game-123');
  assert.equal(state.screen, 'serverLobby');
  assert.ok(state.renderedScreens.includes('serverLobby'));
  assert.deepEqual(state.pollIds, ['game-123']);
  assert.equal(state.refreshCount, 1);
  assert.equal(controller.inFlight, false);
});

test('the Join game action opens the server join screen', () => {
  const { state, controller } = makeHarness();

  controller.openJoin();

  assert.equal(state.screen, 'serverJoin');
  assert.equal(state.renderCount, 1);
});

test('the page dispatches server screens and renders a game ID input for joining', () => {
  const html = fs.readFileSync('index.html', 'utf8');

  assert.match(html, /setup\.screen === 'serverJoin'\) \{ renderServerJoinSetup\(\); return; \}/);
  assert.match(html, /setup\.screen === 'serverLobby'\) \{ renderServerLobbySetup\(\); return; \}/);
  assert.match(html, /id="serverGameId"/);
  assert.match(html, /onclick="backendJoinGame\(document\.getElementById\('serverGameId'\)\.value\)"/);
  assert.match(html, /onclick="openServerJoin\(\)"/);
});

test('server UI uses invitation cards, host Delete confirmation, and host Save & Quit', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  const menu = fs.readFileSync('multiplayer-ui.js', 'utf8');

  assert.match(html, /function incomingGameInvitationsHTML\(\)/);
  assert.match(html, /backendRespondToInvitation\('\$\{esc\(invitation\.invitationId\)\}','accept'\)/);
  assert.match(html, /game\.isHost \? `<button class="btn alt" onclick="backendRenameGame/);
  assert.match(html, /onclick="backendDeleteGame\('\$\{esc\(lobby.gameId\)\}'\)">Delete<\/button>/);
  assert.match(html, /appConfirm\(\s*'Delete this server game/);
  assert.match(menu, /backendIsHostOfCurrentGame\(\)/);
  assert.match(menu, /onclick="closeGameMenu\(\);openSaveGameDialog\(\)"/);
  assert.match(menu, /Save &amp; Quit/);
  assert.match(html, /backendGameRequest\('\/api\/game\/pause'/);
  assert.match(html, /appConfirm\(\s*'Save this match and return everyone to the menu/);
  assert.match(html, /appAlert\(\`Save & Quit failed/);
});

test('joining a server game stores its ID, enters its lobby, and starts polling', async () => {
  const { state, controller } = makeHarness({
    request: async (path, options) => {
      state.requests.push({ path, options });
      return { gameId: JSON.parse(options.body).gameId, game: { status: 'WAITING' }, players: [] };
    },
  });

  assert.equal(await controller.join(' game-456 '), true);
  assert.equal(state.requests[0].path, '/api/game/join');
  assert.deepEqual(JSON.parse(state.requests[0].options.body), { gameId: 'game-456' });
  assert.equal(state.lobby.gameId, 'game-456');
  assert.equal(state.screen, 'serverLobby');
  assert.deepEqual(state.pollIds, ['game-456']);
});

test('failed create and join requests show their error and restore the request state', async () => {
  for (const action of ['create', 'join']) {
    const { state, controller } = makeHarness({
      request: async (path, options) => {
        state.requests.push({ path, options });
        throw new Error('Request rejected by server.');
      },
    });

    const succeeded = action === 'create'
      ? await controller.create()
      : await controller.join('game-789');

    assert.equal(succeeded, false);
    assert.equal(controller.error, 'Request rejected by server.');
    assert.equal(controller.inFlight, false);
    assert.equal(state.screen, action === 'create' ? 'serverLobby' : 'serverJoin');
    assert.ok(state.renderCount >= 2);
    assert.equal(state.renderedInFlight.at(-1), false);
  }
});

test('duplicate create clicks issue only one request while the first is pending', async () => {
  let resolveRequest;
  const { state, controller } = makeHarness({
    request: (path, options) => {
      state.requests.push({ path, options });
      return new Promise(resolve => { resolveRequest = resolve; });
    },
  });

  const firstRequest = controller.create();
  assert.equal(controller.inFlight, true);
  assert.equal(await controller.create(), false);
  assert.equal(state.requests.length, 1);

  resolveRequest({ gameId: 'game-321', game: {}, players: [] });
  assert.equal(await firstRequest, true);
  assert.equal(controller.inFlight, false);
  assert.deepEqual(state.pollIds, ['game-321']);
});

test('malformed successful responses show an actionable error instead of hiding the lobby', async () => {
  const { state, controller } = makeHarness({
    request: async () => ({ ok: true, game: { id: 'game-no-top-level-id' } }),
  });

  assert.equal(await controller.create(), false);
  assert.match(controller.error, /did not include a game ID/);
  assert.equal(controller.inFlight, false);
  assert.equal(state.lobby, null);
  assert.deepEqual(state.pollIds, []);
});
