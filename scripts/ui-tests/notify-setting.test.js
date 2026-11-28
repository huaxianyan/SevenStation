// 设置页的「完成时弹系统通知」：默认开、能关、关掉之后真的不调壳、没有壳时不出现。
const { boot, checker } = require('./boot');

const { window } = boot(`
  window.__log = [];
  window.__setShell = (on) => {
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
  window.__openSettings = () => renderPage('settings');
  window.__labels = () => Array.from(document.querySelectorAll('.kv-toggle-label')).map((n) => n.textContent);
  window.__toggle = () => Array.from(document.querySelectorAll('.kv-row-toggle'))
    .find((row) => row.textContent.includes('完成时弹系统通知'))
    ?.querySelector('.switch');
  window.__pref = () => prefs.notifyDone;
  window.__fire = () => dispatch({
    type: 'event',
    key: 'c-n',
    event: { type: 'agent_settled', aborted: false },
  });
  window.__seed = () => onSessionState({
    type: 'session_state',
    key: 'c-n',
    cwd: 'E:/Dev/SevenStation',
    state: { sessionName: 'SevenStation 项目开发' },
    messages: [],
  });
  window.__calls = () => window.__log.slice();
  window.__reset = () => { window.__log.length = 0; };
`);

const { ok, done } = checker();

// 1. 有壳：设置页有这张卡，开关默认开
window.__setShell(true);
window.__openSettings();
ok(window.__labels().includes('完成时弹系统通知'), '设置页里有通知开关');
const toggle = window.__toggle();
ok(Boolean(toggle), '找到了那个开关');
ok(toggle && toggle.classList.contains('is-on'), '默认是开着的');
ok(window.__pref() === true, '偏好里默认 true');

// 2. 点一下关掉：偏好变了、存到本机
toggle.click();
ok(window.__pref() === false, '点一下变成关');
ok(!toggle.classList.contains('is-on'), '开关变灰');
ok(toggle.getAttribute('aria-checked') === 'false', '无障碍状态跟着变');
ok(window.localStorage.getItem('sevenstation.notifyDone') === '0', '存在本机：' +
  window.localStorage.getItem('sevenstation.notifyDone'));

// 3. 关掉之后跑完一轮，不再打扰壳
window.__seed();
window.__reset();
window.__fire();
ok(!window.__calls().some((item) => item.cmd === 'notify_done'), '关掉后不调 notify_done');

// 4. 再点一下打开，恢复提醒
toggle.click();
ok(window.__pref() === true, '再点一下打开');
window.__reset();
window.__fire();
ok(window.__calls().some((item) => item.cmd === 'notify_done'), '打开后照常提醒');

// 5. 浏览器里（没有壳）：这张卡不出现
window.__setShell(false);
window.__openSettings();
ok(!window.__labels().includes('完成时弹系统通知'), '没有壳时不显示这个开关');

done();
