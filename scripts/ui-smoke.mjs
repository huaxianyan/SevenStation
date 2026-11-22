// 界面冒烟：用 CDP 驱动真实窗口跑一遍主链路。
// 前置：应用已用 --remote-debugging-port=9222 启动（scripts/dev-run.ps1 会做）。
// 用法：node scripts/ui-smoke.mjs --cwd work\smoke\ui-ws
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const cwd = argValue('--cwd');
const port = Number(argValue('--port') ?? 9222);
const prompt = '只回复四个字：冒烟通过';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message) => {
  console.error('✗ ' + message);
  process.exit(1);
};

if (!cwd) fail('缺少 --cwd，需要一个已存在的工作目录');
if (!existsSync(cwd)) fail('工作目录不存在：' + cwd);

async function findPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((target) => target.type === 'page' && !String(target.url).startsWith('devtools://'));
      if (page) return page;
    } catch {
      // 应用可能还没起来。
    }
    await sleep(500);
  }
  fail(`连不上调试端口 ${port}，确认应用已启动`);
}

const page = await findPage();
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = () => reject(new Error('CDP 连接失败'));
});

let nextId = 1;
const pending = new Map();
const pageErrors = [];
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  } else if (message.method === 'Runtime.exceptionThrown') {
    pageErrors.push(message.params.exceptionDetails.text);
  }
};

function call(method, params) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}

async function evaluate(expression) {
  const response = await call('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.result?.exceptionDetails) {
    fail('页面执行出错：' + JSON.stringify(response.result.exceptionDetails).slice(0, 300));
  }
  return response.result?.result?.value;
}

await call('Runtime.enable');
await sleep(800);

const connected = await evaluate('return document.getElementById("connStatus").textContent');
console.log('连接状态：' + connected);
if (!connected.includes('已连接')) fail('客户端没有连上中心：' + connected);

const listCount = await evaluate('return document.querySelectorAll(".session-item").length');
console.log('会话列表条目数（起始）：' + listCount);

const beforeKey = await evaluate('return current() ? current().key : null');

await evaluate(`if (!window.send({ type: 'new_conversation', cwd: ${JSON.stringify(cwd)} })) fail('还没连上中心'); return true;`);

// 已经开着一个会话时线程本来就是可见的，所以要等「换成了新会话」而不是等它出现。
let ready = false;
for (let i = 0; i < 90; i++) {
  const key = await evaluate('return current() ? current().key : null');
  if (key && key !== beforeKey) {
    ready = true;
    break;
  }
  await sleep(250);
}
if (!ready) fail('新建会话没有进入就绪状态');

// 模型是中心从 Pi 那边取一次再缓存的，冷启动要等几秒；胶囊上应该出现模型名。
let modelText = '';
for (let i = 0; i < 40; i++) {
  modelText = await evaluate('return document.getElementById("modelPillText").textContent');
  if (modelText && modelText !== '默认模型') break;
  await sleep(500);
}
if (!modelText) fail('模型胶囊没有文字');
console.log('模型：' + modelText);

await evaluate(`
  const input = document.getElementById('input');
  input.value = ${JSON.stringify(prompt)};
  input.dispatchEvent(new Event('input'));
  document.getElementById('sendBtn').click();
  return true;
`);

let sawStreaming = false;
let settled = false;
for (let i = 0; i < 1200; i++) {
  const running = await evaluate('return document.getElementById("sendBtn").classList.contains("stop")');
  if (running) sawStreaming = true;
  if (!running && (sawStreaming || i >= 8)) {
    const text = await evaluate('return document.getElementById("threadInner").innerText');
    if (!running && text.includes('冒烟通过')) {
      settled = true;
      break;
    }
  }

  await sleep(150);
}

if (!settled) fail('回合没有收尾');
if (!sawStreaming) console.log('（注：这轮回复太快，没抓到「停止」状态）');

const threadText = await evaluate('return document.getElementById("threadInner").innerText');
if (!threadText.includes('冒烟通过')) fail('回合结束后线程里没有助手回复：' + JSON.stringify(threadText.slice(-160)));

const usage = await evaluate('return document.getElementById("ctxUsage").textContent');

// 新会话的文件是首次消息后才落盘的，收尾后列表应该已经把它带上。
let listed = 0;
for (let i = 0; i < 20; i++) {
  listed = await evaluate('return document.querySelectorAll(".session-item").length');
  if (listed > listCount || listed > 0) break;
  await sleep(300);
}
if (listed === 0) fail('回合结束后侧栏仍然没有任何会话，列表刷新没生效');
if (pageErrors.length) fail('页面抛过异常：' + pageErrors.slice(0, 3).join(' | '));

console.log('上下文用量：' + usage + '，侧栏条目数：' + listed);
console.log('✓ 冒烟通过：列表、新会话、流式回复、收尾都正常');
socket.close();
process.exit(0);
