const { publicBoard, storedBoard } = require('../../lib/custom-boards');
const cards = require('../../game-cards');
const { database, noStore, parseBody, requireAccount, requireSameOrigin, sendError } = require('../../lib/account');

const SPACE_INDEXES = new Set(Array.from({ length: 40 }, (_, index) => index));

function validName(value) {
  return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 40;
}

function validPropertyNames(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, name]) => {
    const index = Number(key);
    return String(index) === key && SPACE_INDEXES.has(index) &&
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
      return res.status(200).json({ boards: rows.map(publicBoard) });
    }

    const { name, propertyNames = {}, cardDecks } = parseBody(req);
    if (!validName(name) || !validPropertyNames(propertyNames)) {
      return sendError(res, 400, 'Board name must be 1-40 characters. Space names must be 1-32 characters and use square IDs 0-39.');
    }
    let decks;
    try { decks = cards.normalizeDecks(cardDecks); } catch (error) { return sendError(res, 400, error.message); }
    const rows = await database()`INSERT INTO custom_boards (owner_id, name, property_names)
      VALUES (${account.id}, ${name.trim()}, ${JSON.stringify(storedBoard(cleanPropertyNames(propertyNames), decks))}::jsonb)
      RETURNING id, name, property_names, copied_from, created_at, updated_at`;
    return res.status(201).json({ board: publicBoard(rows[0]) });
  } catch (error) {
    console.error('Custom board request failed:', error);
    return sendError(res, 500, 'Could not load or create custom boards.');
  }
};