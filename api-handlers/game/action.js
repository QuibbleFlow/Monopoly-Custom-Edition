const { syncGameAvatars } = require('../../lib/game-profiles');
const engine = require('../../game-engine.js');
const boardData = require('../../game-board.js');
const cardData = require('../../game-cards.js');
const { database, noStore, parseBody, requireAccount } = require('../../lib/account');
const { persistFinalResultsIfNeeded } = require('../../lib/game-results.js');
const { waitingForPlayer, publicConnections, connectionsDue, reconcileConnections, persistConnections } = require('../../lib/game-connections');

function statusForError(code) {
  switch (code) {
    case 'UNAUTHENTICATED':
    case 'PLAYER_NOT_IN_GAME':
    case 'PLAYER_MISMATCH':
    case 'NOT_YOUR_TURN':
    case 'GAME_OVER':
    case 'NOT_TRADE_PARTICIPANT':
    case 'HOST_REQUIRED':
      return 403;
    case 'STALE_VERSION':
    case 'GAME_NOT_ACTIVE':
      return 409;
    case 'INVALID_ACTION':
    case 'CLIENT_DICE_REJECTED':
    case 'CLIENT_CARD_REJECTED':
    case 'INVALID_REQUEST':
    case 'ILLEGAL_ACTION':
      return 400;
    case 'GAME_NOT_FOUND':
      return 404;
    default:
      return 400;
  }
}

function normalizeAction(action) {
  if (!action || typeof action !== 'object' || typeof action.type !== 'string') {
    return { ok: false, error: { code: 'INVALID_ACTION', message: 'A valid action is required.' } };
  }
  return { ok: true, action };
}

