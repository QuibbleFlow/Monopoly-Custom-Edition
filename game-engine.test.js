const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('./game-engine.js');

const spaces = Array.from({ length: 40 }, (_, index) => ({ type: 'blank', name: `Space ${index}` }));
spaces[1] = { type: 'property', name: 'First', group: 'brown', price: 60, houseCost: 50, rents: [2, 10, 30, 90, 160, 250] };
spaces[3] = { type: 'property', name: 'Second', group: 'brown', price: 60, houseCost: 50, rents: [4, 20, 60, 180, 320, 450] };
spaces[5] = { type: 'railroad', name: 'Rail A', price: 200 };
spaces[15] = { type: 'railroad', name: 'Rail B', price: 200 };
spaces[12] = { type: 'utility', name: 'Utility A', price: 150 };
spaces[28] = { type: 'utility', name: 'Utility B', price: 150 };

const rules = { spaces, jailFine: 50, jailPosition: 10, goSalary: 200, mortgageInterest: 0.1 };
const newState = () => engine.createState({
  names: ['A', 'B', 'C'], accountIds: ['account-a', null, 'account-c'], boardSize: spaces.length,
});
const apply = (state, action) => engine.applyAction(state, action, rules);
const applyWithSpaces = (state, action, board) => engine.applyAction(state, action, { ...rules, spaces: board });

test('initializes and round-trips a complete JSON state with account IDs', () => {
  const state = newState();
  const restored = engine.deserializeState(engine.serializeState(state));
  assert.deepEqual(restored, state);
  assert.equal(restored.players[0].accountId, 'account-a');
  assert.equal(restored.players[1].accountId, null);
  assert.equal(restored.owners.length, 40);
});

test('initializes all eight player seats with defined default colors', () => {
  const names = Array.from({ length: 8 }, (_, index) => `Player ${index + 1}`);
  const state = engine.createState({ names });

  assert.deepEqual(engine.defaultPlayerNames, names);
  assert.deepEqual(state.players.map(player => player.name), names);
  assert.ok(state.players.every(player => typeof player.color === 'string'));
  assert.equal(new Set(state.players.map(player => player.color)).size, 8);
});

test('restores older snapshots into the current serializable state shape', () => {
  const old = newState();
  delete old.started;
  delete old.pendingMove;
  delete old.landingPending;
  delete old.winnerId;
  delete old.turn;
  old.winner = { id: 1, name: 'B' };
  const restored = engine.deserializeState(old);
  assert.equal(restored.started, true);
  assert.equal(restored.pendingMove, null);
  assert.equal(restored.landingPending, false);
  assert.equal(restored.turn, 1);
  assert.equal(restored.winnerId, 1);
  assert.equal(Object.hasOwn(restored, 'winner'), false);
});

test('sets the random starting order only from a complete explicit permutation', () => {
  const state = newState();
  const result = apply(state, { type: 'SET_TURN_ORDER', order: [2, 0, 1] });
  assert.deepEqual(result.state.turnOrder, [2, 0, 1]);
  assert.equal(engine.currentPlayer(result.state).id, 2);
  assert.deepEqual(state.turnOrder, [0, 1, 2]);
  assert.ok(apply(state, { type: 'SET_TURN_ORDER', order: [0, 0, 2] }).error);
});

test('legal action discovery reflects phase, debt, auction, trade, and paused state', () => {
  const state = newState();
  assert.deepEqual(engine.legalActions(state, spaces), []);
  state.started = true;
  assert.ok(engine.legalActions(state, spaces).some(action => action.type === 'ROLL_DICE'));
  state.phase = 'debt';
  state.debt = { pid: 0, amount: 100, creditorId: null };
  assert.ok(engine.legalActions(state, spaces).some(action => action.type === 'PAY_DEBT'));
  state.auction = { pos: 1, high: 0, highId: null, active: [1, 0], turn: 1 };
  assert.ok(engine.legalActions(state, spaces).some(action => action.type === 'AUCTION_FOLD' && action.playerId === 1));
  state.trade = { from: 0, to: 1, give: [], get: [], stage: 'review' };
  assert.ok(engine.legalActions(state, spaces).some(action => action.type === 'ACCEPT_TRADE' && action.playerId === 1));
  state.paused = true;
  assert.deepEqual(engine.legalActions(state, spaces), []);
});

