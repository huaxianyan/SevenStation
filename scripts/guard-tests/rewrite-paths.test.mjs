// Seven Station 的 Pi 扩展里那几个纯函数：相对路径改写要改对、不能改坏。
// 跑法：node scripts/guard-tests/rewrite-paths.test.mjs
import assert from "node:assert/strict";
import { rewritePaths, rewriteMessage, DISCIPLINE, DISCIPLINE_MARKER } from "../../src/SevenStation.Core/Agents/sevenstation-guard.js";

const cwd = "E:\\Dev\\SevenStation";
// 假装这些路径存在，别去碰真磁盘。
const files = new Set([
  "E:\\Dev\\SevenStation\\docs\\STATUS.md",
  "E:\\Dev\\SevenStation\\src\\SevenStation.Core\\Agents\\pi-guidance.md",
  "E:\\Dev\\SevenStation\\dist",
  "E:\\Dev\\SevenStation\\src",
]);
const exists = (target) => files.has(target);

let pass = 0;
const ok = (condition, name) => {
  if (condition) {
    pass += 1;
    console.log("✓ " + name);
    return;
  }
  console.log("✗ " + name);
  process.exitCode = 1;
};

const rewrite = (text) => rewritePaths(text, cwd, exists);

// 相对路径 → 绝对路径
ok(
  rewrite("改好了 docs/STATUS.md。") === "改好了 E:\\Dev\\SevenStation\\docs\\STATUS.md。",
  "相对文件路径换成带盘符的绝对路径",
);
ok(
  rewrite("包在 dist/ 目录里") === "包在 E:\\Dev\\SevenStation\\dist\\ 目录里",
  "相对目录也能换（结尾的分隔符跟着保留）",
);
ok(
  rewrite("看 `src/SevenStation.Core/Agents/pi-guidance.md` 这份") ===
    "看 `E:\\Dev\\SevenStation\\src\\SevenStation.Core\\Agents\\pi-guidance.md` 这份",
  "反引号里的路径照样换",
);

// 不该动的东西
ok(rewrite("E:\\Dev\\SevenStation\\docs\\STATUS.md 本来就能点") === "E:\\Dev\\SevenStation\\docs\\STATUS.md 本来就能点", "已经是绝对路径的不重复改写");
ok(rewrite("看 https://github.com/huaxianyan/SevenStation 这个") === "看 https://github.com/huaxianyan/SevenStation 这个", "网址不改");
ok(rewrite("用 and/or 都行") === "用 and/or 都行", "不像路径的词不改");
ok(rewrite("`node scripts/fake/missing.js` 不存在") === "`node scripts/fake/missing.js` 不存在", "解析后不存在的不改");
ok(rewrite("改 `E:/Dev/SevenStation/docs/STATUS.md`") === "改 `E:\\Dev\\SevenStation\\docs\\STATUS.md`", "正斜杠写的绝对路径换成能点的反斜杠");

// 代码围栏整段跳过
const fenced = "示例：\n\n```bash\ncd docs && ls src/SevenStation.Core/Agents/pi-guidance.md\n```\n";
ok(rewrite(fenced) === fenced, "代码块里的路径不动");

// 一条消息里多个文本块
const message = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "内部思考不改" },
    { type: "text", text: "改了 docs/STATUS.md" },
    { type: "text", text: "还有 dist/" },
  ],
};
const changed = rewriteMessage(message, cwd, exists);
ok(changed && changed.role === "assistant", "改写后仍是一条 assistant 消息");
ok(changed.content[0] === message.content[0], "非文本块原样保留");
ok(changed.content[1].text === "改了 E:\\Dev\\SevenStation\\docs\\STATUS.md", "第一块改写");
ok(changed.content[2].text === "还有 E:\\Dev\\SevenStation\\dist\\", "第二块改写");
ok(message.content[1].text === "改了 docs/STATUS.md", "原来的消息对象没被就地改掉");

// 没有可改的就返回 null，别平白替换消息
ok(
  rewriteMessage({ role: "assistant", content: [{ type: "text", text: "都是中文，没有路径" }] }, cwd, exists) === null,
  "没变化时返回 null",
);
ok(rewriteMessage({ role: "user", content: [{ type: "text", text: "docs/STATUS.md" }] }, cwd, exists) !== null, "用户消息也能改（调用方自己过滤角色）");

// 注入的纪律本身要够短，别把整份说明再塞一遍
ok(DISCIPLINE.includes(DISCIPLINE_MARKER), "纪律里带标记，便于判重");
ok(DISCIPLINE.length < 800, "纪律是短的（" + DISCIPLINE.length + " 字符），不是整份说明");

console.log("\n" + pass + " 条断言通过");
