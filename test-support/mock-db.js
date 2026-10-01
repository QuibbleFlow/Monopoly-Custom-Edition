function makeDbState() {
  return {
    games: [],
    players: [],
    states: [],
    saves: [],
    results: [],
    actionRequests: [],
    invitations: [],
    friendships: [],
    accounts: {
      'account-a': { username: 'alice', avatar_url: null },
      'account-b': { username: 'bob', avatar_url: null },
      'account-c': { username: 'charlie', avatar_url: null },
      'account-d': { username: 'dana', avatar_url: null },
      'account-z': { username: 'zack', avatar_url: null },
    },
  };
}

function makeDb(initial = makeDbState()) {
  const state = {
    games: initial.games.map(game => ({ ...game })),
    players: initial.players.map(player => ({ ...player })),
    states: initial.states.map(entry => ({ ...entry })),
    saves: (initial.saves || []).map(entry => ({ ...entry })),
    results: (initial.results || []).map(entry => ({ ...entry })),
    actionRequests: (initial.actionRequests || []).map(entry => ({ ...entry })),
    invitations: (initial.invitations || []).map(entry => ({ ...entry })),
    friendships: (initial.friendships || []).map(entry => ({ ...entry })),
    accounts: { ...initial.accounts },
  };

  const tx = Object.assign(async function sql(strings, ...values) {
    const query = strings.reduce((result, part, index) => {
      const value = index < values.length ? `$${index + 1}` : '';
      return result + part + value;
    }, '').replace(/\s+/g, ' ').trim();

    if (query.startsWith('SELECT 1 FROM game_players WHERE game_id = $1 AND account_id = $2')) {
      const found = state.players.some(player => player.game_id === values[0] && player.account_id === values[1]);
      return found ? [{ '?column?': 1 }] : [];
    }
    if (query.startsWith('SELECT * FROM game_players WHERE game_id = $1 AND account_id = $2')) {
      return state.players.filter(player => player.game_id === values[0] && player.account_id === values[1]);
    }
    if (query.startsWith('SELECT account_id FROM game_players WHERE game_id = $1 AND account_id = $2 FOR UPDATE')) {
      return state.players.filter(player => player.game_id === values[0] && player.account_id === values[1])
        .map(player => ({ account_id: player.account_id }));
    }
    if (query.startsWith('SELECT gp.game_id, gp.account_id, gp.seat_index, gp.joined_at, gp.returned_at, a.username, a.avatar_url FROM game_players gp JOIN accounts a ON a.id = gp.account_id WHERE gp.game_id = $1 ORDER BY gp.seat_index ASC')) {
      return state.players.filter(player => player.game_id === values[0]).sort((a, b) => a.seat_index - b.seat_index).map(player => ({
        game_id: player.game_id,
        account_id: player.account_id,
        seat_index: player.seat_index,
        joined_at: player.joined_at,
        returned_at: player.returned_at || null,
        username: state.accounts[player.account_id]?.username || null,
        avatar_url: state.accounts[player.account_id]?.avatar_url || null,
      }));
    }
    if (query.startsWith('UPDATE game_players SET returned_at = now() WHERE game_id = $1 AND account_id = $2')) {
      const player = state.players.find(entry => entry.game_id === values[0] && entry.account_id === values[1]);
      if (player) player.returned_at = new Date().toISOString();
      return [{ ok: true }];
    }
    if (query.startsWith('UPDATE game_players SET returned_at = NULL WHERE game_id = $1 AND account_id = $2')) {
      const player = state.players.find(entry => entry.game_id === values[0] && entry.account_id === values[1]);
      if (player) player.returned_at = null;
      return [{ ok: true }];
    }
    if (query.startsWith('UPDATE game_players SET returned_at = NULL WHERE game_id = $1')) {
      state.players.filter(entry => entry.game_id === values[0]).forEach(player => { player.returned_at = null; });
      return [{ ok: true }];
    }
    if (query.startsWith('UPDATE game_players SET results_seen_at = now() WHERE game_id = $1 AND account_id = $2')) {
      const player = state.players.find(entry => entry.game_id === values[0] && entry.account_id === values[1]);
      if (player) player.results_seen_at = new Date().toISOString();
      return [{ ok: true }];
    }
    if (query.startsWith('SELECT COUNT(*)::int AS total, COUNT(results_seen_at)::int AS seen FROM game_players WHERE game_id = $1')) {
      const players = state.players.filter(entry => entry.game_id === values[0]);
      return [{ total: players.length, seen: players.filter(player => player.results_seen_at).length }];
    }
    if (query.startsWith('SELECT gp.account_id, gp.seat_index, a.username, a.avatar_url FROM game_players gp JOIN accounts a ON a.id = gp.account_id WHERE gp.game_id = $1 ORDER BY gp.seat_index ASC')) {
      return state.players.filter(player => player.game_id === values[0]).sort((a, b) => a.seat_index - b.seat_index).map(player => ({
        account_id: player.account_id,
        seat_index: player.seat_index,
        username: state.accounts[player.account_id]?.username || null,
        avatar_url: state.accounts[player.account_id]?.avatar_url || null,
      }));
    }
    if (query.startsWith('SELECT gp.account_id, gp.seat_index, a.username FROM game_players gp JOIN accounts a ON a.id = gp.account_id WHERE gp.game_id = $1 ORDER BY gp.seat_index ASC')) {
      return state.players.filter(player => player.game_id === values[0]).sort((a, b) => a.seat_index - b.seat_index).map(player => ({
        account_id: player.account_id,
        seat_index: player.seat_index,
        username: state.accounts[player.account_id]?.username || null,
      }));
    }
    if (query.startsWith('SELECT COUNT(*)::int AS total FROM game_players WHERE game_id = $1')) {
      return [{ total: state.players.filter(player => player.game_id === values[0]).length }];
    }
    if (query.startsWith('SELECT seat_index FROM game_players WHERE game_id = $1 ORDER BY seat_index ASC FOR UPDATE')) {
      return state.players.filter(player => player.game_id === values[0]).sort((a, b) => a.seat_index - b.seat_index)
        .map(player => ({ seat_index: player.seat_index }));
    }
    if (query.startsWith('SELECT 1 FROM friendships WHERE account_low = LEAST($1::uuid, $2::uuid) AND account_high = GREATEST($3::uuid, $4::uuid) FOR KEY SHARE')) {
      const pair = [values[0], values[1]].sort();
      return state.friendships.some(friendship => friendship.account_low === pair[0] && friendship.account_high === pair[1])
        ? [{ '?column?': 1 }]
        : [];
    }
    if (query.startsWith('SELECT id, status FROM game_invitations WHERE game_id = $1 AND invitee_account_id = $2 FOR UPDATE')) {
      return state.invitations.filter(invitation => invitation.game_id === values[0] && invitation.invitee_account_id === values[1])
        .map(invitation => ({ id: invitation.id, status: invitation.status }));
    }
    if (query.startsWith('SELECT game_id FROM game_invitations WHERE id = $1 AND invitee_account_id = $2')) {
      return state.invitations.filter(invitation => invitation.id === values[0] && invitation.invitee_account_id === values[1])
        .map(invitation => ({ game_id: invitation.game_id }));
    }
    if (query.startsWith('SELECT * FROM game_invitations WHERE id = $1 AND invitee_account_id = $2 FOR UPDATE')) {
      return state.invitations.filter(invitation => invitation.id === values[0] && invitation.invitee_account_id === values[1]);
    }
    if (query.startsWith('INSERT INTO game_invitations')) {
      const invitation = {
        id: `invitation-${state.invitations.length + 1}`,
        game_id: values[0],
        inviter_account_id: values[1],
        invitee_account_id: values[2],
        status: 'pending',
        created_at: new Date().toISOString(),
        responded_at: null,
      };
      state.invitations.push(invitation);
      return [{ id: invitation.id, game_id: invitation.game_id, invitee_account_id: invitation.invitee_account_id, status: invitation.status, created_at: invitation.created_at }];
    }
    if (query.startsWith('UPDATE game_invitations SET inviter_account_id = $1, status = $2, created_at = now(), responded_at = NULL WHERE id = $3')) {
      const invitation = state.invitations.find(entry => entry.id === values[2]);
      if (invitation) {
        invitation.inviter_account_id = values[0];
        invitation.status = values[1];
        invitation.created_at = new Date().toISOString();
        invitation.responded_at = null;
      }
      return invitation ? [{ ...invitation }] : [];
    }
    if (query.startsWith("UPDATE game_invitations SET status = $1, responded_at = now() WHERE id = $2 AND status = 'pending'")) {
      const invitation = state.invitations.find(entry => entry.id === values[1] && entry.status === 'pending');
      if (invitation) {
        invitation.status = values[0];
        invitation.responded_at = new Date().toISOString();
      }
      return invitation ? [{ ...invitation }] : [];
    }
    if (query.startsWith('SELECT account_id, seat_index FROM game_players WHERE game_id = $1 ORDER BY seat_index ASC FOR UPDATE')) {
      return state.players.filter(player => player.game_id === values[0]).sort((a, b) => a.seat_index - b.seat_index)
        .map(player => ({ account_id: player.account_id, seat_index: player.seat_index }));
    }
    if (query.startsWith('SELECT account_id, seat_index, returned_at FROM game_players WHERE game_id = $1 ORDER BY seat_index ASC')) {
      return state.players.filter(player => player.game_id === values[0]).sort((a, b) => a.seat_index - b.seat_index).map(player => ({
        account_id: player.account_id,
        seat_index: player.seat_index,
        returned_at: player.returned_at || null,
      }));
    }
    if (query.startsWith('INSERT INTO games')) {
      const hasName = query.includes('host_account_id, name, status');
      const hasInviteOnly = query.includes('invite_only');
      let cursor = 2;
      const name = hasName ? values[cursor++] : 'Server game';
      const status = values[cursor++];
      const inviteOnly = hasInviteOnly ? !!values[cursor++] : false;
      const selectedBoardId = values[cursor++] || null;
      const resumeSaveId = query.includes('resume_save_id') ? (values[cursor++] || null) : null;
      state.games.push({
        id: values[0],
        host_account_id: values[1],
        name,
        status,
        invite_only: inviteOnly,
        selected_board_id: selectedBoardId,
        resume_save_id: resumeSaveId,
        created_at: new Date().toISOString(),
        started_at: null,
        paused_at: null,
        finished_at: null,
        updated_at: new Date().toISOString(),
      });
      return [{ ok: true }];
    }
    if (query.startsWith('INSERT INTO game_players')) {
      state.players.push({
        game_id: values[0],
        account_id: values[1],
        seat_index: Number(values[2]),
        joined_at: new Date().toISOString(),
        returned_at: values[3] ? new Date(values[3]).toISOString() : null,
        results_seen_at: null,
      });
      return [{ ok: true }];
    }
    if (query.startsWith('SELECT * FROM game_players WHERE game_id = $1 ORDER BY seat_index ASC')) {
      return state.players.filter(player => player.game_id === values[0]).sort((a, b) => a.seat_index - b.seat_index);
    }
    if (query.startsWith('DELETE FROM game_players WHERE game_id = $1 AND account_id = $2')) {
      state.players = state.players.filter(player => !(player.game_id === values[0] && player.account_id === values[1]));
      return [];
    }
    if (query.startsWith('DELETE FROM game_players WHERE game_id = $1')) {
      state.players = state.players.filter(player => player.game_id !== values[0]);
      return [];
    }
    if (query.startsWith('DELETE FROM game_invitations WHERE game_id = $1')) {
      state.invitations = state.invitations.filter(invitation => invitation.game_id !== values[0]);
      return [];
    }
    if (query.startsWith('DELETE FROM game_results WHERE game_id = $1')) {
      state.results = state.results.filter(result => result.game_id !== values[0]);
      return [];
    }
    if (query.startsWith('DELETE FROM game_action_requests WHERE game_id = $1')) {
      state.actionRequests = state.actionRequests.filter(request => request.game_id !== values[0]);
      return [];
    }
    if (query.startsWith('DELETE FROM games WHERE id = $1')) {
      state.games = state.games.filter(game => game.id !== values[0]);
      state.players = state.players.filter(player => player.game_id !== values[0]);
      state.states = state.states.filter(entry => entry.id !== values[0]);
      state.actionRequests = state.actionRequests.filter(entry => entry.game_id !== values[0]);
      state.results = state.results.filter(entry => entry.game_id !== values[0]);
      state.invitations = state.invitations.filter(entry => entry.game_id !== values[0]);
      return [];
    }
    if (query.startsWith("DELETE FROM games WHERE id = $1 AND status = 'FINISHED'")) {
      const game = state.games.find(entry => entry.id === values[0] && entry.status === 'FINISHED');
      if (game) {
        state.games = state.games.filter(entry => entry.id !== values[0]);
        state.players = state.players.filter(player => player.game_id !== values[0]);
        state.states = state.states.filter(entry => entry.id !== values[0]);
        state.actionRequests = state.actionRequests.filter(entry => entry.game_id !== values[0]);
        state.results = state.results.filter(entry => entry.game_id !== values[0]);
        state.invitations = state.invitations.filter(entry => entry.game_id !== values[0]);
      }
      return [];
    }
    if (query.startsWith("DELETE FROM games WHERE status = 'FINISHED' AND updated_at < now() - interval '30 days'")) {
      const expired = state.games.filter(game => game.status === 'FINISHED' && game.updated_at && Date.now() - new Date(game.updated_at).getTime() > 30 * 24 * 60 * 60 * 1000);
      for (const game of expired) {
        state.games = state.games.filter(entry => entry.id !== game.id);
        state.players = state.players.filter(player => player.game_id !== game.id);
        state.states = state.states.filter(entry => entry.id !== game.id);
        state.actionRequests = state.actionRequests.filter(entry => entry.game_id !== game.id);
        state.results = state.results.filter(entry => entry.game_id !== game.id);
        state.invitations = state.invitations.filter(entry => entry.game_id !== game.id);
      }
      return [];
    }
    if (query.startsWith('DELETE FROM game_states WHERE id = $1')) {
      state.states = state.states.filter(entry => entry.id !== values[0]);
      return [];
    }
    if (query.startsWith("SELECT id FROM games WHERE status = 'FINISHED' AND updated_at < now() - interval '30 days' FOR UPDATE")) {
      return state.games.filter(game => game.status === 'FINISHED' && game.updated_at && Date.now() - new Date(game.updated_at).getTime() > 30 * 24 * 60 * 60 * 1000)
        .map(game => ({ id: game.id }));
    }
    if (query.startsWith('UPDATE games SET host_account_id = $1, updated_at = now() WHERE id = $2')) {
      const game = state.games.find(entry => entry.id === values[1]);
      if (game) {
        game.host_account_id = values[0];
        game.updated_at = new Date().toISOString();
      }
      return [{ ok: true }];
    }
    if (query.startsWith('INSERT INTO game_states')) {
      state.states = state.states.filter(entry => entry.id !== values[0]);
      state.states.push({
        id: values[0],
        owner_id: values[1],
        state: typeof values[2] === 'string' ? JSON.parse(values[2]) : values[2],
        board: typeof values[3] === 'string' ? JSON.parse(values[3]) : values[3],
        version: Number(values[4]),
      });
      return [{ ok: true }];
    }
    if (query.startsWith('UPDATE games SET status = $1, started_at = now(), updated_at = now() WHERE id = $2')) {
      const game = state.games.find(entry => entry.id === values[1]);
      if (game) {
        game.status = values[0];
        game.started_at = new Date().toISOString();
        game.updated_at = new Date().toISOString();
      }
      return [{ ok: true }];
    }
    if (query.startsWith('UPDATE games SET status = $1, started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $2')) {
      const game = state.games.find(entry => entry.id === values[1]);
      if (game) {
        game.status = values[0];
        game.started_at = game.started_at || new Date().toISOString();
        game.updated_at = new Date().toISOString();
      }
      return [{ ok: true }];
    }
    if (query.startsWith('UPDATE games SET status = $1, paused_at = now(), updated_at = now() WHERE id = $2 AND status = $3')) {
      const game = state.games.find(entry => entry.id === values[1] && entry.status === values[2]);
      if (game) {
        game.status = values[0];
        game.paused_at = new Date().toISOString();
        game.updated_at = new Date().toISOString();
      }
      return [{ ok: true }];
    }
    if (query.startsWith('UPDATE games SET status = $1, paused_at = NULL, updated_at = now() WHERE id = $2 AND status = $3')) {
      const game = state.games.find(entry => entry.id === values[1] && entry.status === values[2]);
      if (game) {
        game.status = values[0];
        game.paused_at = null;
        game.updated_at = new Date().toISOString();
      }
      return [{ ok: true }];
    }
    if (query.startsWith('UPDATE games SET status = $1, finished_at = COALESCE(finished_at, now()), updated_at = now() WHERE id = $2 AND (status <> $3 OR finished_at IS NULL)')) {
      const game = state.games.find(entry => entry.id === values[1] && (entry.status !== values[2] || !entry.finished_at));
      if (game) {
        game.status = values[0];
        game.finished_at = game.finished_at || new Date().toISOString();
        game.updated_at = new Date().toISOString();
      }
      return [{ ok: true }];
    }
    if (query.startsWith('SELECT host_account_id FROM games WHERE id = $1')) {
      return state.games.filter(game => game.id === values[0]).map(game => ({ host_account_id: game.host_account_id }));
    }
    if (query.startsWith('SELECT status, host_account_id FROM games WHERE id = $1 FOR UPDATE')) {
      return state.games.filter(game => game.id === values[0]).map(game => ({ status: game.status, host_account_id: game.host_account_id }));
    }
    if (query.startsWith('SELECT g.*, gp.account_id, gp.seat_index FROM game_players gp JOIN games g ON g.id = gp.game_id WHERE gp.account_id = $1 ORDER BY g.updated_at DESC')) {
      return state.games.filter(game => state.players.some(player => player.game_id === game.id && player.account_id === values[0]))
        .map(game => ({
          ...game,
          account_id: values[0],
          seat_index: state.players.find(player => player.game_id === game.id && player.account_id === values[0])?.seat_index ?? 0,
        }));
    }
    if (query.startsWith('SELECT * FROM games WHERE id = $1 FOR UPDATE')) {
      return state.games.filter(game => game.id === values[0]);
    }
    if (query.startsWith('SELECT id FROM games WHERE id = $1 FOR UPDATE')) {
      return state.games.filter(game => game.id === values[0]).map(game => ({ id: game.id }));
    }
    if (query.startsWith('SELECT * FROM games WHERE id = $1')) {
      return state.games.filter(game => game.id === values[0]);
    }
    if (query.startsWith('SELECT * FROM game_states WHERE id = $1')) {
      return state.states.filter(entry => entry.id === values[0]);
    }
    if (query.startsWith('SELECT id, version, state, board FROM game_states WHERE id = $1 FOR UPDATE')) {
      return state.states.filter(entry => entry.id === values[0]).map(entry => ({
        id: entry.id,
        version: entry.version,
        state: entry.state,
        board: entry.board,
      }));
    }
    if (query.startsWith('SELECT id, version, state, board FROM game_states WHERE id = $1')) {
      return state.states.filter(entry => entry.id === values[0]).map(entry => ({
        id: entry.id,
        version: entry.version,
        state: entry.state,
        board: entry.board,
      }));
    }
    if (query.startsWith('UPDATE game_states SET state = $1::jsonb, version = $2, updated_at = now() WHERE id = $3')) {
      const gameState = state.states.find(entry => entry.id === values[2]);
      if (gameState) {
        gameState.state = typeof values[0] === 'string' ? JSON.parse(values[0]) : values[0];
        gameState.version = Number(values[1]);
      }
      return [{ ok: true }];
    }
    if (query.startsWith('INSERT INTO game_action_requests')) {
      if (!state.actionRequests.some(entry => entry.game_id === values[0] && entry.request_id === values[1])) {
        state.actionRequests.push({ game_id: values[0], request_id: values[1], result_json: JSON.parse(values[2]) });
      }
      return [{ result_json: JSON.parse(values[2]) }];
    }
    if (query.startsWith('SELECT result_json FROM game_action_requests WHERE game_id = $1 AND request_id = $2')) {
      const request = state.actionRequests.find(entry => entry.game_id === values[0] && entry.request_id === values[1]);
      return request ? [{ result_json: request.result_json }] : [];
    }
    if (query.startsWith('SELECT result_json FROM game_action_requests WHERE game_id = $1 ORDER BY created_at DESC LIMIT 1')) {
      const requests = state.actionRequests.filter(entry => entry.game_id === values[0]);
      const latest = requests[requests.length - 1];
      return latest ? [{ result_json: latest.result_json }] : [];
    }

    // --- game_saves ---
    if (query.startsWith('SELECT id FROM game_saves WHERE id = $1 AND owner_id = $2 FOR UPDATE')) {
      return state.saves.filter(save => save.id === values[0] && save.owner_id === values[1]).map(save => ({ id: save.id }));
    }
    if (query.startsWith('UPDATE game_saves SET name = $1, source_game_id = $2, status = $3, version = $4, state = $5::jsonb, board = $6::jsonb, players = $7::jsonb, selected_board_id = $8, updated_at = now() WHERE id = $9 AND owner_id = $10')) {
      const save = state.saves.find(entry => entry.id === values[8] && entry.owner_id === values[9]);
      if (save) {
        Object.assign(save, {
          name: values[0],
          source_game_id: values[1],
          status: values[2],
          version: Number(values[3]),
          state: typeof values[4] === 'string' ? JSON.parse(values[4]) : values[4],
          board: typeof values[5] === 'string' ? JSON.parse(values[5]) : values[5],
          players: typeof values[6] === 'string' ? JSON.parse(values[6]) : values[6],
          selected_board_id: values[7],
          updated_at: new Date().toISOString(),
        });
      }
      return [{ ok: true }];
    }
    if (query.startsWith('INSERT INTO game_saves')) {
      state.saves.push({
        id: values[0],
        owner_id: values[1],
        source_game_id: values[2],
        name: values[3],
        status: values[4],
        version: Number(values[5]),
        state: typeof values[6] === 'string' ? JSON.parse(values[6]) : values[6],
        board: typeof values[7] === 'string' ? JSON.parse(values[7]) : values[7],
        players: typeof values[8] === 'string' ? JSON.parse(values[8]) : values[8],
        selected_board_id: values[9] || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      return [{ ok: true }];
    }
    if (query.startsWith('SELECT id, owner_id, source_game_id, name, status, version, players, selected_board_id, created_at, updated_at FROM game_saves WHERE id = $1')) {
      return state.saves.filter(save => save.id === values[0]);
    }
    if (query.startsWith('SELECT id, owner_id, source_game_id, name, status, version, players, selected_board_id, created_at, updated_at FROM game_saves WHERE owner_id = $1 ORDER BY updated_at DESC')) {
      return state.saves.filter(save => save.owner_id === values[0]).sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    }
    if (query.startsWith('SELECT * FROM game_saves WHERE id = $1 FOR UPDATE')) {
      return state.saves.filter(save => save.id === values[0]);
    }
    if (query.startsWith('SELECT version, state, board FROM game_saves WHERE id = $1 AND owner_id = $2 FOR UPDATE')) {
      return state.saves.filter(save => save.id === values[0] && save.owner_id === values[1]).map(save => ({
        version: save.version,
        state: save.state,
        board: save.board,
      }));
    }
    if (query.startsWith('UPDATE game_saves SET status = $1, updated_at = now() WHERE id = $2')) {
      const save = state.saves.find(entry => entry.id === values[1]);
      if (save) {
        save.status = values[0];
        save.updated_at = new Date().toISOString();
      }
      return [{ ok: true }];
    }

    // --- game_results ---
    if (query.startsWith('INSERT INTO game_results (game_id, winner_account_id, placements) VALUES ($1, $2, $3::jsonb) ON CONFLICT (game_id) DO NOTHING')) {
      if (!state.results.some(entry => entry.game_id === values[0])) {
        state.results.push({
          game_id: values[0],
          winner_account_id: values[1],
          placements: typeof values[2] === 'string' ? JSON.parse(values[2]) : values[2],
          created_at: new Date().toISOString(),
        });
      }
      return [{ ok: true }];
    }
    if (query.startsWith('SELECT game_id, winner_account_id, placements, created_at FROM game_results WHERE game_id = $1')) {
      return state.results.filter(entry => entry.game_id === values[0]);
    }

    // --- accounts ---
    if (query.startsWith('SELECT username, avatar_url FROM accounts WHERE id = $1')) {
      const account = state.accounts[values[0]];
      return account ? [{ username: account.username, avatar_url: account.avatar_url || null }] : [];
    }

    return [];
  }, {
    async begin(callback) {
      return callback(tx);
    },
  });

  return Object.assign(tx, { begin: async callback => callback(tx), state });
}

module.exports = { makeDbState, makeDb };