test('roll actions accept explicit dice and describe movement without mutating input', () => {
  const state = newState();
  const result = apply(state, { type: 'ROLL_DICE', playerId: 0, dice: [4, 4] });
  assert.equal(result.error, null);
  assert.equal(state.dice[0], 0);
  assert.deepEqual(result.state.dice, [4, 4]);
  assert.equal(result.state.rolledDouble, true);
  assert.ok(result.events.some(event => event.type === 'MOVE_REQUESTED' && event.steps === 8));
});

test('third consecutive doubles sends the player to jail', () => {
  const state = newState();
  state.doubles = 2;
  const result = apply(state, { type: 'ROLL_DICE', playerId: 0, dice: [2, 2] });
  assert.equal(result.state.players[0].pos, 10);
  assert.equal(result.state.players[0].inJail, true);
  assert.equal(result.state.doubles, 0);
  assert.ok(result.events.some(event => event.type === 'THREE_DOUBLES_JAIL'));
});

test('jail roll attempts and doubles release are deterministic', () => {
  const jailed = newState();
  jailed.players[0].inJail = true;
  const failed = apply(jailed, { type: 'ROLL_DICE', playerId: 0, dice: [1, 2] });
  assert.equal(failed.state.players[0].jailTurns, 1);
  assert.ok(failed.events.some(event => event.type === 'JAIL_ROLL_FAILED'));
  const released = apply(jailed, { type: 'ROLL_DICE', playerId: 0, dice: [3, 3] });
  assert.equal(released.state.players[0].inJail, false);
  assert.ok(released.events.some(event => event.type === 'MOVE_REQUESTED' && event.steps === 6));
});

test('movement calculates wraparound and GO salary in the engine', () => {
  const state = newState();
  state.players[0].pos = 39;
  state.pendingMove = { playerId: 0, steps: 1, direction: 1, source: 'test', target: null };
  const result = apply(state, { type: 'MOVE_STEP', playerId: 0, direction: 1 });
  assert.equal(result.state.players[0].pos, 0);
  assert.equal(result.state.players[0].money, 1700);
  assert.ok(result.events.some(event => event.type === 'GO_SALARY_COLLECTED' && event.amount === 200));
});

test('movement must finish before landing can be resolved and cannot be resolved twice', () => {
  const state = newState();
  const rolled = apply(state, { type: 'ROLL_DICE', playerId: 0, dice: [1, 2] });
  assert.ok(apply(rolled.state, { type: 'LAND_ON_SPACE', playerId: 0 }).error);
  assert.ok(apply(rolled.state, { type: 'MOVE_STEP', playerId: 0, direction: -1 }).error);
  let moved = rolled.state;
  for (let step = 0; step < 3; step++) moved = apply(moved, { type: 'MOVE_STEP', playerId: 0, direction: 1 }).state;
  assert.equal(moved.players[0].pos, 3);
  const landing = apply(moved, { type: 'LAND_ON_SPACE', playerId: 0 });
  assert.equal(landing.error, null);
  assert.ok(apply(landing.state, { type: 'LAND_ON_SPACE', playerId: 0 }).error);
});

test('a complete opening turn preserves the existing doubles, purchase, money, and turn rules', () => {
  let state = apply(newState(), { type: 'SET_TURN_ORDER', order: [0, 1, 2] }).state;
  state = apply(state, { type: 'ROLL_DICE', playerId: 0, dice: [1, 1] }).state;
  for (let step = 0; step < 2; step++) state = apply(state, { type: 'MOVE_STEP', playerId: 0, direction: 1 }).state;
  state = apply(state, { type: 'LAND_ON_SPACE', playerId: 0 }).state;
  state = apply(state, { type: 'COMPLETE_ACTION' }).state;
  assert.equal(state.phase, 'roll');
  assert.equal(state.rolledDouble, true);

  state = apply(state, { type: 'ROLL_DICE', playerId: 0, dice: [1, 2] }).state;
  for (let step = 0; step < 3; step++) state = apply(state, { type: 'MOVE_STEP', playerId: 0, direction: 1 }).state;
  state = apply(state, { type: 'LAND_ON_SPACE', playerId: 0 }).state;
  assert.equal(state.phase, 'buy');
  state = apply(state, { type: 'BUY_PROPERTY', playerId: 0, position: 5 }).state;
  assert.equal(state.owners[5], 0);
  assert.equal(state.players[0].money, 1300);
  assert.equal(state.phase, 'after');
  state = apply(state, { type: 'END_TURN', playerId: 0 }).state;
  assert.equal(engine.currentPlayer(state).id, 1);
  assert.equal(state.turn, 2);
});

