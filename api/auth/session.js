const { currentAccount, noStore, requireMethod, sendError } = require('../../lib/account');

module.exports = async function session(req, res) {
  noStore(res);
  if (!requireMethod(req, res, 'GET')) return;
  try {
    const user = await currentAccount(req);
    return res.status(200).json({ user });
  } catch (error) {
    console.error('Session restore failed:', error);
    return sendError(res, 500, 'Account service is unavailable. Check the Vercel function logs.');
  }
};