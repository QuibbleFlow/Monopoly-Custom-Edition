const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const account = require('./lib/account');

function boardHandlers() {
  let board;
  const id = '20000000-0000-4000-8000-000000000001';
  const sql = async (strings, ...values) => {
    const query = strings.join('?').replace(/\s+/g, ' ').trim();
    if (query.startsWith('INSERT INTO custom_boards')) {
      board = { id, owner_id: values[0], name: values[1], property_names: JSON.parse(values[2]) };
      return [structuredClone(board)];
    }
    if (query.startsWith('SELECT')) return board ? [structuredClone(board)] : [];
    if (query.startsWith('UPDATE custom_boards')) {
      board = { ...board, name: values[0], property_names: JSON.parse(values[1]) };
      return [structuredClone(board)];
    }
    throw new Error(`Unexpected query: ${query}`);
  };
  function load(file) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), {
      module, console,
      require: name => name === '../../lib/custom-boards' ? require('./lib/custom-boards') : name === '../../game-cards' ? require('./game-cards') : ({ ...account, database: () => sql, requireAccount: async () => ({ id: 'owner' }), requireSameOrigin: () => true }),
    }, { filename: file });
    return module.exports;
  }
  return { id, create: load('api-handlers/boards/index.js'), edit: load('api-handlers/boards/[id].js') };
}

function response() {
  return {
    statusCode: 200, setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('all 40 square names survive creating and reopening a custom board', async () => {
  const handlers = boardHandlers();
  const names = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [index, ` Space ${index} `]));
  const created = response();
  await handlers.create({ method: 'POST', body: { name: 'My board', propertyNames: names } }, created);
  assert.equal(created.statusCode, 201);
  const reopened = response();
  await handlers.edit({ method: 'GET', query: { id: handlers.id } }, reopened);
  assert.equal(reopened.statusCode, 200);
  assert.equal(Object.keys(reopened.body.board.property_names).length, 40);
  for (let index = 0; index < 40; index++) assert.equal(reopened.body.board.property_names[index], `Space ${index}`);
});

test('editing special spaces saves changes and clearing names persists after reopening', async () => {
  const handlers = boardHandlers();
  await handlers.create({ method: 'POST', body: { name: 'Board', propertyNames: { 0: 'Start', 10: 'Prison', 20: 'Rest', 30: 'Caught' } } }, response());
  const updated = response();
  await handlers.edit({ method: 'PATCH', query: { id: handlers.id }, body: { propertyNames: { 0: 'Begin', 5: 'Train', 12: 'Power' } } }, updated);
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.body.board.property_names[5], 'Train');
  assert.equal(updated.body.board.property_names[10], 'Prison');
  const reset = response();
  await handlers.edit({ method: 'PATCH', query: { id: handlers.id }, body: { propertyNames: { 5: 'Train' }, replacePropertyNames: true } }, reset);
  assert.equal(reset.statusCode, 200);
  const reopened = response();
  await handlers.edit({ method: 'GET', query: { id: handlers.id } }, reopened);
  assert.equal(JSON.stringify(reopened.body.board.property_names), JSON.stringify({ 5: 'Train' }));
});

test('create and edit reject invalid square IDs and invalid names', async () => {
  const handlers = boardHandlers();
  await handlers.create({ method: 'POST', body: { name: 'Board', propertyNames: {} } }, response());
  for (const propertyNames of [{ '-1': 'Invalid' }, { 40: 'Invalid' }, { '1.5': 'Invalid' }, { '01': 'Invalid' }, { 0: '' }, { 0: ' '.repeat(4) }, { 0: 'x'.repeat(33) }, { 0: 123 }, []]) {
    const created = response();
    await handlers.create({ method: 'POST', body: { name: 'Board', propertyNames } }, created);
    assert.equal(created.statusCode, 400);
    const updated = response();
    await handlers.edit({ method: 'PATCH', query: { id: handlers.id }, body: { propertyNames } }, updated);
    assert.equal(updated.statusCode, 400);
  }
});


test('custom decks survive create, reopen, name replacement, and deck-only edits', async () => {
  const handlers = boardHandlers();
  const decks = require('./game-cards').defaultDecks();
  decks.chance[0] = { text: 'Bonus', action: 'money', value: 321 };
  const created = response();
  await handlers.create({ method: 'POST', body: { name: 'Cards', cardDecks: decks } }, created);
  assert.equal(created.statusCode, 201);
  assert.equal(created.body.board.card_decks.chance[0].value, 321);
  const names = response();
  await handlers.edit({ method: 'PATCH', query: { id: handlers.id }, body: { propertyNames: { 0: 'Start' }, replacePropertyNames: true } }, names);
  assert.equal(names.body.board.card_decks.chance[0].value, 321);
  decks.chest = [{ text: 'New rule', action: 'rule', rule: 'jailFine', value: 10 }];
  const edited = response();
  await handlers.edit({ method: 'PATCH', query: { id: handlers.id }, body: { cardDecks: decks } }, edited);
  assert.equal(edited.statusCode, 200);
  const reopened = response();
  await handlers.edit({ method: 'GET', query: { id: handlers.id } }, reopened);
  assert.equal(reopened.body.board.card_decks.chest.length, 1);
  assert.equal(reopened.body.board.card_decks.chest[0].value, 10);
  assert.deepEqual(Object.keys(reopened.body.board.property_names), ['0']);
  const invalid = response();
  await handlers.edit({ method: 'PATCH', query: { id: handlers.id }, body: { cardDecks: { chance: [], chest: [] } } }, invalid);
  assert.equal(invalid.statusCode, 400);
});
