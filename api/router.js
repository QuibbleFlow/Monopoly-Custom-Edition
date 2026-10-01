const routes = {
  auth: {
    session: require('../api-handlers/auth/session.js'),
    signin: require('../api-handlers/auth/signin.js'),
    signout: require('../api-handlers/auth/signout.js'),
    signup: require('../api-handlers/auth/signup.js'),
  },
  boards: {
    index: require('../api-handlers/boards/index.js'),
    item: require('../api-handlers/boards/[id].js'),
    share: require('../api-handlers/boards/[id]/share.js'),
  },
  friends: {
    index: require('../api-handlers/friends/index.js'),
    search: require('../api-handlers/friends/search.js'),
    requests: require('../api-handlers/friends/requests.js'),
    request: require('../api-handlers/friends/requests/[id].js'),
    item: require('../api-handlers/friends/[id].js'),
  },
  game: {
    action: require('../api-handlers/game/action.js'),
    create: require('../api-handlers/game/create.js'),
    join: require('../api-handlers/game/join.js'),
    leave: require('../api-handlers/game/leave.js'),
    load: require('../api-handlers/game/load.js'),
    lobby: require('../api-handlers/game/lobby.js'),
    myGames: require('../api-handlers/game/my-games.js'),
    results: require('../api-handlers/game/results.js'),
    resume: require('../api-handlers/game/resume.js'),
    saves: require('../api-handlers/game/saves.js'),
    start: require('../api-handlers/game/start.js'),
    state: require('../api-handlers/game/state.js'),
  },
  profile: {
    index: require('../api-handlers/profile/index.js'),
    avatar: require('../api-handlers/profile/avatar.js'),
    password: require('../api-handlers/profile/password.js'),
  },
  settings: {
    index: require('../api-handlers/settings/index.js'),
  },
};

function getPathParts(req) {
  const value = req.query?.path;
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string') return value.split('/').filter(Boolean);

  const pathname = String(req.url || '').split('?')[0];
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] === 'api') parts.shift();
  return parts;
}

function withQuery(req, values) {
  const nextReq = Object.create(req);
  nextReq.query = {
    ...(req.query || {}),
    ...values,
  };
  return nextReq;
}

function notFound(res) {
  return res.status(404).json({ error: 'API route not found.' });
}

module.exports = async function apiRouter(req, res) {
  try {
    const parts = getPathParts(req);
    if (!parts.length) return notFound(res);

    const [section, action, idOrAction] = parts;

    if (section === 'auth') {
      const handler = routes.auth[action];
      if (!handler || parts.length !== 2) return notFound(res);
      return handler(req, res);
    }

    if (section === 'boards') {
      if (parts.length === 1) return routes.boards.index(req, res);
      if (parts.length === 2) {
        return routes.boards.item(withQuery(req, { id: action }), res);
      }
      if (parts.length === 3 && idOrAction === 'share') {
        return routes.boards.share(withQuery(req, { id: action }), res);
      }
      return notFound(res);
    }

    if (section === 'friends') {
      if (parts.length === 1) return routes.friends.index(req, res);
      if (parts.length === 2 && action === 'search') return routes.friends.search(req, res);
      if (parts.length === 2 && action === 'requests') return routes.friends.requests(req, res);
      if (parts.length === 3 && action === 'requests') {
        return routes.friends.request(withQuery(req, { id: idOrAction }), res);
      }
      if (parts.length === 2) {
        return routes.friends.item(withQuery(req, { id: action }), res);
      }
      return notFound(res);
    }

    if (section === 'game') {
      const handler = action === 'my-games' ? routes.game.myGames : routes.game[action];
      if (!handler || parts.length !== 2) return notFound(res);
      return handler(req, res);
    }

    if (section === 'profile') {
      const handler = routes.profile[action];
      if (!handler || parts.length !== 2) return notFound(res);
      return handler(req, res);
    }

    if (section === 'settings') {
      if (parts.length !== 1) return notFound(res);
      return routes.settings.index(req, res);
    }

    return notFound(res);
  } catch (error) {
    console.error('API route failed:', {
      method: req?.method,
      url: req?.url,
      error: error && error.stack ? error.stack : error,
    });
    return res.status(500).json({
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The server encountered an unexpected error while processing this request.',
      },
    });
  }
};