'use strict';

/* ------------------------------------------------------------------ *
 * 外观：主题（跟随系统 / 浅色 / 深色）与配色（四套）
 *
 * 这个文件在 <head> 里同步加载，先于页面渲染把 <html data-theme data-palette>
 * 定下来，深色下不会先闪一下白底。app.js 只用这里的东西，不再自己推断。
 * ------------------------------------------------------------------ */

const PALETTES = [
  /* dot 是这套配色的标记色，深浅两套主题上都看得清。 */
  { id: 'paper', name: '纸白', dot: '#9aa0aa' },
  { id: 'sand', name: '暖砂', dot: '#c08a55' },
  { id: 'mist', name: '雾蓝', dot: '#5a99dd' },
  { id: 'pine', name: '松绿', dot: '#4fa879' },
];

const THEMES = [
  { id: 'system', name: '跟随系统' },
  { id: 'light', name: '浅色' },
  { id: 'dark', name: '深色' },
];

/* 用户气泡的三档：默认跟随强调色，另给两档固定绿。 */
const BUBBLE_TONES = [
  { id: 'tint', name: '跟随主题', dot: 'var(--accent)' },
  { id: 'wechat', name: '微信绿', dot: '#d7f0c4' },
  { id: 'mint', name: '薄荷', dot: '#dff1e6' },
];

/* 字体大小：四档，按区域各选一档。值是倍率，直接乘进 CSS 里的 calc()。 */
const FONT_STEPS = [
  { id: 's', name: '小', scale: 0.9 },
  { id: 'm', name: '标准', scale: 1 },
  { id: 'l', name: '大', scale: 1.12 },
  { id: 'xl', name: '特大', scale: 1.24 },
];

/* 三个区域各自独立：正文要能放大读，过程区常常要连带缩小回头看，界面又不想跟着变。 */
const FONT_REGIONS = [
  { id: 'body', name: '对话正文', hint: '提问与回答的正文、正文里的代码' },
  { id: 'work', name: '过程区', hint: '工作步骤、步骤详情、命令与输出' },
  { id: 'ui', name: '界面', hint: '侧栏、输入框、设置页与各种面板' },
];

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

const appearance = {
  theme: 'system',
  palette: 'paper',
  bubble: 'tint',
  fonts: { body: 'm', work: 'm', ui: 'm' },
};

(function loadAppearance() {
  try {
    const theme = localStorage.getItem('sevenstation.theme');
    const palette = localStorage.getItem('sevenstation.palette');
    const bubble = localStorage.getItem('sevenstation.bubble');
    if (THEMES.some((entry) => entry.id === theme)) appearance.theme = theme;
    if (PALETTES.some((entry) => entry.id === palette)) appearance.palette = palette;
    if (BUBBLE_TONES.some((entry) => entry.id === bubble)) appearance.bubble = bubble;

    const fonts = JSON.parse(localStorage.getItem('sevenstation.fonts') || '{}');
    for (const region of FONT_REGIONS) {
      if (FONT_STEPS.some((step) => step.id === fonts[region.id])) {
        appearance.fonts[region.id] = fonts[region.id];
      }
    }
  } catch {
    /* 存不了就用默认值：跟随系统、纸白、跟随主题。 */
  }
})();

function resolvedTheme() {
  if (appearance.theme === 'light' || appearance.theme === 'dark') return appearance.theme;
  return systemDark.matches ? 'dark' : 'light';
}

function fontScale(regionId) {
  const step = FONT_STEPS.find((entry) => entry.id === appearance.fonts[regionId]);
  return step ? step.scale : 1;
}

function applyAppearance() {
  const root = document.documentElement;
  root.dataset.theme = resolvedTheme();
  root.dataset.palette = appearance.palette;
  root.dataset.bubble = appearance.bubble;

  // CSS 里每处字号都写成 calc(原值 * var(--fs-区域))，改这三个变量就整套跟着变。
  for (const region of FONT_REGIONS) {
    root.style.setProperty('--fs-' + region.id, String(fontScale(region.id)));
  }
}

function setAppearance(patch) {
  if (patch.theme) appearance.theme = patch.theme;
  if (patch.palette) appearance.palette = patch.palette;
  if (patch.bubble) appearance.bubble = patch.bubble;
  if (patch.fonts) {
    for (const region of FONT_REGIONS) {
      if (FONT_STEPS.some((step) => step.id === patch.fonts[region.id])) {
        appearance.fonts[region.id] = patch.fonts[region.id];
      }
    }
  }
  try {
    localStorage.setItem('sevenstation.theme', appearance.theme);
    localStorage.setItem('sevenstation.palette', appearance.palette);
    localStorage.setItem('sevenstation.bubble', appearance.bubble);
    localStorage.setItem('sevenstation.fonts', JSON.stringify(appearance.fonts));
  } catch {
    /* 存不了就只在这次会话里生效。 */
  }
  applyAppearance();
}

applyAppearance();

/* 跟随系统那档要跟着系统开关走。 */
systemDark.addEventListener('change', () => {
  if (appearance.theme === 'system') applyAppearance();
});
