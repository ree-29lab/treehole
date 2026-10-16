/**
 * Server-rendered HTML. Every page is a pure function of its arguments, and every
 * piece of user text goes through `textBlock`/`html` so it is escaped exactly once.
 *
 * `ctx` carries per-request state down the render tree:
 *   { now, moods, back, issueNonce, huggedPosts:Set, huggedComments:Set, previewComments:Map }
 */

import { html, raw, textBlock, timeAgo } from './util.js';

export const HOTLINE = '12356';

function nonceField(ctx) {
  return html`<input type="hidden" name="nonce" value="${ctx.issueNonce()}">`;
}

export function layout({ title, body, flash }) {
  return html`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>${title ? `${title} · 树洞` : '树洞'}</title>
<link rel="stylesheet" href="/public/style.css">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ctext y='26' font-size='26'%3E%F0%9F%8C%B3%3C/text%3E%3C/svg%3E">
</head>
<body>
<header class="top">
  <a class="brand" href="/">🌳 树洞</a>
  <nav>
    <a href="/">广场</a>
    <a href="/rules">版规</a>
    <a href="/privacy">隐私</a>
    <a href="/mine">我发过的</a>
  </nav>
</header>
${flash ? html`<div class="flash ${flash.type}">${flash.message}</div>` : ''}
<main>
${raw(body)}
</main>
<footer>
  <p>这里说的话会被人看见，但不会记名。请不要写下任何能指认到具体人的信息。</p>
  <p>如果此刻很难受：<strong>${HOTLINE}</strong> 全国统一心理援助热线（24 小时，免费）。</p>
  <p class="dim">本站不记录 IP、不做访问统计、不投放任何第三方脚本。<a href="/privacy">隐私说明</a></p>
</footer>
<script src="/public/app.js" defer></script>
</body>
</html>`;
}

function moodChip(mood, moods) {
  if (!mood) return '';
  const found = (moods ?? []).find((m) => m.key === mood);
  return found ? html`<span class="mood">${found.emoji} ${found.key}</span>` : html`<span class="mood">${mood}</span>`;
}

/** 「还有 3 天消失」——把自毁时间说清楚，写的人才安心。 */
export function expiryLabel(expiresAt, now) {
  if (!expiresAt) return '';
  const left = expiresAt - now;
  if (left <= 0) return '正在消失';
  const days = Math.ceil(left / 86400000);
  if (days > 1) return `还有 ${days} 天消失`;
  const hours = Math.ceil(left / 3600000);
  return hours > 1 ? `还有 ${hours} 小时消失` : '马上消失';
}

function metaLine({ code, createdAt, now, moods, mood, extra, expiresAt }) {
  const expiry = expiryLabel(expiresAt, now);
  return html`<div class="meta">
  <span class="code">${code}</span>
  <span class="sep">·</span><span class="time">${timeAgo(createdAt, now)}</span>${mood ? moodChip(mood, moods) : ''}${expiry ? html`<span class="expiry">⏳ ${expiry}</span>` : ''}${extra ? html`<span class="sep">·</span><span class="time">${extra}</span>` : ''}
</div>`;
}

function reportForm(ctx, { targetType, targetId }) {
  return html`<details class="report">
  <summary>举报</summary>
  <form method="post" action="/report">
    <input type="hidden" name="target_type" value="${targetType}">
    <input type="hidden" name="target_id" value="${targetId}">
    <input type="hidden" name="back" value="${ctx.back}">
    <select name="reason">
      <option value="攻击或辱骂">攻击或辱骂</option>
      <option value="泄露他人隐私">泄露他人隐私</option>
      <option value="广告或引流">广告或引流</option>
      <option value="看着很难受，想让管理员看看">看着很难受，想让管理员看看</option>
      <option value="其他">其他</option>
    </select>
    <button type="submit">提交举报</button>
  </form>
</details>`;
}

function hugForm(ctx, { targetType, targetId, count, hugged }) {
  return html`<form class="inline hugform" method="post" action="/hug">
  <input type="hidden" name="target_type" value="${targetType}">
  <input type="hidden" name="target_id" value="${targetId}">
  <input type="hidden" name="back" value="${ctx.back}">
  <button class="hug${hugged ? ' on' : ''}" type="submit">🫂 抱抱 <span class="n">${count}</span></button>
</form>`;
}