function parseStoredResult(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

const COMPLETED_TRADE_VIEW_MS = 10 * 1000;
const ACTION_TIMER_MS = 75 * 1000;

function redactTradeState(state, accountId) {
  const copy = engine.cloneState(state);
  delete copy.connections;
  if (copy.trade && copy.trade.from !== undefined && copy.trade.to !== undefined &&
      copy.players[copy.trade.from]?.accountId !== accountId && copy.players[copy.trade.to]?.accountId !== accountId) {
    copy.trade = null;
  }
  return copy;
}

function applyEngineAction(state, action, spaces) {
  return engine.applyAction(state, action, { spaces });
}

function resolveRollSequence(initialState, initialEvents, playerId, spaces, random) {
  let state = initialState;
  const events = initialEvents.slice();
  const apply = action => {
    const result = applyEngineAction(state, action, spaces);
    if (result.error) return result;
    state = result.state;
    events.push(...result.events);
    return null;
  };

  let movementSteps = 0;
  let cardDraws = 0;
  let resolutions = 0;
  while (resolutions < 24 && !state.debt && !state.auction && state.phase !== 'buy' && !state.over) {
    resolutions += 1;
    while (state.pendingMove) {
      if (movementSteps >= spaces.length * 4) {
        return { error: 'The pending movement exceeded the board limit.' };
      }
      const movement = state.pendingMove;
      const error = apply({ type: 'MOVE_STEP', playerId: movement.playerId, direction: movement.direction });
      if (error) return error;
      movementSteps += 1;
    }

    if (!state.landingPending) break;
    const landingEventStart = events.length;
    const landingError = apply({ type: 'LAND_ON_SPACE', playerId, position: state.players[playerId].pos });
    if (landingError) return landingError;
    const landingEvents = events.slice(landingEventStart);
    if (landingEvents.some(event => event.type === 'LANDING_GO_TO_JAIL')) {
      const jailError = apply({ type: 'SEND_TO_JAIL', playerId });
      if (jailError) return jailError;
    }

    const cardRequest = landingEvents.find(event => event.type === 'CARD_DRAW_REQUESTED');
    if (!cardRequest) break;
    if (cardDraws >= 12) return { error: 'The card movement chain exceeded the resolution limit.' };
    cardDraws += 1;
    const deck = state.cardDecks?.[cardRequest.deck] || (cardRequest.deck === 'chance' ? cardData.chance : cardData.chest);
    const randomIndex = Math.min(deck.length - 1, Math.max(0, Math.floor(random() * deck.length)));
    const card = deck[randomIndex];
    const cardEventStart = events.length;
    const cardError = apply({ type: 'APPLY_CARD', playerId, card });
    if (cardError) return cardError;
    const drawnEvent = events.slice(cardEventStart).find(event => event.type === 'CARD_DRAWN');
    if (drawnEvent) {
      drawnEvent.deck = cardRequest.deck;
      // The engine supplies match-scaled text alongside the applied amount.
    }
  }

  if (resolutions >= 24 && (state.pendingMove || state.landingPending)) {
    return { error: 'The turn exceeded the resolution limit.' };
  }

  const deferredResolution = state.debt || state.auction || state.phase === 'buy' || state.over;
  if (!deferredResolution && state.phase === 'roll') {
    const completionError = apply({ type: 'COMPLETE_ACTION', playerId });
    if (completionError) return completionError;
  }

  // Match the original game flow: finishing movement does NOT automatically
  // end a normal turn. The player keeps the after-roll window for managing
  // properties, trading, and pressing End turn. A doubles roll stays in the
  // roll phase for the extra roll. The 75-second action window starts here,
  // just like endOfMovePipeline() did in the original client-authoritative flow.
  if (!state.over) {
    const timerError = apply({ type: 'START_TRADE_TIMER', now: Date.now(), durationMs: ACTION_TIMER_MS });
    if (timerError) return timerError;
  }

  return { state, events };
}

async function executeGameAction({
  account,
  gameId,
  action,
  version,
  requestId,
  sql,
  random = Math.random,
}) {
  if (!account || !account.id) {
    return { ok: false, error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } };
  }

  const normalized = normalizeAction(action);
  if (!normalized.ok) return normalized;

  if (typeof gameId !== 'string' || !gameId.trim()) {
    return { ok: false, error: { code: 'INVALID_REQUEST', message: 'A gameId is required.' } };
  }

  if (!Number.isInteger(version) || version < 1) {
    return { ok: false, error: { code: 'STALE_VERSION', message: 'The submitted game version is invalid.' } };
  }

  const db = sql || database();

  try {
    return await db.begin(async tx => {
      // Lock the game row and authoritative state together. This used to be
      // two sequential Neon round trips for every button press.
      const rows = await tx`
        SELECT g.status, g.host_account_id, gs.id, gs.version, gs.state, gs.board
        FROM games g
        JOIN game_states gs ON gs.id = g.id
        WHERE g.id = ${gameId}
        FOR UPDATE OF g, gs
      `;
      const row = rows[0];
      if (!row) {
        return { ok: false, error: { code: 'GAME_NOT_FOUND', message: 'Game not found.' } };
      }
      const game = { id: gameId, status: row.status, host_account_id: row.host_account_id };

      let currentVersion = Number(row.version) || 1;
      const state = engine.deserializeState(row.state);
      if (connectionsDue(state, game.status)) {
        const members = await tx`SELECT * FROM game_players WHERE game_id = ${gameId} ORDER BY seat_index ASC`;
        const oldHost = game.host_account_id;
        const connectionResult = reconcileConnections(state, game, members);
        const stored = await persistConnections(tx, game, row, state, members, connectionResult, oldHost);
        currentVersion = Number(stored.version);
      }
      await syncGameAvatars(tx, state);
      if (action.type === 'SET_PAUSE' || action.type === 'GAME_TICK') {
        if (game.host_account_id !== account.id) {
          return { ok: false, error: { code: 'HOST_REQUIRED', message: 'Only the host can control game timers.' } };
        }
      }
      const boardState = row.board && typeof row.board === 'object' ? row.board : {};
      const spaces = Array.isArray(boardState.spaces) ? boardState.spaces : boardData.spaces;
      const actingPlayer = state.players.find(player => player.accountId === account.id);
      if (!actingPlayer || actingPlayer.removed) {
        return { ok: false, error: { code: 'PLAYER_NOT_IN_GAME', message: 'You are not a player in this game.' } };
      }
      if (state.connections?.players[account.id]?.status === 'reconnecting') {
        return { ok: false, error: { code: 'RECONNECT_REQUIRED', message: 'Rejoin the match before taking an action.' } };
      }
      if (requestId) {
        const existingRows = await tx`SELECT result_json FROM game_action_requests WHERE game_id = ${gameId} AND request_id = ${requestId}`;
        if (existingRows[0]?.result_json) return parseStoredResult(existingRows[0].result_json);
      }
      if (game.status !== 'ACTIVE') {
        return { ok: false, error: { code: 'GAME_NOT_ACTIVE', message: 'This match is not active.' } };
      }
      if (action.type === 'GAME_TICK' && waitingForPlayer(state)) {
        return { ok: true, gameId, version: currentVersion, status: 'ACTIVE', state, events: [] };
      }

      if (version !== currentVersion) {
        return { ok: false, error: { code: 'STALE_VERSION', message: `Action version ${version} is stale. Current version is ${currentVersion}.` } };
      }

      if (action.playerId != null && Number(action.playerId) !== actingPlayer.id) {
        return { ok: false, error: { code: 'PLAYER_MISMATCH', message: 'You can only act as your own player.' } };
      }

      if (action.type === 'APPLY_CARD') {
        return { ok: false, error: { code: 'CLIENT_CARD_REJECTED', message: 'Cards are selected and applied by the server.' } };
      }

      if (state.over) {
        return { ok: false, error: { code: 'GAME_OVER', message: 'This game has already ended.' } };
      }

      const current = engine.currentPlayer(state);
      if (action.type === 'PROPOSE_TRADE') {
        if (state.trade) {
          return { ok: false, error: { code: 'ILLEGAL_ACTION', message: 'A trade is already active.' } };
        }
        const trade = action.trade;
        if (!trade || !Number.isInteger(Number(trade.to)) || Number(trade.to) === actingPlayer.id) {
          return { ok: false, error: { code: 'ILLEGAL_ACTION', message: 'A valid trade recipient is required.' } };
        }
        const recipient = state.players[Number(trade.to)];
        if (!recipient || recipient.bankrupt || state.connections?.players[recipient.accountId]?.status === 'reconnecting') {
          return { ok: false, error: { code: 'ILLEGAL_ACTION', message: 'That player cannot receive a trade.' } };
        }
        state.trade = {
          from: actingPlayer.id,
          to: Number(trade.to),
          give: Array.isArray(trade.give) ? trade.give.map(Number) : [],
          get: Array.isArray(trade.get) ? trade.get.map(Number) : [],
          giveCash: Number(trade.giveCash) || 0,
          getCash: Number(trade.getCash) || 0,
          stage: 'edit',
          error: '',
        };
      }
      const expectedActorId = state.trade && ['PROPOSE_TRADE', 'CANCEL_TRADE'].includes(action.type)
        ? state.trade.from
        : state.trade && ['ACCEPT_TRADE', 'DECLINE_TRADE', 'POSTPONE_TRADE'].includes(action.type)
          ? state.trade.to
          : state.auction
        ? state.auction.turn
        : state.debt
          ? state.debt.pid
          : current && current.id;
      const hostSystemAction = action.type === 'GAME_TICK' && game.host_account_id === account.id;
      if (!hostSystemAction && (expectedActorId == null || expectedActorId !== actingPlayer.id)) {
        return { ok: false, error: { code: 'NOT_YOUR_TURN', message: 'It is not this player\'s turn.' } };
      }

      const requestAction = { ...action, playerId: action.playerId == null ? actingPlayer.id : Number(action.playerId) };
      if (requestAction.type === 'GAME_TICK') {
        // Browser clocks and blocked flags are presentation details, not authority.
        // Use server time so a modified client cannot stretch or shorten a turn.
        requestAction.now = Date.now();
        requestAction.blocked = false;
      }
      if (requestAction.type === 'ACCEPT_TRADE') {
        requestAction.now = Date.now();
        requestAction.viewTradeMs = COMPLETED_TRADE_VIEW_MS;
      }
      if (requestAction.type === 'ROLL_DICE') {
        if (Object.prototype.hasOwnProperty.call(action, 'dice')) {
          return { ok: false, error: { code: 'CLIENT_DICE_REJECTED', message: 'Dice must be generated server-side.' } };
        }
        const first = 1 + Math.floor(random() * 6);
        const second = 1 + Math.floor(random() * 6);
        requestAction.dice = [first, second];
      }

      const legal = hostSystemAction || engine.legalActions(state, spaces)
        .some(candidate => candidate.type === requestAction.type && candidate.playerId === requestAction.playerId);
      if (!legal) {
        return { ok: false, error: { code: 'ILLEGAL_ACTION', message: 'That action is not legal in the current game state.' } };
      }

      const result = applyEngineAction(state, requestAction, spaces);
      if (result.error) {
        return { ok: false, error: { code: 'ILLEGAL_ACTION', message: result.error } };
      }

      const resolved = requestAction.type === 'ROLL_DICE'
        ? resolveRollSequence(result.state, result.events, actingPlayer.id, spaces, random)
        : { state: result.state, events: result.events };
      if (resolved.error) {
        return { ok: false, error: { code: 'ILLEGAL_ACTION', message: resolved.error } };
      }

      const nextVersion = currentVersion + 1;
      const payload = {
        ok: true,
        gameId,
        version: nextVersion,
        status: resolved.state.over ? 'FINISHED' : 'ACTIVE',
        state: resolved.state,
        events: resolved.events,
        hostAccountId: game.host_account_id,
        presence: publicConnections(resolved.state, game),
      };

      await tx`UPDATE game_states
        SET state = ${JSON.stringify(resolved.state)}::jsonb,
            version = ${nextVersion},
            updated_at = now()
        WHERE id = ${gameId}`;

      // Server-derived only: this reads resolved.state.over, which the
      // engine alone can set (see declareBankruptcy in game-engine.js).
      // Nothing here ever trusts a client-supplied status or result.
      await persistFinalResultsIfNeeded(tx, gameId, resolved.state, spaces);

      if (requestId) {
        const inserted = await tx`INSERT INTO game_action_requests (game_id, request_id, result_json)
          VALUES (${gameId}, ${requestId}, ${JSON.stringify(payload)}::jsonb)
          ON CONFLICT (game_id, request_id) DO NOTHING
          RETURNING result_json`;
        if (inserted && inserted[0]) {
          return payload;
        }
        const replay = await tx`SELECT result_json FROM game_action_requests WHERE game_id = ${gameId} AND request_id = ${requestId}`;
        if (replay && replay[0] && replay[0].result_json) {
          return parseStoredResult(replay[0].result_json);
        }
        return payload;
      }

      return payload;
    });
  } catch (error) {
    console.error('Game action execution failed:', error);
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'The game action could not be processed.' } };
  }
}

