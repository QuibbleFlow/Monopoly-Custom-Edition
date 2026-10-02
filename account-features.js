const CUSTOM_SPACE_IDS = new Set(Array.from({ length: 40 }, (_, index) => index));
const friendsScreenState = { friends: [], requests: [], results: [], status: '', query: '' };
const boardsScreenState = { boards: [], friends: [], status: '', editor: null, sharingBoardId: null, selectingForHost: false };
let accountPresenceTimer = null;
let friendsRefreshTimer = null;
let accountNotificationTimer = null;
let accountNotificationPollInFlight = false;
const seenFriendRequestNotifications = new Set();
const seenGameInvitationNotifications = new Set();
let cornerMenu = null;
let cornerInviteGameId = '';
let cornerSocialActionPending = false;

function ensureCornerMenus() {
  let root = document.getElementById('cornerAccountMenus');
  if (!root) {
    root = document.createElement('div');
    root.id = 'cornerAccountMenus';
    root.innerHTML = `<div class="account-corner-buttons">
      <button id="cornerFriendsButton" class="btn alt" type="button" aria-haspopup="dialog" aria-controls="cornerAccountDialog" aria-expanded="false" onclick="toggleCornerMenu('friends')">Friends</button>
      <button id="cornerProfileButton" class="btn alt profile-corner-button" type="button" aria-haspopup="dialog" aria-controls="cornerAccountDialog" aria-expanded="false" onclick="toggleCornerMenu('profile')">Profile</button>
    </div><div id="cornerAccountBackdrop" class="account-menu-backdrop" hidden onclick="closeCornerMenu()"></div>
    <section id="cornerAccountDialog" class="account-corner-dialog setup" role="dialog" aria-modal="true" aria-labelledby="cornerAccountTitle" hidden>
      <header class="account-menu-heading"><h2 id="cornerAccountTitle"></h2><button class="btn alt" type="button" onclick="closeCornerMenu()" aria-label="Close menu">×</button></header>
      <div id="cornerAccountContent"></div>
    </section>`;
    document.body.appendChild(root);
    document.body.classList.add('has-account-corner');
  }
  const profile = document.getElementById('cornerProfileButton');
  const initial = (accountUser?.username || '?').slice(0, 1).toUpperCase();
  const avatar = accountUser?.avatar_url
    ? `<img class="corner-profile-avatar" src="${esc(accountUser.avatar_url)}" alt="">`
    : `<span class="corner-profile-avatar" aria-hidden="true">${esc(initial)}</span>`;
  const markup = `${avatar}<span>Profile</span>`;
  if (profile.innerHTML !== markup) profile.innerHTML = markup;
  profile.title = accountUser ? `${accountUser.username}'s profile` : 'Sign in or create an account';
  profile.setAttribute('aria-expanded', String(cornerMenu === 'profile'));
  const friends = document.getElementById('cornerFriendsButton');
  const pending = friendsScreenState.requests.filter(item => item.direction === 'incoming').length + backendGameInvitations.filter(item => item.direction === 'incoming').length;
  const friendMarkup = `Friends${accountUser && pending ? `<span class="corner-count">${pending}</span>` : ''}`;
  if (friends.innerHTML !== friendMarkup) friends.innerHTML = friendMarkup;
  friends.setAttribute('aria-expanded', String(cornerMenu === 'friends'));
}

function closeCornerMenu(restoreFocus = true) {
  const previous = cornerMenu;
  cornerMenu = null;
  clearInterval(friendsRefreshTimer);
  friendsRefreshTimer = null;
  const dialog = document.getElementById('cornerAccountDialog');
  if (dialog) dialog.hidden = true;
  const backdrop = document.getElementById('cornerAccountBackdrop');
  if (backdrop) backdrop.hidden = true;
  ensureCornerMenus();
  if (restoreFocus && previous) document.getElementById(previous === 'profile' ? 'cornerProfileButton' : 'cornerFriendsButton')?.focus();
}

function toggleCornerMenu(menu) {
  if (cornerMenu === menu) { closeCornerMenu(); return; }
  clearInterval(friendsRefreshTimer);
  cornerMenu = menu;
  ensureCornerMenus();
  const dialog = document.getElementById('cornerAccountDialog');
  dialog.hidden = false;
  document.getElementById('cornerAccountBackdrop').hidden = false;
  document.getElementById('cornerAccountTitle').textContent = menu === 'profile' ? 'Your profile' : 'Your friends';
  if (menu === 'profile') renderCornerProfile();
  else {
    renderFriendsScreen();
    if (accountUser) {
      loadFriendsScreen();
      refreshBackendMyGames().then(() => { if (cornerMenu === 'friends') renderFriendsScreen(); });
      if (!accountNotificationTimer) friendsRefreshTimer = setInterval(() => {
        if (cornerMenu === 'friends' && document.visibilityState !== 'hidden') loadFriendsScreen();
      }, 3000);
    }
  }
  dialog.querySelector('button, input, select')?.focus();
}

function renderCornerProfile() {
  if (cornerMenu === 'profile') document.getElementById('cornerAccountContent').innerHTML = accountPanelHTML();
}

function refreshAccountUi() {
  ensureCornerMenus();
  if (cornerMenu === 'profile') renderCornerProfile();
  if (cornerMenu === 'friends') renderFriendsScreen();
  if (!document.getElementById('plane')) renderSetup();
}

document.addEventListener('keydown', event => {
  if (!cornerMenu) return;
  if (event.key === 'Escape') { event.preventDefault(); closeCornerMenu(); return; }
  if (event.key !== 'Tab') return;
  const dialog = document.getElementById('cornerAccountDialog');
  const items = [...dialog.querySelectorAll('button, input, select, a[href], [tabindex="0"]')].filter(item => !item.disabled && !item.hidden && item.getClientRects().length);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
    event.preventDefault(); last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
    event.preventDefault(); first.focus();
  }
});

