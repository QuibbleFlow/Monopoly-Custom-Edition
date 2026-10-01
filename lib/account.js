const { createHmac, randomBytes } = require('node:crypto');
const { Pool } = require('@neondatabase/serverless');

const SESSION_COOKIE = 'monopoly_session';
const SESSION_DAYS = 30;
const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,24}$/;

let pool;
let sqlClient;

function createQuery(client) {
  const query = async (strings, ...values) => {
    let text = '';

    for (let i = 0; i < strings.length; i++) {
      text += strings[i];

      if (i < values.length) {
        text += `$${i + 1}`;
      }
    }

    const result = await client.query({
      text,
      values,
    });

    return result.rows;
  };

  return query;
}

function getDatabaseConnectionString() {
  return (
    process.env.DATABASE_URL ||
    process.env.NEON_DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    ''
  ).trim();
}

function database() {
  const connectionString = getDatabaseConnectionString();
  if (!connectionString) {
    throw new Error('DATABASE_URL is not configured. Set the Neon connection string in Vercel environment variables.');
  }

  if (!pool) {
    pool = new Pool({
      connectionString,
    });
  }

  if (!sqlClient) {
    sqlClient = createQuery(pool);

    sqlClient.begin = async callback => {
      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        const tx = createQuery(client);
        const result = await callback(tx);

        await client.query('COMMIT');

        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          console.error('Transaction rollback failed:', rollbackError);
        }

        throw error;
      } finally {
        client.release();
      }
    };
  }

  return sqlClient;
}

function resolveSessionSecret() {
  return (
    process.env.SESSION_SECRET ||
    process.env.AUTH_SECRET ||
    process.env.JWT_SECRET ||
    ''
  );
}

const REQUIRED_RUNTIME_COLUMNS = {
  accounts: ['id', 'username', 'avatar_url', 'settings'],
  account_sessions: ['token_hash', 'account_id', 'expires_at', 'last_seen_at'],
  games: [
    'id', 'host_account_id', 'name', 'status', 'invite_only', 'selected_board_id',
    'resume_save_id', 'created_at', 'started_at', 'paused_at', 'finished_at', 'updated_at',
  ],
  game_players: ['game_id', 'account_id', 'seat_index', 'joined_at', 'returned_at', 'results_seen_at'],
  game_states: ['id', 'owner_id', 'state', 'board', 'version', 'updated_at'],
  game_invitations: ['id', 'game_id', 'inviter_account_id', 'invitee_account_id', 'status'],
  custom_boards: ['id', 'owner_id', 'property_names'],
};

const SCHEMA_VALIDATION_TTL_MS = 60 * 1000;
let schemaValidatedUntil = 0;
let schemaValidationPromise = null;

async function ensureDatabaseRuntimeState(sql) {
  if (!sql || typeof sql !== 'function') return true;
  if (Date.now() < schemaValidatedUntil) return true;
  if (schemaValidationPromise) return schemaValidationPromise;

  schemaValidationPromise = (async () => {
    try {
      const rows = await sql`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ANY(${Object.keys(REQUIRED_RUNTIME_COLUMNS)})
      `;

      const present = new Map();
      for (const row of rows) {
        if (!present.has(row.table_name)) present.set(row.table_name, new Set());
        present.get(row.table_name).add(row.column_name);
      }
      const missing = [];
      for (const [tableName, columns] of Object.entries(REQUIRED_RUNTIME_COLUMNS)) {
        const found = present.get(tableName);
        if (!found) missing.push(`table ${tableName}`);
        else {
          for (const columnName of columns) {
            if (!found.has(columnName)) missing.push(`${tableName}.${columnName}`);
          }
        }
      }

      if (missing.length) {
        throw new Error(
          `Database schema is incomplete. Missing required objects: ${missing.join(', ')}. Apply the current db/migrations set before using server multiplayer.`
        );
      }

      schemaValidatedUntil = Date.now() + SCHEMA_VALIDATION_TTL_MS;
      return true;
    } catch (error) {
      if (error && typeof error.message === 'string' && error.message.includes('Database schema is incomplete')) {
        throw error;
      }

      if (error && (error.code === '42P01' || error.message?.includes('information_schema') || error.message?.includes('current_schema'))) {
        throw new Error(
          'Database connection succeeded, but the required schema is missing or incomplete. Apply the current db/migrations set.'
        );
      }

      throw error;
    } finally {
      schemaValidationPromise = null;
    }
  })();

  return schemaValidationPromise;
}

