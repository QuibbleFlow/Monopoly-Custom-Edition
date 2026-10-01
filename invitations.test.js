const assert = require('node:assert/strict');
const test = require('node:test');
const { createGame, startGame } = require('./api-handlers/game/lifecycle.js');
const {
  sendGameInvitation,
  respondToGameInvitation,
} = require('./api-handlers/game/invitations.js');
const { makeDbState, makeDb } = require('./test-support/mock-db.js');

const accountIds = {
  host: '10000000-0000-4000-8000-000000000001',
  friend: '10000000-0000-4000-8000-000000000002',
  other: '10000000-0000-4000-8000-000000000003',
};

function makeSocialDb() {
  const initial = makeDbState();
  initial.accounts = {
    [accountIds.host]: { username: 'Host', avatar_url: null },
    [accountIds.friend]: { username: 'Friend', avatar_url: null },
    [accountIds.other]: { username: 'Other', avatar_url: null },
  };
  initial.friendships = [{
    account_low: accountIds.host,
    account_high: accountIds.friend,
  }];
  return makeDb(initial);
}

test('game invitations require a current friend, the host, and a WAITING game; duplicates and self-invites are rejected', async () => {
  const db = makeSocialDb();
  const created = await createGame({ account: { id: accountIds.host }, inviteOnly: true, db });

  const self = await sendGameInvitation({
    account: { id: accountIds.host }, gameId: created.gameId,
    inviteeAccountId: accountIds.host, db,
  });
  assert.equal(self.error.code, 'SELF_INVITE');

  const nonFriend = await sendGameInvitation({
    account: { id: accountIds.host }, gameId: created.gameId,
    inviteeAccountId: accountIds.other, db,
  });
  assert.equal(nonFriend.error.code, 'FRIEND_REQUIRED');

  const nonHost = await sendGameInvitation({
    account: { id: accountIds.friend }, gameId: created.gameId,
    inviteeAccountId: accountIds.other, db,
  });
  assert.equal(nonHost.error.code, 'HOST_REQUIRED');

  const uninvitedJoin = await require('./api-handlers/game/lifecycle.js').joinGame({
    account: { id: accountIds.other }, gameId: created.gameId, db,
  });
  assert.equal(uninvitedJoin.error.code, 'INVITATION_REQUIRED');

  const sent = await sendGameInvitation({
    account: { id: accountIds.host }, gameId: created.gameId,
    inviteeAccountId: accountIds.friend, db,
  });
  assert.equal(sent.ok, true);
  assert.equal(sent.invitation.status, 'pending');

  const duplicate = await sendGameInvitation({
    account: { id: accountIds.host }, gameId: created.gameId,
    inviteeAccountId: accountIds.friend, db,
  });
  assert.equal(duplicate.error.code, 'INVITATION_EXISTS');

  const afterStart = await startGame({ account: { id: accountIds.host }, gameId: created.gameId, db });
  assert.equal(afterStart.error.code, 'NOT_ENOUGH_PLAYERS');
});

test('only the invited account can decline or accept; re-invite after decline is idempotent and assigns one seat', async () => {
  const db = makeSocialDb();
  const created = await createGame({ account: { id: accountIds.host }, inviteOnly: true, db });
  const sent = await sendGameInvitation({
    account: { id: accountIds.host }, gameId: created.gameId,
    inviteeAccountId: accountIds.friend, db,
  });

  const unauthorized = await respondToGameInvitation({
    account: { id: accountIds.other }, invitationId: sent.invitation.id,
    action: 'accept', db,
  });
  assert.equal(unauthorized.error.code, 'INVITATION_NOT_FOUND');

  const declined = await respondToGameInvitation({
    account: { id: accountIds.friend }, invitationId: sent.invitation.id,
    action: 'decline', db,
  });
  assert.equal(declined.status, 'declined');

  const resent = await sendGameInvitation({
    account: { id: accountIds.host }, gameId: created.gameId,
    inviteeAccountId: accountIds.friend, db,
  });
  assert.equal(resent.invitation.id, sent.invitation.id);
  assert.equal(resent.invitation.status, 'pending');

  const accepted = await respondToGameInvitation({
    account: { id: accountIds.friend }, invitationId: sent.invitation.id,
    action: 'accept', db,
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.gameId, created.gameId);
  assert.deepEqual(accepted.players.map(player => player.accountId), [accountIds.host, accountIds.friend]);
  assert.deepEqual(accepted.players.map(player => player.seatIndex), [0, 1]);

  const repeated = await respondToGameInvitation({
    account: { id: accountIds.friend }, invitationId: sent.invitation.id,
    action: 'accept', db,
  });
  assert.equal(repeated.ok, true);
  assert.equal(repeated.alreadyJoined, true);
  assert.deepEqual(repeated.players.map(player => player.accountId), [accountIds.host, accountIds.friend]);
  assert.equal(db.state.players.filter(player => player.game_id === created.gameId && player.account_id === accountIds.friend).length, 1);
});
