// 过程区分段：一轮里「工作 → 正文 → 工作 → 正文」各算一段，详情就地展开。
const { boot, checker } = require('./boot');

const { window, document } = boot(`
  window.__renderTurn = function (turn, session, isLast) { return turnNode(turn, session, isLast); };
  window.__updateLiveTurn = function (node, turn) { return updateLiveTurn(node, turn); };
`);

const { ok, done } = checker();

const content = () => [
  { id: 'th1', type: 'thinking', text: '先看目录' },
  { id: 't1', type: 'toolCall', name: 'bash', args: { command: 'ls' }, text: 'a.txt\nb.txt', done: true, durationMs: 12, ts: 1100 },
  { type: 'text', text: '目录里有两个文件。' },
];

const session = { key: 'c-1', cwd: 'E:/Dev/SevenStation', streaming: false, items: [] };
const turn = {
  items: [
    { id: 'u1', kind: 'user', text: '看下项目', ts: 1000 },
    {
      id: 'a1',
      kind: 'assistant',
      ts: 1100,
      blocks: content().concat([
        { id: 'th2', type: 'thinking', text: '接下来读 README', ts: 1200 },
        { id: 't2', type: 'toolCall', name: 'read', args: { path: 'README.md' }, text: '# hi', done: true, durationMs: 5, ts: 1200 },
        { type: 'text', text: 'README 说明如下。' },
      ]),
    },
  ],
};

const node = window.__renderTurn(turn, session, true);
const assistant = node.querySelector('.msg.assistant');
const kinds = [...assistant.children].map((child) =>
  child.classList.contains('work') ? 'work' : child.classList.contains('md') ? 'text' : child.tagName);

ok(
  JSON.stringify(kinds) === JSON.stringify(['work', 'text', 'work', 'text']),
  '按「工作 → 正文 → 工作 → 正文」排：' + kinds.join(','),
);

const groups = assistant.querySelectorAll('.work');
ok(groups.length === 2, '一轮里两段独立的工作区：' + groups.length);
ok(groups[0].dataset.seg === '0' && groups[1].dataset.seg === '2', '每段标了序号');
ok(groups[0].querySelectorAll('.st-row').length === 2, '第一段只有回答前的步骤');
ok(groups[1].querySelectorAll('.st-row').length === 2, '第二段只有回答后的步骤');

// 就地展开
const row = groups[0].querySelectorAll('.st-row')[1];
const detail = row.parentElement.querySelector('.st-more');
row.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
ok(!detail.hidden, '点一行就地展开');
ok(detail.parentElement === row.parentElement, '详情就在这一行底下，不是独立窗口');
ok(document.querySelector('.sm-scrim') === null, '没有弹窗遮罩');
ok(detail.textContent.includes('ls'), '详情里有这条命令');
row.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
ok(detail.hidden, '再点一下收起');
row.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
ok(detail.hidden, 'Esc 也能收起');

const row2 = groups[1].querySelectorAll('.st-row')[1];
row.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
row2.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
ok(detail.hidden && !row2.parentElement.querySelector('.st-more').hidden, '同时只展开一条');

// 正文在长：只换最后那段，前面的工作段节点不动
const live = JSON.parse(JSON.stringify(turn));
live.items[1].blocks[5].text = 'README 说明如下：先装依赖。';
const keptGroup = groups[0];
const keptText = assistant.querySelectorAll('.md')[0];
ok(window.__updateLiveTurn(node, live) === true, '正文变长走就地更新');
ok(assistant.querySelector('.work') === keptGroup, '前面的工作段没被重建');
ok(assistant.querySelectorAll('.md')[1].textContent.includes('先装依赖'), '在长的那段换成了新内容');
ok(assistant.querySelectorAll('.md')[0] === keptText, '更早那段一个节点都没动');

// 回答后又调工具 = 新的一段，结构变了交给整轮重画
const more = JSON.parse(JSON.stringify(turn));
more.items[1].blocks.push({ id: 't3', type: 'toolCall', name: 'bash', args: { command: 'pwd' }, text: 'E:/Dev/SevenStation', done: true, durationMs: 3, ts: 1300 });
ok(window.__updateLiveTurn(node, more) === false, '结构变了就整轮重画（一轮只发生一次）');
const rebuilt = window.__renderTurn(more, session, true);
ok([...rebuilt.querySelector('.msg.assistant').children][2].classList.contains('work'), '重画后新工作段仍排在正文后面');

// 空白思考不占一行
const blank = JSON.parse(JSON.stringify(turn));
blank.items[1].blocks.push(
  { id: 'th3', type: 'thinking', text: ' ' },
  { id: 't4', type: 'toolCall', name: 'bash', args: { command: 'whoami' }, text: 'me', done: true, durationMs: 2, ts: 1400 },
);
const blankNode = window.__renderTurn(blank, session, true);
const thinkingRows = [...blankNode.querySelectorAll('.work .st-row')].filter((item) => item.classList.contains('is-thinking'));
ok(thinkingRows.length === 2, '空白思考不画：' + thinkingRows.length);
ok(thinkingRows.every((item) => item.textContent.replace('思考', '').trim().length > 0), '每行思考都有摘要');

// 模型常在思考与工具调用之间塞一个空格或换行当正文块。那种空段落不能算正文，
// 更不能把前后两段工作切成两截（2026-11-23 实际踩到：一轮里冒出六个「工作 2 步」，中间全是空的）。
const noisy = {
  items: [
    { id: 'u9', kind: 'user', text: '继续改', ts: 2000 },
    {
      id: 'a9',
      kind: 'assistant',
      ts: 2100,
      blocks: [
        { id: 'th9a', type: 'thinking', text: '先看文件', ts: 2100 },
        { type: 'text', text: ' ' },
        { id: 't9a', type: 'toolCall', name: 'bash', args: { command: 'ls' }, text: 'a.txt', done: true, durationMs: 3, ts: 2200 },
        { id: 'th9b', type: 'thinking', text: '再改一处', ts: 2300 },
        // 换行也算空白：这里写成转义，别让它真的换行
        { type: 'text', text: '\n' },
        { id: 't9b', type: 'toolCall', name: 'bash', args: { command: 'pwd' }, text: '/x', done: true, durationMs: 3, ts: 2400 },
        { type: 'text', text: '改好了。' },
      ],
    },
  ],
};
const noisyNode = window.__renderTurn(noisy, session, false);
const noisyAssistant = noisyNode.querySelector('.msg.assistant');
const noisyKinds = [...noisyAssistant.children].map((child) =>
  child.classList.contains('work') ? 'work' : child.classList.contains('md') ? 'text' : child.tagName);
ok(
  JSON.stringify(noisyKinds) === JSON.stringify(['work', 'text']),
  '空白正文块不切段：' + noisyKinds.join(','),
);
const noisyGroups = noisyAssistant.querySelectorAll('.work');
ok(noisyGroups.length === 1, '两串工具调用合成一段工作：' + noisyGroups.length);
ok(noisyGroups[0].querySelectorAll('.st-row').length === 4, '这一段的步骤没丢：' + noisyGroups[0].querySelectorAll('.st-row').length);
ok(noisyAssistant.querySelectorAll('.md').length === 1, '只画一个正文块：' + noisyAssistant.querySelectorAll('.md').length);

done();
