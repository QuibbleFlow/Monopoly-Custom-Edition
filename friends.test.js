const assert = require('node:assert/strict');
const test = require('node:test');
const sendRequest = require('./api-handlers/friends/requests.js');
const respondRequest = require('./api-handlers/friends/requests/[id].js');
const removeFriend = require('./api-handlers/friends/[id].js');

const ids = {
  ada: '20000000-0000-4000-8000-000000000001',
  bea: '20000000-0000-4000-8000-000000000002',
  cam: '20000000-0000-4000-8000-000000000003',
};

function makeFriendsDb() {
  const accounts = [
    { id: ids.ada, username: 'Ada' },
    { id: ids.bea, username: 'Bea' },
    { id: ids.cam, username: 'Cam' },
  ];
  const requests = [];
  const friendships = [];
  let requestId = 0;

  const sql = async (strings, ...values) => {
    const query = strings.reduce((text, part, index) => text + part + (index < values.length ? `$${index + 1}` : ''), '')
      .replace(/\s+/g, ' ').trim();

    if (query.startsWith('INSERT INTO friend_requests')) {
      const senderId = values[0];
      const target = accounts.find(account => account.username.toLowerCase() === values[1].toLowerCase());
      if (!target || target.id === values[2]) return [];
      const pair = [senderId, target.id].sort();
      if (friendships.some(friendship => friendship.account_low === pair[0] && friendship.account_high === pair[1])) return [];
      if (requests.some(request => request.status === 'pending' &&
        [request.sender_id, request.recipient_id].sort().join(':') === pair.join(':'))) return [];
      requestId++;
      const request = { id: `30000000-0000-4000-8000-${String(requestId).padStart(12, '0')}`, sender_id: senderId, recipient_id: target.id, status: 'pending' };
      requests.push(request);
      return [{ id: request.id, recipient_id: target.id, status: request.status, created_at: new Date().toISOString() }];
    }

    if (query.startsWith('WITH updated AS ( UPDATE friend_requests SET status = $1, responded_at = now() WHERE id = $2 AND recipient_id = $3 AND status =')) {
      const request = requests.find(item => item.id === values[1] && item.recipient_id === values[2] && item.status === 'pending');
      if (!request) return [];
      request.status = values[0];
      if (values[0] === 'accepted') {
        const pair = [request.sender_id, request.recipient_id].sort();
        if (!friendships.some(friendship => friendship.account_low === pair[0] && friendship.account_high === pair[1])) {
          friendships.push({ account_low: pair[0], account_high: pair[1] });
        }
      }
      return [{ id: request.id, status: request.status }];
    }

    if (query.startsWith('DELETE FROM friendships')) {
      const pair = [values[0], values[1]].sort();
      const index = friendships.findIndex(friendship => friendship.account_low === pair[0] && friendship.account_high === pair[1]);
      if (index < 0) return [];
      friendships.splice(index, 1);
      return [{ account_low: pair[0] }];
    }

    throw new Error(`Unexpected friend SQL: ${query}`);
  };

  return { sql, requests, friendships };
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function dependencies(db, accountId) {
  return {
    currentAccount: async () => ({ id: accountId }),
    database: () => db.sql,
  };
}

test('friend requests reject self and duplicates, accept only for recipient, and create one friendship', async () => {
  const db = makeFriendsDb();
  const request = response();
  await sendRequest({ method: 'POST', headers: {}, body: { username: 'Ada' } }, request, dependencies(db, ids.ada));
  assert.equal(request.statusCode, 409);
  assert.equal(db.requests.length, 0);

  const sent = response();
  await sendRequest({ method: 'POST', headers: {}, body: { username: 'Bea' } }, sent, dependencies(db, ids.ada));
  assert.equal(sent.statusCode, 201);
  assert.equal(db.requests.length, 1);

  const duplicate = response();
  await sendRequest({ method: 'POST', headers: {}, body: { username: 'bea' } }, duplicate, dependencies(db, ids.ada));
  assert.equal(duplicate.statusCode, 409);
  assert.equal(db.requests.length, 1);

  const unauthorized = response();
  await respondRequest({ method: 'PATCH', headers: {}, query: { id: sent.body.request.id }, body: { action: 'accept' } }, unauthorized, dependencies(db, ids.cam));
  assert.equal(unauthorized.statusCode, 404);
  assert.equal(db.friendships.length, 0);

  const accepted = response();
  await respondRequest({ method: 'PATCH', headers: {}, query: { id: sent.body.request.id }, body: { action: 'accept' } }, accepted, dependencies(db, ids.bea));
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.body.request.status, 'accepted');
  assert.equal(db.friendships.length, 1);

  const duplicateFriendRequest = response();
  await sendRequest({ method: 'POST', headers: {}, body: { username: 'Bea' } }, duplicateFriendRequest, dependencies(db, ids.ada));
  assert.equal(duplicateFriendRequest.statusCode, 409);
  assert.equal(db.friendships.length, 1);
});

test('declining leaves no friendship, and either friend can remove the relationship', async () => {
  const db = makeFriendsDb();
  const sent = response();
  await sendRequest({ method: 'POST', headers: {}, body: { username: 'Cam' } }, sent, dependencies(db, ids.ada));

  const declined = response();
  await respondRequest({ method: 'PATCH', headers: {}, query: { id: sent.body.request.id }, body: { action: 'decline' } }, declined, dependencies(db, ids.cam));
  assert.equal(declined.statusCode, 200);
  assert.equal(declined.body.request.status, 'declined');
  assert.equal(db.friendships.length, 0);

  const acceptedRequest = response();
  await sendRequest({ method: 'POST', headers: {}, body: { username: 'Bea' } }, acceptedRequest, dependencies(db, ids.ada));
  const accepted = response();
  await respondRequest({ method: 'PATCH', headers: {}, query: { id: acceptedRequest.body.request.id }, body: { action: 'accept' } }, accepted, dependencies(db, ids.bea));
  assert.equal(db.friendships.length, 1);

  const removed = response();
  await removeFriend({ method: 'DELETE', headers: {}, query: { id: ids.ada } }, removed, dependencies(db, ids.bea));
  assert.equal(removed.statusCode, 200);
  assert.equal(db.friendships.length, 0);
});
