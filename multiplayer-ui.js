let reconnectMatch = null;
let reconnectScreenBusy = false;
let reconnectScreenError = '';
let reconnectServerOffset = 0;
let reconnectRefreshTimer = null;
let matchHeartbeatTimer = null;
let matchHeartbeatBusy = false;
let matchHeartbeatStart = null;
let reconnectDiscovery = null;
let matchSessionGameId = null;
let matchHeartbeatGeneration = 0;
const matchTabSession = crypto.randomUUID();
let gameMenuPreviousFocus = null;

function stopMatchHeartbeat() {
  matchHeartbeatGeneration += 1;
  clearInterval(matchHeartbeatTimer);
  matchHeartbeatTimer = null;
  matchSessionGameId = null;
}

async function startMatchHeartbeat(gameId) {
  if (matchSessionGameId === gameId) return;
  if (matchHeartbeatStart) return matchHeartbeatStart;
  stopMatchHeartbeat();
  const generation = matchHeartbeatGeneration;
  matchHeartbeatStart = backendGameRequest('/api/game/connection', { method: 'POST', body: JSON.stringify({
    gameId, action: 'rejoin', sessionId: matchTabSession,
  }) });
  try { await matchHeartbeatStart; } finally { matchHeartbeatStart = null; }
  if (generation !== matchHeartbeatGeneration) return;
  matchSessionGameId = gameId;
  matchHeartbeatTimer = setInterval(async () => {
    if (matchHeartbeatBusy || matchSessionGameId !== gameId) return;
    matchHeartbeatBusy = true;
    try {
      await backendGameRequest('/api/game/connection', { method: 'POST', body: JSON.stringify({
        gameId, action: 'heartbeat', sessionId: matchTabSession,
      }) });
    } catch (error) {
      if (['RECONNECT_REQUIRED', 'RECONNECT_EXPIRED', 'GAME_NOT_ACTIVE'].includes(error.code)) await discoverReconnectMatch(true);
    } finally { matchHeartbeatBusy = false; }
  }, 10000);
}

async function discoverReconnectMatch(force = false) {
  if (!accountUser || (!force && matchSessionGameId)) return;
  if (reconnectDiscovery) return reconnectDiscovery;
  reconnectDiscovery = fetchReconnectMatch(force).finally(() => { reconnectDiscovery = null; });
  return reconnectDiscovery;
}

async function fetchReconnectMatch(force) {
  try {
    const result = await backendGameRequest('/api/game/connection');
    const match = result.matches?.[0];
    if (match) await showReconnectScreen(match);
    else if (reconnectMatch || force) {
      await clearActiveMatchUi();
      reconnectMatch = null;
      clearInterval(reconnectRefreshTimer);
      reconnectRefreshTimer = null;
      document.body.classList.remove('reconnect-priority');
      setup.screen = 'serverCreate'; serverCreateTab = 'continue';
      backendSocialError = 'Your match ended or your reconnect window expired.';
      await refreshBackendMyGames(); renderSetup();
    }
  } catch (error) {
    if (reconnectMatch) { reconnectScreenError = error.message; renderReconnectScreen(); }
  }
}

async function clearActiveMatchUi() {
  closeGameMenu();
  closeCornerMenu(false);
  stopMatchHeartbeat();
  stopBackendLobbyPolling();
  stopGameTick();
  await window.authoritativeGame?.clearAuthoritativeState();
  game = null; busy = false; popup = null;
  authoritativeAppliedGameId = null;
  backendLobby = null;
}

async function showReconnectScreen(match) {
  const isNew = reconnectMatch?.gameId !== match.gameId;
  if (isNew) await clearActiveMatchUi();
  reconnectMatch = match;
  reconnectServerOffset = Number(match.serverTime || Date.now()) - Date.now();
  if (isNew) reconnectScreenError = '';
  renderReconnectScreen();
  let ticks = 0;
  if (!reconnectRefreshTimer) reconnectRefreshTimer = setInterval(() => {
    updateReconnectCountdown();
    if (!reconnectScreenBusy && ++ticks % 5 === 0) discoverReconnectMatch();
  }, 1000);
}

