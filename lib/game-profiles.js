async function syncGameAvatars(sql, state) {
  const ids = [...new Set(state.players.map(player => player.accountId).filter(Boolean))];
  if (!ids.length) return;
  const rows = await sql`SELECT id, avatar_url FROM accounts WHERE id = ANY(${ids}::uuid[])`;
  const avatars = new Map(rows.map(row => [row.id, row.avatar_url || null]));
  for (const player of state.players) if (avatars.has(player.accountId)) player.avatarUrl = avatars.get(player.accountId);
}
module.exports = { syncGameAvatars };
