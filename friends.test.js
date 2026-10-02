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

    if (query.startsWith('SELECT id, username FROM accounts WHERE lower(username) = lower($1)')) {
      const target = accounts.find(account => account.username.toLowerCase() === String(values[0]).toLowerCase());
      return target ? [target] : [];
    }

    if (query.startsWith('SELECT 1 FROM friendships WHERE account_low = LEAST($1::uuid, $2::uuid)')) {
      const pair = [values[0], values[1]].sort();
      return friendships.some(friendship => friendship.account_low === pair[0] && friendship.account_high === pair[1])
        ? [{ '?column?': 1 }]
        : [];
    }

    if (query.startsWith('SELECT id, sender_id, recipient_id, status, created_at FROM friend_requests WHERE status =')) {
      const pair = [values[0], values[1]].sort();
      const pending = requests.find(request => request.status === 'pending' &&
        [request.sender_id, request.recipient_id].sort().join(':') === pair.join(':'));
      return pending ? [pending] : [];
    }

    if (query.startsWith('UPDATE friend_requests SET status = $1, responded_at = now() WHERE id = $2 AND status =')) {
      const request = requests.find(item => item.id === values[1] && item.status === 'pending');
      if (!request) return [];
      request.status = values[0];
      request.responded_at = new Date().toISOString();
      return [{ id: request.id }];
    }

    if (query.startsWith('INSERT INTO friendships (account_low, account_high) VALUES ( LEAST($1::uuid, $2::uuid), GREATEST($3::uuid, $4::uuid) ) ON CONFLICT DO NOTHING')) {
      const pair = [values[0], values[1]].sort();
      if (!friendships.some(friendship => friendship.account_low === pair[0] && friendship.account_high === pair[1])) {
        friendships.push({ account_low: pair[0], account_high: pair[1] });
      }
      return [{ account_low: pair[0], account_high: pair[1] }];
    }

    if (query.startsWith('INSERT INTO friend_requests (sender_id, recipient_id) VALUES ($1, $2) RETURNING')) {
      const senderId = values[0];
      const recipientId = values[1];
      requestId++;
      const request = {
        id: `30000000-0000-4000-8000-${String(requestId).padStart(12, '0')}`,
        sender_id: senderId,
        recipient_id: recipientId,
        status: 'pending',
        created_at: new Date().toISOString(),
      };
      requests.push(request);
      return [request];
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
  sql.begin = async callback => callback(sql);

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

test('friend requests are idempotent, accept only for recipient, and create one friendship', async () => {
  const db = makeFriendsDb();
  const request = response();
  await sendRequest({ method: 'POST', headers: {}, body: { username: 'Ada' } }, request, dependencies(db, ids.ada));
  assert.equal(request.statusCode, 400);
  assert.equal(db.requests.length, 0);

  const sent = response();
  await sendRequest({ method: 'POST', headers: {}, body: { username: 'Bea' } }, sent, dependencies(db, ids.ada));
  assert.equal(sent.statusCode, 201);
  assert.equal(db.requests.length, 1);

  const duplicate = response();
  await sendRequest({ method: 'POST', headers: {}, body: { username: 'bea' } }, duplicate, dependencies(db, ids.ada));
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.body.alreadyPending, true);
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
  assert.equal(duplicateFriendRequest.statusCode, 200);
  assert.equal(duplicateFriendRequest.body.alreadyFriends, true);
  assert.equal(db.friendships.length, 1);
});

test('crossed friend requests automatically become a friendship', async () => {
  const db = makeFriendsDb();

  const first = response();
  await sendRequest({ method: 'POST', headers: {}, body: { username: 'Bea' } }, first, dependencies(db, ids.ada));
  assert.equal(first.statusCode, 201);
  assert.equal(db.requests.length, 1);

  const crossed = response();
  await sendRequest({ method: 'POST', headers: {}, body: { username: 'Ada' } }, crossed, dependencies(db, ids.bea));
  assert.equal(crossed.statusCode, 200);
  assert.equal(crossed.body.autoAccepted, true);
  assert.equal(db.requests[0].status, 'accepted');
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
