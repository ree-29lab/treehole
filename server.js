/**
 * HTTP entry point: routing, the passphrase gate, rate limits, form intake and
 * response headers. No framework and no runtime dependencies — Node's http module
 * plus node:sqlite.
 */

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

import * as store from './src/db.js';
import * as auth from './src/auth.js';
import * as views from './src/render.js';
import { loadConfig } from './src/config.js';
import { validateBody } from './src/filter.js';
import { clientIp, originLabel, parseCookies, serializeCookie, sameOrigin } from './src/util.js';

const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url));

const STATIC_FILES = {
  '/public/style.css': { path: 'public/style.css', type: 'text/css; charset=utf-8' },
  '/public/app.js': { path: 'public/app.js', type: 'text/javascript; charset=utf-8' }
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow'
};

const FLASHES = {
  posted: { type: 'ok', message: '放进树洞了。想删的话，在「我发过的」里。' },
  replied: { type: 'ok', message: '回应发出去了。' },
  reported: { type: 'ok', message: '收到，管理员会看一下。谢谢你。' },
  deleted: { type: 'ok', message: '删掉了，库里也没有了。' }
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Only relative, single-slash paths may be used as redirect targets. */
function safeBack(value, fallback = '/') {
  const target = String(value ?? '');
  if (!target.startsWith('/') || target.startsWith('//')) return fallback;
  return target;
}

function escapeForId(id) {
  return Number.isInteger(id) && id > 0 ? String(id) : null;
}

export function createApp(config) {
  const { app: settings, keywords, words, credentials, dbPath } = config;
  const database = store.openDb(dbPath);
  const nonces = new Map();
  let requestCount = 0;

  function issueNonce() {
    const token = randomBytes(9).toString('hex');
    nonces.set(token, Date.now() + 10 * 60 * 1000);
    if (nonces.size > 20000) {
      const now = Date.now();
      for (const [key, expiry] of nonces) if (expiry < now) nonces.delete(key);
    }
    return token;
  }

  function consumeNonce(token) {
    const expiry = nonces.get(String(token ?? ''));
    if (expiry === undefined) return false;
    nonces.delete(String(token));
    return expiry > Date.now();
  }

  function rateLimited(req, action, perMinute) {
    const ipHash = auth.opaqueId(credentials.secret, 'ip', clientIp(req));
    const now = Date.now();
    const hits = store.countRate(database, { ipHash, action, since: now - 60000 });
    if (hits >= perMinute) return true;
    store.addRate(database, { ipHash, action, now });
    if (Math.random() < 0.02) store.pruneRate(database, now - 3600000);
    return false;
  }

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
    res.end(body);
  }

  function sendHtml(res, status, body, headers = {}) {
    send(res, status, String(body), { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  }

  function redirect(res, location, extraHeaders = {}) {
    send(res, 302, '', { Location: location, ...extraHeaders });
  }

  function errorResponse(res, status, message) {
    sendHtml(res, status, views.errorPage({ status, message }));
  }

  async function readForm(req) {
    const type = String(req.headers['content-type'] ?? '');
    if (!type.startsWith('application/x-www-form-urlencoded')) {
      throw new HttpError(415, '提交格式不对，请刷新页面重试。');
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > settings.bodyLimitBytes) throw new HttpError(413, '提交的内容太长了。');
      chunks.push(chunk);
    }
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  }

  /**
   * Reject a submission that clearly came from another site. The single-use nonce is
   * the real CSRF guard; this only catches the obvious cases, and logs why it fired so
   * a locked-out visitor can be diagnosed from logs/server.log instead of guesswork.
   */
  function assertSameOrigin(req) {
    if (sameOrigin(req)) return;
    console.warn(`[treehole] 拒了一次疑似跨站提交：${originLabel(req)}`);
    throw new HttpError(403, '这个提交不是从本站页面发出来的。');
  }

  /** Every mutating request must come from this site and carry a fresh nonce. */
  function guardPost(req, res, form) {
    assertSameOrigin(req);
    if (!consumeNonce(form.get('nonce'))) {
      throw new HttpError(409, '这个表单已经提交过了，或者放了太久。刷新页面再试一次。');
    }
    void res;
  }

  function deviceFrom(req, res, cookies) {
    const raw = cookies.dev;
    const existing = auth.readDeviceId(credentials.secret, raw);
    if (existing) return { deviceId: existing, deviceHash: auth.opaqueId(credentials.secret, 'dev', existing), setCookie: null };
    const deviceId = auth.newDeviceId();
    const value = auth.deviceToken(credentials.secret, deviceId);
    const setCookie = serializeCookie('dev', value, {
      maxAge: settings.deviceDays * 86400,
      sameSite: 'Lax'
    });
    return {
      deviceId,
      deviceHash: auth.opaqueId(credentials.secret, 'dev', deviceId),
      setCookie
    };
  }

  function baseCtx({ deviceHash, issueNonce: issue, back, now = Date.now() }) {
    return {
      now,
      moods: settings.moods,
      back,
      deviceHash,
      issueNonce: issue,
      huggedPosts: new Set(),
      huggedComments: new Set(),
      previewComments: new Map()
    };
  }

  function feedCtx({ deviceHash, back, posts, now }) {
    const ctx = baseCtx({ deviceHash, issueNonce, back, now });
    ctx.huggedPosts = store.huggedSet(database, {
      targetType: 'post',
      ids: posts.map((p) => p.id),
      deviceHash
    });
    for (const post of posts) {
      ctx.previewComments.set(post.id, store.listRecentComments(database, post.id, 2));
    }
    return ctx;
  }

  function gateAuthed(cookies) {
    return auth.safeEqual(cookies.tk ?? '', auth.gateToken(credentials));
  }

  function adminAuthed(cookies) {
    return auth.safeEqual(cookies.adm ?? '', auth.adminToken(credentials));
  }

  function renderFeed(res, req, url, device, { flash, error, draft } = {}) {
    const mood = url.searchParams.get('mood') ?? '';
    const before = Number(url.searchParams.get('before') ?? 0) || undefined;
    const rows = store.listPosts(database, { before, limit: settings.pageSize + 1, mood });
    const hasMore = rows.length > settings.pageSize;
    const posts = hasMore ? rows.slice(0, settings.pageSize) : rows;
    const ctx = feedCtx({ deviceHash: device.deviceHash, back: '/', posts, now: Date.now() });
    const page = views.feedPage({
      ctx,
      posts,
      moods: settings.moods,
      mood,
      expireDays: settings.expireDays,
      hasMore,
      flash: flash ?? FLASHES[url.searchParams.get('flash')] ?? null,
      error,
      draft
    });
    sendHtml(res, 200, page, device.setCookie ? { 'Set-Cookie': device.setCookie } : {});
    void req;
  }

  function renderPost(res, device, id, { flash, draft } = {}) {
    const post = store.getPost(database, id);
    if (!post || post.hidden === 1) {
      return errorResponse(res, 404, '这条树洞不在了——可能被作者删掉，也可能被折叠了。');
    }
    const comments = store.listComments(database, id);
    const ctx = baseCtx({ deviceHash: device.deviceHash, issueNonce, back: `/p/${id}` });
    ctx.huggedPosts = store.huggedSet(database, { targetType: 'post', ids: [post.id], deviceHash: device.deviceHash });
    ctx.huggedComments = store.huggedSet(database, {
      targetType: 'comment',
      ids: comments.map((c) => c.id),
      deviceHash: device.deviceHash
    });
    const page = views.postPage({ ctx, post, comments, flash, draft });
    return sendHtml(res, 200, page, device.setCookie ? { 'Set-Cookie': device.setCookie } : {});
  }

  async function handle(req, res) {
    requestCount += 1;
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    const cookies = parseCookies(req.headers.cookie);

    if (path === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain; charset=utf-8' });
    if (path === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /\n', { 'Content-Type': 'text/plain; charset=utf-8' });

    const staticFile = STATIC_FILES[path];
    if (staticFile) {
      try {
        const body = readFileSync(join(config.root, staticFile.path));
        return send(res, 200, body, { 'Content-Type': staticFile.type, 'Cache-Control': 'no-cache' });
      } catch {
        return errorResponse(res, 404, '找不到这个文件。');
      }
    }

    // ---- 口令门禁 ----
    if (path === '/gate' && req.method === 'GET') {
      if (gateAuthed(cookies)) return redirect(res, '/');
      const failed = url.searchParams.get('err') === '1';
      return sendHtml(
        res,
        200,
        views.gatePage({
          error: failed
            ? '口令不对。照着发给你的人那串字一个一个对：有没有少字、多空格、或者中间那两条短横线变成了别的符号。直接点别人发的那条链接最省事。'
            : null
        })
      );
    }

    if (path === '/gate' && req.method === 'POST') {
      if (rateLimited(req, 'gate', settings.limits.gatePerMinute)) {
        return errorResponse(res, 429, '试得太快了，等一分钟再来。');
      }
      const form = await readForm(req);
      if (!auth.phraseMatches(form.get('passphrase'), credentials.passphrase)) {
        return redirect(res, '/gate?err=1');
      }
      return redirect(res, safeBack(form.get('next'), '/'), {
        'Set-Cookie': serializeCookie('tk', auth.gateToken(credentials), {
          maxAge: settings.sessionDays * 86400,
          sameSite: 'Lax'
        })
      });
    }

    // 带口令的分享链接：/?k=口令
    const linkKey = url.searchParams.get('k');
    if (linkKey !== null && auth.phraseMatches(linkKey, credentials.passphrase)) {
      return redirect(res, '/', {
        'Set-Cookie': serializeCookie('tk', auth.gateToken(credentials), {
          maxAge: settings.sessionDays * 86400,
          sameSite: 'Lax'
        })
      });
    }

    // 后台用的是另一个口令，不该被访客门禁挡住 —— 否则改一次访客口令，
    // 连管理员自己都会被弹到口令页，还以为是后台口令错了。
    const adminArea = path === '/admin' || path.startsWith('/admin/');
    if (!adminArea && !gateAuthed(cookies)) {
      return redirect(res, path === '/' ? '/gate' : `/gate?next=${encodeURIComponent(path + url.search)}`);
    }

    const device = deviceFrom(req, res, cookies);
    const postParam = path.match(/^\/p\/(\d+)$/);
    const replyParam = path.match(/^\/c\/(\d+)$/);

    // ---- 读页面 ----
    if (req.method === 'GET' && path === '/') {
      return renderFeed(res, req, url, device);
    }

    if (req.method === 'GET' && postParam) {
      return renderPost(res, device, Number(postParam[1]), {
        flash: FLASHES[url.searchParams.get('flash')] ?? null
      });
    }

    if (req.method === 'GET' && path === '/rules') {
      return sendHtml(res, 200, views.rulesPage(), device.setCookie ? { 'Set-Cookie': device.setCookie } : {});
    }

    if (req.method === 'GET' && path === '/privacy') {
      const page = views.privacyPage({ expireDays: settings.expireDays });
      return sendHtml(res, 200, page, device.setCookie ? { 'Set-Cookie': device.setCookie } : {});
    }

    if (req.method === 'GET' && path === '/mine') {
      const posts = store.listPosts(database, { limit: 100, deviceHash: device.deviceHash, includeHidden: true });
      const ctx = baseCtx({ deviceHash: device.deviceHash, issueNonce, back: '/mine' });
      return sendHtml(
        res,
        200,
        views.minePage({ ctx, posts, flash: FLASHES[url.searchParams.get('flash')] ?? null }),
        device.setCookie ? { 'Set-Cookie': device.setCookie } : {}
      );
    }

    // ---- 写操作 ----
    if (req.method === 'POST' && path === '/post') {
      const form = await readForm(req);
      guardPost(req, res, form);
      // 洪水闸门：拦掉机器刷请求，但不算进「一分钟一条」的额度
      if (rateLimited(req, 'post.attempt', settings.limits.postAttemptsPerMinute)) {
        return errorResponse(res, 429, '慢一点，提交得太频繁了。');
      }
      const daily = store.countPostsSince(database, Date.now() - 86400000);
      if (daily >= settings.limits.dailyPostCap) {
        return errorResponse(res, 503, '今天树洞已经满了，明天再来吧。');
      }
      const checked = validateBody(form.get('body'), {
        maxChars: settings.postMaxChars,
        patterns: keywords.blockedPatterns,
        crisisWords: keywords.crisisWords
      });
      if (!checked.ok) {
        return renderFeed(res, req, new URL('/', url), device, { error: checked.message, draft: String(form.get('body') ?? '').slice(0, settings.postMaxChars) });
      }
      // 校验通过后才计额度：写错字被退回来的人，不应该因此发不出下一条
      if (rateLimited(req, 'post', settings.limits.postPerMinute)) {
        return errorResponse(res, 429, '慢一点，一分钟只能发一条。');
      }
      const postsToday = store.countPostsByDeviceSince(database, device.deviceHash, Date.now() - 86400000);
      if (postsToday >= settings.limits.postPerDay) {
        return errorResponse(res, 429, '这台设备今天发得够多了，让别人也说两句。');
      }
      const moodKey = String(form.get('mood') ?? '');
      const mood = settings.moods.some((m) => m.key === moodKey) ? moodKey : '';
      const now = Date.now();
      // 勾了「N 天后自动消失」的帖子，到点连回应一起真删（见 purgeExpiredPosts）
      const wantsExpiry = form.get('expire') !== null && form.get('expire') !== '';
      const expiresAt = wantsExpiry ? now + settings.expireDays * 86400000 : null;
      const id = store.createPost(database, {
        body: checked.text,
        mood,
        code: '……',
        deviceHash: device.deviceHash,
        crisis: checked.crisis,
        now,
        expiresAt
      });
      store.setPostCode(database, id, auth.displayCode(words, device.deviceHash, id));
      const headers = device.setCookie ? { 'Set-Cookie': device.setCookie } : {};
      return redirect(res, `/?flash=posted#p${id}`, headers);
    }

    if (req.method === 'POST' && replyParam) {
      const postId = Number(replyParam[1]);
      const post = store.getPost(database, postId);
      if (!post || post.hidden === 1) return errorResponse(res, 404, '这条树洞不在了。');
      const form = await readForm(req);
      guardPost(req, res, form);
      if (rateLimited(req, 'reply.attempt', settings.limits.replyAttemptsPerMinute)) {
        return errorResponse(res, 429, '慢一点，提交得太频繁了。');
      }
      const checked = validateBody(form.get('body'), {
        maxChars: settings.commentMaxChars,
        patterns: keywords.blockedPatterns,
        crisisWords: keywords.crisisWords
      });
      if (!checked.ok) {
        return renderPost(res, device, postId, { flash: { type: 'err', message: checked.message }, draft: String(form.get('body') ?? '') });
      }
      if (rateLimited(req, 'reply', settings.limits.replyPerMinute)) {
        return errorResponse(res, 429, '慢一点，一分钟最多回应五条。');
      }
      const repliesToday = store.countCommentsByDeviceSince(database, device.deviceHash, Date.now() - 86400000);
      if (repliesToday >= settings.limits.postPerDay * 5) {
        return errorResponse(res, 429, '回应得太多了，歇一会儿。');
      }
      const parentRaw = Number(form.get('parent_id') ?? 0);
      let parentId = null;
      if (parentRaw) {
        const parent = store.commentsIn(database, [parentRaw])[0];
        if (!parent || parent.post_id !== postId) {
          return errorResponse(res, 400, '要回应的那条不在这棵树上。');
        }
        parentId = parentRaw;
      }
      const commentId = store.createComment(database, {
        postId,
        parentId,
        body: checked.text,
        code: auth.displayCode(words, device.deviceHash, postId),
        deviceHash: device.deviceHash,
        crisis: checked.crisis,
        now: Date.now()
      });
      const headers = device.setCookie ? { 'Set-Cookie': device.setCookie } : {};
      return redirect(res, `/p/${postId}?flash=replied#c${commentId}`, headers);
    }

    if (req.method === 'POST' && path === '/hug') {
      const form = await readForm(req);
      assertSameOrigin(req);
      const targetType = String(form.get('target_type') ?? '');
      const targetId = Number(form.get('target_id') ?? 0);
      const back = safeBack(form.get('back'));
      if (!['post', 'comment'].includes(targetType) || !targetId) {
        return errorResponse(res, 400, '抱错了。');
      }
      if (rateLimited(req, 'hug', settings.limits.hugPerMinute)) {
        return errorResponse(res, 429, '点得太快了。');
      }
      const result = store.addHug(database, {
        targetType,
        targetId,
        deviceHash: device.deviceHash,
        now: Date.now()
      });
      if (String(req.headers.accept ?? '').includes('application/json')) {
        return send(res, 200, JSON.stringify({ count: result.count, hugged: true }), {
          'Content-Type': 'application/json; charset=utf-8',
          ...(device.setCookie ? { 'Set-Cookie': device.setCookie } : {})
        });
      }
      return redirect(res, back, device.setCookie ? { 'Set-Cookie': device.setCookie } : {});
    }

    if (req.method === 'POST' && path === '/report') {
      const form = await readForm(req);
      assertSameOrigin(req);
      const targetType = String(form.get('target_type') ?? '');
      const targetId = Number(form.get('target_id') ?? 0);
      const back = safeBack(form.get('back'));
      const reason = String(form.get('reason') ?? '其他').slice(0, 60);
      if (!['post', 'comment'].includes(targetType) || !targetId) {
        return errorResponse(res, 400, '举报对象不对。');
      }
      if (rateLimited(req, 'report', settings.limits.reportPerMinute)) {
        return errorResponse(res, 429, '举报得太快了，歇一下。');
      }
      const exists =
        targetType === 'post' ? store.getPost(database, targetId) : store.commentsIn(database, [targetId])[0];
      if (!exists) return errorResponse(res, 404, '这条内容已经不存在了。');
      store.addReport(database, {
        targetType,
        targetId,
        reason,
        deviceHash: device.deviceHash,
        now: Date.now(),
        threshold: settings.reportHideThreshold
      });
      return redirect(res, `${back}${back.includes('?') ? '&' : '?'}flash=reported`, device.setCookie ? { 'Set-Cookie': device.setCookie } : {});
    }

    if (req.method === 'POST' && path === '/delete') {
      const form = await readForm(req);
      guardPost(req, res, form);
      const targetType = String(form.get('target_type') ?? '');
      const targetId = Number(form.get('target_id') ?? 0);
      const back = safeBack(form.get('back'), '/mine');
      if (!['post', 'comment'].includes(targetType) || !targetId) {
        return errorResponse(res, 400, '删除对象不对。');
      }
      const ok = store.deleteOwn(database, { targetType, targetId, deviceHash: device.deviceHash });
      if (!ok) return errorResponse(res, 403, '这条不是你发的，删不了。');
      return redirect(res, `${back}${back.includes('?') ? '&' : '?'}flash=deleted`, device.setCookie ? { 'Set-Cookie': device.setCookie } : {});
    }

    // ---- 后台 ----
    if (path === '/admin/login' && req.method === 'POST') {
      if (rateLimited(req, 'adminlogin', settings.limits.gatePerMinute)) {
        return errorResponse(res, 429, '试得太快了。');
      }
      const form = await readForm(req);
      if (!auth.phraseMatches(form.get('passphrase'), credentials.adminPassphrase)) {
        return sendHtml(res, 401, views.adminLoginPage({ error: '后台口令不对。（访客口令在这里不管用，两个是分开的。）' }));
      }
      return redirect(res, '/admin', {
        'Set-Cookie': serializeCookie('adm', auth.adminToken(credentials), {
          maxAge: settings.sessionDays * 86400,
          sameSite: 'Lax'
        })
      });
    }

    // 后台的每一个入口都要管理员口令，不只是首页
    if (path.startsWith('/admin') && !adminAuthed(cookies)) {
      if (path === '/admin' && req.method === 'GET') {
        return sendHtml(res, 200, views.adminLoginPage({ error: null }));
      }
      return errorResponse(res, 403, '这里需要管理员口令。');
    }

    if (path === '/admin' && req.method === 'GET') {
      const reports = store.openReports(database, 100);
      const hidden = store.hiddenItems(database, 100);
      const commentIds = reports.filter((r) => r.target_type === 'comment').map((r) => r.target_id);
      const comments = store.commentsIn(database, commentIds);
      const items = new Map();
      for (const comment of comments) items.set(`comment:${comment.id}`, comment);
      for (const report of reports) {
        if (report.target_type !== 'post') continue;
        const post = store.getPost(database, report.target_id);
        if (post) items.set(`post:${post.id}`, post);
      }
      const ctx = baseCtx({ deviceHash: device.deviceHash, issueNonce, back: '/admin' });
      return sendHtml(
        res,
        200,
        views.adminPage({ ctx, reports, hidden, items, flash: FLASHES[url.searchParams.get('flash')] ?? null }),
        device.setCookie ? { 'Set-Cookie': device.setCookie } : {}
      );
    }

    if (path === '/admin/action' && req.method === 'POST') {
      const form = await readForm(req);
      guardPost(req, res, form);
      const op = String(form.get('op') ?? '');
      const targetType = String(form.get('target_type') ?? '');
      const targetId = Number(form.get('target_id') ?? 0);
      if (!['post', 'comment'].includes(targetType) || !targetId) {
        return errorResponse(res, 400, '对象不对。');
      }
      const now = Date.now();
      if (op === 'hide') store.setHidden(database, { targetType, targetId, hidden: true, now });
      else if (op === 'restore') store.setHidden(database, { targetType, targetId, hidden: false, now });
      else if (op === 'dismiss') store.dismissReportsFor(database, { targetType, targetId });
      else if (op === 'delete') store.adminDelete(database, { targetType, targetId, now });
      else return errorResponse(res, 400, '不认识的操作。');
      return redirect(res, '/admin');
    }

    if (path === '/admin/export' && req.method === 'GET') {
      const data = JSON.stringify(store.exportAll(database), null, 2);
      return send(res, 200, data, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="treehole-export.json"'
      });
    }

    return errorResponse(res, 404, '这里没有东西。');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof HttpError) {
        errorResponse(res, err.status, err.message);
        return;
      }
      console.error('[treehole] 未处理的错误：', err);
      errorResponse(res, 500, '服务器出了点问题，刷新试试。');
    });
  });

  // 到点自毁：页面在读取时就已经看不到过期帖，这里负责把它们真正从磁盘上删掉。
  // unref 是为了不拖住进程退出（测试里尤其重要）。
  const sweep = setInterval(() => {
    const removed = store.purgeExpiredPosts(database);
    if (removed.length > 0) console.log(`[treehole] 到点自毁：删掉 ${removed.length} 条`);
  }, Math.max(1, settings.sweepMinutes) * 60000);
  sweep.unref();

  return {
    server,
    database,
    config,
    /** Exposed for tests. */
    issueNonce,
    purgeExpired() {
      return store.purgeExpiredPosts(database);
    },
    close() {
      clearInterval(sweep);
      server.close();
      database.close();
    },
    stats() {
      return { requestCount, nonces: nonces.size };
    }
  };
}

