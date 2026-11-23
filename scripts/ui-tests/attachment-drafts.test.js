// 附件跟着会话走：在 A 里贴的图，切到 B 不能跟着过去，更不能被当成 B 的消息发出去。
const { boot, checker } = require('./boot');

const { document, window } = boot(`
  window.__hook = function (key) {
    const session = makeSession(key, { isStreaming: false }, [], 'E:/Dev/SevenStation');
    app.byKey.set(key, session);
    return session;
  };
  window.__open = function (id) { openSession({ id, cwd: 'E:/Dev/SevenStation' }); };
  window.__app = app;
  window.__paint = renderAttachments;
`);

const { ok, done } = checker();

const app = window.__app;
const chips = () => document.querySelectorAll('#attachments .attachment').length;
const addImage = (name) => {
  app.attachments.push({ dataUrl: 'data:image/png;base64,AAA', name });
  window.__paint();
};

window.__hook('c-A');
window.__hook('c-B');
window.__open('c-A');
ok(chips() === 0, 'A 里一开始没有附件');

addImage('a.png');
ok(chips() === 1, 'A 里贴了一张图');

window.__open('c-B');
ok(chips() === 0, '切到 B，图不跟过去');
ok(app.attachments.length === 0, 'B 的附件数组是空的（不会被发到 B）');

addImage('b.png');
ok(chips() === 1, 'B 里贴的是 B 的图');

window.__open('c-A');
ok(chips() === 1, '切回 A，A 的图还在');
ok(app.attachments[0].name === 'a.png', '拿回来的是 A 自己那张');

window.__open('c-B');
ok(app.attachments[0].name === 'b.png', 'B 也还是自己那张');

// 发出去之后两边都清空：切回来不该再冒出来。
app.drafts.set('c-B', '一句话');
app.attachmentDrafts.set('c-B', [{ dataUrl: 'data:image/png;base64,BBB', name: 'b2.png' }]);
app.drafts.delete('c-B');
app.attachmentDrafts.delete('c-B');
app.attachments = [];
window.__paint();
ok(chips() === 0, '发出去之后附件清空');

done();
