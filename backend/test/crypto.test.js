const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCrypto } = require('../lib/crypto');

const c = createCrypto({ encryptKey: 'test-encrypt-key-material', jwtSecret: 'test-jwt-secret' });

test('encrypt/decrypt round-trips a value', () => {
  const plain = '1234567890';
  const enc = c.encrypt(plain);
  assert.ok(enc.startsWith('enc:'), 'ciphertext should carry the enc: prefix');
  assert.notEqual(enc, plain, 'ciphertext must not equal the plaintext');
  assert.equal(c.decrypt(enc), plain);
});

test('encrypt is non-deterministic (random IV) but always decrypts correctly', () => {
  const a = c.encrypt('same-value');
  const b = c.encrypt('same-value');
  assert.notEqual(a, b, 'two encryptions of the same plaintext should differ (random IV)');
  assert.equal(c.decrypt(a), 'same-value');
  assert.equal(c.decrypt(b), 'same-value');
});

test('decrypt passes through a value with no enc: prefix unchanged', () => {
  assert.equal(c.decrypt('plain-upi-id@bank'), 'plain-upi-id@bank');
  assert.equal(c.decrypt(''), '');
  assert.equal(c.decrypt(null), null);
});

test('decrypt fails closed (returns original text) on corrupted ciphertext', () => {
  const enc = c.encrypt('sensitive-bank-number');
  const corrupted = enc.slice(0, -4) + 'XXXX';
  assert.equal(c.decrypt(corrupted), corrupted, 'corrupted ciphertext should not throw or leak garbage');
});

test('hashPassword/verifyPassword: correct password verifies, wrong password does not', () => {
  const hash = c.hashPassword('correct horse battery staple');
  assert.equal(c.verifyPassword('correct horse battery staple', hash), true);
  assert.equal(c.verifyPassword('wrong password', hash), false);
});

test('hashPassword produces a different hash each time (random salt)', () => {
  const h1 = c.hashPassword('same-password');
  const h2 = c.hashPassword('same-password');
  assert.notEqual(h1, h2);
  assert.equal(c.verifyPassword('same-password', h1), true);
  assert.equal(c.verifyPassword('same-password', h2), true);
});

test('verifyPassword rejects malformed stored hashes instead of throwing', () => {
  assert.equal(c.verifyPassword('anything', null), false);
  assert.equal(c.verifyPassword('anything', ''), false);
  assert.equal(c.verifyPassword('anything', 'no-colon-in-here'), false);
});

test('safeEq: equal strings true, unequal strings/lengths false', () => {
  assert.equal(c.safeEq('abc', 'abc'), true);
  assert.equal(c.safeEq('abc', 'abd'), false);
  assert.equal(c.safeEq('abc', 'abcd'), false);
  assert.equal(c.safeEq('', ''), true);
});

test('signToken/verifyToken: valid token round-trips its payload', () => {
  const token = c.signToken({ uid: 'user_123', role: 'customer' });
  const payload = c.verifyToken(token);
  assert.equal(payload.uid, 'user_123');
  assert.equal(payload.role, 'customer');
  assert.ok(payload.exp > Date.now(), 'token should not be expired immediately after signing');
});

test('verifyToken rejects a tampered token', () => {
  const token = c.signToken({ uid: 'user_123' });
  assert.equal(c.verifyToken(token + 'x'), null);
  assert.equal(c.verifyToken('not.a.token'), null);
  assert.equal(c.verifyToken(''), null);
});

test('verifyToken rejects a token signed with a different secret', () => {
  const otherCrypto = createCrypto({ encryptKey: 'other-key', jwtSecret: 'a-different-jwt-secret' });
  const token = otherCrypto.signToken({ uid: 'user_123' });
  assert.equal(c.verifyToken(token), null);
});

test('verifyToken rejects an expired token', () => {
  // Forge a token whose exp is already in the past, using the same signing
  // path signToken uses internally, so only exp differs.
  const header = c.b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = c.b64url(JSON.stringify({ uid: 'user_123', iat: Date.now() - 1000, exp: Date.now() - 500 }));
  const crypto = require('crypto');
  const sig = crypto.createHmac('sha256', 'test-jwt-secret').update(`${header}.${body}`).digest('base64url');
  const expiredToken = `${header}.${body}.${sig}`;
  assert.equal(c.verifyToken(expiredToken), null);
});

test('uid produces distinct, prefixed identifiers', () => {
  const a = c.uid('c_');
  const b = c.uid('c_');
  assert.ok(a.startsWith('c_'));
  assert.ok(b.startsWith('c_'));
  assert.notEqual(a, b);
});