function cornerInviteGames() {
  const games = backendMyGames.filter(item => item.hostAccountId === accountUser?.id && item.status === 'WAITING' && !item.resumeSaveId);
  if (backendLobby?.game?.hostAccountId === accountUser?.id && backendLobby.game.status === 'WAITING' && !backendLobby.game.resumeSaveId && !games.some(item => (item.gameId || item.id) === backendLobby.gameId)) {
    games.unshift({ ...backendLobby.game, gameId: backendLobby.gameId });
  }
  return games;
}

async function cornerInviteFriend(friendId) {
  if (cornerSocialActionPending || !cornerInviteGameId) return;
  cornerSocialActionPending = true;
  renderFriendsScreen();
  try {
    await backendGameRequest('/api/game/invitations', { method: 'POST', body: JSON.stringify({ gameId: cornerInviteGameId, inviteeAccountId: friendId }) });
    await loadFriendsScreen();
    friendsScreenState.status = 'Invitation sent.';
  } catch (error) { friendsScreenState.status = error.message; }
  finally { cornerSocialActionPending = false; renderFriendsScreen(); }
}

async function cornerJoinFriend(friendId) {
  if (document.getElementById('plane')) return;
  const friend = friendsScreenState.friends.find(item => item.id === friendId);
  if (!friend?.joinableGame?.gameId) return;
  closeCornerMenu(false);
  await backendJoinGame(friend.joinableGame.gameId);
}

