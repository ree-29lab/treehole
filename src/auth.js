/**
 * Identity without accounts.
 *
 * - `tk`  gate cookie: proves the visitor knows the shared passphrase.
 * - `dev` device cookie: a random id, signed. It is the only handle for "my posts"
 *   and for deleting your own writing. It carries no personal data and dies with
 *   the browser profile.
 * - `adm` admin cookie: proves the visitor knows the admin passphrase.
 *
 * Every token is HMAC-signed with the deployment secret, so changing a passphrase
 * in `data/secret.json` invalidates all existing cookies.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { normalizePhrase } from './filter.js';

function sign(secret, message) {
  return createHmac('sha256', secret).update(message).digest('hex');
}

/** Constant-time string comparison. */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Compare a typed passphrase with the configured one, forgiving the differences a
 * phone keyboard introduces: full-width punctuation, smart quotes/dashes, stray
 * spaces, and hyphens left out entirely.
 */
export function phraseMatches(input, expected) {
  const typed = normalizePhrase(input);
  const want = normalizePhrase(expected);
  if (!typed || !want) return false;
  if (safeEqual(typed, want)) return true;
  return safeEqual(typed.replace(/-/g, ''), want.replace(/-/g, ''));
}

export function gateToken(credentials) {
  return sign(credentials.secret, `gate:${credentials.passphrase}`);
}

export function adminToken(credentials) {
  return sign(credentials.secret, `admin:${credentials.adminPassphrase}`);
}

export function newDeviceId() {
  return randomBytes(12).toString('hex');
}

export function deviceToken(secret, id) {
  return `${id}.${sign(secret, `dev:${id}`)}`;
}

/** @returns {string|null} the device id when the signature checks out */
export function readDeviceId(secret, cookieValue) {
  if (!cookieValue) return null;
  const dot = cookieValue.lastIndexOf('.');
  if (dot <= 0) return null;
  const id = cookieValue.slice(0, dot);
  const signature = cookieValue.slice(dot + 1);
  if (!safeEqual(signature, sign(secret, `dev:${id}`))) return null;
  return id;
}

/** Non-reversible handle stored in the database instead of the raw id or IP. */
export function opaqueId(secret, kind, value) {
  return sign(secret, `${kind}:${value}`).slice(0, 16);
}

/**
 * Display name for an anonymous author inside one thread: stable for a given device
 * and post, different in every other thread, and never derived from user input.
 */
export function displayCode(words, deviceHash, postId) {
  const digest = sign(deviceHash, `code:${postId}`);
  const a = parseInt(digest.slice(0, 8), 16);
  const b = parseInt(digest.slice(8, 16), 16);
  const c = parseInt(digest.slice(16, 20), 16);
  return `${words.prefix[a % words.prefix.length]}${words.suffix[b % words.suffix.length]}·${String(c % 100).padStart(2, '0')}`;
}

/**
 * 无痕帖的凭据。
 *
 * 发无痕帖时服务端生成一个随机 token，只把它的 HMAC 存进数据库（伪装成 device_hash，
 * 前缀是 `anon:`，和真实设备哈希区分开），token 原文只交给发帖人自己的浏览器。
 * 于是：数据库里查不出这条属于哪台设备；而拿着 token 的那个浏览器仍然能删掉它。
 */
export function newAnonToken() {
  return randomBytes(16).toString('hex');
}

export function anonHash(secret, token) {
  return `anon:${sign(secret, `anon:${token}`).slice(0, 16)}`;
}

export function isAnonHash(value) {
  return typeof value === 'string' && value.startsWith('anon:');
}
