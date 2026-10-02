const cards = require('../game-cards');
// Versioned metadata lives in the existing JSONB document so old boards need no migration.
const DECK_KEY = '__cardDecksV1';
function publicBoard(board) {
  if (!board) return board;
  const stored = board.property_names || {};
  const property_names = Object.fromEntries(Object.entries(stored).filter(([key]) => /^(?:[0-9]|[1-3][0-9])$/.test(key)));
  return { ...board, property_names, card_decks: cards.normalizeDecks(stored[DECK_KEY]) };
}
function storedBoard(names, decks) { return { ...names, [DECK_KEY]: cards.normalizeDecks(decks) }; }
module.exports = { publicBoard, storedBoard };