async function cornerRespondToInvitation(id, action) {
  if (cornerSocialActionPending) return;
  if (action === 'accept') {
    if (document.getElementById('plane')) return;
    closeCornerMenu(false);
    await backendRespondToInvitation(id, action);
    return;
  }
  cornerSocialActionPending = true;
  try {
    await backendGameRequest(`/api/game/invitations/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ action }) });
    await loadFriendsScreen();
  } catch (error) { friendsScreenState.status = error.message; }
  finally { cornerSocialActionPending = false; renderFriendsScreen(); }
}

function startAccountPresence() {
  clearInterval(accountPresenceTimer);
  clearInterval(accountNotificationTimer);
  if (!accountUser) return;
  const heartbeat = () => accountRequest('/api/auth/session').catch(() => {});
  heartbeat();
  accountPresenceTimer = setInterval(heartbeat, 45000);
  pollAccountNotifications();
  accountNotificationTimer = setInterval(pollAccountNotifications, 3000);
}

function stopAccountPresence() {
  clearInterval(accountPresenceTimer);
  clearInterval(accountNotificationTimer);
  accountPresenceTimer = null;
  accountNotificationTimer = null;
  accountNotificationPollInFlight = false;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && accountUser) {
    // Refresh immediately when the player comes back to the tab instead of
    // making them wait for the next background interval.
    pollAccountNotifications();
    if (cornerMenu === 'friends') loadFriendsScreen();
  }
});

function accountNotificationDomId(key) {
  return 'account-notification-' + String(key).replace(/[^A-Za-z0-9_-]/g, '_');
}

function dismissAccountNotification(key) {
  const element = document.getElementById(accountNotificationDomId(key));
  if (element) element.remove();
}

function ensureAccountNotificationTray() {
  let tray = document.getElementById('accountNotificationTray');
  if (tray) return tray;
  tray = document.createElement('div');
  tray.id = 'accountNotificationTray';
  tray.className = 'account-notification-tray';
  tray.setAttribute('aria-live', 'polite');
  tray.setAttribute('aria-label', 'Notifications');
  document.body.appendChild(tray);
  return tray;
}

function showAccountNotification({ key, title, message, actions = [] }) {
  if (!key || document.getElementById(accountNotificationDomId(key))) return;
  const tray = ensureAccountNotificationTray();
  const card = document.createElement('div');
  card.id = accountNotificationDomId(key);
  card.className = 'account-notification';

  const head = document.createElement('div');
  head.className = 'account-notification-head';
  const heading = document.createElement('div');
  heading.className = 'account-notification-title';
  heading.textContent = title;
  const close = document.createElement('button');
  close.className = 'account-notification-close';
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss notification');
  close.textContent = '×';
  close.addEventListener('click', () => dismissAccountNotification(key));
  head.append(heading, close);

  const body = document.createElement('div');
  body.className = 'account-notification-message';
  body.textContent = message;
  card.append(head, body);

  if (actions.length) {
    const actionRow = document.createElement('div');
    actionRow.className = 'account-notification-actions';
    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = action.primary ? 'btn' : 'btn alt';
      button.textContent = action.label;
      button.addEventListener('click', async () => {
        if (button.disabled) return;
        Array.from(actionRow.querySelectorAll('button')).forEach(item => { item.disabled = true; });
        try {
          await action.run();
          dismissAccountNotification(key);
        } catch (error) {
          Array.from(actionRow.querySelectorAll('button')).forEach(item => { item.disabled = false; });
        }
      });
      actionRow.appendChild(button);
    }
    card.appendChild(actionRow);
  }

  tray.prepend(card);
  while (tray.children.length > 4) tray.lastElementChild.remove();
}

async function pollAccountNotifications() {
  if (!accountUser || accountNotificationPollInFlight || document.visibilityState === 'hidden') return;
  accountNotificationPollInFlight = true;
  try {
    const social = await accountRequest('/api/friends/snapshot');
    const friends = Array.isArray(social.friends) ? social.friends : [];
    const requests = Array.isArray(social.requests) ? social.requests : [];
    const invitations = Array.isArray(social.invitations) ? social.invitations : [];

    friendsScreenState.friends = friends;
    friendsScreenState.requests = requests;
    if (typeof backendFriends !== 'undefined') backendFriends = friends;
    if (typeof backendGameInvitations !== 'undefined') backendGameInvitations = invitations;

    ensureCornerMenus();
    if (cornerMenu === 'friends') renderFriendsScreen();

    const activeFriendKeys = new Set(requests.filter(item => item.direction === 'incoming').map(item => 'friend:' + item.id));
    const activeGameKeys = new Set(invitations.filter(item => item.direction === 'incoming').map(item => 'game:' + item.invitationId));
    document.querySelectorAll('.account-notification[id^="account-notification-friend_"]').forEach(element => {
      const raw = element.id.replace('account-notification-', '').replace(/^friend_/, 'friend:');
      if (!activeFriendKeys.has(raw)) element.remove();
    });
    document.querySelectorAll('.account-notification[id^="account-notification-game_"]').forEach(element => {
      const raw = element.id.replace('account-notification-', '').replace(/^game_/, 'game:');
      if (!activeGameKeys.has(raw)) element.remove();
    });

    for (const request of requests.filter(item => item.direction === 'incoming')) {
      const key = 'friend:' + request.id;
      if (seenFriendRequestNotifications.has(key)) continue;
      seenFriendRequestNotifications.add(key);
      showAccountNotification({
        key,
        title: 'Friend request',
        message: `${request.username} sent you a friend request.`,
        actions: [
          { label: 'Accept', primary: true, run: () => decideFriendRequest(request.id, 'accept') },
          { label: 'Decline', run: () => decideFriendRequest(request.id, 'decline') },
        ],
      });
    }

    for (const invitation of invitations.filter(item => item.direction === 'incoming')) {
      const key = 'game:' + invitation.invitationId;
      if (seenGameInvitationNotifications.has(key)) continue;
      seenGameInvitationNotifications.add(key);
      showAccountNotification({
        key,
        title: 'Game invitation',
        message: `${invitation.hostUsername} invited you to join a match (${Number(invitation.playerCount)}/8 players).`,
        actions: [
          { label: 'Accept', primary: true, run: () => backendRespondToInvitation(invitation.invitationId, 'accept') },
          { label: 'Decline', run: () => backendRespondToInvitation(invitation.invitationId, 'decline') },
        ],
      });
    }
  } catch (error) {
    // Notifications are background UX. Existing friends/game screens still
    // surface request errors without spamming the player during gameplay.
  } finally {
    accountNotificationPollInFlight = false;
  }
}

function socialAvatar(user) {
  if (user.avatar_url) return `<img class="social-avatar" src="${esc(user.avatar_url)}" alt="${esc(user.username)} profile picture">`;
  return `<span class="social-avatar" aria-hidden="true" style="display:grid;place-items:center;background:var(--blue);color:#fff;font-weight:800">${esc((user.username || '?').slice(0, 1).toUpperCase())}</span>`;
}

function openFriendsScreen() {
  if (cornerMenu !== 'friends') toggleCornerMenu('friends');
}

function closeFriendsScreen() { closeCornerMenu(); }

async function loadFriendsScreen() {
  const searchInput = document.getElementById('friendSearchInput');
  if (searchInput) friendsScreenState.query = searchInput.value;

  try {
    const social = await accountRequest('/api/friends/snapshot');
    friendsScreenState.friends = social.friends || [];
    friendsScreenState.requests = social.requests || [];
    if (typeof backendFriends !== 'undefined') backendFriends = social.friends || [];
    if (typeof backendGameInvitations !== 'undefined') backendGameInvitations = social.invitations || [];
    friendsScreenState.status = '';
  } catch (error) {
    friendsScreenState.status = error.message;
  }

  ensureCornerMenus();
  if (cornerMenu === 'friends') renderFriendsScreen();
}

function setCornerSection(id, markup) {
  const section = document.getElementById(id);
  if (section && section.innerHTML !== markup) section.innerHTML = markup;
}

function renderFriendsScreen() {
  if (cornerMenu !== 'friends') return;
  const content = document.getElementById('cornerAccountContent');
  if (!accountUser) {
    content.innerHTML = `<p class="muted">Sign in to add friends and join their games.</p><button class="btn" type="button" onclick="toggleCornerMenu('profile')">Sign in</button>`;
    return;
  }
  if (!document.getElementById('cornerFriendsContent')) {
    content.innerHTML = `<div id="cornerFriendsContent">
      <div id="cornerFriendInvites"></div>
      <section class="panel acc-green"><h2>Friends</h2><div id="cornerInviteTarget"></div><div id="cornerFriendRows" class="social-list"></div></section>
      <section class="panel acc-blue"><h2>Add a friend</h2><form class="corner-friend-search" onsubmit="searchFriendAccounts(event)">
        <input id="friendSearchInput" type="search" name="query" minlength="2" maxlength="24" value="${esc(friendsScreenState.query)}" placeholder="Username" autocomplete="off" oninput="friendsScreenState.query=this.value" required>
        <button class="btn" type="submit">Search</button></form><div id="cornerFriendResults" class="social-list"></div></section>
      <section class="panel acc-orange"><h2>Friend requests</h2><div id="cornerFriendRequests" class="social-list"></div><details><summary>Sent requests</summary><div id="cornerSentRequests" class="social-list"></div></details></section>
      <p id="cornerFriendsStatus" class="account-status" role="status"></p>
    </div>`;
  }
  const inviteGames = cornerInviteGames();
  if (!inviteGames.some(item => (item.gameId || item.id) === cornerInviteGameId)) {
    cornerInviteGameId = inviteGames.some(item => (item.gameId || item.id) === backendLobby?.gameId)
      ? backendLobby.gameId : (inviteGames[0]?.gameId || inviteGames[0]?.id || '');
  }
  const target = inviteGames.length
    ? `<label class="muted" for="cornerInviteGame">Invite friends to</label><select id="cornerInviteGame" onchange="cornerInviteGameId=this.value;renderFriendsScreen()">${inviteGames.map(item => `<option value="${esc(item.gameId || item.id)}" ${(item.gameId || item.id) === cornerInviteGameId ? 'selected' : ''}>${esc(item.name || 'Your match')}</option>`).join('')}</select>`
    : `<p class="muted">Create a match to invite friends.</p><button class="btn alt" type="button" onclick="closeCornerMenu(false);backendCreateGame()" ${document.getElementById('plane') ? 'disabled' : ''}>Create game</button>`;
  setCornerSection('cornerInviteTarget', target);
  const incoming = friendsScreenState.requests.filter(request => request.direction === 'incoming');
  const outgoing = friendsScreenState.requests.filter(request => request.direction === 'outgoing');
  const playing = !!document.getElementById('plane');
  const friendRows = friendsScreenState.friends.map(friend => {
    const invited = backendGameInvitations.some(item => item.direction === 'outgoing' && item.gameId === cornerInviteGameId && item.inviteeUsername === friend.username);
    const member = backendLobby?.gameId === cornerInviteGameId && backendLobby.players?.some(item => (item.accountId || item.account_id) === friend.id);
    const invitation = backendGameInvitations.find(item => item.direction === 'incoming' && item.hostUsername === friend.username);
    const joinId = friend.joinableGame?.gameId || invitation?.gameId;
    const joinAction = friend.joinableGame?.gameId ? `cornerJoinFriend('${esc(friend.id)}')` : invitation ? `cornerRespondToInvitation('${esc(invitation.invitationId)}','accept')` : '';
    return `<div class="social-row corner-friend-row">
      ${socialAvatar(friend)}<span class="social-name">${esc(friend.username)}<small class="friend-presence ${friend.online ? 'online' : ''}">${friend.online ? 'Online' : 'Offline'}</small></span>
      <details class="corner-friend-options"><summary aria-label="Options for ${esc(friend.username)}">⋮</summary><button class="btn alt" type="button" onclick="removeFriendAccount('${esc(friend.id)}')">Remove friend</button></details>
      <div class="corner-friend-actions">
        <button class="btn alt" type="button" onclick="${joinAction}" ${!joinId || playing || cornerSocialActionPending ? 'disabled' : ''} title="${playing ? 'Finish or leave your current match first' : joinId ? 'Join this friend’s waiting match' : 'No available match'}">Join game</button>
        <button class="btn" type="button" onclick="cornerInviteFriend('${esc(friend.id)}')" ${!cornerInviteGameId || invited || member || cornerSocialActionPending ? 'disabled' : ''}>${member ? 'In your game' : invited ? 'Invited' : 'Invite to game'}</button>
      </div>
    </div>`;
  }).join('') || '<p class="muted">Your friend list is empty.</p>';
  const requestRows = incoming.map(request => `<div class="social-row">
    ${socialAvatar({ username: request.username, avatar_url: request.avatar_url })}
    <span class="social-name">${esc(request.username)}</span><span class="tag">wants to connect</span>
    <div class="social-actions"><button class="btn" type="button" onclick="decideFriendRequest('${esc(request.id)}','accept')">Accept</button>
    <button class="btn alt" type="button" onclick="decideFriendRequest('${esc(request.id)}','decline')">Decline</button></div>
  </div>`).join('') || '<p class="muted">No incoming requests.</p>';
  const sentRows = outgoing.map(request => `<div class="social-row">
    ${socialAvatar({ username: request.username, avatar_url: request.avatar_url })}
    <span class="social-name">${esc(request.username)}</span><span class="tag">request sent</span>
  </div>`).join('') || '<p class="muted">No sent requests.</p>';
  const results = friendsScreenState.results.map(user => {
    let action = `<button class="btn" type="button" onclick="sendFriendRequest('${esc(user.username)}')">Add friend</button>`;
    if (user.request_direction === 'outgoing') action = '<span class="tag">request sent</span>';
    if (user.request_direction === 'incoming') action = `<button class="btn" type="button" onclick="decideFriendRequest('${esc(user.request_id)}','accept')">Accept request</button>`;
    return `<div class="social-row">
      ${socialAvatar(user)}<span class="social-name">${esc(user.username)}</span>
      <span class="tag">${user.online ? 'online' : 'offline'}</span>
      ${action}
    </div>`;
  }).join('') || (friendsScreenState.query ? '<p class="muted">No matching accounts.</p>' : '');
  const invitationRows = backendGameInvitations.filter(item => item.direction === 'incoming').map(item => `<div class="social-row"><span class="social-name">${esc(item.hostUsername)} invited you<span class="friend-presence">${Number(item.playerCount)} / 8 players</span></span><div class="corner-friend-actions"><button class="btn" type="button" onclick="cornerRespondToInvitation('${esc(item.invitationId)}','accept')" ${playing || cornerSocialActionPending ? 'disabled' : ''}>Join game</button><button class="btn alt" type="button" onclick="cornerRespondToInvitation('${esc(item.invitationId)}','decline')" ${cornerSocialActionPending ? 'disabled' : ''}>Decline</button></div></div>`).join('');
  setCornerSection('cornerFriendInvites', invitationRows ? `<section class="panel acc-yellow"><h2>Game invitations</h2><div class="social-list">${invitationRows}</div></section>` : '');
  setCornerSection('cornerFriendRows', friendRows);
  setCornerSection('cornerFriendRequests', requestRows);
  setCornerSection('cornerSentRequests', sentRows);
  setCornerSection('cornerFriendResults', results);
  document.getElementById('cornerFriendsStatus').textContent = friendsScreenState.status;
  ensureCornerMenus();

}

async function searchFriendAccounts(event) {
  event.preventDefault();
  const liveInput = event.currentTarget.querySelector('[name="query"]');
  friendsScreenState.query = (liveInput ? liveInput.value : new FormData(event.currentTarget).get('query')).trim();
  friendsScreenState.status = 'Searching...';
  renderFriendsScreen();
  try {
    const result = await accountRequest(`/api/friends/search?q=${encodeURIComponent(friendsScreenState.query)}`);
    friendsScreenState.results = result.users || [];
    friendsScreenState.status = '';
  } catch (error) { friendsScreenState.status = error.message; }
  renderFriendsScreen();
}

async function sendFriendRequest(username) {
  try {
    const result = await accountRequest('/api/friends/requests', { method: 'POST', body: JSON.stringify({ username }) });
    friendsScreenState.results = friendsScreenState.results.filter(user => user.username !== username);
    friendsScreenState.status = result.message || (result.autoAccepted
      ? `You and ${username} are now friends.`
      : result.alreadyPending
        ? 'Friend request already sent.'
        : result.alreadyFriends
          ? 'You are already friends.'
          : `Request sent to ${username}.`);
  } catch (error) { friendsScreenState.status = error.message; }
  friendsScreenState.query = '';
  friendsScreenState.results = [];
  await loadFriendsScreen();
  pollAccountNotifications();
}

async function decideFriendRequest(id, action) {
  try {
    await accountRequest(`/api/friends/requests/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ action }) });
    friendsScreenState.status = action === 'accept' ? 'Friend request accepted.' : 'Friend request declined.';
  } catch (error) { friendsScreenState.status = error.message; }
  dismissAccountNotification('friend:' + id);
  friendsScreenState.results = [];
  await loadFriendsScreen();
  pollAccountNotifications();
}