test('landing resolves unowned deeds, rent, mortgages, tax, and cards', () => {
  const state = newState();
  state.players[0].pos = 1;
  state.landingPending = true;
  const available = apply(state, { type: 'LAND_ON_SPACE', playerId: 0 });
  assert.equal(available.state.phase, 'buy');
  assert.ok(available.events.some(event => event.type === 'PROPERTY_AVAILABLE' && event.amount === 60));

  state.owners[1] = 1;
  const rent = apply(state, { type: 'LAND_ON_SPACE', playerId: 0 });
  assert.ok(rent.events.some(event => event.type === 'RENT_DUE' && event.ownerId === 1 && event.amount === 2));
  state.mortgaged[1] = true;
  assert.ok(apply(state, { type: 'LAND_ON_SPACE', playerId: 0 }).events.some(event => event.type === 'NO_RENT_MORTGAGED'));

  spaces[4] = { type: 'tax', name: 'Tax', amount: 200 };
  state.players[0].pos = 4;
  state.landingPending = true;
  assert.ok(apply(state, { type: 'LAND_ON_SPACE', playerId: 0 }).events.some(event => event.type === 'TAX_DUE' && event.amount === 200));
  spaces[7] = { type: 'chance', name: 'Chance' };
  state.players[0].pos = 7;
  state.landingPending = true;
  assert.ok(apply(state, { type: 'LAND_ON_SPACE', playerId: 0 }).events.some(event => event.type === 'CARD_DRAW_REQUESTED' && event.deck === 'chance'));
});

test('card effects apply money, payments, movement requests, and jail state deterministically', () => {
  const state = newState();
  const collected = apply(state, { type: 'APPLY_CARD', playerId: 0, card: { action: 'money', value: 100 } });
  assert.equal(collected.state.players[0].money, 1600);
  assert.equal(state.players[0].money, 1500);

  const birthday = apply(state, { type: 'APPLY_CARD', playerId: 0, card: { action: 'collectFromAll', value: 10 } });
  assert.equal(birthday.state.players[0].money, 1520);
  assert.equal(birthday.state.players[1].money, 1490);
  const fee = apply(state, { type: 'APPLY_CARD', playerId: 0, card: { action: 'payAll', value: 50 } });
  assert.equal(fee.state.players[0].money, 1400);
  assert.equal(fee.state.players[2].money, 1550);

  state.players[0].pos = 36;
  const move = apply(state, { type: 'APPLY_CARD', playerId: 0, card: { action: 'moveTo', value: 0 } });
  assert.equal(move.state.players[0].pos, 36);
  assert.ok(move.events.some(event => event.type === 'CARD_MOVEMENT_REQUESTED' && event.steps === 4));
  const jail = apply(state, { type: 'APPLY_CARD', playerId: 0, card: { action: 'jail' } });
  assert.equal(jail.state.players[0].pos, 10);
  assert.equal(jail.state.players[0].inJail, true);
});

test('property purchase validates phase, turn, ownership, and cash', () => {
  const state = newState();
  state.phase = 'buy';
  state.players[0].pos = 1;
  const purchased = apply(state, { type: 'BUY_PROPERTY', playerId: 0, position: 1 });
  assert.equal(purchased.state.players[0].money, 1440);
  assert.equal(purchased.state.owners[1], 0);
  assert.equal(purchased.state.phase, 'after');
  assert.equal(state.players[0].money, 1500);

  assert.ok(apply(state, { type: 'BUY_PROPERTY', playerId: 1, position: 1 }).error);
  state.players[0].money = 1;
  assert.ok(apply(state, { type: 'BUY_PROPERTY', playerId: 0, position: 1 }).error);
  state.players[0].money = 1500;
  state.phase = 'roll';
  assert.ok(apply(state, { type: 'BUY_PROPERTY', playerId: 0, position: 1 }).error);
});

