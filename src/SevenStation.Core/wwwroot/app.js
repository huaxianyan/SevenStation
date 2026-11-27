'use strict';

/* ------------------------------------------------------------------ *
 * 与 Seven Station Core 通信
 *
 * 页面由 Seven Station Core 托管，命令与事件都走同一条 WebSocket，所以桌面壳和手机浏览器
 * 用的是同一套前端代码。令牌由 Seven Station Core 生成，桌面壳拼在地址上，手机手动带上。
 * ------------------------------------------------------------------ */

/* 界面偏好：放本地，换设备不跟着走。 */
const prefs = { interrupt: false };
try {
  prefs.interrupt = localStorage.getItem('sevenstation.interruptCtrlEnter') === '1';
} catch {
  prefs.interrupt = false;
}

function savePrefs() {
  try {
    localStorage.setItem('sevenstation.interruptCtrlEnter', prefs.interrupt ? '1' : '0');
  } catch {
    /* 隐私模式下存不了，本次会话内生效就够。 */
  }
}

/* 外观放在 appearance.js，那边先于渲染跑，这里只管画设置页那张卡。 */

const TOKEN_KEY = 'sevenstation.token';

/**
 * 令牌来源：地址栏的 ?token=（扫码或别人发来的地址）→ 本机存储。
 * 地址栏里那个只用来交接一次，存下来之后从 URL 上抹掉，免得留在历史记录里。
 */
function readToken() {
  let fromUrl = '';
  try {
    fromUrl = new URLSearchParams(location.search).get('token') || '';
  } catch {
    fromUrl = '';
  }

  if (fromUrl) {
    try {
      localStorage.setItem(TOKEN_KEY, fromUrl);
    } catch {
      // 浏览器禁了存储就算了，这一次照样能用。
    }

    try {
      const clean = new URL(location.href);
      clean.searchParams.delete('token');
      history.replaceState(null, '', clean.pathname + (clean.search ? clean.search : ''));
    } catch {
      // 换不掉也无所谓。
    }

    return fromUrl;
  }

  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

function saveToken(value) {
  try {
    localStorage.setItem(TOKEN_KEY, value);
  } catch {
    // 存不下就只在这次会话里用。
  }
  transport.token = value;
}

const transport = {
  socket: null,
  connected: false,
  attempts: 0,
  queue: [],
  token: readToken(),
};

function send(message) {
  if (transport.connected && transport.socket && transport.socket.readyState === WebSocket.OPEN) {
    transport.socket.send(JSON.stringify(message));
    return true;
  }

  // 掉线时只留住能自愈的请求，别的操作直接告诉用户没连上。
  if (message.type === 'list_conversations' && !transport.queue.some((item) => item.type === 'list_conversations')) {
    transport.queue.push(message);
  }
  return false;
}

function setConnectionState(text, ok) {
  el.connStatus.textContent = text;
  el.connStatus.title = app.centerName ? 'Seven Station Core：' + app.centerName : '';
  el.connStatus.className = 'conn' + (ok === true ? ' ok' : ok === false ? ' off' : '');
}

function connect() {
  if (!transport.token) {
    setConnectionState('还没有访问令牌：去「设置」里填一个', false);
    if (app.view !== 'settings') switchView('settings');
    return;
  }

  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${scheme}://${location.host}/ws?token=${encodeURIComponent(transport.token)}`);
  transport.socket = socket;
  setConnectionState(transport.attempts ? '正在重连…' : '正在连接…');

  socket.addEventListener('open', () => {
    transport.connected = true;
    transport.attempts = 0;
    setConnectionState('已连接', true);
    while (transport.queue.length) {
      socket.send(JSON.stringify(transport.queue.shift()));
    }
    send({ type: 'list_conversations' });

    // 断线重连后把正在看的这条重新要一遍：不重开会话，线程里那一步会一直停在断开前的样子。
    if (app.currentKey) {
      send({ type: 'open_conversation', id: app.currentKey });
    }
  });

  socket.addEventListener('message', (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    if (data && typeof data === 'object') {
      dispatch(data);
    }
  });

  socket.addEventListener('close', () => {
    transport.connected = false;
    transport.attempts += 1;
    setConnectionState('连接断开，正在自动重连', false);
    const delay = Math.min(1000 * 2 ** (transport.attempts - 1), 15000);
    setTimeout(connect, delay);
  });

  socket.addEventListener('error', () => {
    // 具体原因看 close。
  });
}

/* ------------------------------------------------------------------ *
 * 状态
 * ------------------------------------------------------------------ */

const app = {
  view: 'chat',
  skills: null,
  extensions: null,
  updates: null,
  /* 「稍后」只管这一次打开：重开客户端还会再提。 */
  updDismissed: false,
  /* 手动刷新模型清单的时刻：Core 那边要等下一次广播才带上新的 modelsAt。 */
  modelsAt: 0,
  logTail: null,
  sessions: [],
  sessionRoot: '',
  storePath: '',
  centerVersion: '',
  pendingPrompt: '',
  centerName: '',
  filter: '',
  currentKey: null,
  byKey: new Map(),
  // 上一次画的是哪个会话：换会话要落到底，同一会话重画就别动滚动位置。
  renderedKey: null,
  // 每个会话各自的草稿：切会话换一份，别把 A 里没发出去的话带到 B。
  drafts: new Map(),
  /* 附件也按会话存：在 A 里贴的图，切到 B 不能跟着过去。 */
  attachmentDrafts: new Map(),
  activeCwd: '',
  lastCwd: '',
  pendingCwd: '',
  openRequest: null,
  attachments: [],
  extStatus: new Map(),
  widgets: new Map(),
  dirty: new Set(),
  frame: 0,
  nodeCache: new Map(),
  restore: null,
};

function current() {
  return app.currentKey ? app.byKey.get(app.currentKey) : null;
}

function makeSession(key, state, messages, cwd) {
  const raw = messages || [];
  const built = buildItems(raw);
  return {
    key,
    state: state || {},
    cwd: cwd || '',
    raw,
    items: built.items,
    toolIndex: built.toolIndex,
    hasMore: false,
    loadingOlder: false,
    streaming: false,
    stats: null,
    models: null,
    levels: null,
    liveId: null,
    seq: built.items.length,
  };
}

const el = {
  sessionList: document.getElementById('sessionList'),
  sessionFilter: document.getElementById('sessionFilter'),
  filterToggle: document.getElementById('filterToggle'),
  filterbar: document.getElementById('filterbar'),
  navCount: document.getElementById('navCount'),
  settingsBtn: document.getElementById('settingsBtn'),
  threadsNav: document.getElementById('threadsNav'),
  skillsNav: document.getElementById('skillsNav'),
  extensionsNav: document.getElementById('extensionsNav'),
  skillsCount: document.getElementById('skillsCount'),
  extensionsCount: document.getElementById('extensionsCount'),
  extensionsUpdate: document.getElementById('extensionsUpdate'),
  updStrip: document.getElementById('updStrip'),
  updText: document.getElementById('updText'),
  updLater: document.getElementById('updLater'),
  updGo: document.getElementById('updGo'),
  topbar: document.querySelector('.topbar'),
  pageView: document.getElementById('pageView'),
  pageInner: document.getElementById('pageInner'),
  collapseBtn: document.getElementById('collapseBtn'),
  sidebarToggle: document.getElementById('sidebarToggle'),
  exportBtn: document.getElementById('exportBtn'),
  filesBtn: document.getElementById('filesBtn'),
  filePanel: document.getElementById('filePanel'),
  filesPath: document.getElementById('filesPath'),
  filesBody: document.getElementById('filesBody'),
  filesUp: document.getElementById('filesUp'),
  filesClose: document.getElementById('filesClose'),
  terminalBtn: document.getElementById('terminalBtn'),
  jumpBottom: document.getElementById('jumpBottom'),
  content: document.getElementById('content'),
  terminalPanel: document.getElementById('terminalPanel'),
  terminalShell: document.getElementById('terminalShell'),
  terminalBody: document.getElementById('terminalBody'),
  terminalInput: document.getElementById('terminalInput'),
  terminalClear: document.getElementById('terminalClear'),
  terminalStop: document.getElementById('terminalStop'),
  terminalClose: document.getElementById('terminalClose'),
  branchPill: document.getElementById('branchPill'),
  branchPillText: document.getElementById('branchPillText'),
  branchPillCount: document.getElementById('branchPillCount'),
  branchPillAb: document.getElementById('branchPillAb'),
  gitPanel: document.getElementById('gitPanel'),
  pills: document.querySelector('.pills'),
  wsSelectText: document.getElementById('wsSelectText'),
  windowEl: document.getElementById('app'),
  main: document.querySelector('.main'),
  crumbSep: document.getElementById('crumbSep'),
  sessionTitle: document.getElementById('sessionTitle'),
  renameBtn: document.getElementById('renameBtn'),
  sessionCwd: document.getElementById('sessionCwd'),
  thread: document.getElementById('thread'),
  threadInner: document.getElementById('threadInner'),
  composer: document.getElementById('composer'),
  queuePanel: document.getElementById('queuePanel'),
  queueTitle: document.getElementById('queueTitle'),
  queueList: document.getElementById('queueList'),
  queueClear: document.getElementById('queueClear'),
  empty: document.getElementById('empty'),
  input: document.getElementById('input'),
  sendBtn: document.getElementById('sendBtn'),
  attachBtn: document.getElementById('attachBtn'),
  attachments: document.getElementById('attachments'),
  hint: document.getElementById('hint'),
  modelPill: document.getElementById('modelPill'),
  modelPillRoute: document.getElementById('modelPillRoute'),
  modelPillSlash: document.getElementById('modelPillSlash'),
  modelPillText: document.getElementById('modelPillText'),
  modelPanel: document.getElementById('modelPanel'),
  thinkingSelect: document.getElementById('thinkingSelect'),
  compactBtn: document.getElementById('compactBtn'),
  ctxUsage: document.getElementById('ctxUsage'),
  ctxRing: document.getElementById('ctxRing'),
  ctxRingFill: document.getElementById('ctxRingFill'),
  newSessionBtn: document.getElementById('newSessionBtn'),
  restoreSessionBtn: document.getElementById('restoreSessionBtn'),
  emptyNewBtn: document.getElementById('emptyNewBtn'),
  overlay: document.getElementById('overlay'),
  overlayText: document.getElementById('overlayText'),
  modal: document.getElementById('modal'),
  toasts: document.getElementById('toasts'),
  extStatus: document.getElementById('extStatus'),
  connStatus: document.getElementById('connStatus'),
  widgetStrip: document.getElementById('widgetStrip'),
  completions: document.getElementById('completions'),
  fileInput: document.getElementById('fileInput'),
};

const DEFAULT_CSS = `body,
input,
textarea,
keygen,
select,
button {
  text-shadow: 0px 0px 1px rgba(0, 0, 0, 0.16) !important;
  -webkit-font-smoothing: subpixel-antialiased !important;
  font-family: 'Microsoft Yahei';
}

@font-face {
  font-family: 'Microsoft YaHei';
  src: local('Microsoft Yahei');
}

@font-face {
  font-family: 'Microsoft YaHei';
  src: local('Segoe UI');
}

@font-face {
  font-family: '微软雅黑';
  src: local('Microsoft Yahei');
}

@font-face {
  font-family: '微软雅黑';
  src: local('Segoe UI');
}

@font-face {
  font-family: 'Segoe UI';
  src: local('Microsoft Yahei');
}

@font-face {
  font-family: 'Segoe UI';
  src: local('Segoe UI');
}
`;

/* ------------------------------------------------------------------ *
 * 通用小工具
 * ------------------------------------------------------------------ */

const ANSI = /\x1b\[[0-9;]*m/g;
const stripAnsi = (text) => (text || '').replace(ANSI, '');

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(text) {
  return escapeHtml(text).replace(/'/g, '&#39;');
}

function formatBytes(n) {
  if (!n) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function relativeTime(ms) {
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' 小时前';
  if (diff < 7 * 86_400_000) return Math.floor(diff / 86_400_000) + ' 天前';
  const d = new Date(ms);
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`;
}

function baseName(path) {
  const parts = String(path || '').split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function toast(message, kind) {
  const node = buildToast(message, kind, false);
  setTimeout(() => dismissToast(node), kind === 'error' ? 9000 : 4500);
}

/** 通知卡片统一长这样：可选的转圈 + 一段文字，方便换字时只动文字。 */
function buildToast(text, kind, busy) {
  const node = document.createElement('div');
  node.className = 'toast' + (busy ? ' is-busy' : '') + (kind ? ' ' + kind : '');

  if (busy) {
    const spin = document.createElement('span');
    spin.className = 'toast-spin';
    node.appendChild(spin);
  }

  const label = document.createElement('span');
  label.className = 'toast-text';
  label.textContent = text;
  node.appendChild(label);

  el.toasts.appendChild(node);
  return node;
}

/**
 * 进场是往上冒，退场就对称地往下沉。
 * 分两段：先整块淡出下移（看得见的动作，文字和框一起走），
 * 等它透明了再把高度收掉——收的时候看不见框，只有下面的卡片在往上合。
 */
function dismissToast(node) {
  if (!node.isConnected || node.dataset.leaving) return;
  node.dataset.leaving = '1';

  const fade = node.animate(
    [
      { opacity: 1, transform: 'none' },
      { opacity: 0, transform: 'translateY(6px)' },
    ],
    { duration: 150, easing: 'ease-in', fill: 'forwards' },
  );

  fade.onfinish = () => {
    node.style.overflow = 'hidden';
    const collapse = node.animate(
      [{ height: node.getBoundingClientRect().height + 'px' }, { height: '0px' }],
      { duration: 120, easing: 'ease-out' },
    );
    collapse.onfinish = () => node.remove();
  };
}

/** 换文案：新字淡入，卡片高度按新旧差值过渡，变长变短都不跳。 */
function setToastText(node, text) {
  const label = node.querySelector('.toast-text') || node;
  if (label.textContent === text) return;

  const labelHeight = label.getBoundingClientRect().height;
  const before = node.getBoundingClientRect().height;
  label.textContent = text;
  const after = node.getBoundingClientRect().height;

  label.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });

  if (Math.abs(after - before) < 1) return;
  if (Math.abs(labelHeight - label.getBoundingClientRect().height) < 1) return;
  node.style.overflow = 'hidden';
  const animation = node.animate(
    [{ height: before + 'px' }, { height: after + 'px' }],
    { duration: 200, easing: 'ease-out' },
  );
  animation.onfinish = () => {
    node.style.overflow = '';
  };
}

/**
 * 常驻一条状态通知：一秒钟内完不成的操作（压缩、停止）用它。
 * 同一张卡片从「进行中 + 转圈」翻成结果，不要开始一条、结束再来一条。
 */
function statusToast(text) {
  const node = buildToast(text, '', true);
  let timer = 0;

  return {
    node,
    update(next, kind) {
      window.clearTimeout(timer);
      node.className = 'toast' + (kind ? ' ' + kind : '');
      const spin = node.querySelector('.toast-spin');
      if (spin) spin.remove();
      setToastText(node, next);
      timer = window.setTimeout(() => dismissToast(node), kind === 'error' ? 9000 : 3200);
    },
    remove() {
      window.clearTimeout(timer);
      dismissToast(node);
    },
  };
}

function setOverlay(text) {
  if (!text) {
    el.overlay.hidden = true;
    return;
  }
  el.overlayText.textContent = text;
  el.overlay.hidden = false;
}

/* ------------------------------------------------------------------ *
 * 极简 Markdown（够用于聊天正文与工具输出）
 * ------------------------------------------------------------------ */

function renderInline(text) {
  const source = String(text == null ? '' : text);
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+)/g;
  let out = '';
  let last = 0;
  for (const match of source.matchAll(pattern)) {
    out += escapeHtml(source.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('`')) {
      out += '<code>' + escapeHtml(token.slice(1, -1)) + '</code>';
    } else if (token.startsWith('**')) {
      out += '<strong>' + escapeHtml(token.slice(2, -2)) + '</strong>';
    } else if (token.startsWith('*')) {
      out += '<em>' + escapeHtml(token.slice(1, -1)) + '</em>';
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      out += '<a href="' + escapeAttr(link[2]) + '" target="_blank" rel="noreferrer">' +
        escapeHtml(link[1]) + '</a>';
    } else {
      out += '<a href="' + escapeAttr(token) + '" target="_blank" rel="noreferrer">' +
        escapeHtml(token) + '</a>';
    }
    last = match.index + token.length;
  }
  out += escapeHtml(source.slice(last));
  return out;
}

/** 正文里出现的地址和绝对路径要能点：地址开浏览器，路径直接打开（目录开文件夹，文件用默认程序）。 */
// 带引号的路径整段吃下来（Windows 路径里常有空格），所以排在裸路径前面。
// 裸路径不能把中文标点吃进去，否则“E:\a\b，然后”整句都成了链接。
const LINKABLE = /https?:\/\/[^\s<>"'`？，。；！、（）【】《》]+|"[A-Za-z]:\\[^"]*"|\b[A-Za-z]:\\[^\s<>"'`|?*，。；：！？、（）【】《》「」『』]+|\\\\[^\s<>"'`|?*，。；：！？、（）【】《》「」『』]+/g;

/** 句末的标点和右括号不算地址的一部分。 */
function trimLinkTail(value) {
  return value.replace(/[.,;:!?，。；：！？、）)】\]》」』"'”’]+$/, '');
}

function decorateLinks(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.nodeValue || !node.nodeValue.trim()) continue;
    // 已有的链接和代码块里不再二次处理；行内代码要处理，路径常被反引号包着。
    const parent = node.parentElement;
    if (!parent || parent.closest('a, pre')) continue;
    LINKABLE.lastIndex = 0;
    if (LINKABLE.test(node.nodeValue)) targets.push(node);
  }

  for (const node of targets) {
    const text = node.nodeValue;
    const fragment = document.createDocumentFragment();
    let last = 0;
    LINKABLE.lastIndex = 0;

    for (const match of text.matchAll(LINKABLE)) {
      const raw = match[0];
      const quoted = raw.length > 2 && raw.startsWith('"');
      // 引号只是分隔符，不进链接；引号里的内容也别再按句末标点裁。
      const url = quoted ? raw.slice(1, -1) : trimLinkTail(raw);
      if (!url) continue;

      const start = match.index;
      if (start > last) fragment.appendChild(document.createTextNode(text.slice(last, start)));

      const link = document.createElement('a');
      link.textContent = url;
      if (/^https?:\/\//i.test(url)) {
        link.className = 'link-out';
        link.href = url;
        link.target = '_blank';
        link.rel = 'noreferrer noopener';
      } else {
        link.className = 'link-path';
        link.href = '#';
        link.dataset.path = url;
        link.title = '打开这个路径';
      }
      fragment.appendChild(link);

      last = start + url.length;
    }

    if (last === 0) continue;
    if (last < text.length) fragment.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(fragment, node);
  }
}

/**
 * 打开一个路径：目录开文件夹，文件用默认程序直接打开。
 * 桌面客户端让壳自己开（壳跑在用户会话里，窗口才看得见）；
 * 在浏览器里或者壳那边不认账时退回 Core，Core 至少会回一句「找不到这个路径」。
 */
function revealPath(path) {
  const shell = window.__TAURI__ && window.__TAURI__.core;
  if (shell && typeof shell.invoke === 'function') {
    shell.invoke('reveal_path', { path }).catch(() => send({ type: 'reveal_path', path }));
    return;
  }
  send({ type: 'reveal_path', path });
}

/**
 * 打开一个地址。
 * 桌面客户端里 `target="_blank"` 是打不开外部浏览器的：WebView2 新窗口请求交给壳，
 * 壳不接就什么都不发生（以前就是这个毛病，指针变成手了但点了没反应）。
 * 浏览器里照常开新标签页。
 */
function openUrl(url) {
  const shell = window.__TAURI__ && window.__TAURI__.core;
  if (shell && typeof shell.invoke === 'function') {
    shell.invoke('open_url', { url }).catch(() => window.open(url, '_blank', 'noopener'));
    return;
  }
  window.open(url, '_blank', 'noopener');
}

function renderMarkdown(text) {
  const holder = document.createElement('div');
  holder.innerHTML = renderMarkdownInner(text);
  decorateLinks(holder);
  return holder.innerHTML;
}

function renderMarkdownInner(text) {
  const source = String(text == null ? '' : text).replace(/\r\n/g, '\n');
  const chunks = [];
  const fence = /```([\w+-]*)\n([\s\S]*?)(?:```|$)/g;
  let last = 0;
  for (const match of source.matchAll(fence)) {
    if (match.index > last) {
      chunks.push({ code: false, body: source.slice(last, match.index) });
    }
    const lang = match[1] ? ' data-lang="' + escapeAttr(match[1]) + '"' : '';
    chunks.push({ code: true, body: match[2], lang });
    last = match.index + match[0].length;
  }
  if (last < source.length) {
    chunks.push({ code: false, body: source.slice(last) });
  }

  let html = '';
  for (const chunk of chunks) {
    if (chunk.code) {
      const code = chunk.body.replace(/\n$/, '');
      html += '<div class="code-block"><button class="code-copy" data-code="' +
        escapeAttr(encodeURIComponent(code)) + '">复制</button><pre><code>' + escapeHtml(code) +
        '</code></pre></div>';
    } else {
      html += renderBlocks(chunk.body);
    }
  }
  return html;
}

function renderBlocks(body) {
  const lines = body.split('\n');
  const out = [];
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push('<p>' + renderInline(paragraph.join('\n')).replace(/\n/g, '<br />') + '</p>');
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list && list.items.length) {
      out.push(renderListTree(list.items, 0).html);
      list = null;
    }
  };
  const pushListEntry = (tag, depth, text) => {
    if (!list) list = { items: [] };
    list.items.push({ tag, depth, text });
  };

  const tableCells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
  const isTableRow = (line) => /^\|.*\|$/.test(line.trim());
  const isSeparator = (line) => /^\|?[\s:|-]*-{2,}[\s:|-]*\|?$/.test(line.trim()) && line.includes('-');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(heading[1].length + 1, 4);
      out.push('<h' + level + '>' + renderInline(heading[2]) + '</h' + level + '>');
      continue;
    }

    if (/^([-*_])\1{2,}$/.test(trimmed)) {
      flushParagraph();
      flushList();
      out.push('<hr />');
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(trimmed);
    if (quote) {
      flushParagraph();
      flushList();
      out.push('<blockquote>' + renderInline(quote[1]) + '</blockquote>');
      continue;
    }

    // 表格：表头 + 分隔行 + 若干行，整体渲染成一张表。
    if (isTableRow(trimmed) && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      flushParagraph();
      flushList();

      const header = tableCells(trimmed);
      const aligns = tableCells(lines[i + 1]).map((cell) => {
        const left = cell.startsWith(':');
        const right = cell.endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        if (left) return 'left';
        return '';
      });

      const alignAttr = (index) => (aligns[index] ? ' class="align-' + aligns[index] + '"' : '');
      let html = '<div class="table-wrap"><table><thead><tr>' +
        header.map((cell, index) => '<th' + alignAttr(index) + '>' + renderInline(cell) + '</th>').join('') +
        '</tr></thead><tbody>';

      i += 2;
      for (; i < lines.length && isTableRow(lines[i]); i++) {
        const cells = tableCells(lines[i]);
        html += '<tr>' + header.map((_, index) =>
          '<td' + alignAttr(index) + '>' + renderInline(cells[index] || '') + '</td>').join('') + '</tr>';
      }
      i--;
      out.push(html + '</tbody></table></div>');
      continue;
    }

    const bullet = /^([-*+])\s+(.*)$/.exec(trimmed);
    if (bullet) {
      flushParagraph();
      const depth = Math.floor((line.length - line.trimStart().length) / 2);
      pushListEntry('ul', depth, bullet[2]);
      continue;
    }

    const ordered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (ordered) {
      flushParagraph();
      const depth = Math.floor((line.length - line.trimStart().length) / 2);
      pushListEntry('ol', depth, ordered[1]);
      continue;
    }

    if (list) {
      // 列表项的续行
      list.items[list.items.length - 1].text += '\n' + trimmed;
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();
  flushList();
  return out.join('');
}

/** 按缩进还原嵌套列表：两层以上也照原样缩进去。 */
function renderListTree(entries, index) {
  const tag = entries[index].tag;
  let html = '<' + tag + '>';
  const depth = entries[index].depth;

  while (index < entries.length && entries[index].depth >= depth) {
    if (entries[index].depth > depth) {
      const nested = renderListTree(entries, index);
      html += nested.html;
      index = nested.index;
      continue;
    }

    let inner = renderInline(entries[index].text);
    index += 1;

    if (index < entries.length && entries[index].depth > depth) {
      const nested = renderListTree(entries, index);
      inner += nested.html;
      index = nested.index;
    }

    html += '<li>' + inner + '</li>';
  }

  return { html: html + '</' + tag + '>', index };
}

function blocksFromMessage(message) {
  const content = message && message.content;
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) return [];
  return content.map((block) => {
    if (block.type === 'text') return { type: 'text', text: block.text || '' };
    if (block.type === 'thinking') return { type: 'thinking', text: block.thinking || '' };
    if (block.type === 'toolCall') {
      return {
        type: 'toolCall',
        id: block.id,
        name: block.name,
        args: block.arguments || {},
        argsText: JSON.stringify(block.arguments || {}, null, 2),
        output: '',
        running: false,
        done: false,
        interrupted: Boolean(block.interrupted),
        isError: false,
        durationMs: null,
      };
    }
    if (block.type === 'image') {
      return { type: 'image', url: 'data:' + block.mimeType + ';base64,' + block.data };
    }
    return null;
  }).filter(Boolean);
}

/** 一段步骤算不算「还在跑」：有结果算完成，被中断的不算在跑，两者都不是的才是在跑。 */
function stepRunning(entry) {
  return entry.kind === 'tool' && !entry.block.done && !entry.block.interrupted;
}

function messageTimestamp(message) {
  const value = message && message.timestamp;
  return typeof value === 'number' && value > 0 ? value : 0;
}

function buildItems(messages) {
  const items = [];
  const toolIndex = new Map();
  let seq = 0;

  for (const message of messages) {
    if (!message) continue;
    if (message.role === 'user') {
      items.push({
        id: 'i' + seq++,
        kind: 'user',
        text: contentText(message.content),
        images: contentImages(message.content),
        ts: messageTimestamp(message),
      });
    } else if (message.role === 'assistant') {
      const item = {
        id: 'i' + seq++,
        kind: 'assistant',
        blocks: blocksFromMessage(message),
        streaming: false,
        ts: messageTimestamp(message),
        endTs: messageTimestamp(message) + (Number(message.durationMs) || 0),
      };
      items.push(item);
      for (const block of item.blocks) {
        if (block.type === 'toolCall' && block.id) toolIndex.set(block.id, { item, block });
      }
    } else if (message.role === 'toolResult') {
      const hit = toolIndex.get(message.toolCallId);
      if (hit) {
        hit.block.output = contentText(message.content);
        hit.block.isError = Boolean(message.isError);
        hit.block.done = true;
        // 每步耗时一直是 Pi 随结果一起给的，历史里没往界面传，所以完成之后只剩步数。
        hit.block.durationMs =
          typeof message.durationMs === 'number' ? Math.round(message.durationMs) : null;
        const end = messageTimestamp(message);
        if (end) hit.item.endTs = Math.max(hit.item.endTs || 0, end);
      }
    }
  }

  return { items, toolIndex };
}

