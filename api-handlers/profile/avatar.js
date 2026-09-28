const { del, put } = require('@vercel/blob');
const { database, noStore, parseBody, requireAccount, requireMethod, requireSameOrigin, sendError } = require('../../lib/account');

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

module.exports = async function avatar(req, res) {
  noStore(res);
  if (!['POST', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', 'POST, DELETE');
    return sendError(res, 405, 'Method not allowed.');
  }
  if (!requireSameOrigin(req, res)) return;
  try {
    const account = await requireAccount(req, res);
    if (!account) return;
    const rows = await database()`SELECT avatar_url FROM accounts WHERE id = ${account.id}`;
    const previousUrl = rows[0]?.avatar_url;
    if (req.method === 'DELETE') {
      await database()`UPDATE accounts SET avatar_url = NULL, updated_at = now() WHERE id = ${account.id}`;
      if (previousUrl) await del(previousUrl, { token: process.env.BLOB_READ_WRITE_TOKEN });
      return res.status(200).json({ avatar_url: null });
    }

    const { image } = parseBody(req);
    const match = typeof image === 'string' && image.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+=*)$/);
    if (!match || !IMAGE_TYPES[match[1]]) return sendError(res, 400, 'Choose a JPEG, PNG, or WebP image.');
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return sendError(res, 413, 'Profile pictures must be 2 MB or smaller.');
    if (!process.env.BLOB_READ_WRITE_TOKEN) return sendError(res, 503, 'Profile picture storage is not configured.');

    const blob = await put(`avatars/${account.id}.${IMAGE_TYPES[match[1]]}`, bytes, {
      access: 'public',
      addRandomSuffix: true,
      contentType: match[1],
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    try {
      await database()`UPDATE accounts SET avatar_url = ${blob.url}, updated_at = now() WHERE id = ${account.id}`;
    } catch (error) {
      await del(blob.url, { token: process.env.BLOB_READ_WRITE_TOKEN });
      throw error;
    }
    if (previousUrl) await del(previousUrl, { token: process.env.BLOB_READ_WRITE_TOKEN });
    return res.status(200).json({ avatar_url: blob.url });
  } catch (error) {
    console.error('Avatar update failed:', error);
    return sendError(res, 500, 'Could not update your profile picture.');
  }
};