const assert = require('node:assert/strict');
const test = require('node:test');

const {
  controllerFamily,
  buttonLabels,
  chooseSpatialTarget,
} = require('./controller-support.js');

test('controller family and labels match common gamepads', () => {
  assert.equal(controllerFamily('Xbox Wireless Controller'), 'xbox');
  assert.equal(controllerFamily('DualSense Wireless Controller'), 'playstation');
  assert.equal(controllerFamily('Nintendo Switch Pro Controller'), 'nintendo');

  assert.equal(buttonLabels('xbox').A, 'A');
  assert.equal(buttonLabels('playstation').A, '✕');
  assert.equal(buttonLabels('nintendo').A, 'B');
});

test('spatial controller navigation selects the nearest element in the requested direction', () => {
  const items = [
    { rect: { left: 0, top: 0, width: 40, height: 40 } },
    { rect: { left: 100, top: 0, width: 40, height: 40 } },
    { rect: { left: 0, top: 100, width: 40, height: 40 } },
    { rect: { left: 100, top: 100, width: 40, height: 40 } },
  ];

  assert.equal(chooseSpatialTarget(items, 0, 1, 0), 1);
  assert.equal(chooseSpatialTarget(items, 0, 0, 1), 2);
  assert.equal(chooseSpatialTarget(items, 3, -1, 0), 2);
  assert.equal(chooseSpatialTarget(items, 3, 0, -1), 1);
});

test('spatial controller navigation wraps when there is nothing farther in that direction', () => {
  const items = [
    { rect: { left: 0, top: 0, width: 40, height: 40 } },
    { rect: { left: 100, top: 0, width: 40, height: 40 } },
  ];

  assert.equal(chooseSpatialTarget(items, 1, 1, 0), 0);
  assert.equal(chooseSpatialTarget(items, 0, -1, 0), 1);
});
