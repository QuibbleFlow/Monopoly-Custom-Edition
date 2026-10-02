const { database, noStore, parseBody, requireAccount, requireMethod, requireSameOrigin, sendError } = require('../../lib/account');

const SETTING_KEYS = new Set([
  'musicVolume', 'soundEffectsVolume', 'gamePreferences',
  'interfacePreferences', 'controllerPreferences', 'other',
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
    if (req.method === 'GET') {
      const saved = { ...(account.settings || {}) };
      if (saved.controllerPreferences) { saved.controllerPreferences = { ...saved.controllerPreferences }; delete saved.controllerPreferences.mode; }
      return res.status(200).json({ settings: saved });
    }

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
    delete merged.cameraPreferences;
    if (merged.controllerPreferences) {
      const prefs = { ...merged.controllerPreferences };
      delete prefs.mode;
      merged.controllerPreferences = prefs;
      if (!Number.isFinite(prefs.sensitivity) ||
          prefs.sensitivity < .4 || prefs.sensitivity > 2.5 || !Number.isFinite(prefs.deadzone) || prefs.deadzone < .1 || prefs.deadzone > .4) {
        return sendError(res, 400, 'Controller settings are invalid.');
      }
    }
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
