// 更新提示：有新版才露，点在「稍后」只管这一次打开，没有更新就完全不出声。
const { boot, checker } = require('./boot');

const { document, window } = boot(`
  window.__dispatch = dispatch;
  window.__switchView = switchView;
  window.__undismiss = function () { app.updDismissed = false; };
`);

const { ok, done } = checker();

const strip = () => document.getElementById('updStrip');
const text = () => document.getElementById('updText').textContent;
const navIcon = () => document.getElementById('extensionsUpdate').hidden;
const button = (id) => document.getElementById(id);

const piUpdate = {
  type: 'updates',
  checkedAt: '2026-11-22T16:00:00.000Z',
  pi: { name: 'Pi', installed: '1.5.2', latest: '1.6.0', hasUpdate: true, pinned: false, error: '' },
  packages: [
    { name: 'pi-btw', installed: '0.8.1', latest: '0.8.1', hasUpdate: false },
    { name: 'TokenEconomizer', installed: '4a04fe4', latest: '1bfeccd', hasUpdate: true },
  ],
};

// 一开始什么都没有：不露提示条，也不露侧栏图标。
ok(strip().hidden, '还没查过的时候不露提示条');
ok(navIcon(), '还没查过的时候侧栏没有标记');

// 有新版：一条提示条，说人话，不用内部术语。
window.__dispatch(piUpdate);
ok(!strip().hidden, '查到 Pi 有新版就露出来');
ok(text().includes('1.5.2 → 1.6.0'), '提示条里写着从哪个版本到哪个版本：' + text());
ok(text().includes('1 个扩展'), '顺带说清还有几个扩展：' + text());
ok(!/冒烟|registry|PATH|semver/.test(text()), '提示条里不出现内部术语');
ok(!navIcon(), '侧栏「扩展」前面出现升级标记');

// 「稍后」只压住这一次打开，侧栏那个标记还在（它说的是事实）。
button('updLater').click();
ok(strip().hidden, '点「稍后」提示条收起来');
window.__dispatch(piUpdate);
ok(strip().hidden, '同一轮里再收到推送也不再弹');
ok(!navIcon(), '侧栏标记不受「稍后」影响');

// 全是最新：什么都不露。
window.__dispatch({
  type: 'updates',
  checkedAt: '2026-11-22T17:00:00.000Z',
  pi: { installed: '1.6.0', latest: '1.6.0', hasUpdate: false },
  packages: [{ name: 'pi-btw', installed: '0.8.1', latest: '0.8.1', hasUpdate: false }],
});
ok(navIcon(), '都没更新时侧栏标记收起来');

// 只有扩展有更新：不提 Pi。（换一轮：重开客户端，「稍后」就不再管用）
window.__undismiss();
window.__dispatch({
  type: 'updates',
  checkedAt: '2026-11-22T18:00:00.000Z',
  pi: { installed: '1.6.0', latest: '1.6.0', hasUpdate: false },
  packages: [
    { name: 'a', installed: '1.0.0', latest: '1.1.0', hasUpdate: true },
    { name: 'b', installed: '2.0.0', latest: '3.0.0', hasUpdate: true },
  ],
});
ok(text() === '2 个扩展有新版本', '只有扩展有更新时只说扩展：' + text());
ok(!navIcon(), '侧栏标记亮着');

// 设置页的运行时卡片：版本、徽标、可更新清单。
window.__switchView('settings');
const card = document.getElementById('runtimeCard');
ok(Boolean(card), '设置页里有「运行时」卡片');
const cardText = card.textContent;
ok(cardText.includes('1.6.0'), '卡片里写着装着的 Pi 版本');
const piRow = [...card.querySelectorAll('.kv-row')].find((row) => row.querySelector('.kv-key').textContent === 'Pi');
ok(!piRow.querySelector('.upd-badge'), 'Pi 是最新时不挂「有新版」徽标');
const rows = [...card.querySelectorAll('.upd-detail-row')].map((row) => row.textContent);
ok(rows.length === 2, '可更新的扩展逐条列出来：' + rows.join(' | '));
ok(rows.some((line) => line.includes('1.0.0') && line.includes('1.1.0')), '清单里带着版本对');
const check = [...card.querySelectorAll('button')].find((node) => node.textContent.includes('检查'));
ok(Boolean(check), '卡片上有个「检查更新」');

done();