/* ------------------------------------------------------------------ *
 * 渲染：会话列表
 * ------------------------------------------------------------------ */

function dateGroup(ms) {
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ms >= startOfToday) return '今天';
  if (ms >= startOfToday - 86_400_000) return '昨天';
  if (ms >= startOfToday - 7 * 86_400_000) return '本周';
  return '更早';
}

function renderSessionList() {
  const typed = app.filter.trim();
  const filter = typed.toLowerCase();
  // Seven Station Core 带回搜索结果时按内容命中显示，否则只在本地按标题过滤。
  const searching = Boolean(typed) && app.searchResults?.query === typed;
  const pool = searching ? app.searchResults.items : app.sessions;
  const groups = new Map();

  for (const conversation of pool) {
    if (filter && !searching) {
      const haystack = [(conversation.title || ''), conversation.cwd].join(' ').toLowerCase();
      if (!haystack.includes(filter)) continue;
    }
    const label = searching ? '搜索结果' : dateGroup(conversation.updatedAt);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(conversation);
  }

  el.navCount.textContent = app.sessions.length ? String(app.sessions.length) : '';


  el.sessionList.innerHTML = '';

  if (searching && groups.size) {
    const hint = document.createElement('div');
    hint.className = 'group-label';
    hint.textContent = '按内容命中 ' + pool.length + ' 条';
    el.sessionList.appendChild(hint);
  }

  if (!groups.size) {
    const empty = document.createElement('div');
    empty.className = 'group-label';
    empty.textContent = typed ? '没有匹配的对话' : '还没有对话';
    el.sessionList.appendChild(empty);
    return;
  }

  for (const [label, conversations] of groups) {
    if (!searching) {
      const groupLabel = document.createElement('div');
      groupLabel.className = 'group-label';
      groupLabel.textContent = label;
      el.sessionList.appendChild(groupLabel);
    }

    for (const conversation of conversations) {
      const item = document.createElement('div');
      item.className = 'session-item' + (conversation.id === app.currentKey ? ' active' : '');
      item.title = conversation.cwd;

      const open = document.createElement('div');
      open.className = 'session-open';
      open.setAttribute('role', 'button');
      open.setAttribute('tabindex', '0');
      const marker = conversation.working
        ? '<span class="session-spin" aria-hidden="true" style="animation-delay:' + spinPhase(900) + '"></span>'
        : '<span class="session-dot' + (conversation.status === 'ready' ? ' is-ready' : '') +
          '" aria-hidden="true"></span>';
      open.innerHTML =
        '<span class="session-gutter">' + marker + '</span>' +
        '<span class="session-text">' +
        '<span class="name">' + escapeHtml(conversation.title || '新对话') + '</span>' +
        '<span class="row2"><span class="ws">' + escapeHtml(baseName(conversation.cwd) || '未知目录') + '</span>' +
        '<span class="time">' + relativeTime(conversation.updatedAt) + '</span></span>' +
        (conversation.snippet
          ? '<span class="row3">' + escapeHtml(conversation.snippet) + '</span>'
          : '') +
        '</span>';
      open.addEventListener('click', () => openSession(conversation));
      open.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openSession(conversation);
      });

      // 删除键跟「几分钟前」占同一个位置：悬浮时时间淡出，换成这个圆角图标键。
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'session-delete';
      remove.title = '删除对话';
      remove.setAttribute('aria-label', '删除对话');
      remove.innerHTML =
        '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.6 4.6l6.8 6.8M11.4 4.6l-6.8 6.8"/></svg>';
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        confirmDelete(conversation);
      });
      open.querySelector('.row2').appendChild(remove);
      item.appendChild(open);

      el.sessionList.appendChild(item);
    }
  }
}

function confirmDelete(conversation) {
  closeModal();
  const card = document.createElement('div');
  card.className = 'modal';

  const title = document.createElement('h3');
  title.textContent = '删除这个对话';
  card.appendChild(title);

  const note = document.createElement('div');
  note.className = 'modal-message';
  note.textContent = '「' + (conversation.title || '未命名对话') + '」会从列表里移除，Pi 那边的原始记录还在。';
  card.appendChild(note);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  const cancel = document.createElement('button');
  cancel.className = 'ghost-btn';
  cancel.textContent = '取消';
  cancel.addEventListener('click', closeModal);

  const remove = document.createElement('button');
  remove.className = 'primary-btn danger';
  remove.textContent = '删除';
  remove.addEventListener('click', () => {
    closeModal();
    send({ type: 'delete_conversation', id: conversation.id });
    if (app.currentKey === conversation.id) {
      app.currentKey = null;
      app.attachments = [];
      renderAttachments();
      app.sessions = app.sessions.filter((item) => item.id !== conversation.id);
      showWorkspace(false);
      renderSessionList();
    }
  });

  actions.appendChild(cancel);
  actions.appendChild(remove);
  card.appendChild(actions);

  el.modal.innerHTML = '';
  el.modal.appendChild(card);
  el.modal.hidden = false;
}

/* ------------------------------------------------------------------ *
 * 渲染：线程
 * ------------------------------------------------------------------ */

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block && block.type === 'text')
      .map((block) => block.text || '')
      .join('\n');
  }
  return '';
}

function contentImages(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block && block.type === 'image' && block.data)
    .map((block) => 'data:' + (block.mimeType || 'image/png') + ';base64,' + block.data);
}

/** 回合的稳定标识：拿第一条的 id 顶，重画之后还是同一块工作记录。 */
function turnKeyOf(turn) {
  return String(turn?.items?.[0]?.id || '');
}

function turnsOf(session) {
  const turns = [];
  for (const item of session.items) {
    if (item.kind === 'user' || !turns.length) {
      turns.push({ items: [] });
    }
    turns[turns.length - 1].items.push(item);
  }
  return turns;
}

function userNode(item) {
  const wrapper = document.createElement('div');
  wrapper.className = 'msg user';
  wrapper.dataset.item = item.id;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  const md = document.createElement('div');
  md.className = 'md';
  md.innerHTML = renderMarkdown(item.text);
  bubble.appendChild(md);

  if (item.echo) bubble.appendChild(sendStateNode(item));

  if (item.images && item.images.length) {
    const wrap = document.createElement('div');
    wrap.className = 'images';
    for (const url of item.images) {
      const img = document.createElement('img');
      img.src = url;
      wrap.appendChild(img);
    }
    bubble.appendChild(wrap);
  }

  wrapper.appendChild(bubble);
  return wrapper;
}

/**
 * 一轮 = 一条用户消息 + 之后的所有助手动作。
 * 模型还在干活的时候只摆最新那一步；正文一出现就把这些收成一行「工作过程」。
 */
function turnNode(turn, session, isLast) {
  const node = document.createElement('div');
  node.className = 'turn';

  for (const item of turn.items) {
    if (item.kind !== 'user') continue;
    node.appendChild(userNode(item));
  }

  const { ask, segments, images, turnMs } = turnParts(turn);

  const streaming = Boolean(session.streaming) && isLast;
  const base = turnKeyOf(turn);

  const assistant = document.createElement('div');
  assistant.className = 'msg assistant';

  // 按出现顺序画：一段工作，一段正文，又一段工作……
  // 每一段有自己的折叠状态和滚动位置，键里带序号（同一轮可能有好几段工作）。
  segments.forEach((segment, index) => {
    const live = streaming && index === segments.length - 1;

    if (segment.kind === 'work') {
      const since = live ? stampOf(segment.entries[0]) || (ask ? ask.ts : 0) : 0;
      const wrap = workGroup(segment.entries, !live, turnMs, since, session, base + '#' + index);
      wrap.dataset.seg = String(index);
      assistant.appendChild(wrap);
      return;
    }

    const md = document.createElement('div');
    md.className = 'md';
    md.innerHTML = renderMarkdown(segment.text);
    assistant.appendChild(md);
  });

  for (const block of images) {
    const img = document.createElement('img');
    img.src = block.url;
    img.style.maxWidth = '280px';
    img.style.borderRadius = '8px';
    assistant.appendChild(img);
  }

  if (assistant.childElementCount) {
    node.appendChild(assistant);
  }

  return node;
}

/**
 * 把一轮拆成按顺序排的几段：工作 → 正文 → 工作 → 正文……，外加用户提问、图片、耗时。
 *
 * 分段规则是这套界面的关键：**一旦开口回答，前面那段工作就算完结**。
 * 回答之后如果又调工具，那是新的一段工作，排在正文后面，
 * 不能续到回答前面那段上——不然用户分不清哪些步骤在回答前、哪些在回答后（回答多次更明显）。
 */
function turnParts(turn) {
  const segments = [];
  const work = [];
  const texts = [];
  const images = [];

  let group = null;

  for (const item of turn.items) {
    if (item.kind === 'user') continue;
    for (const block of item.blocks || []) {
      // 只有空白（一个空格、一个换行）的正文块不算正文：模型偶尔在思考与工具调用之间
      // 塞一个空格，画出来是空段落，还会把前后两段工作切成两截。
      if (block.type === 'text' && String(block.text || '').trim()) {
        segments.push({ kind: 'text', text: block.text });
        texts.push(block.text);
        group = null;
      } else if (block.type === 'thinking') {
        // 有的模型偶尔给一段空白思考（只有一个空格）。画出来就是一行空步骤，
        // 点开什么都没有，还平白多算一步。干脆不画。
        if (!String(block.text || '').trim()) continue;

        if (!group) {
          group = { kind: 'work', entries: [] };
          segments.push(group);
        }

        const entry = { kind: 'thinking', block, item };
        group.entries.push(entry);
        work.push(entry);
      } else if (block.type === 'toolCall') {
        if (!group) {
          group = { kind: 'work', entries: [] };
          segments.push(group);
        }

        const entry = { kind: 'tool', block, item };
        group.entries.push(entry);
        work.push(entry);
      } else if (block.type === 'image') {
        images.push(block);
      }
    }
  }

  // 一轮的用时按消息自己的时间点算——这个时间点是我们存下来的，不依赖 Pi 现给。
  const ask = turn.items.find((item) => item.kind === 'user');
  let turnMs = null;
  if (ask && ask.ts) {
    let end = 0;
    for (const item of turn.items) {
      if (item.endTs > end) end = item.endTs;
      if (item.ts > end) end = item.ts;
    }
    if (end > ask.ts) turnMs = end - ask.ts;
  }

  return { ask, segments, work, texts, images, turnMs };
}

/** 这一步是什么时候发生的（毫秒），没有就返回 0。 */
function stampOf(entry) {
  const raw = entry?.block?.ts ?? entry?.block?.startedAt ?? entry?.item?.ts ?? entry?.ts;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** 「工作 9 步 · 47 秒」——时间是一轮的实际耗时，不是各步相加。 */
function workLabel(totalMs, count, live) {
  const spent = formatSpent(totalMs);
  const steps = count + ' 步';
  const prefix = live ? '工作中 ' : '工作 ';
  return spent ? prefix + steps + ' · ' + spent : prefix + steps;
}

/**
 * 不足一秒不写：那种一轮本来也没什么可说。
 * 一分钟内写秒，再久写「M 分 S 秒」，一小时以上写「H 小时 M 分」，一天以上写「D 天 H 小时」。
 * 只保留两级：8 小时 30 分 12 秒没人看，卡住的时候「8 小时 30 分」就够了。
 */
function formatSpent(totalMs) {
  if (!(totalMs >= 1000)) return '';

  const total = Math.round(totalMs / 1000);
  if (total < 60) return total + ' 秒';

  if (total < 3600) {
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return seconds ? minutes + ' 分 ' + seconds + ' 秒' : minutes + ' 分';
  }

  if (total < 86400) {
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    return minutes ? hours + ' 小时 ' + minutes + ' 分' : hours + ' 小时';
  }

  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  return hours ? days + ' 天 ' + hours + ' 小时' : days + ' 天';
}

/** 过程区折叠状态挂在会话上：整轮重画之后要能恢复（节点一换就回弹的老毛病）。 */
function uiOf(session) {
  if (!session.ui) session.ui = { work: new Map() };
  return session.ui;
}

/**
 * 每一轮过程区滚到哪儿了（贴不贴底、翻上去时停在什么位置）。
 * 过程区现在自己滚动，整轮重画（换步、断线回来）以后位置和「贴底跟随」都要接上。
 */
const workScroll = new Map();

function rememberScroll(key, value) {
  if (!key) return;
  workScroll.set(key, value);
  if (workScroll.size > 200) workScroll.delete(workScroll.keys().next().value);
}

/** 这个小滚动区是不是贴着底（跟 thread 那个 atBottom 是两回事）。 */
function nearBottom(box) {
  return box.scrollHeight - box.scrollTop - box.clientHeight < 24;
}

/** 工具的种类决定图标和行首那两个字；没登记过的用加号兜底。 */
const STEP_KINDS = {
  bash: { label: '执行命令', icon: 'term' },
  shell: { label: '执行命令', icon: 'term' },
  read: { label: '读取文件', icon: 'read' },
  write: { label: '写入文件', icon: 'write' },
  edit: { label: '修改文件', icon: 'edit' },
  multi_edit: { label: '修改文件', icon: 'edit' },
  grep: { label: '搜索内容', icon: 'find' },
  search: { label: '搜索内容', icon: 'find' },
  glob: { label: '找文件', icon: 'find' },
  list_dir: { label: '列目录', icon: 'find' },
  web_search: { label: '搜索网页', icon: 'web' },
  fetch_content: { label: '打开网页', icon: 'web' },
  get_search_content: { label: '读搜索结果', icon: 'web' },
  todo: { label: '列计划', icon: 'list' },
  thinking: { label: '思考', icon: 'think' },
};

const STEP_ICONS = {
  term: '<path d="M5 6.5 8.5 10 5 13.5"/><path d="M11.5 14h7"/>',
  read: '<path d="M6.5 4.5h7l4 4v11h-11z"/><path d="M9.5 12h5M9.5 15.5h5"/>',
  write: '<path d="M6.5 4.5h11v15h-11z"/><path d="M9.5 9h5M9.5 12.5h5M9.5 16h3"/>',
  edit: '<path d="M6.5 4.5h7l4 4v11h-11z"/><path d="M13.5 4.5v4h4"/><path d="M9.5 14.5h5"/>',
  find: '<circle cx="11" cy="10.5" r="5.2"/><path d="m15 14.5 4 4"/>',
  web: '<circle cx="12" cy="12" r="7.5"/><path d="M4.5 12h15M12 4.5c2.2 2.4 2.2 12.6 0 15M12 4.5c-2.2 2.4-2.2 12.6 0 15"/>',
  list: '<path d="M5 7h3M10 7h9M5 12h3M10 12h9M5 17h3M10 17h9"/>',
  think: '<path d="M12 4.5a5.2 5.2 0 0 1 3.2 9.3c-.5.4-.7.9-.7 1.4v.3H9.5v-.3c0-.5-.2-1-.7-1.4A5.2 5.2 0 0 1 12 4.5Z"/><path d="M10 18.5h4"/>',
  other: '<path d="M12 5.5v13M5.5 12h13"/>',
};

function stepKindKey(entry) {
  if (entry.kind === 'thinking') return 'thinking';
  const name = String(entry.block?.name || '');
  return STEP_KINDS[name] ? name : 'other';
}

function stepMeta(entry) {
  return STEP_KINDS[stepKindKey(entry)] || { label: toolLabel(entry.block?.name) || '工具', icon: 'other' };
}

function stepIcon(icon) {
  return '<svg viewBox="0 0 24 24" aria-hidden="true">' + (STEP_ICONS[icon] || STEP_ICONS.other) + '</svg>';
}

/** 一行只有一句摘要：路径留尾巴，命令压成一行，思考截前 60 个字。 */
function stepSummaryText(entry) {
  if (entry.kind === 'thinking') {
    return { text: String(entry.block?.text || '').replace(/\s+/g, ' ').trim().slice(0, 60), mono: false };
  }

  const block = entry.block || {};
  const args = block.args || {};
  const path = args.path || args.file_path;
  if (typeof path === 'string' && path) return { text: shortenPath(path), mono: true };

  const raw = [args.command, args.pattern, args.query, args.url, args.directory]
    .find((value) => typeof value === 'string' && value.trim());
  if (raw) {
    const flat = String(raw).replace(/\s+/g, ' ').trim();
    return { text: flat.length > 90 ? flat.slice(0, 90) + '…' : flat, mono: true };
  }

  if (block.running) return { text: '进行中…', mono: false };
  if (block.isError) return { text: '出错', mono: false };
  return { text: '', mono: false };
}

/** 右边只留一个记号：打勾、转圈、感叹号、中断的横杠。 */
function stepStateNode(entry) {
  const span = document.createElement('span');
  span.className = 'st-state';

  if (stepRunning(entry)) {
    const spin = document.createElement('span');
    spin.className = 'spin';
    spin.style.animationDelay = spinPhase(900);
    span.appendChild(spin);
    span.title = '正在跑';
    return span;
  }

  if (entry.block?.isError) {
    span.classList.add('is-error');
    span.textContent = '!';
    span.title = '这一步出错了';
    return span;
  }

  if (entry.block?.interrupted && !entry.block?.done) {
    span.classList.add('is-aborted');
    span.textContent = '—';
    span.title = '这一轮被中断了';
    return span;
  }

  span.classList.add('is-ok');
  span.textContent = '✓';
  span.title = '完成';
  return span;
}

/** 合并起来的一组，状态取最显眼的那条：还在跑 > 出错 > 最后一条。 */
function groupStateEntry(entries) {
  return entries.find((entry) => stepRunning(entry))
    || entries.find((entry) => entry.block?.isError)
    || entries[entries.length - 1];
}

/** 连续同类合并成「执行命令 ×3」。思考和没登记的工具不合并。 */
function groupWork(work) {
  const rows = [];
  for (const entry of work) {
    const kind = stepKindKey(entry);
    const last = rows[rows.length - 1];
    if (kind !== 'thinking' && kind !== 'other' && last && last.kind === kind) {
      last.entries.push(entry);
      continue;
    }
    rows.push({ kind, entries: [entry] });
  }
  return rows;
}

/** 展开一行的时候把别的收起来，同一块里只留一个开着的。 */
function workGroup(work, collapsed, turnMs, since, session, turnKey) {
  const wrap = document.createElement('div');
  wrap.className = 'work';
  wrap.dataset.key = turnKey || '';

  const ui = session ? uiOf(session) : null;

  // 还在跑的按开始到现在算，每秒跟着刷新；跑完的算这一段自己的跨度。
  // 别拿整轮耗时：一轮里可能有好几段工作，拿整轮的数会看着像这段干了那么久。
  const live = since > 0;
  const first = stampOf(work[0]);
  const tail = stampOf(work[work.length - 1]);
  const span = first && tail && tail >= first ? tail - first : 0;
  const totalMs = live
    ? Date.now() - since
    : span > 0
      ? span
      : work.reduce((sum, entry) => sum + (entry.block.durationMs || 0), 0) || turnMs || 0;

  const head = document.createElement('button');
  head.className = 'work-head';
  if (live) {
    head.dataset.since = String(since);
    head.dataset.steps = String(work.length);
  }
  head.innerHTML =
    '<span class="work-caret">▸</span>' +
    '<span class="work-title">' + escapeHtml(workLabel(totalMs, work.length, live)) + '</span>';

  const rows = groupWork(work);
  const key = turnKey || '';

  const scroll = document.createElement('div');
  scroll.className = 'work-scroll';

  const body = document.createElement('div');
  body.className = 'work-body';
  rows.forEach((row, index) => body.appendChild(workRowNode(rows, index)));

  // 翻上去了才浮出来：新出几条、点一下回到最下面。
  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'work-latest';
  pill.hidden = true;
  pill.innerHTML =
    '<span class="work-latest-arrow" aria-hidden="true">↓</span>' +
    '<span>回到最新</span>' +
    '<span class="work-latest-count"></span>';

  scroll.append(body, pill);

  const saved = workScroll.get(key);
  let stuck = Boolean(saved && saved.stuck);
  let seen = saved ? saved.seen : rows.length;

  const syncPill = () => {
    const fresh = rows.length - seen;
    pill.hidden = !stuck;
    pill.querySelector('.work-latest-count').textContent = stuck && fresh > 0 ? fresh + ' 条' : '';
    scroll.classList.toggle('is-scrolled', stuck);
  };

  const save = () => rememberScroll(key, { stuck, seen, top: body.scrollTop });

  // 贴底就跟着新的走，用户往上翻就冻住——别抢人家的视线。
  body.addEventListener('scroll', () => {
    stuck = !nearBottom(body);
    if (!stuck) seen = rows.length;
    syncPill();
    save();
  }, { passive: true });

  pill.addEventListener('click', () => {
    stuck = false;
    seen = rows.length;
    body.scrollTop = body.scrollHeight;
    syncPill();
    save();
  });

  // 新的一步进来（就地更新那条路会调它）。
  wrap.follow = () => {
    if (stuck) {
      syncPill();
      return;
    }
    seen = rows.length;
    body.scrollTop = body.scrollHeight;
  };

  // 首帧：上次翻上去就回到原位，否则贴底。
  requestAnimationFrame(() => {
    body.scrollTop = stuck ? Number(saved && saved.top) || 0 : body.scrollHeight;
    syncPill();
  });

  const setOpen = (value, silent) => {
    wrap.classList.toggle('is-collapsed', !value);
    scroll.hidden = !value;
    head.querySelector('.work-caret').textContent = value ? '▾' : '▸';
    if (!silent && ui && turnKey) ui.work.set(turnKey, value);
  };

  // 上回点开的就按上回的开着，没点过才按默认：跑着展开、跑完收起。
  const stored = ui && turnKey ? ui.work.get(turnKey) : undefined;
  setOpen(typeof stored === 'boolean' ? stored : !collapsed, true);
  head.addEventListener('click', () => setOpen(wrap.classList.contains('is-collapsed')));

  wrap.appendChild(head);
  wrap.appendChild(scroll);
  return wrap;
}

/**
 * 一行：图标 + 种类 + 摘要 + 状态记号。点一下在它下面展开这一步的完整内容。
 * 详情待在过程区自己的滚动框里，长输出在里面滚，不会把整轮撑变形。
 */
function workRowNode(rows, index) {
  const row = rows[index];
  const many = row.entries.length > 1;
  const first = row.entries[0];
  const last = row.entries[row.entries.length - 1];
  const meta = stepMeta(first);
  const summary = stepSummaryText(first);
  const state = groupStateEntry(row.entries);

  const item = document.createElement('div');
  item.className = 'st-item';
  item.dataset.step = String(first.block?.id || '');
  item.rowData = row;

  const node = document.createElement('div');
  node.className = 'st-row' + (row.kind === 'thinking' ? ' is-thinking' : '');
  node.dataset.step = String(first.block?.id || '');
  node.dataset.lastStep = String(last.block?.id || '');

  node.innerHTML =
    '<span class="st-icon">' + stepIcon(meta.icon) + '</span>' +
    '<span class="st-name">' + escapeHtml(meta.label) + '</span>' +
    (many ? '<span class="st-count">×' + row.entries.length + '</span>' : '') +
    '<span class="st-sum' + (summary.mono ? ' mono' : '') + '">' + escapeHtml(summary.text) + '</span>' +
    '<span class="st-open" aria-hidden="true">详情</span>';

  node.tabIndex = 0;
  node.setAttribute('role', 'button');
  node.title = '点开看这一步的完整内容';
  node.addEventListener('click', () => toggleStepDetail(item));
  node.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      node.click();
    }
  });

  // 读写过的路径点一下在右侧文件面板打开，省得自己去目录里翻（别连弹窗一起开）。
  const targetPath = first.block?.args?.path || first.block?.args?.file_path;
  const sum = node.querySelector('.st-sum');
  if (typeof targetPath === 'string' && targetPath && sum) {
    sum.classList.add('is-link');
    sum.title = '在文件面板里打开 ' + targetPath;
    sum.addEventListener('click', (event) => {
      event.stopPropagation();
      openPathInPanel(targetPath);
    });
  }

  node.appendChild(stepStateNode(state));

  const detail = document.createElement('div');
  detail.className = 'st-more';
  detail.hidden = true;

  item.append(node, detail);
  return item;
}

/** 右侧文件面板打开一个路径。 */
function openPathInPanel(targetPath) {
  const session = current();
  if (!session) return;

  el.filePanel.hidden = false;
  document.querySelector('.main').classList.add('files-open');
  el.filesPath.textContent = '/' + targetPath;
  el.filesPath.title = '/' + targetPath;
  el.filesBody.innerHTML = '<div class="files-note">读取中…</div>';
  send({ type: 'read_file', key: session.key, path: targetPath });
}

/* ────────────────────────── 步骤详情（就地展开） ────────────────────────── *
 * 点一行，它下面直接展开这一步的全部内容：命令、输出、改动、耗时。
 * 不用独立窗口——那是另一个「页面」，压在对话上、还要自己记住翻到哪；
 * 就地展开也不会把整轮撑变形，因为它待在过程区自己的滚动框里，长输出在里面滚。
 * 同一时间只开一条。
 */

let openStep = null;

/** 状态说人话：详情里可以写字，不像行尾只有一个记号。 */
function stepStateText(entry) {
  if (stepRunning(entry)) return { text: '正在跑', cls: '' };
  if (entry.block?.isError) return { text: '出错', cls: 'is-error' };
  if (entry.block?.interrupted && !entry.block?.done) return { text: '被中断', cls: 'is-aborted' };
  return { text: '完成', cls: 'is-ok' };
}

/** 这一步是什么时候发生的，没有时间戳就留空。 */
function clockOf(entry) {
  const value = stampOf(entry);
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return String(date.getHours()).padStart(2, '0') + ':' +
    String(date.getMinutes()).padStart(2, '0') + ':' +
    String(date.getSeconds()).padStart(2, '0');
}

function closeStepDetail() {
  if (!openStep) return;
  openStep.detail.hidden = true;
  openStep.item.classList.remove('is-open');
  openStep = null;
}

function openStepDetail(item) {
  const detail = item.querySelector('.st-more');
  if (!detail || !item.rowData) return;
  renderStepDetail(detail, item.rowData);
  detail.hidden = false;
  item.classList.add('is-open');
  openStep = { item, detail, key: item.closest('.work')?.dataset.key || '', step: item.dataset.step || '' };
}

