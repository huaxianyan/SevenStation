// 卡住的时候界面要看得出来：光「工作 8 小时」分不清是在跑还是在等。
const { boot, checker } = require('./boot');

const { window } = boot(`
  window.__hint = () => document.getElementById('hint').textContent;
  window.__paint = paintWorkHint;
  window.__session = (key) => {
    const session = makeSession(key, { isStreaming: true }, [], 'E:/Dev/SevenStation');
    session.items = [{ kind: 'user', id: 'u1', text: '干点活', ts: Date.now() - 30620000 }];
    app.byKey.set(key, session);
    app.currentKey = key;
    return session;
  };
  window.__quiet = (key, ms) => { app.lastEventAt.set(key, Date.now() - ms); };
  window.__touch = (key) => touchSession(key);
`);

const { ok, done } = checker();
window.__session('c-quiet');

// 一直在动：只说时长
window.__quiet('c-quiet', 2000);
window.__paint();
ok(window.__hint() === '工作 8 小时 30 分 · Enter 排队', '刚有动静：只报时长');

// 3 分钟没动静
window.__quiet('c-quiet', 3 * 60 * 1000 + 5000);
window.__paint();
const quiet = window.__hint();
ok(quiet.indexOf('3 分 5 秒没动静') >= 0, '3 分钟没动静要说出来：' + quiet);
ok(quiet.indexOf('可能卡住') === -1, '3 分钟还不下结论');

// 10 分钟没动静
window.__quiet('c-quiet', 11 * 60 * 1000);
window.__paint();
const stuck = window.__hint();
ok(stuck.indexOf('11 分没动静') >= 0, '还是一直报时长：' + stuck);
ok(stuck.indexOf('可能卡住了') >= 0, '10 分钟以上明说可能卡住：' + stuck);

// 又来动静了就恢复
window.__touch('c-quiet');
window.__paint();
ok(window.__hint() === '工作 8 小时 30 分 · Enter 排队', '有动静之后恢复平常的样子');

// 从没收到过事件的会话（刚建的）不该立刻报没动静
window.__session('c-fresh');
window.__paint();
ok(window.__hint().indexOf('没动静') === -1, '刚开的会话不算没动静：' + window.__hint());

done();