/** Crisis content is collapsed behind a warning instead of being hidden or rejected. */
function bodyBlock(text, folded) {
  if (!folded) return html`<div class="body">${textBlock(text)}</div>`;
  return html`<details class="folded">
  <summary>这条可能有点重，点开前先喘口气</summary>
  <div class="body">${textBlock(text)}</div>
</details>
<p class="hint">看到这条的你，也可以打 <strong>${HOTLINE}</strong>（全国心理援助热线，24 小时）。</p>`;
}

export function replyForm(ctx, { postId, parentId, placeholder, draft = '' }) {
  return html`<form class="reply" method="post" action="/c/${postId}">
  ${nonceField(ctx)}
  <input type="hidden" name="parent_id" value="${parentId ?? ''}">
  <textarea name="body" rows="3" maxlength="500" placeholder="${placeholder}" data-counter>${draft}</textarea>
  <button type="submit">发出去</button>
</form>`;
}

function commentNode(ctx, comment, children) {
  return html`<div class="comment" id="c${comment.id}">
  ${metaLine({ code: comment.code, createdAt: comment.created_at, now: ctx.now, extra: comment.parent_id ? '回应楼上' : '' })}
  ${bodyBlock(comment.body, comment.folded === 1)}
  <div class="actions">
    ${hugForm(ctx, { targetType: 'comment', targetId: comment.id, count: comment.hug_count, hugged: ctx.huggedComments.has(comment.id) })}
    <details class="replybox">
      <summary>回应</summary>
      ${replyForm(ctx, { postId: comment.post_id, parentId: comment.id, placeholder: '回应这条…' })}
    </details>
    ${comment.device_hash === ctx.deviceHash
      ? html`<form class="inline" method="post" action="/delete" data-confirm="删掉就真的没了，确定吗？">
      ${nonceField(ctx)}
      <input type="hidden" name="target_type" value="comment">
      <input type="hidden" name="target_id" value="${comment.id}">
      <input type="hidden" name="back" value="${ctx.back}">
      <button class="danger own" type="submit">删除</button>
    </form>`
      : ''}
    ${reportForm(ctx, { targetType: 'comment', targetId: comment.id })}
  </div>
  ${children.length ? html`<div class="replies">${raw(children.map((child) => commentNode(ctx, child, [])).join(''))}</div>` : ''}
</div>`;
}

/** Top-level comments with their direct replies inlined; deeper replies stay flat inside the parent block. */
function commentTree(ctx, comments) {
  const byParent = new Map();
  const roots = [];
  for (const comment of comments) {
    if (comment.hidden === 1) continue;
    if (!comment.parent_id) {
      roots.push(comment);
      continue;
    }
    const list = byParent.get(comment.parent_id) ?? [];
    list.push(comment);
    byParent.set(comment.parent_id, list);
  }
  return roots.map((root) => commentNode(ctx, root, byParent.get(root.id) ?? [])).join('');
}

function postCard(ctx, post) {
  const preview = ctx.previewComments.get(post.id) ?? [];
  const rest = Math.max(0, post.reply_count - preview.length);
  return html`<article class="card" id="p${post.id}">
  ${metaLine({ code: post.code, createdAt: post.created_at, now: ctx.now, moods: ctx.moods, mood: post.mood, expiresAt: post.expires_at })}
  ${bodyBlock(post.body, post.folded === 1)}
  <div class="actions">
    ${hugForm(ctx, { targetType: 'post', targetId: post.id, count: post.hug_count, hugged: ctx.huggedPosts.has(post.id) })}
    <a class="count" href="/p/${post.id}">💬 回应 <span class="n">${post.reply_count}</span></a>
    <details class="replybox">
      <summary>直接回应</summary>
      ${replyForm(ctx, { postId: post.id, parentId: '', placeholder: '写点什么回应他…' })}
    </details>
    ${reportForm(ctx, { targetType: 'post', targetId: post.id })}
  </div>
  ${preview.length
    ? html`<div class="preview">${raw(
        preview.map((c) => html`<p><span class="code">${c.code}</span> ${textBlock(c.body)}</p>`).join('')
      )}${rest > 0 ? html`<a class="more" href="/p/${post.id}">还有 ${rest} 条回应</a>` : ''}</div>`
    : ''}
</article>`;
}

export function gatePage({ error }) {
  return layout({
    title: '口令',
    body: html`<section class="gate">
  <h1>🌳 树洞</h1>
  <p>这里只对拿到口令的人开放。口令问给你链接的人要——直接点他发的那条链接，就不用输了。</p>
  ${error ? html`<div class="flash err">${error}</div>` : ''}
  <form method="post" action="/gate">
    <input class="phrase" type="text" name="passphrase" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="输入口令" autofocus>
    <button type="submit">进去</button>
  </form>
  <p class="dim">进去了就能看、能写、能回应。没有人知道你是谁，本站也不知道。</p>
</section>`
  });
}

