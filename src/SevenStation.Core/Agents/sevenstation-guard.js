/**
 * Seven Station 的 Pi 扩展：界面纪律（每轮注入）+ 正文相对路径改写（确定性）。
 *
 * 由 Seven Station Core 用 `-e <这个文件>` 加载，不装进用户的 ~/.pi/agent/extensions，
 * 所以不影响用户在别处开的 Pi 会话。
 *
 * 两块能力：
 * 1. `before_agent_start`：每轮往系统提示末尾补一小段纪律。整份界面说明（pi-guidance.md）
 *    仍然走 `--append-system-prompt`，这里只放最容易在中途忘掉的那几条。
 * 2. `message_end`：把助手正文里的相对路径按会话 cwd 解析成带盘符的绝对路径，
 *    解析后确实存在的才改。界面只把绝对路径做成可点的链接，改完就一定能点。
 *
 * 只用 Pi 的公开钩子，不碰内部对象（`sol-mid-turn-guard` 那种挂内部 patch 的做法一升级就废）。
 */
import { existsSync } from "node:fs";
import path from "node:path";

export const DISCIPLINE_MARKER = "Seven Station 界面纪律";

export const DISCIPLINE = `
## Seven Station 界面纪律（每轮提醒，详细规则见前面那份界面说明）

- **中文**：思考、调用工具前的说明、过程中的小结、最终回答，全部中文；英文只留给代码、命令、路径、标识符、报错原文。
- **位置**：提到这台机器上真实存在的文件或目录，一律写带盘符的绝对路径（E:\\Dev\\...），网址带协议头。
  相对路径在界面上点不了，等于没给。
- **Windows**：路径别经过两层转义（写文件用编辑工具，别用 heredoc 喂 python）；停进程只按 PID，
  绝不 taskkill /IM；Start-Process 不能把 stdout 与 stderr 重定向到同一个文件；交给 PowerShell 5.1
  的 .ps1 要带 BOM；改文件保留原来的换行风格。
`;

/** 代码围栏整段跳过：那里的路径不参与链接，改了反而会改坏示例代码。 */
const FENCE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;

/**
 * 候选路径：至少一个分隔符、每段是正常文件名字符。
 * 前面不能紧跟字母数字或分隔符，避免从长串里切半截。
 */
const CANDIDATE = /(?<![\w.@\\/:-])(?:[A-Za-z]:[\\/])?(?:\.{1,2}[\\/])?[\w.@+-]+(?:[\\/][\w.@+-]+)*[\\/]?/g;

const ABSOLUTE = /^[A-Za-z]:[\\/]/;

/**
 * 把正文里的相对路径改写成绝对路径。纯函数，方便单测。
 *
 * @param {string} text 助手正文
 * @param {string} cwd 会话工作目录
 * @param {(target: string) => boolean} [exists] 存在性判断，测试可注入
 * @returns {string} 改写后的正文（没改动就原样返回）
 */
export function rewritePaths(text, cwd, exists = existsSync) {
  if (typeof text !== "string" || !text || !cwd) return text;

  let result = "";
  let last = 0;
  for (const fence of text.matchAll(FENCE)) {
    result += rewriteSegment(text.slice(last, fence.index), cwd, exists);
    result += fence[0];
    last = fence.index + fence[0].length;
  }
  result += rewriteSegment(text.slice(last), cwd, exists);
  return result;
}

function rewriteSegment(segment, cwd, exists) {
  if (!segment) return segment;
  return segment.replace(CANDIDATE, (token) => {
    if (token.includes("://")) return token;
    // 至少得有一个分隔符：不带分隔符的单词（docs、dist）不当路径。
    if (!/[\\/]/.test(token)) return token;

    if (ABSOLUTE.test(token)) {
      // 绝对路径但用了正斜杠：界面只认反斜杠写法，顺手换成能点的形式。
      const normalized = token.replace(/\//g, "\\");
      return exists(normalized) ? normalized : token;
    }

    if (token.startsWith("\\\\") || token.startsWith("//")) return token;

    // 结尾带分隔符的（`dist/`）改写后也留着，读起来仍是「某个目录」。
    const trailing = /[\\/]$/.test(token);
    const absolute = path.resolve(cwd, token);
    const shown = trailing && !absolute.endsWith("\\") ? absolute + "\\" : absolute;
    return exists(absolute) ? shown : token;
  });
}

/** 改写一条消息里的所有文本块；没有变化就返回 null（不改动消息本体）。 */
export function rewriteMessage(message, cwd, exists = existsSync) {
  const content = Array.isArray(message && message.content) ? message.content : [];
  let changed = false;

  const next = content.map((part) => {
    if (!part || part.type !== "text" || typeof part.text !== "string") return part;
    const text = rewritePaths(part.text, cwd, exists);
    if (text === part.text) return part;
    changed = true;
    return { ...part, text };
  });

  return changed ? { ...message, content: next } : null;
}

export default function sevenStationGuard(pi) {
  pi.on("before_agent_start", (event) => {
    const prompt = (event && event.systemPrompt) || "";
    // 已经带过就别叠：同一轮被多个来源注入时不清不楚。
    if (prompt.includes(DISCIPLINE_MARKER)) return;
    return { systemPrompt: prompt + DISCIPLINE };
  });

  pi.on("message_end", (event, ctx) => {
    const message = event && event.message;
    if (!message || message.role !== "assistant") return;
    const cwd = (ctx && ctx.cwd) || process.cwd();
    const replaced = rewriteMessage(message, cwd);
    if (replaced) return { message: replaced };
  });
}