function renderReconnectScreen() {
  if (!reconnectMatch) return;
  const match = reconnectMatch;
  $('app').innerHTML = `<main class="reconnect-screen"><section class="panel reconnect-card" aria-labelledby="reconnectTitle">
    <span class="menu-eyebrow">MULTIPLAYER</span><h1 id="reconnectTitle">Your match is still active.</h1>
    <p class="muted">Your seat and everything you own are reserved.</p>
    <div class="reconnect-board"><span>Current board</span><strong>${esc(match.boardName)}</strong></div>
    <div class="reconnect-players">${match.players.map(player => `<div class="social-row">${socialAvatar({ username: player.username, avatar_url: player.avatarUrl })}<span class="social-name">${esc(player.username)}<small class="friend-presence">${player.accountId === match.hostAccountId ? 'Host · ' : ''}${player.status === 'reconnecting' ? 'Reconnecting…' : 'Connected'}</small></span></div>`).join('')}</div>
    <p id="reconnectCountdown" class="reconnect-countdown" role="timer"></p>
    <div class="reconnect-actions"><button class="btn" type="button" onclick="rejoinActiveMatch()" ${reconnectScreenBusy ? 'disabled' : ''}>${reconnectScreenBusy ? 'Working…' : 'Rejoin Match'}</button>
      <button class="btn alt danger" type="button" onclick="leaveActiveMatchPermanently()" ${reconnectScreenBusy ? 'disabled' : ''}>Leave Match</button></div>
    ${reconnectScreenError ? `<p class="error" role="alert">${esc(reconnectScreenError)}</p>` : ''}
  </section></main>`;
  document.body.classList.add('reconnect-priority');
  updateReconnectCountdown();
}

function updateReconnectCountdown() {
  const element = $('reconnectCountdown');
  if (!element || !reconnectMatch) return;
  const seconds = Math.max(0, Math.ceil((reconnectMatch.reconnectUntil - Date.now() - reconnectServerOffset) / 1000));
  element.textContent = seconds ? `${seconds}s to reconnect` : 'Checking your reserved seat…';
  if (!seconds && !reconnectScreenBusy) discoverReconnectMatch();
}

async function rejoinActiveMatch() {
  if (!reconnectMatch || reconnectScreenBusy) return;
  const gameId = reconnectMatch.gameId;
  reconnectScreenBusy = true; renderReconnectScreen();
  try {
    await startMatchHeartbeat(gameId);
    reconnectMatch = null;
    clearInterval(reconnectRefreshTimer); reconnectRefreshTimer = null;
    document.body.classList.remove('reconnect-priority');
    await backendOpenGame(gameId);
    if (!window.authoritativeGame?.state) throw new Error('The board could not be loaded. Try rejoining again.');
  } catch (error) {
    reconnectScreenError = error.message;
    stopMatchHeartbeat();
    await discoverReconnectMatch(true);
  } finally { reconnectScreenBusy = false; if (reconnectMatch) renderReconnectScreen(); }
}

async function leaveActiveMatchPermanently() {
  if (!reconnectMatch || reconnectScreenBusy) return;
  const confirmed = await appConfirm('Leave permanently? Your properties return to the bank and your seat will be removed.', 'Leave Match?', 'Leave Match');
  if (!confirmed) return;
  reconnectScreenBusy = true; renderReconnectScreen();
  try {
    await backendGameRequest('/api/game/connection', { method: 'POST', body: JSON.stringify({ gameId: reconnectMatch.gameId, action: 'leave' }) });
    reconnectMatch = null;
    clearInterval(reconnectRefreshTimer); reconnectRefreshTimer = null;
    document.body.classList.remove('reconnect-priority');
    setup.screen = 'serverCreate'; serverCreateTab = 'continue';
    backendSocialError = 'You left the match.';
    await refreshBackendMyGames(); renderSetup();
  } catch (error) { reconnectScreenError = error.message; }
  finally { reconnectScreenBusy = false; if (reconnectMatch) renderReconnectScreen(); }
}

async function abandonActiveMatch() {
  const gameId = window.authoritativeGame?.gameId;
  if (!gameId || reconnectScreenBusy) return;
  closeGameMenu();
  const confirmed = await appConfirm('Leaving starts a 120-second reconnect window. Your seat and belongings stay reserved. If you do not return before it expires, you will be removed. Host permissions pass to the next connected player.', 'Abandon Match?', 'Abandon Match');
  if (!confirmed) return;
  reconnectScreenBusy = true;
  try {
    const result = await backendGameRequest('/api/game/connection', { method: 'POST', body: JSON.stringify({ gameId, action: 'disconnect', sessionId: matchTabSession }) });
    if (result.match) await showReconnectScreen(result.match);
    else await discoverReconnectMatch(true);
  } catch (error) { await appAlert(error.message, 'Unable to leave'); }
  finally { reconnectScreenBusy = false; if (reconnectMatch) renderReconnectScreen(); }
}