function toggleStepDetail(item) {
  const detail = item.querySelector('.st-more');

  if (openStep && openStep.detail === detail) {
    closeStepDetail();
    return;
  }

  closeStepDetail();
  openStepDetail(item);
}

/**
 * 整轮重画（新步骤、正文流式、会话刷新）之后，把用户原本展开着的那一条原样挂回去。
 * 以前重画就等于「自动收起」，还在工作的时候一有新步骤就把人看的那条关掉。
 */
function restoreOpenDetail() {
  if (!openStep) return;

  const wanted = { key: openStep.key, step: openStep.step };
  openStep = null;
  if (!wanted.step) return;

  const wrap = Array.from(el.thread.querySelectorAll('.work')).find((node) => node.dataset.key === wanted.key);
  if (!wrap) return;

  const item = Array.from(wrap.querySelectorAll('.st-item')).find((node) => node.dataset.step === wanted.step);
  if (item) openStepDetail(item);
}

/** 详情里那张卡片：状态、耗时、目录，然后是这一组的全部内容。 */
function renderStepDetail(detail, row) {
  if (!row) return;

  const first = row.entries[0];
  const meta = stepMeta(first);
  const state = groupStateEntry(row.entries);
  const status = stepStateText(state);
  const duration = row.entries.reduce((sum, entry) => sum + (entry.block.durationMs || 0), 0);
  const cwd = current()?.cwd || '';

  // 正在跑的那条会不停刷新，别把里面的滚动位置刷没了。
  const keep = (() => {
    const body = detail.querySelector('.st-more-body');
    return body ? body.scrollTop : 0;
  })();

  detail.innerHTML = '';

  const line = document.createElement('div');
  line.className = 'st-more-meta';
  const statusNode = document.createElement('span');
  statusNode.className = status.cls;
  statusNode.textContent = status.text;
  line.appendChild(statusNode);
  if (duration > 0) {
    const used = document.createElement('span');
    used.textContent = '用时 ' + formatDuration(duration);
    line.append('·', used);
  }
  const clock = clockOf(first);
  if (clock) {
    const when = document.createElement('span');
    when.textContent = clock;
    line.append('·', when);
  }
  if (cwd) {
    const where = document.createElement('span');
    where.className = 'st-more-cwd';
    where.textContent = cwd;
    line.append('·', where);
  }

  const body = document.createElement('div');
  body.className = 'st-more-body';
  for (const entry of row.entries) {
    if (row.entries.length > 1) {
      const tag = document.createElement('div');
      tag.className = 'st-more-tag';
      const stamp = clockOf(entry);
      tag.textContent = (stamp ? stamp + ' · ' : '') + stepStateText(entry).text;
      body.appendChild(tag);
    }

    if (row.kind === 'thinking') {
      const pre = document.createElement('pre');
      pre.className = 'st-more-code';
      pre.textContent = String(entry.block?.text || '');
      body.appendChild(pre);
    } else {
      const block = document.createElement('div');
      block.className = 'st-more-block';
      appendSections(block, entry.block || {});
      body.appendChild(block);
    }
  }

  detail.append(line, body);
  body.scrollTop = keep;
}

/** 这一步正在被更新：展开着就把内容也换新（跑着的输出会一直长）。 */
function refreshStepDetail(entry) {
  if (!openStep) return;
  const row = openStep.item.rowData;
  if (!row || !row.entries.some((candidate) => candidate.block === entry.block)) return;
  renderStepDetail(openStep.detail, row);
}

/** Esc 收掉展开的那一条。 */
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && openStep) closeStepDetail();
});

/** 单步耗时：一分钟内带一位小数，再久就跟「工作 X」用同一套换算（长命令别写成 612.4 秒）。 */
function formatDuration(ms) {
  if (!(ms >= 1000)) return Math.round(ms) + ' 毫秒';
  if (ms < 60000) return (ms / 1000).toFixed(1) + ' 秒';
  return formatSpent(ms);
}

/** 正文里的路径太长时只留尾巴，前面用省略号，别让一行被路径撑满。 */
function shortenPath(value) {
  const text = String(value || '').replace(/\\/g, '/');
  const cwd = (current()?.cwd || '').replace(/\\/g, '/');
  if (cwd && text.toLowerCase().startsWith(cwd.toLowerCase() + '/')) {
    return text.slice(cwd.length + 1);
  }
  return text.length > 58 ? '…' + text.slice(-57) : text;
}

/** 输出太长就掐头留尾，中间标出省略了多少行——比让人翻几千行强。 */
function trimOutput(value, head = 60, tail = 20) {
  const text = String(value ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
  const lines = text.split('\n');
  if (lines.length <= head + tail) return text;
  const skipped = lines.length - head - tail;
  return lines.slice(0, head).join('\n') + '\n…省略 ' + skipped + ' 行…\n' + lines.slice(-tail).join('\n');
}

/** 把一条工具调用翻成人话：给几段「标签 + 内容」，前端照着排。 */
function toolSections(block) {
  const args = block.args || {};
  const sections = [];
  const add = (label, text, mono = true) => {
    if (text === undefined || text === null || text === '') return;
    sections.push({ label, text: String(text), mono });
  };

  const path = args.path || args.file_path;
  const output = block.output;

  switch (block.name) {
    case 'read': {
      add('文件', path);
      const from = Number(args.offset) || 0;
      const count = Number(args.limit) || 0;
      if (from || count) {
        add('范围', '第 ' + (from + 1) + ' 行起' + (count ? '，共 ' + count + ' 行' : ''));
      }
      add('内容', trimOutput(output));
      break;
    }
    case 'write': {
      add('写入', path);
      add('内容', trimOutput(args.content));
      add('结果', block.isError ? '' : '已写入');
      break;
    }
    case 'edit':
    case 'multi_edit': {
      add('修改', path);
      const edits = Array.isArray(args.edits) ? args.edits : [args];
      for (const [index, edit] of edits.entries()) {
        if (edits.length > 1) add('第 ' + (index + 1) + ' 处', '');
        add('- 原来', trimOutput(edit.oldText ?? edit.old_string, 30, 6));
        add('+ 换成', trimOutput(edit.newText ?? edit.new_string, 30, 6));
      }
      break;
    }
    case 'bash':
    case 'shell': {
      add('命令', args.command);
      add(block.isError ? '输出（出错）' : '输出', trimOutput(output));
      break;
    }
    case 'web_search': {
      add('查询', args.queries ? [].concat(args.queries).join('、') : args.query);
      add('结果', trimOutput(output));
      break;
    }
    case 'fetch_content': {
      add('地址', args.url || (args.urls ? [].concat(args.urls).join('\n') : ''));
      add('结果', trimOutput(output));
      break;
    }
    case 'grep':
    case 'search': {
      add('模式', args.pattern || args.query);
      add('目录', path);
      add('结果', trimOutput(output));
      break;
    }
    case 'glob':
    case 'list_dir': {
      add('要找', args.pattern);
      add('目录', path || args.directory);
      add('结果', trimOutput(output));
      break;
    }
    default: {
      const keys = Object.keys(args);
      if (keys.length) add('参数', JSON.stringify(args, null, 2));
      add(block.isError ? '输出（出错）' : '输出', trimOutput(output));
    }
  }

  // 兜底：哪个分支都没给出内容、但确实有输出，就把输出放上。
  if (!sections.some((section) => section.label !== '结果' && section.label !== '范围' && section.text)) {
    add('输出', trimOutput(output));
  }
  return sections.filter((section) => section.text !== '' || section.label.startsWith('第 '));
}

/** 工具详情只摆内容：命令、输出、改了哪几行——行头在步骤行上，这里不再重复。 */
function appendSections(container, block) {
  for (const section of toolSections(block)) {
    if (section.label) {
      const label = document.createElement('div');
      label.className = 'st-label';
      label.textContent = section.label;
      container.appendChild(label);
    }

    const pre = document.createElement('pre');
    pre.className = 'st-code';
    if (section.label === '- 原来') pre.classList.add('is-removed');
    if (section.label === '+ 换成') pre.classList.add('is-added');
    if (block.isError && section.label.startsWith('输出')) pre.classList.add('err-text');
    pre.textContent = section.text;
    container.appendChild(pre);
  }

  if (!container.childNodes.length) {
    const empty = document.createElement('div');
    empty.className = 'st-label';
    empty.textContent = block.running ? '进行中…' : '没有更多细节';
    container.appendChild(empty);
  }
}

const TOOL_LABELS = {
  read: '读',
  write: '写',
  edit: '改',
  multi_edit: '改',
  bash: 'bash',
  shell: 'bash',
  web_search: '搜索',
  fetch_content: '取网页',
  get_search_content: '读搜索结果',
  list_dir: '列目录',
  grep: '搜文件',
  glob: '找文件',
  todo: '列计划',
};

function toolLabel(name) {
  if (!name) return '工具';
  return TOOL_LABELS[name] || name;
}

function toolSummary(block) {
  const args = block.args || {};
  const path = args.path || args.file_path;
  if (typeof path === 'string' && path) {
    const limit = Number(args.limit) || 0;
    const offset = Number(args.offset) || 0;
    const range = limit || offset ? ' · 第 ' + (offset + 1) + ' 行' + (limit ? '起 ' + limit + ' 行' : '起') : '';
    return shortenPath(path) + range;
  }

  const pick = args.command || args.pattern || args.query || args.url;
  if (typeof pick === 'string' && pick) {
    const flat = pick.replace(/\s+/g, ' ').trim();
    return flat.length > 110 ? flat.slice(0, 110) + '…' : flat;
  }

  if (block.running) return '进行中…';
  if (block.isError) return '出错';
  return '';
}

/**
 * 画整段对话。<paramref name="keepAnchor"/> 为真时保住「离底部还有多远」，
 * 往前翻页时用，免得内容从顶部插进来把视线弹走。
 */
function renderThread(keepAnchor) {
  const session = current();
  const anchor = keepAnchor && session ? el.thread.scrollHeight - el.thread.scrollTop : 0;
  // 同一个会话重画：原来贴底才跟着到底，否则原地不动（不然一有事件就把人拽回底部）。
  const sameSession = app.renderedKey === (session ? session.key : null);
  const stayAtBottom = !sameSession || atBottom();
  app.turnNodes = [];
  el.threadInner.innerHTML = '';
  if (!session) return;

  if (session.hasMore) el.threadInner.appendChild(olderRow(session));

  const turns = turnsOf(session);
  turns.forEach((turn, index) => {
    const node = turnNode(turn, session, index === turns.length - 1);
    app.turnNodes.push({ items: turn.items, node });
    el.threadInner.appendChild(node);
  });

  if (keepAnchor) {
    el.thread.scrollTop = el.thread.scrollHeight - anchor;
  } else if (stayAtBottom) {
    scrollToBottom(true);
  }

  app.renderedKey = session ? session.key : null;
  restoreOpenDetail();
  renderQueue();
}

/* ------------------------------ 追加输入 ------------------------------ *
 * 工作中回车的话先落在 Core 的队列里，这里只画那份状态：
 * 能看到、能改、能删，这一轮结束后 Core 依次送出。
 * -------------------------------------------------------------------- */

const ICON_EDIT =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.6 2.9l2.5 2.5-7.2 7.2-2.9.4.4-2.9z"/><path d="M9.4 4.1l2.5 2.5"/></svg>';
const ICON_CHECK =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.4 8.4l3 3 6.2-6.8"/></svg>';
const ICON_CANCEL =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.6 4.6l6.8 6.8M11.4 4.6l-6.8 6.8"/></svg>';

let queueEditId = null;

function renderQueue() {
  const session = current();
  const entries = (session && session.queue) || [];

  el.queuePanel.hidden = entries.length === 0;
  if (!entries.length) {
    if (el.queueList.childElementCount) el.queueList.innerHTML = '';
    return;
  }

  if (queueEditId && !entries.some((entry) => entry.id === queueEditId)) {
    queueEditId = null;
    el.input.value = '';
    rememberDraft();
    autoGrow();
    updateSendReady();
  }

  const editing = queueEditId ? entries.findIndex((entry) => entry.id === queueEditId) : -1;
  el.queueTitle.textContent = editing >= 0
    ? '正在编辑第 ' + (editing + 1) + ' 条 · Enter 保存，Esc 取消'
    : '已追加 ' + entries.length + ' 条 · 送出前可以改';

  // 条目集合没变就只改文字：编辑到一半被整段重建会掉焦点。
  const shown = [...el.queueList.children].map((node) => node.dataset.id);
  const wanted = entries.map((entry) => entry.id);
  if (shown.join('\u0000') !== wanted.join('\u0000')) {
    el.queueList.innerHTML = '';
    for (const entry of entries) {
      const row = queueRow(entry);
      row.classList.toggle('is-editing', entry.id === queueEditId);
      el.queueList.appendChild(row);
    }
  } else {
    entries.forEach((entry, index) => {
      const node = el.queueList.children[index];
      const label = node.querySelector('.queue-index');
      if (label) label.textContent = String(index + 1);
      node.classList.toggle('is-editing', entry.id === queueEditId);
      const text = node.querySelector('.queue-text');
      if (text) text.textContent = entry.text;
    });
  }
}

function queueRow(entry) {
  const row = document.createElement('li');
  row.className = 'queue-item';
  row.dataset.id = entry.id;
  row.innerHTML =
    '<span class="queue-index"></span>' +
    '<span class="queue-text"></span>' +
    '<div class="queue-actions">' +
    '<button class="queue-btn" type="button" data-act="edit" title="编辑" aria-label="编辑">' + ICON_EDIT + '</button>' +
    '<button class="queue-btn danger" type="button" data-act="remove" title="取消这条" aria-label="取消这条">' + ICON_CANCEL + '</button>' +
    '</div>';
  row.querySelector('.queue-text').textContent = entry.text;

  row.addEventListener('click', (event) => {
    const action = event.target.closest('[data-act]');
    if (!action) return;
    if (action.dataset.act === 'edit') startQueueEdit(row, entry);
    if (action.dataset.act === 'remove') send({ type: 'queue_remove', key: app.currentKey, id: entry.id });
  });

  return row;
}

/**
 * 编辑 = 取回输入框：内容落到下面那条输入框里改，回车保存回原来的位置。
 * 面板里不再内联一个 textarea——那儿本来就只有一行高，改长句子看不到前文。
 */
function startQueueEdit(row, entry) {
  if (queueEditId === entry.id) {
    el.input.focus();
    return;
  }

  queueEditId = entry.id;
  el.input.value = entry.text;
  autoGrow();
  updateSendReady();
  el.input.focus();
  el.input.setSelectionRange(entry.text.length, entry.text.length);
  renderQueue();
}

/** 退出编辑态。silent 用于「条目已经不在队列里」这种被动退出。 */
function finishQueueEdit(silent) {
  queueEditId = null;
  if (!silent) {
    el.input.value = '';
    autoGrow();
    updateSendReady();
  }
  renderQueue();
}

el.queueClear.addEventListener('click', () => {
  send({ type: 'queue_clear', key: app.currentKey });
});

/** 顶部那行「加载更早的消息」：只在 Seven Station Core 说上面还有的时候出现。 */
function olderRow(session) {
  const row = document.createElement('div');
  row.className = 'older-row';
  const button = document.createElement('button');
  button.className = 'ghost-btn small';
  button.textContent = session.loadingOlder ? '正在读…' : '加载更早的消息';
  button.disabled = Boolean(session.loadingOlder);
  button.addEventListener('click', () => loadOlder());
  row.appendChild(button);
  return row;
}

function loadOlder() {
  const session = current();
  if (!session || !session.hasMore || session.loadingOlder) return;
  session.loadingOlder = true;
  const button = el.threadInner.querySelector('.older-row button');
  if (button) {
    button.textContent = '正在读…';
    button.disabled = true;
  }
  send({ type: 'load_older', key: session.key, loaded: session.items.length });
}

function patchItem(item) {
  const session = current();
  if (!session) return;

  const turns = turnsOf(session);
  const index = turns.findIndex((turn) => turn.items.includes(item));
  if (index < 0) {
    renderThread();
    return;
  }

  const turn = turns[index];
  const isLast = index === turns.length - 1;
  const known = app.turnNodes[index];

  if (!known || !known.node.isConnected) {
    renderThread();
    return;
  }

  // 正在跑、还没出正文的那一轮：只就地改最新那一行步骤的文字。
  // 整颗换掉的话，鼠标底下的节点被替换，看起来就是在闪。
  if (isLast && session.streaming && item.kind === 'assistant' && updateLiveTurn(known.node, turn)) {
    known.items = turn.items;
    return;
  }

  const node = turnNode(turn, session, isLast);
  known.node.replaceWith(node);
  known.node = node;
  known.items = turn.items;
  restoreOpenDetail();
}

/**
 * 正在跑的一轮：内容只增不减，所以可以就地更新。
 * 展开着的那一步也不再整轮重画了：只把详情里的内容换掉，节点和展开状态都留着。
 */
/* ------------------------------------------------------------------ *
 * 代码块复制按钮：可见性不靠 CSS :hover 单独撑
 * 流式输出每来一段就把这段正文的 innerHTML 整个换掉，新节点没有 hover 状态，
 * 按钮就会一闪一闪。指针位置记在 app 层，重建之后按位置补回 .is-hover。
 * ------------------------------------------------------------------ */

let pointerPoint = null;
let pendingTextUpdate = null;

document.addEventListener('mousemove', (event) => {
  pointerPoint = { x: event.clientX, y: event.clientY };
  markCodeHover(event.target);
}, { passive: true });

function markCodeHover(target) {
  const block = target && target.closest ? target.closest('.code-block') : null;
  document.querySelectorAll('.code-block.is-hover').forEach((node) => {
    if (node !== block) node.classList.remove('is-hover');
  });
  if (block) block.classList.add('is-hover');
}

function refreshCodeHover() {
  if (!pointerPoint || typeof document.elementFromPoint !== 'function') return;
  const node = document.elementFromPoint(pointerPoint.x, pointerPoint.y);
  markCodeHover(node);

  // 重建之后指针还在原地，按钮应该「立刻就在」，不要淡入一下再亮（那就是闪烁的残留）。
  const block = node && node.closest ? node.closest('.code-block') : null;
  if (block) {
    block.classList.add('is-hover-instant');
    requestAnimationFrame(() => block.classList.remove('is-hover-instant'));
  }
}

/** 选区是不是落在这个节点里（只有非空选区才算，光标停着不算）。 */
function selectionInside(node) {
  const selection = window.getSelection && window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
  const range = selection.getRangeAt(0);
  return node.contains(range.startContainer) || node.contains(range.endContainer);
}

/** 选区离开之后，把刚才攒下的那次正文更新补上。 */
document.addEventListener('selectionchange', () => {
  if (!pendingTextUpdate) return;
  const { node, html } = pendingTextUpdate;
  if (!node.isConnected) {
    pendingTextUpdate = null;
    return;
  }

  if (selectionInside(node)) return;
  pendingTextUpdate = null;
  node.innerHTML = html;
  refreshCodeHover();
});

function updateLiveTurn(node, turn) {
  const assistant = node.querySelector('.msg.assistant');
  if (!assistant) return false;

  const { segments } = turnParts(turn);
  if (!segments.length) return false;

  const last = segments[segments.length - 1];
  const groups = assistant.querySelectorAll('.work');
  const texts = segments.filter((segment) => segment.kind === 'text').length;

  // 正文在长：只换最后一个正文节点的内容，别的（前面的工作段、正文段）一个都不碰。
  if (last.kind === 'text') {
    const mds = assistant.querySelectorAll('.md');
    if (mds.length !== texts) return false;
    const target = mds[mds.length - 1];
    const html = renderMarkdown(last.text);
    // 只有最后那段正文真变了才就地换；别的段变了（压缩后重写历史之类）让它整轮重画去。
    if (target.innerHTML === html) return false;
    // 用户正在这段正文里选字：先别重画，等他选完再补（重画会把选区清掉）。
    if (selectionInside(target)) {
      pendingTextUpdate = { node: target, html };
      return false;
    }

    target.innerHTML = html;
    // 节点是新换的，指针还停在原来的位置上：把代码块的 hover 补回去，别让复制按钮闪。
    refreshCodeHover();
    return true;
  }

  // 最后一段是工作：只动最后那一组，前面的正文和更早的工作段保持原样。
  const wrap = groups[groups.length - 1];
  if (!wrap || wrap.dataset.seg !== String(segments.length - 1)) return false;

  const body = wrap.querySelector('.work-body');
  if (!body) return false;

  const rows = groupWork(last.entries);

  // 步骤数变了。多数情况是「又多了几步」——那就往后追加，
  // 前面的行（包括正展开着详情的那一条）一个都不动；只有变少才重画这一组。
  if (body.children.length !== rows.length) {
    if (body.children.length > rows.length) {
      body.innerHTML = '';
      rows.forEach((row, index) => body.appendChild(workRowNode(rows, index)));
    } else {
      for (let index = body.children.length; index < rows.length; index++) {
        body.appendChild(workRowNode(rows, index));
      }
    }

    if (typeof wrap.follow === 'function') wrap.follow();
    updateWorkHead(wrap, last.entries);
    restoreOpenDetail();
    return true;
  }

  // 每一行都同步一遍，不是只刷新最后一行。
  // 一段里并行发几个工具时，先回来的往往不是最后那一行；只更新最后一行会让它一直转圈，
  // 直到下一次整轮重画才纠正（用户看到的就是「明明跑完了还在进行中」）。
  rows.forEach((row, index) => {
    const node = body.children[index];
    if (!node) return;
    node.rowData = row;
    updateLiveRow(node, row.entries[row.entries.length - 1], row);
  });

  if (typeof wrap.follow === 'function') wrap.follow();
  updateWorkHead(wrap, last.entries);
  return true;
}

/** 工作段标题上那行「工作中 9 步 · 47 秒」跟着走。 */
function updateWorkHead(wrap, entries) {
  const head = wrap.querySelector('.work-head');
  if (!head) return;

  head.dataset.steps = String(entries.length);
  const title = head.querySelector('.work-title');
  if (!title) return;

  const since = Number(head.dataset.since || 0);
  title.textContent = since
    ? workLabel(Date.now() - since, entries.length, true)
    : workLabel(0, entries.length, false);
}

/** 两个状态节点长得一样吗：一样就留着老的，别把动画重置了。 */
/**
 * 转圈动画的相位对齐到墙上时钟。
 * 过程区每来一条事件都可能把这一行（甚至整轮）重画，新建的节点会让 animation 从 0° 重来；
 * 事件密的时候看着就跟卡住一样。用负的 animation-delay 把相位钉在时钟上，
 * 重画多少次看到的都是同一个角度、接着转。
 */
function spinPhase(durationMs) {
  const now = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  return '-' + Math.round(now % durationMs) + 'ms';
}

function sameState(left, right) {
  if (left.className !== right.className) return false;
  if ((left.title || '') !== (right.title || '')) return false;
  if (left.textContent !== right.textContent) return false;
  return Boolean(left.querySelector('.spin')) === Boolean(right.querySelector('.spin'));
}

/** 就地改一行：摘要、条数与状态。内容在展开的详情里，不在这儿铺。 */
function updateLiveRow(row, entry, group) {
  row.dataset.lastStep = String(entry.block?.id || '');

  const summary = stepSummaryText(entry);
  const sum = row.querySelector('.st-sum');
  if (sum) {
    sum.textContent = summary.text;
    sum.classList.toggle('mono', summary.mono);
  }

  // 连续同类会合并成「×3」，新的一条并进来时这个数字要跟着涨。
  const total = group ? group.entries.length : 1;
  const count = row.querySelector('.st-count');
  if (total > 1) {
    if (count) {
      count.textContent = '×' + total;
    } else if (sum) {
      const node = document.createElement('span');
      node.className = 'st-count';
      node.textContent = '×' + total;
      sum.parentElement.insertBefore(node, sum);
    }
  } else if (count) {
    count.remove();
  }

  const state = row.querySelector('.st-state');
  if (state) {
    const next = stepStateNode(entry);
    // 在跑的那一步每来一条事件都会进到这里。状态节点整个换掉 = 转圈动画回到 0°：
    // 事件密的时候看着就像卡住不动（不是 CSS 或后端的锅）。内容一样就别动它。
    if (!sameState(state, next)) state.replaceWith(next);
  }

  // 展开着的详情也跟着换新（正在跑的输出会一直长）。
  refreshStepDetail(entry);
}


/* 24 px 以内才箮「贴底」：以前是 90，稍往下拖一点就被当成在底部，
   于是新步骤一进来就把人拽回去。 */
function atBottom() {
  return el.thread.scrollHeight - el.thread.scrollTop - el.thread.clientHeight < 24;
}

function scrollToBottom(force) {
  if (force || atBottom()) {
    el.thread.scrollTop = el.thread.scrollHeight;
  }
}

function schedule(itemId) {
  app.dirty.add(itemId);
  if (app.frame) return;
  app.frame = requestAnimationFrame(() => {
    app.frame = 0;
    const session = current();
    const pinned = atBottom();
    for (const id of app.dirty) {
      const item = session && session.items.find((candidate) => candidate.id === id);
      if (item) patchItem(item);
    }
    app.dirty.clear();
    if (pinned) scrollToBottom(true);
  });
}

/* ------------------------------------------------------------------ *
 * 渲染：顶部与输入区
 * ------------------------------------------------------------------ */

function renderHeader() {
  const session = current();
  if (!session) {
    el.sessionTitle.textContent = '新对话';
    el.sessionCwd.textContent = '';
    el.crumbSep.hidden = true;
    // 模型和思考等级得等会话建好才有地方写；工作区在左侧列表和上方面包屑里看得到。
    el.wsSelectText.textContent = baseName(app.lastCwd || app.activeCwd) || '选择工作区';
    el.modelPill.hidden = true;
    closeModelPanel();
    el.branchPill.hidden = true;
    closeGitPanel();
    el.thinkingSelect.hidden = true;
    el.compactBtn.hidden = true;
    el.ctxUsage.hidden = true;
    el.renameBtn.hidden = true;
    el.exportBtn.hidden = true;
    el.terminalBtn.hidden = true;
    el.filesBtn.hidden = true;
    return;
  }

  const state = session.state || {};
  const firstUser = session.items.find((item) => item.kind === 'user');
  const title = state.sessionName || (firstUser && firstUser.text ? firstUser.text.split('\n')[0] : '') || '新对话';
  el.sessionTitle.textContent = title;
  el.sessionTitle.title = title;
  el.sessionCwd.textContent = baseName(session.cwd) || '';
  el.sessionCwd.title = session.cwd || '';
  el.crumbSep.hidden = !session.cwd;
  el.wsSelectText.textContent = baseName(session.cwd) || '选择工作区';

  renderModelPill();
  renderBranchPill();

  const capabilities = agentCapabilities();
  const levels = capabilities.thinkingLevels ? (session.levels && session.levels.levels) || [] : [];
  if (levels.length > 1) {
    // 库里记的等级可能不在当前模型的可选范围（换过模型就会出现），照实显示出来。
    const wanted = state.thinkingLevel || levels[0];
    const values = levels.includes(wanted) ? levels : [...levels, wanted];
    if (el.thinkingSelect.dataset.values !== values.join(',')) {
      el.thinkingSelect.innerHTML = '';
      for (const level of values) {
        const option = document.createElement('option');
        option.value = level;
        option.textContent = level;
        el.thinkingSelect.appendChild(option);
      }
      el.thinkingSelect.dataset.values = values.join(',');
    }
    el.thinkingSelect.value = wanted;
    el.thinkingSelect.hidden = false;
  } else {
    el.thinkingSelect.hidden = true;
  }

  el.compactBtn.hidden = false;
  el.renameBtn.hidden = false;
  el.exportBtn.hidden = false;
  el.terminalBtn.hidden = false;
  el.filesBtn.hidden = false;
  renderContext();
}

/* -------------------------------- 模型选择 -------------------------------- */

const modelState = { open: false, provider: '全部', query: '', focus: 0, rows: [] };

function modelEntries() {
  const session = current();
  return (session && session.models && session.models.models) || [];
}

/** id 带前缀（magpie 的 auto、workbuddy…）就是路由，没有前缀返回空。 */
function routeOf(entry) {
  const segments = String(entry.id || '').split('/');
  return segments.length > 1 ? segments[0] : '';
}

function modelName(entry) {
  const name = entry.name || entry.id || '';
  const cut = name.indexOf(' · ');
  return cut > 0 ? name.slice(0, cut) : name;
}

function formatContext(size) {
  if (!size) return '';
  if (size >= 100000) {
    return Math.round(size / 10000) + ' 万';
  }
  if (size >= 10000) {
    return Math.round(size / 1000) / 10 + ' 万';
  }
  return Math.round(size / 1000) + ' 千';
}

/** 只摆模型自带的字段：上下文、看图、思考，没有就不写。 */
function modelMeta(entry) {
  const parts = [];
  const context = formatContext(entry.contextWindow);
  if (context) parts.push(context);
  if ((entry.input || []).includes('image')) parts.push('看图');
  if (entry.reasoning) parts.push('思考');
  return parts.join(' · ');
}

function modelPrice(entry) {
  const cost = entry.cost || {};
  const input = Number(cost.input || 0);
  const output = Number(cost.output || 0);
  if (!input && !output) return '';
  return '$' + input + ' / $' + output;
}

function agentCapabilities() {
  const agent = app.agent;
  const caps = (agent && agent.capabilities) || {};
  return {
    tools: caps.tools !== false,
    thinkingLevels: Boolean(caps.thinkingLevels),
    models: Boolean(caps.models),
    contextUsage: Boolean(caps.contextUsage),
    compaction: Boolean(caps.compaction),
    extensions: Boolean(caps.extensions),
    skills: Boolean(caps.skills),
    commands: Boolean(caps.commands),
    attachments: Boolean(caps.attachments),
  };
}

function currentModel() {
  const session = current();
  const entries = modelEntries();
  const state = (session && session.state) || {};
  return state.model || entries[0] || null;
}

function renderModelPill() {
  const session = current();
  const entries = modelEntries();
  if (!session || entries.length < 2 || !agentCapabilities().models) {
    el.modelPill.hidden = true;
    closeModelPanel();
    return;
  }

  const model = currentModel();
  if (!model) {
    el.modelPill.hidden = true;
    return;
  }

  const route = routeOf(model);
  el.modelPill.hidden = false;
  el.modelPillRoute.hidden = !route;
  el.modelPillSlash.hidden = !route;
  el.modelPillRoute.textContent = route;
  el.modelPillText.textContent = modelName(model);
  el.modelPill.title = route ? route + '/' + model.id : String(model.id || '');
}

function modelProviders(entries) {
  const counts = new Map();
  for (const entry of entries) {
    const provider = entry.provider || '其它';
    counts.set(provider, (counts.get(provider) || 0) + 1);
  }
  return [['全部', entries.length], ...counts];
}

function visibleModels() {
  const entries = modelEntries();
  const query = modelState.query.trim().toLowerCase();
  if (query) {
    return entries.filter((entry) => {
      const hay = ((entry.provider || '') + ' ' + entry.id + ' ' + (entry.name || '')).toLowerCase();
      return hay.includes(query);
    });
  }
  if (modelState.provider === '全部') return entries;
  return entries.filter((entry) => (entry.provider || '其它') === modelState.provider);
}

function buildModelRow(entry, index, selectedKey) {
  const row = document.createElement('button');
  row.className = 'model-row';
  row.type = 'button';
  const key = entry.provider + '/' + entry.id;
  if (key === selectedKey) row.classList.add('is-selected');
  if (index === modelState.focus) row.classList.add('is-focus');
  row.dataset.key = key;

  const text = document.createElement('span');
  text.className = 'model-row-text';
  const name = document.createElement('span');
  name.className = 'model-row-name';
  name.textContent = modelName(entry);
  const meta = document.createElement('span');
  meta.className = 'model-row-meta';
  const provider = modelState.provider === '全部' && !modelState.query
    ? (entry.provider || '') + ' · '
    : '';
  meta.textContent = provider + modelMeta(entry);
  text.appendChild(name);
  text.appendChild(meta);
  row.appendChild(text);

  const price = modelPrice(entry);
  if (price) {
    const tag = document.createElement('span');
    tag.className = 'model-row-price';
    tag.textContent = price;
    row.appendChild(tag);
  }

  if (key === selectedKey) {
    const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    check.setAttribute('class', 'model-row-check');
    check.setAttribute('viewBox', '0 0 24 24');
    check.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M5 12.6 9.6 17.2 19 7.8');
    check.appendChild(path);
    row.appendChild(check);
  } else {
    const pad = document.createElement('span');
    pad.className = 'model-row-pad';
    row.appendChild(pad);
  }

  row.addEventListener('click', () => pickModel(entry));
  return row;
}

function renderModelPanel() {
  const entries = modelEntries();
  el.modelPanel.innerHTML = '';

  const search = document.createElement('div');
  search.className = 'model-search';
  search.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M16.2 16.2 21 21"/></svg>';
  const input = document.createElement('input');
  input.type = 'search';
  input.id = 'modelSearchInput';
  input.placeholder = '搜索模型';
  input.setAttribute('aria-label', '搜索模型');
  input.value = modelState.query;
  input.addEventListener('input', () => {
    modelState.query = input.value;
    modelState.focus = 0;
    renderModelPanel();
    const again = document.getElementById('modelSearchInput');
    if (again) {
      again.focus();
      again.setSelectionRange(again.value.length, again.value.length);
    }
  });
  search.appendChild(input);
  el.modelPanel.appendChild(search);

  const body = document.createElement('div');
  body.className = 'model-body';

  if (!modelState.query) {
    const providers = document.createElement('div');
    providers.className = 'model-providers';
    for (const [name, count] of modelProviders(entries)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'model-provider' + (name === modelState.provider ? ' is-active' : '');
      const label = document.createElement('span');
      label.textContent = name;
      const badge = document.createElement('span');
      badge.className = 'count';
      badge.textContent = String(count);
      button.appendChild(label);
      button.appendChild(badge);
      button.addEventListener('click', () => {
        modelState.provider = name;
        modelState.focus = 0;
        renderModelPanel();
      });
      providers.appendChild(button);
    }
    body.appendChild(providers);
  }

  const list = document.createElement('div');
  list.className = 'model-list';

  const session = current();
  const chosen = (session && session.state && session.state.model) || null;
  const selectedKey = chosen ? chosen.provider + '/' + chosen.id : '';

  const rows = visibleModels();
  modelState.rows = rows;

  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'model-empty';
    empty.textContent = '没有匹配的模型';
    list.appendChild(empty);
  } else {
    let lastRoute = null;
    rows.forEach((entry, index) => {
      const route = routeOf(entry);
      if (route && route !== lastRoute) {
        const head = document.createElement('div');
        head.className = 'model-group';
        head.textContent = route;
        list.appendChild(head);
      }
      lastRoute = route;
      list.appendChild(buildModelRow(entry, index, selectedKey));
    });
  }

  body.appendChild(list);
  el.modelPanel.appendChild(body);

  const foot = document.createElement('div');
  foot.className = 'model-foot';
  const keys = document.createElement('span');
  keys.textContent = '↑↓ 移动 · Enter 选中 · Esc 关闭';

  // 缓存会过期，但用户在意的往往是「我刚改完配置」，所以给一个当场重取的入口。
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'model-refresh';
  refresh.textContent = '刷新';
  refresh.title = '重新向 Pi 取一次模型列表';
  refresh.addEventListener('click', (event) => {
    event.stopPropagation();
    const session = current();
    if (!session) return;
    refresh.disabled = true;
    refresh.textContent = '正在刷新…';
    send({ type: 'list_models', key: session.key, force: true });
  });

  const count = document.createElement('span');
  count.textContent = rows.length + ' 个模型';
  foot.appendChild(keys);
  foot.appendChild(refresh);
  foot.appendChild(count);
  el.modelPanel.appendChild(foot);
}

