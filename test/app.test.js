/**
 * End-to-end tests over a real HTTP server and a temporary database.
 * Run with: npm test
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import { startServer } from '../server.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PASSPHRASE = '核桃-星轨-41';
const ADMIN = '管理员-口令-77';

let started;
let base;
let dataDir;
let ipCounter = 0;

function nextIp() {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

/** Minimal cookie jar + fetch wrapper. Each client gets its own IP to isolate rate limits. */
function client(ip = nextIp()) {
  const jar = new Map();
  const send = async (path, { method = 'GET', form, headers = {} } = {}) => {
    const merged = { 'cf-connecting-ip': ip, ...headers };
    if (form) {
      merged['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
      // Origin: null（真的 null）表示「这次连 Origin 都不发」，用来模拟内置 WebView。
      if (!('Origin' in headers)) merged.Origin = base;
      else if (headers.Origin === null) delete merged.Origin;
    }
    if (jar.size > 0) {
      merged.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const response = await fetch(base + path, {
      method,
      redirect: 'manual',
      headers: merged,
      body: form ? new URLSearchParams(form).toString() : undefined
    });
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      jar.set(pair.slice(0, eq), decodeURIComponent(pair.slice(eq + 1)));
    }
    return response;
  };
  return {
    ip,
    jar,
    send,
    get: (path, options) => send(path, { method: 'GET', ...options }),
    post: (path, form, options) => send(path, { method: 'POST', form, ...options }),
    async nonce(path = '/') {
      const html = await (await send(path)).text();
      const match = html.match(/name="nonce" value="([0-9a-f]+)"/);
      assert.ok(match, `页面 ${path} 上应该有一个 nonce`);
      return match[1];
    },
    async enter() {
      const response = await send('/gate', { method: 'POST', form: { passphrase: PASSPHRASE } });
      assert.equal(response.status, 302);
      return response;
    }
  };
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'treehole-test-'));
  const config = loadConfig(ROOT, { dataDir });
  config.credentials.passphrase = PASSPHRASE;
  config.credentials.adminPassphrase = ADMIN;
  started = await startServer({ root: ROOT, config, port: 0 });
  base = started.url;
});

