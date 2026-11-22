// 设置页里一张卡片画崩了，不能把后面的卡片一起带走。
// 2026-11-23 出过一次：运行时卡片里引用错一个函数，结果它往后的设置全没了，界面也没提示。
const { boot, checker } = require('./boot');

const { document, window } = boot(`
  window.__render = function () { renderPage('settings'); };
  // 函数声明在脚本作用域里，改 window 上的同名属性没有用，得直接改这个绑定。
  window.__errors = [];
  console.error = function (...args) { window.__errors.push(args.join(' ')); };
  window.__break = function () { renderRuntimeCard = function () { throw new Error('故意画崩'); }; };
`);

const { ok, done } = checker();

window.__render();
ok(Boolean(document.getElementById('runtimeCard')), '正常时「运行时」卡片在');
ok(document.body.textContent.includes('Seven Station Core'), '「连接」卡片也在');

// 让运行时那张卡片抛异常，其它的照画。
window.__break('renderRuntimeCard');
window.__render();

ok(!document.getElementById('runtimeCard'), '画崩的那张卡片不在（预期）');
ok(document.body.textContent.includes('Seven Station Core'), '崩了之后「连接」卡片还在');
ok(document.body.textContent.includes('最近工作区'), '后面的卡片也照画');
ok(window.__errors.some((line) => line.includes('没画出来')), '控制台里留了一行原因：' + window.__errors.join(' / '));

done();
