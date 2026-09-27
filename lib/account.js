const { createHmac, randomBytes } = require('node:crypto');
const { neon } = require('@neondatabase/serverless');

const SESSION_COOKIE = 'monopoly_session';
const SESSION_DAYS = 30;
const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,24}$/;
let sqlClient;

function database() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured.');
  if (!sqlClient) sqlClient = neon(process.env.DATABASE_URL);
  return sqlClient;
}

function sessionHash(token) {
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 characters.');
  }
  return createHmac('sha256', process.env.SESSION_SECRET).update(token).digest('hex');
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
  const cookie = (req.headers.cookie || '').split(';').map(part => part.trim())
    .find(part => part.startsWith(`${SESSION_COOKIE}=`));
  return cookie ? decodeURIComponent(cookie.slice(SESSION_COOKIE.length + 1)) : '';
}

function setSessionCookie(res, token, maxAge = SESSION_DAYS * 24 * 60 * 60) {
  const secure = process.env.VERCEL || process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}

async function createSession(res, accountId) {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = sessionHash(token);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  const sql = database();
  await sql`DELETE FROM account_sessions WHERE expires_at <= now()`;
  await sql`INSERT INTO account_sessions (token_hash, account_id, expires_at)
    VALUES (${tokenHash}, ${accountId}, ${expiresAt})`;
  setSessionCookie(res, token);
}

async function currentAccount(req) {
  const token = cookieValue(req);
  if (!token) return null;
  const tokenHash = sessionHash(token);
  const sql = database();
  await sql`UPDATE account_sessions SET last_seen_at = now()
    WHERE token_hash = ${tokenHash} AND expires_at > now()`;
  const rows = await sql`SELECT a.id, a.username, a.avatar_url, a.settings
    FROM account_sessions s JOIN accounts a ON a.id = s.account_id
    WHERE s.token_hash = ${tokenHash} AND s.expires_at > now()`;
  return rows[0] || null;
}

async function revokeSession(req) {
  const token = cookieValue(req);
  if (token) await database()`DELETE FROM account_sessions WHERE token_hash = ${sessionHash(token)}`;
}

async function requireAccount(req, res) {
  const account = await currentAccount(req);
  if (!account) sendError(res, 401, 'Sign in to continue.');
  return account;
}

module.exports = {
  SESSION_COOKIE,
  USERNAME_PATTERN,
  createSession,
  currentAccount,
  database,
  noStore,
  parseBody,
  requireAccount,
  requireMethod,
  requireSameOrigin,
  revokeSession,
  sendError,
  setSessionCookie,
};