function pickModel(entry) {
  const session = current();
  if (!session) return;
  send({ type: 'set_model', key: session.key, provider: entry.provider, modelId: entry.id });
  closeModelPanel();
}

/* ------------------------------------------------------------------ *
 * git 分支：只读展示
 * 数据来自 Core 的 git_status（rev-parse / status --porcelain=v2 / for-each-ref），
 * 这里一个字都不写仓库——切分支、建分支都不在这个功能里。
 * ------------------------------------------------------------------ */

const gitState = { open: false, snapshot: null };

/** 相对时间：面板里分支的「3 天前」自己算，不用 git 的英文相对时间。 */
function sinceText(seconds) {
  if (!seconds) return '';
  const diff = Math.max(0, Math.round(Date.now() / 1000 - Number(seconds)));
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.round(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.round(diff / 3600) + ' 小时前';
  if (diff < 86400 * 30) return Math.round(diff / 86400) + ' 天前';
  return Math.round(diff / 86400 / 30) + ' 个月前';
}

/** 改动记号：字母 + 颜色，跟 git status 对得上。 */
function changeMark(flag) {
  switch (flag) {
    case 'new':
    case 'A': return { letter: 'A', cls: 'new' };
    case 'D': return { letter: 'D', cls: 'del' };
    case 'R': return { letter: 'R', cls: 'move' };
    case 'C': return { letter: 'C', cls: 'move' };
    case 'U': return { letter: 'U', cls: 'conflict' };
    default: return { letter: 'M', cls: 'edit' };
  }
}

/** 长路径中间省略：留开头两级和文件名，中间用 … 省掉。 */
function shortPath(path) {
  const parts = String(path).split(/[\\/]/);
  if (parts.length <= 3) return path;
  return parts.slice(0, 2).join('/') + '/…/' + parts[parts.length - 1];
}

function renderBranchPill() {
  const session = current();
  const git = session && session.git;
  if (!session || !git || !git.repo || !git.branch) {
    el.branchPill.hidden = true;
    closeGitPanel();
    return;
  }

  el.branchPill.hidden = false;
  el.branchPillText.textContent = git.branch;

  const changes = Array.isArray(git.files) ? git.files.length : 0;
  el.branchPillCount.hidden = changes === 0;
  el.branchPillCount.textContent = String(changes);

  const ahead = Number(git.ahead) || 0;
  const behind = Number(git.behind) || 0;
  el.branchPillAb.hidden = ahead === 0 && behind === 0;
  el.branchPillAb.textContent = (ahead ? '↑' + ahead : '') + (behind ? '↓' + behind : '');

  el.branchPill.title = [
    git.detached ? '分离头指针' : git.branch,
    changes ? changes + ' 处改动' : '没有改动',
    ahead ? '领先 ' + ahead : '',
    behind ? '落后 ' + behind : '',
  ].filter(Boolean).join(' · ');

  // 等这一帧的布局算完再量：名字一换宽度就变，同步量会读到旧的尺寸。
  fitPills();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fitPills);
}

/**
 * 宽度不够时按「先降目录，再降分支」的顺序收：
 * 目录在左侧列表和上方面包屑里都看得到，分支只在这里有，所以目录先让位。
 */
/**
 * 这一行只让分支名缩：模型名与思考等级按内容走，不动它们。
 * 分支名被压出省略号时加下限（至少留几个字），再窄就只剩图标 + 改动数。
 */
function fitPills() {
  if (!el.pills) return;
  const cut = (node) => Boolean(node) && node.scrollWidth > node.clientWidth + 1;
  el.pills.classList.toggle('floors', cut(el.branchPillText));
}

function closeGitPanel() {
  if (!gitState.open) return;
  gitState.open = false;
  el.gitPanel.hidden = true;
  el.branchPill.setAttribute('aria-expanded', 'false');
}

function placeGitPanel() {
  const rect = el.branchPill.getBoundingClientRect();
  el.gitPanel.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 316)) + 'px';
  el.gitPanel.style.bottom = Math.round(window.innerHeight - rect.top + 10) + 'px';
}

function makeGitSep(text) {
  const sep = document.createElement('div');
  sep.className = 'git-sep';
  sep.textContent = text;
  return sep;
}

function renderGitPanel() {
  const git = gitState.snapshot;
  el.gitPanel.innerHTML = '';
  if (!git || !git.repo) return;

  const head = document.createElement('div');
  head.className = 'git-head';
  head.textContent = git.detached ? '分离头指针' : '当前分支';
  el.gitPanel.appendChild(head);

  const current = document.createElement('div');
  current.className = 'git-row is-current';
  current.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.4 8.2 6.4 11 12.4 5"/></svg>';
  const name = document.createElement('span');
  name.className = 'git-name';
  name.textContent = git.branch || '(未知)';
  name.title = git.branch || '';
  current.appendChild(name);
  const ahead = Number(git.ahead) || 0;
  const behind = Number(git.behind) || 0;
  if (ahead || behind) {
    const ab = document.createElement('span');
    ab.className = 'git-meta';
    ab.textContent = (ahead ? '↑' + ahead : '') + (behind ? '↓' + behind : '');
    current.appendChild(ab);
  }
  el.gitPanel.appendChild(current);

  const others = (git.branches || []).filter((item) => !item.current);
  if (others.length) {
    el.gitPanel.appendChild(makeGitSep('本地分支'));
    others.slice(0, 8).forEach((item) => {
      const row = document.createElement('div');
      row.className = 'git-row';
      row.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.6" cy="3.4" r="1.6"/><circle cx="4.6" cy="12.6" r="1.6"/><circle cx="11.4" cy="6.4" r="1.6"/><path d="M4.6 5v6M11.4 8V5.4c0-1.1-.9-2-2-2H6.2"/></svg>';
      const label = document.createElement('span');
      label.className = 'git-name';
      label.textContent = item.name;
      label.title = item.name;
      row.appendChild(label);
      const since = document.createElement('span');
      since.className = 'git-meta';
      since.textContent = sinceText(item.at);
      row.appendChild(since);
      el.gitPanel.appendChild(row);
    });
  }

  const files = Array.isArray(git.files) ? git.files : [];
  el.gitPanel.appendChild(makeGitSep(files.length ? files.length + ' 处改动' : '没有改动'));
  if (!files.length) {
    const empty = document.createElement('div');
    empty.className = 'git-note';
    empty.textContent = '工作区是干净的。';
    el.gitPanel.appendChild(empty);
  } else {
    files.slice(0, 12).forEach((file) => {
      const row = document.createElement('div');
      row.className = 'git-file';
      const mark = changeMark(file.flag);
      const letter = document.createElement('span');
      letter.className = 'git-flag ' + mark.cls;
      letter.textContent = mark.letter;
      const path = document.createElement('span');
      path.className = 'git-path';
      path.textContent = shortPath(file.path);
      path.title = file.path;
      row.appendChild(letter);
      row.appendChild(path);
      el.gitPanel.appendChild(row);
    });
    if (files.length > 12) {
      const more = document.createElement('div');
      more.className = 'git-note';
      more.textContent = '还有 ' + (files.length - 12) + ' 个文件没列出来，看 git status。';
      el.gitPanel.appendChild(more);
    }
  }

  const note = document.createElement('div');
  note.className = 'git-note';
  note.textContent = '只看不改：切分支、建分支请自己走命令。';
  el.gitPanel.appendChild(note);
}

let gitAsked = { key: '', at: 0 };

function requestGitStatus(force) {
  const session = current();
  if (!session || !session.cwd) return;
  // 同一会话 20 秒内只问一次；点开面板时强制刷新（可能刚在终端里提交过）。
  if (!force && gitAsked.key === session.key && Date.now() - gitAsked.at < 20000) return;
  gitAsked = { key: session.key, at: Date.now() };
  send({ type: 'git_status', key: session.key });
}

function toggleGitPanel() {
  if (gitState.open) {
    closeGitPanel();
    return;
  }
  const session = current();
  const git = session && session.git;
  if (!git || !git.repo) return;

  gitState.snapshot = git;
  gitState.open = true;
  renderGitPanel();
  if (el.gitPanel.parentElement !== document.body) document.body.appendChild(el.gitPanel);
  el.gitPanel.hidden = false;
  el.branchPill.setAttribute('aria-expanded', 'true');
  placeGitPanel();
  // 点开时顺手刷新一次：可能刚在终端里提交过。
  requestGitStatus(true);
}

el.branchPill.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleGitPanel();
});

document.addEventListener('click', (event) => {
  if (!gitState.open) return;
  if (el.gitPanel.contains(event.target)) return;
  closeGitPanel();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && gitState.open) closeGitPanel();
}, true);

window.addEventListener('resize', () => {
  if (gitState.open) placeGitPanel();
  fitPills();
});

if (typeof ResizeObserver === 'function' && el.pills) {
  new ResizeObserver(() => fitPills()).observe(el.pills);
}

/* 面板挂到 body 上用 fixed 定位，免得被输入区的裁剪和层叠顺序吃掉。 */
function placeModelPanel() {
  const rect = el.modelPill.getBoundingClientRect();
  el.modelPanel.style.left = Math.max(8, rect.left) + 'px';
  el.modelPanel.style.bottom = Math.round(window.innerHeight - rect.top + 10) + 'px';
}

function openModelPanel() {
  if (!modelEntries().length) return;
  modelState.open = true;
  modelState.focus = 0;
  modelState.query = '';
  modelState.provider = '全部';
  if (el.modelPanel.parentElement !== document.body) {
    document.body.appendChild(el.modelPanel);
  }
  el.modelPanel.hidden = false;
  el.modelPill.setAttribute('aria-expanded', 'true');
  placeModelPanel();
  renderModelPanel();
  const input = document.getElementById('modelSearchInput');
  if (input) input.focus();
}

function closeModelPanel() {
  if (!modelState.open) return;
  modelState.open = false;
  modelState.query = '';
  el.modelPanel.hidden = true;
  el.modelPill.setAttribute('aria-expanded', 'false');
}

function moveModelFocus(delta) {
  const rows = modelState.rows || [];
  if (!rows.length) return;
  modelState.focus = (modelState.focus + delta + rows.length) % rows.length;
  renderModelPanel();
}

function modelLabel(entry) {
  const name = entry.name || entry.id;
  const segments = String(entry.id || '').split('/');
  if (segments.length < 2) {
    return name;
  }

  // id 带路由前缀（magpie 的 auto / workbuddy / amd…）。名字里已经写了路由就不再重复。
  const route = segments[0];
  return name.toLowerCase().includes(route.toLowerCase()) ? name : name + ' · ' + route;
}

/** 上下文的几个数：顶栏小字、输入框旁的圆环、点击提示都用这一份。 */
function contextNumbers(usage) {
  const percent = Number(usage.percent).toFixed(1).replace(/\.0$/, '');
  const used = (usage.tokens / 1000).toFixed(0);
  const total = Math.round(usage.contextWindow / 1000);
  return { percent, used, total, text: percent + '% · ' + used + 'k/' + total + 'k' };
}

/* 圆环的周长：半径 7.4 写在 index.html 的 circle 上，改那边时这里跟着改。 */
const CTX_RING_LENGTH = 2 * Math.PI * 7.4;

function renderContext() {
  const session = current();
  const usage = session && session.stats && session.stats.contextUsage;
  if (!usage || usage.percent == null) {
    el.ctxUsage.hidden = true;
    if (el.ctxRing) el.ctxRing.hidden = true;
    return;
  }

  const numbers = contextNumbers(usage);
  el.ctxUsage.hidden = false;
  el.ctxUsage.textContent = numbers.text;
  el.ctxUsage.title = '上下文用量';

  // 输入框旁那圈：只有比例，数字放提示里。快到上限时换警示色。
  if (!el.ctxRing || !el.ctxRingFill) return;
  const fraction = Math.min(1, Math.max(0, Number(usage.percent) / 100));
  el.ctxRingFill.style.strokeDasharray = CTX_RING_LENGTH.toFixed(2);
  el.ctxRingFill.style.strokeDashoffset = (CTX_RING_LENGTH * (1 - fraction)).toFixed(2);
  el.ctxRing.dataset.level = Number(usage.percent) >= 85 ? 'high' : 'normal';
  el.ctxRing.hidden = false;
  el.ctxRing.title = '上下文已用 ' + numbers.text;
  el.ctxRing.setAttribute('aria-label', '上下文已用 ' + numbers.text);
}

/* 工作中时在输入卡片下面走一条「工作 X 秒 · Enter 排队」。 */
let workTicker = null;
let workStartedAt = 0;

function stopWorkTicker() {
  if (workTicker) {
    window.clearInterval(workTicker);
    workTicker = null;
  }
  workStartedAt = 0;
}

/** 这一轮是从哪句话开始的：时间点来自库里存的消息，切走再回来也接得上。 */
function turnStartedAt(session) {
  if (!session) return 0;
  for (let index = session.items.length - 1; index >= 0; index -= 1) {
    const item = session.items[index];
    if (item.kind === 'user' && item.ts > 0) return item.ts;
  }
  return 0;
}

function paintWorkHint() {
  const started = turnStartedAt(current()) || workStartedAt;
  if (!started) return;
  // 跟过程区那行用同一个换算，长跑的时候显示「8 小时 30 分」而不是「30620 秒」。
  const spent = formatSpent(Date.now() - started) || '不到 1 秒';
  el.hint.textContent = '工作 ' + spent + ' · Enter 排队';

  // 同一条时间线：下面刷新，上面「工作 N 秒」也跟着走。
  const head = document.querySelector('.work-head[data-since]');
  if (head) {
    const title = head.querySelector('.work-title');
    if (title) {
      title.textContent = workLabel(Date.now() - Number(head.dataset.since), Number(head.dataset.steps), true);
    }
  }
}

function startWorkTicker() {
  if (workTicker) return;
  workStartedAt = Date.now();
  paintWorkHint();
  workTicker = window.setInterval(paintWorkHint, 1000);
}

/* 有没有内容决定发送键是黑的还是灰的，跟流式状态无关。 */
function updateSendReady() {
  const session = current();
  const streaming = Boolean(session && session.streaming);
  el.sendBtn.classList.toggle('ready', !streaming && el.input.value.trim().length > 0);
}

function renderComposerState() {
  const session = current();
  const streaming = Boolean(session && session.streaming);
  // 停止是圆底里一个白方块，发送是同尺寸的圆底加箭头。
  el.sendBtn.innerHTML = streaming
    ? '<span class="send-stop-mark"></span>'
    : '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3.4"/><path d="M4.2 7.2 8 3.4l3.8 3.8"/></svg>';
  el.sendBtn.title = streaming ? '停止' : '发送';
  el.sendBtn.classList.toggle('stop', streaming);
  updateSendReady();
  if (streaming) {
    startWorkTicker();
  } else {
    stopWorkTicker();
    el.hint.textContent = '';
  }
}

function renderAttachments() {
  el.attachments.innerHTML = '';
  el.attachments.hidden = app.attachments.length === 0;
  app.attachments.forEach((attachment, index) => {
    const chip = document.createElement('div');
    chip.className = 'attachment';
    const img = document.createElement('img');
    img.src = attachment.dataUrl;
    img.alt = '';
    const label = document.createElement('span');
    label.className = 'attachment-name';
    label.textContent = attachment.name || 'image';
    label.title = attachment.name || 'image';
    const remove = document.createElement('button');
    remove.className = 'attachment-remove';
    remove.type = 'button';
    remove.title = '移除这张图';
    remove.setAttribute('aria-label', '移除这张图');
    remove.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>';
    remove.addEventListener('click', () => {
      app.attachments.splice(index, 1);
      renderAttachments();
    });
    chip.appendChild(img);
    chip.appendChild(label);
    chip.appendChild(remove);
    el.attachments.appendChild(chip);
  });
}

function renderExtStatus() {
  el.extStatus.innerHTML = '';
  for (const [, text] of app.extStatus) {
    const clean = text.trim();
    if (!clean) continue;
    const chip = document.createElement('span');
    chip.textContent = clean;
    el.extStatus.appendChild(chip);
  }

  const lines = [];
  for (const [, widget] of app.widgets) {
    for (const line of widget) {
      const clean = stripAnsi(line).trim();
      if (clean) lines.push(clean);
    }
  }
  el.widgetStrip.textContent = lines.join('\n');
  el.widgetStrip.hidden = lines.length === 0;
}

function showWorkspace(hasSession) {
  // 设置 / 技能 / 扩展页面占着右边的时候，不要被对话流程把正文翻回来。
  if (app.view !== 'chat') return;
  el.thread.hidden = !hasSession;
  el.empty.hidden = hasSession;
  el.content.classList.toggle('is-empty', !hasSession);
}

/* ------------------------------------------------------------------ *
 * 会话流程
 * ------------------------------------------------------------------ */

function openSession(conversation) {
  if (!conversation || !conversation.id) return;
  switchView('chat');
  // 先把当前输入框存进它自己的会话，再换。
  rememberDraft();
  const known = app.byKey.get(conversation.id);
  if (known) {
    app.currentKey = conversation.id;
    restoreDraft(conversation.id);
    app.activeCwd = conversation.cwd || '';
    showWorkspace(true);
    renderThread();
    renderHeader();
    requestGitStatus();
    renderComposerState();
    renderSessionList();
    return;
  }

  // 历史直接从 SevenStation.Core 的库里读，不再为它起 Pi 进程，所以旧对话也是秒开。
  setOverlay('正在打开对话…');
  send({ type: 'open_conversation', id: conversation.id });
  app.pendingCwd = conversation.cwd || '';
}

function newSession() {
  askCwd();
}

/**
 * 选目录：桌面壳里交给系统的对话框，浏览器里没有这条路，退回页面里那棵目录树。
 */
