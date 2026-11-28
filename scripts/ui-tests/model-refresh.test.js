// 模型面板的刷新：点了要有动静，回来了按钮要复位，不能一直停在「正在刷新…」。
const { boot, checker } = require('./boot');

const { window } = boot(`
  window.__sent = [];
  send = (message) => window.__sent.push(message);

  window.__seed = () => {
    onSessionState({
      type: 'session_state',
      key: 'c-r',
      cwd: 'E:/Dev/SevenStation',
      state: { sessionName: '刷新', model: { provider: 'magpie', id: 'auto' } },
      messages: [],
    });
    const session = app.byKey.get('c-r');
    // 模型胶囊要两个以上才显示，面板也只从胶囊打开：一个模型时 renderModelPill 会主动关面板。
    app.agent = { capabilities: { models: true } };
    session.models = {
      models: [
        { provider: 'magpie', id: 'auto', name: 'auto' },
        { provider: 'magpie', id: 'x', name: 'X' },
      ],
    };
    app.recentModels = [];
    app.currentKey = 'c-r';
    openModelPanel();
  };

  window.__button = () => document.querySelector('.model-refresh');
  window.__again = () => openModelPanel();
  window.__models = (forceName) => dispatch({
    type: 'models',
    key: 'c-r',
    data: {
      models: [
        { provider: 'magpie', id: 'auto', name: forceName || 'auto' },
        { provider: 'magpie', id: 'x', name: 'X' },
      ],
    },
    thinkingLevels: null,
    recent: [],
  });
  window.__sentList = () => window.__sent.slice();
`);

const { ok, done } = checker();

window.__seed();
const button = window.__button();
ok(Boolean(button), '面板底部有刷新按钮');
ok(button.textContent === '刷新' && !button.disabled, '初始可用：' + button.textContent);

// 1. 点一下：发命令、按钮进忙态
button.click();
const sent = window.__sentList();
const ask = sent.filter((item) => item.type === 'list_models').pop();
ok(Boolean(ask) && ask.force === true, '发了强制重取的请求：' + JSON.stringify(ask));
ok(button.disabled === true, '按钮变灰');
ok(button.textContent === '正在刷新…', '文案变成正在刷新：' + button.textContent);

// 2. 清单回来：面板重画，按钮恢复
window.__models('auto-新');
const fresh = window.__button();
ok(fresh && !fresh.disabled, '回来的按钮是可用的');
ok(fresh && fresh.textContent === '刷新', '文案复位：' + (fresh && fresh.textContent));
ok(Boolean(fresh) && fresh !== button, '是重画过的新节点（旧节点的忙态不会留着）');

// 3. 面板重开也是干净的
window.__again();
const reopened = window.__button();
ok(reopened && !reopened.disabled && reopened.textContent === '刷新', '重开面板按钮正常');

done();