async function removeFriendAccount(id) {
  if (!confirm('Remove this friend?')) return;
  try {
    await accountRequest(`/api/friends/${encodeURIComponent(id)}`, { method: 'DELETE' });
    friendsScreenState.status = 'Friend removed.';
  } catch (error) { friendsScreenState.status = error.message; }
  await loadFriendsScreen();
}

function openBoardsScreen(selectingForHost = false) {
  boardsScreenState.returnScreen = selectingForHost ? setup.screen : '';
  boardsScreenState.selectingForHost = selectingForHost;
  boardsScreenState.editor = null;
  boardsScreenState.status = 'Loading your boards...';
  setup.screen = 'boards';
  renderSetup();
  loadBoardsScreen();
}

async function loadBoardsScreen() {
  try {
    const [boardResult, friendResult] = await Promise.all([
      accountRequest('/api/boards'),
      accountRequest('/api/friends'),
    ]);
    boardsScreenState.boards = boardResult.boards || [];
    boardsScreenState.friends = friendResult.friends || [];
    boardsScreenState.status = '';
  } catch (error) {
    boardsScreenState.status = error.message;
  }
  if (setup.screen === 'boards') renderBoardsScreen();
}

function renderBoardsScreen() {
  const boardRows = boardsScreenState.boards.map(board => {
    const shareForm = boardsScreenState.sharingBoardId === board.id
      ? `<div class="account-row"><select id="shareFriendSelect">${boardsScreenState.friends.map(friend => `<option value="${esc(friend.id)}">${esc(friend.username)}</option>`).join('')}</select>
          <button class="btn" type="button" onclick="shareCustomBoard('${esc(board.id)}')" ${boardsScreenState.friends.length ? '' : 'disabled'}>Share copy</button></div>`
      : '';
    return `<div class="social-row"><span class="social-name">${esc(board.name)}</span>
      <span class="tag">${Object.keys(board.property_names || {}).length} renamed</span>
      <div class="social-actions">
        <button class="btn alt" type="button" onclick="editCustomBoard('${esc(board.id)}')">Edit</button>
        <button class="btn alt" type="button" onclick="toggleBoardShare('${esc(board.id)}')">Share board</button>
        <button class="btn" type="button" onclick="selectCustomBoard('${esc(board.id)}')">${boardsScreenState.selectingForHost ? 'Use for game' : 'Use next game'}</button>
        <button class="btn alt" type="button" onclick="deleteCustomBoard('${esc(board.id)}')">Delete</button>
      </div>${shareForm}</div>`;
  }).join('') || '<p class="muted">No custom boards yet.</p>';
  $('app').innerHTML = `<div class="setup">
    <div class="setup-logo-wrap"><img src="${LOGO_SRC}" class="setup-logo" alt="MONOPOLY"></div>
    <p class="sub">Custom Boards</p>
    <div class="panel acc-blue"><h2>${boardsScreenState.selectingForHost ? 'Choose a game board' : 'Board library'}</h2>
      <p class="muted">Rename any of the 40 board spaces. Board positions, ownership, and all game rules keep their fixed square IDs.</p>
      <div class="account-actions"><button class="btn alt" type="button" onclick="selectClassicBoard()">Classic board</button>
        <button class="btn" type="button" onclick="createCustomBoard()">Create board</button></div>
    </div>
    <div class="panel acc-orange"><h2>My boards</h2><div class="social-list">${boardRows}</div></div>
    ${boardsScreenState.status ? `<p class="${boardsScreenState.status.startsWith('Could') || boardsScreenState.status.includes('unavailable') ? 'error' : 'muted'}" role="status">${esc(boardsScreenState.status)}</p>` : ''}
    <button class="btn alt" type="button" onclick="setup.screen='${boardsScreenState.selectingForHost ? (boardsScreenState.returnScreen || 'host') : ''}'; renderSetup()">Back</button>
  </div>`;
}

