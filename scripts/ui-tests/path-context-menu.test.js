// 路径链接的右键菜单：不能再弹浏览器那三项（打开链接 / 另存为 / 复制链接），
// 要给的是「复制路径 / 打开所在目录 / 复制文件」。
const { boot, checker } = require('./boot');

const { window, document } = boot(`
  window.__render = function (text) {
    const session = makeSession('c1', { isStreaming: false }, [
      { role: 'assistant', content: [{ type: 'text', text: text }], timestamp: 1000 },
    ], 'E:/tmp');
    app.byKey.set('c1', session);
    app.currentKey = 'c1';
    renderThread();
    return session;
  };
`);

const { ok, done } = checker();

const menu = () => document.querySelector('.ctx-menu');
const items = () => [...document.querySelectorAll('.ctx-item')].map((node) => node.textContent);

const rightClick = (node) => {
  const event = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 });
  node.dispatchEvent(event);
  return event;
};

const path = String.raw`E:\Dev\SevenStation\README.md`;
window.__render('文件在 ' + path + ' 里。');

const link = document.querySelector('.link-path');
ok(Boolean(link), '正文里的路径被认成可点链接');
ok(link.dataset.path === path, '链接上带着完整路径');

// 没装壳（浏览器里）：只剩打开与复制路径
const first = rightClick(link);
ok(first.defaultPrevented, '右键被拦下来，浏览器那三项不会出现');
ok(Boolean(menu()), '弹的是我们自己的菜单');
ok(JSON.stringify(items()) === JSON.stringify(['打开', '复制路径']), '浏览器里只有两项：' + items().join(','));

// 点别处关掉
document.body.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
ok(menu() === null, '点别处就收起来');

// Esc 也收
rightClick(link);
document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
ok(menu() === null, 'Esc 收起来');

// 装了壳：多出「打开所在目录」「复制文件」，并且真的调壳
const calls = [];
window.__TAURI__ = { core: { invoke: (command, args) => { calls.push([command, args]); return Promise.resolve(); } } };

rightClick(link);
ok(
  JSON.stringify(items()) === JSON.stringify(['打开', '打开所在目录', '复制路径', '复制文件']),
  '壳里四项：' + items().join(','),
);

const copyFile = [...document.querySelectorAll('.ctx-item')].find((node) => node.textContent === '复制文件');
copyFile.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
ok(menu() === null, '点完菜单就收起来');
ok(calls.length === 1 && calls[0][0] === 'copy_file', '调的是 copy_file：' + JSON.stringify(calls[0]));
ok(calls[0] && calls[0][1].path === path, '传的是完整路径');

rightClick(link);
const reveal = [...document.querySelectorAll('.ctx-item')].find((node) => node.textContent === '打开所在目录');
reveal.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
ok(calls.length === 2 && calls[1][0] === 'reveal_in_explorer', '调的是 reveal_in_explorer');

// 网址链接的右键菜单不动（系统那套对网址是有用的）
window.__render('看 https://github.com/huaxianyan/SevenStation 这个仓库。');
const outLink = document.querySelector('.md a[href]');
const outEvent = rightClick(outLink);
ok(outEvent.defaultPrevented === false, '网址链接保留浏览器默认菜单');
ok(menu() === null, '网址链接不弹我们的菜单');

done();