window.addEventListener('pagehide', () => {
  if (!matchSessionGameId) return;
  navigator.sendBeacon('/api/game/connection', new Blob([JSON.stringify({
    gameId: matchSessionGameId, action: 'disconnect', sessionId: matchTabSession,
  })], { type: 'application/json' }));
  stopMatchHeartbeat();
});
window.addEventListener('pageshow', event => { if (event.persisted && accountUser) discoverReconnectMatch(true); });
window.addEventListener('online', () => window.authoritativeGame?.pollNow?.());

function closeGameMenu() {
  const menu = $('gameMenuOverlay');
  if (menu) menu.remove();
  gameMenuPreviousFocus?.focus?.();
}

function openGameMenu() {
  if ($('gameMenuOverlay')) { closeGameMenu(); return; }
  gameMenuPreviousFocus = document.activeElement;
  closeCornerMenu(false);
  const overlay = document.createElement('div');
  overlay.id = 'gameMenuOverlay'; overlay.className = 'scrim game-menu-overlay';
  overlay.dataset.controllerContext = 'game-menu';
  overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'gameMenuTitle');
  overlay.innerHTML = `<section class="dialog game-menu-card"><h2 id="gameMenuTitle">Game Menu</h2><div class="game-menu-actions">
    <button class="btn" onclick="closeGameMenu()">▶ Resume</button>
    <button class="btn alt" onclick="showGamePlayers()">♟ Players</button>
    <button class="btn alt" onclick="closeGameMenu();openFriendsScreen()">♧ Friends</button>
    <button class="btn alt" onclick="closeGameMenu();openGameSettings()">⚙ Settings</button>
    ${!isBackendAuthoritativeGame() ? `<button class="btn alt" onclick="closeGameMenu();act('hostSetPause',${!game?.paused},Date.now())">${game?.paused ? 'Resume game clock' : 'Pause game clock'}</button>` : ''}
    </div>${backendIsHostOfCurrentGame() ? `<div class="game-menu-secondary"><button class="btn alt" onclick="closeGameMenu();openSaveGameDialog()" ${saveGameInFlight ? 'disabled' : ''}>Save &amp; Quit</button><p class="muted">2 save slots. A third save replaces your oldest.</p></div>` : ''}
    ${isBackendAuthoritativeGame() ? '<div class="game-menu-destructive"><button class="btn alt danger" onclick="abandonActiveMatch()">Abandon Match</button></div>' : ''}</section>`;
  document.body.appendChild(overlay);
  overlay.querySelector('button').focus();
}

function showGamePlayers() {
  const panel = document.querySelector('#gameMenuOverlay .dialog');
  if (!panel || !game) return;
  panel.innerHTML = `<h2>Players</h2><div class="social-list">${game.players.filter(player => !player.removed).map(player => {
    const presence = window.authoritativeGame?.presence?.players.find(item => item.accountId === player.accountId);
    const label = player.bankrupt ? 'Bankrupt' : presence?.status === 'reconnecting' ? 'Reconnecting…' : 'Connected';
    return `<div class="social-row">${socialAvatar({ username: player.name, avatar_url: playerAvatarUrl(player) })}<span class="social-name">${esc(player.name)}<small class="friend-presence">${window.authoritativeGame?.hostAccountId === player.accountId ? 'Host · ' : ''}${label}</small></span><strong>${fmt(player.money)}</strong></div>`;
  }).join('')}</div><button class="btn alt" onclick="closeGameMenu();openGameMenu()">Back</button>`;
}

function controllerSettingsHTML() {
  const prefs = window.MonopolyControllerSupport?.getPreferences() || { sensitivity: 1.2, deadzone: .18 };
  return `<fieldset class="controller-settings"><legend>Controller</legend>
    <label for="controllerSensitivity">Cursor sensitivity<input id="controllerSensitivity" type="range" min="0.4" max="2.5" step="0.1" value="${prefs.sensitivity}" oninput="setControllerPreference('sensitivity',Number(this.value))"></label>
    <label for="controllerDeadzone">Stick deadzone<input id="controllerDeadzone" type="range" min="0.1" max="0.4" step="0.01" value="${prefs.deadzone}" oninput="setControllerPreference('deadzone',Number(this.value))"></label>
    <p class="muted">Controls switch automatically. The main board and browsing menus use a cursor. Follow the shown shortcuts to roll, end your turn, click the cursor or open menus. Property controls, dialogs and typing use highlighted buttons. Connected controllers show shortcuts beside each action.</p></fieldset>`;
}

