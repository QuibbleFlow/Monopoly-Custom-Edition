const CUSTOM_PROPERTY_IDS = new Set([1, 3, 6, 8, 9, 11, 13, 14, 16, 18, 19, 21, 23, 24, 26, 27, 29, 31, 32, 34, 37, 39]);
const friendsScreenState = { friends: [], requests: [], results: [], status: '', query: '' };
const boardsScreenState = { boards: [], friends: [], status: '', editor: null, sharingBoardId: null, selectingForHost: false };
let accountPresenceTimer = null;
let friendsRefreshTimer = null;
let accountNotificationTimer = null;
let accountNotificationPollInFlight = false;
const seenFriendRequestNotifications = new Set();
const seenGameInvitationNotifications = new Set();

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
    if (setup.screen === 'friends') loadFriendsScreen();
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
  setup.screen = 'friends';
  friendsScreenState.status = 'Loading friends...';
  renderSetup();
  loadFriendsScreen();
  clearInterval(friendsRefreshTimer);
  friendsRefreshTimer = setInterval(() => {
    if (setup.screen === 'friends') loadFriendsScreen();
  }, 3000);
}

function closeFriendsScreen() {
  clearInterval(friendsRefreshTimer);
  friendsRefreshTimer = null;
  setup.screen = '';
  renderSetup();
}

async function loadFriendsScreen() {
  const searchInput = document.getElementById('friendSearchInput');
  const searchWasFocused = setup.screen === 'friends' && document.activeElement === searchInput;
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

  // The Friends screen refreshes in the background every few seconds.
  // Replacing #app while the player is typing destroys the live <input>,
  // clears its unsaved text, and steals focus. Keep the fresh social data
  // in memory, but wait to redraw until the player is done typing.
  if (setup.screen === 'friends' && !searchWasFocused) renderFriendsScreen();
}