after(() => {
  started?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('未过口令的人只能看到口令页', async () => {
  const visitor = client();
  const response = await visitor.get('/');
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/gate');

  const gate = await visitor.get('/gate');
  assert.equal(gate.status, 200);
  assert.match(await gate.text(), /只对拿到口令的人开放/);
});

test('口令错误被拒，正确就种下通行 cookie', async () => {
  const visitor = client();
  const wrong = await visitor.post('/gate', { passphrase: '乱写的' });
  assert.equal(wrong.status, 302);
  assert.equal(wrong.headers.get('location'), '/gate?err=1');

  const right = await visitor.post('/gate', { passphrase: PASSPHRASE });
  assert.equal(right.headers.get('location'), '/');
  assert.ok(visitor.jar.get('tk'), '应该拿到 tk cookie');

  const feed = await visitor.get('/');
  assert.equal(feed.status, 200);
  assert.match(await feed.text(), /放进树洞/);
});

test('口令容错：多空格、全角横线、少打横线都放行，真写错才拦', async () => {
  const variants = [
    ` ${PASSPHRASE} `,
    '核桃－星轨－41',
    '核桃–星轨–41',
    '核桃—星轨—41',
    '核桃星轨41',
    '核桃 - 星轨 - 41'
  ];
  for (const variant of variants) {
    const visitor = client();
    const response = await visitor.post('/gate', { passphrase: variant });
    assert.equal(response.headers.get('location'), '/', `「${variant}」应该能进`);
    assert.ok(visitor.jar.get('tk'));
  }

  const wrong = client();
  const bad = await wrong.post('/gate', { passphrase: '核桃-星轨-42' });
  assert.equal(bad.headers.get('location'), '/gate?err=1', '写错数字还是应该被拦');
  assert.equal(wrong.jar.get('tk'), undefined);
});

test('带口令的分享链接可以直接进站', async () => {
  const visitor = client();
  const response = await visitor.get(`/?k=${encodeURIComponent(PASSPHRASE)}`);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/');
  assert.ok(visitor.jar.get('tk'));
});

test('发一条树洞，广场上就能看到，作者代号是自动生成的', async () => {
  const author = client();
  await author.enter();
  const nonce = await author.nonce('/');
  const posted = await author.post('/post', { nonce, body: '今天有点撑不住了，但还活着。', mood: '情绪' });
  assert.equal(posted.status, 302);
  assert.match(posted.headers.get('location'), /^\/\?flash=posted#p\d+$/);

  const html = await (await author.get('/')).text();
  assert.match(html, /今天有点撑不住了，但还活着。/);
  assert.match(html, /·\d\d<\/span>/, '代号应该是「形容词+名词·数字」的形式');
  assert.match(html, /情绪/);
});

test('脚本标签被转义，不会被当成代码执行', async () => {
  const author = client();
  await author.enter();
  const payload = '<script>alert(1)</script><img src=x onerror=alert(2)>';
  const nonce = await author.nonce('/');
  await author.post('/post', { nonce, body: payload, mood: '' });

  const html = await (await author.get('/')).text();
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), '尖括号应该被转义');
  assert.ok(!html.includes('<script>alert(1)'), '原始脚本标签不该出现');
  assert.ok(!html.includes('onerror=alert(2)>'), '未转义的属性不该出现');
});

test('空内容、超长内容、联系方式都会被挡回来', async () => {
  const author = client();
  await author.enter();

  const empty = await author.post('/post', { nonce: await author.nonce('/'), body: '   \n  ' });
  assert.equal(empty.status, 200);
  assert.match(await empty.text(), /内容是空的/);

  const tooLong = await author.post('/post', {
    nonce: await author.nonce('/'),
    body: '啊'.repeat(1001)
  });
  assert.equal(tooLong.status, 200);
  assert.match(await tooLong.text(), /太长了/);

  const contact = await author.post('/post', {
    nonce: await author.nonce('/'),
    body: '有事加我微信 abcdefg123 聊'
  });
  assert.equal(contact.status, 200);
  assert.match(await contact.text(), /这条不能发/);
});

test('提到自伤的内容照样发出去，只是被折叠并挂上热线', async () => {
  const author = client();
  await author.enter();
  const nonce = await author.nonce('/');
  const response = await author.post('/post', { nonce, body: '有时候真的不想活了。', mood: '深夜' });
  assert.equal(response.status, 302);

  const html = await (await author.get('/')).text();
  assert.match(html, /这条可能有点重，点开前先喘口气/);
  assert.match(html, /12356/);
});

test('任何人都能回应，也能回应某一条回应', async () => {
  const author = client();
  await author.enter();
  const nonce = await author.nonce('/');
  await author.post('/post', { nonce, body: '第一条测试帖。', mood: '提问' });
  const postId = Number((await (await author.get('/')).text()).match(/id="p(\d+)"/)[1]);

  const replier = client();
  await replier.enter();
  const reply = await replier.post(`/c/${postId}`, {
    nonce: await replier.nonce(`/p/${postId}`),
    parent_id: '',
    body: '我在，说说看。'
  });
  assert.equal(reply.status, 302);
  assert.match(reply.headers.get('location'), new RegExp(`^/p/${postId}\\?flash=replied#c\\d+$`));
  const commentId = reply.headers.get('location').match(/#c(\d+)/)[1];

  const page = await (await replier.get(`/p/${postId}`)).text();
  assert.match(page, /我在，说说看。/);
  assert.match(page, /回应 <span class="n">1<\/span>/);

  const nested = await replier.post(`/c/${postId}`, {
    nonce: await replier.nonce(`/p/${postId}`),
    parent_id: commentId,
    body: '再补一句。'
  });
  assert.equal(nested.status, 302);
  assert.match(await (await replier.get(`/p/${postId}`)).text(), /回应楼上/);
});

test('只有作者能删自己发的，删掉就真的没了', async () => {
  const author = client();
  await author.enter();
  await author.post('/post', { nonce: await author.nonce('/'), body: '这条等会儿要删掉。', mood: '' });
  const postId = Number((await (await author.get('/')).text()).match(/id="p(\d+)"/)[1]);

  const stranger = client();
  await stranger.enter();
  const refused = await stranger.post('/delete', {
    nonce: await stranger.nonce('/'),
    target_type: 'post',
    target_id: String(postId),
    back: '/'
  });
  assert.equal(refused.status, 403);

  const removed = await author.post('/delete', {
    nonce: await author.nonce('/mine'),
    target_type: 'post',
    target_id: String(postId),
    back: '/mine'
  });
  assert.equal(removed.status, 302);

  const gone = await author.get(`/p/${postId}`);
  assert.equal(gone.status, 404);
  const feed = await (await author.get('/')).text();
  assert.ok(!feed.includes('这条等会儿要删掉。'));
});

test('同一个表单提交两次，第二次被拦下', async () => {
  const author = client();
  await author.enter();
  const nonce = await author.nonce('/');
  const first = await author.post('/post', { nonce, body: '只应该出现一次。', mood: '' });
  assert.equal(first.status, 302);
  const second = await author.post('/post', { nonce, body: '只应该出现一次。', mood: '' });
  assert.equal(second.status, 409);

  const html = await (await author.get('/')).text();
  assert.equal(html.split('只应该出现一次。').length - 1, 1);
});

test('来自别的站点的提交会被拒', async () => {
  const author = client();
  await author.enter();
  const nonce = await author.nonce('/');
  const response = await author.post(
    '/post',
    { nonce, body: '伪造的跨站提交', mood: '' },
    { headers: { Origin: 'https://evil.example' } }
  );
  assert.equal(response.status, 403);
});

test('浏览器不给 Origin 时不会把主人挡在门外（靠 nonce 把关）', async () => {
  // 微信/QQ 内置 WebView、沙盒化页面会发 Origin: null，或者干脆不发这一条。
  const cases = [
    { Origin: 'null' },
    { Origin: '' },
    { Origin: null }
  ];
  for (const headers of cases) {
    const author = client();
    await author.enter();
    const nonce = await author.nonce('/');
    const response = await author.post(
      '/post',
      { nonce, body: `没有 Origin 也要能发：${JSON.stringify(headers)}`, mood: '' },
      { headers }
    );
    assert.equal(response.status, 302, `${JSON.stringify(headers)} 应该放行`);
  }

  // 但 nonce 仍然是硬门槛：没有它照样拒。
  const author = client();
  await author.enter();
  const noNonce = await author.post('/post', { nonce: 'deadbeefdeadbeef', body: '没有有效 nonce' }, { headers: { Origin: 'null' } });
  assert.equal(noNonce.status, 409);
});

test('限流：一分钟内第二条就发不出去', async () => {
  const author = client();
  await author.enter();
  const ok = await author.post('/post', { nonce: await author.nonce('/'), body: '限流测试第一条。' });
  assert.equal(ok.status, 302);
  const blocked = await author.post('/post', { nonce: await author.nonce('/'), body: '限流测试第二条。' });
  assert.equal(blocked.status, 429);
});

test('抱抱：同一台设备只算一次，换设备就再加一', async () => {
  const author = client();
  await author.enter();
  await author.post('/post', { nonce: await author.nonce('/'), body: '求抱抱。' });
  const postId = Number((await (await author.get('/')).text()).match(/id="p(\d+)"/)[1]);

  const one = await author.post('/hug', { target_type: 'post', target_id: String(postId), back: '/' }, {
    headers: { Accept: 'application/json' }
  });
  assert.equal(one.status, 200);
  assert.equal((await one.json()).count, 1);

  const again = await author.post('/hug', { target_type: 'post', target_id: String(postId), back: '/' }, {
    headers: { Accept: 'application/json' }
  });
  assert.equal((await again.json()).count, 1, '同一台设备重复点只算一次');

  const other = client();
  await other.enter();
  const third = await other.post('/hug', { target_type: 'post', target_id: String(postId), back: '/' }, {
    headers: { Accept: 'application/json' }
  });
  assert.equal((await third.json()).count, 2);
});

test('三条举报会自动折叠，管理员可以恢复，也可以删掉', async () => {
  const author = client();
  await author.enter();
  await author.post('/post', { nonce: await author.nonce('/'), body: '这条会被举报三次。' });
  const postId = Number((await (await author.get('/')).text()).match(/id="p(\d+)"/)[1]);

  for (let i = 0; i < 3; i += 1) {
    const reporter = client();
    await reporter.enter();
    const response = await reporter.post('/report', {
      target_type: 'post',
      target_id: String(postId),
      reason: '攻击或辱骂',
      back: '/'
    });
    assert.equal(response.status, 302);
  }

  assert.equal((await author.get(`/p/${postId}`)).status, 404, '被折叠后外人看不到');
  const mine = await (await author.get('/mine')).text();
  assert.match(mine, /这条会被举报三次。/, '作者自己的列表里还看得到');

  const admin = client();
  await admin.enter();
  const login = await admin.post('/admin/login', { passphrase: ADMIN });
  assert.equal(login.status, 302);
  const dashboard = await admin.get('/admin');
  assert.equal(dashboard.status, 200);
  const dashboardHtml = await dashboard.text();
  assert.match(dashboardHtml, /这条会被举报三次。/);

  const restoreNonce = dashboardHtml.match(/name="nonce" value="([0-9a-f]+)"/)[1];
  const restored = await admin.post('/admin/action', {
    nonce: restoreNonce,
    op: 'restore',
    target_type: 'post',
    target_id: String(postId)
  });
  assert.equal(restored.status, 302);
  assert.equal((await author.get(`/p/${postId}`)).status, 200, '恢复后又能看了');
});

test('后台不需要先过访客门禁（改访客口令不会把管理员关在门外）', async () => {
  const owner = client(); // 完全没有 tk cookie
  const page = await owner.get('/admin');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /后台口令/);

  const login = await owner.post('/admin/login', { passphrase: ADMIN });
  assert.equal(login.status, 302);
  assert.equal(login.headers.get('location'), '/admin');
  assert.ok(owner.jar.get('adm'), '应该拿到后 adm cookie');

  const dashboard = await owner.get('/admin');
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /待处理举报/);

  // 但内容还是要有访客口令才看得到
  const feed = await client().get('/');
  assert.equal(feed.headers.get('location'), '/gate');
});

