(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ServerLobbyUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createServerLobbyController(dependencies) {
    let inFlight = false;
    let error = '';

    function showError(message, screen) {
      error = message;
      dependencies.setScreen(screen);
      dependencies.render();
    }

    async function submit(path, body, pendingScreen) {
      if (inFlight) return false;
      if (!dependencies.isSignedIn()) {
        showError('Sign in to continue.', pendingScreen);
        return false;
      }

      inFlight = true;
      error = '';
      dependencies.setScreen(pendingScreen);
      dependencies.render();

      try {
        const result = await dependencies.request(path, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        if (!result || typeof result.gameId !== 'string' || !result.gameId.trim()) {
          throw new Error('The server response did not include a game ID.');
        }

        const gameId = result.gameId.trim();
        dependencies.setLobby({
          gameId,
          game: result.game || null,
          players: Array.isArray(result.players) ? result.players : [],
          canStart: !!result.canStart,
        });
        dependencies.setScreen('serverLobby');
        dependencies.startPolling(gameId);
        dependencies.render();
        await dependencies.refreshMyGames();
        return true;
      } catch (requestError) {
        error = requestError && requestError.message ? requestError.message : 'The server lobby request failed.';
        dependencies.setScreen(pendingScreen);
        return false;
      } finally {
        inFlight = false;
        dependencies.render();
      }
    }

    return {
      openJoin() {
        error = '';
        dependencies.setScreen('serverJoin');
        dependencies.render();
      },
      create(selectedBoardId) {
        return submit('/api/game/create', { selectedBoardId: selectedBoardId || null }, 'serverLobby');
      },
      join(gameId) {
        const normalizedGameId = typeof gameId === 'string' ? gameId.trim() : '';
        if (!normalizedGameId) {
          showError('Enter a server game ID to join.', 'serverJoin');
          return Promise.resolve(false);
        }
        return submit('/api/game/join', { gameId: normalizedGameId }, 'serverJoin');
      },
      get inFlight() {
        return inFlight;
      },
      get error() {
        return error;
      },
    };
  }

  return { createServerLobbyController };
});
