const { neon } = require('@neondatabase/serverless');

const expectedColumns = {
  accounts: ['id', 'username', 'password_hash', 'avatar_url', 'settings', 'created_at', 'updated_at'],
  account_sessions: ['token_hash', 'account_id', 'expires_at', 'created_at', 'last_seen_at'],
  friend_requests: ['id', 'sender_id', 'recipient_id', 'status', 'created_at', 'responded_at'],
  friendships: ['account_low', 'account_high', 'created_at'],
  custom_boards: ['id', 'owner_id', 'name', 'property_names', 'copied_from', 'created_at', 'updated_at'],
  games: ['id', 'host_account_id', 'status', 'invite_only', 'selected_board_id', 'resume_save_id', 'created_at', 'started_at', 'paused_at', 'finished_at', 'updated_at'],
  game_players: ['game_id', 'account_id', 'seat_index', 'joined_at', 'returned_at', 'results_seen_at'],
  game_states: ['id', 'owner_id', 'state', 'board', 'version', 'created_at', 'updated_at'],
  game_action_requests: ['game_id', 'request_id', 'result_json', 'created_at'],
  game_saves: ['id', 'owner_id', 'source_game_id', 'name', 'status', 'version', 'state', 'board', 'players', 'selected_board_id', 'created_at', 'updated_at'],
  game_results: ['game_id', 'winner_account_id', 'placements', 'created_at'],
  game_invitations: ['id', 'game_id', 'inviter_account_id', 'invitee_account_id', 'status', 'created_at', 'responded_at'],
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
  'games_pkey',
  'games_resume_save_idx',
  'game_players_pkey',
  'game_players_game_id_seat_index_key',
  'game_players_account_idx',
  'game_players_game_seat_idx',
  'game_states_pkey',
  'game_action_requests_pkey',
  'game_action_requests_game_created_idx',
  'game_saves_pkey',
  'game_saves_owner_updated_idx',
  'game_results_pkey',
  'game_results_winner_idx',
  'game_invitations_pkey',
  'game_invitations_game_invitee_unique',
  'game_invitations_invitee_status_idx',
  'game_invitations_inviter_status_idx',
];

const expectedForeignKeys = [
  'account_sessions_account_id_fkey',
  'friend_requests_sender_id_fkey',
  'friend_requests_recipient_id_fkey',
  'friendships_account_low_fkey',
  'friendships_account_high_fkey',
  'custom_boards_owner_id_fkey',
  'games_host_account_id_fkey',
  'game_players_game_id_fkey',
  'game_players_account_id_fkey',
  'game_states_owner_id_fkey',
  'game_saves_owner_id_fkey',
  'game_results_game_id_fkey',
  'game_results_winner_account_id_fkey',
  'game_invitations_game_id_fkey',
  'game_invitations_inviter_account_id_fkey',
  'game_invitations_invitee_account_id_fkey',
  'game_states_id_fkey',
  'game_action_requests_game_id_fkey',
];

const expectedCheckConstraints = [
  'friend_requests_status_check',
  'friend_requests_check',
  'friendships_check',
  'custom_boards_name_check',
  'games_status_check',
  'game_players_seat_index_check',
  'game_saves_name_check',
  'game_saves_status_check',
  'game_saves_version_check',
  'game_invitations_status_check',
  'game_invitations_check',
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
          AND table_name = ANY(ARRAY['accounts', 'account_sessions', 'friend_requests', 'friendships', 'custom_boards',
            'games', 'game_players', 'game_states', 'game_action_requests', 'game_saves', 'game_results', 'game_invitations'])`;
    const indexes = await sql`SELECT indexname FROM pg_indexes
      WHERE schemaname = current_schema()
          AND indexname = ANY(ARRAY['accounts_pkey', 'accounts_username_lower_unique',
            'account_sessions_pkey', 'account_sessions_expiry_idx', 'friend_requests_pkey',
            'friend_requests_pending_pair_unique', 'friend_requests_recipient_status_idx',
            'friendships_pkey', 'custom_boards_pkey', 'custom_boards_owner_updated_idx',
            'games_pkey', 'games_resume_save_idx', 'game_players_pkey', 'game_players_game_id_seat_index_key',
            'game_players_account_idx', 'game_players_game_seat_idx', 'game_states_pkey',
            'game_action_requests_pkey', 'game_action_requests_game_created_idx', 'game_saves_pkey',
            'game_saves_owner_updated_idx', 'game_results_pkey', 'game_results_winner_idx',
            'game_invitations_pkey', 'game_invitations_game_invitee_unique',
            'game_invitations_invitee_status_idx', 'game_invitations_inviter_status_idx'])`;
    const foreignKeys = await sql`SELECT conname FROM pg_constraint
      WHERE connamespace = to_regnamespace(current_schema()) AND contype = 'f'
          AND conname = ANY(ARRAY['account_sessions_account_id_fkey', 'friend_requests_sender_id_fkey',
            'friend_requests_recipient_id_fkey', 'friendships_account_low_fkey',
            'friendships_account_high_fkey', 'custom_boards_owner_id_fkey',
            'games_host_account_id_fkey', 'game_players_game_id_fkey', 'game_players_account_id_fkey',
            'game_states_owner_id_fkey', 'game_saves_owner_id_fkey', 'game_results_game_id_fkey',
            'game_results_winner_account_id_fkey', 'game_invitations_game_id_fkey',
            'game_invitations_inviter_account_id_fkey', 'game_invitations_invitee_account_id_fkey',
            'game_states_id_fkey', 'game_action_requests_game_id_fkey'])`;
    const checkConstraints = await sql`SELECT conname FROM pg_constraint
      WHERE connamespace = to_regnamespace(current_schema()) AND contype = 'c'
          AND conname = ANY(ARRAY['friend_requests_status_check', 'friend_requests_check',
            'friendships_check', 'custom_boards_name_check', 'games_status_check',
            'game_players_seat_index_check', 'game_saves_name_check', 'game_saves_status_check',
            'game_saves_version_check', 'game_invitations_status_check', 'game_invitations_check'])`;

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