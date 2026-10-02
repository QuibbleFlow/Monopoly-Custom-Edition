const engine = require('../game-engine');
const boardData = require('../game-board');
const { persistFinalResultsIfNeeded } = require('./game-results');
const { lockSaveOwner, trimSaveSlots } = require('./save-slots');

const RECONNECT_MS = 120000;
const LEASE_MS = 30000;

function initializeConnections(state, now = Date.now()) {
  if (state.connections) return false;
  state.connections = { players: {}, waitingSince: null };
  for (const player of state.players.filter(player => !player.removed)) {
    state.connections.players[player.accountId] = {
      status: 'connected', sessions: {}, leaseUntil: now + LEASE_MS, reconnectUntil: null,
    };
  }
  return true;
}

function waitingForPlayer(state) {
  const id = state.auction?.turn ?? state.debt?.pid ?? engine.currentPlayer(state)?.id;
  const player = state.players[id];
  return player && !player.removed && state.connections?.players[player.accountId]?.status === 'reconnecting' ? player : null;
}

function connectionsDue(state, status, now = Date.now()) {
  return !state.connections || Object.values(state.connections.players).some(connection =>
    (status === 'ACTIVE' && connection.status === 'connected' && connection.leaseUntil <= now) ||
    (connection.status === 'reconnecting' && connection.reconnectUntil <= now));
}

function removePlayer(state, accountId) {
  const player = state.players.find(player => player.accountId === accountId && !player.removed);
  if (!player) return false;
  const wasCurrent = engine.currentPlayer(state)?.id === player.id;
  player.removed = true;
  player.bankrupt = true;
  player.money = 0;
  if (!state.eliminatedOrder.includes(player.id)) state.eliminatedOrder.push(player.id);
  for (let i = 0; i < state.owners.length; i++) {
    if (state.owners[i] !== player.id) continue;
    state.owners[i] = null;
    state.houses[i] = 0;
    state.mortgaged[i] = false;
  }
  if (state.trade && [state.trade.from, state.trade.to].includes(player.id)) state.trade = null;
  if (state.viewTrade && [state.viewTrade.from, state.viewTrade.to].includes(player.id)) state.viewTrade = null;
  if (state.debt?.creditorId === player.id) state.debt.creditorId = null;
  if (state.debt?.pid === player.id) state.debt = null;
  if (state.pendingMove?.playerId === player.id) state.pendingMove = null;
  if (wasCurrent) {
    state.auction = null;
    state.debt = null;
    state.pendingMove = null;
    state.landingPending = false;
    state.confirmBankrupt = false;
    state.tradeTimerEnd = null;
    state.doubles = 0;
    state.rolledDouble = false;
    state.phase = 'roll';
  } else if (state.auction) {
    const auction = state.auction;
    const index = Math.max(0, auction.active.indexOf(player.id));
    auction.active = auction.active.filter(id => id !== player.id);
    if (auction.highId === player.id) { auction.highId = null; auction.high = 0; }
    if (!auction.active.length) { state.auction = null; state.phase = 'after'; }
    else if (auction.active.length === 1 && auction.highId === auction.active[0]) {
      const winner = state.players[auction.highId];
      winner.money -= auction.high;
      state.owners[auction.pos] = winner.id;
      state.auction = null;
      state.phase = state.rolledDouble ? 'roll' : 'after';
    } else if (auction.turn === player.id) auction.turn = auction.active[index % auction.active.length];
  }
  const alive = state.players.filter(player => !player.bankrupt && !player.removed);
  if (alive.length < 2) {
    state.over = true;
    state.winnerId = alive[0]?.id ?? null;
    state.trade = null;
    state.auction = null;
    state.debt = null;
    state.tradeTimerEnd = null;
  } else if (wasCurrent) {
    do { state.current = (state.current + 1) % state.turnOrder.length; }
    while (state.players[state.turnOrder[state.current]].bankrupt);
    state.turn += 1;
  }
  delete state.connections?.players[accountId];
  state.log.push(`${player.name} left the match.`);
  return true;
}

