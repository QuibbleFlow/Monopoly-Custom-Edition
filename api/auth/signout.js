const { noStore, parseBody, requireMethod, requireSameOrigin, revokeSession, sendError, setSessionCookie } = require('../../lib/account');

module.exports = async function signout(req, res) {
  noStore(res);
  if (!requireMethod(req, res, 'POST') || !requireSameOrigin(req, res)) return;
  try {
    parseBody(req);
    await revokeSession(req);
    setSessionCookie(res, '', 0);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Account signout failed:', error);
    return sendError(res, 500, 'Could not sign out.');
  }
};