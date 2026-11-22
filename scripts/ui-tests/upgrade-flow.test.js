// 升级：开始一张卡片转圈，结束原地换字——不弹第二个；重复点也不会重复发。
const { boot, checker } = require('./boot');

const { document, window } = boot(`
  // jsdom 没有 Web Animations，换字时的过渡直接跳过。
  Element.prototype.animate = function () { return { onfinish: null, cancel() {} }; };
  window.__sent = [];
  send = (message) => window.__sent.push(message);
  window.__dispatch = dispatch;
  window.__requestUpgrade = requestUpgrade;
`);

const { ok, done } = checker();

const toasts = () => [...document.querySelectorAll('#toasts .toast')];
const strip = () => document.getElementById('updStrip');
const upgradeButton = () => document.getElementById('updGo');

const payload = {
  type: 'updates',
  checkedAt: '2026-11-22T16:00:00.000Z',
  pi: { name: 'Pi', installed: '1.5.2', latest: '1.6.0', hasUpdate: true },
  packages: [{ name: 'TokenEconomizer', installed: '4a04fe4', latest: '1bfeccd', hasUpdate: true }],
};

window.__dispatch(payload);
ok(!strip().hidden, '有新版时提示条在');
ok(upgradeButton().textContent === '升级', '提示条上是「升级」而不是「查看」');

upgradeButton().click();
ok(window.__sent.length === 1 && window.__sent[0].type === 'upgrade_pi', '点了就发 upgrade_pi');
ok(upgradeButton().disabled, '升级期间按钮按住，防止重复点');

window.__dispatch({ type: 'update_job', state: 'running', target: 'Pi', from: '1.5.2', to: '1.6.0' });
ok(toasts().length === 1, '开始升级只出现一张卡片');
ok(toasts()[0].classList.contains('is-busy'), '这张卡片带转圈');
ok(toasts()[0].textContent.includes('1.5.2 → 1.6.0'), '卡片上写着从哪个版本到哪个版本：' + toasts()[0].textContent);

// Pi 升完接着升扩展：还是同一张卡片。
window.__dispatch({ type: 'update_job', state: 'running', target: 'extensions' });
ok(toasts().length === 1, '第二阶段不另开一张卡片');
ok(toasts()[0].textContent.includes('扩展'), '卡片换成「正在更新扩展」：' + toasts()[0].textContent);

// 升完：原地换字，转圈收掉。
window.__dispatch({ type: 'update_job', state: 'done', text: 'Pi 已升级到 1.6.0，1 个扩展也更新好了' });
ok(toasts().length === 1, '结束时还是那一张卡片');
ok(!toasts()[0].classList.contains('is-busy'), '结束时转圈收掉');
ok(toasts()[0].textContent === 'Pi 已升级到 1.6.0，1 个扩展也更新好了', '卡片上写的是结果');
ok(!upgradeButton().disabled, '升级结束后按钮恢复');

// 失败：同一张卡片翻成红字，并说清楚还在原来那个版本。
window.__requestUpgrade();
window.__dispatch({ type: 'update_job', state: 'running', target: 'Pi', from: '1.5.2', to: '1.6.0' });
window.__dispatch({ type: 'update_job', state: 'failed', text: '升级没成功：装不上，还在 1.5.2' });
const failed = toasts().filter((node) => node.classList.contains('error'));
ok(failed.length === 1, '失败时卡片标成错误态');
ok(failed[0].textContent.includes('还在 1.5.2'), '失败文案说清还在哪个版本：' + failed[0].textContent);

// 被拒绝（比如有对话在跑）时没有进行中的卡片，直接来一条提示。
const before = toasts().length;
window.__dispatch({ type: 'update_job', state: 'failed', text: '现在有对话正在跑，等它结束再升级' });
ok(toasts().length === before + 1, '没有进行中卡片时，失败照样出一条提示');

done();
