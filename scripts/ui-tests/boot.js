// 把 wwwroot 里的 appearance.js + app.js 塞进 jsdom，补上浏览器才有的几样东西。
// 注意：jsdom 里每次 eval 各自一个作用域，所以三块必须拼成一次 eval。
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..', '..', 'src', 'SevenStation.Core', 'wwwroot');

function boot(extra = '') {
  const appearance = fs.readFileSync(path.join(root, 'appearance.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

  const dom = new JSDOM(html.replace(/<script[^>]*src=[^>]*><\/script>/g, ''), {
    runScripts: 'dangerously',
    url: 'http://127.0.0.1:8938/',
    pretendToBeVisual: true,
  });

  const { window } = dom;
  window.requestAnimationFrame = (fn) => window.setTimeout(() => fn(Date.now()), 0);
  window.matchMedia = window.matchMedia
    || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  window.WebSocket = class {
    constructor() { this.readyState = 1; }
    send() {}
    close() {}
    addEventListener() {}
  };
  window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });

  window.eval(appearance + String.fromCharCode(10) + app + String.fromCharCode(10) + extra);

  return { dom, window, document: window.document };
}

function checker() {
  const errors = [];
  const ok = (condition, message) => {
    console.log((condition ? '✓ ' : '✗ ') + message);
    if (!condition) errors.push(message);
  };
  const done = () => {
    console.log(errors.length ? '\n有 ' + errors.length + ' 条不对' : '\n全对');
    process.exit(errors.length ? 1 : 0);
  };
  return { ok, done, errors };
}

module.exports = { boot, checker };
