// 一轮跑完：壳在的时候请它弹系统通知；浏览器里、或者用户自己按的停止，不打扰。
const { boot, checker } = require('./boot');

const { window } = boot(`
  window.__log = [];
  window.__shell = (on) => {
    if (!on) {
      delete window.__TAURI__;
      return;
    }
    window.__TAURI__ = {
      core: {
        invoke: (cmd, args) => {
          window.__log.push({ cmd: cmd, args: args });
          return Promise.resolve(true);
        },
      },
    };
  };
  window.__open = () => onSessionState({
    type: 'session_state',
    key: 'c-n',
    cwd: 'E:/Dev/SevenStation',
    state: { sessionName: 'SevenStation 项目开发' },
    messages: [],
  });
  window.__lastReply = (text) => {
    const session = app.byKey.get('c-n');
    session.items.push({ id: 'a1', kind: 'assistant', blocks: [{ type: 'text', text: text }], streaming: false });
  };
  window.__fire = (aborted) => dispatch({
    type: 'event',
    key: 'c-n',
    event: { type: 'agent_settled', aborted: aborted === true },
  });
  window.__calls = () => window.__log.slice();
  window.__reset = () => { window.__log.length = 0; };
`);

const { ok, done } = checker();

window.__open();
window.__lastReply('  改好了，两个包都构建成功。  ');

// 1. 有壳：跑完就请壳弹通知
window.__shell(true);
window.__reset();
window.__fire(false);
const calls = window.__calls();
const notify = calls.find((item) => item.cmd === 'notify_done');
ok(Boolean(notify), '调了壳的 notify_done：' + JSON.stringify(calls.map((c) => c.cmd)));
ok(notify && notify.args.title === '「SevenStation 项目开发」这一轮完成了', '标题带对话名：' + (notify && notify.args.title));
ok(notify && notify.args.body === '改好了，两个包都构建成功。', '正文是最后一条回答的开头：' + (notify && notify.args.body));

// 2. 用户自己按的停止：不提醒
window.__reset();
window.__fire(true);
ok(!window.__calls().some((item) => item.cmd === 'notify_done'), '停止不弹通知');

// 3. 浏览器里（没有壳）：跳过，不报错
window.__shell(false);
window.__reset();
let threw = false;
try {
  window.__fire(false);
} catch (error) {
  threw = true;
}
ok(!threw, '没有壳时不会抛错');
ok(window.__calls().length === 0, '没有壳时不调任何命令');

// 4. 没有回答正文时给一句兜底，不留空通知
window.__shell(true);
window.__reset();
window.__open();
window.__fire(false);
const second = window.__calls().find((item) => item.cmd === 'notify_done');
ok(second && second.args.body === '发一句话接着聊。', '没有正文时用兜底文案：' + (second && second.args.body));
ok(second && second.args.title === '「SevenStation 项目开发」这一轮完成了', '标题照旧带对话名');

done();