function createCustomBoard() {
  boardsScreenState.editor = { id: null, name: 'My Board', property_names: {}, card_decks: MonopolyCards.defaultDecks(), selected: 1 };
  setup.screen = 'boardEditor';
  renderBoardEditorScreen();
}

function editCustomBoard(id) {
  const board = boardsScreenState.boards.find(item => item.id === id);
  if (!board) return;
  boardsScreenState.editor = { ...board, property_names: { ...(board.property_names || {}) }, card_decks: MonopolyCards.normalizeDecks(board.card_decks), selected: 1 };
  setup.screen = 'boardEditor';
  renderBoardEditorScreen();
}

function editorSpaceLabel(index) {
  return boardsScreenState.editor?.property_names?.[index] || SPACES[index].name;
}

let boardEditorResizeObserver;
function fitBoardEditorLabels() {
  const preview = document.querySelector('.board-editor-preview');
  if (!preview) return;
  preview.querySelectorAll('.board-preview-space').forEach(square => {
    const label = square.querySelector('.board-preview-label');
    if (!label) return;
    const style = getComputedStyle(square);
    const width = square.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const height = square.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    // Fit each tile independently. Wrap at spaces and keep whole words intact.
    let size = Math.min(13, Math.max(6, preview.clientWidth / 64));
    label.style.fontSize = `${size}px`;
    while (size > 1 && (label.scrollWidth > width || label.scrollHeight > height)) {
      size = Math.max(1, size - .25);
      label.style.fontSize = `${size}px`;
    }
  });
}

