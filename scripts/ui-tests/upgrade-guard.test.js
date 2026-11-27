// 有对话在跑的时候点升级：先问一句，确认后才带 stopRunning 发出去。
const { boot, checker } = require('./boot');

const { window } = boot(`
  window.__sent = [];
  const rawSend = send;
  send = function (payload) {
    window.__sent.push(payload);
    return rawSend(payload);
  };
  window.__reset = () => { window.__sent.length = 0; };
  window.__list = (items) => dispatch({ type: 'conversation_list', items: items });
  window.__upgrade = () => requestUpgrade();
  window.__modalOpen = () => !document.getElementById('modal').hidden;
  window.__modalText = () => (document.getElementById('modal').textContent || '').replace(/\\s+/g, ' ');
  window.__modalButtons = () => Array.from(document.querySelectorAll('#modal button')).map((b) => b.textContent);
  window.__clickModal = (text) => {
    const node = Array.from(document.querySelectorAll('#modal button')).find((b) => b.textContent === text);
    if (node) node.click();
    return Boolean(node);
  };
  window.__upgradeReqs = () => window.__sent.filter((m) => m.type === 'upgrade_pi');
`);

const { ok, done } = checker();
const list = window.__list;
const upgrade = window.__upgrade;

// 1. 没有对话在跑：直接发，不带 stopRunning
window.__reset();
list([{ id: 'c-a', title: '甲', working: false }]);
upgrade();
let reqs = window.__upgradeReqs();
ok(reqs.length === 1 && reqs[0].stopRunning === undefined, '空闲时直接升级：' + JSON.stringify(reqs));
ok(!window.__modalOpen(), '不弹窗');

// 2. 有对话在跑：先弹窗，什么也不发
window.__reset();
list([
  { id: 'c-a', title: '甲', working: true },
  { id: 'c-b', title: '乙', working: false },
]);
upgrade();
ok(window.__modalOpen(), '有对话在跑时弹确认');
ok(window.__upgradeReqs().length === 0, '确认之前不发升级请求');
const buttons = window.__modalButtons();
ok(buttons.includes('停下并升级') && buttons.includes('等它跑完'), '两个选择都在：' + JSON.stringify(buttons));
ok(window.__modalText().includes('甲'), '说明里指名是哪个对话：' + window.__modalText().slice(0, 60));

// 3. 选「等它跑完」：什么都不发生
window.__reset();
ok(window.__clickModal('等它跑完'), '能找到取消按钮');
ok(!window.__modalOpen(), '取消后关窗');
ok(window.__upgradeReqs().length === 0, '取消就不升级');

// 4. 选「停下并升级」：带上 stopRunning
window.__reset();
upgrade();
ok(window.__clickModal('停下并升级'), '能找到确认按钮');
reqs = window.__upgradeReqs();
ok(reqs.length === 1 && reqs[0].stopRunning === true, '确认后要求先停再升：' + JSON.stringify(reqs));
ok(!window.__modalOpen(), '确认后关窗');

// 5. 多个在跑：都写进说明，别只提一个
window.__reset();
list([
  { id: 'c-a', title: '甲', working: true },
  { id: 'c-b', title: '乙', working: true },
  { id: 'c-c', title: '丙', working: true },
]);
upgrade();
const text = window.__modalText();
ok(text.includes('甲') && text.includes('乙') && text.includes('3 个对话'), '说清有几个在跑：' + text.slice(0, 80));

done();
