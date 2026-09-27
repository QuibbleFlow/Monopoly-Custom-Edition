const { database, noStore, parseBody, requireAccount, requireSameOrigin, sendError } = require('../../lib/account');

const PROPERTY_INDEXES = new Set([1, 3, 6, 8, 9, 11, 13, 14, 16, 18, 19, 21, 23, 24, 26, 27, 29, 31, 32, 34, 37, 39]);

function validName(value) {
  return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 40;
}

function validPropertyNames(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, name]) => {
    const index = Number(key);
    return String(index) === key && PROPERTY_INDEXES.has(index) &&
      typeof name === 'string' && name.trim().length >= 1 && name.trim().length <= 32;
  });
}

function cleanPropertyNames(value) {
  return Object.fromEntries(Object.entries(value).map(([key, name]) => [key, name.trim()]));
}

module.exports = async function boards(req, res) {
  noStore(res);
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return sendError(res, 405, 'Method not allowed.');
  }
  if (req.method === 'POST' && !requireSameOrigin(req, res)) return;
  try {
    const account = await requireAccount(req, res);
    if (!account) return;
    if (req.method === 'GET') {
      const rows = await database()`SELECT id, name, property_names, copied_from, created_at, updated_at
        FROM custom_boards WHERE owner_id = ${account.id}
        ORDER BY updated_at DESC, created_at DESC`;
      return res.status(200).json({ boards: rows });
    }

    const { name, propertyNames = {} } = parseBody(req);
    if (!validName(name) || !validPropertyNames(propertyNames)) {
      return sendError(res, 400, 'Board name or property names are invalid. Only the 22 regular property spaces can be renamed.');
    }
    const rows = await database()`INSERT INTO custom_boards (owner_id, name, property_names)
      VALUES (${account.id}, ${name.trim()}, ${JSON.stringify(cleanPropertyNames(propertyNames))}::jsonb)
      RETURNING id, name, property_names, copied_from, created_at, updated_at`;
    return res.status(201).json({ board: rows[0] });
  } catch (error) {
    console.error('Custom board request failed:', error);
    return sendError(res, 500, 'Could not load or create custom boards.');
  }
};