test('后台口令写错会被拒，且不会种下后台 cookie', async () => {
  const owner = client();
  const wrong = await owner.post('/admin/login', { passphrase: '不是这个' });
  assert.equal(wrong.status, 401);
  assert.equal(owner.jar.get('adm'), undefined);
});

test('过完访客门禁也拿不到后台，除非再输后台口令', async () => {
  const visitor = client();
  await visitor.enter();
  const page = await visitor.get('/admin');
  assert.match(await page.text(), /后台口令/);

  const exportDenied = await visitor.get('/admin/export');
  assert.equal(exportDenied.status, 403, '没登录后台就拿不到导出');
});

test('勾了「自动消失」的帖子会带上倒计时，到点后连回应一起真删', async () => {
  const author = client();
  await author.enter();
  const nonce = await author.nonce('/');
  const posted = await author.post('/post', {
    nonce,
    body: '这条是勾了自毁的。',
    mood: '',
    expire: '1'
  });
  assert.equal(posted.status, 302);
  const postId = Number(posted.headers.get('location').match(/#p(\d+)/)[1]);

  // 列表和详情页都能看到倒计时，作者自己的列表也看得到
  assert.match(await (await author.get('/')).text(), /还有 \d+ 天消失/);
  assert.match(await (await author.get(`/p/${postId}`)).text(), /还有 \d+ 天消失/);

  const row = started.app.database.prepare('SELECT expires_at FROM posts WHERE id = ?').get(postId);
  assert.ok(row.expires_at > Date.now(), 'expires_at 应该是未来时间');

  // 没勾的帖子不应该有倒计时（换个 IP，免得撞上「一分钟一条」的限流）
  const other = client();
  await other.enter();
  const plain = await other.nonce('/');
  const plainPosted = await other.post('/post', { nonce: plain, body: '这条不勾自毁。', mood: '' });
  const plainId = Number(plainPosted.headers.get('location').match(/#p(\d+)/)[1]);
  const plainRow = started.app.database.prepare('SELECT expires_at FROM posts WHERE id = ?').get(plainId);
  assert.equal(plainRow.expires_at, null);

  // 现在把时间拨到过去：列表立刻看不到、详情页 404
  started.app.database
    .prepare('UPDATE posts SET expires_at = ? WHERE id = ?')
    .run(Date.now() - 1000, postId);
  const feed = await (await author.get('/')).text();
  assert.ok(!feed.includes('这条是勾了自毁的。'), '过期后不该再出现在广场');
  assert.equal((await author.get(`/p/${postId}`)).status, 404);

  // 清扫之后，数据库里那一行也真的没了
  const removed = started.app.purgeExpired();
  assert.ok(removed.includes(postId), '清扫应该包括这条');
  const left = started.app.database.prepare('SELECT COUNT(*) AS n FROM posts WHERE id = ?').get(postId);
  assert.equal(Number(left.n), 0, '到点自毁是真删，不是标记');
});

test('隐私说明页能打开，并且把「站长能看到内容」写明白了', async () => {
  const visitor = client();
  await visitor.enter();
  const page = await visitor.get('/privacy');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /不记 IP 地址/);
  assert.match(html, /站长）能看到全部内容/);
  assert.match(html, /随时删掉自己写的/);
  assert.match(html, /12356/);
});
