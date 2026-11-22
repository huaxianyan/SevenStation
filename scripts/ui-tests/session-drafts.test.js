// 草稿按会话隔离：在 A 里打的字切到 B 不能跟着走，更不能被当成本地发出去。
const { boot, checker } = require('./boot');

const { window } = boot(`
  window.__hook = function (key) {
    const session = makeSession(key, { isStreaming: false }, [], 'E:/tmp/demo');
    app.byKey.set(key, session);
    return session;
  };
  window.__open = function (id) { openSession({ id, cwd: 'E:/tmp/demo' }); };
  window.__input = el.input;
  window.__state = app;
`);

const { ok, done } = checker();

const input = window.__input;
const state = window.__state;

window.__hook('c-A');
window.__hook('c-B');
window.__open('c-A');

input.value = '这段话是写给 A 的';
input.dispatchEvent(new window.Event('input', { bubbles: true }));
ok(state.drafts.get('c-A') === '这段话是写给 A 的', 'A 里打的字进了 A 的草稿');

window.__open('c-B');
ok(input.value === '', '切到 B 输入框是空的（不带着 A 的话）');

input.value = 'B 的草稿';
input.dispatchEvent(new window.Event('input', { bubbles: true }));
ok(state.drafts.get('c-B') === 'B 的草稿', 'B 有自己的草稿');
ok(state.drafts.get('c-A') === '这段话是写给 A 的', 'A 的草稿还在');

window.__open('c-A');
ok(input.value === '这段话是写给 A 的', '切回 A 草稿回来');

state.drafts.delete('c-A');
input.value = '';
ok(state.drafts.has('c-A') === false, '发出去就销掉草稿');

done();
