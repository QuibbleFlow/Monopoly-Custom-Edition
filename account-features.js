const CUSTOM_PROPERTY_IDS = new Set([1, 3, 6, 8, 9, 11, 13, 14, 16, 18, 19, 21, 23, 24, 26, 27, 29, 31, 32, 34, 37, 39]);
const friendsScreenState = { friends: [], requests: [], results: [], status: '', query: '' };
const boardsScreenState = { boards: [], friends: [], status: '', editor: null, sharingBoardId: null, selectingForHost: false };
let accountPresenceTimer = null;
let friendsRefreshTimer = null;

function startAccountPresence() {
  clearInterval(accountPresenceTimer);
  if (!accountUser) return;
  const heartbeat = () => accountRequest('/api/auth/session').catch(() => {});
  heartbeat();
  accountPresenceTimer = setInterval(heartbeat, 45000);
}

function stopAccountPresence() {
  clearInterval(accountPresenceTimer);
  accountPresenceTimer = null;
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
  }, 5000);
}

function closeFriendsScreen() {
  clearInterval(friendsRefreshTimer);
  friendsRefreshTimer = null;
  setup.screen = '';
  renderSetup();
}

async function loadFriendsScreen() {
  try {
    const [friendResult, requestResult] = await Promise.all([
      accountRequest('/api/friends'),
      accountRequest('/api/friends/requests'),
    ]);
    friendsScreenState.friends = friendResult.friends || [];
    friendsScreenState.requests = requestResult.requests || [];
    friendsScreenState.status = '';
  } catch (error) {
    friendsScreenState.status = error.message;
  }
  if (setup.screen === 'friends') renderFriendsScreen();
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
        <input type="search" name="query" minlength="2" maxlength="24" value="${esc(friendsScreenState.query)}" placeholder="Username" required>
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
  friendsScreenState.query = new FormData(event.currentTarget).get('query').trim();
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
    await accountRequest('/api/friends/requests', { method: 'POST', body: JSON.stringify({ username }) });
    friendsScreenState.results = friendsScreenState.results.filter(user => user.username !== username);
    friendsScreenState.status = `Request sent to ${username}.`;
  } catch (error) { friendsScreenState.status = error.message; }
  friendsScreenState.query = '';
  friendsScreenState.results = [];
  await loadFriendsScreen();
}

async function decideFriendRequest(id, action) {
  try {
    await accountRequest(`/api/friends/requests/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ action }) });
    friendsScreenState.status = action === 'accept' ? 'Friend request accepted.' : 'Friend request declined.';
  } catch (error) { friendsScreenState.status = error.message; }
  friendsScreenState.results = [];
  await loadFriendsScreen();
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