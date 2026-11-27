// 会话列表那一格时间：在跑就说「工作中」，其余自己会走。
const { boot, checker } = require('./boot');

const { window, document } = boot(`
  window.__list = (items) => { app.sessions = items; renderSessionList(); };
  window.__tick = () => refreshSessionTimes();
  window.__timeTexts = () => [...document.querySelectorAll('.session-item')].map((item) => ({
    name: item.querySelector('.name').textContent,
    time: item.querySelector('.time').textContent,
    working: Boolean(item.querySelector('.session-spin')),
  }));
`);

const { ok, done } = checker();
const now = Date.now();

window.__list([
  { id: 'c-run', title: '正在跑', cwd: 'E:/Dev/SevenStation', updatedAt: now - 12 * 60 * 1000, working: true, status: 'ready' },
  { id: 'c-idle', title: '别的会话', cwd: 'E:/Dev/Android', updatedAt: now - 12 * 60 * 1000, working: false, status: 'ready' },
]);

let rows = window.__timeTexts();
ok(rows.length === 2, '两条会话：' + rows.length);
ok(rows[0].working && rows[0].time === '工作中', '在跑的那条写「工作中」：' + rows[0].time);
ok(rows[1].time === '12 分钟前', '没在跑的那条写时间：' + rows[1].time);

// 把它改成更早的时间，模拟时间流逝；定时器只该动没在跑的那条
const timeNodes = [...document.querySelectorAll('.time[data-at]')];
timeNodes[1].dataset.at = String(now - 45 * 60 * 1000);
window.__tick();
rows = window.__timeTexts();
ok(rows[1].time === '45 分钟前', '时间自己会走：' + rows[1].time);
ok(rows[0].time === '工作中', '工作在跑的那条不被时间盖掉：' + rows[0].time);

// 一轮结束：列表重画成没有 working 的样子
window.__list([
  { id: 'c-run', title: '正在跑', cwd: 'E:/Dev/SevenStation', updatedAt: Date.now(), working: false, status: 'ready' },
]);
rows = window.__timeTexts();
ok(rows[0].time === '刚刚', '跑完变「刚刚」：' + rows[0].time);

done();
