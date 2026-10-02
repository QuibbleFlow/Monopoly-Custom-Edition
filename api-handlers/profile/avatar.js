const { del, put } = require('@vercel/blob');
const { database, noStore, parseBody, requireAccount, requireSameOrigin, sendError } = require('../../lib/account');

const MAX_IMAGE_BYTES = 256 * 1024;
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
      await cleanup(previousUrl);
      return res.status(200).json({ avatar_url: null });
    }

    const { image } = parseBody(req);
    const match = typeof image === 'string' && image.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+=*)$/);
    if (!match || !IMAGE_TYPES[match[1]]) return sendError(res, 400, 'Choose a JPEG, PNG, or WebP image.');
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return sendError(res, 413, 'Resize your profile picture to 256 KB or smaller.');
    const validSignature = match[1] === 'image/png'
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : match[1] === 'image/jpeg'
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!validSignature) return sendError(res, 400, 'The file is not a supported image.');
    // Small resized pictures also work on projects without a Blob store.
    let url = `data:${match[1]};base64,${bytes.toString('base64')}`;
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      try {
        const blob = await put(`avatars/${account.id}.${IMAGE_TYPES[match[1]]}`, bytes, {
          access: 'public', addRandomSuffix: true, contentType: match[1],
          token: process.env.BLOB_READ_WRITE_TOKEN,
        });
        url = blob.url;
      } catch (error) { console.warn('Avatar storage unavailable. Saving compact image to account.'); }
    }
    try {
      await database()`UPDATE accounts SET avatar_url = ${url}, updated_at = now() WHERE id = ${account.id}`;
    } catch (error) {
      await cleanup(url);
      throw error;
    }
    if (previousUrl !== url) await cleanup(previousUrl);
    return res.status(200).json({ avatar_url: url });
  } catch (error) {
    console.error('Avatar update failed:', error);
    return sendError(res, 500, 'Could not update your profile picture.');
  }
};
async function cleanup(url) {
  if (!process.env.BLOB_READ_WRITE_TOKEN || !/^https:\/\/[^/]+\.public\.blob\.vercel-storage\.com\//.test(url || '')) return;
  try { await del(url, { token: process.env.BLOB_READ_WRITE_TOKEN }); }
  catch (error) { console.warn('Could not clean up previous avatar.'); }
}
