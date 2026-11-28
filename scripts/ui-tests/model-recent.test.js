// 模型面板左栏第一项是「常用」：最近选过的 7 个，选过的回顶部，超了从末尾挤掉。
const { boot, checker } = require('./boot');

const { window } = boot(`
  window.__seed = (models, recent, chosen) => {
    onSessionState({
      type: 'session_state',
      key: 'c-m',
      cwd: 'E:/Dev/SevenStation',
      state: { sessionName: '模型面板', model: chosen },
      messages: [],
    });
    const session = app.byKey.get('c-m');
    session.models = { models: models };
    app.recentModels = recent;
    app.currentKey = 'c-m';
  };
  window.__open = () => openModelPanel();
  window.__providers = () => Array.from(document.querySelectorAll('.model-provider'))
    .map((node) => node.textContent.replace(/\\s+/g, ' ').trim());
  window.__rows = () => Array.from(document.querySelectorAll('.model-row'))
    .map((node) => node.querySelector('.model-row-name').textContent);
  window.__rowMeta = (index) => document.querySelectorAll('.model-row')[index]
    .querySelector('.model-row-meta').textContent;
  window.__groups = () => Array.from(document.querySelectorAll('.model-group')).map((n) => n.textContent);
  window.__hint = () => {
    const node = document.querySelector('.model-hint');
    return node ? node.textContent : '';
  };
  window.__pick = (name) => {
    const row = Array.from(document.querySelectorAll('.model-row'))
      .find((node) => node.querySelector('.model-row-name').textContent === name);
    if (row) row.click();
    return Boolean(row);
  };
  window.__recent = () => (app.recentModels || []).map((item) => item.id);
  window.__push = (items) => dispatch({ type: 'recent_models', items: items });
  window.__providerClick = (name) => {
    const node = Array.from(document.querySelectorAll('.model-provider'))
      .find((item) => item.textContent.includes(name));
    if (node) node.click();
    return Boolean(node);
  };
  window.__provider = () => modelState.provider;
`);

const { ok, done } = checker();

const model = (provider, id, name) => ({ provider, id, name: name || id });
const many = [
  model('workbuddy', 'DeepSeek-V4.1-Flash'),
  model('anthropic', 'claude-sonnet-4-5'),
  model('magpie', 'auto/judge'),
  model('magpie', 'openai/gpt-5.1'),
  model('google', 'gemini-3-pro'),
  model('anthropic', 'claude-haiku-4-5'),
  model('magpie', 'zhipu/glm-4.6'),
  model('magpie', 'moonshot/kimi-k2'),
  model('magpie', 'deepseek/reasoner'),
];

const recentOf = (pairs) => pairs.map(([provider, id]) => ({ provider, id }));

// 1. 左栏第一项是常用，没有「全部」
window.__seed(many, recentOf([['workbuddy', 'DeepSeek-V4.1-Flash'], ['google', 'gemini-3-pro']]), {
  provider: 'workbuddy',
  id: 'DeepSeek-V4.1-Flash',
});
window.__open();
ok(window.__provider() === '常用', '打开面板默认停在常用：' + window.__provider());
const providers = window.__providers();
ok(providers[0].startsWith('常用'), '第一项是常用：' + JSON.stringify(providers.slice(0, 3)));
ok(!providers.some((name) => name.includes('全部')), '不再有「全部」这一项');

// 2. 常用按最近用过的顺序，当前模型置顶
ok(JSON.stringify(window.__rows()) === JSON.stringify(['DeepSeek-V4.1-Flash', 'gemini-3-pro']),
  '常用只放选过的，顺序跟记录一致：' + JSON.stringify(window.__rows()));
ok(window.__rowMeta(0).startsWith('workbuddy ·'), '常用里每行带 provider 前缀：' + window.__rowMeta(0));
ok(window.__groups().length === 0, '常用不套 route 分组');