function setControllerPreference(key, value) {
  const controller = window.MonopolyControllerSupport;
  if (!controller) return;
  controller.configure({ [key]: value });
  queueAccountSettings({ controllerPreferences: controller.getPreferences() });
}

function openGameSettings() {
  const overlay = document.createElement('div');
  overlay.id = 'gameMenuOverlay'; overlay.className = 'scrim game-menu-overlay';
  overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-label', 'Settings');
  overlay.innerHTML = `<section class="dialog game-menu-card"><h2>Settings</h2><div class="account-preferences">
    <label>Music volume<input type="range" min="0" max="100" value="${Math.round(musicVolume * 100)}" oninput="setMusicVolume(this.value)"></label>
    <label>Effects volume<input type="range" min="0" max="100" value="${Math.round(soundEffectsVolume * 100)}" oninput="setSoundEffectsVolume(this.value)"></label>
    <label>Game sounds<input type="checkbox" ${soundOn ? 'checked' : ''} onchange="setAccountSound(this.checked)"></label></div>
    ${controllerSettingsHTML()}<button class="btn alt" onclick="closeGameMenu()">Close</button></section>`;
  document.body.appendChild(overlay); overlay.querySelector('select,button').focus();
}

document.addEventListener('keydown', event => {
  const overlay = $('gameMenuOverlay');
  if (!overlay) return;
  if (event.key === 'Escape') { event.preventDefault(); closeGameMenu(); }
  if (event.key === 'Tab') {
    const items = [...overlay.querySelectorAll('button,input,select')].filter(item => !item.disabled);
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});

function updateMatchConnectionUi(snapshot = window.authoritativeGame?.getAuthoritativeState()) {
  const element = $('matchConnectionStatus');
  if (!element) return;
  const status = snapshot?.connectionStatus || 'connected';
  const labels = { connected: 'Connected', reconnecting: 'Reconnecting…', disconnected: 'Disconnected', failed: 'Connection failed' };
  element.textContent = snapshot?.presence?.waitingFor ? `Waiting for ${snapshot.presence.waitingFor} to reconnect` : labels[status];
  element.dataset.status = status;
}

async function renameSavedMatch(saveId) {
  const save = backendSaves.find(save => save.saveId === saveId);
  if (!save) return;
  const name = await appPrompt('Choose a save name.', save.name, 'Rename save', 80);
  if (!name?.trim()) return;
  try {
    await backendGameRequest('/api/game/saves', { method: 'PATCH', body: JSON.stringify({ saveId, name: name.trim() }) });
    await refreshBackendSaves(); renderSetup();
  } catch (error) { await appAlert(error.message, 'Unable to rename save'); }
}

async function backendInviteRemainingPlayers(gameId) {
  if (!backendLobby || backendLobby.gameId !== gameId || cornerSocialActionPending) return;
  cornerSocialActionPending = true; renderSetup();
  try {
    const missing = backendLobby.players.filter(player => player.accountId !== accountUser.id && !player.returnedAt);
    for (const player of missing) {
      try {
        await backendGameRequest('/api/game/invitations', { method:'POST', body:JSON.stringify({ gameId, inviteeAccountId:player.accountId }) });
      } catch (error) { if (error.code !== 'INVITATION_EXISTS') throw error; }
    }
    socialSnapshotCache = null;
    await refreshBackendSocial();
    backendSocialError = 'Invitations sent to the remaining players.';
  } catch (error) { backendSocialError = error.message; }
  finally { cornerSocialActionPending = false; renderSetup(); }
}

async function deleteSavedMatch(saveId) {
  if (!await appConfirm('Delete this save file? This cannot be undone.', 'Delete save?', 'Delete')) return;
  try {
    await backendGameRequest('/api/game/saves', { method: 'DELETE', body: JSON.stringify({ saveId }) });
    await refreshBackendSaves(); renderSetup();
  } catch (error) { await appAlert(error.message, 'Unable to delete save'); }
}

window.authoritativeGame?.subscribeConnection(async snapshot => {
  updateMatchConnectionUi(snapshot);
  if (snapshot.connection === 'reconnecting' || snapshot.connectionStatus === 'failed') await discoverReconnectMatch(true);
});