async function pickFolder(initial, onPick) {
  if (shell) {
    try {
      const picked = await shell.invoke('pick_folder', { initial: initial || '' });
      onPick(picked || '');
      return;
    } catch (error) {
      console.warn('系统的选目录窗口没打开，改用这里的目录树', error);
    }
  }

  openDirPicker(initial, onPick);
}

/**
 * 选工作区用的目录选择器：目录列表由 Seven Station Core 给（browse_dir），
 * 浏览器里也能用，不依赖桌面客户端的原生对话框。
 */
function openDirPicker(startPath, onPick) {
  closeModal();
  app.dirPicker = { onPick, path: startPath || '' };

  const card = document.createElement('div');
  card.className = 'modal dir-picker';

  const title = document.createElement('h3');
  title.textContent = '选一个目录当工作区';
  card.appendChild(title);

  const where = document.createElement('div');
  where.className = 'dir-where';
  card.appendChild(where);

  const list = document.createElement('div');
  list.className = 'dir-list';
  card.appendChild(list);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  const cancel = document.createElement('button');
  cancel.className = 'ghost-btn';
  cancel.textContent = '取消';
  cancel.addEventListener('click', () => {
    app.dirPicker = null;
    closeModal();
  });

  const use = document.createElement('button');
  use.className = 'primary-btn';
  use.textContent = '就用这个目录';
  use.addEventListener('click', () => {
    const chosen = app.dirPicker && app.dirPicker.path;
    const callback = app.dirPicker && app.dirPicker.onPick;
    app.dirPicker = null;
    closeModal();
    if (chosen && callback) callback(chosen);
  });

  actions.appendChild(cancel);
  actions.appendChild(use);
  card.appendChild(actions);
  el.modal.appendChild(card);
  el.modal.hidden = false;

  app.dirPicker.where = where;
  app.dirPicker.list = list;
  app.dirPicker.use = use;
  renderDirListing({ path: '', parent: null, drives: [], dirs: [], error: '', pending: true });
  send({ type: 'browse_dir', path: startPath || '' });
}

function renderDirListing(payload) {
  const picker = app.dirPicker;
  if (!picker) return;

  picker.path = payload.path || '';
  picker.where.textContent = picker.path || '这台机器上的盘符';
  picker.use.disabled = !picker.path;

  const list = picker.list;
  list.innerHTML = '';

  if (payload.error) {
    const note = document.createElement('div');
    note.className = 'dir-empty';
    note.textContent = payload.error;
    list.appendChild(note);
    return;
  }

  if (payload.pending) {
    const note = document.createElement('div');
    note.className = 'dir-empty';
    note.textContent = '正在读目录…';
    list.appendChild(note);
    return;
  }

  if (payload.parent) {
    const up = document.createElement('button');
    up.className = 'dir-row dir-up';
    up.textContent = '上一级';
    up.addEventListener('click', () => {
      send({ type: 'browse_dir', path: payload.parent });
    });
    list.appendChild(up);
  }

  const entries = picker.path ? payload.dirs || [] : payload.drives || [];
  if (!entries.length) {
    const note = document.createElement('div');
    note.className = 'dir-empty';
    note.textContent = picker.path ? '这个目录下面没有子目录' : '没有可用的盘符';
    list.appendChild(note);
    return;
  }

  entries.forEach((entry) => {
    const row = document.createElement('button');
    row.className = 'dir-row';
    row.title = entry.path;
    row.textContent = entry.name;
    row.addEventListener('click', () => {
      send({ type: 'browse_dir', path: entry.path });
    });
    list.appendChild(row);
  });
}

/* ------------------------------ 恢复会话 ------------------------------ */

/**
 * 从 Pi 那边把旧会话收回来：左边按工作区分组，右边先看这段讲的是什么再决定恢复。
 * magpie 给的是整条 `pi --session <id>` 命令，切到那一栏粘进去，Seven Station Core 负责解析。
 */
function openRestoreDialog() {
  app.restore = {
    source: 'pi',
    items: null,
    loading: true,
    filter: '',
    selectedId: null,
    command: '',
    commandBusy: false,
    commandResult: null,
    commandError: '',
    restoring: false,
    progress: null,
    progressVisible: false,
    progressTimer: 0,
  };

  const card = document.createElement('div');
  card.className = 'modal is-restore';
  el.modal.innerHTML = '';
  el.modal.appendChild(card);
  el.modal.hidden = false;

  send({ type: 'list_restore_candidates' });
  renderRestoreDialog();
}

function renderRestoreDialog() {
  const state = app.restore;
  const card = el.modal.querySelector('.is-restore');
  if (!state || !card) return;

  card.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'restore-head';
  const title = document.createElement('h3');
  title.textContent = '恢复会话';
  head.appendChild(title);

  const sources = document.createElement('div');
  sources.className = 'restore-sources';

  const piChip = document.createElement('button');
  piChip.className = 'chip' + (state.source === 'pi' ? ' is-on' : '');
  piChip.textContent = state.items ? 'Pi · ' + state.items.length + ' 段' : 'Pi';
  piChip.addEventListener('click', () => {
    if (state.source === 'pi') return;
    state.source = 'pi';
    renderRestoreDialog();
  });
  sources.appendChild(piChip);

  const magpieChip = document.createElement('button');
  magpieChip.className = 'chip' + (state.source === 'magpie' ? ' is-on' : '');
  magpieChip.textContent = 'magpie 命令';
  magpieChip.addEventListener('click', () => {
    if (state.source === 'magpie') return;
    state.source = 'magpie';
    renderRestoreDialog();
  });
  sources.appendChild(magpieChip);
  head.appendChild(sources);
  card.appendChild(head);

  if (state.source === 'pi') {
    card.appendChild(makeRestoreSearch(state));
  } else {
    card.appendChild(makeRestoreCommandBar(state));
  }

  const body = document.createElement('div');
  body.className = 'restore-body' + (state.source === 'magpie' ? ' is-single' : '');

  // 命令那一栏只对应一段会话，不用分左右；列表那一栏才需要。
  if (state.source === 'pi') {
    body.appendChild(makeRestoreList(state));
  }

  const preview = document.createElement('div');
  preview.className = 'restore-preview';
  body.appendChild(preview);
  card.appendChild(body);

  renderRestorePreview(state, preview);
  if (state.restoring && state.progressVisible) {
    card.appendChild(makeRestoreProgress(state));
  }
  card.appendChild(makeRestoreFoot(state));
}

function makeRestoreSearch(state) {
  const row = document.createElement('div');
  row.className = 'restore-search';

  const mag = document.createElement('span');
  mag.className = 'mag';
  mag.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7.2" cy="7.2" r="4.2"/><path d="m10.4 10.4 3 3"/></svg>';
  row.appendChild(mag);

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '搜标题或工作区';
  input.value = state.filter;
  row.appendChild(input);

  // 输入时只重画列表，不重画输入框，否则光标每敲一下就跳回开头。
  input.addEventListener('input', () => {
    state.filter = input.value;
    const list = el.modal.querySelector('.restore-list');
    const preview = el.modal.querySelector('.restore-preview');
    if (!list || !preview) return;
    const fresh = makeRestoreList(state);
    list.replaceWith(fresh);
    renderRestorePreview(state, preview);
    const foot = el.modal.querySelector('.restore-count');
    if (foot) foot.textContent = restoreCountText(state);
    const btn = el.modal.querySelector('.restore-buttons .primary-btn');
    if (btn) btn.disabled = !currentRestoreTarget(state);
  });

  return row;
}

function makeRestoreCommandBar(state) {
  const wrap = document.createElement('div');
  wrap.className = 'restore-command';

  const box = document.createElement('textarea');
  box.className = 'restore-command-input';
  box.rows = 2;
  box.spellcheck = false;
  box.placeholder = "Set-Location -LiteralPath 'E:\\Dev\\Android'; pi --session 01a1ed4e-…";
  box.value = state.command;
  box.addEventListener('input', () => {
    state.command = box.value;
    state.commandResult = null;
    state.commandError = '';
  });
  wrap.appendChild(box);

  const actions = document.createElement('div');
  actions.className = 'restore-command-actions';

  const hint = document.createElement('span');
  hint.className = 'restore-hint' + (state.commandError ? ' is-bad' : '');
  hint.textContent = state.commandError || (state.commandResult?.item ? '' : '粘贴 magpie 的命令');
  actions.appendChild(hint);

  const pick = document.createElement('button');
  pick.className = 'ghost-btn small';
  pick.textContent = state.commandBusy ? '正在找…' : '找这段会话';
  pick.disabled = state.commandBusy;
  pick.addEventListener('click', () => {
    const command = state.command.trim();
    if (!command) {
      state.commandError = '先粘贴命令';
      renderRestoreDialog();
      return;
    }

    state.commandBusy = true;
    state.commandError = '';
    renderRestoreDialog();
    send({ type: 'resolve_resume_command', command });
  });
  actions.appendChild(pick);

  wrap.appendChild(actions);
  return wrap;
}

function makeRestoreList(state) {
  const list = document.createElement('div');
  list.className = 'restore-list';

  const notice = document.createElement('div');
  notice.className = 'restore-empty';
  if (state.loading) {
    notice.textContent = '正在读 Pi 那边的会话…';
    list.appendChild(notice);
    return list;
  }

  const items = filterRestoreItems(state);
  if (!items.length) {
    notice.textContent = state.filter ? '没有匹配的会话，换个词试试' : 'Pi 那边还没有会话记录';
    list.appendChild(notice);
    return list;
  }

  if (!state.selectedId || !items.some((item) => item.id === state.selectedId)) {
    const first = items.find((item) => !item.imported) || items[0];
    state.selectedId = first.id;
  }

  let currentGroup = null;
  for (const item of items) {
    const group = workspaceName(item.cwd);
    if (group !== currentGroup) {
      currentGroup = group;
      const head = document.createElement('div');
      head.className = 'restore-group';
      head.textContent = group;
      const path = document.createElement('span');
      path.textContent = ' · ' + (item.cwd || '（没记工作区）');
      head.appendChild(path);
      list.appendChild(head);
    }

    const row = document.createElement('button');
    row.className = 'restore-row';
    row.classList.toggle('is-selected', item.id === state.selectedId);
    row.classList.toggle('is-imported', Boolean(item.imported));

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.title || '（空会话）';
    row.appendChild(name);

    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = shortWhen(item.startedAt);
    row.appendChild(when);

    if (item.imported) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '已恢复';
      row.appendChild(badge);
    }

    row.addEventListener('click', () => {
      state.selectedId = item.id;
      renderRestoreDialog();
    });
    list.appendChild(row);
  }

  return list;
}

function currentRestoreTarget(state) {
  if (state.source === 'magpie') {
    return state.commandResult && state.commandResult.item;
  }

  return filterRestoreItems(state).find((item) => item.id === state.selectedId) || null;
}

function filterRestoreItems(state) {
  const items = state.items || [];
  const needle = state.filter.trim().toLowerCase();
  if (!needle) return items;

  return items.filter((item) =>
    String(item.title || '').toLowerCase().includes(needle) ||
    String(item.cwd || '').toLowerCase().includes(needle) ||
    workspaceName(item.cwd).toLowerCase().includes(needle));
}

function renderRestorePreview(state, preview) {
  preview.innerHTML = '';
  const item = currentRestoreTarget(state);

  if (!item) {
    const hint = document.createElement('div');
    hint.className = 'restore-empty';
    hint.textContent = state.source === 'magpie' ? '粘贴命令后在这里预览' : '挑一段看看';
    preview.appendChild(hint);
    return;
  }

  const title = document.createElement('p');
  title.className = 'preview-title';
  title.textContent = item.title || '（空会话）';
  preview.appendChild(title);

  const facts = document.createElement('div');
  facts.className = 'preview-facts';
  for (const text of [
    item.messageCount + ' 条消息',
    formatBytes(item.sizeBytes),
    shortDate(item.startedAt),
    item.model || '',
  ]) {
    if (!text) continue;
    const part = document.createElement('span');
    part.textContent = text;
    facts.appendChild(part);
  }
  preview.appendChild(facts);

  const cwd = document.createElement('div');
  cwd.className = 'preview-cwd';
  cwd.textContent = item.cwd || '没记工作区';
  preview.appendChild(cwd);

  if (item.lastMessage) {
    const quote = document.createElement('p');
    quote.className = 'preview-quote';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = '最近一条回复';
    quote.appendChild(who);
    quote.appendChild(document.createTextNode(item.lastMessage));
    preview.appendChild(quote);
  }

  if (item.imported) {
    const done = document.createElement('div');
    done.className = 'preview-done';
    done.textContent = '已在对话库里，恢复会打开原来那段';
    preview.appendChild(done);
  }
}

/**
 * 恢复时的进度（原型 G2）：读大文件按字节走，写库按条数走。
 * 只在超过 250 ms 还没做完时才出现，两三百毫秒的那种不闪一下。
 */
function makeRestoreProgress(state) {
  const card = document.createElement('div');
  card.className = 'restore-progress';

  const line = document.createElement('div');
  line.className = 'line';
  const label = document.createElement('span');
  label.className = 'label';
  line.appendChild(label);
  const meta = document.createElement('span');
  meta.className = 'meta';
  line.appendChild(meta);
  card.appendChild(line);

  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('i');
  bar.appendChild(fill);
  card.appendChild(bar);

  const sub = document.createElement('div');
  sub.className = 'sub';
  card.appendChild(sub);

  applyRestoreProgress(card, state);
  return card;
}

function updateRestoreProgress(state) {
  const card = el.modal.querySelector('.restore-progress');
  if (!card) return;
  applyRestoreProgress(card, state);
}

function applyRestoreProgress(card, state) {
  const progress = state.progress || { stage: 'read', done: 0, total: 0, messages: 0 };
  const reading = progress.stage === 'read';
  const ratio = progress.total > 0 ? Math.min(1, progress.done / progress.total) : 0;

  card.querySelector('.label').textContent = reading ? '正在读会话' : '正在写入对话库';
  card.querySelector('.meta').textContent = reading
    ? formatBytes(progress.done) + ' / ' + formatBytes(progress.total)
    : progress.done + ' 条';
  card.querySelector('.bar i').style.width = Math.round((reading ? ratio : 1) * 100) + '%';
  card.querySelector('.sub').textContent = reading
    ? '已收 ' + (progress.messages || 0) + ' 条消息'
    : '';
}

function beginRestore(state) {
  state.restoring = true;
  state.progress = null;
  state.progressVisible = false;
  clearTimeout(state.progressTimer);
  state.progressTimer = setTimeout(() => {
    if (!app.restore || !app.restore.restoring) return;
    app.restore.progressVisible = true;
    renderRestoreDialog();
  }, 250);
}

function endRestore(state) {
  clearTimeout(state.progressTimer);
  state.progressTimer = 0;
  state.restoring = false;
  state.progressVisible = false;
  state.progress = null;
}

function restoreCountText(state) {
  if (state.source === 'pi' && state.items) {
    const imported = state.items.filter((item) => item.imported).length;
    return state.items.length + ' 段 · 已恢复 ' + imported + ' 段';
  }

  if (state.source === 'magpie' && state.commandResult?.item) {
    return state.commandResult.item.imported ? '这段已经恢复过' : '这段还没恢复';
  }

  return '';
}

function makeRestoreFoot(state) {
  const foot = document.createElement('div');
  foot.className = 'restore-foot';

  const count = document.createElement('span');
  count.className = 'restore-count';
  count.textContent = restoreCountText(state);
  foot.appendChild(count);

  const buttons = document.createElement('div');
  buttons.className = 'restore-buttons';

  const cancel = document.createElement('button');
  cancel.className = 'ghost-btn';
  // 恢复是 Seven Station Core 那边接着干的事，关掉窗口不会取消它，所以按钮说实话。
  cancel.textContent = state.restoring ? '关掉这个窗口' : '取消';
  cancel.addEventListener('click', () => {
    if (state.restoring) endRestore(state);
    closeModal();
    app.restore = null;
  });
  buttons.appendChild(cancel);

  const target = currentRestoreTarget(state);
  const restore = document.createElement('button');
  restore.className = 'primary-btn';
  restore.textContent = state.restoring ? '正在恢复…' : '恢复这段';
  restore.disabled = state.restoring || !target;
  restore.addEventListener('click', () => {
    const chosen = currentRestoreTarget(state);
    if (!chosen) return;
    restore.disabled = true;
    restore.textContent = '正在恢复…';
    beginRestore(state);
    send({ type: 'restore_session', sessionId: chosen.id });
  });
  buttons.appendChild(restore);

  foot.appendChild(buttons);
  return foot;
}

function workspaceName(cwd) {
  if (!cwd) return '（没记工作区）';
  const parts = String(cwd).split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : cwd;
}

function formatBytes(bytes) {
  const size = Number(bytes) || 0;
  if (size >= 1024 * 1024) return (size / 1024 / 1024).toFixed(1) + ' MB';
  if (size >= 1024) return Math.round(size / 1024) + ' KB';
  return size + ' B';
}

function shortDate(ms) {
  const value = Number(ms) || 0;
  if (!value) return '';
  const date = new Date(value);
  const pad = (number) => String(number).padStart(2, '0');
  const day = pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  const time = pad(date.getHours()) + ':' + pad(date.getMinutes());
  return date.getFullYear() === new Date().getFullYear() ? day + ' ' + time : date.getFullYear() + '-' + day;
}

function shortWhen(ms) {
  const value = Number(ms) || 0;
  if (!value) return '';
  const date = new Date(value);
  const now = new Date();
  const pad = (number) => String(number).padStart(2, '0');
  if (date.toDateString() === now.toDateString()) {
    return pad(date.getHours()) + ':' + pad(date.getMinutes());
  }
  return date.getFullYear() === now.getFullYear()
    ? pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    : String(date.getFullYear());
}

function askCwd() {
  // 桌面壳里直接开系统的选目录对话框，省掉中间那层自己画的。
  if (shell) {
    pickFolder(app.cwdDraft || app.lastCwd || app.activeCwd || '', (picked) => {
      if (picked) startSession(picked);
    });
    return;
  }

  closeModal();
  const card = document.createElement('div');
  card.className = 'modal';

  const title = document.createElement('h3');
  title.textContent = '在哪个工作区新建对话';
  card.appendChild(title);

  const inputRow = document.createElement('div');
  inputRow.className = 'path-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'D:\work\project';
  input.value = app.cwdDraft || app.lastCwd || app.activeCwd || '';
  app.cwdDraft = null;
  inputRow.appendChild(input);

  const browse = document.createElement('button');
  browse.className = 'ghost-btn';
  browse.textContent = '浏览…';
  browse.addEventListener('click', () => {
    pickFolder(input.value, (picked) => {
      if (!picked) return;
      app.cwdDraft = picked;
      askCwd();
    });
  });
  inputRow.appendChild(browse);

  card.appendChild(inputRow);

  const recent = [...new Set([...(app.recentWorkspaces || []), ...app.sessions.map((session) => session.cwd)])]
    .filter(Boolean)
    .slice(0, 6);
  if (recent.length) {
    const list = document.createElement('div');
    list.className = 'options';
    for (const cwd of recent) {
      const option = document.createElement('button');
      option.className = 'option';
      option.textContent = cwd;
      option.addEventListener('click', () => {
        input.value = cwd;
        input.focus();
      });
      list.appendChild(option);
    }
    card.appendChild(list);
  }

  const check = document.createElement('div');
  check.className = 'modal-hint';
  card.appendChild(check);

  const checkPath = (value) => {
    if (!value) {
      check.textContent = '';
      return;
    }

    app.pathCheck = value;
    send({ type: 'check_path', path: value });
  };
  let checkTimer = 0;
  input.addEventListener('input', () => {
    window.clearTimeout(checkTimer);
    const value = input.value.trim();
    checkTimer = window.setTimeout(() => checkPath(value), 260);
  });
  checkPath(input.value.trim());

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancel = document.createElement('button');
  cancel.className = 'ghost-btn';
  cancel.textContent = '取消';
  cancel.addEventListener('click', closeModal);
  const start = document.createElement('button');
  start.className = 'primary-btn';
  start.textContent = '开始';
  start.addEventListener('click', () => startSession(input.value.trim()));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') startSession(input.value.trim());
  });
  actions.appendChild(cancel);
  actions.appendChild(start);
  card.appendChild(actions);

  el.modal.innerHTML = '';
  el.modal.appendChild(card);
  el.modal.hidden = false;
  setTimeout(() => input.focus(), 0);
}

function startSession(cwd) {
  if (!cwd) return;
  closeModal();
  setOverlay('正在打开对话…');
  pendingCwd = cwd;
  app.lastCwd = cwd;
  if (!send({ type: 'new_conversation', cwd })) {
    setOverlay(null);
    toast('还没连上 Seven Station Core，等连接恢复再试', 'warning');
  }
}

/* 侧栏：折叠状态记在本地，重开还是上次的样子 */
function setSidebar(open) {
  closeModelPanel();
  el.windowEl.classList.toggle('sidebar-collapsed', !open);
  el.sidebarToggle.hidden = open;
  try {
    localStorage.setItem('sevenstation.sidebar', open ? '1' : '0');
  } catch {
    // 无痕模式写不了，忽略。
  }
}

el.collapseBtn.addEventListener('click', () => setSidebar(false));
el.sidebarToggle.addEventListener('click', () => setSidebar(true));

/* ------------------------------------------------------------------ *
 * 桌面壳：窗口边框、最小化这些交给系统（Tauri 用系统标题栏），
 * 页面这边只保留一件跟壳有关的事——选目录时开系统的对话框
 * ------------------------------------------------------------------ */

const shell = window.__TAURI__ && window.__TAURI__.core ? window.__TAURI__.core : null;

let sidebarOpen = true;
try {
  sidebarOpen = localStorage.getItem('sevenstation.sidebar') !== '0';
} catch {
  sidebarOpen = true;
}
setSidebar(sidebarOpen);

el.filterToggle.addEventListener('click', () => {
  el.filterbar.hidden = !el.filterbar.hidden;
  if (!el.filterbar.hidden) el.sessionFilter.focus();
});


el.settingsBtn.addEventListener('click', () => switchView('settings'));
el.threadsNav.addEventListener('click', () => switchView('chat'));
el.skillsNav.addEventListener('click', () => switchView('skills'));
el.extensionsNav.addEventListener('click', () => switchView('extensions'));

/* ------------------------------------------------------------------ *
 * 页面视图：设置 / 技能 / 扩展（右边整块切换，不用弹窗）
 * ------------------------------------------------------------------ */

const PAGE_TITLES = { settings: '设置', skills: '技能', extensions: '扩展' };

function switchView(view) {
  app.view = view;
  closeModelPanel();
  const chat = view === 'chat';

  el.main.classList.toggle('is-page', !chat);
  el.threadsNav.classList.toggle('is-active', chat);
  el.skillsNav.classList.toggle('is-active', view === 'skills');
  el.extensionsNav.classList.toggle('is-active', view === 'extensions');
  el.settingsBtn.classList.toggle('is-active', view === 'settings');
  el.composer.hidden = !chat;
  el.pageView.hidden = chat;

  if (chat) {
    showWorkspace(Boolean(app.currentKey));
    renderHeader();
    return;
  }

  el.thread.hidden = true;
  el.empty.hidden = true;
  el.jumpBottom.hidden = true;
  el.content.classList.remove('is-empty');
  el.sessionTitle.textContent = PAGE_TITLES[view] || '';
  el.sessionTitle.title = '';
  el.sessionCwd.textContent = '';
  el.crumbSep.hidden = true;
  el.pageView.scrollTop = 0;
  if (view === 'skills' && !app.skills) requestSkills();
  if (view === 'extensions' && !app.extensions) requestExtensions();
  renderPage(view);
}

function renderPage(view) {
  el.pageInner.innerHTML = '';
  if (view === 'settings') renderSettingsPage();
  if (view === 'skills') renderSkillsPage();
  if (view === 'extensions') renderExtensionsPage();
}

function makePageHead(title, note, action) {
  const head = document.createElement('div');
  head.className = 'page-head';

  const text = document.createElement('div');
  const heading = document.createElement('h2');
  heading.textContent = title;
  text.appendChild(heading);

  if (note) {
    const line = document.createElement('p');
    line.className = 'page-note';
    line.textContent = note;
    text.appendChild(line);
  }

  head.appendChild(text);
  if (action) head.appendChild(action);
  return head;
}

function makePageCard(title, note) {
  const card = document.createElement('section');
  card.className = 'page-card';

  if (title) {
    const heading = document.createElement('h3');
    heading.textContent = title;
    card.appendChild(heading);
  }

  if (note) {
    const line = document.createElement('p');
    line.className = 'page-note';
    line.textContent = note;
    card.appendChild(line);
  }

  return card;
}

/** 打字时误按不会停：默认关，开了才会在模型干活时打断。 */
function makeInterruptToggle() {
  const row = document.createElement('div');
  row.className = 'kv-row kv-row-toggle';

  const left = document.createElement('div');
  left.className = 'kv-toggle-text';
  const label = document.createElement('span');
  label.className = 'kv-toggle-label';
  label.textContent = 'Ctrl+Enter 直接打断';
  const note = document.createElement('span');
  note.className = 'kv-toggle-note';
  note.textContent = '关掉时只有停止键能停';
  left.appendChild(label);
  left.appendChild(note);

  const toggle = document.createElement('button');
  toggle.className = 'switch' + (prefs.interrupt ? ' is-on' : '');
  toggle.type = 'button';
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-checked', prefs.interrupt ? 'true' : 'false');
  toggle.setAttribute('aria-label', 'Ctrl+Enter 直接打断');
  const knob = document.createElement('span');
  knob.className = 'switch-knob';
  toggle.appendChild(knob);
  toggle.addEventListener('click', () => {
    prefs.interrupt = !prefs.interrupt;
    savePrefs();
    toggle.classList.toggle('is-on', prefs.interrupt);
    toggle.setAttribute('aria-checked', prefs.interrupt ? 'true' : 'false');
  });

  row.appendChild(left);
  row.appendChild(toggle);
  return row;
}

function addKeyValues(card, rows) {
  const list = document.createElement('div');
  list.className = 'kv';

  rows.forEach(([key, value]) => {
    const row = document.createElement('div');
    row.className = 'kv-row';

    const label = document.createElement('span');
    label.className = 'kv-key';
    label.textContent = key;

    const text = document.createElement('span');
    text.className = 'kv-value';
    text.textContent = value || '未知';
    text.title = value || '';

    row.appendChild(label);
    row.appendChild(text);
    list.appendChild(row);
  });

  card.appendChild(list);
}

function makeRefreshButton(label, onClick) {
  const button = document.createElement('button');
  button.className = 'ghost-btn';
  button.textContent = label || '刷新';
  button.addEventListener('click', onClick);
  return button;
}

function makeBadge(text, tone) {
  const badge = document.createElement('span');
  badge.className = 'badge' + (tone ? ' badge-' + tone : '');
  badge.textContent = text;
  return badge;
}

