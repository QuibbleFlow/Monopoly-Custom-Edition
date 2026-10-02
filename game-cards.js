(function (root, factory) {
  const cards = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = cards;
  if (root) root.MonopolyCards = cards;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const chance = [
    { text: 'Advance to GO. Collect $200.', action: 'moveTo', value: 0 },
    { text: 'Advance to Burlington.', action: 'moveTo', value: 24 },
    { text: 'Take a trip to the Lakeshore West Line.', action: 'moveTo', value: 5 },
    { text: 'Advance to Saint-Louis-du-Ha! Ha!.', action: 'moveTo', value: 39 },
    { text: 'Bank pays you a dividend of $50.', action: 'money', value: 50 },
    { text: 'Go back 3 spaces.', action: 'moveBack', value: 3 },
    { text: 'Go directly to Jail.', action: 'jail' },
    { text: 'Speeding fine. Pay $15.', action: 'money', value: -15 },
    { text: 'You won a crossword contest. Collect $100.', action: 'money', value: 100 },
    { text: 'You are elected chairman. Pay each player $50.', action: 'payAll', value: 50 },
  ];

  const chest = [
    { text: 'Advance to GO. Collect $200.', action: 'moveTo', value: 0 },
    { text: 'Bank error in your favor. Collect $200.', action: 'money', value: 200 },
    { text: 'Doctor fee. Pay $50.', action: 'money', value: -50 },
    { text: 'Sale of stock. Collect $50.', action: 'money', value: 50 },
    { text: 'Go directly to Jail.', action: 'jail' },
    { text: 'Holiday fund matures. Collect $100.', action: 'money', value: 100 },
    { text: 'It is your birthday. Collect $10 from every player.', action: 'collectFromAll', value: 10 },
    { text: 'Hospital fees. Pay $100.', action: 'money', value: -100 },
    { text: 'School fees. Pay $50.', action: 'money', value: -50 },
    { text: 'You inherit $100.', action: 'money', value: 100 },
  ];

  const actions = {
    money: { label: 'Collect or pay money', fields: { value: ['Amount (+ collect, − pay)', -1000000, 1000000, 50] } },
    moneyPercentage: { label: 'Collect or pay a percentage of cash', fields: { value: ['Percent (+ collect, − pay)', -100, 100, 10] } },
    moveTo: { label: 'Move to a specific space', fields: { value: ['Destination square (0–39)', 0, 39, 0] }, movement: true },
    moveForward: { label: 'Move forward', fields: { value: ['Number of spaces', 0, 80, 3] }, movement: true },
    moveBack: { label: 'Move backward', fields: { value: ['Number of spaces', 0, 80, 3] }, movement: true },
    moveNearest: { label: 'Move to the next railroad or utility', fields: {}, movement: true },
    jail: { label: 'Go directly to jail', fields: {} },
    collectFromAll: { label: 'Collect money from every other player', fields: { value: ['Amount per player', 0, 1000000, 10] } },
    payAll: { label: 'Pay every other player', fields: { value: ['Amount per player', 0, 1000000, 50] } },
    repairs: { label: 'Pay for repairs on your buildings', fields: { houseCost: ['Cost per house', 0, 1000000, 25], hotelCost: ['Cost per hotel', 0, 1000000, 100] } },
    rule: { label: 'Change a rule for the rest of the game', fields: { value: ['New rule value', 0, 1000000, 200] } },
    nothing: { label: 'Message only (no effect)', fields: {} },
  };
  const rules = {
    goSalary: { label: 'Cash for passing GO', max: 1000000, default: 200 },
    jailFine: { label: 'Fine to leave jail', max: 1000000, default: 50 },
    rentMultiplier: { label: 'Rent multiplier', max: 10, default: 1 },
    taxMultiplier: { label: 'Tax multiplier', max: 10, default: 1 },
  };
  function normalizeCard(card, requireText = true) {
    if (!card || typeof card !== 'object' || !Object.hasOwn(actions, card.action)) throw new Error('Choose a supported card action.');
    if (requireText && (typeof card.text !== 'string' || !card.text.trim() || card.text.trim().length > 500)) throw new Error('Card text must be 1–500 characters.');
    const result = { text: typeof card.text === 'string' ? card.text.trim() : '', action: card.action };
    for (const [key, [, min, max]] of Object.entries(actions[card.action].fields)) {
      if (typeof card[key] !== 'number' || !Number.isFinite(card[key]) || card[key] < min || card[key] > max || (!['rule', 'moneyPercentage'].includes(card.action) && !Number.isInteger(card[key]))) throw new Error('Card amounts and destinations must be within the displayed limits.');
      result[key] = card[key];
    }
    if (actions[card.action].movement) {
      for (const key of ['collectGo', 'resolveLanding']) {
        if (card[key] !== undefined && typeof card[key] !== 'boolean') throw new Error('Movement options must be true or false.');
        result[key] = card[key] !== false;
      }
    }
    if (card.action === 'moveNearest') {
      if (!['railroad', 'utility'].includes(card.targetType)) throw new Error('Choose railroad or utility.');
      result.targetType = card.targetType;
    }
    if (card.action === 'rule') {
      if (!Object.hasOwn(rules, card.rule) || card.value > rules[card.rule].max) throw new Error('Choose a rule and a value within its limits.');
      result.rule = card.rule;
    }
    return result;
  }
  function defaultDecks() { return JSON.parse(JSON.stringify({ chance, chest })); }
  function normalizeDecks(decks) {
    if (decks == null) return defaultDecks();
    if (typeof decks !== 'object' || Array.isArray(decks) || Object.keys(decks).some(key => !['chance', 'chest'].includes(key))) throw new Error('Provide Chance and Community Chest decks.');
    const result = {};
    for (const name of ['chance', 'chest']) {
      if (!Array.isArray(decks[name]) || decks[name].length < 1 || decks[name].length > 50) throw new Error('Each deck needs between 1 and 50 cards.');
      result[name] = decks[name].map(card => normalizeCard(card));
    }
    return result;
  }
  return { chance, chest, actions, rules, normalizeCard, normalizeDecks, defaultDecks };
});