test('building requires an unmortgaged color set and updates cash', () => {
  const state = newState();
  state.phase = 'after';
  state.owners[1] = 0;
  assert.ok(apply(state, { type: 'BUY_HOUSE', playerId: 0, position: 1 }).error);
  state.owners[3] = 0;
  const built = apply(state, { type: 'BUY_HOUSE', playerId: 0, position: 1 });
  assert.equal(built.state.houses[1], 1);
  assert.equal(built.state.players[0].money, 1450);
  const sold = apply(built.state, { type: 'SELL_HOUSE', playerId: 0, position: 1 });
  assert.equal(sold.state.houses[1], 0);
  assert.equal(sold.state.players[0].money, 1475);
  state.mortgaged[3] = true;
  assert.ok(apply(state, { type: 'BUY_HOUSE', playerId: 0, position: 1 }).error);
});

test('rent reflects color sets, houses, railroads, utilities, and mortgages', () => {
  const state = newState();
  state.owners[1] = 0;
  assert.equal(engine.calcRent(state, spaces, 1), 2);
  state.owners[3] = 0;
  assert.equal(engine.calcRent(state, spaces, 1), 4);
  state.houses[1] = 1;
  assert.equal(engine.calcRent(state, spaces, 1), 10);
  state.owners[5] = 0;
  assert.equal(engine.calcRent(state, spaces, 5), 25);
  state.owners[15] = 0;
  assert.equal(engine.calcRent(state, spaces, 5), 50);
  state.owners[12] = 0;
  state.dice = [3, 4];
  assert.equal(engine.calcRent(state, spaces, 12), 28);
  state.owners[28] = 0;
  assert.equal(engine.calcRent(state, spaces, 12), 70);
  state.mortgaged[12] = true;
  assert.equal(engine.calcRent(state, spaces, 12), 70);
});

test('mortgage transitions respect houses and charge the existing ten percent fee', () => {
  const state = newState();
  state.phase = 'after';
  state.owners[1] = 0;
  const mortgaged = apply(state, { type: 'MORTGAGE_PROPERTY', playerId: 0, position: 1 });
  assert.equal(mortgaged.state.mortgaged[1], true);
  assert.equal(mortgaged.state.players[0].money, 1530);
  const unmortgaged = apply(mortgaged.state, { type: 'UNMORTGAGE_PROPERTY', playerId: 0, position: 1 });
  assert.equal(unmortgaged.state.mortgaged[1], false);
  assert.equal(unmortgaged.state.players[0].money, 1497);
});

test('payments create debt, allow liquidation, and settle with a creditor', () => {
  const state = newState();
  state.players[0].money = 10;
  state.owners[5] = 0;
  state.players[0].pos = 1;
  state.owners[1] = 1;
  state.landingPending = true;
  const board = spaces.map(space => ({ ...space, rents: space.rents && space.rents.slice() }));
  board[1].rents[0] = 50;
  const debt = applyWithSpaces(state, { type: 'LAND_ON_SPACE', playerId: 0, position: 1 }, board);
  assert.deepEqual(debt.state.debt, { pid: 0, amount: 50, creditorId: 1 });
  assert.equal(debt.state.phase, 'debt');

  const mortgage = applyWithSpaces(debt.state, { type: 'MORTGAGE_PROPERTY', playerId: 0, position: 5 }, board);
  assert.equal(mortgage.state.players[0].money, 110);
  const settled = applyWithSpaces(mortgage.state, { type: 'PAY_DEBT', playerId: 0 }, board);
  assert.equal(settled.state.players[0].money, 60);
  assert.equal(settled.state.players[1].money, 1550);
  assert.equal(settled.state.debt, null);
});

test('automatic payment liquidates assets in rule order or declares bankruptcy', () => {
  const state = newState();
  state.players[1].money = 0;
  state.owners[5] = 1;
  const settled = apply(state, { type: 'APPLY_CARD', playerId: 0, card: { action: 'collectFromAll', value: 80 } });
  assert.ok(settled.events.some(event => event.type === 'PROPERTY_FORCED_MORTGAGED' && event.position === 5));
  assert.ok(settled.events.some(event => event.type === 'PAYMENT_SETTLED'));
  assert.equal(settled.state.players[1].bankrupt, false);

  const bankruptState = newState();
  bankruptState.players = bankruptState.players.slice(0, 2);
  bankruptState.turnOrder = [0, 1];
  bankruptState.players[1].money = 0;
  const bankrupt = apply(bankruptState, { type: 'APPLY_CARD', playerId: 0, card: { action: 'collectFromAll', value: 1 } });
  assert.equal(bankrupt.state.players[1].bankrupt, true);
  assert.equal(bankrupt.state.winnerId, 0);
  assert.equal(bankrupt.state.over, true);
});

