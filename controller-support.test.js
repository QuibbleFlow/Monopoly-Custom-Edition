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


test('virtual cursor has a deadzone, accelerates smoothly, and stays within the viewport', () => {
  const { advanceCursor } = require('./controller-support');
  const prefs={sensitivity:1,deadzone:.2};
  let cursor={x:100,y:100,vx:0,vy:0};
  assert.deepEqual(advanceCursor(cursor,.1,.1,.016,390,900,prefs),cursor);
  cursor=advanceCursor(cursor,1,0,.016,390,900,prefs);
  assert.ok(cursor.x>100 && cursor.vx<1000);
  const initialSpeed=cursor.vx;
  for(let i=0;i<100;i++)cursor=advanceCursor(cursor,1,1,.016,390,900,prefs);
  assert.ok(cursor.vx>initialSpeed);
  assert.equal(cursor.x,388);
  assert.ok(cursor.y<=898);
  const stopped=advanceCursor(cursor,0,0,.016,390,900,prefs);
  assert.ok(stopped.vx<cursor.vx);
});

test('controller settings clamp sensitivity and deadzone without retaining a manual mode', () => {
  const { configure, getPreferences, normalizePreferences }=require('./controller-support');
  assert.deepEqual(normalizePreferences({mode:'bad',sensitivity:99,deadzone:99}),{sensitivity:2.5,deadzone:.4});
  configure({mode:'mouse',sensitivity:.7,deadzone:.15});
  assert.deepEqual(getPreferences(),{sensitivity:.7,deadzone:.15});
  configure({mode:'focus'});
  assert.equal(getPreferences().mode,undefined);
});

test('controller interaction follows the screen rather than an account preference', () => {
  const { modeForContext } = require('./controller-support');
  for (const screen of ['menu','profile','friends','lobby','boards','settings','save','reconnect']) {
    assert.equal(modeForContext(screen),'mouse',screen);
  }
  for (const screen of ['gameplay','manage','purchase','auction','keyboard','trade','dialog','other',undefined]) {
    assert.equal(modeForContext(screen),'focus',screen);
  }
});
