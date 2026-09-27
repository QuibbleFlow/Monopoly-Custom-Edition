const { database, noStore, parseBody, requireAccount, requireMethod, requireSameOrigin, sendError, USERNAME_PATTERN } = require('../../lib/account');

module.exports = async function profile(req, res) {
  noStore(res);
  try {
    if (req.method === 'GET') {
      const account = await requireAccount(req, res);
      if (!account) return;
      return res.status(200).json({ user: account });
    }
    if (req.method !== 'PATCH') {
      res.setHeader('Allow', 'GET, PATCH');
      return sendError(res, 405, 'Method not allowed.');
    }
    if (!requireSameOrigin(req, res)) return;
    const account = await requireAccount(req, res);
    if (!account) return;
    const { username } = parseBody(req);
    if (typeof username !== 'string' || !USERNAME_PATTERN.test(username.trim())) {
      return sendError(res, 400, 'Username must be 3-24 letters, numbers, or underscores.');
    }
    const rows = await database()`UPDATE accounts SET username = ${username.trim()}, updated_at = now()
      WHERE id = ${account.id} RETURNING id, username, avatar_url, settings`;
    return res.status(200).json({ user: rows[0] });
  } catch (error) {
    if (error.code === '23505') return sendError(res, 409, 'That username is already taken.');
    console.error('Profile update failed:', error);
    return sendError(res, 500, 'Could not update your profile.');
  }
};