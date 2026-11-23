// 输入框旁的上下文圆环：比例要画对，数字要读得出来（手机没有悬停，点一下也要有）。
const { boot, checker } = require('./boot');

const { document, window } = boot(`
  window.__session = function (usage) {
    const session = makeSession('c-ctx', { isStreaming: false }, [], 'E:/Dev/SevenStation');
    session.stats = usage ? { contextUsage: usage } : {};
    app.byKey.set('c-ctx', session);
    app.currentKey = 'c-ctx';
    return session;
  };
  window.__render = renderContext;
  window.__toasts = [];
`);

const { ok, done } = checker();

const ring = document.getElementById('ctxRing');
const fill = document.getElementById('ctxRingFill');
const length = 2 * Math.PI * 7.4; // 跟 circle 的 r=7.4 对应

// 没有数据时两个都不显示。
window.__session(null);
window.__render();
ok(ring.hidden, '没有用量数据时圆环不出现');
ok(document.getElementById('ctxUsage').hidden, '顶栏那行小字也不出现');

// 18.5%
window.__session({ percent: 18.5, tokens: 185000, contextWindow: 1000000 });
window.__render();
ok(!ring.hidden, '有数据时圆环出现');
ok(Math.abs(Number(fill.style.strokeDasharray) - length) < 0.01, '一周的长度按半径算对：' + fill.style.strokeDasharray);
const expected = length * (1 - 0.185);
ok(Math.abs(Number(fill.style.strokeDashoffset) - expected) < 0.05, '已用 18.5% 时留出一圈空白：' + fill.style.strokeDashoffset);
ok(ring.dataset.level === 'normal', '平时不换警示色');
ok(ring.title.includes('18.5%') && ring.title.includes('185k/1000k'), '悬停提示里有具体数值：' + ring.title);
ok(ring.getAttribute('aria-label').includes('18.5%'), '读屏标签里也有数值');
ok(document.getElementById('ctxUsage').textContent === '18.5% · 185k/1000k', '顶栏小字保留精确值');

// 快到上限换色。
window.__session({ percent: 92, tokens: 920000, contextWindow: 1000000 });
window.__render();
ok(ring.dataset.level === 'high', '92% 时换成警示色');
ok(Math.abs(Number(fill.style.strokeDashoffset) - length * 0.08) < 0.05, '92% 时只剩一小段空');

// 超过 100% 别画出负长度。
window.__session({ percent: 130, tokens: 1300000, contextWindow: 1000000 });
window.__render();
ok(Number(fill.style.strokeDashoffset) === 0, '超过上限时按满圈画：' + fill.style.strokeDashoffset);

// 点一下能读出数值（手机没有悬停）。
window.__session({ percent: 18.5, tokens: 185000, contextWindow: 1000000 });
window.__render();
ring.click();
const text = [...document.querySelectorAll('#toasts .toast')].map((node) => node.textContent).join(' | ');
ok(text.includes('18.5%') && text.includes('185k / 1000k'), '点击弹出具体数值：' + text);

done();
