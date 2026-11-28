// 发完一句话，侧栏要回到顶部：刚发的对话被顶到最前，别让用户自己滚回去。
const { boot, checker } = require('./boot');

const { window } = boot(`
  window.__top = 500;   // 假装用户已经翻到下面去了
  const list = document.getElementById('sessionList');
  Object.defineProperty(list, 'scrollTop', {
    configurable: true,
    get: () => window.__top,
    set: (value) => { window.__top = value; },
  });

  window.__sent = [];
  send = (message) => window.__sent.push(message);

  window.__seed = () => {
    onSessionState({
      type: 'session_state',
      key: 'c-t',
      cwd: 'E:/Dev/SevenStation',
      state: { sessionName: '侧栏置顶' },
      messages: [],
    });
    app.currentKey = 'c-t';
    app.sessions = [
      { id: 'old', title: '很老的对话', cwd: 'E:/Dev/SevenStation', updatedAt: Date.now() - 86400000 },
      { id: 'c-t', title: '侧栏置顶', cwd: 'E:/Dev/SevenStation', updatedAt: Date.now() },
    ];
    renderSessionList();
  };

  window.__type = (text) => {
    document.getElementById('input').value = text;
    submitPrompt();
  };
  window.__list = (items) => dispatch({ type: 'conversation_list', items: items });
  window.__top_ = () => window.__top;
  window.__pending = () => app.pendingListTop;
`);

const { ok, done } = checker();

window.__seed();
ok(window.__top_() === 500, '先让侧栏停在下面：' + window.__top_());

// 1. 发一句话：侧栏立刻回到顶部
window.__type('继续');
ok(window.__top_() === 0, '发送后侧栏回到顶部：' + window.__top_());
ok(window.__pending() === true, '记住了「这次要回顶」，等列表重建后再补一次');

// 2. 列表回来（重建）后仍然是顶部，标记清掉
window.__top = 380;
window.__list([
  { id: 'c-t', title: '侧栏置顶', cwd: 'E:/Dev/SevenStation', updatedAt: Date.now() },
  { id: 'old', title: '很老的对话', cwd: 'E:/Dev/SevenStation', updatedAt: Date.now() - 86400000 },
]);
ok(window.__top_() === 0, '列表重建后还在顶部：' + window.__top_());
ok(window.__pending() === false, '标记用一次就清掉');

// 3. 之后列表再刷新（比如别的设备发消息）不该抢用户的滚动位置
window.__top = 320;
window.__list([
  { id: 'c-t', title: '侧栏置顶', cwd: 'E:/Dev/SevenStation', updatedAt: Date.now() },
  { id: 'old', title: '很老的对话', cwd: 'E:/Dev/SevenStation', updatedAt: Date.now() - 86400000 },
]);
ok(window.__top_() === 320, '没发消息时不动用户的滚动位置：' + window.__top_());

done();
