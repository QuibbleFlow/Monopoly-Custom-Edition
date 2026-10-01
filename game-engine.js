(function (root, factory) {
  const engine = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = engine;
  if (root) root.MonopolyGameEngine = engine;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_COLORS = ['#d62839', '#1f6fd1', '#16803a', '#8e4bd0',
    '#f28c1b', '#0fa3a3', '#d6479b', '#6b4f2a'];
  const DEFAULT_PLAYER_NAMES = Object.freeze(
    Array.from({ length: 8 }, (_, index) => `Player ${index + 1}`)
  );

  function createState(options) {
    const {
      names, colors = [], accountIds = [], boardNames = {}, boardSize = 40,
      startMoney = 1500,
    } = options;
    if (!Array.isArray(names) || names.length < 2 || names.length > 8) {
      throw new Error('A game requires between two and eight players.');
    }
    return {
      boardNames: { ...boardNames },
      players: names.map((name, id) => ({
        id,
        name,
        accountId: accountIds[id] == null ? null : accountIds[id],
        color: colors[id] || DEFAULT_COLORS[id],
        money: startMoney,
        pos: 0,
        inJail: false,
        jailTurns: 0,
        bankrupt: false,
      })),
      turnOrder: names.map((_, id) => id),
      current: 0,
      turn: 1,
      phase: 'roll',
      dice: [0, 0],
      doubles: 0,
      rolledDouble: false,
      pendingMove: null,
      landingPending: false,
      owners: Array(boardSize).fill(null),
      houses: Array(boardSize).fill(0),
      mortgaged: Array(boardSize).fill(false),
      debt: null,
      auction: null,
      trade: null,
      confirmBankrupt: false,
      log: [],
      over: false,
      winnerId: null,
      eliminatedOrder: [],
      rev: 0,
      cardSeq: 0,
      tradeTimerEnd: null,
      viewTrade: null,
      paused: false,
      pausedAt: null,
      started: false,
    };
  }

  function cloneState(state) {
    return JSON.parse(JSON.stringify(state));
  }

  function serializeState(state) {
    return JSON.stringify(state);
  }

  function deserializeState(snapshot) {
    const state = cloneState(typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot);
    if (state.winnerId === undefined) {
      state.winnerId = state.winner && state.winner.id != null ? state.winner.id : null;
      delete state.winner;
    }
    if (!Array.isArray(state.eliminatedOrder)) state.eliminatedOrder = [];
    state.players.forEach(player => {
      if (player.accountId === undefined) player.accountId = null;
    });
    if (state.started === undefined) state.started = true;
    if (state.pendingMove === undefined) state.pendingMove = null;
    if (state.landingPending === undefined) state.landingPending = false;
    if (!state.turn) state.turn = 1;
    return state;
  }

  function currentPlayer(state) {
    return state.players[state.turnOrder[state.current]];
  }

  function groupSquares(spaces, group) {
    return spaces.map((space, index) => space.group === group ? index : -1).filter(index => index >= 0);
  }

  function ownsFullSet(state, spaces, playerId, group) {
    return groupSquares(spaces, group).every(index => state.owners[index] === playerId);
  }

  function groupHasHouses(state, spaces, group) {
    return groupSquares(spaces, group).some(index => state.houses[index] > 0);
  }

  function groupHasMortgage(state, spaces, group) {
    return groupSquares(spaces, group).some(index => state.mortgaged[index]);
  }

  function countOwned(state, spaces, playerId, type) {
    return spaces.reduce((count, space, index) => count + (space.type === type && state.owners[index] === playerId ? 1 : 0), 0);
  }

  function ownedSquares(state, playerId) {
    return state.owners.reduce((owned, owner, index) => {
      if (owner === playerId) owned.push(index);
      return owned;
    }, []);
  }

  function calcRent(state, spaces, position) {
    const space = spaces[position];
    const ownerId = state.owners[position];
    if (!space || ownerId == null) return 0;
    if (space.type === 'property') {
      const houses = state.houses[position];
      if (houses > 0) return space.rents[houses];
      return ownsFullSet(state, spaces, ownerId, space.group) ? space.rents[0] * 2 : space.rents[0];
    }
    if (space.type === 'railroad') return 25 * Math.pow(2, countOwned(state, spaces, ownerId, 'railroad') - 1);
    if (space.type === 'utility') {
      const multiplier = countOwned(state, spaces, ownerId, 'utility') === 2 ? 10 : 4;
      return multiplier * (state.dice[0] + state.dice[1]);
    }
    return 0;
  }

  // Authoritative net worth for a single player: cash on hand plus the
  // value of every asset they own. Unmortgaged properties count at full
  // board price; mortgaged properties count at their mortgage value
  // (what the bank paid out for them) since that's the value actually
  // backing the player's position; houses/hotels count at their full
  // build cost. This is intentionally distinct from liquidationValue(),
  // which is a private, in-turn "how much can this player raise right
  // now" helper used only during forced asset sales.
  function calculateNetWorth(state, spaces, playerId) {
    const p = state.players[playerId];
    if (!p) return 0;
    let worth = p.money;
    for (let index = 0; index < spaces.length; index++) {
      if (state.owners[index] !== playerId) continue;
      const space = spaces[index];
      worth += (state.houses[index] || 0) * (space.houseCost || 0);
      worth += state.mortgaged[index] ? mortgageValue(spaces, index) : (space.price || 0);
    }
    return worth;
  }

  // Authoritative final placements for an ended game (state.over === true).
  // 1st place is the surviving winner (state.winnerId); the rest are
  // ranked by reverse bankruptcy order (the most recently eliminated
  // player placed higher than one eliminated earlier). Money and net
  // worth are read straight from authoritative state -- bankrupt players
  // have already had their assets transferred away and money zeroed by
  // declareBankruptcy, so they correctly show 0/0.
  function computeFinalResults(state, spaces) {
    if (!state.over) return null;
    const eliminated = Array.isArray(state.eliminatedOrder) ? state.eliminatedOrder.slice().reverse() : [];
    const ranked = state.winnerId == null ? eliminated : [state.winnerId, ...eliminated.filter(id => id !== state.winnerId)];
    return ranked.map((playerId, index) => {
      const p = state.players[playerId];
      return {
        playerId,
        accountId: p ? p.accountId : null,
        name: p ? p.name : null,
        placement: index + 1,
        money: p ? p.money : 0,
        netWorth: calculateNetWorth(state, spaces, playerId),
      };
    });
  }

  function canManage(state) {
    return !state.over && (
      ['buy', 'after', 'debt'].includes(state.phase) ||
      (state.phase === 'roll' && state.doubles > 0)
    );
  }

  function canBuild(state, spaces, position, playerId) {
    const space = spaces[position];
    if (!space || space.type !== 'property' || state.owners[position] !== playerId) return false;
    if (!ownsFullSet(state, spaces, playerId, space.group) || groupHasMortgage(state, spaces, space.group)) return false;
    return state.houses[position] < 5 && state.players[playerId].money >= space.houseCost;
  }

  function canSell(state, spaces, position, playerId) {
    const space = spaces[position];
    return !!space && space.type === 'property' && state.owners[position] === playerId && state.houses[position] > 0;
  }

  function mortgageValue(spaces, position) {
    return spaces[position].price / 2;
  }

  function unmortgageCost(spaces, position, interest = 0.1) {
    return Math.ceil(mortgageValue(spaces, position) * (1 + interest));
  }

  function canMortgage(state, spaces, position, playerId) {
    const space = spaces[position];
    if (!space || !space.price || state.owners[position] !== playerId || state.mortgaged[position]) return false;
    return space.type !== 'property' || !groupHasHouses(state, spaces, space.group);
  }

  function isTradable(state, spaces, position, playerId) {
    const space = spaces[position];
    return !!space && state.owners[position] === playerId &&
      !(space.type === 'property' && groupHasHouses(state, spaces, space.group));
  }

  function validateTrade(state, trade, spaces, interest = 0.1) {
    if (!trade || !state.players[trade.from] || !state.players[trade.to]) return { code: 'PLAYERS_REQUIRED' };
    if (trade.from === trade.to) return { code: 'PLAYERS_REQUIRED' };
    const from = state.players[trade.from], to = state.players[trade.to];
    const give = trade.give == null ? [] : trade.give, get = trade.get == null ? [] : trade.get;
    const giveCash = Number(trade.giveCash == null ? 0 : trade.giveCash);
    const getCash = Number(trade.getCash == null ? 0 : trade.getCash);
    if (!Array.isArray(give) || !Array.isArray(get) || !Number.isFinite(giveCash) || !Number.isFinite(getCash) ||
        giveCash < 0 || getCash < 0 || new Set(give).size !== give.length || new Set(get).size !== get.length) {
      return { code: 'INVALID_OFFER' };
    }
    if (!give.length && !get.length && !giveCash && !getCash) return { code: 'EMPTY_OFFER' };
    if (giveCash > from.money) return { code: 'INSUFFICIENT_GIVE_CASH', playerId: from.id, available: from.money };
    if (getCash > to.money) return { code: 'INSUFFICIENT_GET_CASH', playerId: to.id, available: to.money };
    if (!give.every(position => isTradable(state, spaces, position, from.id)) ||
        !get.every(position => isTradable(state, spaces, position, to.id))) return { code: 'PROPERTY_NOT_TRADABLE' };
    const fromFee = get.filter(position => state.mortgaged[position])
      .reduce((sum, position) => sum + Math.ceil(mortgageValue(spaces, position) * interest), 0);
    const toFee = give.filter(position => state.mortgaged[position])
      .reduce((sum, position) => sum + Math.ceil(mortgageValue(spaces, position) * interest), 0);
    if (from.money - giveCash + getCash < fromFee) return { code: 'GIVE_SIDE_CANNOT_PAY_FEE', playerId: from.id, amount: fromFee };
    if (to.money - getCash + giveCash < toFee) return { code: 'GET_SIDE_CANNOT_PAY_FEE', playerId: to.id, amount: toFee };
    return { code: null };
  }

  function legalActions(state, spaces, options = {}) {
    const player = currentPlayer(state);
    const actions = [];
    if (!player || player.bankrupt || state.over || state.paused || !state.started) return actions;
    if (state.phase === 'roll') {
      actions.push({ type: 'ROLL_DICE', playerId: player.id });
      if (player.inJail && player.money >= (options.jailFine || 50)) actions.push({ type: 'PAY_JAIL_FINE', playerId: player.id });
    } else if (state.phase === 'buy') {
      actions.push({ type: 'DECLINE_PROPERTY', playerId: player.id });
      const space = spaces[player.pos];
      if (space && state.owners[player.pos] == null && player.money >= space.price) {
        actions.push({ type: 'BUY_PROPERTY', playerId: player.id, position: player.pos });
      }
    } else if (state.phase === 'after') {
      actions.push({ type: 'END_TURN', playerId: player.id });
    }
    if (canManage(state)) {
      for (const position of ownedSquares(state, player.id)) {
        if (canBuild(state, spaces, position, player.id)) actions.push({ type: 'BUY_HOUSE', playerId: player.id, position });
        if (canSell(state, spaces, position, player.id)) actions.push({ type: 'SELL_HOUSE', playerId: player.id, position });
        if (canMortgage(state, spaces, position, player.id)) actions.push({ type: 'MORTGAGE_PROPERTY', playerId: player.id, position });
        if (state.mortgaged[position] && player.money >= unmortgageCost(spaces, position, options.mortgageInterest)) {
          actions.push({ type: 'UNMORTGAGE_PROPERTY', playerId: player.id, position });
        }
      }
    }
    if (state.debt) {
      const debtor = state.players[state.debt.pid];
      if (debtor && !debtor.bankrupt) {
        if (debtor.money >= state.debt.amount) actions.push({ type: 'PAY_DEBT', playerId: debtor.id });
        actions.push({ type: 'CONFIRM_BANKRUPTCY', playerId: debtor.id });
      }
    }
    if (state.auction) {
      const bidder = state.players[state.auction.turn];
      if (bidder && !bidder.bankrupt) {
        actions.push({ type: 'AUCTION_BID', playerId: bidder.id, minimum: state.auction.high + 1, maximum: bidder.money });
        actions.push({ type: 'AUCTION_FOLD', playerId: bidder.id });
      }
    }
    if (state.trade) {
      if (state.trade.stage === 'edit') actions.push({ type: 'PROPOSE_TRADE', playerId: state.trade.from });
      if (state.trade.stage === 'review') {
        actions.push({ type: 'ACCEPT_TRADE', playerId: state.trade.to });
        actions.push({ type: 'DECLINE_TRADE', playerId: state.trade.to });
        actions.push({ type: 'POSTPONE_TRADE', playerId: state.trade.to });
      }
      actions.push({ type: 'CANCEL_TRADE', playerId: state.trade.from });
    }
    return actions;
  }

  function applyAction(inputState, action, options = {}) {
    const state = cloneState(inputState);
    const spaces = options.spaces || [];
    const jailFine = options.jailFine == null ? 50 : options.jailFine;
    const jailPosition = options.jailPosition == null ? 10 : options.jailPosition;
    const goSalary = options.goSalary == null ? 200 : options.goSalary;
    const interest = options.mortgageInterest == null ? 0.1 : options.mortgageInterest;
    const events = [];
    const fail = message => ({ state: inputState, events: [], error: message });
    const emit = (type, details = {}) => events.push({ type, ...details });
    const player = id => state.players[id];
    const current = () => currentPlayer(state);
    const isCurrentActor = id => current() && current().id === id;
    const checkCurrent = id => !state.over && isCurrentActor(id) && !player(id).bankrupt;

    function endTurn() {
      state.doubles = 0;
      state.rolledDouble = false;
      if (state.trade && ['pick', 'edit'].includes(state.trade.stage)) state.trade = null;
      state.tradeTimerEnd = null;
      let next = state.current;
      do {
        next = (next + 1) % state.turnOrder.length;
      } while (player(state.turnOrder[next]).bankrupt);
      state.current = next;
      state.phase = 'roll';
      state.turn = (state.turn || 1) + 1;
      emit('TURN_CHANGED', { playerId: current().id, turn: state.turn });
    }

    function finishAction() {
      state.debt = null;
      state.auction = null;
      state.confirmBankrupt = false;
      if (state.over) return;
      if (current().bankrupt) {
        endTurn();
      } else if (state.rolledDouble && !current().inJail) {
        state.phase = 'roll';
        emit('DOUBLES_AGAIN', { playerId: current().id });
      } else {
        state.phase = 'after';
      }
    }

    function finishAuction(winnerId) {
      const auction = state.auction;
      if (!auction) return;
      const amount = winnerId === null ? 0 : auction.high;
      if (winnerId !== null) {
        const winner = player(winnerId);
        winner.money -= amount;
        state.owners[auction.pos] = winnerId;
      }
      state.auction = null;
      finishAction();
      emit('AUCTION_ENDED', { position: auction.pos, winnerId, amount });
    }

    function startAuction(position) {
      const ids = state.players.filter(candidate => !candidate.bankrupt).map(candidate => candidate.id);
      const start = ids.indexOf(current().id);
      const order = ids.slice(start + 1).concat(ids.slice(0, start + 1));
      state.auction = { pos: position, high: 0, highId: null, active: order, turn: order[0] };
      state.phase = 'auction';
      emit('AUCTION_STARTED', { position, firstPlayerId: order[0] });
    }

    function requestMovement(playerId, steps, direction, source, target = null) {
      state.pendingMove = steps > 0 ? { playerId, steps, direction, source, target } : null;
      state.landingPending = steps === 0;
      emit('MOVE_REQUESTED', { playerId, steps, direction, source, target });
    }

    function liquidationValue(playerId) {
      let value = 0;
      for (let index = 0; index < spaces.length; index++) {
        if (state.owners[index] !== playerId) continue;
        value += state.houses[index] * (spaces[index].houseCost || 0) / 2;
        if (!state.mortgaged[index] && spaces[index].price) value += mortgageValue(spaces, index);
      }
      return value;
    }

    function declareBankruptcy(playerId, creditorId) {
      const debtor = player(playerId);
      const creditor = creditorId == null ? null : player(creditorId);
      for (let index = 0; index < spaces.length; index++) {
        if (state.owners[index] !== playerId) continue;
        state.owners[index] = creditor ? creditor.id : null;
        state.houses[index] = 0;
        if (!creditor) state.mortgaged[index] = false;
        emit('BANKRUPTCY_PROPERTY_TRANSFERRED', { playerId, creditorId: creditor ? creditor.id : null, position: index });
      }
      if (creditor) creditor.money += Math.max(0, debtor.money);
      debtor.money = 0;
      debtor.bankrupt = true;
      state.eliminatedOrder.push(debtor.id);
      emit('PLAYER_BANKRUPT', { playerId, creditorId: creditor ? creditor.id : null });
      const alive = state.players.filter(candidate => !candidate.bankrupt);
      if (alive.length === 1) {
        state.over = true;
        state.winnerId = alive[0].id;
        emit('GAME_WON', { playerId: alive[0].id });
      }
    }

    function payMoney(playerId, amount, creditorId, forceAuto = false) {
      const debtor = player(playerId);
      const creditor = creditorId == null ? null : player(creditorId);
      if (debtor.money >= amount) {
        debtor.money -= amount;
        if (creditor) creditor.money += amount;
        emit('PAYMENT_SETTLED', { playerId, creditorId: creditor ? creditor.id : null, amount });
        return true;
      }
      const manual = current().id === playerId && !forceAuto;
      if (!manual) {
        while (debtor.money < amount) {
          let best = -1;
          for (let index = 0; index < spaces.length; index++) {
            if (state.owners[index] === playerId && state.houses[index] > 0 &&
                (best === -1 || state.houses[index] > state.houses[best])) best = index;
          }
          if (best === -1) break;
          state.houses[best]--;
          const proceeds = spaces[best].houseCost / 2;
          debtor.money += proceeds;
          emit('HOUSE_FORCED_SOLD', { playerId, position: best, amount: proceeds });
        }
        for (let index = 0; index < spaces.length && debtor.money < amount; index++) {
          if (state.owners[index] === playerId && canMortgage(state, spaces, index, playerId)) {
            state.mortgaged[index] = true;
            const proceeds = mortgageValue(spaces, index);
            debtor.money += proceeds;
            emit('PROPERTY_FORCED_MORTGAGED', { playerId, position: index, amount: proceeds });
          }
        }
        if (debtor.money >= amount) {
          debtor.money -= amount;
          if (creditor) creditor.money += amount;
          emit('PAYMENT_SETTLED', { playerId, creditorId: creditor ? creditor.id : null, amount });
          return true;
        } else {
          declareBankruptcy(playerId, creditorId);
          return false;
        }
      }
      if (debtor.money + liquidationValue(playerId) < amount) {
        declareBankruptcy(playerId, creditorId);
        return false;
      }
      state.debt = { pid: playerId, amount, creditorId: creditor ? creditor.id : null };
      state.phase = 'debt';
      emit('DEBT_CREATED', { playerId, creditorId: creditor ? creditor.id : null, amount });
      return false;
    }

    if (!action || typeof action.type !== 'string') return fail('An action type is required.');
    if (state.paused && action.type !== 'SET_PAUSE') return fail('The game is paused.');
    const actorId = action.playerId == null ? (current() && current().id) : action.playerId;
    const position = action.position == null ? (current() && current().pos) : action.position;

    switch (action.type) {
      case 'SET_TURN_ORDER': {
        const order = action.order;
        const ids = state.players.map(candidate => candidate.id);
        if (state.started || state.turn !== 1 || state.phase !== 'roll' || !Array.isArray(order) ||
            order.length !== ids.length || new Set(order).size !== ids.length || !order.every(id => ids.includes(id))) {
          return fail('The starting turn order must be a permutation of all players before play begins.');
        }
        state.turnOrder = order.slice();
        state.current = 0;
        state.started = true;
        emit('TURN_ORDER_SET', { order: order.slice(), firstPlayerId: order[0] });
        break;
      }
      case 'ROLL_DICE': {
        if (!checkCurrent(actorId) || state.phase !== 'roll' || state.pendingMove || state.landingPending) return fail('Dice can only be rolled by the current player during the roll phase.');
        const dice = action.dice;
        if (!Array.isArray(dice) || dice.length !== 2 || dice.some(value => !Number.isInteger(value) || value < 1 || value > 6)) {
          return fail('A roll must contain two dice values from 1 to 6.');
        }
        const active = current();
        const isDouble = dice[0] === dice[1];
        state.dice = dice.slice();
        emit('DICE_ROLLED', { playerId: active.id, dice: dice.slice(), isDouble });
        if (active.inJail) {
          state.rolledDouble = false;
          if (isDouble) {
            active.inJail = false;
            active.jailTurns = 0;
            emit('JAIL_RELEASED', { playerId: active.id, reason: 'doubles' });
            requestMovement(active.id, dice[0] + dice[1], 1, 'dice');
          } else {
            active.jailTurns++;
            if (active.jailTurns >= 3) {
              active.inJail = false;
              active.jailTurns = 0;
              emit('JAIL_FINE_DUE', { playerId: active.id, amount: jailFine, steps: dice[0] + dice[1] });
              if (payMoney(active.id, jailFine, null, true)) requestMovement(active.id, dice[0] + dice[1], 1, 'jail-fine');
            } else {
              emit('JAIL_ROLL_FAILED', { playerId: active.id, attempts: active.jailTurns });
            }
          }
        } else {
          state.doubles = isDouble ? state.doubles + 1 : 0;
          if (state.doubles === 3) {
            state.doubles = 0;
            state.rolledDouble = false;
            active.pos = jailPosition;
            active.inJail = true;
            active.jailTurns = 0;
            emit('THREE_DOUBLES_JAIL', { playerId: active.id, position: jailPosition });
          } else {
            state.rolledDouble = isDouble;
            requestMovement(active.id, dice[0] + dice[1], 1, 'dice');
          }
        }
        break;
      }
      case 'MOVE_STEP': {
        const active = player(action.playerId);
        const movement = state.pendingMove;
        if (!active || active.bankrupt || !checkCurrent(active.id) || state.phase !== 'roll' ||
            !movement || movement.playerId !== active.id || movement.direction !== action.direction || movement.steps < 1) {
          return fail('The movement step is not part of a pending roll or card effect.');
        }
        const from = active.pos;
        const to = (from + action.direction + state.owners.length) % state.owners.length;
        active.pos = to;
        movement.steps--;
        if (movement.steps === 0) {
          state.pendingMove = null;
          state.landingPending = true;
        }
        emit('PLAYER_MOVED', { playerId: active.id, from, to, direction: action.direction, remaining: movement.steps });
        if (action.direction === 1 && to === 0) {
          active.money += goSalary;
          emit('GO_SALARY_COLLECTED', { playerId: active.id, amount: goSalary });
        }
        break;
      }
      case 'SEND_TO_JAIL': {
        const active = player(action.playerId);
        if (!active || active.bankrupt || !checkCurrent(active.id) || state.phase !== 'roll') return fail('That player cannot be sent to jail.');
        active.pos = jailPosition;
        active.inJail = true;
        active.jailTurns = 0;
        state.pendingMove = null;
        state.landingPending = false;
        state.rolledDouble = false;
        state.doubles = 0;
        emit('PLAYER_JAILED', { playerId: active.id, position: jailPosition });
        break;
      }
      case 'LAND_ON_SPACE': {
        const active = player(action.playerId);
        const landingPosition = action.position == null ? active && active.pos : action.position;
        const space = spaces[landingPosition];
        if (!active || active.bankrupt || !checkCurrent(active.id) || state.phase !== 'roll' || state.pendingMove || !state.landingPending || !space || active.pos !== landingPosition) return fail('That landing is not valid.');
        state.landingPending = false;
        if (['property', 'railroad', 'utility'].includes(space.type)) {
          const ownerId = state.owners[landingPosition];
          if (ownerId == null) {
            state.phase = 'buy';
            emit('PROPERTY_AVAILABLE', { playerId: active.id, position: landingPosition, amount: space.price });
          } else if (ownerId !== active.id && state.mortgaged[landingPosition]) {
            emit('NO_RENT_MORTGAGED', { playerId: active.id, ownerId, position: landingPosition });
          } else if (ownerId !== active.id) {
            const amount = calcRent(state, spaces, landingPosition);
            emit('RENT_DUE', { playerId: active.id, ownerId, position: landingPosition, amount });
            payMoney(active.id, amount, ownerId, false);
          } else {
            emit('LANDING_OWN_PROPERTY', { playerId: active.id, position: landingPosition });
          }
        } else if (space.type === 'tax') {
          emit('TAX_DUE', { playerId: active.id, position: landingPosition, amount: space.amount });
          payMoney(active.id, space.amount, null, false);
        } else if (space.type === 'gotojail') {
          emit('LANDING_GO_TO_JAIL', { playerId: active.id, position: landingPosition, jailPosition });
        } else if (space.type === 'chance' || space.type === 'chest') {
          emit('CARD_DRAW_REQUESTED', { playerId: active.id, position: landingPosition, deck: space.type });
        } else {
          emit('LANDING_NO_EFFECT', { playerId: active.id, position: landingPosition });
        }
        break;
      }
      case 'APPLY_CARD': {
        const card = action.card, active = player(actorId);
        if (!checkCurrent(actorId) || state.phase !== 'roll' || state.pendingMove || state.landingPending || !card || typeof card.action !== 'string') return fail('That card effect is invalid.');
        emit('CARD_DRAWN', { playerId: active.id, action: card.action, value: card.value == null ? null : card.value });
        if (card.action === 'money') {
          if (card.value >= 0) {
            active.money += card.value;
            emit('CARD_MONEY_COLLECTED', { playerId: active.id, amount: card.value });
          } else {
            payMoney(active.id, -card.value, null, false);
          }
        } else if (card.action === 'moveTo') {
          if (!Number.isInteger(card.value) || card.value < 0 || card.value >= state.owners.length) return fail('The card destination is invalid.');
          const steps = (card.value - active.pos + state.owners.length) % state.owners.length;
          requestMovement(active.id, steps, 1, 'card', card.value);
          emit('CARD_MOVEMENT_REQUESTED', { playerId: active.id, target: card.value, direction: 1, steps });
        } else if (card.action === 'moveBack') {
          if (!Number.isInteger(card.value) || card.value < 0) return fail('The card movement distance is invalid.');
          requestMovement(active.id, card.value, -1, 'card');
          emit('CARD_MOVEMENT_REQUESTED', { playerId: active.id, target: null, direction: -1, steps: card.value });
        } else if (card.action === 'jail') {
          active.pos = jailPosition;
          active.inJail = true;
          active.jailTurns = 0;
          state.rolledDouble = false;
          state.doubles = 0;
          state.pendingMove = null;
          state.landingPending = false;
          emit('PLAYER_JAILED', { playerId: active.id, position: jailPosition });
        } else if (card.action === 'collectFromAll') {
          if (!(card.value >= 0)) return fail('The card payment amount is invalid.');
          for (const other of state.players) {
            if (other.id !== active.id && !other.bankrupt) payMoney(other.id, card.value, active.id, false);
          }
        } else if (card.action === 'payAll') {
          if (!(card.value >= 0)) return fail('The card payment amount is invalid.');
          for (const other of state.players) {
            if (other.id !== active.id && !other.bankrupt && !payMoney(active.id, card.value, other.id, false)) break;
          }
        } else {
          return fail(`Unknown card effect: ${card.action}`);
        }
        emit('CARD_EFFECT_APPLIED', { playerId: active.id, action: card.action });
        break;
      }
      case 'PAY_DEBT': {
        const debt = state.debt;
        if (!debt || debt.pid !== actorId || player(debt.pid).money < debt.amount) return fail('The debt cannot be paid now.');
        const debtor = player(debt.pid);
        const creditor = debt.creditorId == null ? null : player(debt.creditorId);
        debtor.money -= debt.amount;
        if (creditor) creditor.money += debt.amount;
        emit('DEBT_PAID', { playerId: debtor.id, creditorId: creditor ? creditor.id : null, amount: debt.amount });
        finishAction();
        break;
      }
      case 'CONFIRM_BANKRUPTCY': {
        const debt = state.debt;
        if (!debt || debt.pid !== actorId) return fail('Bankruptcy cannot be declared by this player now.');
        if (!state.confirmBankrupt) {
          state.confirmBankrupt = true;
          emit('BANKRUPTCY_CONFIRMATION_REQUIRED', { playerId: actorId });
        } else {
          declareBankruptcy(debt.pid, debt.creditorId);
          finishAction();
        }
        break;
      }
      case 'PROPOSE_TRADE': {
        const trade = state.trade;
        if (!trade || trade.from !== actorId || !['edit', 'review'].includes(trade.stage)) return fail('This player cannot propose the current trade.');
        const validation = validateTrade(state, trade, spaces, interest);
        if (validation.code) {
          trade.error = validation.code;
          emit('TRADE_REJECTED', { validation });
        } else {
          trade.error = '';
          trade.stage = 'review';
          emit('TRADE_PROPOSED', { from: trade.from, to: trade.to });
        }
        break;
      }
      case 'ACCEPT_TRADE': {
        const trade = state.trade;
        if (!trade || trade.to !== actorId || trade.stage !== 'review') return fail('This player cannot accept the current trade.');
        if (!Number.isFinite(action.now) || !Number.isFinite(action.viewTradeMs) || action.viewTradeMs < 0) return fail('The completed-trade timestamp is invalid.');
        const validation = validateTrade(state, trade, spaces, interest);
        if (validation.code) {
          trade.error = validation.code;
          trade.stage = 'edit';
          trade.postponed = false;
          emit('TRADE_REJECTED', { validation });
          break;
        }
        const from = player(trade.from), to = player(trade.to);
        const completed = {
          from: from.id, to: to.id,
          give: trade.give.slice(), giveCash: trade.giveCash,
          get: trade.get.slice(), getCash: trade.getCash,
        };
        for (const position of completed.give) {
          state.owners[position] = to.id;
          if (state.mortgaged[position]) to.money -= Math.ceil(mortgageValue(spaces, position) * interest);
        }
        for (const position of completed.get) {
          state.owners[position] = from.id;
          if (state.mortgaged[position]) from.money -= Math.ceil(mortgageValue(spaces, position) * interest);
        }
        from.money += completed.getCash - completed.giveCash;
        to.money += completed.giveCash - completed.getCash;
        state.viewTrade = {
          fromName: from.name, toName: to.name,
          give: completed.give.slice(), giveCash: completed.giveCash,
          get: completed.get.slice(), getCash: completed.getCash,
          expiresAt: Number(action.now) + Number(action.viewTradeMs),
        };
        state.trade = null;
        emit('TRADE_COMPLETED', { trade: completed });
        break;
      }
      case 'CANCEL_TRADE':
      case 'DECLINE_TRADE': {
        const trade = state.trade;
        const expectedPlayer = action.type === 'CANCEL_TRADE' ? trade && trade.from : trade && trade.to;
        if (!trade || expectedPlayer !== actorId) return fail('This player cannot close the current trade.');
        state.trade = null;
        emit(action.type === 'CANCEL_TRADE' ? 'TRADE_CANCELLED' : 'TRADE_DECLINED', { from: trade.from, to: trade.to });
        break;
      }
      case 'POSTPONE_TRADE': {
        const trade = state.trade;
        if (!trade || trade.to !== actorId || trade.stage !== 'review') return fail('This player cannot postpone the current trade.');
        trade.postponed = true;
        emit('TRADE_POSTPONED', { from: trade.from, to: trade.to });
        break;
      }
      case 'START_TRADE_TIMER': {
        if (!Number.isFinite(action.now) || !Number.isFinite(action.durationMs) || action.durationMs < 0) return fail('The action timer input is invalid.');
        if (!state.over) state.tradeTimerEnd = action.now + action.durationMs;
        emit('ACTION_TIMER_STARTED', { expiresAt: state.tradeTimerEnd });
        break;
      }
      case 'SET_PAUSE': {
        if (state.over || !Number.isFinite(action.now)) return fail('The game cannot be paused now.');
        const paused = !!action.paused;
        if (paused === !!state.paused) break;
        if (paused) {
          state.paused = true;
          state.pausedAt = action.now;
          emit('GAME_PAUSED', { at: action.now });
        } else {
          const duration = action.now - (state.pausedAt || action.now);
          if (state.tradeTimerEnd) state.tradeTimerEnd += duration;
          if (state.viewTrade) state.viewTrade.expiresAt += duration;
          state.paused = false;
          state.pausedAt = null;
          emit('GAME_RESUMED', { at: action.now, duration });
        }
        break;
      }
      case 'GAME_TICK': {
        if (state.over || state.paused || !Number.isFinite(action.now)) return fail('The game timer cannot advance now.');
        if (state.viewTrade && action.now >= state.viewTrade.expiresAt) {
          state.viewTrade = null;
          emit('VIEW_TRADE_EXPIRED');
        }
        if (state.tradeTimerEnd && action.now >= state.tradeTimerEnd) {
          state.tradeTimerEnd = null;
          emit('ACTION_TIMER_EXPIRED', { blocked: !!action.blocked });
          if (!action.blocked) {
            if (state.phase === 'after' || (state.phase === 'roll' && state.doubles > 0)) endTurn();
            else if (state.phase === 'buy') startAuction(current().pos);
          }
        }
        break;
      }
      case 'BUY_PROPERTY': {
        if (!checkCurrent(actorId) || state.phase !== 'buy') return fail('Property can only be bought by the current player during the buy phase.');
        const space = spaces[position];
        if (!space || !space.price || state.owners[position] != null || position !== current().pos) return fail('That property is not available to buy.');
        if (current().money < space.price) return fail('There is not enough money to buy that property.');
        current().money -= space.price;
        state.owners[position] = actorId;
        emit('PROPERTY_PURCHASED', { playerId: actorId, position, amount: space.price });
        finishAction();
        break;
      }
      case 'DECLINE_PROPERTY':
      case 'START_AUCTION': {
        if (!checkCurrent(actorId) || state.phase !== 'buy' || position !== current().pos || !spaces[position] ||
            !spaces[position].price || state.owners[position] != null) return fail('An auction can only start for the current unowned property during the buy phase.');
        startAuction(position);
        break;
      }
      case 'BUY_HOUSE':
      case 'SELL_HOUSE':
      case 'MORTGAGE_PROPERTY':
      case 'UNMORTGAGE_PROPERTY': {
        if (!canManage(state) || !checkCurrent(actorId)) return fail('Property management is not available to this player now.');
        const space = spaces[position];
        if (!space) return fail('That board position does not exist.');
        const active = current();
        if (action.type === 'BUY_HOUSE') {
          if (!canBuild(state, spaces, position, actorId)) return fail('That house cannot be built under the current rules.');
          active.money -= space.houseCost;
          state.houses[position]++;
          emit('HOUSE_BUILT', { playerId: actorId, position, count: state.houses[position], amount: space.houseCost });
        } else if (action.type === 'SELL_HOUSE') {
          if (!canSell(state, spaces, position, actorId)) return fail('There is no house to sell on that property.');
          active.money += space.houseCost / 2;
          state.houses[position]--;
          emit('HOUSE_SOLD', { playerId: actorId, position, count: state.houses[position], amount: space.houseCost / 2 });
        } else if (action.type === 'MORTGAGE_PROPERTY') {
          if (!canMortgage(state, spaces, position, actorId)) return fail('That property cannot be mortgaged under the current rules.');
          state.mortgaged[position] = true;
          active.money += mortgageValue(spaces, position);
          emit('PROPERTY_MORTGAGED', { playerId: actorId, position, amount: mortgageValue(spaces, position) });
        } else {
          const cost = unmortgageCost(spaces, position, interest);
          if (state.owners[position] !== actorId || !state.mortgaged[position] || active.money < cost) return fail('That property cannot be unmortgaged now.');
          state.mortgaged[position] = false;
          active.money -= cost;
          emit('PROPERTY_UNMORTGAGED', { playerId: actorId, position, amount: cost });
        }
        break;
      }
      case 'PAY_JAIL_FINE': {
        if (!checkCurrent(actorId) || state.phase !== 'roll' || !current().inJail || current().money < jailFine) return fail('The jail fine cannot be paid now.');
        current().money -= jailFine;
        current().inJail = false;
        current().jailTurns = 0;
        emit('JAIL_FINE_PAID', { playerId: actorId, amount: jailFine });
        break;
      }
      case 'COMPLETE_ACTION':
        if (state.phase !== 'roll' || state.pendingMove || state.landingPending) return fail('The current move must resolve before the action can finish.');
        finishAction();
        break;
      case 'END_TURN': {
        if (state.over || !current() || state.pendingMove || state.landingPending || !(state.phase === 'after' || (state.phase === 'roll' && state.doubles > 0) || current().bankrupt)) {
          return fail('The turn cannot end during this phase.');
        }
        endTurn();
        break;
      }
      case 'AUCTION_BID': {
        const auction = state.auction;
        if (!auction || auction.turn !== actorId) return fail('It is not that player\'s auction turn.');
        const amount = Math.floor(Number(action.amount));
        const bidder = player(actorId);
        if (!(amount > auction.high) || amount > bidder.money) return fail('That bid is not legal.');
        auction.high = amount;
        auction.highId = actorId;
        const index = auction.active.indexOf(actorId);
        let next = auction.active[(index + 1) % auction.active.length];
        if (auction.active.length === 1 && auction.highId === auction.active[0]) finishAuction(auction.highId);
        else {
          if (next === auction.highId && auction.active.length > 1) next = auction.active[(auction.active.indexOf(next) + 1) % auction.active.length];
          auction.turn = next;
        }
        emit('AUCTION_BID_PLACED', { playerId: actorId, position: auction.pos, amount });
        break;
      }
      case 'AUCTION_FOLD': {
        const auction = state.auction;
        if (!auction || auction.turn !== actorId) return fail('It is not that player\'s auction turn.');
        const foldedId = actorId;
        const index = auction.active.indexOf(actorId);
        auction.active.splice(index, 1);
        if (auction.active.length === 0) finishAuction(null);
        else if (auction.active.length === 1 && auction.highId === auction.active[0]) finishAuction(auction.highId);
        else {
          let next = auction.active[index % auction.active.length];
          if (next === auction.highId && auction.active.length > 1) next = auction.active[(auction.active.indexOf(next) + 1) % auction.active.length];
          auction.turn = next;
        }
        emit('AUCTION_PLAYER_FOLDED', { playerId: foldedId });
        break;
      }
      default:
        return fail(`Unknown game action: ${action.type}`);
    }

    return { state, events, error: null };
  }

  return {
    defaultPlayerNames: DEFAULT_PLAYER_NAMES,
    createState,
    cloneState,
    serializeState,
    deserializeState,
    currentPlayer,
    groupSquares,
    ownsFullSet,
    groupHasHouses,
    groupHasMortgage,
    countOwned,
    ownedSquares,
    calcRent,
    canManage,
    canBuild,
    canSell,
    mortgageValue,
    unmortgageCost,
    canMortgage,
    isTradable,
    validateTrade,
    legalActions,
    applyAction,
    calculateNetWorth,
    computeFinalResults,
  };
});