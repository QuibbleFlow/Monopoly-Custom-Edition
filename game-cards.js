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

  return { chance, chest };
});