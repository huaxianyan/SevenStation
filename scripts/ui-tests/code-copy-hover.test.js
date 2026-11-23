// 代码块的复制按钮不能因为流式重建而一闪一闪：指针没动，重建后要立刻补回 hover 状态。
// 另外用户正在这段正文里选字时，重建会把选区清掉，得先跳过。
const { boot, checker } = require('./boot');

const { document, window } = boot(`
  window.__markdown = renderMarkdown;
  window.__refreshHover = refreshCodeHover;
  window.__selectionInside = selectionInside;
`);

const { ok, done } = checker();

const host = document.createElement('div');
host.className = 'md';
document.body.appendChild(host);

const source = '先看一眼这段：\n\n```js\nconst a = 1;\n```\n';
host.innerHTML = window.__markdown(source);
const block = host.querySelector('.code-block');
const copy = host.querySelector('.code-copy');
ok(Boolean(block) && Boolean(copy), '正文里渲染出了代码块和复制按钮');

// 指针停在复制按钮上。
copy.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, clientX: 12, clientY: 34 }));
ok(block.classList.contains('is-hover'), '指针停在代码块上时标上 is-hover');

// 模拟流式重建：innerHTML 整段换掉，旧节点连同 hover 一起没了。
host.innerHTML = window.__markdown(source);
const rebuilt = host.querySelector('.code-block');
ok(!rebuilt.classList.contains('is-hover'), '重建出来的新节点没有 hover（这就是闪烁的原因）');

// 重建之后按指针位置补回来。
document.elementFromPoint = () => rebuilt.querySelector('.code-copy');
window.__refreshHover();
ok(rebuilt.classList.contains('is-hover'), '补回之后按钮立刻可见，不再闪');

// 指针移开：别的代码块不该继续挂着 is-hover。
const other = document.createElement('div');
other.className = 'code-block';
host.appendChild(other);
document.elementFromPoint = () => other;
window.__refreshHover();
ok(!rebuilt.classList.contains('is-hover') && other.classList.contains('is-hover'), 'hover 跟着指针走，只留一个');

// 选区保护：选着字的时候不该重画这段正文。
const md = host;
const range = document.createRange();
range.selectNodeContents(host.querySelector('pre'));
const selection = window.getSelection();
selection.removeAllRanges();
selection.addRange(range);
ok(window.__selectionInside(md), '选区在这段正文里时认得出来');

selection.removeAllRanges();
ok(!window.__selectionInside(md), '选区没了就不再拦着重画');

done();
