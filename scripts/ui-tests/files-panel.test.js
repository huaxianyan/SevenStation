// 文件面板头部：关闭在最左、向上挨着它（一组），路径是可以点的面包屑。
const { boot, checker } = require('./boot');

const { window } = boot(`
  window.__sent = [];
  const rawSend = send;
  send = function (payload) {
    window.__sent.push(payload);
    return rawSend(payload);
  };
  window.__reset = () => { window.__sent.length = 0; };
  window.__open = () => onSessionState({
    type: 'session_state',
    key: 'c-files',
    cwd: 'E:/Dev/SevenStation',
    state: { sessionName: '文件面板' },
    messages: [],
  });
  window.__paint = (path) => paintFilesPath(path);
  window.__up = () => document.getElementById('filesUp').click();
  window.__crumbs = () => Array.from(document.querySelectorAll('#filesPath .files-crumb:not(.sep)'))
    .map((node) => node.textContent);
  window.__crumbClick = (text) => {
    const node = Array.from(document.querySelectorAll('#filesPath .files-crumb:not(.sep)'))
      .find((item) => item.textContent === text);
    if (node) node.click();
    return Boolean(node);
  };
  window.__dirReqs = () => window.__sent.filter((m) => m.type === 'list_dir');
`);

const { ok, done } = checker();
const doc = window.document;
const $ = (id) => doc.getElementById(id);

// 1. 头部顺序：关闭在最左、向上挨着，两个都在同一组里
const head = doc.querySelector('.files-head');
const nav = head.querySelector('.files-nav');
ok(Boolean(nav), '头部有一组按钮容器');
const buttons = Array.from(nav.querySelectorAll('button')).map((node) => node.id);
ok(buttons[0] === 'filesClose' && buttons[1] === 'filesUp', '关闭在前、向上在后：' + JSON.stringify(buttons));
ok(doc.getElementById('filesPath').previousElementSibling === nav, '路径在这组按钮后面');

// 2. 面包屑按「/」分段，末段是当前
window.__open();
window.__paint('src/SevenStation.Core/wwwroot');
ok(JSON.stringify(window.__crumbs()) === JSON.stringify(['/', 'src', 'SevenStation.Core', 'wwwroot']),
  '路径分成四段：' + JSON.stringify(window.__crumbs()));
const last = Array.from(doc.querySelectorAll('#filesPath .files-crumb')).pop();
ok(last.classList.contains('current'), '末段标成当前目录');
ok($('filesUp').disabled === false, '不在最上层时向上可点');

// 3. 点中间那段：直接回到那一级，并且真的去列目录
window.__reset();
ok(window.__crumbClick('src'), '能找到 src 这一段');
const reqs = window.__dirReqs();
ok(reqs.length === 1 && reqs[0].path === 'src', '点 src 就列 src：' + JSON.stringify(reqs));

// 4. 向上只退一级
window.__reset();
window.__paint('src/SevenStation.Core');
window.__up();
const up = window.__dirReqs();
ok(up.length === 1 && up[0].path === 'src', '向上退一级：' + JSON.stringify(up));

// 5. 已经在工作区根：向上灰掉，点了也不动
window.__reset();
window.__paint('');
ok($('filesUp').disabled === true, '根目录时向上禁用');
window.__up();
ok(window.__dirReqs().length === 0, '禁用状态下点了不发请求');
ok(JSON.stringify(window.__crumbs()) === JSON.stringify(['/']), '根目录只有一段 /');

// 6. 从根点回某一级还是通的
window.__reset();
ok(window.__crumbClick('/'), '根那一段可点');
ok(window.__dirReqs().length === 1 && window.__dirReqs()[0].path === '', '点 / 列出工作区根');

done();