function reconcileConnections(state, game, members, now = Date.now()) {
  const initialized = initializeConnections(state, now);
  if (!state.connections.joinOrder) state.connections.joinOrder = members.slice().sort((a, b) =>
    new Date(a.joined_at || 0) - new Date(b.joined_at || 0) || a.seat_index - b.seat_index).map(member => member.account_id);
  let changed = false;
  const removed = [];
  for (const member of members) {
    const connection = state.connections.players[member.account_id];
    if (!connection) continue;
    if (game.status === 'ACTIVE') {
      for (const [id, seenAt] of Object.entries(connection.sessions)) {
        if (seenAt + LEASE_MS <= now) delete connection.sessions[id];
      }
      if (connection.status === 'connected' && connection.leaseUntil <= now) {
        connection.status = 'reconnecting';
        connection.reconnectUntil = connection.leaseUntil + RECONNECT_MS;
        changed = true;
      }
    }
    if (connection.status === 'reconnecting' && connection.reconnectUntil <= now) {
      removePlayer(state, member.account_id);
      removed.push(member.account_id);
      changed = true;
    }
  }
  // Joined time, then seat, defines succession. Turn order is independent.
  const remaining = members.filter(member => !removed.includes(member.account_id));
  const hostConnection = state.connections.players[game.host_account_id];
  if (!hostConnection || (game.status === 'ACTIVE' && hostConnection.status === 'reconnecting')) {
    const candidates = remaining.filter(member => member.account_id !== game.host_account_id &&
      state.connections.players[member.account_id]?.status !== 'reconnecting');
    const order = state.connections.joinOrder;
    const hostIndex = order.indexOf(game.host_account_id);
    const distance = member => (order.indexOf(member.account_id) - hostIndex + order.length) % order.length;
    candidates.sort((a, b) => distance(a) - distance(b));
    if (candidates.length) {
      game.host_account_id = candidates[0].account_id;
      changed = true;
    } else if (!hostConnection && remaining.length) {
      game.host_account_id = remaining[0].account_id;
      changed = true;
    }
  }
  const waiting = waitingForPlayer(state);
  if (waiting && !state.connections.waitingSince) {
    state.connections.waitingSince = now;
    changed = true;
  } else if (!waiting && state.connections.waitingSince) {
    const elapsed = now - state.connections.waitingSince;
    if (state.tradeTimerEnd) state.tradeTimerEnd += elapsed;
    if (state.viewTrade?.expiresAt) state.viewTrade.expiresAt += elapsed;
    state.connections.waitingSince = null;
    changed = true;
  }
  return { changed, removed, initialized };
}

async function persistConnections(tx, game, row, state, members, result, oldHost) {
  for (const accountId of result.removed) {
    await tx`DELETE FROM game_players WHERE game_id = ${game.id} AND account_id = ${accountId}`;
    const saves = await tx`SELECT id, state, version, players FROM game_saves WHERE source_game_id = ${game.id} FOR UPDATE`;
    for (const save of saves) {
      const snapshot = engine.deserializeState(save.state);
      removePlayer(snapshot, accountId);
      const metadata = (typeof save.players === 'string' ? JSON.parse(save.players) : save.players).filter(player => player.accountId !== accountId);
      await tx`UPDATE game_saves SET state = ${JSON.stringify(snapshot)}::jsonb, players = ${JSON.stringify(metadata)}::jsonb,
        version = ${Number(save.version) + 1}, updated_at = now() WHERE id = ${save.id}`;
    }
  }
  if (oldHost !== game.host_account_id) {
    await lockSaveOwner(tx, game.host_account_id);
    await tx`UPDATE games SET host_account_id = ${game.host_account_id}, updated_at = now() WHERE id = ${game.id}`;
    await tx`UPDATE game_states SET owner_id = ${game.host_account_id} WHERE id = ${game.id}`;
    await tx`UPDATE game_saves SET owner_id = ${game.host_account_id} WHERE source_game_id = ${game.id}`;
    await trimSaveSlots(tx, game.host_account_id);
  }
  const version = Number(row.version) + (result.changed ? 1 : 0);
  await tx`UPDATE game_states SET state = ${JSON.stringify(state)}::jsonb, version = ${version}, updated_at = now() WHERE id = ${game.id}`;
  if (state.over && ['ACTIVE', 'PAUSED'].includes(game.status)) {
    await persistFinalResultsIfNeeded(tx, game.id, state, row.board?.spaces || boardData.spaces);
    game.status = 'FINISHED';
  }
  return { ...row, state, version };
}

