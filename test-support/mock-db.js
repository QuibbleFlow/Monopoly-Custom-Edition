function makeDbState() {
  return {
    games: [],
    players: [],
    states: [],
    saves: [],
    results: [],
    actionRequests: [],
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
    if (query.startsWith('SELECT account_id, seat_index, returned_at FROM game_players WHERE game_id = $1 ORDER BY seat_index ASC')) {
      return state.players.filter(player => player.game_id === values[0]).sort((a, b) => a.seat_index - b.seat_index).map(player => ({
        account_id: player.account_id,
        seat_index: player.seat_index,
        returned_at: player.returned_at || null,
      }));
    }
    if (query.startsWith('INSERT INTO games')) {
      state.games.push({
        id: values[0],
        host_account_id: values[1],
        status: values[2],
        selected_board_id: values[3],
        resume_save_id: values[4] || null,
        created_at: new Date().toISOString(),
        started_at: null,
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
    if (query.startsWith('DELETE FROM games WHERE id = $1')) {
      state.games = state.games.filter(game => game.id !== values[0]);
      return [];
    }
    if (query.startsWith('DELETE FROM game_states WHERE id = $1')) {
      state.states = state.states.filter(entry => entry.id !== values[0]);
      return [];
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
    if (query.startsWith('UPDATE games SET status = $1, updated_at = now() WHERE id = $2 AND status <> $3')) {
      const game = state.games.find(entry => entry.id === values[1] && entry.status !== values[2]);
      if (game) {
        game.status = values[0];
        game.updated_at = new Date().toISOString();
      }
      return [{ ok: true }];
    }
    if (query.startsWith('SELECT host_account_id FROM games WHERE id = $1')) {
      return state.games.filter(game => game.id === values[0]).map(game => ({ host_account_id: game.host_account_id }));
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