test('bankruptcy requires confirmation and leaves winner as a serializable player ID', () => {
  const state = newState();
  state.players = state.players.slice(0, 2);
  state.turnOrder = [0, 1];
  state.players[1].money = 0;
  state.debt = { pid: 1, amount: 100, creditorId: null };
  state.phase = 'debt';
  const confirm = apply(state, { type: 'CONFIRM_BANKRUPTCY', playerId: 1 });
  assert.equal(confirm.state.players[1].bankrupt, false);
  const declared = apply(confirm.state, { type: 'CONFIRM_BANKRUPTCY', playerId: 1 });
  assert.equal(declared.state.players[1].bankrupt, true);
  assert.equal(declared.state.winnerId, 0);
  assert.equal(JSON.parse(engine.serializeState(declared.state)).winnerId, 0);
});

test('auction bids and folds award the property and advance the phase', () => {
  const state = newState();
  state.phase = 'buy';
  state.players[0].pos = 1;
  const started = apply(state, { type: 'DECLINE_PROPERTY', playerId: 0 });
  assert.deepEqual(started.state.auction.active, [1, 2, 0]);
  const bid = apply(started.state, { type: 'AUCTION_BID', playerId: 1, amount: 40 });
  const fold = apply(bid.state, { type: 'AUCTION_FOLD', playerId: 2 });
  const won = apply(fold.state, { type: 'AUCTION_FOLD', playerId: 0 });
  assert.equal(won.state.owners[1], 1);
  assert.equal(won.state.players[1].money, 1460);
  assert.equal(won.state.phase, 'after');
  assert.ok(won.events.some(event => event.type === 'AUCTION_ENDED' && event.winnerId === 1));
});

test('ending a turn skips eliminated players', () => {
  const state = newState();
  state.phase = 'after';
  state.players[1].bankrupt = true;
  const result = apply(state, { type: 'END_TURN', playerId: 0 });
  assert.equal(result.state.current, 2);
  assert.equal(result.state.turn, 2);
  assert.equal(result.state.phase, 'roll');
});

test('action timers expire into a turn advance or auction and respect animation blocking', () => {
  const after = newState();
  after.phase = 'after';
  after.tradeTimerEnd = 1000;
  const ended = apply(after, { type: 'GAME_TICK', now: 1000, blocked: false });
  assert.equal(ended.state.current, 1);
  assert.equal(ended.state.tradeTimerEnd, null);
  assert.ok(ended.events.some(event => event.type === 'TURN_CHANGED'));

  const buying = newState();
  buying.phase = 'buy';
  buying.players[0].pos = 1;
  buying.tradeTimerEnd = 1000;
  const auction = apply(buying, { type: 'GAME_TICK', now: 1000, blocked: false });
  assert.equal(auction.state.phase, 'auction');
  assert.equal(auction.state.auction.pos, 1);

  const blocked = apply(after, { type: 'GAME_TICK', now: 1000, blocked: true });
  assert.equal(blocked.state.current, 0);
  assert.equal(blocked.state.tradeTimerEnd, null);
});

test('pause/resume shifts game deadlines by the explicit paused duration', () => {
  const state = newState();
  state.tradeTimerEnd = 10000;
  state.viewTrade = { expiresAt: 11000 };
  const paused = apply(state, { type: 'SET_PAUSE', paused: true, now: 100 });
  const resumed = apply(paused.state, { type: 'SET_PAUSE', paused: false, now: 500 });
  assert.equal(resumed.state.tradeTimerEnd, 10400);
  assert.equal(resumed.state.viewTrade.expiresAt, 11400);
  assert.equal(resumed.state.paused, false);
  assert.equal(resumed.state.pausedAt, null);
});