function listenText() {
  const listen = app.listen || '';
  if (!listen) return '未知';
  return listen + (/127\.0\.0\.1|localhost/.test(listen) ? '（只本机能连）' : '（局域网可连）');
}

/* -------------------------------- 设置 -------------------------------- */

function renderAppearanceCard() {
  const card = makePageCard('外观');
  const block = document.createElement('div');
  block.className = 'appearance-block';

  const group = (label, control) => {
    const wrap = document.createElement('div');
    wrap.className = 'appearance-group';
    const caption = document.createElement('span');
    caption.className = 'appearance-label';
    caption.textContent = label;
    wrap.appendChild(caption);
    wrap.appendChild(control);
    return wrap;
  };

  const seg = document.createElement('div');
  seg.className = 'seg';
  for (const theme of THEMES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = theme.name;
    button.classList.toggle('is-on', appearance.theme === theme.id);
    button.addEventListener('click', () => {
      setAppearance({ theme: theme.id });
      card.replaceWith(renderAppearanceCard());
    });
    seg.appendChild(button);
  }

  const paletteRow = document.createElement('div');
  paletteRow.className = 'palette-row';
  for (const palette of PALETTES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'palette-btn';
    button.classList.toggle('is-on', appearance.palette === palette.id);
    const dot = document.createElement('span');
    dot.className = 'palette-dot';
    dot.style.background = palette.dot;
    button.appendChild(dot);
    button.appendChild(document.createTextNode(palette.name));
    button.addEventListener('click', () => {
      setAppearance({ palette: palette.id });
      card.replaceWith(renderAppearanceCard());
    });
    paletteRow.appendChild(button);
  }

  const bubbleRow = document.createElement('div');
  bubbleRow.className = 'palette-row';
  for (const tone of BUBBLE_TONES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'palette-btn';
    button.classList.toggle('is-on', appearance.bubble === tone.id);
    const dot = document.createElement('span');
    dot.className = 'palette-dot';
    dot.style.background = tone.dot;
    button.appendChild(dot);
    button.appendChild(document.createTextNode(tone.name));
    button.addEventListener('click', () => {
      setAppearance({ bubble: tone.id });
      card.replaceWith(renderAppearanceCard());
    });
    bubbleRow.appendChild(button);
  }

  block.appendChild(group('主题', seg));
  block.appendChild(group('配色', paletteRow));
  block.appendChild(group('用户气泡', bubbleRow));

  card.appendChild(block);
  return card;
}

/**
 * 字体大小：按区域各选一档。
 * 正文读起来累就放大，过程区想多塞点就缩小，两边互不牵连；
 * 只存这台设备的 localStorage，不进 Seven Station Core 的设置。
 */
function renderFontCard() {
  const card = makePageCard('字体大小', '只影响这台设备上的显示，不写进 Seven Station Core 的设置。');

  const block = document.createElement('div');
  block.className = 'appearance-block';

  for (const region of FONT_REGIONS) {
    const row = document.createElement('div');
    row.className = 'seg';

    for (const step of FONT_STEPS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = step.name;
      button.classList.toggle('is-on', appearance.fonts[region.id] === step.id);
      button.addEventListener('click', () => {
        setAppearance({ fonts: { [region.id]: step.id } });
        // 字号一变，换行、行高、输入框高度都要重算，重画这一张卡片最省事。
        card.replaceWith(renderFontCard());
        if (typeof autoGrow === 'function') autoGrow();
      });
      row.appendChild(button);
    }

    const wrap = document.createElement('div');
    wrap.className = 'appearance-group';
    wrap.title = region.hint || '';

    const caption = document.createElement('span');
    caption.className = 'appearance-label';
    caption.textContent = region.name;

    wrap.append(caption, row);
    block.appendChild(wrap);
  }

  card.appendChild(block);
  return card;
}

/**
 * 桌面客户端才有的桥：Tauri 注入的全局对象。浏览器里打开页面时它不存在，
 * 所以「这台设备连的 Seven Station Core」这一块在网页访问时不出现。
 */
function clientInvoke() {
  const bridge = window.__TAURI__;
  if (!bridge || !bridge.core || typeof bridge.core.invoke !== 'function') return null;
  return bridge.core.invoke;
}

/**
 * 这台设备自己的连接设置。装在别的机器上的客户端只认这一份，
 * Seven Station Core 那台机器上的设置与它无关。
 */
function renderClientCenterCard() {
  const invoke = clientInvoke();
  if (!invoke) return null;

  const card = makePageCard('这台设备连的 Seven Station Core');

  const urlRow = document.createElement('div');
  urlRow.className = 'row-edit';
  const urlLabel = document.createElement('span');
  urlLabel.className = 'row-label';
  urlLabel.textContent = 'Seven Station Core 地址';
  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.placeholder = 'http://192.168.1.10:8787/';
  urlInput.spellcheck = false;
  urlRow.append(urlLabel, urlInput);
  card.appendChild(urlRow);

  const tokenRow = document.createElement('div');
  tokenRow.className = 'row-edit';
  const tokenLabel = document.createElement('span');
  tokenLabel.className = 'row-label';
  tokenLabel.textContent = '访问令牌';
  const tokenInput = document.createElement('input');
  tokenInput.type = 'text';
  tokenInput.placeholder = '访问令牌';
  tokenInput.spellcheck = false;
  tokenRow.append(tokenLabel, tokenInput);
  card.appendChild(tokenRow);

  const status = document.createElement('p');
  status.className = 'page-note';
  status.textContent = '读取中…';
  card.appendChild(status);

  const actions = document.createElement('div');
  actions.className = 'css-actions';
  const save = document.createElement('button');
  save.className = 'ghost-btn small';
  save.textContent = '保存并重连';
  save.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    const token = tokenInput.value.trim();
    if (!url) {
      status.textContent = 'Seven Station Core 地址不能为空';
      return;
    }

    save.disabled = true;
    status.textContent = '保存中…';
    try {
      await invoke('client_config_save', { url, token });
      status.textContent = '已保存，正在连新的地址…';
    } catch (error) {
      save.disabled = false;
      status.textContent = '保存失败：' + (error && error.message ? error.message : error);
    }
  });
  actions.appendChild(save);
  card.appendChild(actions);

  invoke('client_config_get')
    .then((config) => {
      urlInput.value = config.url || '';
      tokenInput.value = config.token || '';

      status.textContent = config.token
        ? ''
        : '还没有令牌，连不上 Seven Station Core';
    })
    .catch((error) => {
      status.textContent = '读不到当前设置：' + (error && error.message ? error.message : error);
    });

  return card;
}


/**
 * 访问令牌。网页版（手机浏览器、别的电脑）打开这个页面时，这里是唯一的入口；
 * 桌面客户端里也能用，只是它还有一份自己的地址设置。
 */
function renderTokenCard() {
  const card = makePageCard('访问令牌');

  const current = document.createElement('p');
  current.className = 'page-note';
  current.textContent = transport.token
    ? '当前：' + transport.token.slice(0, 8) + '…（存在这台设备的浏览器里，不会传到别处）'
    : '还没有令牌，填了才能连上。令牌在 Seven Station Core 那台机器的 %ProgramData%\SevenStation.Core\token.txt，'
      + '或者在 Control 里点「添加设备」生成一个给这台设备专用的。';
  card.appendChild(current);

  const row = document.createElement('div');
  row.className = 'row-edit';
  const label = document.createElement('span');
  label.className = 'row-label';
  label.textContent = '令牌';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '粘贴访问令牌';
  input.spellcheck = false;
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') input.dataset.enter = '1';
  });
  row.append(label, input);
  card.appendChild(row);

  const actions = document.createElement('div');
  actions.className = 'css-actions';

  const save = document.createElement('button');
  save.className = 'ghost-btn small';
  save.textContent = '保存并重连';
  save.addEventListener('click', () => {
    const value = input.value.trim();
    if (!value) {
      toast('先把令牌粘贴进来', 'warning');
      return;
    }

    saveToken(value);
    transport.attempts = 0;
    if (transport.socket) {
      try { transport.socket.close(); } catch { /* 已经断了 */ }
      transport.socket = null;
    }
    connect();
    renderPage('settings');
    toast('令牌已保存，正在重连');
  });

  const clear = document.createElement('button');
  clear.className = 'ghost-btn small';
  clear.textContent = '清除';
  clear.addEventListener('click', () => {
    saveToken('');
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* 无所谓 */ }
    if (transport.socket) {
      try { transport.socket.close(); } catch { /* 已经断了 */ }
      transport.socket = null;
    }
    renderPage('settings');
    setConnectionState('还没有访问令牌：去「设置」里填一个', false);
  });

  actions.append(save, clear);
  card.appendChild(actions);
  return card;
}

/* ------------------------------------------------------------------ *
 * 更新：Pi 自己与扩展有没有新版
 * Seven Station Core 每 6 小时查一次，结果推过来；这里只负责照着画。
 * 没有更新就什么都不露——一个「都是最新」的常驻提示只会占地方。
 * ------------------------------------------------------------------ */

function updateSummary() {
  const data = app.updates;
  if (!data) return null;
  const pi = data.pi && data.pi.hasUpdate ? data.pi : null;
  const packages = (data.packages || []).filter((item) => item.hasUpdate);
  if (!pi && !packages.length) return null;
  return { pi, packages, checkedAt: data.checkedAt || '' };
}

function versionNode(from, to) {
  const strong = document.createElement('strong');
  strong.textContent = `${from} → ${to}`;
  return strong;
}

function renderUpdateStrip() {
  const summary = updateSummary();
  const show = Boolean(summary) && !app.updDismissed;
  el.updStrip.hidden = !show;
  el.updText.textContent = '';
  if (!show) return;

  if (summary.pi) {
    el.updText.append('Pi 有新版本 ');
    el.updText.append(versionNode(summary.pi.installed || '未知', summary.pi.latest || '未知'));
    if (summary.packages.length) {
      el.updText.append(`，另有 ${summary.packages.length} 个扩展待更新`);
    }

    return;
  }

  el.updText.append(`${summary.packages.length} 个扩展有新版本`);
}

function renderNavUpdate() {
  const packages = (app.updates && app.updates.packages) || [];
  el.extensionsUpdate.hidden = !packages.some((item) => item.hasUpdate);
}

el.updLater.addEventListener('click', () => {
  app.updDismissed = true;
  renderUpdateStrip();
});

el.updGo.addEventListener('click', () => requestUpgrade());

function requestUpgrade() {
  setUpgradeBusy(true);
  send({ type: 'upgrade_pi' });
}

/** 升级期间把三处入口都按住：一次只能跑一个，重复点没有意义。 */
function setUpgradeBusy(busy) {
  el.updGo.disabled = busy;
  el.updGo.textContent = busy ? '正在升级…' : '升级';
  document.querySelectorAll('.upd-upgrade').forEach((button) => {
    button.disabled = busy;
    button.textContent = busy ? '正在升级…' : '升级';
  });
}

/**
 * 升级只有两种状态进卡片：开始（转圈）和结束（原地换字）。
 * 中间那些下载进度不刷到界面上——一张卡片翻个面就够了，别让人读 npm 的日志。
 */
let upgradeCard = null;

function handleUpdateJob(message) {
  if (message.state === 'running') {
    // Pi 升完还要升扩展：还是这一张卡片，只换字。
    const text = message.target === 'extensions'
      ? '正在更新扩展…'
      : `正在升级 Pi${message.from && message.to ? ` ${message.from} → ${message.to}` : ''}…`;
    if (upgradeCard) {
      setToastText(upgradeCard.node, text);
    } else {
      upgradeCard = statusToast(text);
    }

    setUpgradeBusy(true);
    return;
  }

  const failed = message.state === 'failed';
  const text = message.text || (failed ? '升级没成功' : '升级完成');
  if (upgradeCard) {
    upgradeCard.update(text, failed ? 'error' : '');
    upgradeCard = null;
  } else {
    toast(text, failed ? 'error' : '');
  }

  setUpgradeBusy(false);
}

function renderRuntimeCard() {
  const card = makePageCard('运行时');
  card.id = 'runtimeCard';

  const data = app.updates;
  const pi = data && data.pi;
  const packages = (data && data.packages) || [];
  const stale = packages.filter((item) => item.hasUpdate);

  const list = document.createElement('div');
  list.className = 'kv';

  const addRow = (key, nodes, flag) => {
    const row = document.createElement('div');
    row.className = 'kv-row';

    const label = document.createElement('span');
    label.className = 'kv-key';
    label.textContent = key;

    const value = document.createElement('span');
    value.className = 'kv-value';
    nodes.forEach((node) => value.append(node));

    if (flag) {
      const badge = document.createElement('span');
      badge.className = 'upd-badge';
      badge.textContent = '有新版';
      value.append(badge);
    }

    row.append(label, value);
    list.append(row);
  };

  if (!data) {
    addRow('Pi', ['还没查过']);
  } else if (!pi || !pi.installed) {
    addRow('Pi', ['版本未知']);
  } else if (pi.hasUpdate) {
    addRow('Pi', [versionNode(pi.installed, pi.latest || '未知')], true);
  } else {
    addRow('Pi', [pi.installed]);
  }

  if (data && packages.length) {
    const text = stale.length
      ? `${packages.length} 个，${stale.length} 个可更新`
      : `${packages.length} 个，都是最新`;
    addRow('扩展', [text], stale.length > 0);
  }

  const models = data && data.models;
  if (models) {
    const count = app.modelsAt && modelEntries().length ? modelEntries().length : models.count;
    const stamp = app.modelsAt || (models.cachedAt ? Date.parse(models.cachedAt) : 0);
    const when = stamp ? relativeTime(stamp) + '刷新' : '';
    addRow('模型目录', [count > 0 ? `${count} 个${when ? ' · ' + when : ''}` : '还没取过']);
  } else {
    addRow('模型目录', ['交给 Pi 取，取过一次就缓存 24 小时']);
  }

  const checked = data && data.checkedAt
    ? new Date(data.checkedAt).toLocaleString('zh-CN', { hour12: false })
    : '';
  addRow('上次检查', [checked || (data && data.checking ? '正在查…' : '还没查过')]);
  card.append(list);

  if (stale.length) {
    const detail = document.createElement('div');
    detail.className = 'upd-detail';
    stale.forEach((item) => {
      const line = document.createElement('div');
      line.className = 'upd-detail-row';
      const name = document.createElement('span');
      name.className = 'upd-detail-name';
      name.textContent = item.name;
      name.title = item.source || item.name;
      const version = document.createElement('span');
      version.className = 'upd-detail-version';
      version.append(versionNode(item.installed || '未知', item.latest || '未知'));
      line.append(name, version);
      detail.append(line);
    });
    card.append(detail);
  }

  const actions = document.createElement('div');
  actions.className = 'page-actions';

  if (pi && pi.hasUpdate) {
    const upgrade = document.createElement('button');
    upgrade.type = 'button';
    upgrade.className = 'ghost-btn small upd-upgrade';
    upgrade.textContent = '升级';
    upgrade.addEventListener('click', () => requestUpgrade());
    actions.append(upgrade);
  }

  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'ghost-btn small';
  check.textContent = data && data.checking ? '正在查…' : '检查更新';
  check.disabled = Boolean(data && data.checking);
  check.addEventListener('click', () => {
    send({ type: 'check_updates', force: true });
    check.disabled = true;
    check.textContent = '正在查…';
  });
  actions.append(check);

  if (models) {
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'ghost-btn small';
    refresh.textContent = '重取模型';
    const key = app.currentKey;
    if (!key) {
      refresh.disabled = true;
      refresh.title = '先打开一条对话，模型清单要问 Pi 才有';
    } else {
      refresh.addEventListener('click', () => {
        app.modelsAt = Date.now();
        send({ type: 'list_models', key, force: true });
        refresh.disabled = true;
        refresh.textContent = '正在取…';
      });
    }

    actions.append(refresh);
  }

  card.append(actions);

  return card;
}

/**
 * 一张卡片画不出来不该把整页连带拖走：出错记到控制台，后面的照画。
 * （2026-11-23：卡片里引用错一个函数，结果「运行时」往后整段设置都消失了，界面上也没有任何提示。）
 */
function appendCard(build) {
  try {
    const node = build();
    if (node) el.pageInner.appendChild(node);
  } catch (error) {
    console.error('设置页有一张卡片没画出来：', error);
  }
}

function renderSettingsPage() {
  el.pageInner.appendChild(makePageHead('设置'));
  appendCard(renderAppearanceCard);
  appendCard(renderFontCard);
  appendCard(renderRuntimeCard);

  const connection = makePageCard('连接');
  const local = location.hostname === '127.0.0.1' || location.hostname === 'localhost';
  addKeyValues(connection, [
    ['Seven Station Core', location.origin],
    ['版本', app.centerVersion || '未知'],
    ['状态', transport.connected ? '已连接' : '未连接'],
    ['数据文件', app.storePath || '未知'],
    ['访问', local ? '本机' : '局域网'],
  ]);
  el.pageInner.appendChild(connection);
  appendCard(renderTokenCard);

  // 只有装成桌面客户端时才有本机设置（浏览器里直接打开页面拿不到这个桥）。
  appendCard(renderClientCenterCard);

  const agent = app.agent;
  const card = makePageCard(agent ? agent.name : 'Agent');
  const rows = agent && Array.isArray(agent.info) ? agent.info : [];
  addKeyValues(card, rows.length
    ? rows.map((row) => [row.label, row.value || '未知'])
    : [['状态', '还没连上 Seven Station Core']]);
  el.pageInner.appendChild(card);

  const recent = makePageCard('最近工作区');
  if (!app.recentWorkspaces || !app.recentWorkspaces.length) {
    const empty = document.createElement('p');
    empty.className = 'page-note';
    empty.textContent = '还没有用过工作区';
    recent.appendChild(empty);
  } else {
    const list = document.createElement('div');
    list.className = 'chips';
    app.recentWorkspaces.forEach((dir) => {
      const chip = document.createElement('button');
      chip.className = 'chip-btn';
      chip.textContent = dir;
      chip.title = dir;
      chip.addEventListener('click', () => {
        app.cwdDraft = dir;
        askCwd();
      });
      list.appendChild(chip);
    });
    recent.appendChild(list);
  }
  el.pageInner.appendChild(recent);

  const keys = makePageCard('快捷键与操作');
  const shortcutRows = [
    ['Enter', '发送'],
    ['Shift+Enter', '换行'],
    ['Ctrl+K', '新建对话'],
    ['Ctrl+B', '收起侧栏'],
    ['Ctrl+F', '搜索对话'],
    ['Esc', '关掉弹层'],
  ];
  const shortcutList = document.createElement('div');
  shortcutList.className = 'kv';
  shortcutRows.forEach(([combo, what]) => {
    const row = document.createElement('div');
    row.className = 'kv-row';
    const key = document.createElement('span');
    key.className = 'kv-key';
    key.textContent = combo;
    const text = document.createElement('span');
    text.className = 'kv-value';
    text.textContent = what;
    row.appendChild(key);
    row.appendChild(text);
    shortcutList.appendChild(row);
  });
  keys.appendChild(shortcutList);
  keys.appendChild(makeInterruptToggle());
  el.pageInner.appendChild(keys);

  const style = makePageCard('自定义样式', '保存后所有设备一起生效。');
  const editor = document.createElement('textarea');
  editor.className = 'css-editor';
  editor.spellcheck = false;
  editor.value = app.customCss || DEFAULT_CSS;
  style.appendChild(editor);

  const styleBar = document.createElement('div');
  styleBar.className = 'css-actions';

  const saveStyle = document.createElement('button');
  saveStyle.className = 'primary-btn small';
  saveStyle.textContent = '保存';
  saveStyle.addEventListener('click', () => {
    send({ type: 'set_css', css: editor.value });
    applyCustomCss(editor.value);
    toast('样式已保存');
  });

  const resetStyle = document.createElement('button');
  resetStyle.className = 'ghost-btn small';
  resetStyle.textContent = '恢复默认';
  resetStyle.addEventListener('click', () => {
    editor.value = DEFAULT_CSS;
    send({ type: 'set_css', css: DEFAULT_CSS });
    applyCustomCss(DEFAULT_CSS);
    toast('已恢复默认样式');
  });

  const clearStyle = document.createElement('button');
  clearStyle.className = 'ghost-btn small';
  clearStyle.textContent = '清空';
  clearStyle.addEventListener('click', () => {
    editor.value = '';
    send({ type: 'set_css', css: '' });
    applyCustomCss('');
    toast('已清空，回到默认样式');
  });

  styleBar.appendChild(saveStyle);
  styleBar.appendChild(resetStyle);
  styleBar.appendChild(clearStyle);
  style.appendChild(styleBar);
  el.pageInner.appendChild(style);

  // 按钮跟标题站同一行，卡片里就只剩一条竖向流：标题 → 说明 → 日志。
  const logs = makePageCard();
  const logsHead = document.createElement('div');
  logsHead.className = 'card-head';
  const logsTitle = document.createElement('h3');
  logsTitle.textContent = '日志';
  const readLog = document.createElement('button');
  readLog.className = 'ghost-btn small';
  readLog.textContent = '读最近日志';
  readLog.addEventListener('click', () => send({ type: 'read_log', lines: 120 }));
  logsHead.append(logsTitle, readLog);
  logs.appendChild(logsHead);

  const logBox = document.createElement('pre');
  logBox.className = 'log-tail';
  logBox.id = 'logTailBox';
  logBox.textContent = app.logTail ? app.logTail.text || '（空）' : '还没读过';
  logs.appendChild(logBox);
  el.pageInner.appendChild(logs);
}

/* -------------------------------- 技能 -------------------------------- */

function renderSkillsPage() {
  const data = app.skills;
  const refresh = makeRefreshButton('刷新', () => {
    app.skills = null;
    requestSkills();
  });

  el.pageInner.appendChild(makePageHead(
    '技能',
    data ? '' : '正在读技能清单…',
    refresh,
  ));

  if (!data) return;

  const groups = new Map();
  data.items.forEach((item) => {
    const scope = item.scope || '用户';
    if (!groups.has(scope)) groups.set(scope, []);
    groups.get(scope).push(item);
  });

  if (!data.items.length) {
    const card = makePageCard();
    const empty = document.createElement('p');
    empty.className = 'page-note';
    empty.textContent = '还没有技能。把带 SKILL.md 的目录放进 ~/.pi/agent/skills 或工作区的 .pi/skills。';
    card.appendChild(empty);
    el.pageInner.appendChild(card);
    return;
  }

  ['用户', '项目'].forEach((scope) => {
    const items = groups.get(scope);
    if (!items || !items.length) return;

    const card = makePageCard(scope === '用户' ? '用户技能' : '项目技能（' + baseName(app.activeCwd || '') + '）');
    const list = document.createElement('div');
    list.className = 'item-list';

    items.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'item-row';

      const top = document.createElement('div');
      top.className = 'item-top';
      const name = document.createElement('span');
      name.className = 'item-name';
      name.textContent = item.name;
      top.appendChild(name);
      if (item.commandOnly) top.appendChild(makeBadge('只能手动调用', 'soft'));
      row.appendChild(top);

      if (item.description) {
        const desc = document.createElement('p');
        desc.className = 'item-desc clamp';
        desc.textContent = item.description;
        desc.title = item.description;
        row.appendChild(desc);
      }

      const path = document.createElement('span');
      path.className = 'item-path';
      path.textContent = item.path;
      path.title = item.path;
      row.appendChild(path);

      list.appendChild(row);
    });

    card.appendChild(list);
    el.pageInner.appendChild(card);
  });
}

function requestSkills() {
  send({ type: 'list_skills', cwd: app.activeCwd || app.lastCwd || '' });
}

/* -------------------------------- 扩展 -------------------------------- */

function renderExtensionsPage() {
  const data = app.extensions;
  const refresh = makeRefreshButton('刷新', () => {
    app.extensions = null;
    requestExtensions();
  });

  el.pageInner.appendChild(makePageHead(
    '扩展',
    data ? '' : '正在读扩展清单…',
    refresh,
  ));

  if (!data) return;

  const packages = makePageCard('扩展包');
  if (!data.packages.length) {
    const empty = document.createElement('p');
    empty.className = 'page-note';
    empty.textContent = '还没有装扩展包。用 pi install 装一个再刷新。';
    packages.appendChild(empty);
  } else {
    const list = document.createElement('div');
    list.className = 'item-list';

    data.packages.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'item-row';

      const top = document.createElement('div');
      top.className = 'item-top';
      const name = document.createElement('span');
      name.className = 'item-name';
      name.textContent = item.name;
      top.appendChild(name);
      top.appendChild(makeBadge(item.kind, 'soft'));
      if (item.version) top.appendChild(makeBadge(item.version, 'plain'));
      if (!item.installed) top.appendChild(makeBadge('没装上', 'warn'));
      row.appendChild(top);

      const where = document.createElement('span');
      where.className = 'item-path';
      where.textContent = item.installed && item.path ? item.path : item.source;
      where.title = item.path || item.source;
      row.appendChild(where);

      list.appendChild(row);
    });

    packages.appendChild(list);
  }

  if (data.problems.length) {
    data.problems.forEach((problem) => {
      const line = document.createElement('p');
      line.className = 'page-note warn';
      line.textContent = problem;
      packages.appendChild(line);
    });
  }

  el.pageInner.appendChild(packages);

  const commands = makePageCard('扩展命令');
  if (!data.commands.length) {
    const empty = document.createElement('p');
    empty.className = 'page-note';
    empty.textContent = '这个工作区还没有扩展命令。打开一个对话后再回来。';
    commands.appendChild(empty);
  } else {
    const list = document.createElement('div');
    list.className = 'item-list';

    data.commands.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'item-row';

      const top = document.createElement('div');
      top.className = 'item-top';
      const name = document.createElement('span');
      name.className = 'item-name';
      name.textContent = '/' + item.name;
      top.appendChild(name);
      if (item.scope && item.scope !== '扩展') top.appendChild(makeBadge(item.scope, 'soft'));
      row.appendChild(top);

      if (item.description) {
        const desc = document.createElement('p');
        desc.className = 'item-desc';
        desc.textContent = item.description;
        row.appendChild(desc);
      }

      list.appendChild(row);
    });

    commands.appendChild(list);
  }

  el.pageInner.appendChild(commands);
}

function requestExtensions() {
  // 扩展命令是 Pi 报的，Seven Station Core 只认缓存。手上有开着的对话就顺手让它报一遍。
  const session = current();
  if (session && !session.commands) {
    send({ type: 'list_commands', key: session.key });
  }
  send({ type: 'list_extensions', cwd: app.activeCwd || app.lastCwd || '' });
}

el.restoreSessionBtn.addEventListener('click', openRestoreDialog);

el.newSessionBtn.addEventListener('click', () => {
  switchView('chat');
  newSession();
});
el.emptyNewBtn.addEventListener('click', () => {
  switchView('chat');
  newSession();
});
el.renameBtn.addEventListener('click', renameConversation);
el.sessionTitle.addEventListener('dblclick', renameConversation);