async function maintainConnections(db, gameId, operation = null) {
  return db.begin(async tx => {
    const games = await tx`SELECT * FROM games WHERE id = ${gameId} FOR UPDATE`;
    const game = games[0];
    if (!game || !['ACTIVE', 'PAUSED'].includes(game.status)) return { game };
    const rows = await tx`SELECT id, version, state, board FROM game_states WHERE id = ${gameId} FOR UPDATE`;
    if (!rows[0]) return { game };
    const members = await tx`SELECT * FROM game_players WHERE game_id = ${gameId} ORDER BY seat_index ASC`;
    const state = engine.deserializeState(rows[0].state);
    const now = Date.now();
    const oldHost = game.host_account_id;
    const result = reconcileConnections(state, game, members, now);
    let error = null;
    if (operation) {
      const member = members.find(member => member.account_id === operation.accountId && !result.removed.includes(member.account_id));
      const connection = state.connections.players[operation.accountId];
      if (!member || !connection) error = { code: 'RECONNECT_EXPIRED', message: 'Your player slot is no longer in this match.' };
      else if (operation.action === 'leave') {
        removePlayer(state, operation.accountId);
        result.removed.push(operation.accountId);
        result.changed = true;
      } else if (game.status === 'ACTIVE') {
        if (operation.action === 'rejoin') {
          result.changed ||= connection.status !== 'connected';
          connection.sessions[operation.sessionId] = now;
          connection.status = 'connected';
          connection.leaseUntil = now + LEASE_MS;
          connection.reconnectUntil = null;
        } else if (operation.action === 'heartbeat') {
          if (connection.status !== 'connected' || !Object.hasOwn(connection.sessions, operation.sessionId)) {
            error = { code: 'RECONNECT_REQUIRED', message: 'Rejoin your match to continue.' };
          } else {
            connection.sessions[operation.sessionId] = now;
            connection.leaseUntil = now + LEASE_MS;
          }
        } else if (operation.action === 'disconnect') {
          delete connection.sessions[operation.sessionId];
          if (!Object.keys(connection.sessions).length && connection.status === 'connected') {
            connection.status = 'reconnecting';
            connection.leaseUntil = now;
            connection.reconnectUntil = now + RECONNECT_MS;
            result.changed = true;
          }
        }
        // Bound session records without evicting live tabs. Eight simultaneous
        // tabs per player is sufficient and prevents unbounded JSON growth.
        const sessions = Object.entries(connection.sessions).sort((a, b) => b[1] - a[1]);
        connection.sessions = Object.fromEntries(sessions.slice(0, 8));
      }
      const after = reconcileConnections(state, game, members.filter(member => !result.removed.includes(member.account_id)), now);
      result.changed ||= after.changed;
      result.removed.push(...after.removed);
    }
    const row = result.changed || result.initialized || operation ? await persistConnections(tx, game, rows[0], state, members, result, oldHost) : { ...rows[0], state };
    return { game, ...row, serverTime: now, error };
  });
}

function publicConnections(state, game) {
  return {
    hostAccountId: game.host_account_id,
    players: state.players.filter(player => !player.removed).map(player => ({
      accountId: player.accountId, playerId: player.id, username: player.name, avatarUrl: player.avatarUrl,
      status: state.connections?.players[player.accountId]?.status || 'connected',
      reconnectUntil: state.connections?.players[player.accountId]?.reconnectUntil || null,
    })),
    waitingFor: waitingForPlayer(state)?.name || null,
  };
}

async function cancelPausedReconnect(tx, gameId, accountId) {
  const rows = await tx`SELECT id, version, state, board FROM game_states WHERE id = ${gameId} FOR UPDATE`;
  if (!rows[0]) return;
  const state = engine.deserializeState(rows[0].state);
  const connection = state.connections?.players[accountId];
  if (connection?.status !== 'reconnecting') return;
  connection.status = 'paused'; connection.sessions = {}; connection.reconnectUntil = null;
  await tx`UPDATE game_states SET state = ${JSON.stringify(state)}::jsonb, version = ${Number(rows[0].version) + 1}, updated_at = now() WHERE id = ${gameId}`;
}

module.exports = { RECONNECT_MS, LEASE_MS, initializeConnections, reconcileConnections, removePlayer,
  maintainConnections, publicConnections, waitingForPlayer, connectionsDue, persistConnections, cancelPausedReconnect };
