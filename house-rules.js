(function (root, factory) {
  const rules = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = rules;
  if (root) root.MonopolyHouseRules = rules;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function normalize(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Provide valid house rules.');
    const moneyMultiplier = value.moneyMultiplier ?? 1;
    if (!Number.isInteger(moneyMultiplier) || moneyMultiplier < 1 || moneyMultiplier > 10000) throw new Error('Money multiplier must be a whole number from 1 to 10,000.');
    for (const key of ['freeParkingJackpot', 'doubleGo']) {
      if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error('House rule toggles must be on or off.');
    }
    return { moneyMultiplier, freeParkingJackpot: value.freeParkingJackpot === true, doubleGo: value.doubleGo === true };
  }
  function scaleSpaces(spaces, rules) {
    const factor = rules?.moneyMultiplier || 1;
    return spaces.map(space => {
      const result = { ...space };
      for (const key of ['price', 'houseCost', 'amount']) if (typeof space[key] === 'number') result[key] = space[key] * factor;
      if (space.rents) result.rents = space.rents.map(amount => amount * factor);
      return result;
    });
  }
  // Match complete numeric tokens, never substrings such as 100 in 1000.
  // Bare numbers also match user-written messages. Percentages never do.
  function replaceAmounts(text, amounts, moneyOnly = false) {
    const number = /\d+(?:[, \u00a0\u202f]\d{3})*(?:\.\d+)?/g;
    const numeric = token => Number(token.replace(/[, \u00a0\u202f]/g, ''));
    const currency = (source, offset, length) => /(?:\$|\bCAD)\s*[-+]?\s*$/i.test(source.slice(0, offset)) || /^\s*(?:\$|CAD\b|dollars?\b)/i.test(source.slice(offset + length));
    const marked = new Set();
    for (const match of text.matchAll(number)) if (currency(text, match.index, match[0].length)) marked.add(numeric(match[0]));
    return text.replace(number, (token, offset, source) => {
      const before = source[offset - 1] || '', after = source[offset + token.length] || '';
      const isMoney = currency(source, offset, token.length), amount = numeric(token);
      if ((!isMoney && /[\w.]/.test(before)) || /[\w%]/.test(after) || /^\s*%/.test(source.slice(offset + token.length))) return token;
      if ((moneyOnly || marked.has(amount)) && !isMoney) return token;
      const replacement = amounts.get(amount);
      if (replacement === undefined || replacement === amount) return token;
      if (token.includes(',')) return replacement.toLocaleString('en-CA');
      const spacing = token.match(/[ \u00a0\u202f]/)?.[0];
      if (spacing) return replacement.toLocaleString('en-CA').replace(/,/g, spacing);
      return String(replacement);
    });
  }
  function scaleCard(card, rules, goSalary) {
    const result = { ...card }, factor = rules?.moneyMultiplier || 1, amounts = new Map();
    function scale(key) {
      if (typeof card[key] !== 'number') return;
      result[key] = card[key] * factor;
      amounts.set(Math.abs(card[key]), Math.abs(result[key]));
    }
    if (['money', 'collectFromAll', 'payAll'].includes(card.action)) scale('value');
    if (card.action === 'repairs') { scale('houseCost'); scale('hotelCost'); }
    if (card.action === 'rule' && ['goSalary', 'jailFine'].includes(card.rule)) scale('value');
    if (card.action === 'moveTo' && card.value === 0 && card.collectGo !== false) amounts.set(200, goSalary ?? 200 * factor);
    if (typeof card.text === 'string') result.text = replaceAmounts(card.text, amounts, card.action === 'moveTo');
    return result;
  }
  return { normalize, scaleSpaces, scaleCard, replaceAmounts };
});