async function handleGameAction(req, res, deps = {}) {
  noStore(res);

  try {
    const account = deps.currentAccount ? await deps.currentAccount(req, res) : await requireAccount(req, res);
    if (!account) {
      return res.status(401).json({ error: 'Sign in to continue.' });
    }

    const payload = parseBody(req);
    const gameId = payload.gameId;
    const action = payload.action;
    const requestId = payload.requestId;
    const version = payload.version;
    const sql = deps.database ? deps.database() : database();
    const result = await executeGameAction({
      account,
      gameId,
      action,
      version,
      requestId,
      sql,
      random: deps.random || Math.random,
    });

    if (!result.ok) {
      return res.status(statusForError(result.error.code)).json({ error: result.error });
    }

    return res.status(200).json({
      ok: true,
      gameId: result.gameId,
      version: result.version,
      status: result.status || 'ACTIVE',
      state: redactTradeState(result.state, account.id),
      events: result.events,
      hostAccountId: result.hostAccountId,
      presence: result.presence,
    });
  } catch (error) {
    console.error('Game action API failed:', error);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'The game action could not be processed.' } });
  }
}

module.exports = async function gameAction(req, res) {
  return handleGameAction(req, res, {});
};

module.exports.handleGameAction = handleGameAction;
module.exports.executeGameAction = executeGameAction;
module.exports.statusForError = statusForError;