function renderBoardEditorScreen() {
  if (boardEditorResizeObserver) boardEditorResizeObserver.disconnect();
  const editor = boardsScreenState.editor;
  if (!editor) { setup.screen = 'boards'; renderBoardsScreen(); return; }
  const spaces = SPACES.map((space, index) => {
    const [row, col] = gridPos(index);
    const color = space.type === 'property' ? COLOR_GROUPS[space.group].css : '#a9b3ac';
    const label = esc(editorSpaceLabel(index));
    const contents = `<span class="board-preview-label">${label}</span>`;
    const style = `grid-row:${row};grid-column:${col};--space-color:${color}`;
    return `<button class="board-preview-space ${space.type} ${editor.selected === index ? 'selected' : ''}" style="${style}" type="button" title="${label}" aria-label="Rename ${label}" aria-pressed="${editor.selected === index}" data-space="${index}" onclick="selectEditorProperty(${index})">${contents}</button>`;
  }).join('');
  const selectedName = editor.property_names[editor.selected] || SPACES[editor.selected].name;
  const selectedSpace = SPACES[editor.selected];
  const selectedColor = selectedSpace.type === 'property' ? COLOR_GROUPS[selectedSpace.group].css : '#a9b3ac';
  $('app').innerHTML = `<div class="setup board-editor">
    <div class="setup-logo-wrap"><img src="${LOGO_SRC}" class="setup-logo" alt="MONOPOLY"></div>
    <p class="sub">Board Editor</p>
    <div class="board-editor-layout">
    <div class="panel acc-green board-editor-stage">
      <div class="board-editor-stage-heading"><h2>Your board</h2><span class="board-editor-count">${Object.keys(editor.property_names).length} of ${CUSTOM_SPACE_IDS.size} spaces renamed</span></div>
      <div class="board-editor-preview"><div class="board-preview-center"><span class="board-preview-title">${esc(editor.name)}</span><span class="board-preview-hint">Select any space to rename it</span></div>${spaces}</div>
    </div>
    <div class="panel acc-blue board-editor-controls">
      <h2>Customize your board</h2>
      <div class="board-editor-field">
      <label class="muted" for="customBoardName">Board name</label>
      <input id="customBoardName" type="text" maxlength="40" value="${esc(editor.name)}" oninput="updateBoardEditorName(this.value)">
      </div>
      <div class="board-editor-field board-editor-property" style="--space-color:${selectedColor}">
      <label for="selectedPropertyName">${esc(SPACES[editor.selected].name)}</label>
      <p class="muted">Enter a new space name</p>
      <input id="selectedPropertyName" type="text" maxlength="32" value="${esc(selectedName)}" oninput="updateBoardPropertyName(this.value)">
      </div>
      <p class="muted">Choose any tile on the board to edit its name. Clear the field to restore its original name.</p>
      <div class="account-actions"><button class="btn" type="button" onclick="saveCustomBoardEditor()">Save board</button>
        <button class="btn alt" type="button" onclick="setup.screen='boards'; renderBoardsScreen()">Cancel</button></div>
      <p class="account-status" role="status">${esc(boardsScreenState.status)}</p>
    </div>
    </div>
    ${renderCardDeckEditor()}
  </div>`;
  fitBoardEditorLabels();
  if (typeof ResizeObserver !== 'undefined') {
    boardEditorResizeObserver = new ResizeObserver(fitBoardEditorLabels);
    boardEditorResizeObserver.observe(document.querySelector('.board-editor-preview'));
  }
  if (document.fonts) document.fonts.ready.then(fitBoardEditorLabels);
}

function selectEditorProperty(index) {
  if (!CUSTOM_SPACE_IDS.has(index) || !boardsScreenState.editor) return;
  boardsScreenState.editor.selected = index;
  renderBoardEditorScreen();
}

function updateBoardEditorName(value) {
  if (!boardsScreenState.editor) return;
  boardsScreenState.editor.name = value;
  const title = document.querySelector('.board-preview-title');
  if (title) title.textContent = value;
}

function updateBoardPropertyName(value) {
  const editor = boardsScreenState.editor;
  if (!editor) return;
  const index = editor.selected;
  if (value.trim()) editor.property_names[index] = value.trim();
  else delete editor.property_names[index];
  const square = document.querySelector(`[data-space="${index}"]`);
  if (square) {
    const name = editorSpaceLabel(index);
    square.querySelector('.board-preview-label').textContent = name;
    square.title = name;
    square.setAttribute('aria-label', `Rename ${name}`);
    fitBoardEditorLabels();
  }
  const count = document.querySelector('.board-editor-count');
  if (count) count.textContent = `${Object.keys(editor.property_names).length} of ${CUSTOM_SPACE_IDS.size} spaces renamed`;
}