// 3. 当前模型不在名单里（新建对话沿用了默认模型）：先顶上
window.__seed(many, recentOf([['google', 'gemini-3-pro']]), { provider: 'magpie', id: 'openai/gpt-5.1' });
window.__open();
ok(JSON.stringify(window.__rows()) === JSON.stringify(['openai/gpt-5.1', 'gemini-3-pro']),
  '当前模型不在名单时置顶：' + JSON.stringify(window.__rows()));

// 4. 最多 7 个
const manyRecent = recentOf([
  ['workbuddy', 'DeepSeek-V4.1-Flash'],
  ['anthropic', 'claude-sonnet-4-5'],
  ['magpie', 'auto/judge'],
  ['magpie', 'openai/gpt-5.1'],
  ['google', 'gemini-3-pro'],
  ['anthropic', 'claude-haiku-4-5'],
  ['magpie', 'zhipu/glm-4.6'],
]);
window.__seed(many, manyRecent, { provider: 'workbuddy', id: 'DeepSeek-V4.1-Flash' });
window.__open();
ok(window.__rows().length === 7, '最多摆 7 个：' + window.__rows().length);
ok(!window.__rows().includes('moonshot/kimi-k2'), '第 8 个被挤出去了');

// 5. 选一个已经在名单里的：回到最前面，不重复占位
ok(window.__pick('zhipu/glm-4.6'), '能找到 zhipu/glm-4.6 这一行');
ok(window.__recent()[0] === 'zhipu/glm-4.6', '重选把它挪到最前：' + JSON.stringify(window.__recent().slice(0, 3)));
ok(window.__recent().length === 7, '重选不会多出一条：' + window.__recent().length);
ok(new Set(window.__recent()).size === window.__recent().length, '名单里没有重复项');

// 6. 选一个没在名单里的：插到最前，末尾挤掉
window.__open();
ok(window.__providerClick('magpie'), '切到 magpie 那一栏');
ok(window.__pick('moonshot/kimi-k2'), '能找到 moonshot/kimi-k2 这一行（不在这 7 个里）');
const after = window.__recent();
ok(after[0] === 'moonshot/kimi-k2', '新选的排第一：' + after[0]);
ok(after.length === 7, '插入后仍是 7 条：' + after.length);
ok(!after.includes('claude-haiku-4-5'), '末尾那条被挤掉：' + JSON.stringify(after));

// 7. 还没有记录：回落全部 + 一行说明，不摆空列表
window.__seed(many, [], null);
window.__open();
ok(window.__rows().length === many.length, '没有记录时先列出全部：' + window.__rows().length);
ok(window.__hint() === '还没有常用记录，选过的模型会自动出现在这里。', '有一行说明：' + window.__hint());
ok(window.__groups().length > 0, '回落时按 provider 分组');

// 8. 名单里指向的模型已经没了：跳过，不留点不动的行
window.__seed(many, recentOf([['magpie', 'gone/model'], ['google', 'gemini-3-pro']]), null);
window.__open();
ok(JSON.stringify(window.__rows()) === JSON.stringify(['gemini-3-pro']), '删掉的模型不出现在常用里：' + JSON.stringify(window.__rows()));

// 9. 别的对话（或别的设备）改了名单：广播过来就换，不用重开面板
window.__seed(many, recentOf([['google', 'gemini-3-pro']]), { provider: 'google', id: 'gemini-3-pro' });
window.__open();
ok(window.__rows().length === 1, '先只有一条：' + JSON.stringify(window.__rows()));
window.__push(recentOf([['magpie', 'zhipu/glm-4.6'], ['google', 'gemini-3-pro']]));
ok(window.__rows().includes('zhipu/glm-4.6') && window.__rows().length === 2, '收到广播后立刻跟着换：' + JSON.stringify(window.__rows()));
ok(window.__recent().length === 2, '全局名单也跟着更新：' + window.__recent().length);

done();
