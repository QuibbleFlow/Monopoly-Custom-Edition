const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const account = require('./lib/account');
const picture = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/3ioAAAAASUVORK5CYII=';
function handler({ token = '', uploadFails = false, cleanupFails = false } = {}) {
  let stored = token ? 'https://test.public.blob.vercel-storage.com/old.png' : null;
  const deletions = [];
  const sql = async (strings, ...values) => {
    if (strings.join('').startsWith('SELECT')) return [{ avatar_url: stored }];
    stored = strings.join('').includes('avatar_url = NULL') ? null : values[0];
    return [];
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync('./api-handlers/profile/avatar.js', 'utf8'), {
    module, Buffer, process: { env: { BLOB_READ_WRITE_TOKEN: token } }, console: { warn() {}, error() {} },
    require: name => name === '@vercel/blob' ? {
      put: async () => { if (uploadFails) throw new Error('Unavailable'); return { url: 'https://test.public.blob.vercel-storage.com/new.png' }; },
      del: async url => { deletions.push(url); if (cleanupFails) throw new Error('Cleanup unavailable'); },
    } : { ...account, database: () => sql, requireAccount: async () => ({ id: 'owner' }), requireSameOrigin: () => true },
  });
  return { run: module.exports, stored: () => stored, deletions };
}
function response() { return { setHeader() {}, statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } }; }
test('avatar upload persists without a Blob token and removal clears it', async () => {
  const avatar = handler(); const res = response();
  await avatar.run({ method: 'POST', body: { image: picture } }, res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.avatar_url, picture); assert.equal(avatar.stored(), picture);
  const removed = response(); await avatar.run({ method: 'DELETE' }, removed);
  assert.equal(removed.statusCode, 200); assert.equal(avatar.stored(), null);
});
test('unavailable Blob storage falls back and cleanup failures do not break successful uploads', async () => {
  for (const uploadFails of [false, true]) {
    const avatar = handler({ token: 'configured', uploadFails, cleanupFails: true }); const res = response();
    await avatar.run({ method: 'POST', body: { image: picture } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(avatar.stored(), uploadFails ? picture : 'https://test.public.blob.vercel-storage.com/new.png');
    const removed = response(); await avatar.run({ method: 'DELETE' }, removed);
    assert.equal(removed.statusCode, 200); assert.equal(avatar.stored(), null);
  }
});
test('avatar upload rejects unsupported, invalid and oversized images without changing the account', async () => {
  const avatar = handler();
  for (const [image, status] of [
    ['data:image/svg+xml;base64,PHN2Zz4=', 400],
    ['data:image/png;base64,aGVsbG8=', 400],
    ['data:image/png;base64,' + Buffer.alloc(256 * 1024 + 1).toString('base64'), 413],
  ]) {
    const res = response(); await avatar.run({ method: 'POST', body: { image } }, res);
    assert.equal(res.statusCode, status); assert.equal(avatar.stored(), null);
  }
});