test('trade proposals validate ownership and acceptance settles cash, deeds, and mortgage fees', () => {
  const state = newState();
  state.owners[1] = 0;
  state.owners[3] = 1;
  state.mortgaged[1] = true;
  state.mortgaged[3] = true;
  state.trade = { from: 0, to: 1, giveCash: 30, getCash: 10, give: [1], get: [3], stage: 'edit', error: '' };
  const proposed = apply(state, { type: 'PROPOSE_TRADE', playerId: 0 });
  assert.equal(proposed.state.trade.stage, 'review');
  const accepted = apply(proposed.state, { type: 'ACCEPT_TRADE', playerId: 1, now: 1000, viewTradeMs: 10000 });
  assert.equal(accepted.state.trade, null);
  assert.equal(accepted.state.owners[1], 1);
  assert.equal(accepted.state.owners[3], 0);
  assert.equal(accepted.state.players[0].money, 1477);
  assert.equal(accepted.state.players[1].money, 1517);
  assert.equal(accepted.state.viewTrade.expiresAt, 11000);
  assert.ok(accepted.events.some(event => event.type === 'TRADE_COMPLETED'));
});

test('trades cannot include unowned properties or properties in a developed set', () => {
  const state = newState();
  state.owners[1] = 0;
  state.owners[3] = 0;
  state.houses[1] = 1;
  const trade = { from: 0, to: 1, giveCash: 0, getCash: 0, give: [1], get: [], stage: 'edit' };
  assert.equal(engine.validateTrade(state, trade, spaces).code, 'PROPERTY_NOT_TRADABLE');
  state.houses[1] = 0;
  state.owners[1] = null;
  assert.equal(engine.validateTrade(state, trade, spaces).code, 'PROPERTY_NOT_TRADABLE');
});

test('net worth counts cash plus unmortgaged property price, mortgage value, and full house cost', () => {
  const state = newState();
  assert.equal(engine.calculateNetWorth(state, spaces, 0), state.players[0].money);

  state.owners[1] = 0;
  state.houses[1] = 2;
  assert.equal(engine.calculateNetWorth(state, spaces, 0), state.players[0].money + 60 + 2 * 50);

  state.owners[3] = 0;
  state.mortgaged[3] = true;
  assert.equal(engine.calculateNetWorth(state, spaces, 0), state.players[0].money + 60 + 2 * 50 + 30);

  assert.equal(engine.calculateNetWorth(state, spaces, 99), 0);
});

test('final results rank the winner first and the rest by reverse bankruptcy order, with authoritative money and net worth', () => {
  const state = newState();
  state.over = true;
  state.winnerId = 0;
  // Player 2 went bankrupt before player 1 did, so player 1 (eliminated
  // more recently) should place above player 2.
  state.eliminatedOrder = [2, 1];
  state.players[0].money = 1500;
  state.owners[1] = 0;
  state.players[1].money = 0;
  state.players[2].money = 0;

  const results = engine.computeFinalResults(state, spaces);
  assert.deepEqual(results.map(entry => entry.placement), [1, 2, 3]);
  assert.deepEqual(results.map(entry => entry.playerId), [0, 1, 2]);
  assert.deepEqual(results.map(entry => entry.accountId), ['account-a', null, 'account-c']);
  assert.equal(results[0].money, 1500);
  assert.equal(results[0].netWorth, 1500 + 60);
  assert.equal(results[1].money, 0);
  assert.equal(results[1].netWorth, 0);
  assert.equal(results[2].money, 0);
  assert.equal(results[2].netWorth, 0);

  const notOver = newState();
  assert.equal(engine.computeFinalResults(notOver, spaces), null);
});

const { handleGameAction, executeGameAction } = require('./api-handlers/game/action.js');

function makeRes() {
  return {
    headers: {},
    statusCode: 200,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function tagSql(rowsByQuery) {
  const sql = Object.assign(async function sql(strings, ...values) {
    const key = strings.reduce((result, part, index) => {
      const value = index < values.length ? `$${index + 1}` : '';
      return result + part + value;
    }, '').replace(/\s+/g, ' ').trim();
    return rowsByQuery[key] || [];
  }, {
    async begin(callback) {
      return callback(sql);
    },
  });
  return sql;
}

test('unauthenticated action requests are rejected', async () => {
  const res = makeRes();
  await handleGameAction({ method: 'POST', body: { gameId: 'game-1', action: { type: 'ROLL_DICE', playerId: 0 }, version: 1 }, headers: {} }, res, {
    currentAccount: async () => null,
    database: () => tagSql({}),
  });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'Sign in to continue.' });
});