function renderFriendsScreen() {
  const incoming = friendsScreenState.requests.filter(request => request.direction === 'incoming');
  const outgoing = friendsScreenState.requests.filter(request => request.direction === 'outgoing');
  const friendRows = friendsScreenState.friends.map(friend => `<div class="social-row">
    ${socialAvatar(friend)}<span class="social-name">${esc(friend.username)}</span>
    <span class="tag">${friend.online ? 'online' : 'offline'}</span>
    <button class="btn alt" type="button" onclick="removeFriendAccount('${esc(friend.id)}')">Remove</button>
  </div>`).join('') || '<p class="muted">Your friend list is empty.</p>';
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
  $('app').innerHTML = `<div class="setup">
    <div class="setup-logo-wrap"><img src="${LOGO_SRC}" class="setup-logo" alt="MONOPOLY"></div>
    <p class="sub">Friends</p>
    <div class="panel acc-blue"><h2>Find a player</h2>
      <form class="account-row" onsubmit="searchFriendAccounts(event)">
        <input id="friendSearchInput" type="search" name="query" minlength="2" maxlength="24" value="${esc(friendsScreenState.query)}" placeholder="Username" autocomplete="off" oninput="friendsScreenState.query=this.value" required>
        <button class="btn" type="submit">Search</button>
      </form><div class="social-list">${results}</div>
    </div>
    <div class="panel acc-orange"><h2>Friend requests</h2><div class="social-list">${incoming}</div>
      <h2 style="margin-top:var(--sp3)">Sent requests</h2><div class="social-list">${sentRows}</div></div>
    <div class="panel acc-green"><h2>Your friends</h2><div class="social-list">${friendRows}</div></div>
    ${friendsScreenState.status ? `<p class="error" role="status">${esc(friendsScreenState.status)}</p>` : ''}
    <button class="btn alt" type="button" onclick="closeFriendsScreen()">Back</button>
  </div>`;
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
      <p class="muted">Property names change for display only. Board positions, ownership, and all game rules keep their fixed square IDs.</p>
      <div class="account-actions"><button class="btn alt" type="button" onclick="selectClassicBoard()">Classic board</button>
        <button class="btn" type="button" onclick="createCustomBoard()">Create board</button></div>
    </div>
    <div class="panel acc-orange"><h2>My boards</h2><div class="social-list">${boardRows}</div></div>
    ${boardsScreenState.status ? `<p class="${boardsScreenState.status.startsWith('Could') || boardsScreenState.status.includes('unavailable') ? 'error' : 'muted'}" role="status">${esc(boardsScreenState.status)}</p>` : ''}
    <button class="btn alt" type="button" onclick="setup.screen='${boardsScreenState.selectingForHost ? 'host' : ''}'; renderSetup()">Back</button>
  </div>`;
}

function createCustomBoard() {
  boardsScreenState.editor = { id: null, name: 'My Board', property_names: {}, selected: 1 };
  setup.screen = 'boardEditor';
  renderBoardEditorScreen();
}

function editCustomBoard(id) {
  const board = boardsScreenState.boards.find(item => item.id === id);
  if (!board) return;
  boardsScreenState.editor = { ...board, property_names: { ...(board.property_names || {}) }, selected: 1 };
  setup.screen = 'boardEditor';
  renderBoardEditorScreen();
}

function editorSpaceLabel(index) {
  return boardsScreenState.editor?.property_names?.[index] || SPACES[index].name;
}

function renderBoardEditorScreen() {
  const editor = boardsScreenState.editor;
  if (!editor) { setup.screen = 'boards'; renderBoardsScreen(); return; }
  const spaces = SPACES.map((space, index) => {
    const [row, col] = gridPos(index);
    const editable = CUSTOM_PROPERTY_IDS.has(index);
    const color = space.type === 'property' ? COLOR_GROUPS[space.group].css : '#a9b3ac';
    const contents = esc(editorSpaceLabel(index));
    const style = `grid-row:${row};grid-column:${col};--space-color:${color}`;
    return editable
      ? `<button class="board-preview-space property ${editor.selected === index ? 'selected' : ''}" style="${style}" type="button" data-space="${index}" onclick="selectEditorProperty(${index})">${contents}</button>`
      : `<div class="board-preview-space ${space.type}" style="${style}">${contents}</div>`;
  }).join('');
  const selectedName = editor.property_names[editor.selected] || SPACES[editor.selected].name;
  $('app').innerHTML = `<div class="setup">
    <div class="setup-logo-wrap"><img src="${LOGO_SRC}" class="setup-logo" alt="MONOPOLY"></div>
    <p class="sub">Board Editor</p>
    <div class="panel acc-blue board-editor-controls">
      <label class="muted" for="customBoardName">Board name</label>
      <input id="customBoardName" type="text" maxlength="40" value="${esc(editor.name)}" oninput="updateBoardEditorName(this.value)">
      <div class="board-editor-preview"><div class="board-preview-center">${esc(editor.name)}<br><span class="muted">Select a colored property to rename it</span></div>${spaces}</div>
      <label class="muted" for="selectedPropertyName">Selected property: ${esc(SPACES[editor.selected].name)}</label>
      <input id="selectedPropertyName" type="text" maxlength="32" value="${esc(selectedName)}" oninput="updateBoardPropertyName(this.value)">
      <p class="muted">GO, Jail, Free Parking, and Go To Jail remain unchanged.</p>
      <div class="account-actions"><button class="btn" type="button" onclick="saveCustomBoardEditor()">Save board</button>
        <button class="btn alt" type="button" onclick="setup.screen='boards'; renderBoardsScreen()">Cancel</button></div>
      <p class="account-status" role="status">${esc(boardsScreenState.status)}</p>
    </div>
  </div>`;
}

function selectEditorProperty(index) {
  if (!CUSTOM_PROPERTY_IDS.has(index) || !boardsScreenState.editor) return;
  boardsScreenState.editor.selected = index;
  renderBoardEditorScreen();
}

function updateBoardEditorName(value) {
  if (!boardsScreenState.editor) return;
  boardsScreenState.editor.name = value;
  const title = document.querySelector('.board-preview-center');
  if (title) title.firstChild.textContent = value;
}

function updateBoardPropertyName(value) {
  const editor = boardsScreenState.editor;
  if (!editor) return;
  const index = editor.selected;
  if (value.trim()) editor.property_names[index] = value.trim();
  else delete editor.property_names[index];
  const square = document.querySelector(`[data-space="${index}"]`);
  if (square) square.textContent = value || SPACES[index].name;
}

async function saveCustomBoardEditor() {
  const editor = boardsScreenState.editor;
  if (!editor) return;
  updateBoardEditorName($('customBoardName').value);
  updateBoardPropertyName($('selectedPropertyName').value);
  boardsScreenState.status = 'Saving board...';
  try {
    const body = { name: editor.name, propertyNames: editor.property_names };
    const result = await accountRequest(editor.id ? `/api/boards/${encodeURIComponent(editor.id)}` : '/api/boards', {
      method: editor.id ? 'PATCH' : 'POST', body: JSON.stringify(body),
    });
    boardsScreenState.editor = { ...result.board, property_names: { ...(result.board.property_names || {}) }, selected: editor.selected };
    boardsScreenState.status = 'Board saved to your account.';
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
  setup.screen = boardsScreenState.selectingForHost ? 'host' : '';
  renderSetup();
}

function selectClassicBoard() {
  selectedHostBoard = null;
  setup.screen = boardsScreenState.selectingForHost ? 'host' : '';
  renderSetup();
}