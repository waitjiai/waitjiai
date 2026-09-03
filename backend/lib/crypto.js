// Auth/crypto primitives — extracted from server.js so they're testable in
// isolation (see test/crypto.test.js) without booting the full HTTP server
// or requiring a database. Behavior is unchanged from the inline versions
// that used to live directly in server.js; server.js now calls
// createCrypto({ encryptKey, jwtSecret }) once at boot and destructures the
// same function names it used before, so every call site elsewhere in
// server.js is untouched.
const crypto = require('crypto');

function createCrypto({ encryptKey, jwtSecret }) {
  const encKey = typeof encryptKey === 'string'
    ? crypto.scryptSync(encryptKey, 'waitji-salt-v1', 32)
    : encryptKey;

  function encrypt(text) {
    if (!text) return text;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
    const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return 'enc:' + Buffer.concat([iv, tag, enc]).toString('base64');
  }

  function decrypt(text) {
    if (!text || !String(text).startsWith('enc:')) return text;
    try {
      const buf = Buffer.from(text.slice(4), 'base64');
      const iv = buf.slice(0, 12);
      const tag = buf.slice(12, 28);
      const enc = buf.slice(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
    } catch { return text; }
  }

  function hashPassword(pw) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
    return `${salt}:${hash}`;
  }

  function verifyPassword(pw, stored) {
    if (!stored || !stored.includes(':')) return false;
    const [salt, hash] = stored.split(':');
    const test = crypto.scryptSync(pw, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(test));
  }

  // Constant-time string comparison, used for JWT signature verification and
  // Razorpay webhook signature verification — plain `!==` short-circuits on
  // the first differing byte, a timing side-channel.
  function safeEq(a, b) {
    const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  }

  function b64url(s) { return Buffer.from(s).toString('base64url'); }

  // Minimal JWT (HS256)
  function signToken(payload) {
    const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = b64url(JSON.stringify({ ...payload, iat: Date.now(), exp: Date.now() + 7 * 864e5 }));
    const sig = crypto.createHmac('sha256', jwtSecret).update(`${header}.${body}`).digest('base64url');
    return `${header}.${body}.${sig}`;
  }

  function verifyToken(token) {
    try {
      const [header, body, sig] = token.split('.');
      const expected = crypto.createHmac('sha256', jwtSecret).update(`${header}.${body}`).digest('base64url');
      if (!safeEq(sig, expected)) return null;
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
      if (payload.exp < Date.now()) return null;
      return payload;
    } catch { return null; }
  }

  function uid(prefix = '') { return prefix + crypto.randomBytes(8).toString('hex'); }

  return { encrypt, decrypt, hashPassword, verifyPassword, safeEq, signToken, verifyToken, b64url, uid };
}

module.exports = { createCrypto };
