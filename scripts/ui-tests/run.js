// 依次跑所有检查脚本，任何一个失败就非零退出。
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const files = fs.readdirSync(__dirname).filter((name) => name.endsWith('.test.js')).sort();
let failed = 0;

for (const file of files) {
  console.log('\n=== ' + file + ' ===');
  const result = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
  if (result.status !== 0) failed++;
}

console.log(failed ? '\n有 ' + failed + ' 个脚本没过' : '\n全部通过');
process.exit(failed ? 1 : 0);