async function saveCustomBoardEditor() {
  const editor = boardsScreenState.editor;
  if (!editor) return;
  updateBoardEditorName($('customBoardName').value);
  updateBoardPropertyName($('selectedPropertyName').value);
  boardsScreenState.status = 'Saving board...';
  try {
    const body = { name: editor.name, propertyNames: editor.property_names, replacePropertyNames: true, cardDecks: MonopolyCards.normalizeDecks(editor.card_decks) };
    const result = await accountRequest(editor.id ? `/api/boards/${encodeURIComponent(editor.id)}` : '/api/boards', {
      method: editor.id ? 'PATCH' : 'POST', body: JSON.stringify(body),
    });
    boardsScreenState.editor = { ...result.board, property_names: { ...(result.board.property_names || {}) }, card_decks: MonopolyCards.normalizeDecks(result.board.card_decks), selected: editor.selected };
    if (selectedHostBoard?.id === result.board.id) selectedHostBoard = result.board;
    boardsScreenState.status = 'Board and cards saved to your account.';
    const list = await accountRequest('/api/boards');
    boardsScreenState.boards = list.boards || [];
  } catch (error) { boardsScreenState.status = error.message; }
  if (setup.screen === 'boardEditor') renderBoardEditorScreen();
}

async function deleteCustomBoard(id) {
  if (!confirm('Delete this custom board?')) return;
  try {
    await accountRequest(`/api/boards/${encodeURIComponent(id)}`, { method: 'DELETE' });
    boardsScreenState.boards = boardsScreenState.boards.filter(board => board.id !== id);
    if (selectedHostBoard?.id === id) selectedHostBoard = null;
    boardsScreenState.status = 'Board deleted.';
  } catch (error) { boardsScreenState.status = error.message; }
  renderBoardsScreen();
}

function toggleBoardShare(id) {
  boardsScreenState.sharingBoardId = boardsScreenState.sharingBoardId === id ? null : id;
  renderBoardsScreen();
}

async function shareCustomBoard(id) {
  const friendId = $('shareFriendSelect')?.value;
  if (!friendId) { boardsScreenState.status = 'Add a friend before sharing a board.'; renderBoardsScreen(); return; }
  try {
    const result = await accountRequest(`/api/boards/${encodeURIComponent(id)}/share`, {
      method: 'POST', body: JSON.stringify({ friendId }),
    });
    boardsScreenState.status = `Independent board copy shared with ${result.board.owner_id === friendId ? 'your friend' : 'the selected account'}.`;
  } catch (error) { boardsScreenState.status = error.message; }
  renderBoardsScreen();
}

function selectCustomBoard(id) {
  selectedHostBoard = boardsScreenState.boards.find(board => board.id === id) || null;
  setup.screen = boardsScreenState.selectingForHost ? (boardsScreenState.returnScreen || 'host') : '';
  renderSetup();
}

function selectClassicBoard() {
  selectedHostBoard = null;
  setup.screen = boardsScreenState.selectingForHost ? (boardsScreenState.returnScreen || 'host') : '';
  renderSetup();
}


function cardEffectSummary(card) {
  const definition = MonopolyCards.actions[card.action];
  if (card.action === 'moveTo') return `Move to ${editorSpaceLabel(card.value)}`;
  if (card.action === 'money') return `${card.value < 0 ? 'Pay' : 'Collect'} $${Math.abs(card.value)}`;
  if (card.action === 'moneyPercentage') return `${card.value < 0 ? 'Pay' : 'Collect'} ${Math.abs(card.value)}% of current cash`;
  if (card.action === 'rule') return `${MonopolyCards.rules[card.rule].label}: ${card.value}`;
  if (card.action === 'repairs') return `$${card.houseCost} per house, $${card.hotelCost} per hotel`;
  if (card.action === 'moveNearest') return `Next ${card.targetType}`;
  return definition.label + (card.value === undefined ? '' : `: ${card.value}`);
}

function renderCardDeckEditor() {
  const editor = boardsScreenState.editor;
  editor.card_decks ||= MonopolyCards.defaultDecks();
  return `<section class="card-deck-section" aria-labelledby="cardDeckHeading">
    <div class="card-deck-heading"><div><h2 id="cardDeckHeading">Make every card your own</h2><p class="muted">Open any card to edit its message and action. Both decks start with every default card. Save board saves all card changes too.</p></div></div>
    <p class="card-rule-note">Rule cards change the selected rule for everyone for the rest of the game. Movement cards can collect money at GO and trigger the destination’s normal effect. Cards are drawn randomly, with equal chances.</p>
    <div class="card-deck-grid">${['chest', 'chance'].map(deck => {
      const list = editor.card_decks[deck];
      return `<div class="panel card-deck-panel ${deck}"><div class="card-deck-heading"><h3>${deck === 'chest' ? 'Community Chest' : 'Chance'} <span class="card-deck-count">${list.length}/50</span></h3><button class="btn alt small" onclick="resetCardDeck('${deck}')">Restore defaults</button></div>
      <ol class="card-editor-list">${list.map((card, index) => renderEditableCard(deck, card, index)).join('')}</ol>
      <button class="btn" ${list.length >= 50 ? 'disabled' : ''} onclick="changeCardList('${deck}',${list.length},'add')">+ Add card</button></div>`;
    }).join('')}</div>
    <div class="card-deck-footer"><button class="btn" onclick="saveCustomBoardEditor()">Save board and cards</button><p class="account-status" role="status">${esc(boardsScreenState.status)}</p></div>
  </section>`;
}