function sessionHash(token) {
  const secret = resolveSessionSecret();
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 characters. Set it in Vercel environment variables.');
  }

  return createHmac('sha256', secret)
    .update(token)
    .digest('hex');
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  return {};
}

function sendError(res, status, message) {
  return res.status(status).json({ error: message });
}

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Cookie');
}

function requireMethod(req, res, method) {
  if (req.method === method) return true;

  res.setHeader('Allow', method);
  sendError(res, 405, 'Method not allowed.');
  return false;
}

function requireSameOrigin(req, res) {
  const origin = req.headers.origin;

  if (!origin) return true;

  const forwardedHost = req.headers['x-forwarded-host'];
  const host = forwardedHost || req.headers.host;

  if (!host || new URL(origin).host !== host) {
    sendError(res, 403, 'Cross-origin request rejected.');
    return false;
  }

  return true;
}

function cookieValue(req) {
  const cookie = (req.headers.cookie || '')
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith(`${SESSION_COOKIE}=`));

  return cookie
    ? decodeURIComponent(cookie.slice(SESSION_COOKIE.length + 1))
    : '';
}

function setSessionCookie(
  res,
  token,
  maxAge = SESSION_DAYS * 24 * 60 * 60
) {
  const secure =
    process.env.VERCEL || process.env.NODE_ENV === 'production'
      ? '; Secure'
      : '';

  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
  );
}

async function createSession(res, accountId) {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = sessionHash(token);

  const expiresAt = new Date(
    Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000
  );

  const sql = database();

  await sql`DELETE FROM account_sessions WHERE expires_at <= now()`;

  await sql`
    INSERT INTO account_sessions (token_hash, account_id, expires_at)
    VALUES (${tokenHash}, ${accountId}, ${expiresAt})
  `;

  setSessionCookie(res, token);
}

const SESSION_TOUCH_INTERVAL_MS = 30 * 1000;
const sessionTouchCache = new Map();

async function currentAccount(req) {
  const token = cookieValue(req);

  if (!token) return null;

  if (!getDatabaseConnectionString() || !resolveSessionSecret()) {
    return null;
  }

  const tokenHash = sessionHash(token);
  const sql = database();

  await ensureDatabaseRuntimeState(sql);

  const now = Date.now();
  const lastTouch = sessionTouchCache.get(tokenHash) || 0;
  if (now - lastTouch >= SESSION_TOUCH_INTERVAL_MS) {
    sessionTouchCache.set(tokenHash, now);
    if (sessionTouchCache.size > 1000) {
      const oldest = sessionTouchCache.keys().next().value;
      if (oldest) sessionTouchCache.delete(oldest);
    }
    try {
      await sql`
        UPDATE account_sessions
        SET last_seen_at = now()
        WHERE token_hash = ${tokenHash}
          AND expires_at > now()
      `;
    } catch (error) {
      sessionTouchCache.delete(tokenHash);
      throw error;
    }
  }

  const rows = await sql`
    SELECT a.id, a.username, a.avatar_url, a.settings
    FROM account_sessions s
    JOIN accounts a ON a.id = s.account_id
    WHERE s.token_hash = ${tokenHash}
      AND s.expires_at > now()
  `;

  return rows[0] || null;
}

async function revokeSession(req) {
  const token = cookieValue(req);

  if (token) {
    await database()`
      DELETE FROM account_sessions
      WHERE token_hash = ${sessionHash(token)}
    `;
  }
}

async function requireAccount(req, res) {
  if (!getDatabaseConnectionString()) {
    sendError(res, 503, 'Authentication is not configured. Set DATABASE_URL in Vercel environment variables.');
    return null;
  }

  if (!resolveSessionSecret()) {
    sendError(res, 503, 'Authentication is not configured. Set SESSION_SECRET in Vercel environment variables.');
    return null;
  }

  const account = await currentAccount(req);

  if (!account) {
    sendError(res, 401, 'Sign in to continue.');
  }

  return account;
}

module.exports = {
  SESSION_COOKIE,
  USERNAME_PATTERN,
  createSession,
  currentAccount,
  database,
  ensureDatabaseRuntimeState,
  noStore,
  parseBody,
  requireAccount,
  requireMethod,
  requireSameOrigin,
  revokeSession,
  sendError,
  setSessionCookie,
};