test('player authorization and stale version checks are enforced', async () => {
  const baseState = newState();
  baseState.started = true;
  baseState.phase = 'roll';
  const sql = tagSql({
    'SELECT id, version, state, board FROM game_states WHERE id = $1 FOR UPDATE': [{ id: 'game-1', version: 2, state: engine.serializeState(baseState), board: { spaces } }],
  });
  const res = makeRes();
  await handleGameAction({ method: 'POST', body: { gameId: 'game-1', action: { type: 'ROLL_DICE', playerId: 1 }, version: 1 }, headers: {} }, res, {
    currentAccount: async () => ({ id: 'account-a', username: 'alice' }),
    database: () => sql,
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error.code, 'STALE_VERSION');

  const wrongPlayer = makeRes();
  await handleGameAction({ method: 'POST', body: { gameId: 'game-1', action: { type: 'ROLL_DICE', playerId: 1 }, version: 2 }, headers: {} }, wrongPlayer, {
    currentAccount: async () => ({ id: 'account-z', username: 'zack' }),
    database: () => sql,
  });
  assert.equal(wrongPlayer.statusCode, 403);
  assert.equal(wrongPlayer.body.error.code, 'PLAYER_NOT_IN_GAME');
});

test('valid action flow generates server-controlled dice and increments version', async () => {
  const baseState = newState();
  baseState.started = true;
  baseState.phase = 'roll';
  const sql = tagSql({
    'SELECT id, version, state, board FROM game_states WHERE id = $1 FOR UPDATE': [{ id: 'game-1', version: 1, state: engine.serializeState(baseState), board: { spaces } }],
    'UPDATE game_states SET state = $1, version = $2, updated_at = now() WHERE id = $3': [{ ok: true }],
    'INSERT INTO game_action_requests (game_id, request_id, result_json) VALUES ($1, $2, $3) ON CONFLICT (game_id, request_id) DO NOTHING RETURNING result_json': [{ ok: true }],
  });

  const result = await executeGameAction({
    account: { id: 'account-a', username: 'alice' },
    gameId: 'game-1',
    action: { type: 'ROLL_DICE', playerId: 0 },
    version: 1,
    requestId: 'req-1',
    sql,
    random: () => 0.5,
  });

  assert.equal(result.ok, true);
  assert.equal(result.version, 2);
  assert.deepEqual(result.state.dice, [4, 4]);
  assert.ok(result.events.some(event => event.type === 'DICE_ROLLED'));
});

test('duplicate request IDs are treated as idempotent and cannot reapply the action', async () => {
  const baseState = newState();
  baseState.started = true;
  baseState.phase = 'roll';
  const seen = new Map();
  const sql = Object.assign(async function sql(strings, ...values) {
    const query = strings.reduce((result, part, index) => {
      const value = index < values.length ? `$${index + 1}` : '';
      return result + part + value;
    }, '').replace(/\s+/g, ' ').trim();
    if (query.startsWith('SELECT id, version, state, board FROM game_states')) {
      return [{ id: 'game-1', version: 1, state: engine.serializeState(baseState), board: { spaces } }];
    }
    if (query.startsWith('SELECT result_json FROM game_action_requests')) {
      return seen.has('req-duplicate') ? [{ result_json: JSON.stringify({ ok: true, version: 2, state: baseState, events: [{ type: 'DICE_ROLLED', playerId: 0, dice: [4, 4], isDouble: true }] }) }] : [];
    }
    if (query.startsWith('INSERT INTO game_action_requests')) {
      seen.set('req-duplicate', true);
      return [{ result_json: JSON.stringify({ ok: true, version: 2, state: baseState, events: [{ type: 'DICE_ROLLED', playerId: 0, dice: [4, 4], isDouble: true }] }) }];
    }
    if (query.startsWith('UPDATE game_states')) return [{ ok: true }];
    return [];
  }, {
    async begin(callback) { return callback(sql); },
  });

  const duplicate = await executeGameAction({
    account: { id: 'account-a', username: 'alice' },
    gameId: 'game-1',
    action: { type: 'ROLL_DICE', playerId: 0 },
    version: 1,
    requestId: 'req-duplicate',
    sql,
    random: () => 0.5,
  });

  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.version, 2);
  assert.deepEqual(duplicate.events[0], { type: 'DICE_ROLLED', playerId: 0, dice: [4, 4], isDouble: true });
});