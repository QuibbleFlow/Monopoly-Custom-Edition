const { database, noStore, parseBody, requireAccount, requireSameOrigin, sendError } = require('../../lib/account');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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

module.exports = async function board(req, res) {
  noStore(res);
  if (!['GET', 'PATCH', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', 'GET, PATCH, DELETE');
    return sendError(res, 405, 'Method not allowed.');
  }
  if (req.method !== 'GET' && !requireSameOrigin(req, res)) return;
  try {
    const account = await requireAccount(req, res);
    if (!account) return;
    const id = String(req.query.id || '');
    if (!UUID_PATTERN.test(id)) return sendError(res, 400, 'Board ID is invalid.');

    if (req.method === 'GET') {
      const rows = await database()`SELECT id, name, property_names, copied_from, created_at, updated_at
        FROM custom_boards WHERE id = ${id} AND owner_id = ${account.id}`;
      if (!rows[0]) return sendError(res, 404, 'Board not found.');
      return res.status(200).json({ board: rows[0] });
    }

    if (req.method === 'DELETE') {
      const rows = await database()`DELETE FROM custom_boards
        WHERE id = ${id} AND owner_id = ${account.id} RETURNING id`;
      if (!rows[0]) return sendError(res, 404, 'Board not found.');
      return res.status(200).json({ ok: true });
    }

    const body = parseBody(req);
    if (body.name !== undefined && !validName(body.name)) return sendError(res, 400, 'Board name must be 1-40 characters.');
    if (body.propertyNames !== undefined && !validPropertyNames(body.propertyNames)) {
      return sendError(res, 400, 'Only the 22 regular property spaces can be renamed.');
    }
    if (body.name === undefined && body.propertyNames === undefined) return sendError(res, 400, 'No board changes were provided.');

    const currentRows = await database()`SELECT name, property_names FROM custom_boards
      WHERE id = ${id} AND owner_id = ${account.id}`;
    if (!currentRows[0]) return sendError(res, 404, 'Board not found.');
    const name = body.name === undefined ? currentRows[0].name : body.name.trim();
    const propertyNames = body.propertyNames === undefined
      ? currentRows[0].property_names
      : { ...currentRows[0].property_names, ...cleanPropertyNames(body.propertyNames) };
    const updated = await database()`UPDATE custom_boards SET name = ${name},
      property_names = ${JSON.stringify(propertyNames)}::jsonb, updated_at = now()
      WHERE id = ${id} AND owner_id = ${account.id}
      RETURNING id, name, property_names, copied_from, created_at, updated_at`;
    if (!updated[0]) return sendError(res, 404, 'Board not found.');
    return res.status(200).json({ board: updated[0] });
  } catch (error) {
    console.error('Custom board update failed:', error);
    return sendError(res, 500, 'Could not update that board.');
  }
};