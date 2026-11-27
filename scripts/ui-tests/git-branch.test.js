// git 分支：胶囊怎么画、宽度不够怎么降级、面板里有什么。
// 布局规则是「先降目录、再降分支」——目录在左侧列表和面包屑里都看得到，分支只在这一处有。
const { boot, checker } = require('./boot');

const { document, window } = boot(`
  window.__session = function (git) {
    const session = makeSession('c-git', { isStreaming: false }, [], 'E:/Dev/ComebackGooglePinyinInput');
    session.git = git;
    app.byKey.set('c-git', session);
    app.currentKey = 'c-git';
    renderHeader();
    return session;
  };
  window.__pill = () => document.getElementById('branchPill');
  window.__pills = () => document.querySelector('.pills');
  window.__panel = () => document.getElementById('gitPanel');
  window.__fit = fitPills;
  window.__toggle = toggleGitPanel;
  window.__short = shortPath;
  window.__since = sinceText;
`);

const { ok, done } = checker();

const pill = window.__pill();
const pillsEl = window.__pills();
const panel = window.__panel();
const text = () => document.getElementById('branchPillText').textContent;
const count = () => document.getElementById('branchPillCount');
const ab = () => document.getElementById('branchPillAb');

const repo = (over) => Object.assign({
  repo: true,
  root: 'E:\\Dev\\ComebackGooglePinyinInput',
  branch: 'feature/pinyin-editor',
  detached: false,
  ahead: 1,
  behind: 0,
  files: [{ flag: 'M', path: 'app/src/main/java/x/PinyinEditor.kt' }],
  branches: [
    { name: 'feature/pinyin-editor', at: Math.floor(Date.now() / 1000) - 60, current: true },
    { name: 'main', at: Math.floor(Date.now() / 1000) - 3 * 86400, current: false },
  ],
}, over || {});

// 不是仓库：不出现
window.__session({ repo: false, branch: '', files: [], branches: [] });
ok(pill.hidden, '不是 git 仓库时不显示分支胶囊');

// 是仓库：名字、改动数、领先落后都对
window.__session(repo());
ok(!pill.hidden, '是仓库时显示胶囊');
ok(text() === 'feature/pinyin-editor', '显示当前分支：' + text());
ok(!count().hidden && count().textContent === '1', '改动数挂在后面：' + count().textContent);
ok(!ab().hidden && ab().textContent === '↑1', '领先落后：' + ab().textContent);
ok(pill.title.includes('1 处改动'), '悬停提示里写了改动数：' + pill.title);

// 干净仓库：不显示改动数
window.__session(repo({ files: [], ahead: 0 }));
ok(count().hidden, '没有改动时不显示数字');
ok(ab().hidden, '不领先不落后时不显示箭头');

// 分离头指针：显示短 SHA，标题说明
window.__session(repo({ detached: true, branch: 'a1b2c3d' }));
ok(text() === 'a1b2c3d', '分离头指针显示短 SHA');
ok(pill.title.includes('分离头指针'), '悬停提示里说明是分离头指针：' + pill.title);

// 这一行的构成：模型 → 思考等级 → 分支，没有工作区胶囊（目录在左侧列表和面包屑里看得到）
window.__session(repo());
const pills = window.__pills();
const order = [...pills.children]
  .map((node) => {
    if (node.classList.contains('pill-model-wrap')) return 'pill-model-wrap';
    return node.id;
  })
  .filter((id) => ['pill-model-wrap', 'thinkingSelect', 'branchPill'].includes(id));
ok(document.getElementById('workspacePill') === null, '输入区那一行没有工作区胶囊了');
ok(order[0] === 'pill-model-wrap', '第一个是模型：' + order.join(' / '));
ok(order[1] === 'thinkingSelect', '第二个是思考等级');
ok(order[2] === 'branchPill', '第三个才是 git 分支');

const applyFit = (branchCut) => {
  // jsdom 不做布局，scrollWidth/clientWidth 都是 0；这里伪造「分支名有没有被压出省略号」。
  const label = document.getElementById('branchPillText');
  Object.defineProperty(label, 'scrollWidth', { configurable: true, get: () => (branchCut ? 240 : 100) });
  Object.defineProperty(label, 'clientWidth', { configurable: true, get: () => 100 });
  window.__fit();
  return [...pills.classList].filter((cls) => cls !== 'pills');
};

ok(JSON.stringify(applyFit(false)) === '[]', '分支名没被压：不加下限');
ok(JSON.stringify(applyFit(true)) === '["floors"]', '分支名被压：给分支加下限（至少留几个字）');
ok(JSON.stringify(applyFit(false)) === '[]', '宽回来之后下限要撤掉');

// 面板：当前分支、本地分支、改动清单都在
window.__session(repo());
window.__toggle();
ok(!panel.hidden, '点胶囊打开面板');
const panelText = panel.textContent;
ok(panelText.includes('当前分支'), '面板里有「当前分支」');
ok(panelText.includes('feature/pinyin-editor'), '面板里列出当前分支名');
ok(panelText.includes('main'), '面板里列出其它本地分支');
ok(panelText.includes('1 处改动'), '面板里写了改动数');
ok(panelText.includes('PinyinEditor.kt'), '面板里列出了改动文件');
ok(panelText.includes('只看不改'), '面板里说明只读');
ok(!panelText.includes('最近提交'), '第一版不带最近提交');

window.__toggle();   // 面板此刻是开着的，再点一下应该收起
ok(panel.hidden, '再点一次收起');

// 工具函数
ok(window.__short('app/src/main/java/com/x/PinyinEditor.kt') === 'app/src/…/PinyinEditor.kt', '长路径中间省略：' + window.__short('app/src/main/java/com/x/PinyinEditor.kt'));
ok(window.__short('a.kt') === 'a.kt', '短路径原样显示');
ok(window.__since(Math.floor(Date.now() / 1000) - 3600 * 5) === '5 小时前', '相对时间自己算中文：' + window.__since(Math.floor(Date.now() / 1000) - 3600 * 5));

done();
