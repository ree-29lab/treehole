/* 渐进增强：没有 JS 时所有表单照常提交（整页跳转），有 JS 时更顺一点。 */
(function () {
  'use strict';

  // 危险操作要确认
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    var message = form.getAttribute('data-confirm');
    if (message && !window.confirm(message)) event.preventDefault();
  });

  // 抱抱：不刷新页面，只把数字加一
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (!form.classList.contains('hugform')) return;
    event.preventDefault();
    var button = form.querySelector('button');
    var counter = form.querySelector('.n');
    if (button) button.disabled = true;
    fetch(form.action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(new FormData(form)).toString(),
      credentials: 'same-origin'
    })
      .then(function (response) {
        if (!response.ok) throw new Error('hug failed');
        return response.json();
      })
      .then(function (data) {
        if (counter) counter.textContent = String(data.count);
        if (button) button.classList.add('on');
      })
      .catch(function () {
        form.submit();
      })
      .finally(function () {
        if (button) button.disabled = false;
      });
  });

  // ---------- 无痕帖：凭据只存在这台浏览器里 ----------
  // 发帖后服务端把凭据通过 URL 的 ?at= 交回来一次，这里立刻存进 localStorage，
  // 并把地址栏抹干净（免得它留在历史记录里）。
  var ANON_KEY = 'treehole.anon';

  function readAnon() {
    try {
      var raw = window.localStorage.getItem(ANON_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (error) {
      return {};
    }
  }

  function writeAnon(map) {
    try {
      window.localStorage.setItem(ANON_KEY, JSON.stringify(map));
    } catch (error) {
      /* 隐私模式下写不进去就只是删不了，不影响发帖 */
    }
  }

  function tokenFor(postId) {
    return readAnon()[String(postId)] || '';
  }

  (function captureToken() {
    var match = location.search.match(/[?&]at=([0-9a-f]{32})/);
    var postMatch = location.hash.match(/^#p(\d+)$/);
    if (!match || !postMatch) return;
    var map = readAnon();
    map[postMatch[1]] = match[1];
    writeAnon(map);
    var cleaned = location.search.replace(/[?&]at=[0-9a-f]{32}/, '').replace(/^&/, '?');
    if (cleaned === '?') cleaned = '';
    history.replaceState(null, '', location.pathname + cleaned + location.hash);
  })();

  // 无痕内容：本机有凭据才显示删除按钮，并把凭据填进表单
  Array.prototype.forEach.call(document.querySelectorAll('[data-anon-delete]'), function (form) {
    var postId = form.getAttribute('data-anon-post');
    var token = tokenFor(postId);
    if (!token) return;
    var field = form.querySelector('input[name="anon_token"]');
    if (field) field.value = token;
    form.hidden = false;
  });

  // 回应无痕帖时带上凭据：这一句也记成无痕
  Array.prototype.forEach.call(document.querySelectorAll('form[data-anon-for]'), function (form) {
    var token = tokenFor(form.getAttribute('data-anon-for'));
    if (!token) return;
    var field = form.querySelector('input[name="anon_token"]');
    if (field) field.value = token;
  });

  // 「我发过的」里的无痕帖区块：服务端认不出作者，只能靠本机凭据去问
  (function renderAnonList() {
    var box = document.getElementById('anon-list');
    if (!box) return;
    var map = readAnon();
    var ids = Object.keys(map);
    if (ids.length === 0) {
      box.innerHTML = '';
      var empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = '这台浏览器里没有无痕帖的凭据。';
      box.appendChild(empty);
      return;
    }
    var tokens = ids.map(function (id) { return map[id]; }).join(',');
    fetch('/anon/mine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ tokens: tokens }).toString(),
      credentials: 'same-origin'
    })
      .then(function (response) { return response.ok ? response.json() : Promise.reject(); })
      .then(function (data) {
        box.innerHTML = '';
        if (!data.posts.length) {
          var gone = document.createElement('p');
          gone.className = 'empty';
          gone.textContent = '凭据还在，但对应的无痕帖已经删掉或到期了。';
          box.appendChild(gone);
          return;
        }
        data.posts.forEach(function (post) {
          var card = document.createElement('article');
          card.className = 'card';
          var body = document.createElement('div');
          body.className = 'body';
          body.textContent = post.body;
          var actions = document.createElement('div');
          actions.className = 'actions';
          var open = document.createElement('a');
          open.className = 'count';
          open.href = '/p/' + post.id;
          open.textContent = '打开（回应 ' + post.reply_count + '）';
          var remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'danger';
          remove.textContent = '删除';
          remove.addEventListener('click', function () {
            if (!window.confirm('删掉就真的没了（连凭据一起作废），确定吗？')) return;
            remove.disabled = true;
            fetch('/anon/delete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                target_type: 'post',
                target_id: String(post.id),
                anon_token: map[String(post.id)]
              }).toString(),
              credentials: 'same-origin'
            })
              .then(function (response) {
                if (!response.ok) throw new Error('delete failed');
                var next = readAnon();
                delete next[String(post.id)];
                writeAnon(next);
                card.remove();
              })
              .catch(function () {
                remove.disabled = false;
                window.alert('删不掉——刷新页面再试一次。');
              });
          });
          actions.appendChild(open);
          actions.appendChild(remove);
          card.appendChild(body);
          card.appendChild(actions);
          box.appendChild(card);
        });
      })
      .catch(function () {
        box.innerHTML = '';
        var failed = document.createElement('p');
        failed.className = 'empty';
        failed.textContent = '读不出无痕帖，刷新试试。';
        box.appendChild(failed);
      });
  })();

  // 字数提示
  Array.prototype.forEach.call(document.querySelectorAll('textarea[data-counter]'), function (area) {
    var max = Number(area.getAttribute('maxlength') || 0);
    if (!max) return;
    var hint = document.createElement('span');
    hint.className = 'dim';
    hint.style.display = 'block';
    hint.style.textAlign = 'right';
    area.insertAdjacentElement('afterend', hint);
    var update = function () {
      var used = Array.from(area.value).length;
      hint.textContent = used + ' / ' + max;
      hint.style.color = used > max * 0.9 ? 'var(--danger)' : '';
    };
    area.addEventListener('input', update);
    update();
  });

  // 跳到某条回应时，把包着它的折叠块打开
  function openTarget() {
    if (!location.hash) return;
    var node = document.querySelector(location.hash);
    while (node) {
      if (node.tagName === 'DETAILS') node.open = true;
      node = node.parentElement;
    }
  }
  openTarget();
  window.addEventListener('hashchange', openTarget);
})();
