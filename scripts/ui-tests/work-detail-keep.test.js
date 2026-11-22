// 工作中展开的详情不被新步骤收起，也不把人拽到底部。
const { boot, checker } = require('./boot');

const { window, document } = boot(`
  window.__boot = function (messages) {
    const session = makeSession('c1', { isStreaming: true }, messages, 'E:/tmp/demo');
    app.byKey.set('c1', session);
    app.currentKey = 'c1';
    session.streaming = true;
    renderThread();
    return session;
  };
  window.__patch = function () { patchItem(current().items[current().items.length - 1]); };
  window.__rerender = function () { renderThread(); };
  window.__scrollTop = function (value) { if (typeof value === 'number') el.thread.scrollTop = value; return el.thread.scrollTop; };
`);

const { ok, done } = checker();

const messages = [
  { role: 'user', content: [{ type: 'text', text: '跑一下' }], timestamp: 1000 },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '先看看目录' },
      { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } },
    ],
    timestamp: 1100,
  },
  { role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: 'a.txt\nb.txt' }], timestamp: 1200, durationMs: 9 },
  { role: 'assistant', content: [{ type: 'text', text: '目录里有两个文件。' }], timestamp: 1300 },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '接下来读 README' },
      { type: 'toolCall', id: 't2', name: 'read', arguments: { path: 'README.md' } },
    ],
    timestamp: 1400,
  },
  { role: 'toolResult', toolCallId: 't2', content: [{ type: 'text', text: '# hi' }], timestamp: 1500, durationMs: 4 },
];

const session = window.__boot(messages);

const groups = () => [...document.querySelectorAll('.work')];
const rowOf = (groupId, stepId) =>
  document.querySelector('.work[data-key$="#' + groupId + '"] .st-item[data-step="' + stepId + '"]');

const target = rowOf(2, 't2');
ok(Boolean(target), '找到最后一段工作的读取命令');
target.querySelector('.st-row').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
ok(!target.querySelector('.st-more').hidden, '点开详情');
ok(target.querySelector('.st-more').textContent.includes('README'), '详情里是这条命令');

// 同一条消息里又调了一次工具：这一段往后长一行
const live = session.items[session.items.length - 1];
live.blocks.push({ type: 'toolCall', id: 't3', name: 'bash', args: {}, argsText: '', output: '', running: true, done: false, isError: false, durationMs: null });
session.toolIndex.set('t3', { item: live, block: live.blocks[live.blocks.length - 1] });
window.__patch();

const after = rowOf(2, 't2');
ok(Boolean(after), '新步骤进来后原来那一行还在');
ok(after && !after.querySelector('.st-more').hidden, '展开着的详情没有被收起');
ok(after && after.querySelector('.st-more').textContent.includes('README'), '详情内容还是原来那一条');
ok(groups()[1].querySelectorAll('.st-row').length === 3, '新步骤是追加的（该段现在 3 行）');
ok(after === target, '原来那一行的节点没被重建');

// 整轮重画也要留住展开的详情
window.__rerender();
const restored = rowOf(2, 't2');
ok(restored && !restored.querySelector('.st-more').hidden, '整轮重画之后详情仍然展开');

// 没贴底时重画不该把人拽到底部
window.__scrollTop(0);
window.__rerender();
ok(window.__scrollTop() === 0, '没贴底就保持原位（scrollTop=' + window.__scrollTop() + '）');

done();
