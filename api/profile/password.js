const bcrypt = require('bcryptjs');
const { database, noStore, parseBody, requireAccount, requireMethod, requireSameOrigin, sendError } = require('../../lib/account');

module.exports = async function changePassword(req, res) {
  noStore(res);
  if (!requireMethod(req, res, 'POST') || !requireSameOrigin(req, res)) return;
  try {
    const account = await requireAccount(req, res);
    if (!account) return;
    const { currentPassword, newPassword } = parseBody(req);
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' ||
        Buffer.byteLength(newPassword, 'utf8') < 10 || Buffer.byteLength(newPassword, 'utf8') > 72) {
      return sendError(res, 400, 'Enter your current password and a new password of 10-72 bytes.');
    }
    const rows = await database()`SELECT password_hash FROM accounts WHERE id = ${account.id}`;
    if (!rows[0] || !(await bcrypt.compare(currentPassword, rows[0].password_hash))) {
      return sendError(res, 401, 'Current password is incorrect.');
    }
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await database()`UPDATE accounts SET password_hash = ${passwordHash}, updated_at = now() WHERE id = ${account.id}`;
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Password change failed:', error);
    return sendError(res, 500, 'Could not change your password.');
  }
};