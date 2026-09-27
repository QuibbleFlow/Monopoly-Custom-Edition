const bcrypt = require('bcryptjs');
const { createSession, database, noStore, parseBody, requireMethod, requireSameOrigin, sendError, USERNAME_PATTERN } = require('../../lib/account');

module.exports = async function signup(req, res) {
  noStore(res);
  if (!requireMethod(req, res, 'POST') || !requireSameOrigin(req, res)) return;
  try {
    const { username, password } = parseBody(req);
    if (typeof username !== 'string' || !USERNAME_PATTERN.test(username.trim())) {
      return sendError(res, 400, 'Username must be 3-24 letters, numbers, or underscores.');
    }
    if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') < 10 || Buffer.byteLength(password, 'utf8') > 72) {
      return sendError(res, 400, 'Password must be 10-72 bytes long.');
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const rows = await database()`INSERT INTO accounts (username, password_hash)
      VALUES (${username.trim()}, ${passwordHash})
      RETURNING id, username, avatar_url, settings`;
    await createSession(res, rows[0].id);
    return res.status(201).json({ user: rows[0] });
  } catch (error) {
    if (error.code === '23505') return sendError(res, 409, 'That username is already taken.');
    console.error('Account signup failed:', error);
    return sendError(res, 500, 'Account service is unavailable. Check the Vercel function logs.');
  }
};