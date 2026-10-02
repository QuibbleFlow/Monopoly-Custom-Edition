const test = require('node:test');
const assert = require('node:assert/strict');
const cards = require('./game-cards');
const engine = require('./game-engine');
const { spaces } = require('./game-board');
const { publicBoard, storedBoard } = require('./lib/custom-boards');
const state = () => engine.createState({ names: ['A', 'B', 'C'] });
function apply(current, card) {
  const result = engine.applyAction(current, { type: 'APPLY_CARD', playerId: 0, card }, { spaces });
  assert.equal(result.error, null);
  return result.state;
}
function move(current) {
  while (current.pendingMove) {
    const result = engine.applyAction(current, { type: 'MOVE_STEP', playerId: 0, direction: current.pendingMove.direction }, { spaces });
    assert.equal(result.error, null);
    current = result.state;
  }
  return current;
}
test('deck validation preserves all defaults, clones decks, rejects empty decks and unsafe effects', () => {
  const defaults = cards.defaultDecks();
  assert.equal(defaults.chance.length, cards.chance.length);
  assert.equal(defaults.chest.length, cards.chest.length);
  defaults.chance[0].text = 'Independent';
  assert.notEqual(cards.chance[0].text, 'Independent');
  for (const card of [
    { text: '', action: 'money', value: 2 },
    { text: 'X', action: 'money', value: Infinity },
    { text: 'X', action: 'money', value: '200' },
    { text: 'X', action: 'money', value: 1000001 },
    { text: 'X', action: 'eval', value: 5 },
    { text: 'X', action: '__proto__' },
    { text: 'X', action: 'moveForward', value: 0.5 },
    { text: 'X', action: 'moveTo', value: 40 },
    { text: 'X', action: 'moveTo', value: 0, collectGo: 'false' },
    { text: 'X', action: 'rule', rule: 'rentMultiplier', value: 11 },
    { text: 'X', action: 'rule', rule: 'arbitrary', value: 1 },
  ]) assert.throws(() => cards.normalizeDecks({ chest: [card], chance: cards.chance }));
  assert.throws(() => cards.normalizeDecks({ chest: [], chance: cards.chance }));
  assert.throws(() => cards.normalizeDecks({ chest: Array(51).fill(cards.chest[0]), chance: cards.chance }));
});
test('stored boards separate space names from decks and survive independent sharing copies', () => {
  const decks = cards.defaultDecks();
  decks.chance[0] = { text: 'Custom bonus', action: 'money', value: 321 };
  const source = { id: 'one', property_names: storedBoard({ 0: 'Start' }, decks) };
  const shared = structuredClone(source);
  const result = publicBoard(shared);
  assert.deepEqual(result.property_names, { 0: 'Start' });
  assert.equal(result.card_decks.chance[0].value, 321);
  result.card_decks.chance[0].value = 999;
  assert.equal(publicBoard(source).card_decks.chance[0].value, 321);
  assert.deepEqual(publicBoard({ property_names: { 5: 'Train' } }).card_decks, cards.defaultDecks());
});
test('cash percentage, repairs, player payments, message cards, and jail execute their effects', () => {
  let current = apply(state(), { action: 'moneyPercentage', value: -10 });
  assert.equal(current.players[0].money, 1350);
  current.owners[1] = 0; current.houses[1] = 3;
  current.owners[3] = 0; current.houses[3] = 5;
  current.owners[6] = 1; current.houses[6] = 5;
  current = apply(current, { action: 'repairs', houseCost: 7, hotelCost: 90 });
  assert.equal(current.players[0].money, 1239);
  current = apply(current, { action: 'collectFromAll', value: 15 });
  assert.deepEqual(current.players.map(p => p.money), [1269, 1485, 1485]);
  current = apply(current, { action: 'payAll', value: 5 });
  assert.deepEqual(current.players.map(p => p.money), [1259, 1490, 1490]);
  assert.deepEqual(apply(current, { action: 'nothing' }).players, current.players);
  current = apply(current, { action: 'jail' });
  assert.equal(current.players[0].inJail, true);
  assert.equal(current.players[0].pos, 10);
});
test('custom card costs enter the usual debt flow', () => {
  const initial = state(); initial.owners[39] = 0; initial.players[0].money = 10;
  const current = apply(initial, { action: 'money', value: -100 });
  assert.equal(current.debt.amount, 100);
  assert.equal(current.phase, 'debt');
});
test('movement controls GO payments and landing, including full laps and nearest spaces', () => {
  let current = state(); current.players[0].pos = 39;
  current = move(apply(current, { action: 'moveTo', value: 1, collectGo: false, resolveLanding: false }));
  assert.equal(current.players[0].pos, 1);
  assert.equal(current.players[0].money, 1500);
  assert.equal(current.landingPending, false);
  current = move(apply(current, { action: 'moveForward', value: 80, resolveLanding: false }));
  assert.equal(current.players[0].pos, 1);
  assert.equal(current.players[0].money, 1900);
  current = move(apply(current, { action: 'moveNearest', targetType: 'utility' }));
  assert.equal(current.players[0].pos, 12);
  assert.equal(current.landingPending, true);
  current.landingPending = false;
  current = move(apply(current, { action: 'moveBack', value: 13, resolveLanding: false }));
  assert.equal(current.players[0].pos, 39);
  assert.equal(current.players[0].money, 1900);
});
test('rule changes persist in snapshots and affect GO, jail, rent and tax', () => {
  let current = apply(state(), { action: 'rule', rule: 'goSalary', value: 777 });
  current.players[0].pos = 39;
  current = move(apply(current, { action: 'moveForward', value: 1, resolveLanding: false }));
  assert.equal(current.players[0].money, 2277);
  current = apply(current, { action: 'rule', rule: 'rentMultiplier', value: 2.5 });
  current.owners[1] = 1;
  assert.equal(engine.calcRent(current, spaces, 1), 5);
  current = apply(current, { action: 'rule', rule: 'taxMultiplier', value: 0.5 });
  current.players[0].pos = 4; current.landingPending = true;
  const tax = engine.applyAction(current, { type: 'LAND_ON_SPACE', playerId: 0 }, { spaces });
  assert.equal(tax.events.find(e => e.type === 'TAX_DUE').amount, 100);
  current = apply(tax.state, { action: 'rule', rule: 'jailFine', value: 0 });
  current.players[0].inJail = true;
  const money = current.players[0].money;
  const fine = engine.applyAction(current, { type: 'PAY_JAIL_FINE', playerId: 0 }, { spaces });
  assert.equal(fine.error, null);
  assert.equal(fine.state.players[0].money, money);
  assert.equal(fine.state.players[0].inJail, false);
  assert.deepEqual(engine.deserializeState(engine.serializeState(fine.state)).rules, fine.state.rules);
});
