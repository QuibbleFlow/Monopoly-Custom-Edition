const SAVE_LIMIT = 2;

async function lockSaveOwner(tx, accountId) {
  // Serialize saves from different matches owned by the same account.
  await tx`SELECT id FROM accounts WHERE id = ${accountId} FOR UPDATE`;
}

async function trimSaveSlots(tx, accountId) {
  const rows = await tx`SELECT id FROM game_saves WHERE owner_id = ${accountId}
    ORDER BY created_at DESC, id DESC FOR UPDATE`;
  for (const row of rows.slice(SAVE_LIMIT)) {
    await tx`DELETE FROM game_saves WHERE id = ${row.id} AND owner_id = ${accountId}`;
  }
  return rows.slice(SAVE_LIMIT).length;
}

module.exports = { SAVE_LIMIT, lockSaveOwner, trimSaveSlots };