function renderEditableCard(deck, card, index) {
  const definition = MonopolyCards.actions[card.action];
  const prefix = `card-${deck}-${index}`;
  const field = (key, label, min, max, step = 1) => `<label for="${prefix}-${key}">${esc(label)} <span class="muted">(${min}–${max})</span></label><input id="${prefix}-${key}" type="number" min="${min}" max="${max}" step="${step}" value="${card[key]}" oninput="updateEditorCard('${deck}',${index},'${key}',Number(this.value))">`;
  return `<li><details class="card-editor-item" data-card="${prefix}" ${boardsScreenState.openCard === prefix ? 'open' : ''} ontoggle="if(this.open) boardsScreenState.openCard='${prefix}'">
    <summary><span class="card-number">${index + 1}</span><span><strong class="card-text-preview">${esc(card.text)}</strong><span class="card-effect-preview">${esc(cardEffectSummary(card))}</span></span><span class="card-edit-hint">Edit</span></summary>
    <div class="card-editor-form"><label for="${prefix}-text">Card message</label><textarea id="${prefix}-text" maxlength="500" rows="3" oninput="updateEditorCard('${deck}',${index},'text',this.value)">${esc(card.text)}</textarea>
    <label for="${prefix}-action">What this card does</label><select id="${prefix}-action" onchange="changeEditorCardAction('${deck}',${index},this.value)">${Object.entries(MonopolyCards.actions).map(([key, action]) => `<option value="${key}" ${key === card.action ? 'selected' : ''}>${esc(action.label)}</option>`).join('')}</select>
    ${card.action === 'rule' ? `<label for="${prefix}-rule">Rule to change</label><select id="${prefix}-rule" onchange="changeEditorCardRule('${deck}',${index},this.value)">${Object.entries(MonopolyCards.rules).map(([key, rule]) => `<option value="${key}" ${key === card.rule ? 'selected' : ''}>${esc(rule.label)}</option>`).join('')}</select>` : ''}
    ${Object.entries(definition.fields).map(([key, [label, min, max]]) => card.action === 'moveTo' ? `<label for="${prefix}-value">Destination space</label><select id="${prefix}-value" onchange="updateEditorCard('${deck}',${index},'value',Number(this.value))">${SPACES.map((space, position) => `<option value="${position}" ${position === card.value ? 'selected' : ''}>${position}: ${esc(editorSpaceLabel(position))}</option>`).join('')}</select>` : field(key, label, min, card.action === 'rule' ? MonopolyCards.rules[card.rule].max : max, ['rule', 'moneyPercentage'].includes(card.action) ? '0.01' : 1)).join('')}
    ${card.action === 'moveNearest' ? `<label for="${prefix}-targetType">Destination type</label><select id="${prefix}-targetType" onchange="updateEditorCard('${deck}',${index},'targetType',this.value)"><option value="railroad" ${card.targetType === 'railroad' ? 'selected' : ''}>Railroad</option><option value="utility" ${card.targetType === 'utility' ? 'selected' : ''}>Utility</option></select>` : ''}
    ${definition.movement ? `<label class="card-checkbox"><input type="checkbox" ${card.collectGo !== false ? 'checked' : ''} onchange="updateEditorCard('${deck}',${index},'collectGo',this.checked)"> Collect current GO payout when passing GO forward</label><label class="card-checkbox"><input type="checkbox" ${card.resolveLanding !== false ? 'checked' : ''} onchange="updateEditorCard('${deck}',${index},'resolveLanding',this.checked)"> Apply destination effect (rent, tax, another card, etc.)</label>` : ''}
    <div class="card-editor-tools"><button class="btn alt small" ${index === 0 ? 'disabled' : ''} onclick="changeCardList('${deck}',${index},'up')">Move up</button><button class="btn alt small" ${index === boardsScreenState.editor.card_decks[deck].length - 1 ? 'disabled' : ''} onclick="changeCardList('${deck}',${index},'down')">Move down</button><button class="btn alt small" ${boardsScreenState.editor.card_decks[deck].length >= 50 ? 'disabled' : ''} onclick="changeCardList('${deck}',${index},'duplicate')">Duplicate</button><button class="btn danger small" ${boardsScreenState.editor.card_decks[deck].length <= 1 ? 'disabled' : ''} onclick="changeCardList('${deck}',${index},'remove')">Remove</button></div></div>
  </details></li>`;
}

function updateEditorCard(deck, index, key, value) {
  const card = boardsScreenState.editor.card_decks[deck][index];
  card[key] = value;
  const item = document.querySelector(`[data-card="card-${deck}-${index}"]`);
  if (item) {
    item.querySelector('.card-text-preview').textContent = card.text;
    item.querySelector('.card-effect-preview').textContent = cardEffectSummary(card);
  }
}
function changeEditorCardAction(deck, index, action) {
  const old = boardsScreenState.editor.card_decks[deck][index];
  const card = { text: old.text, action };
  for (const [key, [, , , value]] of Object.entries(MonopolyCards.actions[action].fields)) card[key] = value;
  if (MonopolyCards.actions[action].movement) Object.assign(card, { collectGo: true, resolveLanding: true });
  if (action === 'moveNearest') card.targetType = 'railroad';
  if (action === 'rule') card.rule = 'goSalary';
  boardsScreenState.editor.card_decks[deck][index] = card;
  boardsScreenState.openCard = `card-${deck}-${index}`;
  renderBoardEditorScreen();
}
function changeEditorCardRule(deck, index, rule) {
  const card = boardsScreenState.editor.card_decks[deck][index];
  card.rule = rule;
  card.value = MonopolyCards.rules[rule].default;
  renderBoardEditorScreen();
}
function changeCardList(deck, index, operation) {
  const list = boardsScreenState.editor.card_decks[deck];
  let selected = index;
  if (operation === 'add' && list.length < 50) list.push({ text: 'Your custom card', action: 'money', value: 50 });
  if (operation === 'duplicate' && list.length < 50) { list.splice(index + 1, 0, { ...list[index] }); selected++; }
  if (operation === 'remove' && list.length > 1) { list.splice(index, 1); selected = Math.min(index, list.length - 1); }
  if (operation === 'up' && index > 0) { [list[index - 1], list[index]] = [list[index], list[index - 1]]; selected--; }
  if (operation === 'down' && index < list.length - 1) { [list[index + 1], list[index]] = [list[index], list[index + 1]]; selected++; }
  boardsScreenState.openCard = `card-${deck}-${selected}`;
  renderBoardEditorScreen();
}
function resetCardDeck(deck) {
  if (!confirm('Restore this deck to its default cards? Your edits to this deck will be replaced.')) return;
  boardsScreenState.editor.card_decks[deck] = MonopolyCards.defaultDecks()[deck];
  boardsScreenState.openCard = null;
  renderBoardEditorScreen();
}
