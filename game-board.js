(function (root, factory) {
  const board = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = board;
  if (root) root.MonopolyBoard = board;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const colorGroups = {
    brown: { label: 'Brown', css: '#955436' },
    lightblue: { label: 'Light blue', css: '#B9E8F2' },
    pink: { label: 'Pink', css: '#AE1572' },
    orange: { label: 'Orange', css: '#F57F1C' },
    red: { label: 'Red', css: '#ED2023' },
    yellow: { label: 'Yellow', css: '#F3EE04' },
    green: { label: 'Green', css: '#00A650' },
    darkblue: { label: 'Dark blue', css: '#1477BA' },
  };

  function property(name, group, price, houseCost, rents) {
    return { type: 'property', name, group, price, houseCost, rents };
  }

  function railroad(name) {
    return { type: 'railroad', name, price: 200 };
  }

  function utility(name) {
    return { type: 'utility', name, price: 150 };
  }

  const spaces = [
    { type: 'go', name: 'GO' },
    property('Mediterranean Avenue', 'brown', 60, 50, [2, 10, 30, 90, 160, 250]),
    { type: 'chest', name: 'Community Chest' },
    property('Baltic Avenue', 'brown', 60, 50, [4, 20, 60, 180, 320, 450]),
    { type: 'tax', name: 'Income Tax', amount: 200 },
    railroad('Reading Railroad'),
    property('Oriental Avenue', 'lightblue', 100, 50, [6, 30, 90, 270, 400, 550]),
    { type: 'chance', name: 'Chance' },
    property('Vermont Avenue', 'lightblue', 100, 50, [6, 30, 90, 270, 400, 550]),
    property('Connecticut Avenue', 'lightblue', 120, 50, [8, 40, 100, 300, 450, 600]),
    { type: 'jail', name: 'Jail / Just Visiting' },
    property('St. Charles Place', 'pink', 140, 100, [10, 50, 150, 450, 625, 750]),
    utility('Electric Company'),
    property('States Avenue', 'pink', 140, 100, [10, 50, 150, 450, 625, 750]),
    property('Virginia Avenue', 'pink', 160, 100, [12, 60, 180, 500, 700, 900]),
    railroad('Pennsylvania Railroad'),
    property('St. James Place', 'orange', 180, 100, [14, 70, 200, 550, 750, 950]),
    { type: 'chest', name: 'Community Chest' },
    property('Tennessee Avenue', 'orange', 180, 100, [14, 70, 200, 550, 750, 950]),
    property('New York Avenue', 'orange', 200, 100, [16, 80, 220, 600, 800, 1000]),
    { type: 'parking', name: 'Free Parking' },
    property('Kentucky Avenue', 'red', 220, 150, [18, 90, 250, 700, 875, 1050]),
    { type: 'chance', name: 'Chance' },
    property('Indiana Avenue', 'red', 220, 150, [18, 90, 250, 700, 875, 1050]),
    property('Illinois Avenue', 'red', 240, 150, [20, 100, 300, 750, 925, 1100]),
    railroad('B&O Railroad'),
    property('Atlantic Avenue', 'yellow', 260, 150, [22, 110, 330, 800, 975, 1150]),
    property('Ventnor Avenue', 'yellow', 260, 150, [22, 110, 330, 800, 975, 1150]),
    utility('Water Works'),
    property('Marvin Gardens', 'yellow', 280, 150, [24, 120, 360, 850, 1025, 1200]),
    { type: 'gotojail', name: 'Go To Jail' },
    property('Pacific Avenue', 'green', 300, 200, [26, 130, 390, 900, 1100, 1275]),
    property('North Carolina Avenue', 'green', 300, 200, [26, 130, 390, 900, 1100, 1275]),
    { type: 'chest', name: 'Community Chest' },
    property('Pennsylvania Avenue', 'green', 320, 200, [28, 150, 450, 1000, 1200, 1400]),
    railroad('Short Line'),
    { type: 'chance', name: 'Chance' },
    property('Park Place', 'darkblue', 350, 200, [35, 175, 500, 1100, 1300, 1500]),
    { type: 'tax', name: 'Luxury Tax', amount: 100 },
    property('Boardwalk', 'darkblue', 400, 200, [50, 200, 600, 1400, 1700, 2000]),
  ];

  return { colorGroups, spaces };
});