function renameConversation() {
  const session = current();
  if (!session) return;

  closeModal();
  const card = document.createElement('div');
  card.className = 'modal';

  const title = document.createElement('h3');
  title.textContent = '给这个对话改个名字';
  card.appendChild(title);

  const input = document.createElement('input');
  input.type = 'text';
  input.value = (session.state && session.state.sessionName) || '';
  card.appendChild(input);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  const cancel = document.createElement('button');
  cancel.className = 'ghost-btn';
  cancel.textContent = '取消';
  cancel.addEventListener('click', closeModal);

  const save = document.createElement('button');
  save.className = 'primary-btn';
  save.textContent = '保存';
  const commit = () => {
    const next = input.value.trim();
    if (!next) {
      toast('名字不能是空的', 'warning');
      return;
    }
    closeModal();
    send({ type: 'rename_conversation', id: session.key, title: next });
  };
  save.addEventListener('click', commit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') commit();
  });

  actions.appendChild(cancel);
  actions.appendChild(save);
  card.appendChild(actions);

  el.modal.innerHTML = '';
  el.modal.appendChild(card);
  el.modal.hidden = false;
  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
}

let searchTimer = 0;
el.sessionFilter.addEventListener('input', () => {
  app.filter = el.sessionFilter.value;
  renderSessionList();

  window.clearTimeout(searchTimer);
  const query = app.filter.trim();
  if (!query) {
    app.searchResults = null;
    return;
  }

  searchTimer = window.setTimeout(() => send({ type: 'search', query }), 240);
});

el.modelPill.addEventListener('click', () => {
  if (modelState.open) {
    closeModelPanel();
  } else {
    openModelPanel();
  }
});

el.modelPill.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'Enter') {
    event.preventDefault();
    openModelPanel();
  }
});

el.modelPanel.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeModelPanel();
    el.modelPill.focus();
    return;
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    moveModelFocus(1);
    return;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveModelFocus(-1);
    return;
  }
  if (event.key === 'Enter') {
    const entry = (modelState.rows || [])[modelState.focus];
    if (entry) {
      event.preventDefault();
      pickModel(entry);
    }
  }
});

document.addEventListener('mousedown', (event) => {
  if (!modelState.open) return;
  if (el.modelPanel.contains(event.target) || el.modelPill.contains(event.target)) return;
  closeModelPanel();
});

el.thinkingSelect.addEventListener('change', () => {
  const session = current();
  if (!session) return;
  send({ type: 'set_thinking', key: session.key, level: el.thinkingSelect.value });
});

el.compactBtn.addEventListener('click', () => {
  const session = current();
  if (!session) return;
  send({ type: 'compact', key: session.key });
  if (!app.compactionToast) {
    const handle = statusToast('正在压缩上下文');
    app.compactionToast = handle;
    window.setTimeout(() => {
      if (app.compactionToast !== handle) return;
      app.compactionToast = null;
      handle.update('压缩好像没结束，可以再点一次', 'warning');
    }, 120000);
  }
});

/* ------------------------------------------------------------------ *
 * 输入与发送
 * ------------------------------------------------------------------ */

function autoGrow() {
  el.input.style.height = 'auto';
  el.input.style.height = Math.min(el.input.scrollHeight, 220) + 'px';
}

el.input.addEventListener('input', () => {
  autoGrow();
  updateSendReady();
  queueCompletion();
  rememberDraft();
});

/**
 * 草稿按会话存。
 * 以前只有一个输入框：在 A 里打了一段话没发，切到 B 直接回车，那段话就发到 B 去了。
 * 现在切会话就换一份草稿，谁也不串。
 */
function rememberDraft() {
  const key = app.currentKey;
  if (!key) return;
  // 正在改队列里的某一条：输入框里装的是那条消息，不是草稿。
  if (queueEditId) return;

  const text = el.input.value;
  if (text.trim()) app.drafts.set(key, text);
  else app.drafts.delete(key);

  if (app.attachments.length) app.attachmentDrafts.set(key, app.attachments.slice());
  else app.attachmentDrafts.delete(key);
}

function restoreDraft(key) {
  const text = (key && app.drafts.get(key)) || '';
  if (el.input.value !== text) {
    el.input.value = text;
    autoGrow();
    updateSendReady();
  }

  // 附件跟着会话换，谁也不带谁的东西过去。
  app.attachments = ((key && app.attachmentDrafts.get(key)) || []).slice();
  renderAttachments();
}

el.input.addEventListener('keydown', (event) => {
  if (completionOpen()) {
    if (event.key === 'ArrowDown') { event.preventDefault(); moveCompletion(1); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); moveCompletion(-1); return; }
    if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
      event.preventDefault();
      acceptCompletion();
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); closeCompletion(); return; }
  }

  if (event.key === 'Escape' && queueEditId) {
    event.preventDefault();
    finishQueueEdit();
    return;
  }

  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submitPrompt();
  }
});

el.input.addEventListener('blur', () => setTimeout(closeCompletion, 120));

document.addEventListener('keydown', (event) => {
  if (!event.ctrlKey || event.altKey || event.metaKey) return;
  const key = event.key.toLowerCase();

  // 在输入框里也要能用，这几个组合不跟打字冲突。
  if (key === 'k') {
    event.preventDefault();
    askCwd();
    return;
  }

  if (key === 'enter' && prefs.interrupt) {
    const session = current();
    if (session && session.streaming) {
      event.preventDefault();
      requestStop(session);
    }
    return;
  }

  if (key === 'b') {
    event.preventDefault();
    el.collapseBtn.click();
    return;
  }

  if (key === 'j') {
    event.preventDefault();
    if (current()) showTerminal(el.terminalPanel.hidden);
    return;
  }

  if (key === 'e') {
    event.preventDefault();
    if (current()) {
      if (el.filePanel.hidden) openFiles(current().filesPath || '');
      else closeFiles();
    }
    return;
  }

  if (key === 'f' && current()) {
    event.preventDefault();
    el.filterToggle.click();
    el.sessionFilter.focus();
    el.sessionFilter.select();
  }
});

/* ------------------------------------------------------------------ *
 * 输入补全：@ 找文件，/ 找命令
 * ------------------------------------------------------------------ */

const completion = { kind: '', items: [], index: 0, start: 0, end: 0, query: '' };
let completionTimer = 0;

function completionOpen() {
  return !el.completions.hidden && completion.items.length > 0;
}

function applyCustomCss(css) {
  let node = document.getElementById('customCss');
  if (!node) {
    node = document.createElement('style');
    node.id = 'customCss';
    document.head.appendChild(node);
  }

  node.textContent = css || DEFAULT_CSS;
  app.customCss = css || '';
}

function closeCompletion() {
  completion.items = [];
  completion.kind = '';
  el.completions.hidden = true;
  el.completions.innerHTML = '';
}

function queueCompletion() {
  const value = el.input.value;
  const caret = el.input.selectionStart ?? value.length;
  const before = value.slice(0, caret);

  if (value.startsWith('/') && !value.slice(0, caret).includes(' ')) {
    requestCommands(before.slice(1));
    return;
  }

  const match = /(^|\s)@([^\s@]*)$/.exec(before);
  const session = current();
  if (!match || !session) {
    closeCompletion();
    return;
  }

  const query = match[2];
  completion.kind = 'file';
  completion.start = caret - query.length - 1;
  completion.end = caret;
  completion.query = query;

  window.clearTimeout(completionTimer);
  completionTimer = window.setTimeout(() => {
    send({ type: 'complete_files', key: session.key, query });
  }, 120);
}

function requestCommands(prefix) {
  const session = current();
  if (!session) {
    closeCompletion();
    return;
  }

  completion.kind = 'command';
  completion.start = 0;
  completion.end = (el.input.selectionStart ?? prefix.length + 1);
  completion.query = prefix;

  const items = (session.commands || []).filter((command) =>
    String(command.name || '').toLowerCase().startsWith(prefix.toLowerCase()));
  renderCompletions(items);

  if (!session.commands) {
    send({ type: 'list_commands', key: session.key });
  }
}

function renderCompletions(items) {
  completion.items = items.slice(0, 60);
  completion.index = 0;

  if (!completion.items.length) {
    el.completions.innerHTML =
      '<div class="empty-hint">' +
      (completion.kind === 'command' ? '这里没有匹配的命令' : '没有匹配的文件') +
      '</div>';
    el.completions.hidden = false;
    return;
  }

  el.completions.innerHTML = '';
  completion.items.forEach((item, index) => {
    const row = document.createElement('button');
    row.className = 'completion-item' + (index === 0 ? ' is-active' : '');

    if (completion.kind === 'file') {
      row.innerHTML =
        '<span class="path">' + escapeHtml(item.path) + '</span>' +
        '<span class="kind">' + (item.dir ? '目录' : '文件') + '</span>';
    } else {
      row.innerHTML =
        '<span class="path">/' + escapeHtml(item.name || '') + '</span>' +
        '<span class="desc">' + escapeHtml(item.description || '') + '</span>' +
        '<span class="kind">' + escapeHtml(item.source || '') + '</span>';
    }

    row.addEventListener('mousedown', (event) => {
      event.preventDefault();
      completion.index = index;
      acceptCompletion();
    });
    el.completions.appendChild(row);
  });

  el.completions.hidden = false;
}

function moveCompletion(step) {
  const count = completion.items.length;
  if (!count) return;
  completion.index = (completion.index + step + count) % count;
  [...el.completions.querySelectorAll('.completion-item')].forEach((node, index) => {
    node.classList.toggle('is-active', index === completion.index);
    if (index === completion.index) node.scrollIntoView({ block: 'nearest' });
  });
}

function acceptCompletion() {
  const item = completion.items[completion.index];
  if (!item) {
    closeCompletion();
    return;
  }

  const value = el.input.value;
  const before = value.slice(0, completion.start);
  const after = value.slice(completion.end);
  const insert = completion.kind === 'file' ? '@' + item.path : '/' + item.name + ' ';

  el.input.value = before + insert + after;
  const caret = (before + insert).length;
  el.input.setSelectionRange(caret, caret);
  el.input.focus();
  closeCompletion();
  autoGrow();

  // 补完目录接着补里面的内容，省得再打一次 @。
  if (item.dir) {
    queueCompletion();
  }
}

/** 停止要跟 Core 说一声才生效，这中间给一条「正在停止」，别让人以为没点上。 */
function requestStop(session) {
  if (!session) return;
  // 已经在停了：再点没有意义，也别重复发 abort。
  if (stopPending && stopPending.key === session.key) return;
  // 这一轮其实已经结束了：说一句，别让人对着没反应的按钮猜。
  if (!session.streaming) {
    toast('这一轮已经结束了');
    return;
  }

  send({ type: 'abort', key: session.key });

  const pending = { key: session.key, handle: statusToast('正在停止') };
  stopPending = pending;

  // 万一 Core 那边没回音，别让圈一直转。
  window.setTimeout(() => {
    if (stopPending !== pending) return;
    stopPending = null;
    pending.handle.update('还没停下来，可以再点一次', 'warning');
  }, 15000);
}

let stopPending = null;

el.sendBtn.addEventListener('click', () => {
  const session = current();
  if (session && session.streaming) {
    requestStop(session);
    return;
  }
  submitPrompt();
});

function exportMarkdown() {
  const session = current();
  if (!session) return;

  const title = (session.state && session.state.sessionName) || '对话';
  const lines = [
    '# ' + title,
    '',
    '- 工作区：`' + (session.cwd || '') + '`',
    '- 导出时间：' + new Date().toLocaleString('zh-CN'),
    '',
  ];

  for (const item of session.items) {
    if (item.kind === 'user') {
      lines.push('## 我', '', item.text || '（图片）', '');
      continue;
    }

    if (item.kind !== 'assistant') continue;

    const text = item.blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n\n')
      .trim();
    if (text) {
      lines.push('## 助手', '', text, '');
    }

    for (const block of item.blocks.filter((entry) => entry.type === 'toolCall')) {
      lines.push('> `' + block.name + '` ' + toolSummary(block), '');
    }
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) + '.md';
  link.click();
  URL.revokeObjectURL(link.href);
  toast('已导出为 Markdown');
}

el.exportBtn.addEventListener('click', exportMarkdown);

/* ------------------------------------------------------------------ *
 * 终端：每条对话一个常驻 shell，输出是 Seven Station Core 广播过来的
 * ------------------------------------------------------------------ */

const terminal = { history: [], cursor: -1 };

function terminalText(session) {
  if (!session) return '';
  if (session.terminalText === undefined) session.terminalText = '';
  return session.terminalText;
}

function appendTerminal(text) {
  const session = current();
  if (!session) return;

  const body = el.terminalBody;
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 24;

  session.terminalText = (terminalText(session) + text).slice(-200000);
  body.textContent = session.terminalText;
  body.scrollTop = atBottom ? body.scrollHeight : body.scrollTop;
}

function showTerminal(visible) {
  el.terminalPanel.hidden = !visible;
  if (!visible) return;

  const session = current();
  if (session) {
    el.terminalBody.textContent = terminalText(session);
    el.terminalBody.scrollTop = el.terminalBody.scrollHeight;
    send({ type: 'terminal_start', key: session.key });
  }

  el.terminalInput.focus();
}

function runTerminalLine() {
  const session = current();
  const line = el.terminalInput.value;
  if (!session || !line.trim()) return;

  terminal.history.push(line);
  terminal.cursor = terminal.history.length;
  el.terminalInput.value = '';

  // PowerShell 读标准输入时不会回显命令，界面上自己补一行。
  appendTerminal('> ' + line + '\n');
  send({ type: 'terminal_input', key: session.key, text: line });
}

el.terminalBtn.addEventListener('click', () => showTerminal(el.terminalPanel.hidden));

/* ------------------------------------------------------------------ *
 * 工作区文件：只读浏览与预览
 * ------------------------------------------------------------------ */

function openFiles(path) {
  const session = current();
  if (!session) return;

  el.filePanel.hidden = false;
  document.querySelector('.main').classList.add('files-open');
  el.filesPath.textContent = '/' + path;
  el.filesPath.title = '/' + path;
  el.filesBody.innerHTML = '<div class="files-note">读取中…</div>';
  session.filesPath = path;
  send({ type: 'list_dir', key: session.key, path });
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function renderListing(message) {
  el.filesBody.innerHTML = '';

  if (!message.exists) {
    el.filesBody.innerHTML = '<div class="files-note">这个目录不在了</div>';
    return;
  }

  if (!message.items.length) {
    el.filesBody.innerHTML = '<div class="files-note">空目录</div>';
    return;
  }

  for (const item of message.items) {
    const row = document.createElement('button');
    row.className = 'files-row';
    row.innerHTML =
      '<span class="mark">' + (item.dir ? '▸' : '·') + '</span>' +
      '<span class="name">' + escapeHtml(item.name) + '</span>' +
      '<span class="meta">' + (item.dir ? '' : escapeHtml(formatSize(item.size))) + '</span>';

    row.addEventListener('click', () => {
      if (item.dir) {
        openFiles(item.path);
        return;
      }

      const session = current();
      if (!session) return;
      el.filesPath.textContent = '/' + item.path;
      el.filesBody.innerHTML = '<div class="files-note">读取中…</div>';
      send({ type: 'read_file', key: session.key, path: item.path });
    });

    el.filesBody.appendChild(row);
  }
}

function renderFileContent(message) {
  el.filesBody.innerHTML = '';

  if (message.text === null || message.text === undefined) {
    const note = document.createElement('div');
    note.className = 'files-note';
    note.textContent = message.reason || '打不开这个文件';
    el.filesBody.appendChild(note);
    return;
  }

  const pre = document.createElement('pre');
  pre.className = 'files-preview';
  pre.textContent = message.text;
  el.filesBody.appendChild(pre);
  el.filesBody.scrollTop = 0;
}

el.filesBtn.addEventListener('click', () => {
  if (!el.filePanel.hidden) {
    closeFiles();
    return;
  }

  const session = current();
  openFiles(session?.filesPath || '');
});

el.filesClose.addEventListener('click', () => closeFiles());

function closeFiles() {
  el.filePanel.hidden = true;
  document.querySelector('.main').classList.remove('files-open');
}

el.filesUp.addEventListener('click', () => {
  const session = current();
  if (!session) return;
  const parts = (session.filesPath || '').split('/').filter(Boolean);
  parts.pop();
  openFiles(parts.join('/'));
});
el.terminalClose.addEventListener('click', () => showTerminal(false));
el.terminalClear.addEventListener('click', () => {
  const session = current();
  if (session) session.terminalText = '';
  el.terminalBody.textContent = '';
});

el.terminalStop.addEventListener('click', () => {
  const session = current();
  if (session) send({ type: 'terminal_stop', key: session.key });
});

el.terminalInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    runTerminalLine();
    return;
  }

  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    if (!terminal.history.length) return;
    event.preventDefault();
    terminal.cursor = Math.max(0, Math.min(terminal.history.length, terminal.cursor + (event.key === 'ArrowUp' ? -1 : 1)));
    el.terminalInput.value = terminal.cursor === terminal.history.length ? '' : terminal.history[terminal.cursor];
    return;
  }

  if (event.key === 'Escape') {
    event.preventDefault();
    showTerminal(false);
  }
});

/**
 * 先把这句话画在对话里再发出去。
 * 等 Pi 把话收下再显示（实测 3~4 秒）会让人以为卡住了；实际投递的细节不必暴露。
 * Core 那边收到真正的用户消息后，把这条回显换成正牌。
 */
function echoPrompt(session, text, images, payloadImages) {
  if (!session) return;
  app.echoSeq = (app.echoSeq || 0) + 1;
  const item = {
    id: 'echo' + app.echoSeq,
    kind: 'user',
    text,
    images: images || [],
    payloadImages: payloadImages || [],
    ts: Date.now(),
    echo: true,
    state: 'sending',
  };

  session.items.push(item);
  session.streaming = true;

  if (session === current()) {
    patchItem(item);
    scrollToBottom(true);
    renderComposerState();
  }
}

/** 气泡左边那个小圈：转着 = 还没确认，淡出 = 确认了，红圈 = 没发出去。 */
function sendStateNode(item) {
  if (item.state === 'failed') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'send-state is-failed';
    button.title = '没有发出去';
    button.setAttribute('aria-label', '没有发出去，点一下处理');
    button.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true">'
      + '<circle cx="8" cy="8" r="7" fill="currentColor"/>'
      + '<path d="M8 4.3v4.8" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>'
      + '<circle cx="8" cy="11.4" r="1" fill="#fff"/></svg>';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      askResend(item);
    });
    return button;
  }

  const dot = document.createElement('span');
  dot.className = 'send-state ' + (item.state === 'sent' ? 'is-sent' : 'is-sending');
  return dot;
}

/** 没发出去时点那个红圈：重新发送、删除这条，还是先放着。 */
function askResend(item) {
  closeModal();

  const card = document.createElement('div');
  card.className = 'modal';

  const title = document.createElement('h3');
  title.textContent = '这条没发出去';
  card.appendChild(title);

  const preview = document.createElement('p');
  preview.className = 'modal-hint';
  preview.textContent = item.text.length > 90 ? item.text.slice(0, 90) + '…' : item.text;
  card.appendChild(preview);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  const cancel = document.createElement('button');
  cancel.className = 'ghost-btn';
  cancel.textContent = '取消';
  cancel.addEventListener('click', closeModal);

  const remove = document.createElement('button');
  remove.className = 'ghost-btn danger';
  remove.textContent = '删除这条';
  remove.addEventListener('click', () => {
    closeModal();
    const session = current();
    if (!session) return;
    session.items = session.items.filter((entry) => entry !== item);
    renderThread(true);
  });

  const again = document.createElement('button');
  again.className = 'primary-btn';
  again.textContent = '重新发送';
  again.addEventListener('click', () => {
    closeModal();
    retryEcho(item);
  });

  actions.append(cancel, remove, again);
  card.appendChild(actions);

  el.modal.innerHTML = '';
  el.modal.appendChild(card);
  el.modal.hidden = false;
  again.focus();
}

/** 重发一条失败的：圈先转回去，再按原来的内容发一次。 */
function retryEcho(item) {
  const session = current();
  if (!session) return;

  item.state = 'sending';
  session.streaming = true;
  patchItem(item);
  renderComposerState();

  const message = { type: 'prompt', key: session.key, message: item.text };
  if (item.payloadImages && item.payloadImages.length) {
    message.images = item.payloadImages;
  }
  send(message);
}

/** 提示失败：还没被确认的那条改成红圈留着，让人自己决定重发还是删掉。 */
function markEchoesFailed(key) {
  const session = key ? app.byKey.get(key) : current();
  if (!session) return;

  let touched = false;
  for (const item of session.items) {
    if (!item.echo || item.state !== 'sending') continue;
    item.state = 'failed';
    touched = true;
    if (session === current()) patchItem(item);
  }

  if (!touched) return;
  if (!session.liveId) {
    session.streaming = false;
    renderComposerState();
  }
}

function submitPrompt() {
  const text = el.input.value.trim();

  // 正在编辑队列里的某一条：回车是「存回去」，不是发新消息。
  if (queueEditId) {
    const id = queueEditId;
    if (!text) {
      finishQueueEdit();
      return;
    }
    send({ type: 'queue_edit', key: app.currentKey, id, message: text });
    finishQueueEdit();
    return;
  }

  if (!text) return;

  const session = current();
  if (!session) {
    // 还没有对话时，直接用当前工作区建一个，再把这句话发出去。
    const cwd = app.lastCwd || app.activeCwd;
    if (!cwd) {
      askCwd();
      return;
    }

    app.pendingPrompt = text;
    el.input.value = '';
    autoGrow();
    startSession(cwd);
    return;
  }

  const message = {
    type: 'prompt',
    key: session.key,
    message: text,
  };

  if (app.attachments.length) {
    message.images = app.attachments.map((attachment) => ({
      type: 'image',
      data: attachment.data,
      mimeType: attachment.mimeType,
    }));
  }

  // 排队中的话不进对话，只看得到待发送面板；空闲时立刻把这句话画出来。
  if (!session.streaming) {
    echoPrompt(
      session,
      text,
      app.attachments.map((attachment) => attachment.dataUrl),
      message.images || [],
    );
  }

  send(message);
  el.input.value = '';
  // 发出去了就不算草稿，切回来别再冒出来。
  app.drafts.delete(session.key);
  app.attachmentDrafts.delete(session.key);
  app.attachments = [];
  renderAttachments();
  autoGrow();
}

el.attachBtn.addEventListener('click', () => el.fileInput.click());

// 圆环上的数字只有提示里看得到；手机没有悬停，点一下也要能读出具体数值。
if (el.ctxRing) {
  el.ctxRing.addEventListener('click', () => {
    const session = current();
    const usage = session && session.stats && session.stats.contextUsage;
    if (!usage || usage.percent == null) return;
    const numbers = contextNumbers(usage);
    toast('上下文已用 ' + numbers.percent + '%：' + numbers.used + 'k / ' + numbers.total + 'k tokens');
  });
}

el.fileInput.addEventListener('change', async () => {
  const files = [...el.fileInput.files];
  el.fileInput.value = '';
  await addImageFiles(files);
});

/* 路径链接上的右键菜单
 * 浏览器自带的那套（在新窗口中打开链接 / 将链接另存为 / 复制链接）对文件路径毫无意义，
 * 链接的 href 还是 #，点了也没用。所以在路径链接上换成我们自己的几项。
 * -------------------------------------------------------------------- */

let pathMenu = null;

function closePathMenu() {
  if (!pathMenu) return;
  pathMenu.remove();
  pathMenu = null;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制');
  } catch (error) {
    toast('复制失败：' + (error && error.message ? error.message : '浏览器不让用剪贴板'), 'error');
  }
}

function pathMenuItems(path, invoke) {
  const items = [];

  items.push({ label: '打开', run: () => revealPath(path) });

  if (invoke) {
    items.push({
      label: '打开所在目录',
      run: () => invoke('reveal_in_explorer', { path }).catch((error) => toast(String(error), 'error')),
    });
  }

  items.push({ separator: true });
  items.push({ label: '复制路径', run: () => copyText(path) });

  if (invoke) {
    items.push({
      label: '复制文件',
      run: () => invoke('copy_file', { path })
        .then(() => toast('已复制文件，可以直接粘贴'))
        .catch((error) => toast(String(error), 'error')),
    });
  }

  return items;
}

function showPathMenu(x, y, path) {
  closePathMenu();

  const invoke = clientInvoke();
  const node = document.createElement('div');
  node.className = 'ctx-menu';
  node.setAttribute('role', 'menu');

  pathMenuItems(path, invoke).forEach((item) => {
    if (item.separator) {
      const line = document.createElement('div');
      line.className = 'ctx-sep';
      node.appendChild(line);
      return;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ctx-item';
    button.textContent = item.label;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      closePathMenu();
      item.run();
    });
    node.appendChild(button);
  });

  document.body.appendChild(node);

  // 贴着鼠标，但不许出窗口边界。
  const box = node.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - box.width - 8);
  const top = Math.min(y, window.innerHeight - box.height - 8);
  node.style.left = Math.max(8, left) + 'px';
  node.style.top = Math.max(8, top) + 'px';

  pathMenu = node;
}

document.addEventListener('contextmenu', (event) => {
  const link = event.target.closest('.link-path');
  if (!link || !link.dataset.path) return;

  // 拦下来就不会再弹浏览器那三项了。
  event.preventDefault();
  showPathMenu(event.clientX, event.clientY, link.dataset.path);
});

document.addEventListener('click', () => closePathMenu());
document.addEventListener('scroll', () => closePathMenu(), true);
window.addEventListener('resize', () => closePathMenu());
window.addEventListener('blur', () => closePathMenu());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && pathMenu) {
    closePathMenu();
    event.stopPropagation();
  }
}, true);

/* 图片可以直接粘、也可以拖进窗口 */
document.addEventListener('click', (event) => {
  const pathLink = event.target.closest('.link-path');
  if (pathLink) {
    event.preventDefault();
    revealPath(pathLink.dataset.path);
    return;
  }

  // 正文里的地址：壳里自己开浏览器，浏览器里就走默认行为。
  const outLink = event.target.closest('.md a[href], .msg a[href]');
  const href = outLink && outLink.getAttribute('href');
  if (href && /^https?:/i.test(href)) {
    event.preventDefault();
    openUrl(href);
    return;
  }

  if (event.target.matches('.msg .md img, .attachment img')) {
    const overlay = document.createElement('div');
    overlay.className = 'image-zoom';
    const image = document.createElement('img');
    image.src = event.target.src;
    overlay.appendChild(image);
    overlay.addEventListener('click', () => overlay.remove());
    document.body.appendChild(overlay);
    event.preventDefault();
    return;
  }

  if (event.target.classList.contains('image-zoom')) {
    event.target.remove();
  }
});