/**
 * @param {{root?: string, port?: number, host?: string, dataDir?: string, config?: object}} [options]
 * @returns {Promise<{url: string, app: object, server: import('node:http').Server, close: () => void}>}
 */
export async function startServer(options = {}) {
  const root = options.root ?? PROJECT_ROOT;
  const config = options.config ?? loadConfig(root, { dataDir: options.dataDir });
  const app = createApp(config);
  const host = options.host ?? config.app.host;
  const port = options.port ?? config.app.port;
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(port, host, resolve);
  });
  const address = app.server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return {
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`,
    config,
    app,
    server: app.server,
    close() {
      app.close();
    }
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const started = await startServer();
  const { config } = started;
  console.log('🌳 树洞已启动');
  console.log(`   本机地址：${started.url}`);
  console.log(`   分享口令：${config.credentials.passphrase}`);
  console.log(`   分享链接：${started.url}/?k=${encodeURIComponent(config.credentials.passphrase)}`);
  console.log(`   管理口令：${config.credentials.adminPassphrase}（后台在 ${started.url}/admin，只给你自己）`);
  console.log(`   数据文件：${config.dbPath}`);
  if (config.credentialsGenerated) console.log('   （口令是这次新生成的，已写入 data/secret.json，别丢了也别提交到 git）');
}
