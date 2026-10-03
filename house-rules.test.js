const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('./house-rules');
const cards = require('./game-cards');
const engine = require('./game-engine');
const { spaces } = require('./game-board');
const { createGame, joinGame, startGame, pauseGame } = require('./api-handlers/game/lifecycle');
const { getGameState } = require('./api-handlers/game/state');
const { executeGameAction } = require('./api-handlers/game/action');
const { loadGame, resumeGame } = require('./api-handlers/game/saves');
const { makeDb } = require('./test-support/mock-db');
function state(houseRules = {}) { return engine.createState({ names: ['A', 'B'], houseRules }); }
function act(current, action) {
  const result = engine.applyAction(current, { playerId: 0, ...action }, { spaces });
  assert.equal(result.error, null);
  return result;
}
function land(current, position) {
  current.players[0].pos = position; current.phase = 'roll'; current.landingPending = true;
  return act(current, { type: 'LAND_ON_SPACE' });
}
test('house rules default off and reject invalid multipliers and toggle values', () => {
  assert.deepEqual(rules.normalize(), { moneyMultiplier: 1, freeParkingJackpot: false, doubleGo: false });
  for (const value of [0, -1, 1.5, 10001, Infinity, '1000']) assert.throws(() => rules.normalize({ moneyMultiplier: value }));
  assert.throws(() => rules.normalize({ freeParkingJackpot: 'true' }));
  assert.throws(() => rules.normalize({ doubleGo: 1 }));
  assert.equal(state().matchSpaces, undefined);
});
test('money scaling clones the match board and scales cash, prices, buildings, tax and rents once', () => {
  const before = JSON.stringify(spaces), current = state({ moneyMultiplier: 1000 });
  assert.equal(current.players[0].money, 1500000);
  assert.equal(current.rules.goSalary, 200000); assert.equal(current.rules.jailFine, 50000);
  assert.equal(current.matchSpaces[39].price, 400000);
  assert.equal(current.matchSpaces[39].houseCost, 200000);
  assert.equal(current.matchSpaces[4].amount, 200000);
  current.owners[39] = 1;
  assert.equal(engine.calcRent(current, spaces, 39), 50000);
  current.owners[5] = 1; current.owners[12] = 1; current.dice = [2, 3];
  assert.equal(engine.calcRent(current, spaces, 5), 25000);
  assert.equal(engine.calcRent(current, spaces, 12), 20000);
  current.owners[28] = 1;
  assert.equal(engine.calcRent(current, spaces, 12), 50000);
  const restored = engine.deserializeState(engine.serializeState(current));
  assert.equal(engine.calcRent(restored, restored.matchSpaces, 39), 50000);
  assert.equal(JSON.stringify(spaces), before);
});
test('scaled purchases, houses, mortgages, valuation and legality agree', () => {
  let current = state({ moneyMultiplier: 100 }); current.started = true; current.phase = 'buy'; current.players[0].pos = 1;
  current = act(current, { type: 'BUY_PROPERTY' }).state;
  assert.equal(current.players[0].money, 144000);
  current.owners[3] = 0; current.phase = 'after';
  current = act(current, { type: 'BUY_HOUSE', position: 1 }).state;
  assert.equal(current.players[0].money, 139000);
  assert.equal(engine.calculateNetWorth(current, spaces, 0), 156000);
  current = act(current, { type: 'SELL_HOUSE', position: 1 }).state;
  current = act(current, { type: 'MORTGAGE_PROPERTY', position: 1 }).state;
  assert.equal(current.players[0].money, 144500);
  current.players[0].money = 3299;
  assert.ok(!engine.legalActions(current, spaces).some(a => a.type === 'UNMORTGAGE_PROPERTY' && a.position === 1));
});
test('card text changes exact amounts and preserves unrelated numbers, words and punctuation', () => {
  const card = { text: 'Holiday fund matures. Collect $100. Room 100, year 2100, 10%.', action: 'money', value: 100 };
  const shown = rules.scaleCard(card, { moneyMultiplier: 1000 });
  assert.equal(shown.text, 'Holiday fund matures. Collect $100000. Room 100, year 2100, 10%.');
  assert.equal(shown.value, 100000); assert.equal(card.value, 100);
  assert.equal(rules.scaleCard({ ...card, text: 'Collect 100!' }, { moneyMultiplier: 10 }).text, 'Collect 1000!');
  assert.equal(rules.scaleCard({ ...card, text: 'Collect $100. Keep $1000 and 100th.' }, { moneyMultiplier: 10 }).text, 'Collect $1000. Keep $1000 and 100th.');
  assert.equal(rules.scaleCard({ ...card, value: -100, text: 'Pay -$100, then rest.' }, { moneyMultiplier: 10 }).text, 'Pay -$1000, then rest.');
  assert.equal(rules.scaleCard({ ...card, value: 1000, text: 'Collect $1,000 or 1,000 dollars.' }, { moneyMultiplier: 1000 }).text, 'Collect $1,000,000 or 1,000,000 dollars.');
  assert.equal(rules.scaleCard({ ...card, text: 'Collect $100.00, exactly.' }, { moneyMultiplier: 1 }).text, 'Collect $100.00, exactly.');
});
test('fixed card amounts, repairs and money rules scale, percentages and distances do not', () => {
  const options = { moneyMultiplier: 1000 };
  for (const action of ['money', 'collectFromAll', 'payAll']) assert.equal(rules.scaleCard({ action, value: 100 }, options).value, 100000);
  const repairs = rules.scaleCard({ action: 'repairs', houseCost: 25, hotelCost: 100, text: 'Pay $25 per house and $100 per hotel, up to 4 houses.' }, options);
  assert.equal(repairs.houseCost, 25000); assert.equal(repairs.hotelCost, 100000);
  assert.equal(repairs.text, 'Pay $25000 per house and $100000 per hotel, up to 4 houses.');
  assert.equal(rules.scaleCard({ action: 'rule', rule: 'goSalary', value: 300 }, options).value, 300000);
  assert.equal(rules.scaleCard({ action: 'rule', rule: 'rentMultiplier', value: 2 }, options).value, 2);
  assert.deepEqual(rules.scaleCard({ action: 'moneyPercentage', value: -10, text: 'Pay 10%.' }, options), { action: 'moneyPercentage', value: -10, text: 'Pay 10%.' });
  assert.deepEqual(rules.scaleCard({ action: 'moveBack', value: 3, text: 'Go back 3 spaces.' }, options), { action: 'moveBack', value: 3, text: 'Go back 3 spaces.' });
  assert.equal(rules.scaleCard(cards.chance[0], options).text, 'Advance to GO. Collect $200000.');
});
test('engine applies base card amounts once, emits matching text and leaves stored decks unchanged', () => {
  let current = state({ moneyMultiplier: 10000 }); const original = JSON.stringify(current.cardDecks);
  const result = act(current, { type: 'APPLY_CARD', card: { action: 'money', value: 1000000, text: 'Collect $1,000,000.' } });
  assert.equal(result.state.players[0].money, 10015000000);
  assert.equal(result.events.find(e => e.type === 'CARD_DRAWN').text, 'Collect $10,000,000,000.');
  current = act(result.state, { type: 'APPLY_CARD', card: { action: 'moneyPercentage', value: -10 } }).state;
  assert.equal(current.players[0].money, 9013500000);
  assert.equal(JSON.stringify(current.cardDecks), original);
});
test('Free Parking collects scaled tax and card fees, then resets with no duplicate payout', () => {
  let current = state({ moneyMultiplier: 10, freeParkingJackpot: true });
  current = land(current, 4).state;
  current = act(current, { type: 'APPLY_CARD', card: { action: 'money', value: -50 } }).state;
  assert.equal(current.freeParkingPot, 2500);
  const before = current.players[0].money;
  const result = land(current, 20); current = result.state;
  assert.equal(current.players[0].money, before + 2500); assert.equal(current.freeParkingPot, 0);
  assert.equal(result.events.find(e => e.type === 'FREE_PARKING_COLLECTED').amount, 2500);
  current = land(current, 20).state;
  assert.equal(current.players[0].money, before + 2500);
  assert.equal(land(state(), 4).state.freeParkingPot, 0);
});
test('Free Parking receives settled debt and partial bankruptcy cash, never unpaid fees or rent', () => {
  let current = state({ freeParkingJackpot: true }); current.players[0].money = 10; current.owners[39] = 0;
  current = land(current, 4).state;
  assert.equal(current.freeParkingPot, 0); assert.equal(current.debt.amount, 200);
  current.players[0].money = 200;
  current = act(current, { type: 'PAY_DEBT' }).state; assert.equal(current.freeParkingPot, 200);
  current = state({ freeParkingJackpot: true }); current.players[0].money = 10;
  current = land(current, 4).state; assert.equal(current.freeParkingPot, 10);
  current = state({ freeParkingJackpot: true }); current.owners[39] = 1;
  current = land(current, 39).state; assert.equal(current.freeParkingPot, 0); assert.equal(current.players[1].money, 1550);
});
test('Free Parking includes jail fines, repair fees and mortgage interest, excludes purchase principal', () => {
  let current = state({ moneyMultiplier: 10, freeParkingJackpot: true }); current.players[0].inJail = true;
  current = act(current, { type: 'PAY_JAIL_FINE' }).state; assert.equal(current.freeParkingPot, 500);
  current.owners[1] = 0; current.houses[1] = 2;
  current = act(current, { type: 'APPLY_CARD', card: { action: 'repairs', houseCost: 25, hotelCost: 100 } }).state;
  assert.equal(current.freeParkingPot, 1000);
  current.houses[1] = 0; current.phase = 'after';
  current = act(current, { type: 'MORTGAGE_PROPERTY', position: 1 }).state;
  current = act(current, { type: 'UNMORTGAGE_PROPERTY', position: 1 }).state;
  assert.equal(current.freeParkingPot, 1030);
  current.phase = 'buy'; current.players[0].pos = 39;
  current = act(current, { type: 'BUY_PROPERTY' }).state; assert.equal(current.freeParkingPot, 1030);
});
test('Double GO adds one scaled salary only when landing exactly on GO', () => {
  let current = state({ moneyMultiplier: 1000, doubleGo: true }); current.players[0].pos = 39;
  current.pendingMove = { playerId: 0, steps: 1, direction: 1, collectGo: true, resolveLanding: true };
  current = act(current, { type: 'MOVE_STEP', direction: 1 }).state;
  assert.equal(current.players[0].money, 1700000);
  current = act(current, { type: 'LAND_ON_SPACE' }).state;
  assert.equal(current.players[0].money, 1900000);
  assert.equal(land(state(), 0).state.players[0].money, 1500);
});
async function online(houseRules) {
  const db = makeDb(), host = { id: 'account-a' }, guest = { id: 'account-b' };
  const created = await createGame({ account: host, db });
  await joinGame({ account: guest, gameId: created.gameId, db });
  const started = await startGame({ account: host, gameId: created.gameId, houseRules, db });
  assert.equal(started.ok, true);
  const current = engine.deserializeState(db.state.states[0].state); current.turnOrder = [0, 1]; current.current = 0;
  db.state.states[0].state = engine.serializeState(current);
  return { db, host, guest, gameId: created.gameId };
}
test('multiplayer host chooses validated rules and guest sees the same board, cash and card effects', async () => {
  const { db, host, guest, gameId } = await online({ moneyMultiplier: 1000, freeParkingJackpot: true });
  const before = await getGameState({ account: guest, gameId, db });
  assert.equal(before.state.players[0].money, 1500000); assert.equal(before.state.matchSpaces[39].price, 400000);
  assert.equal(before.state.houseRules.freeParkingJackpot, true);
  const values = [0, 1 / 6, .5];
  const result = await executeGameAction({ account: host, gameId, action: { type: 'ROLL_DICE' }, version: 1, requestId: 'scaled-chest', sql: db, random: () => values.shift() ?? .5 });
  assert.equal(result.ok, true); // 1 + 2 lands on Baltic Avenue, price scales.
  assert.equal(result.state.phase, 'buy');
  assert.equal(result.events.find(e => e.type === 'PROPERTY_AVAILABLE').amount, 60000);
  const denied = await startGame({ account: guest, gameId, houseRules: { moneyMultiplier: 100 }, db });
  assert.equal(denied.error.code, 'HOST_REQUIRED');
  const fresh = await createGame({ account: host, db }); await joinGame({ account: guest, gameId: fresh.gameId, db });
  const invalid = await startGame({ account: host, gameId: fresh.gameId, houseRules: { moneyMultiplier: -2 }, db });
  assert.equal(invalid.error.code, 'INVALID_HOUSE_RULES');
});
test('authoritative card messages use match amounts and saves restore rules and jackpot without rescaling', async () => {
  const { db, host, guest, gameId } = await online({ moneyMultiplier: 1000, freeParkingJackpot: true, doubleGo: true });
  let current = engine.deserializeState(db.state.states[0].state); current.players[0].pos = 33; current.freeParkingPot = 123000;
  current.cardDecks.chance = [{ text: 'Holiday fund matures. Collect $100.', action: 'money', value: 100 }];
  db.state.states[0].state = engine.serializeState(current);
  const values = [0, 1 / 6, 0];
  const result = await executeGameAction({ account: host, gameId, action: { type: 'ROLL_DICE' }, version: 1, requestId: 'scaled-custom-card', sql: db, random: () => values.shift() ?? 0 });
  assert.equal(result.ok, true); assert.equal(result.state.players[0].money, 1600000);
  assert.equal(result.events.find(e => e.type === 'CARD_DRAWN').text, 'Holiday fund matures. Collect $100000.');
  assert.equal(result.state.cardDecks.chance[0].value, 100);
  await pauseGame({ account: host, gameId, db });
  const saved = db.state.saves[0]; assert.equal(saved.state.freeParkingPot, 123000);
  db.state.games = []; db.state.players = []; db.state.states = []; db.state.actionRequests = [];
  const loaded = await loadGame({ account: host, saveId: saved.id, db }); assert.equal(loaded.ok, true);
  db.state.invitations.push({ id: 'return', game_id: loaded.gameId, invitee_account_id: guest.id, status: 'accepted' });
  await joinGame({ account: guest, gameId: loaded.gameId, db });
  const resumed = await resumeGame({ account: host, gameId: loaded.gameId, db }); assert.equal(resumed.ok, true);
  assert.equal(resumed.state.houseRules.moneyMultiplier, 1000);
  assert.equal(resumed.state.players[0].money, 1600000);
  assert.equal(resumed.state.freeParkingPot, 123000);
  assert.equal(resumed.state.matchSpaces[39].price, 400000);
});
