// 长跑的时间要能一眼读出来：30620 秒不是人看的东西。
const { boot, checker } = require('./boot');

const { window } = boot(`
  window.__spent = formatSpent;
  window.__duration = formatDuration;
`);

const { ok, done } = checker();
const spent = window.__spent;
const duration = window.__duration;

ok(spent(0) === '', '不足一秒不写');
ok(spent(999) === '', '999 毫秒也不写');
ok(spent(1000) === '1 秒', '整一秒');
ok(spent(47000) === '47 秒', '一分钟内写秒：' + spent(47000));
ok(spent(59999) === '1 分', '59.999 秒进位成一分钟：' + spent(59999));
ok(spent(60000) === '1 分', '整一分钟只写分：' + spent(60000));
ok(spent(83000) === '1 分 23 秒', '一分多写「M 分 S 秒」：' + spent(83000));
ok(spent(3600000) === '1 小时', '整一小时：' + spent(3600000));
ok(spent(5400000) === '1 小时 30 分', '一小时半：' + spent(5400000));
ok(spent(30620000) === '8 小时 30 分', '截图里那个 30620 秒 → ' + spent(30620000));
ok(spent(86400000) === '1 天', '整一天：' + spent(86400000));
ok(spent(90000000) === '1 天 1 小时', '一天多：' + spent(90000000));
ok(spent(30620000).includes('秒') === false, '长跑不再显示「秒」');

ok(duration(320) === '320 毫秒', '单步几百毫秒：' + duration(320));
ok(duration(12300) === '12.3 秒', '单步十几秒带一位小数：' + duration(12300));
ok(duration(83000) === '1 分 23 秒', '单步超过一分钟换成「分」：' + duration(83000));
ok(duration(612400) === '10 分 12 秒', '长命令不写成 612.4 秒：' + duration(612400));

done();
