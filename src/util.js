/**
 * Low-level helpers: HTML escaping, tagged-template rendering, cookies, time, client IP.
 * Every user-supplied string must pass through this module before reaching a response body.
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** A fragment that has already been escaped and must not be escaped again. */
export class SafeHtml {
  constructor(value) {
    this.value = String(value);
  }

  toString() {
    return this.value;
  }
}

/** Escape a value for HTML text or attribute context. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Mark an already-safe HTML fragment so `html` does not escape it again. */
export function raw(fragment) {
  return new SafeHtml(fragment);
}

/**
 * Tagged template that escapes every interpolated value, so unescaped user text
 * cannot reach the output unless it was explicitly wrapped in `raw()`.
 * Returns SafeHtml: nesting one template inside another never double-escapes.
 */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) {
    out += partHtml(values[i]);
    out += strings[i + 1];
  }
  return new SafeHtml(out);
}

function partHtml(value) {
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(partHtml).join('');
  return escapeHtml(value);
}

/** Escape user text and turn newlines into <br>, the only formatting the site supports. */
export function textBlock(value) {
  return raw(escapeHtml(value).replace(/\n/g, '<br>'));
}

/** Parse a Cookie header into a plain object. */
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

/** Serialize one Set-Cookie header value. */
export function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? '/'}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/** Relative time label. Exact timestamps are never shown: they narrow down who wrote what. */
export function timeAgo(ts, now = Date.now()) {
  const diff = Math.max(0, now - ts);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/**
 * Client IP for rate limiting only. Behind the Cloudflare tunnel the socket address is
 * always loopback, so the tunnel's forwarded headers carry the real address.
 */
export function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).trim();
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}

/** Stable key/value digest for IDs that must not be reversible. */
export function shortHash(hex, length = 16) {
  return hex.slice(0, length);
}

/** True when the request looks same-origin (blocks cross-site form posts). */
export function sameOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin) {
    const referer = req.headers.referer;
    if (!referer) return false;
    try {
      return new URL(referer).host === host;
    } catch {
      return false;
    }
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