export function feedPage({ ctx, posts, moods, mood, flash, error, draft, hasMore, expireDays }) {
  return layout({
    title: '广场',
    flash,
    body: html`${error ? html`<div class="flash err">${error}</div>` : ''}
<section class="compose-wrap">
  <form class="compose" method="post" action="/post">
    ${nonceField(ctx)}
    <textarea name="body" rows="4" maxlength="1000" data-counter placeholder="想说什么就写在这里。不会有人知道是你。">${draft ?? ''}</textarea>
    <div class="moods">
      ${raw(
        moods
          .map(
            (m, index) => html`<label class="chip"><input type="radio" name="mood" value="${m.key}"${index === 0 ? ' checked' : ''}><span>${m.emoji} ${m.key}</span></label>`
          )
          .join('')
      )}
      <label class="chip expire-chip" title="勾上之后，这条和它下面的回应会一起在到点时被真删掉">
        <input type="checkbox" name="expire" value="1"><span>⏳ ${expireDays} 天后自动消失</span>
      </label>
      <button class="submit" type="submit">放进树洞</button>
    </div>
  </form>
</section>

<nav class="moodfilter">
  <a class="${mood ? '' : 'on'}" href="/">全部</a>
  ${raw(moods.map((m) => html`<a class="${mood === m.key ? 'on' : ''}" href="/?mood=${encodeURIComponent(m.key)}">${m.emoji} ${m.key}</a>`).join(''))}
</nav>

<section class="feed">
${raw(posts.map((post) => postCard(ctx, post)).join('') || '<p class="empty">还没有人说话。要不要做第一个？</p>')}
</section>
${hasMore
  ? html`<p class="more-wrap"><a class="more" href="/?before=${posts[posts.length - 1].id}${mood ? `&mood=${encodeURIComponent(mood)}` : ''}">看更早的</a></p>`
  : ''}`
  });
}

export function postPage({ ctx, post, comments, flash, draft }) {
  return layout({
    title: `第 ${post.id} 条`,
    flash,
    body: html`<p class="back"><a href="/">← 回广场</a></p>
<article class="card single" id="p${post.id}">
  ${metaLine({ code: post.code, createdAt: post.created_at, now: ctx.now, moods: ctx.moods, mood: post.mood, expiresAt: post.expires_at })}
  ${bodyBlock(post.body, post.folded === 1)}
  <div class="actions">
    ${hugForm(ctx, { targetType: 'post', targetId: post.id, count: post.hug_count, hugged: ctx.huggedPosts.has(post.id) })}
    <span class="count">💬 回应 <span class="n">${post.reply_count}</span></span>
    ${post.device_hash === ctx.deviceHash
      ? html`<form class="inline" method="post" action="/delete" data-confirm="删掉整条树洞（含所有回应）就真的没了，确定吗？">
      ${nonceField(ctx)}
      <input type="hidden" name="target_type" value="post">
      <input type="hidden" name="target_id" value="${post.id}">
      <input type="hidden" name="back" value="/mine">
      <button class="danger own" type="submit">删除</button>
    </form>`
      : ''}
    ${reportForm(ctx, { targetType: 'post', targetId: post.id })}
  </div>
</article>
<section class="replybox-main">
  ${replyForm(ctx, { postId: post.id, parentId: '', placeholder: '写点什么回应他…', draft: draft ?? '' })}
</section>
<section class="comments">
${raw(commentTree(ctx, comments) || '<p class="empty">还没有人回应。你可以是第一个。</p>')}
</section>`
  });
}

export function minePage({ ctx, posts, flash }) {
  const rows = posts
    .map(
      (post) => html`<article class="card">
  ${metaLine({ code: post.code, createdAt: post.created_at, now: ctx.now, moods: ctx.moods, mood: post.mood, extra: `回应 ${post.reply_count}`, expiresAt: post.expires_at })}
  <div class="body">${textBlock(post.body)}</div>
  <div class="actions">
    <a class="count" href="/p/${post.id}">打开</a>
    <form class="inline" method="post" action="/delete" data-confirm="删掉就真的没了，也不会有残留。确定吗？">
      ${nonceField(ctx)}
      <input type="hidden" name="target_type" value="post">
      <input type="hidden" name="target_id" value="${post.id}">
      <input type="hidden" name="back" value="/mine">
      <button class="danger" type="submit">删除</button>
    </form>
  </div>
</article>`
    )
    .join('');
  return layout({
    title: '我发过的',
    flash,
    body: html`<h1 class="page">我发过的</h1>
<p class="dim">这份列表只存在你这台设备的浏览器里。换设备或清掉浏览器数据，就找不回来了。</p>
<section class="feed">
${raw(rows || '<p class="empty">你还没发过什么。</p>')}
</section>`
  });
}

