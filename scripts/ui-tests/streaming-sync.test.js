// 侧栏「工作中」与对话里的停止键必须一致。
// Core 重启（装包就是）会把还在跑的那一轮带走，界面却还挂着「正在跑」——两处就对不上。
const { boot, checker } = require('./boot');

const { window } = boot(`
  window.__open = (key, streaming) => onSessionState({
    type: 'session_state',
    key,
    cwd: 'E:/Dev/SevenStation',
    state: { sessionName: '某条会话', isStreaming: streaming },
    messages: [],
  });
  window.__list = (items) => dispatch({ type: 'conversation_list', items: items });
  window.__get = (key) => app.byKey.get(key);
  window.__drop = () => dropStaleStreaming();
`);

const { ok, done } = checker();
const open = window.__open;
const list = window.__list;
const get = window.__get;

// 1. 本地以为在跑，Core 说不跑：跟着 Core 走（这就是「侧栏不转、对话还在转」那个不一致）
open('c-a', true);
ok(get('c-a').streaming === true, '先按 Core 给的 isStreaming=true 建出来');
list([{ id: 'c-a', title: 'A', working: false }]);
ok(get('c-a').streaming === false, 'Core 说没在跑，界面也放掉：' + get('c-a').streaming);

// 2. Core 说在跑：立刻跟上（这次 Core 认领比界面晚）
open('c-b', false);
list([{ id: 'c-b', title: 'B', working: true }]);
ok(get('c-b').streaming === true, 'Core 说在跑，界面也认：' + get('c-b').streaming);

// 3. 刚发出去、Core 还没认领：不能被打回空闲
open('c-c', true);
get('c-c').sentAt = Date.now();
list([{ id: 'c-c', title: 'C', working: false }]);
ok(get('c-c').streaming === true, '刚发出去的那条不给打回空闲');

// 4. 有还没被确认的气泡时同样不动
open('c-d', true);
get('c-d').items.push({ id: 'echo1', kind: 'user', text: 'hi', echo: true, state: 'sending' });
list([{ id: 'c-d', title: 'D', working: false }]);
ok(get('c-d').streaming === true, '气泡还在转圈时不判空闲');

// 5. 连接刚接上：本地挂着的「正在跑」一律放掉
open('c-e', true);
window.__drop();
ok(get('c-e').streaming === false, '重连后本地不复用旧的「正在跑」');

// 6. 列表里没有的会话不受影响（还没见过的会话本来就不在缓存里）
list([{ id: 'c-unknown', title: '没人打开过', working: true }]);
ok(get('c-unknown') === undefined, '没打开过的会话不会凭空建出来');

done();
