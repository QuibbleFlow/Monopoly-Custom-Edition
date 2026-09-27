(function (root, factory) {
  const createAuthoritativeGame = factory;
  if (typeof module !== 'undefined' && module.exports) module.exports = createAuthoritativeGame;
  if (root) root.authoritativeGame = createAuthoritativeGame({ root });
})(typeof globalThis !== 'undefined' ? globalThis : this, function createAuthoritativeGame(deps = {}) {
  const root = deps.root || (typeof globalThis !== 'undefined' ? globalThis : {});
  const fetchRequest = deps.fetch || root.fetch?.bind(root);
  const requestTimeout = deps.setTimeout || root.setTimeout?.bind(root) || setTimeout;
  const clearRequestTimeout = deps.clearTimeout || root.clearTimeout?.bind(root) || clearTimeout;
  const stateListeners = new Set();
  const pollInterval = deps.pollInterval || 2500;
  let requestCounter = 0;
  let pollingTimer = null;
  let pollingGameId = null;
  let pollingInFlight = false;
  let generation = 0;

  const manager = {
    gameId: null,
    version: 0,
    status: null,
    state: null,
    lastEvents: [],
    active: false,

    getAuthoritativeState() {
      return {
        gameId: this.gameId,
        version: this.version,
        status: this.status,
        state: this.state,
        events: this.lastEvents,
      };
    },

    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },

    async notify() {
      const snapshot = this.getAuthoritativeState();
      await Promise.all(Array.from(stateListeners, listener => listener(snapshot)));
    },

    async setAuthoritativeState(payload) {
      if (!payload || !payload.gameId) return false;
      if (this.gameId && this.gameId !== payload.gameId) {
        this.stopPolling();
        this.gameId = null;
        this.version = 0;
        this.status = null;
        this.state = null;
        this.lastEvents = [];
      }
      if (!this.gameId) this.gameId = payload.gameId;
      return this.applyAuthoritativeState(payload);
    },

    async applyAuthoritativeState(payload) {
      if (!payload || !payload.gameId || payload.gameId !== this.gameId) return false;
      const nextVersion = Number(payload.version);
      if (!Number.isInteger(nextVersion) || nextVersion <= this.version) return false;
      this.version = nextVersion;
      this.status = payload.status || this.status;
      this.state = payload.state || null;
      this.lastEvents = Array.isArray(payload.events) ? payload.events : [];
      await this.notify();
      return true;
    },

    preserveAuthoritativeTurnState(peerState) {
      if (!peerState || !this.state || this.status !== 'ACTIVE') return peerState;
        for (const key of [
          'current', 'turn', 'phase', 'dice', 'doubles', 'rolledDouble', 'pendingMove', 'landingPending',
          'debt', 'over', 'winnerId', 'owners', 'houses', 'mortgaged',
        ]) {
        if (Object.prototype.hasOwnProperty.call(this.state, key)) {
          peerState[key] = JSON.parse(JSON.stringify(this.state[key]));
        }
      }
        const authoritativePlayers = new Map((this.state.players || []).map(player => [player.id, player]));
        for (const peerPlayer of peerState.players || []) {
          const authoritativePlayer = authoritativePlayers.get(peerPlayer.id);
          if (!authoritativePlayer) continue;
          for (const key of ['pos', 'money', 'inJail', 'jailTurns', 'bankrupt']) {
            if (Object.prototype.hasOwnProperty.call(authoritativePlayer, key)) {
              peerPlayer[key] = authoritativePlayer[key];
            }
          }
        }
      return peerState;
    },

    clearAuthoritativeState() {
      this.stopPolling();
      this.gameId = null;
      this.version = 0;
      this.status = null;
      this.state = null;
      this.lastEvents = [];
      return this.notify();
    },

    createRequestId() {
      const crypto = deps.crypto || root.crypto;
      if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
      requestCounter += 1;
      return `game-action-${Date.now()}-${requestCounter}`;
    },

    async fetchLatest(gameId = this.gameId, options = {}) {
      if (!gameId || !fetchRequest) return null;
      const requestGeneration = options.generation == null ? generation : options.generation;
      const response = await fetchRequest(`/api/game/state?gameId=${encodeURIComponent(gameId)}`, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw makeError(result, response.status, 'Could not load the authoritative game state.');
      if (requestGeneration !== generation || (this.gameId && gameId !== this.gameId)) return null;
      await this.setAuthoritativeState(result);
      return result;
    },

    startPolling(gameId = this.gameId) {
      if (!gameId) return false;
      if (this.active && pollingGameId === gameId) return true;
      this.stopPolling();
      this.gameId = gameId;
      this.active = true;
      pollingGameId = gameId;
      const pollGeneration = generation;
      const schedule = delay => {
        if (!this.active || pollingGameId !== gameId || pollGeneration !== generation || pollingTimer) return;
        if (root.document && root.document.visibilityState === 'hidden') return;
        pollingTimer = requestTimeout(tick, delay);
      };
      const tick = async () => {
        pollingTimer = null;
        if (!this.active || pollingGameId !== gameId || pollGeneration !== generation) return;
        if (pollingInFlight) {
          schedule(pollInterval);
          return;
        }
        pollingInFlight = true;
        try {
          await this.fetchLatest(gameId, { generation: pollGeneration });
        } catch (error) {
          if (deps.onPollError) deps.onPollError(error);
          else if (root.console) root.console.warn('Authoritative sync poll failed:', error);
        } finally {
          pollingInFlight = false;
          schedule(pollInterval);
        }
      };
      this.pollNow = () => schedule(0);
      this.visibilityHandler = () => {
        if (!this.active || pollingGameId !== gameId) return;
        if (root.document?.visibilityState === 'hidden') {
          if (pollingTimer) clearRequestTimeout(pollingTimer);
          pollingTimer = null;
        } else {
          schedule(0);
        }
      };
      if (root.document) root.document.addEventListener('visibilitychange', this.visibilityHandler);
      schedule(0);
      return true;
    },

    stopPolling() {
      this.active = false;
      generation += 1;
      if (pollingTimer) clearRequestTimeout(pollingTimer);
      pollingTimer = null;
      if (this.visibilityHandler && root.document) root.document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
      this.pollNow = null;
      pollingGameId = null;
    },

    async submitGameAction({ gameId = this.gameId, expectedVersion = this.version, action, requestId = this.createRequestId() } = {}) {
      if (!gameId) throw makeError({ error: { code: 'NO_ACTIVE_GAME', message: 'No authoritative game is active.' } }, 0);
      if (!requestId) requestId = this.createRequestId();
      const requestGeneration = generation;
      let response;
      try {
        response = await fetchRequest('/api/game/action', {
          credentials: 'same-origin',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ gameId, requestId, version: Number(expectedVersion), action }),
        });
      } catch (error) {
        const networkError = makeError({ error: { code: 'NETWORK_ERROR', message: 'The server could not be reached. Retry this action to safely check whether it was accepted.' } }, 0);
        networkError.requestId = requestId;
        networkError.expectedVersion = Number(expectedVersion);
        throw networkError;
      }
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = makeError(result, response.status, 'The action could not be submitted.');
        error.requestId = requestId;
        error.expectedVersion = Number(expectedVersion);
        if (error.code === 'STALE_VERSION' || error.code === 'NOT_YOUR_TURN') {
          try { await this.fetchLatest(gameId, { generation: requestGeneration }); } catch (syncError) { error.syncError = syncError; }
        }
        throw error;
      }
      if (requestGeneration === generation && gameId === this.gameId) {
        await this.applyAuthoritativeState({
          gameId: result.gameId,
          version: result.version,
          status: result.status || 'ACTIVE',
          state: result.state,
          events: result.events || [],
        });
      }
      return { ...result, requestId };
    },

    submitAction(action, options = {}) {
      return this.submitGameAction({
        gameId: options.gameId || this.gameId,
        expectedVersion: options.expectedVersion == null ? this.version : options.expectedVersion,
        action,
        requestId: options.requestId,
      });
    },
  };

  if (root.addEventListener) root.addEventListener('beforeunload', () => manager.stopPolling());
  return manager;
});

function makeError(result, status = 0, fallback = 'The request failed.') {
  const detail = result && result.error;
  const error = new Error((detail && detail.message) || (typeof detail === 'string' ? detail : '') || fallback);
  error.code = (detail && detail.code) || 'REQUEST_FAILED';
  error.status = status;
  return error;
}