export function privacyPage({ expireDays }) {
  return layout({
    title: '隐私说明',
    body: html`<h1 class="page">隐私说明</h1>
<section class="prose">
  <p>写之前你可能想知道：这个地方记了什么、没记什么。</p>

  <h2>不记的</h2>
  <ul>
    <li><strong>不知道你是谁。</strong>没有账号、没有昵称、不用手机号或邮箱，也不需要登录。</li>
    <li><strong>不记 IP 地址。</strong>只在后台存一个还原不回来的乱码，用来防刷屏，7 天后自动清掉。</li>
    <li><strong>不看你的设备。</strong>你的浏览器那边只有一个随机串，换浏览器或清掉缓存就换了一个人。</li>
    <li><strong>不做统计、不放广告、不装任何第三方的东西。</strong>页面上没有一个外部链接，你的访问不会被别人看到。</li>
    <li><strong>不会被搜索引擎搜到。</strong>所有页面都标了不给收录。</li>
    <li><strong>发在哪条帖子里，就只在那条帖子里。</strong>同一条帖子里的发言能看出是同一个人；换一条帖子，代号就换了，对不上。</li>
  </ul>

  <h2>记的</h2>
  <ul>
    <li>你写的内容本身，和大致时间（页面上只显示「3 小时前」，不显示具体几点几分）。</li>
  </ul>

  <h2>谁能看到</h2>
  <ul>
    <li>拿到口令的人都能看到你写的东西，也都能回应。</li>
    <li><strong>开这个树洞的人（站长）能看到全部内容</strong>——内容就存在他自己电脑的一个文件里。他看不到你是谁、从哪来，但他能看到你写了什么。这一点我不骗你。</li>
    <li>你没有勾「${expireDays} 天后自动消失」的话，内容会一直留着，直到你自己删。</li>
  </ul>

  <h2>你自己能做的</h2>
  <ul>
    <li><strong>随时删掉自己写的</strong>：在「我发过的」里点删除，帖子连它下面的回应一起从数据库里消失，不留痕迹。</li>
    <li><strong>让它自己消失</strong>：发的时候勾上「⏳ N 天后自动消失」，到点连回应一起真删。</li>
    <li><strong>被冒犯就举报</strong>：三条举报会自动折叠，站长会人工看。</li>
  </ul>

  <h2>唯一挡不住的</h2>
  <p>你自己写出来的信息——真名、班级、住址、聊天记录截图、能被认出来的事。技术拦不住这个，请自己别写。</p>

  <h2>还有一句实话</h2>
  <p>网上没有绝对安全的地方。这里能保证的是"少记、不追人、能删"，不是"查不到"。如果一件事连一点点被猜到的风险都不能承担，就别写在这里。</p>

  <p>难受的时候可以打 <strong>${HOTLINE}</strong>（全国统一心理援助热线，24 小时）。</p>
</section>`
  });
}

export function rulesPage() {
  return layout({
    title: '版规',
    body: html`<h1 class="page">这里的规矩</h1>
<section class="prose">
  <h2>一句话</h2>
  <p>这是个只对熟人开放的地方。别伤害别人，也别把自己交出去。</p>
  <h2>会删的东西</h2>
  <ul>
    <li>任何能指认到具体人的信息：真实姓名、班级、住址、照片、聊天记录截图、联系方式。</li>
    <li>广告、拉群、引流、交易、招嫖、赌博。</li>
    <li>人肉、开盒、威胁。</li>
    <li>把别人写在这里的内容截图外传（发现即删，必要时会改口令把外人挡出去）。</li>
  </ul>
  <h2>不会删的东西</h2>
  <ul>
    <li>骂人、脏话、情绪、抱怨——除非它是冲着某个具体的人去的。</li>
    <li>难过的、绝望的、说不出口的内容。这类内容会被自动折叠起来：那是为了保护顺手划到的人，不是为了把你藏起来。</li>
  </ul>
  <h2>举报与撤回</h2>
  <ul>
    <li>每条帖子和回应都有「举报」。三条举报会自动折叠，管理员看到后会人工判断。</li>
    <li>自己发的东西可以随时删掉，删掉就是真的从数据库里消失，不留痕迹。</li>
  </ul>
  <h2>以及</h2>
  <p>如果你此刻很难受，请打 <strong>${HOTLINE}</strong>（全国统一心理援助热线，24 小时）。也可以找身边任何一个活人——同学、老师、家人，谁都行。</p>
</section>`
  });
}

