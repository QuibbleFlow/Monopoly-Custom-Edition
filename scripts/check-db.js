const { neon } = require('@neondatabase/serverless');

const expectedColumns = {
  accounts: ['id', 'username', 'password_hash', 'avatar_url', 'settings', 'created_at', 'updated_at'],
  account_sessions: ['token_hash', 'account_id', 'expires_at', 'created_at', 'last_seen_at'],
  friend_requests: ['id', 'sender_id', 'recipient_id', 'status', 'created_at', 'responded_at'],
  friendships: ['account_low', 'account_high', 'created_at'],
  custom_boards: ['id', 'owner_id', 'name', 'property_names', 'copied_from', 'created_at', 'updated_at'],
};

const expectedIndexes = [
  'accounts_pkey',
  'accounts_username_lower_unique',
  'account_sessions_pkey',
  'account_sessions_expiry_idx',
  'friend_requests_pkey',
  'friend_requests_pending_pair_unique',
  'friend_requests_recipient_status_idx',
  'friendships_pkey',
  'custom_boards_pkey',
  'custom_boards_owner_updated_idx',
];

const expectedForeignKeys = [
  'account_sessions_account_id_fkey',
  'friend_requests_sender_id_fkey',
  'friend_requests_recipient_id_fkey',
  'friendships_account_low_fkey',
  'friendships_account_high_fkey',
  'custom_boards_owner_id_fkey',
];

const expectedCheckConstraints = [
  'friend_requests_status_check',
  'friend_requests_check',
  'friendships_check',
  'custom_boards_name_check',
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set; Neon connection was not attempted.');
    process.exitCode = 1;
    return;
  }

  try {
    const sql = neon(process.env.DATABASE_URL);
    const [database] = await sql`SELECT current_database() AS database_name, current_schema() AS schema_name`;
    const columns = await sql`SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ANY(ARRAY['accounts', 'account_sessions', 'friend_requests', 'friendships', 'custom_boards'])`;
    const indexes = await sql`SELECT indexname FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname = ANY(ARRAY['accounts_pkey', 'accounts_username_lower_unique',
          'account_sessions_pkey', 'account_sessions_expiry_idx', 'friend_requests_pkey',
          'friend_requests_pending_pair_unique', 'friend_requests_recipient_status_idx',
          'friendships_pkey', 'custom_boards_pkey', 'custom_boards_owner_updated_idx'])`;
    const foreignKeys = await sql`SELECT conname FROM pg_constraint
      WHERE connamespace = to_regnamespace(current_schema()) AND contype = 'f'
        AND conname = ANY(ARRAY['account_sessions_account_id_fkey', 'friend_requests_sender_id_fkey',
          'friend_requests_recipient_id_fkey', 'friendships_account_low_fkey',
          'friendships_account_high_fkey', 'custom_boards_owner_id_fkey'])`;
    const checkConstraints = await sql`SELECT conname FROM pg_constraint
      WHERE connamespace = to_regnamespace(current_schema()) AND contype = 'c'
        AND conname = ANY(ARRAY['friend_requests_status_check', 'friend_requests_check',
          'friendships_check', 'custom_boards_name_check'])`;

    const foundColumns = new Map();
    for (const row of columns) {
      if (!foundColumns.has(row.table_name)) foundColumns.set(row.table_name, new Set());
      foundColumns.get(row.table_name).add(row.column_name);
    }

    const missing = [];
    for (const [table, required] of Object.entries(expectedColumns)) {
      const found = foundColumns.get(table);
      if (!found) missing.push(`table ${table}`);
      else for (const column of required) if (!found.has(column)) missing.push(`${table}.${column}`);
    }
    const foundIndexes = new Set(indexes.map(row => row.indexname));
    for (const index of expectedIndexes) if (!foundIndexes.has(index)) missing.push(`index ${index}`);
    const foundForeignKeys = new Set(foreignKeys.map(row => row.conname));
    for (const foreignKey of expectedForeignKeys) if (!foundForeignKeys.has(foreignKey)) missing.push(`foreign key ${foreignKey}`);
    const foundCheckConstraints = new Set(checkConstraints.map(row => row.conname));
    for (const constraint of expectedCheckConstraints) if (!foundCheckConstraints.has(constraint)) missing.push(`check constraint ${constraint}`);

    if (missing.length) {
      console.error(`Connected to Neon database ${database.database_name}, schema ${database.schema_name}, but the schema is incomplete:`);
      for (const item of missing) console.error(`- Missing ${item}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Neon connection and expected schema verified: ${database.database_name} (${database.schema_name}).`);
  } catch {
    console.error('Neon connection/schema check failed. Verify DATABASE_URL, network access, and database permissions. The connection string was not displayed.');
    process.exitCode = 1;
  }
}

main();