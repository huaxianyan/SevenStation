// 按了停止之后的提示：别再往上报「工作 8 小时 30 分」，那看着像没停。
const { boot, checker } = require('./boot');

const { window, document } = boot(`
  window.__hint = () => document.getElementById('hint');
  window.__paint = paintWorkHint;
  window.__stopPending = (key) => { stopPending = key ? { key } : null; };
  window.__session = (key) => {
    const session = makeSession(key, { isStreaming: true }, [], 'E:/Dev/SevenStation');
    session.items = [{ kind: 'user', id: 'u1', text: '干点活', ts: Date.now() - 30620000 }];
    app.byKey.set(key, session);
    app.currentKey = key;
    return session;
  };
`);

const { ok, done } = checker();
const hint = window.__hint();

window.__session('c-stop');
window.__paint();
ok(hint.textContent === '工作 8 小时 30 分 · Enter 排队', '平时报时长（换算过）：' + hint.textContent);

window.__stopPending('c-stop');
window.__paint();
ok(hint.textContent === '正在停止 · 等 Pi 收尾', '按了停止就不再报秒数：' + hint.textContent);
ok(!/\d/.test(hint.textContent), '停止中的提示里没有数字');

window.__stopPending('c-other');
window.__paint();
ok(hint.textContent.includes('8 小时 30 分'), '别的会话在停，不挡这个会话的时长');

window.__stopPending(null);
window.__paint();
ok(hint.textContent === '工作 8 小时 30 分 · Enter 排队', '收尾之后回到正常提示');

done();
