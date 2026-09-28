const { database, noStore, parseBody, requireAccount, requireMethod, requireSameOrigin, sendError } = require('../../lib/account');

const SETTING_KEYS = new Set([
  'musicVolume', 'soundEffectsVolume', 'gamePreferences',
  'interfacePreferences', 'cameraPreferences', 'other',
]);

module.exports = async function settings(req, res) {
  noStore(res);
  try {
    if (!['GET', 'PATCH'].includes(req.method)) {
      res.setHeader('Allow', 'GET, PATCH');
      return sendError(res, 405, 'Method not allowed.');
    }
    if (req.method === 'PATCH' && !requireSameOrigin(req, res)) return;
    const account = await requireAccount(req, res);
    if (!account) return;
    if (req.method === 'GET') return res.status(200).json({ settings: account.settings || {} });

    const { settings } = parseBody(req);
    if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
        Object.keys(settings).some(key => !SETTING_KEYS.has(key))) {
      return sendError(res, 400, 'Settings payload is invalid.');
    }
    for (const key of ['musicVolume', 'soundEffectsVolume']) {
      if (key in settings && (!Number.isFinite(settings[key]) || settings[key] < 0 || settings[key] > 100)) {
        return sendError(res, 400, `${key} must be between 0 and 100.`);
      }
    }
    const merged = { ...(account.settings || {}), ...settings };
    const serialized = JSON.stringify(merged);
    if (Buffer.byteLength(serialized, 'utf8') > 16384) return sendError(res, 413, 'Settings payload is too large.');
    const rows = await database()`UPDATE accounts SET settings = ${serialized}::jsonb, updated_at = now()
      WHERE id = ${account.id} RETURNING settings`;
    return res.status(200).json({ settings: rows[0].settings });
  } catch (error) {
    console.error('Settings request failed:', error);
    return sendError(res, 500, 'Could not load or save account settings.');
  }
};