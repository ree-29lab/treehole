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