export function adminLoginPage({ error }) {
  return layout({
    title: '后台',
    body: html`<h1 class="page">后台</h1>
<p class="dim">这里用<b>后台口令</b>，和发给朋友的访客口令不是同一个。忘了就跑一次 <code>bin/status.sh</code>，或者看 <code>data/secret.json</code> 里的 <code>adminPassphrase</code>。</p>
${error ? html`<div class="flash err">${error}</div>` : ''}
<form class="adminlogin" method="post" action="/admin/login">
  <input type="text" name="passphrase" placeholder="后台口令" autocomplete="off" autofocus>
  <button type="submit">进</button>
</form>`
  });
}

function reportRow(ctx, report, item) {
  const missing = !item;
  const typeLabel = report.target_type === 'post' ? '帖子' : '回应';
  const link = missing
    ? ''
    : html`<a href="/p/${report.target_type === 'post' ? report.target_id : item.post_id}${report.target_type === 'comment' ? `#c${report.target_id}` : ''}">查看原文</a>`;
  return html`<tr class="${missing ? 'gone' : ''}">
  <td>
    ${metaLine({ code: `${typeLabel} #${report.target_id}`, createdAt: report.created_at, now: ctx.now, extra: `累计举报 ${missing ? 0 : item.report_count}` })}
    <div class="body">${missing ? raw('<em>内容已经被删掉了</em>') : textBlock(item.body)}</div>
    <div class="dim">理由：${report.reason} ｜ ${link}</div>
  </td>
  <td class="ops">
    <form class="inline" method="post" action="/admin/action">
      ${nonceField(ctx)}
      <input type="hidden" name="target_type" value="${report.target_type}">
      <input type="hidden" name="target_id" value="${report.target_id}">
      <button name="op" value="hide" type="submit">折叠</button>
      <button name="op" value="dismiss" type="submit">忽略</button>
      <button class="danger" name="op" value="delete" type="submit" data-confirm="真的删掉吗？">删除</button>
    </form>
  </td>
</tr>`;
}

export function adminPage({ ctx, reports, hidden, items, flash }) {
  const totalHidden = hidden.posts.length + hidden.comments.length;
  return layout({
    title: '后台',
    flash,
    body: html`<h1 class="page">后台</h1>
<p class="dim"><a href="/admin/export">导出全部内容（JSON）</a> ｜ 已折叠 ${totalHidden} 条 ｜ 待处理举报 ${reports.length} 条</p>
<h2 class="page">待处理举报</h2>
<table class="admin">${raw(reports.map((r) => reportRow(ctx, r, items.get(`${r.target_type}:${r.target_id}`))).join('') || '<tr><td>没有待处理的举报。</td></tr>')}</table>
<h2 class="page">已被折叠的内容</h2>
<table class="admin">${raw(
      [...hidden.posts, ...hidden.comments]
        .map(
          (item) => html`<tr>
  <td>
    ${metaLine({ code: `${item.post_id ? '回应' : '帖子'} #${item.id}`, createdAt: item.created_at, now: ctx.now, extra: `举报 ${item.report_count}` })}
    <div class="body">${textBlock(item.body)}</div>
  </td>
  <td class="ops">
    <form class="inline" method="post" action="/admin/action">
      ${nonceField(ctx)}
      <input type="hidden" name="target_type" value="${item.post_id ? 'comment' : 'post'}">
      <input type="hidden" name="target_id" value="${item.id}">
      <button name="op" value="restore" type="submit">恢复</button>
      <button class="danger" name="op" value="delete" type="submit" data-confirm="真的删掉吗？">删除</button>
    </form>
  </td>
</tr>`
        )
        .join('') || '<tr><td>没有。</td></tr>'
    )}</table>`
  });
}

export function errorPage({ status, message }) {
  return layout({
    title: '出错了',
    body: html`<section class="gate">
  <h1>${status}</h1>
  <p>${message}</p>
  <p><a href="/">回广场</a></p>
</section>`
  });
}
