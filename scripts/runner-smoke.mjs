// 执行代理链路的冒烟：核心 → 命名管道 → 代理（用户会话）→ Pi，真给模型发一句话。
//
// 前置：核心与代理都在跑，且用同一个 SEVENSTATION_RUNNER_PIPE。
// 沙箱起法（临时 home，别用 8787）：
//   SEVENSTATION_CORE_HOME=work\smoke\runner-home dotnet SevenStation.Core.dll --runner &
//   SEVENSTATION_CORE_HOME=work\smoke\runner-home SEVENSTATION_LISTEN=http://127.0.0.1:8937 dotnet SevenStation.Core.dll &
// 用法：node scripts/runner-smoke.mjs --port 8937 --home work\smoke\runner-home --cwd work\smoke\runner-cwd
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const port = Number(argValue('--port') ?? 8937);
const home = argValue('--home');
const cwd = argValue('--cwd');

if (!home || !cwd) {
  console.error('✗ 需要 --home（核心的沙箱目录）与 --cwd（已存在的工作目录）');
  process.exit(1);
}

const token = readFileSync(join(home, 'token.txt'), 'utf8').trim();
const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);

let key = null;
let reply = '';
let settled = false;
const seen = new Set();

const done = (ok, message) => {
  console.log((ok ? '✓ ' : '✗ ') + message);
  process.exit(ok ? 0 : 1);
};

const timer = setTimeout(() => {
  done(false, '90 秒内没等到 agent_settled（见过的事件：' + [...seen].join(', ') + '）');
}, 90000);

// Pi 的消息是 { role, content: [{ type: 'text', text }] }，正文要从 content 里拼。
const textOf = (payload) => {
  const content = payload?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text')
    .map((part) => String(part.text ?? ''))
    .join('');
};

socket.onopen = () => {
  socket.send(JSON.stringify({ type: 'new_conversation', cwd, title: '执行代理冒烟' }));
};

socket.onmessage = (event) => {
  let frame;
  try {
    frame = JSON.parse(event.data);
  } catch {
    return;
  }

  if (frame.type) seen.add(frame.type);

  if (frame.type === 'session_state' && frame.key && !key) {
    key = frame.key;
    socket.send(JSON.stringify({ type: 'prompt', key, message: '只回复两个字：收到' }));
    return;
  }

  if (frame.type === 'error') {
    clearTimeout(timer);
    done(false, '核心报错：' + (frame.message ?? frame.text ?? JSON.stringify(frame)));
  }

  if (frame.type === 'notice' && frame.kind === 'error') {
    clearTimeout(timer);
    done(false, '核心报错：' + frame.text);
  }

  if (frame.type !== 'event') return;

  const inner = frame.event ?? {};
  if (inner.type === 'message_end' && inner.message?.role === 'assistant') {
    reply += textOf(inner.message);
  }
  if (inner.type === 'agent_settled') settled = true;

  if (settled) {
    clearTimeout(timer);
    const clean = reply.trim();
    done(Boolean(clean), clean ? '代理链路通了，Pi 回了：' + clean : 'settled 了但没拿到回复正文');
  }
};

socket.onerror = () => done(false, '连不上 WebSocket，确认核心起来了、端口没被占用');
