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
  window.__open = (name) => onSessionState({
    type: 'session_state',
    key: 'c-n',
    cwd: 'E:/Dev/SevenStation',
    state: { sessionName: name },
    messages: [],
  });
  window.__fire = (aborted) => dispatch({
    type: 'event',
    key: 'c-n',
    event: { type: 'agent_settled', aborted: aborted === true },
  });
  window.__calls = () => window.__log.slice();
  window.__reset = () => { window.__log.length = 0; };
  window.__notify = () => window.__log.find((item) => item.cmd === 'notify_done');
`);

const { ok, done } = checker();

// 1. 有壳：标题讲清了发生什么，正文说是哪个对话
window.__shell(true);
window.__open('SevenStation 项目开发');
window.__reset();
window.__fire(false);
let notify = window.__notify();
ok(Boolean(notify), '调了壳的 notify_done');
ok(notify && notify.args.title === '工作完成', '标题是通用的：' + (notify && notify.args.title));
ok(
  notify && notify.args.body === '「SevenStation 项目开发」的任务已完成。',
  '正文只说哪个对话：' + (notify && notify.args.body),
);

// 2. 不再把回答内容塞进通知
ok(notify && !Object.keys(notify.args).includes('text'), '通知里没有回答正文这一项');
ok(notify && notify.args.body.length < 40, '正文是一句话，不随回答变长：' + (notify && notify.args.body.length));

// 3. 用户自己按的停止：不提醒
window.__reset();
window.__fire(true);
ok(!window.__calls().some((item) => item.cmd === 'notify_done'), '停止不弹通知');

// 4. 浏览器里（没有壳）：跳过，不报错
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

// 5. 还没起名的对话：有个像样的兜底
window.__shell(true);
window.__open('');
window.__reset();
window.__fire(false);
notify = window.__notify();
ok(notify && notify.args.body === '「新对话」的任务已完成。', '没有名字时用「新对话」：' + (notify && notify.args.body));

// 6. 超长名字：截断，别把正文挤成两三行
const longName = '这是一个特别特别长的对话名字用来测试截断会不会把正文撑成两行以上';
window.__open(longName);
window.__reset();
window.__fire(false);
notify = window.__notify();
const expected = '「' + longName.slice(0, 24) + '…」的任务已完成。';
ok(notify && notify.args.body === expected, '超长名字截到 24 字加省略号：' + (notify && notify.args.body));
ok(notify && notify.args.body.length <= 36, '截断后正文不超过一行：' + (notify && notify.args.body.length));

done();
