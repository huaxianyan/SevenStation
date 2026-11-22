// 直接问一个跑着的 Seven Station Core「Pi 和扩展有没有新版」。
//
// 用法：node scripts/check-updates.mjs --port 8899 --token <令牌>
//   --port   非 8787 的临时实例端口（别问正在服务用户的那一个）
//   --token  该实例 core home 里 token.txt 的内容
// 只读：发 check_updates 拿一条 updates 消息就退出，不改任何东西。


import { createRequire } from 'node:module';

const require = createRequire('E:/Dev/SevenStation/scripts/ui-tests/');
const WebSocket = require('ws');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf('--' + name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const port = flag('port', '8899');
const token = flag('token', '');
const timeout = Number(flag('timeout', '30000'));

if (!token) {
  console.error('要带 --token（<core home>/token.txt 里的内容）');
  process.exit(2);
}

const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
const timer = setTimeout(() => {
  console.error('等超时了，没收到 updates');
  process.exit(1);
}, timeout);

socket.on('open', () => {
  socket.send(JSON.stringify({ type: 'check_updates', force: true }));
});

socket.on('message', (raw) => {
  let message;
  try {
    message = JSON.parse(String(raw));
  } catch {
    return;
  }

  if (message.type !== 'updates') {
    return;
  }

  clearTimeout(timer);
  const pi = message.pi || {};
  console.log(`检查时间：${message.checkedAt || '未知'}`);
  console.log(`Pi：${pi.installed || '未知'} → ${pi.latest || '未知'}${pi.hasUpdate ? '（有新版）' : '（最新）'}${pi.error ? ' ' + pi.error : ''}`);
  for (const item of message.packages || []) {
    const state = item.pinned ? '钉住，不查' : item.error || (item.hasUpdate ? '有新版' : '最新');
    console.log(`  ${item.name}：${item.installed || '未装'} → ${item.latest || '-'} ${state}`);
  }

  socket.close();
  process.exit(0);
});

socket.on('error', (error) => {
  clearTimeout(timer);
  console.error('连不上：' + error.message);
  process.exit(1);
});
