const bcrypt = require('bcryptjs');
const { createSession, database, noStore, parseBody, requireMethod, requireSameOrigin, sendError } = require('../../lib/account');

module.exports = async function signin(req, res) {
  noStore(res);
  if (!requireMethod(req, res, 'POST') || !requireSameOrigin(req, res)) return;
  try {
    const { username, password } = parseBody(req);
    if (typeof username !== 'string' || typeof password !== 'string') {
      return sendError(res, 400, 'Enter your username and password.');
    }
    const rows = await database()`SELECT id, username, password_hash, avatar_url, settings
      FROM accounts WHERE lower(username) = lower(${username.trim()}) LIMIT 1`;
    if (!rows[0] || !(await bcrypt.compare(password, rows[0].password_hash))) {
      return sendError(res, 401, 'Username or password is incorrect.');
    }
    await createSession(res, rows[0].id);
    return res.status(200).json({ user: { id: rows[0].id, username: rows[0].username, avatar_url: rows[0].avatar_url, settings: rows[0].settings } });
  } catch (error) {
    console.error('Account signin failed:', error);
    return sendError(res, 500, 'Account service is unavailable. Check the Vercel function logs.');
  }
};