document.addEventListener('click', async (event) => {
  const button = event.target.closest('.code-copy');
  if (!button) return;
  event.preventDefault();
  const code = decodeURIComponent(button.dataset.code || '');

  try {
    await navigator.clipboard.writeText(code);
  } catch {
    const area = document.createElement('textarea');
    area.value = code;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }

  button.textContent = '已复制';
  window.setTimeout(() => { button.textContent = '复制'; }, 1200);
});

el.content.addEventListener('scroll', () => {
  const distance = el.content.scrollHeight - el.content.scrollTop - el.content.clientHeight;
  el.jumpBottom.hidden = distance < 200;
});

el.jumpBottom.addEventListener('click', () => {
  el.content.scrollTo({ top: el.content.scrollHeight, behavior: 'smooth' });
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  // 别的设备可能改过东西，切回来时对一下。
  send({ type: 'list_conversations' });
  const session = current();
  if (session) send({ type: 'refresh_state', key: session.key });
});

document.addEventListener('paste', (event) => {
  const files = [...(event.clipboardData?.files || [])].filter((file) => file.type.startsWith('image/'));
  if (!files.length) return;
  event.preventDefault();
  addImageFiles(files);
});

let dragDepth = 0;
document.addEventListener('dragenter', (event) => {
  if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
  dragDepth += 1;
  document.body.classList.add('dragging');
});

document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('dragging');
});

document.addEventListener('dragover', (event) => {
  if ([...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault();
});

document.addEventListener('drop', async (event) => {
  const files = [...(event.dataTransfer?.files || [])];
  if (!files.length) return;
  event.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  await addImageFiles(files);
});

/**
 * 截图动辄 4K，原样塞进去对话会变得很重。超过 1600 像素就等比缩一下，
 * 透明图仍存 PNG，其它转 JPEG。
 */
async function prepareImage(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

  const mimeType = file.type || 'image/png';
  if (mimeType === 'image/gif') {
    return { dataUrl, mimeType };
  }

  const image = await new Promise((resolve) => {
    const probe = new Image();
    probe.onload = () => resolve(probe);
    probe.onerror = () => resolve(null);
    probe.src = dataUrl;
  });

  if (!image) {
    return { dataUrl, mimeType };
  }

  const longest = Math.max(image.width, image.height);
  if (longest <= 1600 && file.size < 1.5 * 1024 * 1024) {
    return { dataUrl, mimeType };
  }

  const scale = Math.min(1, 1600 / longest);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);

  const output = mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
  return { dataUrl: canvas.toDataURL(output, 0.9), mimeType: output };
}

async function addImageFiles(files) {
  const images = files.filter((file) => file.type.startsWith('image/'));
  if (!images.length) {
    if (files.length) toast('现在只能附加图片', 'warning');
    return;
  }

  for (const file of images) {
    const prepared = await prepareImage(file);
    const comma = prepared.dataUrl.indexOf(',');
    app.attachments.push({
      name: file.name || '粘贴的图片',
      mimeType: prepared.mimeType,
      data: prepared.dataUrl.slice(comma + 1),
      dataUrl: prepared.dataUrl,
    });
  }

  renderAttachments();
  el.input.focus();
}

/* ------------------------------------------------------------------ *
 * 宿主消息分发
 * ------------------------------------------------------------------ */

let pendingCwd = '';

function dispatch(message) {
  switch (message.type) {
    case 'hello':
      if (message.center) {
        app.centerName = message.center;
        if (transport.connected) setConnectionState('已连接', true);
      }
      if (message.data) {
        app.storePath = message.data;
      }
      if (message.version) {
        app.centerVersion = message.version;
      }
      if (Array.isArray(message.agents)) {
        app.agents = message.agents;
        app.agent = message.agents[0] || null;
      }
      // 侧栏的数量一开始就要有，别等点进页面才去读。
      if (!app.skills) requestSkills();
      if (!app.extensions) requestExtensions();
      if (message.listen) {
        app.listen = message.listen;
      }
      if (message.css !== undefined) {
        applyCustomCss(message.css || '');
      }
      if (Array.isArray(message.workspaces)) {
        app.recentWorkspaces = message.workspaces;
      }
      if (app.agent && app.agent.ready === false) {
        toast(`Seven Station Core 那台机器上没找到 ${app.agent.name}，先把 ${app.agent.name} 装好再开始对话。`, 'warning');
      }
      break;

    case 'path_check': {
      // 只提示，不拦人：Seven Station Core 那边建对话时本来就会校验目录。
      const hint = el.modal.querySelector('.modal-hint');
      if (hint) {
        hint.textContent = message.exists ? '' : message.reason || '';
      }
      break;
    }

    case 'browse_dir':
      renderDirListing(message);
      break;

    case 'skills':
      app.skills = message;
      el.skillsCount.textContent = String((message.items || []).length);
      if (app.view === 'skills') renderPage('skills');
      break;

    case 'update_job':
      handleUpdateJob(message);
      break;

    case 'updates':
      app.updates = message;
      renderUpdateStrip();
      renderNavUpdate();
      if (app.view === 'settings') renderPage('settings');
      break;

    case 'extensions':
      app.extensions = message;
      el.extensionsCount.textContent = String((message.packages || []).length);
      if (app.view === 'extensions') renderPage('extensions');
      break;

    case 'css':
      applyCustomCss(message.css || '');
      break;

    case 'log_tail': {
      // 日志就在设置页里，读完直接铺到那一块，不再另开弹窗。
      app.logTail = message;
      if (app.view !== 'settings') {
        switchView('settings');
      }
      const box = document.getElementById('logTailBox');
      if (box) {
        box.textContent = message.text || '（空）';
      }
      break;
    }

    case 'search_results':
      if (message.query !== app.filter.trim()) break;
      app.searchResults = { query: message.query, items: message.items || [] };
      renderSessionList();
      break;

    case 'conversation_list':
      app.sessions = message.items || [];
      if (Array.isArray(message.workspaces)) {
        app.recentWorkspaces = message.workspaces;
      }
      renderSessionList();
      break;

    case 'conversation_saved':
      send({ type: 'list_conversations' });
      break;

    case 'resume_resolved':
      if (app.restore) {
        app.restore.commandBusy = false;
        app.restore.commandResult = { item: message.item, cwd: message.cwd };
        if (!message.item) {
          app.restore.commandError = '没找到这段会话';
        }
        renderRestoreDialog();
      }
      break;

    case 'restore_candidates':
      if (app.restore) {
        app.restore.items = message.items || [];
        app.restore.loading = false;
        renderRestoreDialog();
      }
      break;

    case 'restore_progress':
      if (app.restore) {
        app.restore.progress = {
          stage: message.stage || 'read',
          done: Number(message.done) || 0,
          total: Number(message.total) || 0,
          messages: Number(message.messages) || 0,
        };
        updateRestoreProgress(app.restore);
      }
      break;

    case 'session_restored': {
      const state = app.restore;
      if (state) endRestore(state);
      closeModal();
      app.restore = null;
      if (state) {
        const conversation = app.sessions.find((item) => item.id === message.id);
        if (conversation) {
          openSession(conversation);
        } else {
          send({ type: 'list_conversations' });
        }
      }

      if (message.already) {
        toast('这段已在对话库里，已打开');
      } else {
        toast('已恢复 ' + message.messageCount + ' 条消息');
      }
      break;
    }

    case 'conversation_settings': {
      const session = app.byKey.get(message.key);
      if (session) {
        if (typeof message.title === 'string' && message.title) {
          session.state.sessionName = message.title;
        }
        if (message.model) session.state.model = message.model;
        if (message.thinkingLevel) session.state.thinkingLevel = message.thinkingLevel;
      }
      const entry = app.sessions.find((item) => item.id === message.key);
      if (entry && message.title) entry.title = message.title;
      if (message.key === app.currentKey) renderHeader();
      renderSessionList();
      break;
    }


    case 'session_state':
      onSessionState(message);
      break;

    case 'older_messages':
      onOlderMessages(message);
      break;

    case 'dir_listing': {
      if (current()?.key !== message.key) break;
      if (el.filePanel.hidden) break;
      renderListing(message);
      break;
    }

    case 'file_content': {
      if (current()?.key !== message.key) break;
      if (el.filePanel.hidden) break;
      renderFileContent(message);
      break;
    }

    case 'terminal_state': {
      const session = app.byKey.get(message.key);
      if (!session) break;
      session.terminalShell = message.shell || '';
      session.terminalRunning = Boolean(message.running);
      if (current() === session && !el.terminalPanel.hidden) {
        el.terminalShell.textContent = [session.terminalShell, message.cwd].filter(Boolean).join(' · ');
      }
      break;
    }

    case 'terminal_output': {
      if (current()?.key !== message.key) break;
      appendTerminal(message.text || '');
      break;
    }

    case 'terminal_exit': {
      if (current()?.key !== message.key) break;
      appendTerminal('[进程已结束，退出码 ' + message.code + ']\n');
    }

    case 'file_completions': {
      const session = app.byKey.get(message.key);
      if (!session || completion.kind !== 'file') break;
      // 只认最后一次请求，慢回来的结果丢掉。
      if (message.query !== completion.query) break;
      renderCompletions(message.items || []);
      break;
    }

    case 'commands': {
      const session = app.byKey.get(message.key);
      if (!session) break;
      session.commands = message.items || [];
      if (completion.kind === 'command') requestCommands(completion.query);
      if (app.view === 'extensions') requestExtensions();
      break;
    }

    case 'models':
      onModels(message);
      break;

    case 'git_status': {
      const session = app.byKey.get(message.key);
      if (session) {
        session.git = message.data || null;
        if (message.key === app.currentKey) {
          renderBranchPill();
          if (gitState.open) {
            gitState.snapshot = session.git;
            renderGitPanel();
            placeGitPanel();
          }
        }
      }
      break;
    }

    case 'stats': {
      const session = app.byKey.get(message.key);
      if (session) {
        session.stats = message.data || null;
        if (message.key === app.currentKey) renderContext();
      }
      break;
    }

    case 'event':
      onEvent(message.key, message.event);
      break;

    case 'queue_state': {
      const session = app.byKey.get(message.key);
      if (session) session.queue = Array.isArray(message.entries) ? message.entries : [];
      if (message.key === app.currentKey) renderQueue();
      break;
    }

    case 'prompt_accepted':
      break;

    case 'process_exit':
      onProcessExit(message);
      break;

    case 'notice':
      toast(message.text || '', message.kind || '');
      break;

    case 'error':
      setOverlay(null);
      markEchoesFailed(message.key);
      toast(message.message || '这条操作没成功，可以再试一次', 'error');
      break;

    default:
      break;
  }
}

function onSessionState(message) {
  setOverlay(null);
  const key = message.key;
  const previous = app.byKey.get(key);
  const cwd = message.cwd || (previous && previous.cwd) || pendingCwd || app.pendingCwd || '';
  const session = makeSession(key, message.state, message.messages, cwd);
  session.stats = message.stats || null;
  session.hasMore = Boolean(message.hasMore);
  session.loadingOlder = false;
  session.queue = (message.state && Array.isArray(message.state.queue)) ? message.state.queue : [];
  if (previous) {
    session.models = previous.models;
    session.levels = previous.levels;
    // 展开状态跟着会话走：重新拉一遍状态、断线重连回来都不该把展开的步骤回弹。
    session.ui = previous.ui;
  }

  // 还没有会话时打的字（先选工作区那一步）：别在会话建好时被换掉了，直接认领成它的草稿。
  if (!app.currentKey && !queueEditId && el.input.value.trim()) {
    app.drafts.set(key, el.input.value);
  }
  rememberDraft();
  app.byKey.set(key, session);
  app.currentKey = key;
  restoreDraft(key);
  app.activeCwd = cwd;
  pendingCwd = '';
  app.pendingCwd = '';

  session.streaming = Boolean(message.state && message.state.isStreaming);
  showWorkspace(true);
  renderThread();
  renderHeader();
  renderComposerState();
  renderSessionList();

  if (!session.models) {
    send({ type: 'list_models', key });
  }
  send({ type: 'list_conversations' });

  if (app.pendingPrompt) {
    const text = app.pendingPrompt;
    app.pendingPrompt = '';
    el.input.value = text;
    submitPrompt();
  }
}

function onOlderMessages(message) {
  const session = app.byKey.get(message.key);
  if (!session) return;
  session.loadingOlder = false;
  session.hasMore = Boolean(message.hasMore);
  const older = Array.isArray(message.messages) ? message.messages : [];
  if (!older.length) {
    if (current() === session) renderThread(true);
    return;
  }

  session.raw = older.concat(session.raw);
  const built = buildItems(session.raw);
  // 正在生成的那条还没进 raw（要等 message_end），重建时单独留住。
  if (session.liveId) {
    const live = session.items.find((item) => item.id === session.liveId);
    if (live) built.items.push(live);
  }
  // 没被 Core 确认的回显不在 raw 里，重建时要接回末尾，否则气泡会凭空消失。
  const pending = session.items.filter((item) => item.echo && item.state !== 'sent');
  session.items = built.items;
  if (pending.length) session.items.push(...pending);
  session.toolIndex = built.toolIndex;
  session.seq = session.items.length;
  if (current() === session) renderThread(true);
}

function onModels(message) {
  const session = app.byKey.get(message.key);
  if (!session) return;
  session.models = message.data || null;
  session.levels = message.thinkingLevels || null;
  if (message.key === app.currentKey) {
    renderHeader();
    // 设置页正开着的话，把「模型目录」那一行的时间换掉。
    if (app.modelsAt) renderPage('settings');
  }
}


function onProcessExit(message) {
  if (stopPending && stopPending.key === message.key) {
    stopPending.handle.update('已停止');
    stopPending = null;
  }

  const session = app.byKey.get(message.key);
  app.byKey.delete(message.key);
  const detail = message.stderr ? '\n' + message.stderr.split('\n').slice(-4).join('\n') : '';
  toast('Pi 运行时退出了（退出码 ' + message.code + '），发一句话就会自动重连。' + detail, 'error');
  if (app.currentKey === message.key) {
    app.currentKey = null;
    app.attachments = [];
    renderAttachments();
    showWorkspace(false);
    renderHeader();
  }
  if (session) renderSessionList();
}

/* ------------------------------------------------------------------ *
 * 事件流
 * ------------------------------------------------------------------ */

function liveItem(session) {
  if (!session.liveId) return null;
  return session.items.find((item) => item.id === session.liveId) || null;
}

function onEvent(key, event) {
  const session = app.byKey.get(key);
  if (!session || !event) return;

  switch (event.type) {
    case 'message_start': {
      const message = event.message || {};
      if (message.role === 'assistant') {
        const item = {
          id: 'live-' + session.seq++,
          kind: 'assistant',
          blocks: [],
          streaming: true,
          ts: messageTimestamp(message),
          endTs: messageTimestamp(message) + (Number(message.durationMs) || 0),
        };
        session.items.push(item);
        session.liveId = item.id;
        session.streaming = true;
        if (key === app.currentKey) {
          patchItem(item);
          scrollToBottom(false);
          renderComposerState();
        }
      }
      break;
    }

    case 'message_update':
      onAssistantUpdate(session, key, event.assistantMessageEvent);
      break;

    case 'message_end': {
      const message = event.message || {};
      if (message.role === 'assistant') {
        const item = liveItem(session);
        if (item) {
          item.blocks = blocksFromMessage(message);
          item.streaming = false;
          session.raw.push(message);
          for (const block of item.blocks) {
            if (block.type === 'toolCall' && block.id) session.toolIndex.set(block.id, { item, block });
          }
          session.liveId = null;
          if (key === app.currentKey) schedule(item.id);
        }
      } else if (message.role === 'user') {
        session.raw.push(message);

        // 回显那条就地换成正牌：同一个气泡，只把左边那个圈淡掉，不闪一下。
        const echoAt = session.items.findIndex((entry) => entry.echo && entry.state === 'sending');
        if (echoAt >= 0) {
          const echo = session.items[echoAt];
          echo.id = 'i' + session.seq++;
          echo.text = contentText(message.content);
          echo.images = contentImages(message.content);
          echo.ts = messageTimestamp(message);
          echo.payloadImages = [];
          echo.state = 'sent';
          if (key === app.currentKey) {
            patchItem(echo);
            scrollToBottom(false);
          }
          // 淡出播完就摘掉标记，之后整段重绘不再画那个圈。
          window.setTimeout(() => { echo.echo = false; }, 260);
          break;
        }

        const item = {
          id: 'i' + session.seq++,
          kind: 'user',
          text: contentText(message.content),
          images: contentImages(message.content),
          ts: messageTimestamp(message),
        };
        session.items.push(item);
        if (key === app.currentKey) {
          patchItem(item);
          scrollToBottom(false);
        }
      }
      break;
    }

    case 'tool_execution_start': {
      const entry = session.toolIndex.get(event.toolCallId);
      if (entry) {
        entry.block.args = event.args || entry.block.args;
        entry.block.argsText = JSON.stringify(entry.block.args || {}, null, 2);
        entry.block.running = true;
        entry.block.done = false;
        entry.block.name = event.toolName || entry.block.name;
        if (key === app.currentKey) schedule(entry.item.id);
      }
      break;
    }

    case 'tool_execution_update': {
      const entry = session.toolIndex.get(event.toolCallId);
      if (entry && event.partialResult) {
        entry.block.output = contentText(event.partialResult.content);
        if (key === app.currentKey) schedule(entry.item.id);
      }
      break;
    }

    case 'tool_execution_end': {
      const entry = session.toolIndex.get(event.toolCallId);
      if (entry) {
        entry.block.running = false;
        entry.block.done = true;
        entry.block.isError = Boolean(event.isError);
        entry.block.durationMs = typeof event.durationMs === 'number' ? Math.round(event.durationMs) : null;
        if (event.result) {
          entry.block.output = contentText(event.result.content) || entry.block.output;
        }
        if (event.args) {
          entry.block.args = event.args;
          entry.block.argsText = JSON.stringify(event.args, null, 2);
        }
        if (key === app.currentKey) schedule(entry.item.id);
      }
      break;
    }

    case 'agent_settled': {
      if (stopPending && stopPending.key === key) {
        stopPending.handle.update(event.aborted ? '已停止' : '本轮已结束');
        stopPending = null;
      }

      session.streaming = false;
      const item = liveItem(session);
      if (item) {
        item.streaming = false;
        session.liveId = null;
      }
      // 收尾时把最后一条助手消息重画一次：思考块的标题与工具卡状态都随流式状态变。
      const last = [...session.items].reverse().find((candidate) => candidate.kind === 'assistant');
      if (last && key === app.currentKey) schedule(last.id);
      if (key === app.currentKey) renderComposerState();
      send({ type: 'refresh_stats', key });
      send({ type: 'list_conversations' });
      // 一轮干完可能改过文件：分支胶囊上的改动数跟着更新。
      if (key === app.currentKey) requestGitStatus();
      break;
    }

    case 'queue_update':
      // 排队由 Seven Station Core 管（queue_state），Pi 那边应当一直是空的；
      // 真出现内容说明有别的路径往里塞了东西，照实刷新一次输入区状态。
      if (key === app.currentKey) renderComposerState();
      break;

    case 'thinking_level_changed':
      session.state.thinkingLevel = event.level;
      if (key === app.currentKey) renderHeader();
      break;

    case 'session_info_changed':
      session.state.sessionName = event.name || undefined;
      if (key === app.currentKey) renderHeader();
      break;

    case 'compaction_start':
      // 也可能是 Pi 自己触发的自动压缩，这时没有点击过按钮。
      app.compactionToast = app.compactionToast || statusToast('正在压缩上下文');
      break;

    case 'compaction_end': {
      const running = app.compactionToast;
      app.compactionToast = null;
      if (running) running.update('上下文已压缩');
      else toast('上下文已压缩');
      send({ type: 'refresh_stats', key });
      break;
    }

    case 'extension_ui_request':
      onExtensionRequest(session, event);
      break;

    default:
      break;
  }
}

function onAssistantUpdate(session, key, update) {
  if (!update) return;
  const item = liveItem(session);
  if (!item) return;
  const index = typeof update.contentIndex === 'number' ? update.contentIndex : 0;
  session.streaming = true;

  switch (update.type) {
    case 'text_start':
      item.blocks[index] = { type: 'text', text: '' };
      break;
    case 'text_delta':
      if (!item.blocks[index] || item.blocks[index].type !== 'text') item.blocks[index] = { type: 'text', text: '' };
      item.blocks[index].text += update.delta || '';
      break;
    case 'text_end':
      item.blocks[index] = { type: 'text', text: update.content || '' };
      break;
    case 'thinking_start':
      item.blocks[index] = { type: 'thinking', text: '' };
      break;
    case 'thinking_delta':
      if (!item.blocks[index] || item.blocks[index].type !== 'thinking') item.blocks[index] = { type: 'thinking', text: '' };
      item.blocks[index].text += update.delta || '';
      break;
    case 'thinking_end':
      item.blocks[index] = { type: 'thinking', text: update.content || '' };
      break;
    case 'toolcall_start':
      item.blocks[index] = {
        type: 'toolCall',
        id: update.id,
        name: update.toolName,
        args: {},
        argsText: '',
        output: '',
        running: true,
        done: false,
        isError: false,
        durationMs: null,
      };
      session.toolIndex.set(update.id, { item, block: item.blocks[index] });
      break;
    case 'toolcall_delta':
      if (item.blocks[index] && item.blocks[index].type === 'toolCall') {
        item.blocks[index].argsText += update.delta || '';
      }
      break;
    case 'toolcall_end': {
      const block = item.blocks[index];
      if (block && block.type === 'toolCall') {
        const call = update.toolCall || {};
        block.args = call.arguments || {};
        block.argsText = JSON.stringify(block.args, null, 2);
        block.name = call.name || block.name;
        block.id = call.id || block.id;
        session.toolIndex.set(block.id, { item, block });
      }
      break;
    }
    default:
      break;
  }

  if (key === app.currentKey) {
    schedule(item.id);
    renderComposerState();
  }
}

/* ------------------------------------------------------------------ *
 * 扩展交互
 * ------------------------------------------------------------------ */

function onExtensionRequest(session, request) {
  const method = request.method;
  if (method === 'setStatus') {
    if (request.statusText == null) {
      app.extStatus.delete(request.statusKey);
    } else {
      app.extStatus.set(request.statusKey, stripAnsi(request.statusText));
    }
    renderExtStatus();
    return;
  }

  if (method === 'setWidget') {
    if (!request.widgetLines) {
      app.widgets.delete(request.widgetKey);
    } else {
      app.widgets.set(request.widgetKey, request.widgetLines);
    }
    renderExtStatus();
    return;
  }

  if (method === 'notify') {
    toast(stripAnsi(request.message), request.notifyType === 'error' ? 'error' : request.notifyType === 'warning' ? 'warning' : '');
    return;
  }

  if (method === 'setTitle') {
    document.title = request.title ? 'SevenStation · ' + stripAnsi(request.title) : 'SevenStation';
    return;
  }

  if (method === 'set_editor_text') {
    el.input.value = request.text || '';
    autoGrow();
    el.input.focus();
    return;
  }

  if (method === 'select' || method === 'confirm' || method === 'input' || method === 'editor') {
    app.openRequest = request;
    openDialog(session, request);
  }
}

function respond(session, id, payload) {
  send(Object.assign({ type: 'extension_response', key: session.key, id }, payload));
}

function openDialog(session, request) {
  closeModal();
  const card = document.createElement('div');
  card.className = 'modal';

  const title = document.createElement('h3');
  title.textContent = stripAnsi(request.title) || ({
    select: '请选择',
    confirm: '请确认',
    input: '请输入',
    editor: '编辑内容',
  }[request.method] || '需要你的输入');
  card.appendChild(title);

  if (request.message) {
    const body = document.createElement('div');
    body.className = 'modal-message';
    body.textContent = stripAnsi(request.message);
    card.appendChild(body);
  }

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const finish = (payload) => {
    respond(session, request.id, payload);
    closeModal();
  };

  if (request.method === 'select') {
    const list = document.createElement('div');
    list.className = 'options';
    for (const option of request.options || []) {
      const button = document.createElement('button');
      button.className = 'option';
      button.textContent = option;
      button.addEventListener('click', () => finish({ value: option }));
      list.appendChild(button);
    }
    card.appendChild(list);
    const cancel = document.createElement('button');
    cancel.className = 'ghost-btn';
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => finish({ cancelled: true }));
    actions.appendChild(cancel);
  } else if (request.method === 'confirm') {
    const no = document.createElement('button');
    no.className = 'ghost-btn';
    no.textContent = '否';
    no.addEventListener('click', () => finish({ confirmed: false }));
    const yes = document.createElement('button');
    yes.className = 'primary-btn';
    yes.textContent = '是';
    yes.addEventListener('click', () => finish({ confirmed: true }));
    const cancel = document.createElement('button');
    cancel.className = 'ghost-btn';
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => finish({ cancelled: true }));
    actions.appendChild(cancel);
    actions.appendChild(no);
    actions.appendChild(yes);
    yes.focus();
  } else if (request.method === 'input') {
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = request.placeholder || '';
    input.value = request.prefill || '';
    card.appendChild(input);
    const cancel = document.createElement('button');
    cancel.className = 'ghost-btn';
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => finish({ cancelled: true }));
    const submit = document.createElement('button');
    submit.className = 'primary-btn';
    submit.textContent = '确定';
    submit.addEventListener('click', () => finish({ value: input.value }));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') finish({ value: input.value });
    });
    actions.appendChild(cancel);
    actions.appendChild(submit);
    setTimeout(() => input.focus(), 0);
  } else {
    const area = document.createElement('textarea');
    area.value = request.prefill || '';
    card.appendChild(area);
    const cancel = document.createElement('button');
    cancel.className = 'ghost-btn';
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => finish({ cancelled: true }));
    const submit = document.createElement('button');
    submit.className = 'primary-btn';
    submit.textContent = '保存';
    submit.addEventListener('click', () => finish({ value: area.value }));
    actions.appendChild(cancel);
    actions.appendChild(submit);
    setTimeout(() => area.focus(), 0);
  }

  card.appendChild(actions);
  el.modal.innerHTML = '';
  el.modal.appendChild(card);
  el.modal.hidden = false;
}

function closeModal() {
  app.openRequest = null;
  el.modal.hidden = true;
  el.modal.innerHTML = '';
}

el.modal.addEventListener('click', (event) => {
  if (event.target === el.modal) {
    // 点背景等同取消，避免工具一直挂着。
    const session = current();
    const request = app.openRequest;
    if (session && request) respond(session, request.id, { cancelled: true });
    closeModal();
  }
});

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

applyCustomCss('');
renderSessionList();
renderExtStatus();
renderComposerState();
showWorkspace(false);
renderHeader();
setConnectionState('正在连接…');
connect();
