// 第一次打开一条不在缓存里的对话，也要立刻问一次 git 状态。
// （以前只在「缓存里已有这条会话」那条路径问，所以要点开、切走、再切回来才看到分支胶囊。）
const { boot, checker } = require('./boot');

const { window } = boot(`
  window.__sent = [];
  const rawSend = send;
  send = function (payload) {
    window.__sent.push(payload);
    return rawSend(payload);
  };
  window.__reset = () => { window.__sent.length = 0; };
  window.__openFirst = (key = 'c-first', cwd = 'E:/Dev/SevenStation') => onSessionState({
    type: 'session_state',
    key,
    cwd,
    state: { sessionName: '第一次打开' },
    messages: [],
  });
`);

const { ok, done } = checker();
const sent = () => window.__sent.filter((m) => m.type === 'git_status');

window.__reset();
window.__openFirst();
ok(sent().length === 1, '第一次打开就问了一次 git 状态：' + sent().length);
ok(sent()[0] && sent()[0].key === 'c-first', '问的是这条会话：' + (sent()[0] && sent()[0].key));

// 同一条会话再来一次状态推送：节流挡住，别每次重连都去敲 git
window.__reset();
window.__openFirst();
ok(sent().length === 0, '同一条会话 20 秒内不重复问');

// 换一条会话：立刻问新的那条
window.__reset();
window.__openFirst();
window.__openFirst('c-second', 'E:/Dev/Android');
ok(sent().length === 1 && sent()[0].key === 'c-second', '换会话会重新问：' + JSON.stringify(sent()[0]));

done();
