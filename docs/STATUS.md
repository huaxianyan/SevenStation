# 进度

## STATUS-092：侧栏说没在跑、对话里还在转（2026-11-27）

现象：装完 0.5.3（Core 重启过）之后，某条会话在界面上还显示「进行中」，侧栏那条却不转。

取证：旁听 WebSocket 广播，`conversation_list` 里那条 `working=false`、`status=ready`；
而它最后一条落库消息停在 Core 重启前那一刻（19:19:23），之后一个小时没有任何新消息。
`CenterHub` 的 `working` 是 `_live[id].Streaming`——那一轮确实不在了（重启杀掉了子进程）。

根因在前端：`session.streaming` 只在 `agent_start` / `message_start` 时置 true，`agent_settled` 置 false。
Core 重启时前端收不到 `agent_settled`，这个 true 就一直挂着；而 `openSession` 命中缓存时**不发**
`open_conversation`（3300 行附近），重连时也只重取 `currentKey` 这一条——切到别的会话看到的就是缓存里的假状态。
侧栏走 Core 的 `working`，对话走本地的 `streaming`，两处各说各的。

修法：

- `dropStaleStreaming()`：连接刚接上时把本地所有「正在跑」放掉（断开期间 Core 可能重启过，本地不可信）；
- `syncStreamingFromList()`：收到列表时按 Core 的 `working` 校正，Core 说在跑就认，说没跑时才降级，
  并且刚发出 8 秒内、或还有没被确认的气泡、或正在流式接收时不打回空闲。

测试 `scripts/ui-tests/streaming-sync.test.js`（7 条）。版本 0.5.4。

## STATUS-091：会话列表的时间与用量跟着动（2026-11-27）

两处「只有一轮结束才更新」的显示：

- **会话列表那一格**：原来固定写 `relativeTime(updatedAt)`，只在收到 `conversations` 时重算，
  所以工作中一直是开始前的旧时间。现在在跑的那条写「工作中」（左边本来就有转圈），
  其余每 30 秒只改文本节点（不重建列表，避免打断悬停、把滚动条弹回去）。
  测试 `scripts/ui-tests/session-time.test.js`（6 条）。
- **tokens / 上下文占比**：原来只有 `PersistTurnAsync`（一轮结束）时问 Pi `get_session_stats`。
  现在 `message_end` 与 `tool_execution_end` 之后 `AskLiveStats` 顺手要一次（3 秒节流、5 秒超时），
  失败退避 30 秒并记日志——长命令期间 Pi 没空回话是常事，不能每条消息都重试刷屏。
  落库时机不变，仍在一轮结束。
## STATUS-090：第一次点开的对话不出分支胶囊（2026-11-27）

`git_status` 只在「这条会话已在 `app.byKey` 里」那条路径问（`openSession` 的缓存分支）。
第一次点一条不在缓存里的对话走的是 `open_conversation` → `onSessionState`，那条路径没问，
所以要点开、切走、再切回来（这次命中缓存）才出现。修法：`onSessionState` 里也 `requestGitStatus()`，
20 秒节流已经挡住重复请求。测试 `scripts/ui-tests/git-first-open.test.js`（4 条）。版本 0.5.2。
## STATUS-089：git 探测在服务账户下失效（2026-11-27，装 0.5.0 后复现）

现象：装上 0.5.0 之后，界面上看不到分支胶囊。

- 装的这一版功能都在：`SevenStation.Core.exe --git-status E:/Dev/SevenStation` 在用户会话里跑能出 repo:true，
  前端也有 `branchPill`；但通过页面的 `git_status` 请求回来是 `{repo:false}`。
- 根因：Core 服务跑在 **LocalSystem**，工作区 owner 是 `BAHAMUTinaBranford`，git 2.35.2 起对
  「仓库 owner 不是自己」直接拒绝（`detected dubious ownership`），**stdout 空、原因只在 stderr**。
  旧代码只读 stdout、丢掉 stderr，于是判定「不是仓库」，日志里一条都没有（这就是为什么查不到）。
- 修：`GitProbe.RunAsync` 给 git 传 `GIT_CONFIG_*` 组的 `safe.directory=*`（只跑 rev-parse / status /
  for-each-ref，不执行仓库内容）；并且「stdout 空但 stderr 有话」时记一行日志（`not a git repository` 除外，
  那是正常情况）。
- 版本升 0.5.1 并重打两个 MSI：**同版本号重装 MSI 不会替换文件**，0.5.0 已经装过就必须换号。
## STATUS-088：Pi 一声不吭的时候，界面别假装在干活（2026-11-27）

现象：界面「工作 30620 秒」挂了 8 小时半。查库发现**那一轮实际只干了 4 分钟**：
`messages` 里 02:07 到 02:11 有正常的一轮（assistant 与 toolResult 交替），**02:11 之后到 10:37 一条消息都没有**，
而 `streaming` 一直是 true，10:37 点停止时 Core 还会「Pi 已接受，等它收尾」——等的是个不会来的收尾。

结论：不是「这一轮真跑了 8 小时」，是 **Pi 卡在某一处（多半是一个不返回的工具调用）既不结束也不退出**，
Core 没有超时兜底，界面就只剩秒数在涨。

- 前端：`dispatch` 里每个带 `key` 的消息都更新 `app.lastEventAt`。`paintWorkHint` 在 3 分钟没动静时
  改成「工作 8 小时 30 分 · 3 分没动静」，10 分钟以上再补「，可能卡住了」。
- Core：`Live.LastEventAt` 在 `RecordReceived` 里刷新；每 60 秒的 `WatchQuietSessions` 对
  「还在跑且 5 分钟没事件」的会话每 10 分钟记一条日志，便于下次拿到现场。**只记不改状态**：
  Pi 可能真的在跑长命令，替它判死会把消息丢在半路。
- 测试：`scripts/ui-tests/work-hint-quiet.test.js`（6 条）、`work-hint-stop.test.js`（5 条）。
- 顺带：按了停止之后不再往上报时长（Pi 收尾要等当前那步），改显示「正在停止 · 等 Pi 收尾」。
## STATUS-086：输入区那一行只留「模型 → 等级 → 分支」，新建对话记住上次设置（2026-11-27）

两件事：把输入卡片下面那颗工作区胶囊去掉（目录在左侧列表和上方面包屑里都看得到，重复一份没必要），
以及修掉「新建对话思考等级总是回到 low」。

- 顺序改成**模型 → 思考等级 → git 分支**（有仓库才有第三颗）。收缩只作用于分支名：
  模型 `flex: 0 0 auto`（决定这一轮花谁的钱）、等级也按内容走；分支名被压出省略号时加 120px 下限，再窄就剩图标 + 改动数。
  `pill-workspace` 的样式与监听一并删掉；选目录仍有空态按钮与新建对话两处入口。
- **思考等级回到 low 的根因**：新建对话库里 `thinking_level` 是 NULL，界面回落到等级列表第一条，
  而 Pi 对这个模型报的列表是 `["low","high","max"]`——第一条就是 low；Pi 实际跑的是它自己的默认 `high`。
  也就是说界面显示 low、实际跑 high，两边都不对。
- 修法两条：① `CaptureSettingsAsync` 顺手把模型与等级记进 `settings`（`lastModel` / `lastThinkingLevel`），
  新建对话时 `InheritLastSettings` 把它们写进新对话；② 新起的 Pi 子进程在第一次 prompt 前
  `ApplyStoredSettingsAsync` 把对话里记的模型与等级推过去（`SettingsApplied` 保证每个子进程一次）。
  第二条同时修掉「界面显示 A、Pi 实际跑 B」这个更隐蔽的问题。

## STATUS-087：长跑时间换成「小时 / 天」（2026-11-27）

「工作 30620 秒」读不出来。输入卡片下面那行改走 `formatSpent`：一分钟内写秒，再久「M 分 S 秒」，
一小时以上「H 小时 M 分」，一天以上「D 天 H 小时」（只留两级）。单步「用时」超过一分钟也走同一套，
长命令不再显示「612.4 秒」。测试 `scripts/ui-tests/spent-format.test.js`（17 条）。
## STATUS-085：看得见 git 分支（2026-11-27）

在 Pi 里开分支干活时没地方看当前在哪条分支上，所以在输入框那一行加了一颗只读的分支胶囊。

- Core 侧 `src/SevenStation.Core/Sessions/GitProbe.cs`：三条只读命令（`rev-parse --show-toplevel`、
  `status --porcelain=v2 --branch`、`for-each-ref refs/heads`），`GIT_OPTIONAL_LOCKS=0`，6 秒超时，
  同一目录 4 秒内缓存。**不做 checkout / branch / stash**，一个字都不写仓库。
  不是仓库、没装 git、超时一律当「不是仓库」，不往界面上抛错。
- 协议：客户端 `{"type":"git_status","key":...}` → Core 回 `{"type":"git_status","key":...,"data":{...}}`。
  打开会话时问一次（20 秒节流），一轮 `agent_settled` 之后再问一次，点开面板强制刷新。
- 排障开关：`SevenStation.Core.exe --git-status <目录>` 直接把快照打成 JSON，不起服务。
- 前端（`app.js` / `index.html` / `styles.css`）：胶囊显示分支名 + 改动数 + ↑领先↓落后，点开一个浮层：
  当前分支、本地分支（最多 8 条，带「3 天前」）、改动清单（最多 12 条，M/A/D/R/U 上色）、
  「只看不改」一句。面板里不带「最近三条提交」——用户 2026-11-27 定。
- 宽度不够时**先降目录、再降分支**：目录在面包屑与左侧列表里都看得到，分支只在这一处有。
  收缩全交给 flex（目录 `flex-shrink: 6`、分支 `2`、模型与被压时才加下限），挤到模型名头上时目录名直接收成一个图标。
  模型名是最后让位的（`flex: 0 0 auto`）。
- 实测（1536 宽窗口）：输入区列宽上限 760px，胶囊可用宽度只有 426px。branch `main` → 全部完整；
  `feature/pinyin-editor` + 7 处改动 → 全部完整；48 字的长分支名 → 目录变 `SevenSt…`、分支省略、模型完整。
- 测试 `scripts/ui-tests/git-branch.test.js`（24 条：显示/隐藏、改动数与领先落后、分离头指针、
  降级顺序、模型不让位、面板内容、路径中省略、相对时间）。
- 原型与实测在 `design/git-branch-proto.html`（1600 宽三方案）与 `design/git-branch-narrow-proto.html`（窄宽度降级）。

## STATUS-084：上下文圆环、折叠规则交接（2026-11-23）

- 输入框那一行加了上下文比例圆环（18px，已用部分从 12 点顺时针画，≥85% 换警示色，悬停有提示、点击弹数值）。
  数据与顶栏小字同源（`contextUsage`），顶栏保留精确值。测试 `scripts/ui-tests/context-ring.test.js`（13 条）。
  效果图 `design/shots/ctx-ring-light.png`、`ctx-ring-full.png`、`ctx-ring-dark.png`。
- 过程区的自动折叠规则**交给用户自己开发**（2026-11-23 决定），做完提 PR 合并。交接说明在
  `docs/work-panel-collapse.md`：现状与代码位置、三条互斥需求、四个候选方案、七条必须保持的不变量、
  本地验证办法、PR 边界。现在的「跑着展开、跑完收起」是约定，不是缺陷。
- 打包修好之后（MSI 现在真的带 `Agents/`），这台机器装的是 `0.26.1123.1022`，日志里已确认
  `--append-system-prompt 支持，-e/--extension 支持`。

## STATUS-083：界面纪律扩展与路径改写（2026-11-23）

0.5.0 之后连续两轮发现「提示词写了但模型不照做」：调用工具前的说明用英文、正文里的路径写成相对路径（界面上点不了）。
排查下来都是同一类问题——`--append-system-prompt` 一次性注入的长文档，跑到中途注意力就淡了，且无法事后补救。

- 新增 Pi 扩展 `src/SevenStation.Core/Agents/sevenstation-guard.js`，由 `PiHost.Compose` 用 `-e <绝对路径>` 加载：
  - `before_agent_start` 每轮补一小段界面纪律（中文含工具前说明 / 真实位置写绝对路径 / Windows 常见坑），带标记判重；
  - `message_end` 把助手正文里的相对路径按会话 cwd 改写成带盘符的绝对路径，解析后确实存在的才改，代码围栏跳过。
- 单测 `scripts/guard-tests/rewrite-paths.test.mjs`（18 条断言，纯函数，不调模型）。真机沙箱实测：
  让模型「只输出 `docs/STATUS.md`」，出来的正文与入库正文都是 `E:\Dev\SevenStation\docs\STATUS.md`；
  另一次让它复述被注入的纪律，它准确列出三条，说明注入生效。
- `PiLocator` 的 `--help` 探测改成一次读完缓存，同时判断 `--append-system-prompt` 与 `-e/--extension` 并把结论写进日志。
- 顺带修掉 `pi-guidance.md` 里两处早先写入事故：带空格的示例路径里反斜杠丢了、结尾中文段重复两遍。

## 当前主线

- 现在在做什么：0.5.0 出包。相对 0.4.1 的增量是执行代理（Pi 改由登录会话里的代理进程起）、设备配对与令牌、
  更新提示与一键升级、字号设置、路径右键菜单、过程区分段与就地展开。
- 版本号已改成 0.5.0，五处同号：`SevenStation.Core.csproj` 的 `<Version>`、Control 与 Desktop 的
  `Cargo.toml` 与 `tauri.conf.json`。
- 发布说明 `docs/release-notes/v0.5.0.md` 已过门禁（23 行）；出包后按 `build/release/v<版本>.md` 的格式补构建信息表。
- 发版前还要做：`node scripts/ui-smoke.mjs --cwd <目录>`（真调模型，客户端也要起来）、两个 MSI 出包、
  在干净环境真装真卸。第 4 项这台机器做不了——它是用户的生产环境。
- 发布物仍是**两个 Windows x64 安装程序**：`SevenStationCore-win-x64-0.5.0.msi`（含 Control）与
  `SevenStation-win-x64-0.5.0.msi`。都不做便携版。
- **本机装着的 v0.4.1 是用户的生产环境**（2026-11-19 起他用这两个软件干活）：测试一律用
  `SEVENSTATION_PROFILE=test` + 临时 `SEVENSTATION_CORE_HOME` + 8899 端口，详见 `AGENTS.md` 的「生产与测试隔离」。
- 2026-11-19 起用户把日常开发搬到这里来用（正式版，现在是 `v0.4.1`）。装前备份在
  `%USERPROFILE%\SevenStation-backup-20261119-1458\`；工作区都在 Seven Station Core 那台机器上，
  客户端设备的本地文件不参与。
- 已发布（2026-11-19）：Release `v0.4.0` 一个页面，装 Seven Station Core 与客户端的两个 MSI 加各自 `.sha256`；
  0.3.0 也按同一形态重做成 `v0.3.0`。标签只有版本号，一版一 Release。
- 已知阻塞：无。
- 已知限制（写进发布说明）：Seven Station Core 目前只放 Windows 包，之后会出 Linux 版；局域网限本地子网、没做 TLS；
  手机窄屏未调；数据库没有版本化迁移，只有「查列再补」这一处临时逻辑。

## STATUS-082：升级通道（2026-11-22）

接着 STATUS-081 把「升得动」补上。

- `Agents/PiUpgrader.cs`：经执行代理起 `node pi-launcher.js update --self|--extensions`，PATH 第一段
  是 Pi 自带的 node 目录（系统那个 node 20 会直接死在 `enableCompileCache`），5 分钟超时挡在中间，
  失败原因取输出最后一行。
- 升级顺序：先 Pi 再扩展；有对话正在跑就拒（它会把旧版本目录收拾掉，正在用的进程指着那边）。
  连上时若还没查过，先现查一次再决定「有没有要升级的东西」。
- 结束先说结果再重查：卡片立刻翻面，版本号随后跟上（重新查要打 npm/git，不能让用户干等网络）。
- 界面：提示条与运行时卡片上的「升级」都发 `upgrade_pi`；过程沿用 `statusToast()`——
  同一张卡片从「正在升级…+转圈」翻成「已升级」，不弹第二个。升级期间按钮按住。

验证（沙箱，`work/smoke` 里已清理）：假 launcher 走完「Core → 管道 → 代理 → 子进程」全程，
确认参数是 `update --extensions`、`PATH` 首段是 pi-node；失败路径回的是 launcher 自己的报错。
`scripts/ui-tests/upgrade-flow.test.js` 锁住「一张卡片翻面 / 重复点不重复发 / 失败说清还在哪个版本」。

**事故记录**：这一轮第一次试跑时，手写的临时 `settings.json` 反斜杠被吃掉了，Core 读不出来就自动探测
到了真安装，点下去等于真的执行了 `pi update --self`——本机 Pi 已从 1.5.2 升到 1.6.0。
升级本身是成功的（1.6.0 仍支持 `--mode rpc` / `--append-system-prompt` / `--session`，
旧版本目录 `1.5.2` 还在，会话没断），但这是不该发生的：验证升级先用日志里的
「找到 Pi：…」确认指向临时目录，再点。

## STATUS-081：只读更新（版本可见 + 每 6 小时查一次，2026-11-22）

只做「看得见」，还没做「升得动」。

- Core 新增 `Agents/PiUpdates.cs`：判定照 Pi 的 `checkForAvailableUpdates()`——钉住的一律跳过、
  npm 比 semver、git 拿上游分支比 `ls-remote`、任何异常都当没有更新。Pi 是哪个 npm 包从
  `install/releases/<版本>/package.json` 的 dependencies 里读，不写死包名。
- 节奏：启动后 20 秒一次，之后每 6 小时；手动「检查更新」有 10 分钟缓存，并发只打一次网络。
  新客户端连上直接拿缓存（`Join` 里补一条 `updates`）。
- 界面三处：输入框上方提示条（有新版才露，`稍后`＝本次不再提醒）、侧栏「扩展」行数字左边的紫色图标
  （只在有扩展可更新时亮）、设置页「运行时」卡片（Pi 与扩展的版本、可更新清单、检查更新）。
  提示条的「查看」先跳到运行时卡片；升级通道做好后换成「升级」。
- 紫色 `--upd`（亮 `#7357e8` / 深 `#a78bfa`）只用在更新这条线上。

验证：临时 home 起 8899（`work/smoke/upd-home`）跑 `node scripts/check-updates.mjs`，实测
Pi 1.5.2 → 1.6.0、TokenEconomizer 4a04fe4 → 1bfeccd、钉住的 `pi-smart-compact@v2ex-recovery`
只报提交不比远程；界面用 CDP 截图核过亮/深两套。`scripts/ui-tests/updates-strip.test.js` 锁住
「有更新才露 / 稍后只管这一次 / 没有更新不出声 / 文案不出现内部术语」。

## STATUS-080：更新图标尾巴加长（原型 v6，2026-11-22）

用户说「箭头尾巴有点短，第一眼看不出是往上的」。第一版 shaft 只有 6.35–9.65（长 3.3），
16~18px 下头几乎贴着尾根。现在改成 **5.8–10.2（长 4.4）**、头宽 2.8，墨迹中心仍精确落在圆心（0.00px）。

原型里留了三档对比（3.3 / 4.0 / **4.4** / 4.8）：4.8 顶到圆边显挤，4.0 略保守。
截图 `design/shots/updates-proto-v2-icons.png`，说明在 `docs/research/updates-2026-11.md` 6.6。

## STATUS-079：更新图标加大 + 换升级专用紫 + 侧栏图标挪到数字左边（原型 v5，2026-11-22）

三条改动：

1. **颜色**：土黄/橙换成**升级专用紫**（浅色 `#7357e8`、深色 `#a78bfa`，变量 `--upd`）。这个紫色只出现在
   「有更新」这条线上（提示条图标、侧栏徽标、设置页状态位），不挪去染按钮或导航选中。
2. **尺寸**：图标加大 —— 提示条 18px（原 15）、侧栏 16px（原 14）；形状仍选 A（圈里向上箭头）。
3. **侧栏位置**：图标放到数字**左边**，两者一起放在 `margin-left: auto` 的尾部簇里，
   所以所有行的数字仍然右对齐（`扩展  ⊕ 7`，7 的右边缘与「对话 2」「技能 18」对齐）。

截图 `design/shots/updates-proto-v2-{light,dark,icons}.png`；说明在 `docs/research/updates-2026-11.md` 6.3 / 6.6。

## STATUS-078：更新图标改成向上箭头，并按墨迹实测居中（原型 v4，2026-11-22）

用户指出两点：方向反了（有新版 = 升级 = **向上**向上箭头；向下箭头是「下载文件」），以及上一个图标
箭头没在圆圈正中。

- 四个候选全换成向上语义：A 圈里向上箭头（描边 1.4）、B 同形粗一点、C 向上箭头 + 底座、D 圈里两个尖角。
  **选 A**：语义对、小尺寸干净。
- 居中不再靠目测：原型里对每个候选的 `path` 跑 `getBBox()`，算墨迹外框中心与圆心 (8, 8) 的距离，
  四张卡片底部直接打印偏差。改完后 A/B/D 都是 **0.00px**（上一版 A 是 7.95，偏 0.05；向下那版偏得更多）。
- 「图标按墨迹 bbox 对齐容器中心」写进了 AGENTS 的界面约定。

截图 `design/shots/updates-proto-v2-{light,dark,icons}.png`，说明在 `docs/research/updates-2026-11.md` 6.6 节。

## STATUS-077：更新图标 + 失败自动退回 + 「稍后」语义（原型 v3，2026-11-22）

用户定下来的三条，原型与文档同步改了：

1. **检查间隔 6 小时照准**；
2. **不做「退回并重启 Pi」按钮**：升级流程是「装到一边 → 确认能启动 → 才切换」，起不来就丢掉新版、
   保持旧版本，用户只看到「升级没成功，还在 1.5.2」；
3. **「稍后」= 本次打开不再提醒**（只记内存，重开客户端会再提）；
4. 另外要求：光靠颜色点不够，得有个**看得出是「更新」的图标**。

图标出了四个候选（`design/shots/updates-proto-v2-icons.png`，原型里 `?only=icons` 可放大看）：
**选 A「圈里向下箭头」**——小尺寸清楚，也不和刷新/重试的循环箭头混。同一枚用在主界面提示条（15px）、
侧栏「扩展」行末（14px）、设置页状态位。

截图：`design/shots/updates-proto-v2-{light,dark,icons}.png`；设计说明在
`docs/research/updates-2026-11.md` 第六节（6.2 / 6.3 / 6.5 / 6.6）。

## STATUS-076：更新提示改为主界面可见 + 定期检查（原型 v2，2026-11-22）

用户要求两点：一是 UI 文案别说「冒烟」这类内部词；二是检查更新不能纯手动，查到就要在主界面提示，
点一下直接升级（Pi 本体在输入框上方，扩展在侧栏「扩展」那一行）。

- **检查节奏**：启动后 20 秒 + 每 6 小时，结果缓存；失败不提示，只在设置页写明原因；`PI_OFFLINE`/断网直接跳过。
- **主界面提示条**：输入框正上方一条，`Pi 有新版本 1.5.2 → 1.6.0 [稍后] [升级]`，点「升级」原地变进行中，
  完成后变绿并自动消失；「稍后」= 本机今天不再提。
- **侧栏**：「扩展」数字始终是装了几个，有新版多一个橙点；设置页「运行时」卡片仍是完整入口（含扩展与模型目录）。
- **文案全部改成人的说法**：`升级没成功：新版本装好了但打不开，这台电脑的 node 版本太旧。已经保持原样，还在 1.5.2。`
  这类，对照表见原型 F 区。

原型 `design/updates-proto.html` 与截图 `design/shots/updates-proto-v2-{light,dark}.png` 已更新；
设计说明在 `docs/research/updates-2026-11.md` 第六节。

## STATUS-075：版本与更新的界面原型（2026-11-22）

原型 `design/updates-proto.html`（引用真实 `styles.css`；`?theme=dark`、`?fs=xl` 可看变体），
截图 `design/shots/updates-proto-{light,dark}.png`。四块：

- **设置页「运行时」卡片**：Pi 版本 → 最新版 + 状态徽标（有新版 / 已是最新 / 检查中 / 检查失败 / 正在升级）
  + [升级 Pi][检查更新]；模型目录刷新并入同一卡片。
- **扩展页**：页头 [检查更新]；行内只多一个「有新版 <短提交>」；钉住/本地包直接写「不检查更新」。
- **进度**：沿用现有 toast 卡片，进行中 → 结果原地翻面，失败带原因；失败后给「回退并重启 Pi」卡片（只能回一步）。
- **技能页**：只加来源标签，不加版本。

待用户定的三点：升级入口是否也在侧栏提示、检查更新是否自动、要不要回退按钮。

## STATUS-074：扩展「有新版」的判定照 Pi 自己的规则（2026-11-22）

用户要求：别自己发明判定，查 Pi 怎么界定扩展有没有更新，按那个来。查到并核对了
`dist/core/package-manager.js` 的 `checkForAvailableUpdates()`：

- 只查全局 + 项目的 `packages[]`，跳过 `temporary`；**`pinned` 一律跳过**（npm 精确版本号、
  git 任何 ref —— `buildGitSource` 里 `pinned: Boolean(args.ref)`）；
- npm：`npm view <spec> version --json`，`semver.gt(最新, 已装)`；
- git：`git ls-remote origin refs/heads/<上游分支>`（来自 `@{upstream}`，非 `origin/*` 退回 `HEAD`）
  与本地 `rev-parse HEAD` 比，不同就是有新版；**用 ls-remote，不 fetch、不碰工作区**；
- `PI_OFFLINE` 时不查；任何异常都当「没有更新」。

用这套原命令在本机核了一遍：4 个 npm 全部最新；git 里只有 **TokenEconomizer 有更新**（4a04fe4 → 1bfeccd），
pi-v2ex-quota 一致，pi-smart-compact 钉住被跳过（且其上游 `origin/v2ex-recovery` 也没新提交）。
顺带修正早先的错误判断：拿默认分支 `origin/HEAD` 去比是错的，Pi 比的是当前分支的上游。

另外记下 Pi 升级时的破坏性行为：git 包是 `git reset --hard` + `git clean -fdx` + 装依赖，
**本地改动会丢**；npm 包装 `@latest`（或配置里的 spec）。

方案文档同步改在 `docs/research/updates-2026-11.md` 的「三、方案」与「四点六」两节。

## STATUS-073：隔离实跑 pi update（2026-11-22，未动产品代码）

在 `work/smoke/pi-home`（真实 `~/.pi/agent` 的副本，不含 sessions）上跑 `pi update --self`，标准输入接 `/dev/null`：

- 系统 node **v20** 在 PATH 上 → 失败（staging 冒烟报 `enableCompileCache` 不存在，那是 Node ≥ 22.8 的 API）；
- 把 pi-node **v22.23.3** 放 PATH 最前 → 34 秒成功，`1.5.2 → 1.6.0`，全程无提问。

同时确认：`settings.json` / `models.json` md5 不变（1.6.0 唯一的迁移是 legacy apiKeys → `auth.json`，
本机已有 `auth.json` 故跳过）；失败不留残骸（`current-version` 不变、staging 已清）；旧版本只留一步
（升级后 1.5.1 被删）；1.6.0 的 `--append-system-prompt` / `--mode rpc` / `--session` 都在，
`get_state` 握手 `success: true`。

**最重要的一条**：升级过程用的是 **PATH 里的 node 与 npm**（`npm ci` 与 `.bin/pi.cmd`），
不是我们平时起 Pi 用的那个绝对路径 node。升级时必须把 pi-node 目录塞进 PATH 最前面。

细节与命令见 `docs/research/updates-2026-11.md` 的四点六节；日志留在 `work/smoke/exp-ok.log` 与
`work/smoke/exp-node20-fail.log`（已忽略，不进库）。

## STATUS-072：技能、扩展、Pi 自身的版本与升级（调研，2026-11-22）

用户提出：技能、扩展、Pi 本身的升级现在界面里看不到，先调研出方案。方案写在
`docs/research/updates-2026-11.md`，本轮不动代码。

关键实测：Pi 装的是 1.5.2，npm 上已经有 1.6.0；7 个扩展里 4 个 npm 全是最新，3 个 git 里
TokenEconomizer 与 pi-smart-compact 远端有新提交（后者钉在 `@v2ex-recovery`，要按钉的分支比）；
18 个技能都是本地目录、没有 `.git`，也没有版本字段 —— 技能没有「版本」这个概念。

## STATUS-071：路径链接的右键菜单换成自己的（2026-11-22，未发版）

用户反馈：在 Seven Station 里对带完整路径的文件按右键，弹的是浏览器那三项
「在新窗口中打开链接 / 将链接另存为 / 复制链接」——对文件路径没有任何意义（链接的 href 就是 `#`）。

**做法**：路径链接（`.link-path`）上的 `contextmenu` 一律 `preventDefault()`，换成页内小菜单：

| 菜单项 | 说明 |
| --- | --- |
| 打开 | 原有行为（`reveal_path`，文件给默认程序、目录开文件夹） |
| 打开所在目录 | 新壳命令 `reveal_in_explorer` → `explorer.exe /select,<路径>` |
| 复制路径 | 路径文本进剪贴板（给只收文本的聊天框） |
| 复制文件 | 新壳命令 `copy_file` → 文件本体进剪贴板，可直接粘贴 |

网址链接不动（浏览器那套对网址是有用的）。在浏览器里打开 Seven Station 时只显示「打开 / 复制路径」，
因为后两项要靠壳（剪贴板属于当前登录会话，Core 在 Session 0 里碰不到用户的剪贴板）。

**两个坑（都是这台 Windows 上的）**：

- `fs::canonicalize` 会给路径加 `\\?\` 前缀，带这个前缀进剪贴板别人读不了；落盘前必须用 `plain_path()` 去掉
  （UNC 的 `\\?\UNC\` 还原成 `\\`）。
- 子进程用 `Command::status()`（继承 stdio）调 PowerShell 会卡到超时、返回非零；换成 `.output()` 秒回。
  顺带的好处：失败时能把 stderr 带出来。

**验证**：

- jsdom：`scripts/ui-tests/path-context-menu.test.js` 14 条 —— 右键被拦下、菜单项随环境变化、
  `copy_file` / `reveal_in_explorer` 的调用参数、点别处与 Esc 收起、网址链接保留默认菜单。
- Rust：`cargo test` 3 条（复制成功、不存在的路径报错、`reveal_in_explorer` 报错）。
- 手工：同样的 PowerShell 脚本单独跑一次，剪贴板里能读到文件（`Get-Clipboard -Format FileDropList`）。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`d5e05144548db97b…`）、
`dist/SevenStation-win-x64-0.4.1.msi`（`8ae6009b6bf89d1b…`）——这次两端都动了，客户端也要重装。

## STATUS-070：给 Pi 注入「Windows 常见坑」（2026-11-22，未发版）

用户要求：把 Windows 上最常见、最关键的盲区提前注入给 Pi，别总结太多，要最普遍的那种（比如路径拼接）。

素材来自 `E:/Dev/AgentHistory`（machine/AGENTS.md 的跨机器规则、workspace 流水、本项目归档），挑出反复出现、
代价最大的八条写进 `Agents/pi-guidance.md` 的「Windows 上容易踩的坑」：

1. 反斜杠别经过两层转义：heredoc 喂 python 时双反斜杠会折叠成单个，`\t`／`\n`／`\U` 直接变控制字符，
   路径写坏了 `git diff` 还看不出来；必须内联时用 `chr(92)` 拼。
2. 路径一律绝对、拼接用 `Join-Path`／`Path.Combine`，带空格加引号，别假设 `/tmp` 之类一定存在。
3. 停进程只按 PID，绝不 `taskkill /IM`（按镜像名会连带杀掉用户正在用的进程，本机栽过两次）。
4. `Start-Process` 不能把 stdout 与 stderr 重定向到同一个文件。
5. 控制台是 GBK；脚本写 UTF-8，给 PowerShell 5.1 的 `.ps1` 要带 BOM。
6. 别改换行（CRLF/LF 混用会让 diff 爆成整篇差异）。
7. 改 HKLM、建计划任务、动服务要管理员，要提权就说清楚。
8. 删文件／目录失败多为句柄未放开，先找占用进程。

**验证**：让带注入的 Pi 往文件里写一行带盘符的绝对路径并自己打印十六进制——落盘是
`45 3a 5c 44 65 76 5c …`，三个反斜杠都是单个 `5c`，没有控制字符（19 秒）。

顺便记一笔：写这份 STATUS 时我自己又踩了第 1 条（python heredoc 里的反斜杠被折叠），改用 edit 工具落下才对得上。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`ea53da8b6518414f…`）。

## STATUS-069：让 Pi 用中文思考 / 回答（外加一个并行调用的真 bug）（2026-11-22，未发版）

用户要 Pi 在思考、过程说明、回答里都用中文，方式跟以前一样走 `--append-system-prompt` 注入
（`Agents/pi-guidance.md` 增加「说什么语言」一节）：思考也用中文；命令、代码、路径、标识符、日志与报错原文照抄；
代码注释与提交信息按仓库习惯写中文。

**实测（同一道题跑两次，一次带注入一次不带）**

| | 带注入（中文思考） | 不带（英文思考） |
| --- | --- | --- |
| 最终回答语言 | 中文 | **中文**（Pi 本来就跟着用户的语言走） |
| 思考 | 22095 字，33% 汉字 | 20672 字，2% 汉字 |
| 输出 tokens | 13477 | 7190 |
| 墙钟 | 140 秒 | 84 秒 |

复杂任务上中文思考约 2 倍输出 tokens、更慢；但那一次它还自己写了 jsdom 探针验证（cacheRead 522k vs 241k），
所以差距不全来自语言。简单任务反过来省：中文 105 tokens / 英文 151 tokens（中文更密）。
**结论：最终回答本来就会是中文，注入真正改变的是思考语言；质量没掉（两次都找到了同一个 bug，中文那次还验证了一遍）。**

**顺带修掉它找出来的真 bug**：`updateLiveTurn()` 行数不变时只刷新最后一行，所以一段里并行发几个工具、
先完成的那条不是最后一行时，它会一直显示「进行中」（转圈），直到下一次整轮重画。现在每一行都同步一遍。
`scripts/ui-tests/work-detail-keep.test.js` 加了回归：并行两条里先完成的那条（合并成 `×2` 的那行）不再转圈。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`b22f8f805e008ae0…`）。

## STATUS-068：工作中展开的详情被自动收起 + 上下抖动（2026-11-22，未发版）

用户一边看展开着的步骤详情，一边等新步骤，发现：**新步骤一来，展开的详情就自己收起来了**，
而且画面上下抖。

**两个原因都在「整轮重画」上**：

1. 新步骤进来时，`updateLiveTurn()` 一看行数变了就 `body.innerHTML = ''` 整组重画；
   加上任何一条能让 `patchItem()` 落到兜底的话还会整轮重画——展开的详情节点就此消失。
   详情本来只存在 DOM 里（`openStep` 握着节点引用），节点没了就等于「自动收起」。
   现在改成**只增就往后追加**，前面的行连同展开的详情一个都不动；真要重画（行数变少、
   或者整轮重画）就把展开的那一条按「段键 + 步骤 id」找回来重新挂上（`restoreOpenDetail()`）。
2. `renderThread()` 默认 `scrollToBottom(true)`：同一会话里一有事件就把人拽到底部，
   配合详情收起-展开那一跳，就是上下的抖。现在**只有原来就贴底才跟随**，换会话才强制到底
   （`app.renderedKey` 记着上次画的是哪个会话）。

**验证**：jsdom 新增 `scripts/ui-tests/work-detail-keep.test.js`——新步骤进来后原来那一行的节点没被重建、
详情仍然展开且内容不变、行数是追加的；整轮重画后详情仍在；没贴底时重画 `scrollTop` 保持 0。
10 条断言全过。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`bca29046ec500ffc…`）。

## STATUS-067：设置里按区域调字号（2026-11-22，未发版）

用户反馈过程区字偏小，要能自己调，而且**改字号不能夹字、漏字、截字**。

**做法**：`styles.css` 里 146 处 `font-size` 全部改写成 `calc(原值 * var(--fs-区域))`，
区域只分三个：`body`（对话正文与正文里的代码）、`work`（过程区步骤与详情）、`ui`（侧栏、输入框、设置页及其余面板）。
`appearance.js` 按设置把三个倍率写到 `<html>` 上（0.9 / 1 / 1.12 / 1.24），跟主题一起存 localStorage，
在 `<head>` 里同步应用，不会先闪一下标准字号。

设置页新增「字体大小」卡片：三行（对话正文 / 过程区 / 界面）× 四档（小 / 标准 / 大 / 特大），只影响这台设备的显示。

**不夹字的处理**：

- `.kv-row` 的标签原来写死 92px，放大后「Seven Station Core」被挤成两行；改成 `min-width: 92px` + 不换行，
  值那一列不再用省略号截断，放不下就折行。
- 卡片里的说明行与下面的内容之间补了间距。

**验证**：无头 Edge 在四档下各跑一遍，逐个查 `overflow: hidden` 且内容超出容器的元素——除会话名与
长路径这两处「本来就该省略、且带 title」的之外没有命中；对话（含展开的详情）、设置页、技能页在 特大 下截图核对正常。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`cd5c212a0c191b93…`）。

## STATUS-066：过程区四个滚动条（2026-11-22，未发版）

展开一条详情后，右侧挤着四个滚动条：对话、过程区、详情卡片、详情里的输出块各滚各的，
滚轮到底在滚哪个不知道。

**改法**：详情与输出块都不再自己滚，过程区里只留 `.work-body` 一个滚动框（对话本身一个）。
详情顺着内容长，超出就在过程区里滚；输出再长也不额外开框。

**验证**：无头 Edge 里展开一条 120 行输出的详情，数页面里纵向能滚的容器，
展开前 0 个、展开后只剩 `work-body` 一个。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`851b9f00fe0538ee…`）。

## STATUS-065：空白思考也占一行（2026-11-22，未发版）

用户点开最近一轮的「思考」行，详情是空的。

查生产库确认：那一轮里有一条 thinking 块的正文是**一个空格**（`thinking: " "`，模型自己给的就是空白）。
数据没丢，界面也就老老实实画了一行「思考」，点开自然什么都没有，还平白多算一步。

修法：`turnParts()` 里跳过 `trim()` 之后为空的 thinking 块，不画、不计数。
历史与正在跑的都用同一个判断，`thinking_start` 一开一关不会闪出一行空步骤。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`5eddc8ef40e8d9cf…`）。

## STATUS-064：过程区按回答分段 + 详情回到就地展开 + 草稿按会话隔离（2026-11-22，未发版）

用户在一张单子上提了四件事，这轮一起做完：回答后另起一段工作、详情回到就地展开、草稿按会话隔离、
流式更新不再整轮重画。

**一、回答之后的工作不该并回回答前那一段**

以前一轮里所有工作步骤并成一块，摆在所有正文前面。于是一轮里出现「工作 → 回答 → 又工作」时，
后面的步骤被塞进回答之前那一块，用户分不清哪些在回答前、哪些在回答后；回答多次更明显。

现在 `turnParts()` 按出现顺序返回 `segments`：工作段、正文段交替，**正文一出现就把前面的工作段封口**，
后面的工具调用开新的一段，排在正文后面。折叠状态和滚动位置按段记（键是 `turnKey#段号`）。

**二、去掉独立的过程查看弹窗**

`.sm-*` 那套（挂 body 上 fixed 的窗口）整个删掉，回到点一行就地展开（`.st-more`）：
在过程区自己的滚动框里展开，限高 `min(40vh, 300px)` 自己滚，不会把整轮撑变形；Esc 或再点一下收起，同时只开一条。

**三、跨会话草稿误发**

在 A 里打了一段话没发，切到 B 直接回车，那段话就发到 B 去了。现在 `app.drafts` 按会话存草稿，
切会话换一份；发出去就销掉。还没有会话时打的字会在会话建好时认领成它的草稿。

**四、顺带修掉整轮重建**

正在跑的一轮里，每来一条事件原来会整轮重画。现在：正文在长只换最后一个 `.md` 的内容；
步骤在长只改那一行（摘要、条数、状态）；步骤数变了只重画这一段的身子；只有结构真变了（比如回答后又有新工作）才整轮重画。

**验证**：jsdom 两个脚本（`scripts/ui-tests/turn-segments.test.js`、`session-drafts.test.js`）20 + 6 条断言全过；
临时 home 里塞了一段「工作 → 回答 → 工作 → 回答」的历史，用无头 Edge 截图确认两个工作段分列在两条正文之间，
点行就地展开正常。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`2f0134473f4a7efc…`）。

## STATUS-063：首次打开显示没连上 —— 任务排期要十秒（2026-11-22，未发版）

症状：装完第一次打开 Control 显示「没连上」，重启之后打开就是「已连上」。

**原因**：`schtasks /run` 只是把请求交给计划任务服务，真正拉起来要几秒到十几秒
（日志里对过：20:52:46 注册并 `/run`，代理 20:52:56 才起，20:53:08 才连上）。
界面那会儿只显示「没连上」，看着就像坏了；重启那次能连上，是因为登录触发早就把代理起好了。

**改法**：

- 界面在「刚叫过它起来」的 45 秒内显示 **正在启动…**，不再直接报没连上；没连上时 2 秒一问，连上后 5 秒。
- 除了计划任务，**再写一份 HKCU 的 Run 键**：登录那一瞬间 Run 键比计划任务快（任务要排期）。
  两个都起也没关系，第二个占不到管道会自己退出。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`eb3dc73ed12378ab…`）。

## STATUS-062：代理被 cmd 窗口带走了 + 状态一直显示没连上（2026-11-22，未发版）

装完 STATUS-061 的包，用户看到：重启和打开 Control 时都会弹一个 cmd 窗口，而且界面一直「没连上」。

**两个真因**：

1. **代理是被那个窗口弄死的**。`SevenStation.Core.exe` 发布出来是**控制台**子系统，计划任务在登录会话里
   拉它，自然弹一个 cmd 窗口；用户一关窗口，进程收到 CTRL_CLOSE，任务结果就是 `0xC000013A`
   （`schtasks /query /v` 里能看到，正好和 runner.log 里十秒一次的重启对上）。
2. **状态接口在骗人**。核心平时是懒连的（真要用 Pi 才连代理），`/api/runner` 只回「现在有没有连接」，
   所以没发过对话时永远是 `connected: false`，界面就一直「没连上」。

**修法**：

- 发布改成 **GUI 子系统**（`<OutputType>WinExe</OutputType>`）：不再有控制台窗口，也就没有 CTRL_CLOSE。
  服务与 runner 都不需要控制台，日志本来就写文件；用 `dotnet dll` 跑时输出照旧（那是 dotnet 宿主自己的控制台）。
- runner 里再补一刀 `FreeConsole()` 兜底。
- 任务 XML 补 `RestartOnFailure`（1 分钟后重试 3 次），真死了不用等下次登录。
- `/api/runner` 改成先主动探一次连接（`RunnerClient.Probe()`），状态页才反映真实情况。

**验证**：

- 发布出来的 `SevenStation.Core.exe` PE 子系统 = 2（GUI）。
- 沙箱里没发过任何对话，直接查 `/api/runner` 就回 `connected: true`。
- 沙箱链路照旧：`✓ 代理链路通了，Pi 回了：收到`；`cargo test --release` 9 个全过。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`83ff3ec66750c298…`）。

## STATUS-061：Control 与 Core 启动就要管理员（2026-11-22，未发版）

用户定：这两个东西**打开就要 UAC，不给权限就不启动**——反正开关、防火墙、服务状态全要管理员，
每次都确认一遍太烦。据此调整：

- **Seven Station Control**：`main()` 里先看权限，没有就以管理员身份重开自己然后退出；用户点「否」就到此为止。
- **Seven Station Core**：不是服务、不在沙箱里、也没有 `--elevated` 标记，就同样重开自己。
- **`--elevated` 标记**：重开时带上它，那份不再要求权限。判定权限的代码万一有毛病，也不会变成无限弹 UAC。
- **放行**：`SEVENSTATION_PROFILE=test`、`SEVENSTATION_CORE_HOME`、`SEVENSTATION_DATA_DIR` 都不拦，否则开发寸步难行。
- 启动日志里多了一句「管理员权限 True/False」，出问题先看它。

**执行代理反而不许提权**：任务 XML 里是 `InteractiveToken` + `LeastPrivilege`，代理拿到普通令牌，
Pi 也就不会继承管理员身份——不然刚统一好的「跟终端里用 pi 一样」又没了。

于是执行代理回到计划任务方案（STATUS-059）：STATUS-060 换 Run 键只是因为非提权建不了带 Principal 的任务；
现在 Control 提权了，任务建得出来，`schtasks /run` 起的又是普通权限进程，正好。

**验证**：`cargo test --release` 9 个全过（含任务 XML 必须 `LeastPrivilege`、必须 `PT0S`）；
沙箱起核心 + 代理 + 真发一句话，`✓ 代理链路通了，Pi 回了：收到`；发布出来的 dll 里确认有新代码。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`5181481b6aa45a2f…`）。

**注意**：Control 每次启动都会要一次管理员（已经开着一个时再点，UAC 过后会并进已有窗口）。

## STATUS-060：计划任务建不起来，改成 Run 键；重启走壳命令（2026-11-22，未发版）

用户装了 STATUS-059 的包，Control 反复重开都显示「执行代理：未注册」。查 Control 的日志：

```
执行代理没挂上：建不了执行代理的登录任务：错误: 拒绝访问。
```

**原因**：`schtasks /create /xml` 里那份 XML 带 `<Principals>`。非提权进程建这种任务会被计划任务
拒绝（我这边用 SYSTEM 测所以一路通过，正好把这条路试漏了）。

**改法**：不再用计划任务，改用 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`：

- Control 每次启动把 `"<exe>" --runner` 写进 Run 键（写自己家的键，不需要管理员也没限制），
  然后直接 spawn 一个代理。已经在跑时新起的那个会因为占不到管道自己退出，所以随手调是安全的。
- 计划任务那套「跑满三天被收掉」的毛病也跟着没了。
- 「重启」改成壳命令 `runner_restart`：`build.rs` 的 `AppManifest` 与 `capabilities/control.json`
  两处都登记了（这次没漏）。它按命令行里的 `--runner` 认人再杀——服务用的是同一个 exe 名，
  只按进程名会把用户正在用的服务一起带走。
- 核心的 `/api/runner` 收窄成 `{ connected, pipe, log }`，`/api/runner/restart` 与 `RunnerTask.cs` 删掉，
  安装包里那条 `schtasks /delete` 的卸载动作也撤了。

**验证**：

- 起一个 `--runner` 的 `SevenStation.Core.exe` 和一个不带参数的（同一个副本），跑 Control 里那条杀进程脚本：
  只有 `--runner` 那个被杀，另一个和**用户正在跑的生产服务**都还在（生产那个还回了「拒绝访问」，说明没碰到）。
- Run 键写入/读回格式对（`"<exe>" --runner`）。
- `cargo test --release` 7 个测试全过。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`d51120f4e9ea7e38…`）。

**遗留**：卸载后 Run 键还留着（指向不存在的 exe，Windows 会静默跳过）。要清得在卸载时按用户清 HKCU，
先记着不做。

## STATUS-059：执行代理的登录任务 + Control 里的状态与重启（2026-11-22，未发版）

STATUS-058 那三条现在都做完了，可以装。

**登录自启**：Seven Station Control 每次启动都会建一遍计划任务「SevenStation Core Runner」
（`schtasks /create /xml ... /f`，任务 XML 里是 `InteractiveToken` + 登录触发 + `ExecutionTimeLimit=PT0S`），
建完顺手 `/run`，所以装好第一次打开 Control 就生效，不用注销重登。换成 exe 路径变了的老任务也没关系，
每次都带 `/f` 重建。卸载时 MSI 自己把任务删掉（`WixQuietExec` 里调 `schtasks /delete`）。

任务必须由用户这边建：服务账户建不了「跟着某个用户登录跑」的任务。核心只负责查询状态和叫人重启。

**状态与重启**：

- 核心新接口 `GET /api/runner` → `{ connected, pipe, task, registered, account, log }`；
  `POST /api/runner/restart` → `schtasks /run`，任务没注册时回 409 并说明去哪打开。
- Control 的连接卡片多一行「执行代理」：`已连上` / `没连上` / `未注册`，下面配一句为什么，
  右边一个「重启」按钮（走已有的 `core_api`，没新增壳命令，省掉一次 ACL 登记）。

**验证**：

- 计划任务那套 XML 用真实 `schtasks /create|query|run|delete` 跑过一遍（rc 全 0，登录状态是「交互式」）。
- 沙箱核心（临时 home、8958 端口）：没连上时 `connected:false`，真发一句话后变 `true`；
  不带令牌 401；任务没注册时 `restart` 回 409 和那句提示。
- `cargo test --release` 9 个测试全过（新加 3 个锁任务 XML：必须带 `--runner`、必须 `InteractiveToken`、
  必须 `PT0S`、XML 特殊字符要转义、XML 文件要 UTF-16 带 BOM）。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`d6b3073a52f685ce…`）。

**还没验的**：普通（非管理员）用户建自己的登录任务这条路，以及装完之后「客户端里调工具是否跟终端一致」。
这两条只有用户那边能验。

## STATUS-058：Pi 改由用户登录会话里的执行代理来起（2026-11-22，未发版）

**为什么改**：服务跑在 Session 0 / SYSTEM，Pi 作为它的子进程也一样。用户实测在客户端里调工具
比在终端里用 Pi 慢很多、也费 token（npm/node 找不到、凭据不对、生成的文件 owner 变成 SYSTEM），
起 GUI 程序还看不见窗口。根因不是缺几个环境变量，是进程站错了会话。
用户拍板：底层要跟「用户在终端里用 Pi」完全一致；Windows 只是过渡，后面主目标是 Linux，
「没登录 / 注销就不能用」是能接受的结果。

**做法**：同一个 exe 两个角色。

- `SevenStation.Core.exe`（服务，SYSTEM）：对话库、WebSocket、托管页面，**不再直接起 Pi**。
- `SevenStation.Core.exe --runner`（登录后自启，用户会话）：只做一件事——按核心给的 exe/参数/cwd
  起进程，把 stdin/stdout/stderr 转回去。Pi 怎么用、说什么话仍然全在核心这边（Agent 边界不变）。
- 两者之间一条命名管道（`\\.\pipe\sevenstation-runner`，`SEVENSTATION_RUNNER_PIPE` 可改），
  上面跑按行 JSON、按会话 id 分帧：`start` / `line` / `eof` / `kill` ←→ `started` / `out` / `err` / `exit` / `failed`。

**判定**：`Process.GetCurrentProcess().SessionId == 0`（或账户名是 SYSTEM）就必须走代理；
连不上就明确报错（「Pi 需要在已登录的桌面会话里运行……」），**不回落成 SYSTEM 起 Pi**——
回落等于把这次要修的问题悄悄装回去。

**代码**：

- 新 `Rpc/IPiTransport.cs`、`Rpc/ProcessTransport.cs`、`Rpc/PiCommand.cs`、`Rpc/PiHost.cs`、
  `Rpc/RunnerClient.cs`（客户端 + `RunnerTransport` + 按行读写的桥）、`Runner/RunnerHost.cs`（`--runner` 那半边）。
- `Rpc/PiSession.cs` 换成吃 `IPiTransport`，其余 RPC 逻辑没动。
- 去掉 Pi 子进程的 `USERPROFILE`/`HOME` 覆盖：那套是给 Session 0 打的补丁，现在两边环境本来就对，
  再覆盖反而会把配置指错（实测指到了 systemprofile，Pi 报 `No API key found`）。
- `CoreSettings`：`PI_AGENT_DIR` 指到某个用户目录时，`Home` 以前一律写成进程自己的家（服务下就是
  systemprofile），改成从 `<家>\.pi\agent` 反推；另外把已经写错的 systemprofile 一并纠正。

**坑（血的）**：命名管道同步句柄上，挂着的阻塞读会把同一句柄上的写一起卡住——核心连上代理后
`WriteLine` 直接死等，看着像「代理没收到」。两端都必须 `PipeOptions.Asynchronous`。

**验证**：`node scripts/runner-smoke.mjs --port <非8787> --home <临时home> --cwd <目录>`
（临时 home、临时管道名，Pi 用 `magpie/auto/deepseek-v4.1-flash`）。

- 有代理：`✓ 代理链路通了，Pi 回了：收到`，代理日志里有 `起进程 …`。
- 没有代理：界面报「Pi 需要在已登录的桌面会话里运行……」，不回落。

**还没做（不做完这个功能不能发版）**：

1. 代理的登录自启（计划任务，当前用户、无需管理员）与卸载清理。
2. Seven Station Control 显示代理状态、能给个「重启代理」。
3. 安装包里带上这两件事——否则装上新版本的机器根本起不了 Pi。

## STATUS-057：core_api 真的连不上 —— 请求头被写成了裸 LF（2026-11-20，未发版）

补完 ACL 之后还是不行，弹窗报「Seven Station Core 回了一段看不懂的响应」。

**根因**：`core_api` 里手写的 HTTP 请求，`

` 在生成代码时被写成了**真正的换行**（字符串字面量里是裸 LF）。
于是请求头全是坏的：请求行后面直接空行，Kestrel 当成「没有 Host 头的 HTTP/1.1」回 400，
而解析那头找的又是四个换行连在一起，永远找不到 → 报「看不懂的响应」。

**修法**：

- 拼请求单独抽成 `build_request()`，用一个地方写 CRLF；`core_api` 只调它。
- 解析改成 `split_headers()`：先认 `CRLFCRLF`，退化再认 `LFLF`；`dechunk()` 同样先认 CRLF 再认 LF。
- 补 6 个单元测试锁住这些（`cargo test --release`）：请求行/头必须带 CRLF、头后要有空行、去 CRLF 后不能有裸 LF、
  chunked 单块与多块拼接。

**顺带**（用户提的）：出错时那句「读不到设备列表，先确认 Seven Station Core 在运行」是废话 ——
服务在不在运行看主界面状态卡就知道。改成直接摆原因：「读不到设备列表：<错误原文>」，顶部那行只写「读不到」。

验证：raw socket 打沙箱 Core（临时 home，只按 PID 停）确认响应是 `HTTP/1.1 200` + CRLFCRLF，
`/api/devices`、`/api/addresses`、`POST /api/devices` 都是 chunked，`/api/qr` 带 Content-Length；
两种正文都能被新解析拿到。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`5ac2cc3a65de9409…`）。

## STATUS-056：弹窗里「思考」不换行、Control 的 core_api 被 ACL 拦住（2026-11-20，未发版）

装完 STATUS-055 之后用户报两条：

1. **弹窗里的思考文字不换行**，一行被截在右边，还多出一条横向滚动条。
   原因：`renderStepModal()` 给思考那块用的 class 是 `.sm-code`，但样式表里只写了 `.sm-body .st-code`，
   `.sm-code` 没定义 → `<pre>` 用浏览器默认的 `white-space: pre`。
   修法：补 `.sm-code`（正文衬线换成界面字体、`white-space: pre-wrap`、`word-break: break-word`、最高 320px 自己滚）。
2. **添加设备整块不能用**，弹窗里写「读不到设备列表」，页面右下角报 `Command core_api not allowed by ACL`。
   原因：加 `core_api` 时只写了 `generate_handler!`，忘了登记 **`build.rs` 的 `AppManifest`** 与
   **`capabilities/control.json`** 的 `allow-core-api`。Tauri 2 的自定义命令要两处都登记，缺一个就在运行时被 ACL 拒掉。
   修法：两处补上；`cargo build` 后 `permissions/autogenerated/core_api.toml` 自动生成，
   `gen/schemas/capabilities.json` 里也出现了 `allow-core-api`（确认编译进去的是新能力表）。

顺带：设备列表、地址下拉、二维码生成都走同一个 `core_api`，所以这一处一漏整块功能都点不动 —— 以后新增壳命令先改这两处。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`37cf01d73029f15f…`，Control 在 Core 包里）。

## STATUS-055：过程区改成「点击看弹窗 + 自己滚动跟随」（2026-11-20，未发版）

用户定了原型 `work/proto-worklog.html` 的方案，一次改三件：

1. **点一行不再就地展开**，改成弹窗（`.sm-scrim` / `.sm-dlg`）：
   标题是步骤种类 + 时间，下面一行状态与用时、工作目录；正文沿用 `appendSections()` 摆命令、输出、改动；
   合并起来的那一组用 `.sm-tag` 逐条分隔。Esc 关闭，← → 翻上一条/下一条，底部也有按钮。
   弹窗挂在 `body` 上 fixed（跟文件面板一样），不受输入区裁剪影响。
2. **过程区自己滚动**：`.work-body` 限高 `min(48vh, 340px)`，`scrollbar-gutter: stable`。
   贴着底（`nearBottom()`，24 px）才跟随新步骤；用户往上翻就冻在原地，顶部渐变提示上面还有内容。
3. **不在底部时浮出「回到最新（n 条）」**：条数是翻上去之后新出现的步数，点一下回到底部并清零。

配套清理：删掉 `closeOpenItems()`、`.st-body`、`.st-group-body`、`.st-time`、`timeText()`、
`session.ui` 的 `groups`/`steps`；`uiOf()` 只剩 `work`。行尾悬停露出「详情」，让「能点」看得见。

验证（jsdom 里加载真页面 + 假会话）：

| 项 | 结果 |
| --- | --- |
| 过程区结构 | `.work-body` / `.work-latest` 都在，按钮默认隐藏 |
| 就地展开残留 | `.st-body` 0 个 |
| 点一行 | 弹窗出现，标题「思考」，状态「完成·用时 300 毫秒」 |
| 下一条 | 标题变「执行命令 ×3」，组内 3 个分隔标记 |
| Esc | 弹窗关闭 |
| 就地更新 | 内容没变时转圈节点**原样保留**；跑完变 ✓ 且转圈消失 |
| 收起 | 点标题后 `.work-scroll` 跟着隐藏 |

滚动跟随依赖真实布局，jsdom 没有布局，只能靠结构和入口验；真机上看一眼。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`74f17275e22d87dc…`）。

## STATUS-054：步骤上的转圈会「卡住」（2026-11-20，未发版）

用户报：最新一步的转圈动画时不时卡住。不是后端的事，也不是 CSS：**动画被重画重置了**。

原因两条，都落在过程区的增量更新上：

1. `updateLiveRow()` 每来一条事件就 `state.replaceWith(stepStateNode(entry))` —— 状态节点整个换新的，
   `.spin` 上的 `animation` 从 0° 重新开始。事件密的时候永远停在 0° 附近，看着就是不动。
2. 更狠的一条：`patchItem()` 在「这一轮开始出正文」或「换了一步」时会整轮重画，同样把动画打回原点。

改法：

- `sameState()`：状态节点内容（class / title / 文字 / 有没有在转）没变就不替换，留着老节点让它继续转。
- `spinPhase(900)`：新建转圈节点时算 `animation-delay: -<performance.now() % 900>ms`，
  把相位钉到墙上时钟。哪怕整轮被重画，新节点的角度也刚好接上，看起来是连续在转。
  侧栏的 `.session-spin` 同样处理。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`c7a3d71f81de3de5…`）。

## STATUS-053：对话框里冒出空灰条、空地址框（2026-11-20）

装完新版打开「添加设备」看到的两个毛病，同一个根因：**元素自己写了 `display: flex`，把 `[hidden]` 盖掉了**。

- 顶部那条空灰条 = `#deviceSummaryRow`（`.summary` 是 flex），本该在生成前隐藏。
- 空的地址下拉 = `#deviceAddressRow`（`.field-row` 是 flex），局域网没开时本该隐藏。

修法：样式里加全局兜底 `[hidden] { display: none !important; }`（这坑 AGENTS 里早写过，Control 这边漏了）。
顺手：Core 没起来时「已配对的设备」下面不再是空白，改成一行为「读不到设备列表，先确认 Seven Station Core 在运行。」

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`01d1b0a2d71e3029…`）。

## STATUS-052：dist 只留当前版本的包（2026-11-20）

用户嫌安装时挑不清哪个是最新包。清掉 `dist/` 里的 0.4.0 三件套（msi、sha256、wixpdb），
并在两个打包脚本里加了一步：打包前把 `dist/` 里**版本号不是当前版本**的 `*-win-x64-*.msi*` 与 `.wixpdb` 删掉。
顺手补上 `wixpdb` 的覆盖删除（原来只删了 msi 与 sha256）。

验证：故意塞回 `SevenStationCore-win-x64-0.4.0.msi` 与 `SevenStation-win-x64-0.4.0.msi.sha256`，
跑一次 `build-installer-center.ps1`，两个假文件都被清掉，`dist/` 只剩 0.4.1。

## STATUS-051：点路径直接打开文件（2026-11-20，未发版）

用户要求的：路径点到文件就直接打开那个文件，别再开资源管理器把它选中。

- 桌面壳 `reveal_path`：`explorer.exe <路径>` 一句话搞定两种——目录开文件夹，文件用关联程序打开
  （原来文件走 `/select,`，只是选中）。先 `fs::metadata` 确认存在，不存在就直接报「找不到这个路径」，
  不让 explorer 自己弹框。
- Core 的兜底 `RevealPath()` 同步：`ArgumentList.Add(path)`，并删掉没用的 `isDirectory`。
- 前端链接悬停提示从「在资源管理器里打开」改成「打开这个路径」。
- 给 Pi 的说明也改口径：点路径直接打开（目录开文件夹、文件用默认程序），所以给路径要给到具体文件，
  别只给目录让人自己找。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`8bfe546e3fb561f0…`）、
`dist/SevenStation-win-x64-0.4.1.msi`（`91da2b0c3353a499…`）。

## STATUS-050：给 Pi 的界面说明补上「你在 Seven Station 里」（2026-11-20，未发版）

用户提的：Pi 一直以为自己在跟终端里的人对话，答话方式还是终端味。它确实不知道自己在 Seven Station 里跑。

机制本来就有：`PiSession` 启动 Pi 时用 `--append-system-prompt` 把 `Agents/pi-guidance.md` 塞进系统提示
（原来只写了「路径和网址怎么写才可点」）。这次把内容扩成三节：

- **你在哪儿、和谁说话**：Pi 是 Seven Station Core 的子进程；用户在看客户端（桌面/手机/浏览器），
  可能同时开两个客户端看同一个线程；工具调用只显示成一行步骤、输出默认折叠，所以结论要写进正文；
  没有 PTY，全屏程序、方向键、交互确认都无意义；别假设用户有键盘和大屏。
- **干活的样子**：每个命令要有明确目的（步骤摘要就是用户唯一线索），一次推进一件说得清的事。
  2026-11-20 补两条：用户可以直接贴图片/截图（当作消息里的图片给你看，不用让他再描述）；
  用户会随时插话——跑着的时候还能发消息，Core 排队等这一轮结束再交给你，也可能直接点停止打断你。
- **可点的地址与路径**：先分清「给用户照着去用的」还是「说明里提一下」——要用的（网站、服务地址、端口、目录、文件）
  一律写完整（带协议头、带端口、带盘符），客户端才认得出、才能变链接；纯说明/举例的不用刻意补全，
  但也别让半截地址看起来像要点的目标。同一个目标只写一次完整写法。

验证：本机直接起一次 Pi（`--mode rpc --append-system-prompt <新文件>`，1150 字 36 行），`get_state` 正常回
`auto/deepseek-v4.1-flash`，说明多行参数没问题。探测用的子进程按 PID 停掉，没动正式服务里的会话。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi` 43.8 MB（`8b0f84568778e89d…`）。
新说明在**下一个新起的 Pi 子进程**里生效：重开对话、重启 Core、或子进程退出后再发消息都会重起子进程；
正在跑的这一轮仍是旧说明（说明是同一次子进程启动的参数，改不了已经在跑的）。

## STATUS-049：单设备令牌 + 扫码配对 + 网页版填令牌（2026-11-20，未发版）

按 Android 规划的落地顺序先做前两步（Core 侧 API、Control 的「添加设备」），顺带把网页版的令牌入口补上。

**Core**

- 新表 `devices`（`Storage/DeviceStore.cs`）：id / 名字 / 令牌 / 创建时间 / 最后在线 / 作废时间。
- 鉴权规则：`/ws` 接受**主令牌**或**任一未作废的设备令牌**；管理接口只认主令牌（设备令牌不能给自己再发一个）。
- 新接口（都要主令牌）：
  - `GET /api/addresses` —— 本机私网地址（10/8、172.16/12、192.168/16），带网卡名；
  - `GET /api/devices`、`POST /api/devices`（`{name}`）、`POST /api/devices/{id}/revoke`；
  - `GET /api/qr?data=…` —— 返回 **SVG** 二维码（QRCoder 1.6.0）。用 SVG 是为了 Control 那边不用处理二进制。
- `TokenStore` 拆出 `Provided(context)`，`Matches()` 复用。

**网页版**

- 令牌来源：地址栏 `?token=` → `localStorage`。带 `?token=` 打开时存下来并把它从地址栏抹掉（`history.replaceState`），
  免得留在浏览记录里。
- 设置页新增「访问令牌」卡片（浏览器里也有）：显示当前前 8 位、粘贴保存并重连、清除。
- 没令牌时不再装作在连：状态栏写「还没有访问令牌：去「设置」里填一个」，并自动切到设置页。
- 设置里的「访问」一行改成 本机 / 局域网，不再是写死的「只本机能连」。

**Control**

- 新增 Rust 命令 `core_api(method, path, body)`：走回环裸 HTTP + `Authorization: Bearer <token.txt>`，
  自己处理 `chunked` 兜底，不引 HTTP 客户端依赖。
- 连接卡片加一行「设备」（显示几台已配对）+ 添加设备对话框：
  名字 → 生成 → 选地址（`/api/addresses`）→ 显示可复制的地址与令牌、二维码（SVG 直接塞进 DOM）；
  下面列已配对设备，可**移除**（点了先确认一次，因为移除后那台设备要重新扫码）。
  2026-11-20 用户评这一版「不好看」，改成字段式表单（标签在上、输入框整宽）、× 关闭、
  生成后结果区在表单下面展开、设备列表带空状态与台数；顺带修好日志卡片溢出到页脚外面的问题。
  文案：不用「作废」（票据味），统一「移除」；原型里那个单独一个「改」字也删了。
  用户选定原型 **A · 生成后**（`work/proto-device.html`），据此把应用里的流程对齐：
  生成成功后表单收成一行摘要「手机 · 192.168.1.5:8787」，下面展开二维码与地址/令牌，
  主按钮由「生成令牌」换成「完成」（点它关闭并复位，下次打开又是干净的表单）。

**验证**（沙箱 Core，临时 home，只按 PID 停自己起的进程）

| 项 | 结果 |
| --- | --- |
| `/api/addresses` | 6 个私网地址（含 EasyTier 的 10.77.x、Hyper-V 的 192.168.x） |
| 创建设备 | 48 位令牌，列表只回 `8327a021…` 前缀 |
| `/api/qr` | 200，`image/svg+xml`，`:``<svg …` 开头 |
| 设备令牌连 `/ws` | ok；乱令牌 401；设备令牌调管理接口 401 |
| 移除后 | 设备令牌 401，主令牌仍然可用 |
| `/?token=<设备令牌>` | 200，页面正常 |

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（含 Control，最新 `e52e2fba…`）、`dist/SevenStation-win-x64-0.4.1.msi`（`79b55779…`）。

下一步：Android 阶段 0（Gradle 工程 + 扫码/手输 + WebView）。

## STATUS-048：过程区重排 + 展开状态不再回弹（2026-11-20，未发版）

用户报两件事：展开一条 bash 会看到两条（行头重复）；整个过程区读/写/改混在一起看着乱。原型 `work/proto-steps.html` 定稿后落地。

- **行头只画一次**：`toolCard()` 里那份 `.tool-head` 删掉，改成 `appendSections()` 只摆内容（命令 / 输出 / 改了哪几行）。
- **一行一步**：新增 `STEP_KINDS` / `STEP_ICONS`（终端、读、写、改、搜索、网页、清单、思考、兜底），
  左边图标 + 中文动词，中间一句摘要（路径只留尾巴、命令压一行），右边只有一个记号：`✓` / 转圈 / `!` / `—`；
  「完成」两个字和每行的耗时都去掉了，耗时只在展开那一步时露出。
- **同类合并**：连续同类工具折成「执行命令 ×3」，点开摊成子行，每条子行自己还能再展开。
- **手风琴**：同一块里只留一个开着的（`closeOpenItems()`）。
- **展开状态存进会话**：`session.ui = { work: Map, groups: Set, steps: Set }`；`workGroup()` 建节点时按它恢复，
  点击时回写；`onSessionState()` 重建会话时把 `previous.ui` 带过来，断线重连/重新拉状态都不回弹。
- **就地更新不再整轮重画**：`updateLiveTurn()` 匹配 `data-last-step`，展开着的那一步由 `updateLiveRow()`
  只换详情内容；合并、换种类、换步才退回整轮重画（状态在会话里，重画也还在）。
- 保留了原来「点路径在文件面板打开」的行为，移到新的摘要上；行改成可聚焦，回车/空格也能展开。

验证：把纯逻辑函数从 `app.js` 抠出来在 Node 里跑（`groupWork` / `stepSummaryText` / `stepStateNode` / `stepMeta`）——
3 条连续 bash 合并成 ×3、思考/读/改/搜索各自独立、运行中出转圈、没登记的工具回退原名 + 加号图标、种类映射 6 项全对。
视觉部分要装包后看。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi` 43.7 MB（`3df37cb703bfaf13…`）。

## STATUS-047：深色模式发送键用「深底 + 亮描边」（2026-11-20，未发版）

用户报：深色下发送键的白箭头贴在浅灰底上，几乎看不见（箭头 `#ffffff`、底 `#ecedf0`，对比约 1.1:1）。
根因：`--accent` 在深色主题里是浅色 `#ecedf0`，而 `--on-accent` 只在 `:root` 里定义过 `#ffffff`，深色没覆盖。

给了三版原型（`work/proto-send-dark.html`，浅底深墨 / 深底亮描边 / 中性深灰底），用户选 **B：深底 + 亮描边**。

落地：

- 深色主题加 `--send-ring: #55595f`；`.send-btn.ready/.stop` 在 `[data-theme="dark"]` 下改成
  `background: var(--bubble)`、`color: var(--text)`、`box-shadow: inset 0 0 0 1px var(--send-ring)`。
- 深底上压暗会更看不见，悬停从 `brightness(.92)` 改成 `brightness(1.45)`。
- `.send-stop-mark` 的方块色改成 `currentColor`，深浅主题都不用另配。
- `--on-accent` 在深色下保持 `#14161a`（只剩开关旋钮用它，浅色轨道上要深色旋钮）。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi` 43.7 MB（`c3af9200abb09135…`）。

## STATUS-046：正文里的地址点了不跳浏览器（2026-11-20，已修未发版）

用户报：点地址链接也不会跳浏览器，之前以为只有本地路径不行。

原因：地址是渲染成 `<a target="_blank">` 的。WebView2 里「开新窗口」要走宿主的 `NewWindowRequested`，
Tauri 壳没接这个请求，点了就什么都不发生（指针变手、看着能点，实际是空响）。本地路径没事，是因为
`.link-path` 有自己的点击处理，直接调壳的 `reveal_path`。

改法：

- 壳新增 `open_url` 命令：只认 `http://` / `https://`，用 `explorer.exe <地址>` 起系统浏览器
  （不让页面拿壳当随便起程序的入口）。登记进 `build.rs` 的 `AppManifest` 与 `capabilities/center.json`
  （`allow-open-url`）。
- 前端加 `openUrl()`，并在全局点击处理里拦截 `.md a[href]` / `.msg a[href]`：
  壳里调 `invoke('open_url')`，浏览器里退回 `window.open`，其余（`#`、锚点）不受影响。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`5e3f416288fb5bac…`）、
`dist/SevenStation-win-x64-0.4.1.msi`（`757101a764d1213c…`）。
**两个都要装**：开浏览器的命令在壳里，拦截逻辑在 Core 的页面上。

## STATUS-045：Pi 压缩上下文会抹掉对话历史（2026-11-20，已修未发版）

用户报：客户端里看不到在终端（TUI）里那段对话的记录。

查到的链路（全是只读证据）：

1. Pi 的会话文件有 3 条 `compaction` 记录，最后一条 `2026-11-20T02:49:24Z` = 本地 **10:49:24**。
2. Core 库里这条对话有 221 条消息，**最早一条正好是 10:49**——整段更早的历史没了。
3. 原因：每一轮结束 `PersistTurnAsync()` 拿 `get_messages` 回来，`:``SaveTurn()` 先
   `DELETE FROM messages WHERE conversation_id = $id` 再整段重插。Pi 压缩之后 `get_messages` 只回
   窗口里的消息，于是库里只剩窗口那一段，压缩点以前的全被删掉。`seq` 也跟着从 0 重新编号
   （所以早上看到的是 844，现在是 218）。
   ——顺带说明：**跟客户端还是 TUI 无关**，终端里说的话本来就只进 Pi 的会话文件，
   而库里这份是 Core 的副本；副本又被压缩重写过，所以两头都对不上。

改法（`ConversationStore`）：

- `SaveTurn()` 不再整段替换，改成 `MergeMessages()`：按「角色 + 时间戳 + toolCallId」去重后追加，
  已有的行一条都不动。压缩后 Pi 只回窗口内的消息，重复的跳过、新的接着往后排。
- 万一回来的消息比库里还早（跨了压缩点），按时间戳整段重排一次，顺序不会乱。
- `message_count` 改成写库后的真实条数，不再用 Pi 这次给的数组长度。

验证（临时控制台工程直接引用 Core 跑 `ConversationStore`，跑完删掉）：

| 步骤 | 结果 |
| --- | --- |
| 存 A,B,C | 库里 3 条 |
| 压缩后只回 C,D | 库里 4 条：A,B,C,D（C 去重、D 补上） |
| 再塞一条更早的 F | 库里 5 条：A,B,F,C,D（按时间重排） |
| `message_count` | 5 ✓ |

出包：`dist/SevenStationCore-win-x64-0.4.1.msi` 43.7 MB（`474299a30833acc4…`）。

**丢掉的那段能不能补**：能。Pi 的会话文件里全都有，按同样的去重规则并回库即可（历史时间戳更早，
走重排分支）。用户 2026-11-20 决定：不补，那段不重要。

## STATUS-044：卡住的「运行中」、停止卡 120 秒、重连后不出状态，三处一起修（2026-11-20，未发版）

按 STATUS-043 的结论动手：

- **没跑完的步骤不再假装在跑**：`CenterHub.MarkInterruptedSteps()` 在发 `session_state` 前，
  对「有 `toolCall` 没 `toolResult`」的块补 `interrupted: true`（只在没有在跑的回合上做）。
  前端 `stepRunning()` / `stepStatusText()` 统一判断，被中断的显示「已中断」、灰空心点（`.step-dot.is-aborted`），
  不再一直转「运行中」。卡片状态点也把中断当错误色。
- **重连后重新要一遍状态**：`connect()` 里 socket 打开时，如果正看着某条对话，补发一次
  `open_conversation`；以前只发 `list_conversations`，线程就停在上次断开前的样子。
- **停止不再等 120 秒**：`abort` 单独走 `AbortAsync()`，`SendAsync` 超时 5 秒；
  超时就把子进程收掉、`SetStreaming(false)`、发一条 notice 再补 `session_state`。
  `EnsureLive` 靠 `Session.IsRunning` 判断，收掉之后下次发消息会重新起子进程。
- **关闭有总时限**：`ApplicationStopping` 里 `ShutdownAsync().Wait(10s)`，超时就先退出，不陪 SCM 耗。
- 验证（沙箱 Core，临时 home + 8909 端口，只按 PID 停自己起的进程）：
  往临时库塞「一条有结果、一条没结果」的消息 → `open_conversation` 回来
  `call-done interrupted=false`、`call-open interrupted=true`，`isStreaming=false` ✓。
- 出包：`dist/SevenStationCore-win-x64-0.4.1.msi` 43.7 MB（`c0fbac0de01de2b4…`）。

**踩坑（记进 AGENTS.md）**：测试脚本里 `taskkill /F /IM SevenStation.Core.exe` 按镜像名匹配，
会把用户正在用的正式服务一起杀掉，一小时内栽了两次，用户只好退回终端用 pi。
以后只按 PID 停自己 spawn 的进程。另外 `wix extension add WixToolset.Util.wixext/5.0.2`
**不带 `-g` 会返回 0 但什么都没装**，打包就报 WIX0144。

## STATUS-043：查到「断开后状态自相矛盾 / 停止卡住 / 看着像重连失败」的链路（2026-11-20，只调查未改代码）

用户现象：Core 服务停了 → 手动启动 → 客户端「已连接」但任务状态不明 → 点「停止」一直转 →
关掉客户端重开，线框里还挂着一条「运行中」。

证据（生产日志 + 对话库，只读）：

1. `2026-11-20 10:47:00.750 对话 c-426013b16dfa 起子进程 …` 之后，下一条是
   `2026-11-20 11:01:30.975 启动（Windows 服务）`，**中间没有「停止」行**——进程是被硬杀掉/超时终结的，
   回合没走完。同一段 `01:40:08 停止` 之后还继续服务了 30 秒（`open_conversation 失败 :: InvalidOperationException:
   ExecuteReader can only be called when the store…`），说明关闭时连接没断、宿主吊着——已在 `c86fc9e` 修掉。
2. 对话库 `messages` 最后一条（seq 844）是 `{"type":"toolCall","id":"call_00_ET_8Tlf8…","name":"bash"}`，
   **没有对应的 toolResult**。
3. `app.js` 里步骤行是 `const running = entry.kind === 'tool' && !entry.block.done;`（约 1224 行），
   没有结果的 tool 块永远画成「运行中」；而侧栏转圈看的是 Core 的 `conversation.working`，
   新进程里 `_live` 是空的 → 绿点。于是同一条对话「侧栏不转、线框转」，重启 Core、重开客户端都不会变——
   这个状态在 `messages.payload` 里，不在内存里。
4. 「停止」卡住：`abort` 走 `SimpleAsync → live.Session.SendAsync(..., TimeSpan.FromSeconds(120))`
   （`CenterHub.cs:2080`），子进程不回应就干等 **120 秒**，界面上就是一直转。

关于「重装后不自动重连」：前端 `connect()` 的 `close` 处理器是无限退避重试（1s→2s→…→15s 封顶），
令牌也不会因重启而变（`read_center`：`center.json` → `token.txt`，`token.txt` 只在缺失时生成）。
所以更可能是旧 Core 关闭时吊住 30 秒占着 8787，新 Core 起不来/绑不上，页面确实连不上；
叠加第 3 条那个卡住的「运行中」，看起来就像「没重连成功」。**推测，验证方式**：升级前让 Control 先等
`sc query` 到 STOPPED 再放行安装（现在已经 45 秒），或升级后查日志里有没有新的「启动」行。

要改的话四处（还没动手）：

- 打开对话/启动 Core 时，把「有 toolCall 没 toolResult」的尾巴标成中断，界面显示「已中断」而不是「运行中」。
- `session_state`/`open_conversation` 报 `streaming=false` 时，前端把本地 `session.streaming` 清掉。
- `abort` 单独给短超时（5 秒），失败就明确提示，别跟着 120 秒通用超时转。
- 关闭流程：断 WS（已做）+ 子进程退出上限（已有 8 秒），再给整体关闭一个总时限。

## STATUS-042：服务停不下来 → 重启超时 → 服务留在停止状态（2026-11-20，未发版）

- 用户报：重新探测仍提示找不到 Pi；手动改、重新探测、失败回填，三种情况都不会把服务拉起来。
- 查到的因果链（生产日志 + `%LOCALAPPDATA%\SevenStation.Control\control.log`）：
  1. `2026-11-20 10:02:55 Seven Station Core 停止` 之后，进程**又活了 30 秒**，期间客户端还在连、还在报
     SQLite 已释放的错——宿主在等 WebSocket 收尾。
  2. `CenterHub.ShutdownAsync()` 根本不断开连接，Kestrel 关闭要等连接结束，默认超时 30 秒才强断。
  3. Control 的 `restart()` 里 `wait_for(false)` 只等 20 秒（40×500ms），超时就 `?` 直接返回，
     **`sc start` 从来没发出去**，服务就这么留在「已停止」。
  4. 服务没起来 → Core 不会重新探测 → UI 看到 `piReady=false` → 「找不到 Pi」。三个现象其实是同一个原因。
- Core 改法：`CenterConnection.Abort()`（`Interlocked` 置位 + `WebSocket.Abort()`），
  `ShutdownAsync()` 先把所有连接 Abort 掉再收尾。
- Control 改法：停止等待放宽到 90×500ms（45 秒），而且**停不下来不再提前返回**，继续 `sc start`
  让真正的错误暴露出来；启动等待 60×500ms。UI 上如果发现服务没起来，直接提示
  「服务没起来，点上面的『启动』把它拉起来」，而不是含糊地说没找到 Pi。
- 实测（沙箱服务 `SevenStationCore-Sandbox`，自己的数据目录与端口，不碰生产）：
  - 挂着客户端时 `sc stop` → **603 ms** 变 STOPPED（改之前 30 秒起步）。
  - 同一沙箱上跑 `sevenstation-control.exe --do pi ""`（清空 + 重启）→ 整段 **703 ms**，结束后服务 RUNNING，
    Core 日志 `找到 Pi：C:\Users\7inaBranford\.pi\agent`，`settings.json` 回填正确。
  - 测完已删掉沙箱服务与临时目录。
- 出包：`dist/SevenStationCore-win-x64-0.4.1.msi` 43.7 MB（`e2a11355a8e4cdf4…`）。

## STATUS-041：深色模式下一堆写死的浅色底（2026-11-20，未发版）

- 现象：深色模式下正文里的表格、代码块、行内代码亮得刺眼，表头和白底行里的浅灰字几乎看不见。
- 原因：这些样式写死了浅色值，没走主题变量——
  `.md code` `#f3f3f5`/`#e8e8ee`、`.md pre` `#f7f7f9`、`.md tbody tr:nth-child(even)` `#fbfbfc`、
  `.think` `#fbfbfc`、`.tool-body` `#fafafb`、`.table-wrap thead th` `#f7f7f9`、`.log-tail`、
  `.step-detail pre`、`.dir-where`、`.option`、`.badge-soft`、`.dir-row:hover`、`.files-row:hover`、
  `.completion-item.is-active`、`.new-thread:hover`、`.pill-select:hover`、加载转圈的边框色。
  文字色也有两处硬编码：`.md a` 的 `#2f54c9`（深色下深蓝几乎看不见）、`.conn.ok` 的 `#1f7a4d`。
- 改法：全部换成主题变量（`var(--panel)` / `var(--active)` / `var(--border-strong)` / `var(--green)` /
  `color-mix(in oklab, var(--text) 4%, transparent)` 这类）。新增 `--link` 令牌：浅色 `#2f54c9`，深色 `#7ea6ff`。
- 顺手修掉一个一直没生效的东西：`toolCard` 里状态点是按 `state ok/err/running` 这类 **class** 设的，
  样式表里却只写了 `[data-state="ok"]` 选择器，所以那个点一直是透明的。补上 `.state.ok/.err/.running`。
- 出包：`dist/SevenStationCore-win-x64-0.4.1.msi` 43.7 MB（`293df8289abe421a…`）。
- 未验证：深色主题的实际观感（截不了 WebView2 的图），需要用户看一眼。

## STATUS-040：Control 里改 Pi 目录，打一半字被清掉（2026-11-20，未发版）

- 现象：点「更改」进入输入态，输到一半输入框就不能输了，而「保存 / 取消」还杵在原地。
- 原因：Control 每 3 秒 `publish()` 一次（`main.rs` 的 poller），页面收到 `state` 就整份 `render()`，
  里面那行 `el('piDir').textContent = ...` 直接把单元格的子节点换掉——输入框连同上半截字一起没了；
  而按钮是独立元素、只切了 `hidden`，所以还留着。3 秒一次，正好是「改一半就断」。
- 改法：输入态（`el('piInput')` 存在）时不碰 Pi 那一行；`applyPiDir()` 等待期间另立 `piBusy` 标志，
  免得「正在重启…」那行每 3 秒被推送刷回「还没配」。
- 出包：`dist/SevenStationCore-win-x64-0.4.1.msi` 43.7 MB（`9a0c71f923a10d87…`）。

## STATUS-039：只认了一种 Pi 装法——npm 装法现在也认（2026-11-20，未发版）

- 用户贴的截图摊牌了：他那台 Pi 是 **npm 版**，目录是
  `C:\Users\wakab\AppData\Local\pi-node\current`（`pi` / `pi.cmd` / `pi.ps1` +
  `node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js`），数据在 `C:\Users\wakab\.pi`。
  而 Seven Station Core 只认官方安装包那种布局（`<家>\.pi\agent\bin\pi-launcher.js`），于是判定成「没有 Pi」。
  `pi-launcher.js` 确实是 Pi 自己的一部分（本机 `<家>\.pi\agent\bin\` 里就有），只是 npm 装法没有它。
- Core 改法：
  - `PiLocator.ResolveLaunchScript()`：先找 `bin\pi-launcher.js`，没有再读
    `node_modules\@earendil-works\pi-coding-agent\package.json` 的 `bin.pi`（回退 `dist/bundle/cli.js`、`dist/cli.js`）。
    `LauncherPath`、`EnsureInstalled`、`--help` 探测、`PiSession` 起子进程全都走它。
  - `IsPiDirectory()` 取代原来写死的 `File.Exists(bin/pi-launcher.js)`，探测与校验都用它。
  - 探测位置补 `<家>\AppData\Local\pi-node\current`（每个用户档案都看）；`ResolveNode` 补「Pi 目录旁边的 node.exe」。
  - 会话目录：官方装法 `<家>\.pi\agent\sessions`，npm 装法 `<家>\.pi\sessions`，`PiLocator.SessionsDirectory()` 挑存在的那个；
    `PiSessionLibrary.Root` 与 `PiAgent` 的「会话目录」统一用它。`HomeOf()` 也能从 npm 目录反推家目录。
- Control 同步：`pi_entry()` 两种入口都认，「重新探测」「更改」不再把 npm 装法当成无效目录；
  `derive_home()` 支持 `<家>\AppData\Local\pi-node\current`。
- 实测：造一份 npm 布局（package.json + dist/bundle/cli.js）→ Core 用 `PI_AGENT_DIR` 指过去，
  `settings.json` 里 `Agents.pi.Directory` 就写成了那个目录；Control `--do pi <npm 目录>` 退出码 0，
  随便指个 `E:/tmp` 仍然退出码 4。
- 出包：`dist/SevenStationCore-win-x64-0.4.1.msi` 43.7 MB（`90bb9663c0071acc…`）。
- 未验证：真机上 npm 版 Pi 能不能正常起会话（要用户那台才能试）。

## STATUS-038：Control 改 Pi 目录的四个毛病（2026-11-20，未发版）

用户报「点了重新探测反而把已有的路径弄没了，明明就是常规的 `C:\Users\7inaBranford\.pi\agent`」。

- **这条链路本身是通的**（本机按服务账户复现整条流程）：
  `sevenstation-control.exe --do pi ""` → `settings.json` 的 `Agents.pi.Directory` 变空、`Listen` 保留；
  再起 Core → 日志 `找到 Pi：C:\Users\7inaBranford\.pi\agent`、`配置里缺的 Agent 已补上`，
  文件回填正确。用户那台当时为什么没找到，日志里没有 `找到 Pi`，复现不出来。
- 但顺着查发现四个真问题，都修了：
  1. **读完状态太早**：`invoke('set_pi_dir')` 之后立刻 `read_state`，服务还没起来就读，
     于是显示「还没配」——人会以为探测失败。改成轮询最多 15 秒，等到 `piReady` 为止。
  2. **探测失败会丢原值**：现在记住改之前的路径，探测不出来就自动填回去并告知。
  3. **写配置会抹掉整份**：`write_pi_dir` 原来读失败就从空对象开始写，能把 `Listen` 等一起抹了。
     现在「读不懂就拒绝写」（实测：坏 JSON → 退出码 4、文件一字未动）。
  4. **编辑态太脆**：`input` 的 `blur` 直接取消编辑，粘贴时一失焦刚贴的就没，回车也落空。
     去掉 blur 取消，改成显式「保存 / 取消」按钮（改变/重新探测两个按钮在编辑态隐藏），
     键盘仍然支持 Enter 保存、Esc 取消。
- 出包：`dist/SevenStationCore-win-x64-0.4.1.msi` 43.7 MB（`5166c07da24883bc…`）。

## STATUS-037：点路径没反应——服务开不出用户桌面的窗口（2026-11-20，未发版）

- 现象：装了服务版之后，正文里点可点路径，资源管理器不弹。
- 原因：`reveal_path` 由 Seven Station Core 执行，而 Core 是 Windows 服务，`Process.Start("explorer.exe")`
  落在**会话 0**，用户桌面永远不会出现窗口；`Process.Start` 不报错，所以界面既没提示也没动作。
  生产日志里没有「打开路径失败」，本机 `Get-Process explorer` 也只有会话 1 的那一个——都对得上。
- 改法：让壳去开。桌面客户端新增 `reveal_path` 命令（`src/SevenStation.Desktop/src/main.rs`），
  `build.rs` 的 `AppManifest` 与 `capabilities/center.json` 同步登记（`allow-reveal-path`，
  已确认生成在 `gen/schemas/acl-manifests.json`）。页面里 `revealPath()` 优先调壳，
  壳不认账（浏览器、手机）才退回 Core——那条路至少会回一句「找不到这个路径」。
- 连带：**这次两个包都得装**。核心逻辑在 Core 的 wwwroot，新命令在客户端壳里，缺一个都点不开。
- 出包：Core `34e3fee99838b52e…`（43.7 MB）、客户端 `afcae29c390bf0c6…`（3660 KB）。
- 未验证：真实点击是否弹出资源管理器（这台机器的会话 0 无法验证，只能由用户在桌面点一次）。

## STATUS-036：工作过程只留最新一条但能翻出来，细节改成看得懂的写法（2026-11-20，未发版）

- **翻不出已完成步骤**：`workGroup` 里 `work.slice(-1)` 是「只画最新一条」，画完就没了——展开/收起只能操作整组，
  前面完成的步骤根本不在 DOM 里。现在会全部画出来：干活时最新那条直接摆在正文，
  其余的收进「前 N 步已完成」的折子里（`work-more` / `work-earlier`），点一下就展开，再点收起。
  跑完之后整组照旧按状态折叠。
- **就地更新认错行**：`updateLiveTurn` 原来取 `.work-body .step` 的第一个，加了折子之后可能抓到折子里的旧行。
  改成只认 `.work-body` 的直接子节点、按 `data-step`（工具调用 id）比对；对不上就整轮重画，
  对上才就地改文字。
- **细节全是原始 JSON**：`toolCard` 以前把 `args` 原样 `JSON.stringify` 加整段输出倒进 `<pre>`。
  现在按工具给分段（`toolSections`）：`read` 给文件 + 行范围 + 内容，`bash` 给命令 + 输出，
  `edit/multi_edit` 给「原来 / 换成」两条（红底 / 绿底），`write` 给写入 + 内容，
  `web_search` / `fetch_content` / `grep` / `glob` 各给对应的字段，其余退回参数 JSON。
  输出超过 80 行就掐头 60、留尾 20，中间标「…省略 N 行…」；路径用 `shortenPath` 相对当前工作区显示，
  点一下能在文件面板里打开。
- 加工放在前端（`wwwroot/app.js`）而不是 Core：事件里该有的字段都有，加工只是排版；
  前端改了两端（桌面与手机共用一份 wwwroot）同时生效，也不用动库里的历史 payload。
- 验证：`shortenPath` / `trimOutput` / `toolSections` 用 node 逐类跑过（read 带 limit、read 长文件、
  bash、edit、write、未知工具出错），分段与截断都对；界面实际观感没法在这台机器上截图。
- 出包：`dist/SevenStationCore-win-x64-0.4.1.msi` 43.7 MB（`0a01ea231366fd88…`）。

## STATUS-035：追加输入改为「回合边界」送出，不再等整轮结束（2026-11-20，未发版）

- 用户报的现象属实：`DeliverQueuedAsync` 只在 `agent_settled` 里调用，也就是整轮任务彻底结束后才把
  排队的第一条送出去，剩下的还要再等一轮——一个跑五分钟的任务，追加的话要等五分钟才生效。
- 改法：在 `turn_end`（模型这一轮回答 + 它的工具调用结束）就把队首那条交给 Pi，带
  `streamingBehavior: "steer"`，Pi 会在下一次调模型前采用它。`agent_settled` 那条保留，作为兜底
  （整轮结束后还有剩的就当新一轮起点）。一次仍然只送一条。
- 停止保护：新增 `Live.StopRequested`（`abort` 时置位、`agent_settled` 清掉），按过停止就不再往 Pi 塞，
  排队的留在面板里由用户自己决定。只在 `live.Streaming` 时送，避免空闲时带 steer 出错。
- 队列仍然由 Seven Station Core 自己持有，所以「编辑」照旧可用：条目在 panel 里的时候能改，
  被回合边界送出去之后就改不了了——和 Pi TUI 里 alt+Q 的可用窗口一致。删除/清空也照旧。
- 实测（临时实例 8899，多步任务 + 中途追加）：
  `6.6s` 入队（queue_state=1）→ `9.8s` 队空（已在回合边界送出）→ `10.1s` 追加的话落地 → `16.5s` 整轮结束。
  日志里没有「送出排队消息失败」。
- 出包：`dist/SevenStationCore-win-x64-0.4.1.msi` 43.7 MB（`e35ea0b156b69a8c…`）。

## STATUS-034：Control 改 Pi 目录被 ACL 挡了 + 待发图片挪到空隙里（2026-11-19，未发版）

- **`Command set_pi_dir not allowed by ACL`**：用户点的是「重新探测」（空路径 = 清掉后让 Core 重找），
  与「更改」走的是同一条命令，ACL 一挡两个按钮都动不了。新增壳命令要登记两处，我只做了一处。
  `src/SevenStation.Control/build.rs` 的 `AppManifest::commands` 补 `"set_pi_dir"`，
  `capabilities/control.json` 的 `permissions` 补 `allow-set-pi-dir`。
  核对 `gen/schemas/acl-manifests.json` 里已经出现 `allow-set-pi-dir`，权限这次真的生成了。
  （桌面客户端那边一直是这么要求的，AGENTS.md 里也记着「新增壳命令要在 build.rs 登记」，这次漏的是能力表。）
- **粘贴图片把正文顶上去**：`.attachments` 原本是 `.composer` 里的普通流元素，多一行就把上面正文区挤下去。
  现在和提示合并成一个 `.composer-dock`（`position: absolute; bottom: 100%`，容器 `pointer-events: none`，
  只有 `.attachments` 打开点击），两者都不参与布局，正文区纹丝不动。
- **那个叉太丑**：原来是个默认样式的 `<button>×</button>`，浏览器给它画了边框。
  改成 20px 圆形按钮 + 11px 的 SVG 叉（`stroke-width 1.4`），平时只有淡淡的叉，悬停铺一层 `--border`。
  文件名超长时按 260px 封顶、省略号收尾，留 `title` 看全名；缩略图 22px 圆角 5px；
  底色从写死的 `#f7f7f9` 换成 `var(--panel)`，深色主题不会再冒出白块。
- 出包：`dist/SevenStationCore-win-x64-0.4.1.msi` 43.7 MB（`7672200fcbacbb74…`）。
- 未验证：界面观感（叉的样子、图片条浮在空隙里的实际位置）没法在这台机器上截图，需要人眼确认。

## STATUS-033：安装时自动收掉在跑的程序（2026-11-19，未发版）

- 只靠 `util:CloseApplication` 不行：它发的是关闭消息，而 Control 收到关闭请求是 `prevent_close` + 缩回托盘
  （`src/SevenStation.Control/src/main.rs:232`），进程还在、exe 继续被占着，装完还是旧程序。
  便携方式跑的 Core 更是没人管。
- 改成 taskkill：`WixQuietExec`（Util 扩展）执行
  `taskkill /F /T /IM SevenStation.Control.exe /IM SevenStation.Core.exe`（客户端包只有 `/IM SevenStation.exe`）。
  `/T` 连 Pi 子进程与 WebView2 的浏览器进程一起带走，不留孤儿。
- 装与卸各一条：`KillRunningOnInstall` 在 `InstallFiles` 前、「`KillRunningOnRemove`」在 `RemoveFiles` 前。
  服务仍然由 `ServiceControl` 先停（`StopServices`=1900 早于 3999）。
- 踩到两条 WiX 规矩：`BinaryRef` 不是元素（`WIX0005`），扩展的 CA 二进制直接用
  `BinaryRef="Wix4UtilCA_X64"` 属性引用即可；同一个 Action 在序列里只能出现一次（`WIX0091`），
  所以装/卸各建一条 CA。CA 用 `Execute="immediate"`——WixQuietExec 靠与 CA 同名的 Property 取命令，
  deferred 方式拿不到。
- 核对 MSI（`CustomAction` / `InstallExecuteSequence` 两张表）：类型 65（immediate）、
  3999 < 4000、3499 < 3500，命令串与预期一致；两个包都通过。
- 出包：Core `c26414fcf6445af…`（43.7 MB）、客户端 `58c23878860d0596…`（3660 KB）。
- 未真机验证：装的时候真的把托盘里的 Control 杀掉这件事，得在别人的机器上装一次才知道。

## STATUS-032：可点位置双管齐下——渲染器兼容 + 给 Pi 的写法约定（2026-11-19，未发版）

- 渲染器（`wwwroot/app.js` 的 `decorateLinks`）：
  - 行内代码（反引号）里的路径也做成链接；只跳过 `a` 与代码块 `pre`。模型爱把路径包进反引号，这条解决了一大半。
  - 新增引号包裹的路径：`"E:\My Files\notes.md"` 整段识别，引号本身不进链接，也不会被句末标点裁剪。
  - 裸路径不再吞中文标点（`，。；：！？、（）【】《》「」『』`），否则「E:\a\b，然后」整句都成了链接。
  - 验证（node 逐条跑）：裸路径、带空格引号路径、反引号路径、UNC、网址带句号、中文逗号结尾、无路径的普通文字，七种输入结果都对。
- 给 Pi 的写法约定：新增 `src/SevenStation.Core/Agents/pi-guidance.md`（随程序集输出），
  `PiSession.Start` 用 `--append-system-prompt <内容>` 注入。Pi 的这个参数只吃文本，所以 Core 自己读文件再传。
- 兼容兜底：`PiLocator.SupportsAppendSystemPrompt` 先跑一次 `node <agent>\bin\pi-launcher.js --help`
  看有没有这个参数（老版本遇到不认识的参数会直接退出，不能让聊天整个挂掉），结果按进程缓存。
- 实测：
  - 子进程命令行里出现 `--append-system-prompt`（父进程是测试实例）→ `injected=YES`。
  - 问「把这两个文件的完整路径发给我」，回复就是裸绝对路径 + 裸网址，没有反引号也没有相对路径。
- 出包：`dist/SevenStationCore-win-x64-0.4.1.msi` 43.7 MB，SHA-256 `a103b25e6d5d4f26679926011a17ae1730a7dbea84dd8b020fca251b8febdeac`。
- 界面观感（链接在反引号里的样子）还没人眼确认过。

## STATUS-031：服务的 Pi 探测补上用户变量与任意盘用户档案（2026-11-19，未发版）

- 用户反馈：他们机器上 `pi` 直接能跑（Pi 装在 PATH 上），Core 却报「还没有配置 Pi」。
  原因有两层，都是因为 Seven Station Core 跑在 **LocalSystem** 下：
  1. `Environment.GetEnvironmentVariable("PI_AGENT_DIR")` 只拿到**机器级**变量，用户在「环境变量」
     对话框里设的是 `HKEY_USERS\<SID>\Environment`（用户级），服务账户根本看不到。
  2. 用户档案扫描写死了 `C:\Users\*`，家目录在别的盘或自定义路径的用户直接漏掉。
- 改法（`CoreSettings`）：
  - 新增 `UserEnvironmentPiDirectories()`：遍历 `HKEY_USERS\<SID>\Environment` 读 `PI_AGENT_DIR`，
    支持 `%VAR%` 展开；hive 没挂载（用户未登录）时跳过。
  - 新增 `UserHomes()`：从 `HKLM\...\ProfileList\<SID>\ProfileImagePath` 取全部用户家目录（任意盘、任意路径），
    再补 `C:\Users\*` 兜底；跳过 `systemprofile` 与 `Default`。
  - `ProfileCandidates()` 改用 `UserHomes()`。
  - 程序集级 `[assembly: SupportedOSPlatform("windows")]`（读注册表、跑服务本来就只对 Windows 成立），
    消掉 CA1416；`Microsoft.Win32.Registry` 包引用不需要，net10.0 自带。
- 实测：把 `PI_AGENT_DIR=E:\tmp\fake-pi` 写进用户级注册表（服务账户读不到的位置），
  冷启动一个临时实例，`settings.json` 的 `Agents.pi.Directory` 就是 `E:\tmp\fake-pi`——这条路径以前必然漏。
  测完已删除该注册表值、清掉临时目录。
- 出包：`dist/SevenStationCore-win-x64-0.4.1.msi` 已含本次改动（43.7 MB）。

## STATUS-030：Seven Station Control 里能改 Pi 安装目录了（2026-11-19，未发版）

- 起因：另一个用户装完之后 `list_models` 一直报「还没有配置 Pi」。Core 的自动探测只扫
  `C:\Users\*\.pi\agent\bin\pi-launcher.js`，Pi 装在别处（或没装在系统盘家目录）就找不到。
- Control 的「连接」区加了一行 **Pi 安装目录**：显示当前配置（读 `settings.json` 的 `Agents.pi.Directory`），
  不可用会显示一行提示；「更改」就地变输入框（Enter 存、Esc 取消），「重新探测」把目录清空、重启服务让 Core 重新找。
- Rust：`Snapshot` 加 `pi_directory` / `pi_ready`；`set_pi_dir()` 先校验 `bin/pi-launcher.js` 存在，
  再走提权写配置（`--do pi <path>`）；`write_pi_dir()` 改 `Agents.pi` 只动 `Directory`/`Home`，
  `Node` 等其它键保持不变，`<用户>\.pi\agent` 这种标准位置顺手推出家目录；写完重启服务。
- 校验在提权入口里也做了一遍，绕不过去。实测三种情况都对：`E:/tmp` → 退出码 4 且配置不动；
  清空 → `Directory` 变空、`Home` 保留；设好 → `Directory`/`Home` 正确、`Node` 原样保留。
- 出包：`dist/SevenStationCore-win-x64-0.4.1.msi` 已含新版 Control。界面观感需要人眼确认。

## STATUS-029：安装包的版本倒退已修（2026-11-19，未发版）

- `scripts/build-installer-center.ps1`：FileVersion 改成 `0.<年>.<月日>.<时分>`（如 `0.26.1119.2211`）——
  四段各 ≤ 65535、随构建单调递增，且一定大于历史上的 `0.4.39632.0`。不再取模，不会回绕。
- 两个 wxs 都加了 `util:CloseApplication`（挂在 `<Package>` 下，父元素只能是 Package/Module/Fragment）：
  升级前先关掉在跑的 `SevenStation.Core.exe` / `SevenStation.exe`。两个构建脚本都加了
  `-ext WixToolset.Util.wixext`，该扩展已装到 wix 的全局扩展目录。
- 已核对（由脚本重建的两个 0.4.1 MSI）：`Wix4CloseApplication` 表里分别有
  `CloseCore → SevenStation.Core.exe`、`CloseClient → SevenStation.exe`；Core 的 exe 版本
  `0.26.1119.2211`、客户端 `0.4.1.0`。服务那侧本来就有 `Stop="both" Wait="yes"`，占用这条路是通的。
- **没发版**：`<Version>` 仍是 0.4.1，没打新标签。`dist/` 里的 0.4.1 安装包已经是打了补丁的版本，
  与线上已发布的 0.4.1 资产字节不同，下次发版直接用。
- 未验证：拿 0.4.0 真装一次再升级到现在这个包（要重装旧版本，没做）。

## STATUS-028：0.4.1 升级把 Core.exe 装丢了（2026-11-19）

- 现象：用户在自己机器上装 0.4.1 的 Core MSI，安装报成功、ARP 显示 0.4.1，但
  `C:\Program Files\SevenStation Core\SevenStation.Core.exe` 不存在、`SevenStationCore` 服务也没注册；
  Seven Station Control 起成便携模式，弹「没找到 SevenStation.Core.exe」。
- 根因（用户先停了服务，排除占用）：**FileVersion 倒退了**。构建脚本用「UTC 秒数 % 60000」当第三段，
  0.4.0 出过 `0.4.39632.0`，0.4.1 回绕成 `0.4.11411.0`。两个 MSI 里 `CoreExecutable` 组件 GUID 相同
  （`{86036D2D-…}`），Windows Installer 见到目标位置是「更高版本」就跳过替换，组件却记成已安装，
  旧的卸载再把文件删掉 —— 最后 exe 与服务注册（挂在同一组件上）一起没了。
  其余文件没事：DLL 的 AssemblyVersion 是 0.4.1（更新），`wwwroot`/`json` 无版本号按内容比对。
- 处理：`msiexec /fa {976887C6-70AC-4EE9-9EA4-2174D2F41D72} /qn` 修复安装，文件与服务都回来了，
  `127.0.0.1:8787` 返回 200。
- 待修（0.4.2）：在 MSI 里用 `util:CloseApplication` 在 InstallFiles 之前关掉正在跑的
  `SevenStation.Core.exe` / `SevenStation.exe`，并给 WiX 加 `WixToolset.Util.wixext`；
  升级前先停服务这条写进发布说明的升级注意事项。
- 影响面：所有从 0.4.0 升级的机器都会碰到（服务默认常驻），不是个例。

## STATUS-027：0.4.1 发布（2026-11-19）

- 版本号三处改到 `0.4.1`（Core csproj、两个 Cargo.toml、两个 tauri.conf.json），
  发布说明 `docs/release-notes/v0.4.1.md` 过门禁（40 行、分类、链接到 `v0.4.1` 下的 STATUS）。
- 出包：`SevenStationCore-win-x64-0.4.1.msi`（43.3 MB，SHA-256 `54f96072…df7736`）与
  `SevenStation-win-x64-0.4.1.msi`（3.2 MB，SHA-256 `b6d07af3…65e53e9a`），MSI 里 ProductVersion 都是 0.4.1。
  构建信息表在 `build/release/v0.4.1.md`，源码提交 `e77e04e`。
- `main` 与标签 `v0.4.1` 用 SSH 推；Release 由用户在自己会话里执行 `gh release create` 建好。
  核对：标题 `v0.4.1`、非草稿、四个资产（两个 MSI + 两个 .sha256）无显示标签、字节数与本地一致；
  把两个包下载回来算 SHA-256，与本地逐字节一致；正文与 `build/release/v0.4.1.md` 完全相同（40 行，含构建信息表）。
- `gh` 这次踩到：新版 gh 把 token 存进 Windows 凭据管理器，`hosts.yml` 里只剩用户名，
  所以以 SYSTEM 身份（本会话）跑 `gh` 永远 invalid；发布命令要让用户在自己的会话里跑。
- 构建环境的两个坑：`dotnet publish` 卡在还原是 MSBuild server 的问题，设
  `DOTNET_CLI_DO_NOT_USE_MSBUILD_SERVER=1` 后 48 秒过；WiX 的 UI 扩展按系统账户档案找，
  `%USERPROFILE%` 覆盖无效，扩展要复制到 `C:\Windows\system32\config\systemprofile\.wix\extensions`。
- 没做真机安装/升级测试（生产环境隔离：不许覆盖用户正在用的 0.4.0）。

## STATUS-026：进度类操作一条通知到底（2026-11-19）

- 用户定的规则：一秒钟内完不成的操作，用**同一条**通知从「进行中（转圈）」翻成结果，
  不要开始弹一条、结束再弹一条；一次性提示（如模型回退）几秒后自己消失就行。
- 压缩：点按钮先挂一条「正在压缩上下文」+ 转圈，`compaction_end` 时同一条改成「上下文已压缩」
  （3.2 秒后消失）；Pi 自动触发的压缩没点过按钮也会补上这条。120 秒没结束就改成「压缩好像没结束」。
- 停止：`requestStop()` 挂一条「正在停止」+ 转圈，`agent_settled` 回来按 `event.aborted` 翻成
  「已停止」或「本轮已结束」；15 秒没回音提示「还没停下来，可以再点一次」。进程退出也收尾。
- 实现：`statusToast()` 返回可 `update()/remove()` 的句柄，样式 `.toast.is-busy` + `.toast-spin`。
- 动画：进场往上冒（`rise`）；退场分两段——先整块淡出下沉 150ms（文字和框一起走），
  透明后再把高度收成 0（120ms，这时看不见框，只有后面的卡片平滑上移）；
  换文案时新字淡入、卡片高度按新旧差值 200ms 过渡，变长变短都不跳。
- 未验证：动画观感（需要在界面里点一次压缩或停止看那张卡片翻面与收起）。
## STATUS-025：通知挪进正文与输入框之间的留白（2026-11-19）

- 用户定的界面规则：那块留白平时没信息，瞬时的通知就该放这儿，不要浮在右下角挡内容。
- `#toasts` 从根容器挪进 `.composer`（第一个子元素），`.toasts` 改成
  `position:absolute; bottom:100%; left/right:24px`，贴住输入区上沿、只向上叠，绝对定位所以不顶动布局。
- 样式从深色药丸改成浅色卡片（边框 + 10% 底色），warning / error 用边框颜色区分；
  `pointer-events:none`，通知不吃点击。
- 未验证：观感（需要在界面里触发一条通知看一眼）。

## 待办：批三的约定（2026-11-19 用户定）

新对话沿用上次的模型与思考等级：**全局一份**（不按工作区分）、只记**手动切换**、
继承的模型不在清单里时**弹一条简短通知**（不用详细）。还没写代码。

## STATUS-024：发送状态三态与正文里的地址路径（2026-11-19）

- **发送状态**：气泡左边一个 14px 小圈，`sending` 转、送达淡出、失败变红圆底感叹号（挖空）。
  失败时点它弹小面板：取消 / 删除这条 / 重新发送（重发沿用原文与图片，圈转回去再发一次）。
  成功后不撤气泡、不闪一下——回显那条就地换成正牌消息，只把圈淡掉。失败时气泡不再描红边（用户去掉的）。
  回显条目本来就在 `session.items` 里，`turnsOf()` 会画；**别再额外补画一遍**（踩过：气泡变两条）。
  只有从 `raw` 重建 items 的地方（`onOlderMessages`）要接回还没确认的那些。
- **地址与路径可点**：`renderMarkdown()` 外面包了 `decorateLinks()`，正文里的 `http(s)://`、
  `C:\...`、`\\server\share` 会变成链接（跳过 `a`/`code`/`pre`）。网址走新窗口打开；
  绝对路径发 WS `reveal_path`，Core 用 `explorer.exe`（目录直接开、文件用 `/select,`）打开，
  打不开回 `notice` 轻提示。
- 演示开关：`SEVENSTATION_DEBUG_FAIL_PROMPT=1` 时每句话都当场失败，用来看红圈。
- 验证：`node --check` 通过、构建 0 错误、正则单测（URL/盘符/UNC/句末标点/括号）通过；
  `reveal_path` 打不存在的路径回 `notice: warning 找不到这个路径`。用户在测试实例上确认：
  首发的气泡只有一个、红圈点的面板「重新发送」「删除这条」都符合预期（重发后转圈并送达、淡出）。
## STATUS-023：发出去立刻看得见（2026-11-19）

- 问题：说完话到界面上出现自己的气泡之间要等 3~4 秒（实测），因为气泡要等 Pi 回 `message_end`
  才画出来；同时「工作中」也要等 `agent_start`。观感上就是卡住。
- 做法：`submitPrompt()` 在发送前先 `echoPrompt()` 把这句话画进对话，同时把会话标成 streaming，
  「工作 N 秒」立刻开始走；Core 确认后（真正的用户消息到达）用 `echoAt` 把回显换成正牌，不重复。
  提示失败时 `dropEchoes()` 撤掉回显，避免留一条其实没发出去的话。
- 排队的情况不回显：那时这条还没发出去，面板才是它的位置。
- 验证：`node --check` 通过、构建 0 错误；用户在测试客户端确认「气泡立现、停止键与计秒同时切换、
  没有重复的用户消息」。
## STATUS-022：三处「界面在说谎」修掉（2026-11-19）

- 侧栏「工作中」指示器时有时无：`SendConversationList` 只在 list/new/rename/delete 时推送，
  流式开始和结束都不推，客户端也不本地改 `working`。现在状态变化统一走 `SetStreaming()`，
  它会在状态真的变化时 `BroadcastConversations()` 给所有连接。
- 新对话模型显示成 GLM-5.2：新对话 `conversations.Model` 为空，客户端 `currentModel()` 兜到
  模型列表第一条（`v2ex/coder`，显示名 GLM-5.2），而实际跑的是 Pi 的默认。现在 Core 读
  `<agent>/settings.json` 的 `defaultProvider` + `defaultModel`，用缓存列表补全字段后塞进
  `state.model`，胶囊显示的就是真正在跑的模型。
- 模型缓存永不过期：`models` / `thinkingLevels` 加上 `modelsAt` 时间戳，24 小时后自动重取；
  模型面板底部加了「刷新」，发 `list_models` 带 `force: true` 当场重取。
- 验证：临时实例（8899）跑一次真实对话，实测 `state.model = magpie/auto/deepseek-v4.1-flash`、
  `conversation_list` 在开始时 `working=true`、结束时 `working=false`、`modelsAt` 落库。
  界面观感仍需人眼确认。

## STATUS-021：对话区细节与追加输入队列（2026-11-19，开发中）

- 目标：用户提的六条界面问题——自己发的消息认不出来、左侧栏「工作中」指示器不刷新、工作中
  输入卡片被提示行顶高、输入区与正文太挤、步骤刷屏、步骤行悬停时闪、往上翻被拽回底部。
- 已落地（本地提交，未出包）：
  - 用户气泡右对齐加色，三档（跟随主题 / 微信绿 / 薄荷）并入设置页「外观」卡，默认跟随主题。
  - 输入卡片常驻灰影，聚焦时叠蓝色光环，灰影保留；提示行固定预留一行；正文底留白 44 px。
  - 工作中只留最新一条步骤，上一步一完成就折进摘要行；整轮结束后收成一行「工作 N 步」。
  - 正在跑的那一轮改为就地更新步骤文字，不再整轮重建——悬停时不再闪。
  - 滚动只在离底 24 px 内才跟随（原来 90 px），`message_start` / 用户消息落地不再强制拉到底。
  - 追加输入改由 Seven Station Core 自持队列：可看、可改单条、可删单条、可清空，
    这一轮结束后依次送出（`agent_settled` 触发）。Pi 那边的队列命令只有 `clear_queue`，单条改不了。
- 验证：`dotnet build SevenStation.slnx` 0 错误；临时 home + 8899 起核心，脚本走 WebSocket 实测
  「排队两条 → 编辑一条 → 删一条 → 清空」，并确认「本轮结束送出一条、下一轮送出下一条」，
  `session_state` 里带回队列。用户在测试客户端上验过气泡、间距、阴影、步骤收纳、面板与编辑流程。
- 测试中修掉两处：`queue_state` 被错放进 `onEvent()` 导致面板不出现；按停止时未判断
  `agent_settled.aborted`，把排队内容当成下一轮送了出去。编辑改为「取回输入框」。
- 未验证：编辑到一半该条被送出/删除时的自动退出路径（用户跳过）。界面截图仍无（SYSTEM 身份起不了无头浏览器）。
- 未做：左侧栏指示器（`SendConversationList` 只在 list/new/rename/delete 时推，流式开始结束不推）、
  新对话模型的假显示（兜到列表第一条 GLM-5.2）、模型缓存永不过期、新对话继承上次的模型与思考等级。

## 已收口：图标与安装程序画面

- 图标不再是手画：`design/make-icons.py` 用 Segoe UI Semibold 的 π 按包围盒栅格化，一次产出
  Control 的 `icon.ico`/`tray.png`、客户端的深底 `icon.ico`、网页用的 `mark-light.png`/`mark-dark.png`。
- 安装程序画面：`design/make-installer-art.py` 生成 `installer/assets/banner.bmp`（493×58）与
  `dialog.bmp`（493×312），两个 wxs 用 `WixVariable` 指过去，`Icon + ARPPRODUCTICON` 给「应用和功能」配图标。
- 真跑一次向导的截图在 `design/shots/msi-wizard-real.png`：顶栏会被 493×312 的对话框底图盖住，
  页面上看不到 banner；要留顶栏得改底图尺寸，WiX 那个控件尺寸固定，塞进去会拉伸，所以这版就是没有顶栏的样子。

## STATUS-001：Pi 桌面界面能开会话并流式对话

- 做了什么：.NET 10 WPF 窗口托管 WebView2；C# 侧管 `pi --mode rpc` 子进程，一条命令一个
  相关响应、事件原样转发给页面；界面实现会话列表（按工作目录分组）、历史渲染、流式正文与
  思考块、工具卡片、扩展弹窗与状态栏、模型与思考等级切换、上下文用量与压缩。
- 验证方式（2026-11-17，真窗口 + CDP 驱动真实交互）：
  - 冷启动到 `get_state` 响应 4.4 秒，关 stdin 后 0.25 秒退出，退出码 0。
  - 新建会话、发送 prompt、首个 `text_delta` 到 `agent_settled` 全通，正文与思考块落在页面上。
  - 点击侧栏已有会话可续聊：历史 7 条消息、工具卡片 1 张（bash，105 毫秒）渲染正确。
  - 模型下拉 17 项、思考等级、上下文用量（1% · 18k/1000k）都来自真实响应。
  - 扩展状态栏能显示 Pi 扩展推的 `setStatus`，ANSI 色码已剥掉。
- 边界：图片只作为附件随文本发送，`@文件` 补全没做；终端面板没做；扩展弹窗只在
  select / confirm / input / editor 四种上验证了渲染路径，没有真实扩展触发过全流程。
- 证据：`dotnet build` 0 警告 0 错误；界面截图在当时的临时目录，未入库。

## STATUS-002：仓库定名 SevenStation 并推到公开远端

- 按用户要求把项目搬到当前工作目录，仓库名与目录同名（均为 SevenStation），
  程序集、命名空间、exe、日志与界面品牌一并改名，避免同一产品留两个名字。
- 验证：`dotnet build` 通过，`scripts/ui-smoke.mjs` 在改名后重跑通过；`git log` 保留原有提交。
- 记录：那次 `gdi32full.dll` 崩溃（`0xc0000409`）由用户指认为本机 MacType 注入所致，
  不是代码问题，已写进 `AGENTS.md` 的已知坑。

## STATUS-003：拆成 Seven Station Core + 客户端，多端共用一份会话

- 用户 2026-11-17 定下目标形态：一套 Seven Station Core 负责跟 Pi 打交道，PC 与手机都连这套 Seven Station Core；日后客户端再加
  host 能力，用 Seven Station Core 的 Pi 操作别的设备。原「只做 PC 端」的约束作废，见 `docs/DECISIONS.md`。
- 改了什么：新增 `src/SevenStation.Core`（ASP.NET Core，管 pi 子进程、会话扫描、`/ws`、
  托管前端）；桌面端退化成 WebView2 壳，加载 Seven Station Core 地址；`AppBridge` 变成 `CenterHub`，
  命令应答回发起连接、会话事件广播给所有连接。前端从 `chrome.webview` 桥换成 WebSocket。
- 安全：Seven Station Core 默认只监听 `127.0.0.1:8787`；`/ws` 要令牌，令牌文件在 `%LOCALAPPDATA%\SevenStation.Core\token.txt`。
- 验证（2026-11-17，真窗口 + CDP + 第二个 WebSocket 客户端）：
  - `scripts/ui-smoke.mjs` 通过：连接状态「已连接」、新会话、流式、收尾、侧栏刷新。
  - 第二个客户端 `list_sessions` 拿到同一份会话（1 条），`open_session` 拿到 3 条历史。
  - 桌面窗口里发一条消息，第二个客户端收到同一条 `text_delta` 与 `agent_settled`，key 一致。
  - 同一会话打开两次只产生 1 个 key，即一个子进程，满足单写者。
- 边界：局域网与 TLS 没做；手机端只验证了同一页面能被打开（未做窄屏适配）。

## STATUS-004：Seven Station Core 定名 SevenStation.Core，与客户端分家

- 用户 2026-11-17 定名：Seven Station Core 叫 SevenStation.Core（MA 既是 Main 也是 Main Agent），客户端仍是 SevenStation。
- 改了什么：`src/SevenStation.Server` → `src/SevenStation.Core`，程序集与 exe 变成 `SevenStation.Core`；
  Seven Station Core 日志写 `%LOCALAPPDATA%\SevenStation.Core\logs\center.log`，令牌文件 `%LOCALAPPDATA%\SevenStation.Core	oken.txt`；
  环境变量改为 `SEVENSTATION_LISTEN` / `SEVENSTATION_TOKEN`；客户端从 Seven Station Core 的令牌文件自动读取。
- 界面：连接状态显示成「已连接 · SevenStation.Core」；新建会话语义改为「填 Seven Station Core 机器上的目录」；
  空状态文案不再说「本机」。
- 验证：`dotnet build SevenStation.slnx` 0 警告 0 错误；`dev-run.ps1` 起 Seven Station Core 与客户端，
  health 返回真实会话根目录，界面连上后列出 170 个会话。

## STATUS-005：对话归 SevenStation.Core，客户端只读 MA 的数据

- 用户 2026-11-17 定：不再全盘使用 Pi 的会话管理。Pi 的会话目录太乱（一百多条结束未清理），
  点开旧会话要等很久、还有加载失败的。对话改成 SevenStation.Core 自己的概念，客户端只跟 MA 通讯。
  记在 `docs/DECISIONS.md` 的 D5。
- 数据：SQLite（`%LOCALAPPDATA%\SevenStation.Core\data\sevenstation.db`，`SEVENSTATION_DATA_DIR` 可覆盖），
  两张表 `conversations` / `messages`，加一张 `settings` 放模型列表这类缓存。
- 绑定：新建对话时只建一条记录；第一次发消息才起 Pi 子进程，把 Pi 的 `sessionFile` 记进
  `pi_session_file` 字段，续聊时拿它 resume。这个字段不出现在任何客户端响应里。
- 存档：每轮 `agent_settled` 后取一次 `get_messages` / `get_session_stats` / `get_state`，
  整体替换该对话的消息并更新标题、模型、思考等级、用量。
- 验证（2026-11-17，真窗口 + CDP + SQLite 直查）：
  - 新建对话 → 发消息 → 流式 → 收尾，库里落地 5 条消息（含 1 条 system）、标题取首句、
    `pi_session_file` 已写入。
  - 关掉 Seven Station Core（子进程一起没）再开，点开同一对话：109 ms 出历史，**没有**起任何 Pi 子进程。
  - 模型列表改为读缓存后，看历史的路径完全不碰 Pi。
  - 删除对话：侧栏 2 → 1，库里对应行与消息一起消失，Pi 那边文件保留。
  - `scripts/ui-smoke.mjs` 通过（用量 `1.1% · 11k/1000k`）。
- 顺带修：`refresh_stats` 原来回的是整份状态，收尾时会用库里未写完的副本覆盖刚流式出来的内容；
  现在只回用量。SQLite 原生库有已知高危版本，已钉 `SQLitePCLRaw.bundle_e_sqlite3` 3.0.5。
- 边界：旧的 170 条 Pi 会话不迁移，MA 从空库开始；对话不能重命名（标题自动取首句）。

## STATUS-006：对话重命名，切模型不再清空线程

- 用户 2026-11-17 要：对话要能重命名，模型选择要能用（上一轮漏了）。
- 重命名：标题旁加了铅笔按钮，双击标题也能改；库里改标题，所有连着的客户端一起更新。
- 模型/思考等级：之前改设置会回整份 `session_state`，用库里还没写完的副本把流式内容覆盖掉——
  表现为「一切模型对话就空了」。改成只回 `conversation_settings`（标题、模型、思考等级），不碰消息。
- 思考等级：换过模型后库里记的等级可能不在当前模型的可选范围，界面照实把它补成一个选项，
  不再显示成空白。
- 客户端自愈：强杀后残留的 WebView2 进程占着缓存目录会报 `0x800700AA`。现在创建环境失败会重试两次，
  仍失败则提示「先关掉旧的窗口和残留的 msedgewebview2」；`dev-run.ps1` 启动前会顺手清理这些残留。
- 验证（2026-11-17，真窗口 + CDP）：切模型后消息数保持 2、线程文本不丢，下拉显示新模型；
  重开后标题、模型 `v2ex/coder-m3`、思考等级 `medium`、消息数都对；重命名后头部与侧栏同步，消息不丢。

## STATUS-007：模型下拉按 provider 分组，标签带上路由

- 用户的困惑：终端里看到的是 `magpie/auto/deepseek-v4.1-flash`，界面只显示
  `Deepseek-V4.1-Flash · routing group`，两者对不上，也不直观。
- 原因：Pi 的模型列表同时给 `provider`、`id`、`name`，界面只用了 `name`，`id` 只藏在选项值里。
- 改法：下拉按 provider 分组（`v2ex` / `explabs` / `magpie` / `oneapi`）；标签是 `name`，
  若 `id` 带路由前缀而名字里没体现，再补 ` · 路由`（如 `· auto`）；悬停提示给完整 `provider/id`。
  分组标签本身就对应终端里那串前缀。
- 验证：17 个模型分 4 组；当前项显示 `Deepseek-V4.1-Flash · routing group · auto`，
  title 为 `magpie/auto/deepseek-v4.1-flash`。

## STATUS-008：按 pi-gui 重做布局

- 用户指出布局离 pi-gui 差太远，给了截图参照。改成它那套浅色形态，不再是深色两栏。
- 外壳：页面灰底 + 圆角窗口，侧栏独立成浅灰面板。
- 侧栏：顶部收起按钮、整行「新建对话」、导航（对话带数量 / 设置）、对话段头带筛选按钮；
  列表按日期分组（今天 / 昨天 / 本周 / 更早），每条两行：标题 + 时间，工作区 + 运行状态。
- 主区：面包屑「工作区 / 标题」+ 重命名铅笔；空态是品牌方块 + 小标签 + 大标题 + 工作区选择。
- 输入区：卡片 + 胶囊行（工作区、模型、思考等级）+ 圆形发送键；提示行只在有队列时出现。
  空态直接输入也会建对话再发出去。
- 其他：设置面板显示 Seven Station Core 地址、版本、对话库路径、连接状态；侧栏可收起（状态存本地）。
- 验证：真窗口截图（空态、对话、折叠、设置）；新建 → 选 auto 模型 → 发一句话 → 收到「收到」；
  标题在发送后即时更新到面包屑与侧栏。
- 与参考的差异：参考里的 Scheduled / Skills / Extensions 三个入口我们没有对应功能，没有摆空壳。

## STATUS-009：输入侧与常驻

这轮补的都是"用起来缺的那几块"，UI 细化留到后面。

- `@` 文件补全：Seven Station Core 自己扫工作区（不经过 Pi），选了目录会接着往下钻；只允许在工作区里找。
- `/` 命令列表：走 Pi 的 `get_commands`（扩展命令、提示词模板、技能），按工作区缓存。
- 图片可以粘贴、也能直接拖进窗口；拖的时候编辑区给个高亮。
- 代码块右上角「复制」，悬停才出现。
- 头部「导出为 Markdown」：标题、工作区、时间，用户与助手正文，工具调用一行一条。
- Seven Station Core 常驻：`scripts/start-center.ps1`（隐藏窗口、等端口真起来）、`stop-center.ps1`、
  `install-autostart.ps1`（登录自启的计划任务，支持 `-Status` / `-Remove`）。
- 内容根固定到 exe 目录：从任何位置启动都能找到 `wwwroot`，打包后双击也不会白屏。

## STATUS-010：终端面板

- 每条对话一个常驻 shell，从头部终端图标打开，面板摆在对话区与输入区之间。
- 实现走 `pwsh -Command -`：命令一行一行喂标准输入，变量与工作目录都延续，
  不需要 PTY，也不用在前端塞终端模拟器。代价写在文档里：交互式全屏程序（vim、top）用不了。
- 没有 pwsh 的机器退回系统自带 powershell；非 Windows 平台走 `bash -s`。
- 输出是广播：两台设备同时开着，看到的是同一条命令流的同一份输出；
  后来打开的设备会把已经跑出来的缓冲补上。
- 面板上有清空、结束进程、收起；输入框支持上下键翻历史，Esc 收起。
- 控制序列在服务端就剥掉了，界面只显示纯文本，不会变成乱码。

## STATUS-011：工作区文件浏览

- 头部文件夹图标打开右侧抽屉：面包屑路径、进入目录、上一层、关闭。
- 文件点开是只读预览，等宽字体；超过 512 KB 或看起来是二进制的文件直接说明原因，不去猜。
- 路径只能在会话工作区里走：`..` 或绝对路径跑出去一律当作找不到。
- 抽屉打开时正文（顶栏、对话区、终端、输入区）整体让开，不压在输入框上面。

## STATUS-012：搜索、记忆与几个日常缺口

- 搜索：标题与正文一起搜，结果里带命中的那一小段。正文存在 `messages.text` 列
  （`payload` 里的中文是 `\uXXXX` 转义的，直接 LIKE 搜不到），老库启动时补列并回填。
- 工作区记忆：用过的目录记在 Seven Station Core（最多 8 条），新建对话时直接挑；输入框会实时检查目录在不在，
  不存在就不让点「开始」。
- 快捷键：Ctrl+K 新建、Ctrl+B 侧栏、Ctrl+J 终端、Ctrl+E 文件、Ctrl+F 搜索、Esc 关弹层。
- 设置面板：Pi 装没装、会话目录、最近工作区、快捷键清单，外加「看最近日志」——
  手机上出问题先看这一屏。
- 断线兜底：Seven Station Core 没起来时，客户端不再是一页白屏，而是说明连的哪个地址、配置在哪、5 秒自动重试。
- 工具卡片里的文件路径点一下就打开文件面板；聊天里的图片点开可放大。
- 切回窗口时自动对一次会话列表与当前状态（别的设备可能改过）。

## STATUS-013：窗口记忆与图片压缩

- 客户端记住窗口大小与位置（`%LOCALAPPDATA%\SevenStation\window.json`）；
  换了显示器导致坐标跑出屏幕时只恢复尺寸，位置仍回到居中。
- 粘进来或拖进来的图片超过 1600 像素就先等比缩小再发（4000×2000 的截图从 157 KB 降到 39 KB）；
  透明图仍存 PNG，GIF 不动。

## STATUS-014：小收尾

- 设置里显示 Seven Station Core 对外地址，并标出「只本机能连」还是「局域网可连」。
- 对话滚动往上翻时出现「回到最新」，新内容不会把位置顶走。

## STATUS-015：冒烟脚本跟上界面

- `scripts/ui-smoke.mjs` 之前靠按钮文案判断「正在跑」，改成看 `stop` 类；
  新建会话后也不再等「线程出现」，而是等「换成新会话」——旧会话开着时线程本来就可见。
- 工作区输入框不再禁用「开始」：目录检查只给提示，真正把关的是 Seven Station Core 建对话时的校验。
  禁用来禁去会跟人抢跑道，也让自动化脚本点不动。

## STATUS-016：按原型做掉六处细节

- 侧栏的技能与扩展数量改成连上就拉一次，不用点进页面才出现。
- 对话行的删除键换成 24 像素圆角图标键，跟「几分钟前」占同一个位置：悬浮时时间淡出。
  行本身从 `<button>` 换成 `role="button"` 的 div，删除键才能落进第二行。
- 工作区胶囊的箭头从字体符号改成 12 像素图标，名字过长中间省略，箭头固定在右端不参与挤位。
- 模型面板高度写死 392 × 420：切分组、搜模型、只剩三个模型都不再跳高跳矮（原先是 403 上下浮动）。
- 图标按钮尺寸归到 26 / 22 / 28 / 32 / 24 五档，图标按边长取整像素；发送与附加键换成图标。
- 小圆点归到 8 / 12 / 16 三档。原来是 7 和 11，1.25 倍缩放下落在半个物理像素上，
  截图放大是 8×9 的带平边糊块，看着不像圆。
- 顺带修三处暗色主题下看不见的图案：停止方块与开关旋钮写死 `#fff` 压在近白底色上，改成 `--on-accent`；
  侧栏折叠键的悬浮底色也改成主题色。

## STATUS-017：状态点、进行中的历史、每步与整轮用时

- 侧栏状态点按状态上色：跑着是转圈，跑完是绿色，只有还没开始过的空对话是灰色。
  之前跑完也是灰色，看着像出了问题。
- 这一轮还在跑的时候就把内容落库：用户的话、每段模型输出、每个工具结果一产生就
  `AppendMessages` 追加，轮次结束再由 `PersistTurnAsync` 拿 Pi 的完整消息整体替换（能自愈）。
  中途切到别的对话再切回来，看到的是正在跑的内容，不再是空白。
- 每步耗时一直在 Pi 的消息里（`toolResult.durationMs`），历史渲染没往界面传，所以完成之后只剩步数；
  现在补上。整轮用时按消息自己的时间点算（用户那句话到最后一次动作），不再把各步相加当总计；
  还在跑的时候按开始到现在每秒刷新，和输入框下面的提示是同一个数。

## STATUS-018：发布口径收口（命名、许可证、死配置）

- 产物改名成 `<项目名>-<平台>-<架构>-<版本>.msi`：Seven Station Core `SevenStationCore-win-x64-<版本>.msi`，
  客户端 `SevenStation-win-x64-<版本>.msi`。两个 Release 分开建，名字与包名一致。
- 仓库加 `LICENSE`（GPLv3 全文），README 增「装起来用」「许可证」两节，「发布」一节按 MSI 重写；
  `RELEASE.md` 按两个产品的命名、门禁、`gh release create` 两条命令重写。
- 两个安装程序的许可页都换掉 WiX 自带的假文字，改用 `installer/license.rtf`（GPLv3 说明与安装会做的事），
  构建脚本用 `-d LicenseRtf=` 传进去，不再各自放一份。
- 删掉客户端 MSI 里只写不读的 `HKLM\SOFTWARE\SevenStation`（`CenterUrl`/`CenterToken`）：
  安装向导早就不问这两项了，装一次写一对空字符串，属于死配置。客户端现在只认
  `%LOCALAPPDATA%\SevenStation\center.json`、`token.txt` 与环境变量，`winreg` 依赖一并去掉。
- 修「Pi 名片里的会话目录」：写在 `~/.pi/sessions`，那里根本不存在，Pi 1.5 的会话在
  `<agent 目录>\sessions`。
- 发布说明拆成 `docs/release-notes/v0.3.0-core.md` 与 `v0.3.0-client.md`，两份都过门禁
  （`--link-pattern '/blob/[^/\s]+/'`，因为标签不带 `v` 前缀）。
- 验证：`dotnet build SevenStation.slnx` 0 错误；两个 MSI 用 `wix msi decompile` 核过
  （客户端无 Registry 表、Seven Station Core 有 `ServiceInstall`、两边许可页都是 GPL 文本）；
  两个包的 `.sha256` 与文件对应。

## STATUS-019：从 Pi / magpie 恢复会话

- 入口：侧栏「新建对话」右侧常驻一个恢复按钮（原型 A 版）。没配过令牌的新机器仍走引导页。
- 对话框（原型 P1 版）：左列表右预览。列表按工作区分组、按开始时间倒序，能搜标题或工作区；
  每行给标题、时间，已收进对话库的变灰并标「已恢复」。预览给首句、消息数、大小、时间、模型、
  工作目录和最近一条回复。
- 两栏的来源：`Pi` 直接扫 `<agent 目录>\sessions`；`magpie 命令`粘一整条
  `Set-Location -LiteralPath '…'; pi --session <id>`，Seven Station Core 解析出会话 id 再匹配，那一栏是单栏。
- 恢复的语义是**接管**不是复制：对话绑定到原来那个 Pi 会话文件（`pi_session_file`），
  消息按 `user`/`assistant`/`toolResult` 搬进对话库用于渲染，续聊时 `pi --session <文件>`
  接着原来那段跑。验证过：恢复 389 条那段，发一句「只回复两个字：继续」，原 jsonl 从 437 行涨到 438 行。
- 重复恢复直接打开已有那段（`already: true`），不会复制出第二份。
- 扫描带缓存（路径 + mtime + 大小）：197 段冷扫 236 ms，热扫 24 ms。
- 顺手加的：`.modal textarea { min-height: 140px }` 会压住更具体度更低的规则，
  命令输入框带上 `.modal` 前缀才定得住 54 px。

## 归档索引

## 当前主线

- 现在在做什么：0.5.0 出包。相对 0.4.1 的增量是执行代理（Pi 改由登录会话里的代理进程起）、设备配对与令牌、
  更新提示与一键升级、字号设置、路径右键菜单、过程区分段与就地展开。
- 版本号已改成 0.5.0，五处同号：`SevenStation.Core.csproj` 的 `<Version>`、Control 与 Desktop 的
  `Cargo.toml` 与 `tauri.conf.json`。
- 发布说明 `docs/release-notes/v0.5.0.md` 已过门禁（23 行）；出包后按 `build/release/v<版本>.md` 的格式补构建信息表。
- 发版前还要做：`node scripts/ui-smoke.mjs --cwd <目录>`（真调模型，客户端也要起来）、两个 MSI 出包、
  在干净环境真装真卸。第 4 项这台机器做不了——它是用户的生产环境。
- 发布物仍是**两个 Windows x64 安装程序**：`SevenStationCore-win-x64-0.5.0.msi`（含 Control）与
  `SevenStation-win-x64-0.5.0.msi`。都不做便携版。
- **本机装着的 v0.4.1 是用户的生产环境**（2026-11-19 起他用这两个软件干活）：测试一律用
  `SEVENSTATION_PROFILE=test` + 临时 `SEVENSTATION_CORE_HOME` + 8899 端口，详见 `AGENTS.md` 的「生产与测试隔离」。
- 2026-11-19 起用户把日常开发搬到这里来用（正式版，现在是 `v0.4.1`）。装前备份在
  `%USERPROFILE%\SevenStation-backup-20261119-1458\`；工作区都在 Seven Station Core 那台机器上，
  客户端设备的本地文件不参与。
- 已发布（2026-11-19）：Release `v0.4.0` 一个页面，装 Seven Station Core 与客户端的两个 MSI 加各自 `.sha256`；
  0.3.0 也按同一形态重做成 `v0.3.0`。标签只有版本号，一版一 Release。
- 已知阻塞：无。
- 已知限制（写进发布说明）：Seven Station Core 目前只放 Windows 包，之后会出 Linux 版；局域网限本地子网、没做 TLS；
  手机窄屏未调；数据库没有版本化迁移，只有「查列再补」这一处临时逻辑。

## STATUS-082：升级通道（2026-11-22）

接着 STATUS-081 把「升得动」补上。

- `Agents/PiUpgrader.cs`：经执行代理起 `node pi-launcher.js update --self|--extensions`，PATH 第一段
  是 Pi 自带的 node 目录（系统那个 node 20 会直接死在 `enableCompileCache`），5 分钟超时挡在中间，
  失败原因取输出最后一行。
- 升级顺序：先 Pi 再扩展；有对话正在跑就拒（它会把旧版本目录收拾掉，正在用的进程指着那边）。
  连上时若还没查过，先现查一次再决定「有没有要升级的东西」。
- 结束先说结果再重查：卡片立刻翻面，版本号随后跟上（重新查要打 npm/git，不能让用户干等网络）。
- 界面：提示条与运行时卡片上的「升级」都发 `upgrade_pi`；过程沿用 `statusToast()`——
  同一张卡片从「正在升级…+转圈」翻成「已升级」，不弹第二个。升级期间按钮按住。

验证（沙箱，`work/smoke` 里已清理）：假 launcher 走完「Core → 管道 → 代理 → 子进程」全程，
确认参数是 `update --extensions`、`PATH` 首段是 pi-node；失败路径回的是 launcher 自己的报错。
`scripts/ui-tests/upgrade-flow.test.js` 锁住「一张卡片翻面 / 重复点不重复发 / 失败说清还在哪个版本」。

**事故记录**：这一轮第一次试跑时，手写的临时 `settings.json` 反斜杠被吃掉了，Core 读不出来就自动探测
到了真安装，点下去等于真的执行了 `pi update --self`——本机 Pi 已从 1.5.2 升到 1.6.0。
升级本身是成功的（1.6.0 仍支持 `--mode rpc` / `--append-system-prompt` / `--session`，
旧版本目录 `1.5.2` 还在，会话没断），但这是不该发生的：验证升级先用日志里的
「找到 Pi：…」确认指向临时目录，再点。

## STATUS-081：只读更新（版本可见 + 每 6 小时查一次，2026-11-22）

只做「看得见」，还没做「升得动」。

- Core 新增 `Agents/PiUpdates.cs`：判定照 Pi 的 `checkForAvailableUpdates()`——钉住的一律跳过、
  npm 比 semver、git 拿上游分支比 `ls-remote`、任何异常都当没有更新。Pi 是哪个 npm 包从
  `install/releases/<版本>/package.json` 的 dependencies 里读，不写死包名。
- 节奏：启动后 20 秒一次，之后每 6 小时；手动「检查更新」有 10 分钟缓存，并发只打一次网络。
  新客户端连上直接拿缓存（`Join` 里补一条 `updates`）。
- 界面三处：输入框上方提示条（有新版才露，`稍后`＝本次不再提醒）、侧栏「扩展」行数字左边的紫色图标
  （只在有扩展可更新时亮）、设置页「运行时」卡片（Pi 与扩展的版本、可更新清单、检查更新）。
  提示条的「查看」先跳到运行时卡片；升级通道做好后换成「升级」。
- 紫色 `--upd`（亮 `#7357e8` / 深 `#a78bfa`）只用在更新这条线上。

验证：临时 home 起 8899（`work/smoke/upd-home`）跑 `node scripts/check-updates.mjs`，实测
Pi 1.5.2 → 1.6.0、TokenEconomizer 4a04fe4 → 1bfeccd、钉住的 `pi-smart-compact@v2ex-recovery`
只报提交不比远程；界面用 CDP 截图核过亮/深两套。`scripts/ui-tests/updates-strip.test.js` 锁住
「有更新才露 / 稍后只管这一次 / 没有更新不出声 / 文案不出现内部术语」。

## STATUS-080：更新图标尾巴加长（原型 v6，2026-11-22）

用户说「箭头尾巴有点短，第一眼看不出是往上的」。第一版 shaft 只有 6.35–9.65（长 3.3），
16~18px 下头几乎贴着尾根。现在改成 **5.8–10.2（长 4.4）**、头宽 2.8，墨迹中心仍精确落在圆心（0.00px）。

原型里留了三档对比（3.3 / 4.0 / **4.4** / 4.8）：4.8 顶到圆边显挤，4.0 略保守。
截图 `design/shots/updates-proto-v2-icons.png`，说明在 `docs/research/updates-2026-11.md` 6.6。

## STATUS-079：更新图标加大 + 换升级专用紫 + 侧栏图标挪到数字左边（原型 v5，2026-11-22）

三条改动：

1. **颜色**：土黄/橙换成**升级专用紫**（浅色 `#7357e8`、深色 `#a78bfa`，变量 `--upd`）。这个紫色只出现在
   「有更新」这条线上（提示条图标、侧栏徽标、设置页状态位），不挪去染按钮或导航选中。
2. **尺寸**：图标加大 —— 提示条 18px（原 15）、侧栏 16px（原 14）；形状仍选 A（圈里向上箭头）。
3. **侧栏位置**：图标放到数字**左边**，两者一起放在 `margin-left: auto` 的尾部簇里，
   所以所有行的数字仍然右对齐（`扩展  ⊕ 7`，7 的右边缘与「对话 2」「技能 18」对齐）。

截图 `design/shots/updates-proto-v2-{light,dark,icons}.png`；说明在 `docs/research/updates-2026-11.md` 6.3 / 6.6。

## STATUS-078：更新图标改成向上箭头，并按墨迹实测居中（原型 v4，2026-11-22）

用户指出两点：方向反了（有新版 = 升级 = **向上**向上箭头；向下箭头是「下载文件」），以及上一个图标
箭头没在圆圈正中。

- 四个候选全换成向上语义：A 圈里向上箭头（描边 1.4）、B 同形粗一点、C 向上箭头 + 底座、D 圈里两个尖角。
  **选 A**：语义对、小尺寸干净。
- 居中不再靠目测：原型里对每个候选的 `path` 跑 `getBBox()`，算墨迹外框中心与圆心 (8, 8) 的距离，
  四张卡片底部直接打印偏差。改完后 A/B/D 都是 **0.00px**（上一版 A 是 7.95，偏 0.05；向下那版偏得更多）。
- 「图标按墨迹 bbox 对齐容器中心」写进了 AGENTS 的界面约定。

截图 `design/shots/updates-proto-v2-{light,dark,icons}.png`，说明在 `docs/research/updates-2026-11.md` 6.6 节。

## STATUS-077：更新图标 + 失败自动退回 + 「稍后」语义（原型 v3，2026-11-22）

用户定下来的三条，原型与文档同步改了：

1. **检查间隔 6 小时照准**；
2. **不做「退回并重启 Pi」按钮**：升级流程是「装到一边 → 确认能启动 → 才切换」，起不来就丢掉新版、
   保持旧版本，用户只看到「升级没成功，还在 1.5.2」；
3. **「稍后」= 本次打开不再提醒**（只记内存，重开客户端会再提）；
4. 另外要求：光靠颜色点不够，得有个**看得出是「更新」的图标**。

图标出了四个候选（`design/shots/updates-proto-v2-icons.png`，原型里 `?only=icons` 可放大看）：
**选 A「圈里向下箭头」**——小尺寸清楚，也不和刷新/重试的循环箭头混。同一枚用在主界面提示条（15px）、
侧栏「扩展」行末（14px）、设置页状态位。

截图：`design/shots/updates-proto-v2-{light,dark,icons}.png`；设计说明在
`docs/research/updates-2026-11.md` 第六节（6.2 / 6.3 / 6.5 / 6.6）。

## STATUS-076：更新提示改为主界面可见 + 定期检查（原型 v2，2026-11-22）

用户要求两点：一是 UI 文案别说「冒烟」这类内部词；二是检查更新不能纯手动，查到就要在主界面提示，
点一下直接升级（Pi 本体在输入框上方，扩展在侧栏「扩展」那一行）。

- **检查节奏**：启动后 20 秒 + 每 6 小时，结果缓存；失败不提示，只在设置页写明原因；`PI_OFFLINE`/断网直接跳过。
- **主界面提示条**：输入框正上方一条，`Pi 有新版本 1.5.2 → 1.6.0 [稍后] [升级]`，点「升级」原地变进行中，
  完成后变绿并自动消失；「稍后」= 本机今天不再提。
- **侧栏**：「扩展」数字始终是装了几个，有新版多一个橙点；设置页「运行时」卡片仍是完整入口（含扩展与模型目录）。
- **文案全部改成人的说法**：`升级没成功：新版本装好了但打不开，这台电脑的 node 版本太旧。已经保持原样，还在 1.5.2。`
  这类，对照表见原型 F 区。

原型 `design/updates-proto.html` 与截图 `design/shots/updates-proto-v2-{light,dark}.png` 已更新；
设计说明在 `docs/research/updates-2026-11.md` 第六节。

## STATUS-075：版本与更新的界面原型（2026-11-22）

原型 `design/updates-proto.html`（引用真实 `styles.css`；`?theme=dark`、`?fs=xl` 可看变体），
截图 `design/shots/updates-proto-{light,dark}.png`。四块：

- **设置页「运行时」卡片**：Pi 版本 → 最新版 + 状态徽标（有新版 / 已是最新 / 检查中 / 检查失败 / 正在升级）
  + [升级 Pi][检查更新]；模型目录刷新并入同一卡片。
- **扩展页**：页头 [检查更新]；行内只多一个「有新版 <短提交>」；钉住/本地包直接写「不检查更新」。
- **进度**：沿用现有 toast 卡片，进行中 → 结果原地翻面，失败带原因；失败后给「回退并重启 Pi」卡片（只能回一步）。
- **技能页**：只加来源标签，不加版本。

待用户定的三点：升级入口是否也在侧栏提示、检查更新是否自动、要不要回退按钮。

## STATUS-074：扩展「有新版」的判定照 Pi 自己的规则（2026-11-22）

用户要求：别自己发明判定，查 Pi 怎么界定扩展有没有更新，按那个来。查到并核对了
`dist/core/package-manager.js` 的 `checkForAvailableUpdates()`：

- 只查全局 + 项目的 `packages[]`，跳过 `temporary`；**`pinned` 一律跳过**（npm 精确版本号、
  git 任何 ref —— `buildGitSource` 里 `pinned: Boolean(args.ref)`）；
- npm：`npm view <spec> version --json`，`semver.gt(最新, 已装)`；
- git：`git ls-remote origin refs/heads/<上游分支>`（来自 `@{upstream}`，非 `origin/*` 退回 `HEAD`）
  与本地 `rev-parse HEAD` 比，不同就是有新版；**用 ls-remote，不 fetch、不碰工作区**；
- `PI_OFFLINE` 时不查；任何异常都当「没有更新」。

用这套原命令在本机核了一遍：4 个 npm 全部最新；git 里只有 **TokenEconomizer 有更新**（4a04fe4 → 1bfeccd），
pi-v2ex-quota 一致，pi-smart-compact 钉住被跳过（且其上游 `origin/v2ex-recovery` 也没新提交）。
顺带修正早先的错误判断：拿默认分支 `origin/HEAD` 去比是错的，Pi 比的是当前分支的上游。

另外记下 Pi 升级时的破坏性行为：git 包是 `git reset --hard` + `git clean -fdx` + 装依赖，
**本地改动会丢**；npm 包装 `@latest`（或配置里的 spec）。

方案文档同步改在 `docs/research/updates-2026-11.md` 的「三、方案」与「四点六」两节。

## STATUS-073：隔离实跑 pi update（2026-11-22，未动产品代码）

在 `work/smoke/pi-home`（真实 `~/.pi/agent` 的副本，不含 sessions）上跑 `pi update --self`，标准输入接 `/dev/null`：

- 系统 node **v20** 在 PATH 上 → 失败（staging 冒烟报 `enableCompileCache` 不存在，那是 Node ≥ 22.8 的 API）；
- 把 pi-node **v22.23.3** 放 PATH 最前 → 34 秒成功，`1.5.2 → 1.6.0`，全程无提问。

同时确认：`settings.json` / `models.json` md5 不变（1.6.0 唯一的迁移是 legacy apiKeys → `auth.json`，
本机已有 `auth.json` 故跳过）；失败不留残骸（`current-version` 不变、staging 已清）；旧版本只留一步
（升级后 1.5.1 被删）；1.6.0 的 `--append-system-prompt` / `--mode rpc` / `--session` 都在，
`get_state` 握手 `success: true`。

**最重要的一条**：升级过程用的是 **PATH 里的 node 与 npm**（`npm ci` 与 `.bin/pi.cmd`），
不是我们平时起 Pi 用的那个绝对路径 node。升级时必须把 pi-node 目录塞进 PATH 最前面。

细节与命令见 `docs/research/updates-2026-11.md` 的四点六节；日志留在 `work/smoke/exp-ok.log` 与
`work/smoke/exp-node20-fail.log`（已忽略，不进库）。

## STATUS-072：技能、扩展、Pi 自身的版本与升级（调研，2026-11-22）

用户提出：技能、扩展、Pi 本身的升级现在界面里看不到，先调研出方案。方案写在
`docs/research/updates-2026-11.md`，本轮不动代码。

关键实测：Pi 装的是 1.5.2，npm 上已经有 1.6.0；7 个扩展里 4 个 npm 全是最新，3 个 git 里
TokenEconomizer 与 pi-smart-compact 远端有新提交（后者钉在 `@v2ex-recovery`，要按钉的分支比）；
18 个技能都是本地目录、没有 `.git`，也没有版本字段 —— 技能没有「版本」这个概念。

## STATUS-071：路径链接的右键菜单换成自己的（2026-11-22，未发版）

用户反馈：在 Seven Station 里对带完整路径的文件按右键，弹的是浏览器那三项
「在新窗口中打开链接 / 将链接另存为 / 复制链接」——对文件路径没有任何意义（链接的 href 就是 `#`）。

**做法**：路径链接（`.link-path`）上的 `contextmenu` 一律 `preventDefault()`，换成页内小菜单：

| 菜单项 | 说明 |
| --- | --- |
| 打开 | 原有行为（`reveal_path`，文件给默认程序、目录开文件夹） |
| 打开所在目录 | 新壳命令 `reveal_in_explorer` → `explorer.exe /select,<路径>` |
| 复制路径 | 路径文本进剪贴板（给只收文本的聊天框） |
| 复制文件 | 新壳命令 `copy_file` → 文件本体进剪贴板，可直接粘贴 |

网址链接不动（浏览器那套对网址是有用的）。在浏览器里打开 Seven Station 时只显示「打开 / 复制路径」，
因为后两项要靠壳（剪贴板属于当前登录会话，Core 在 Session 0 里碰不到用户的剪贴板）。

**两个坑（都是这台 Windows 上的）**：

- `fs::canonicalize` 会给路径加 `\\?\` 前缀，带这个前缀进剪贴板别人读不了；落盘前必须用 `plain_path()` 去掉
  （UNC 的 `\\?\UNC\` 还原成 `\\`）。
- 子进程用 `Command::status()`（继承 stdio）调 PowerShell 会卡到超时、返回非零；换成 `.output()` 秒回。
  顺带的好处：失败时能把 stderr 带出来。

**验证**：

- jsdom：`scripts/ui-tests/path-context-menu.test.js` 14 条 —— 右键被拦下、菜单项随环境变化、
  `copy_file` / `reveal_in_explorer` 的调用参数、点别处与 Esc 收起、网址链接保留默认菜单。
- Rust：`cargo test` 3 条（复制成功、不存在的路径报错、`reveal_in_explorer` 报错）。
- 手工：同样的 PowerShell 脚本单独跑一次，剪贴板里能读到文件（`Get-Clipboard -Format FileDropList`）。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`d5e05144548db97b…`）、
`dist/SevenStation-win-x64-0.4.1.msi`（`8ae6009b6bf89d1b…`）——这次两端都动了，客户端也要重装。

## STATUS-070：给 Pi 注入「Windows 常见坑」（2026-11-22，未发版）

用户要求：把 Windows 上最常见、最关键的盲区提前注入给 Pi，别总结太多，要最普遍的那种（比如路径拼接）。

素材来自 `E:/Dev/AgentHistory`（machine/AGENTS.md 的跨机器规则、workspace 流水、本项目归档），挑出反复出现、
代价最大的八条写进 `Agents/pi-guidance.md` 的「Windows 上容易踩的坑」：

1. 反斜杠别经过两层转义：heredoc 喂 python 时双反斜杠会折叠成单个，`\t`／`\n`／`\U` 直接变控制字符，
   路径写坏了 `git diff` 还看不出来；必须内联时用 `chr(92)` 拼。
2. 路径一律绝对、拼接用 `Join-Path`／`Path.Combine`，带空格加引号，别假设 `/tmp` 之类一定存在。
3. 停进程只按 PID，绝不 `taskkill /IM`（按镜像名会连带杀掉用户正在用的进程，本机栽过两次）。
4. `Start-Process` 不能把 stdout 与 stderr 重定向到同一个文件。
5. 控制台是 GBK；脚本写 UTF-8，给 PowerShell 5.1 的 `.ps1` 要带 BOM。
6. 别改换行（CRLF/LF 混用会让 diff 爆成整篇差异）。
7. 改 HKLM、建计划任务、动服务要管理员，要提权就说清楚。
8. 删文件／目录失败多为句柄未放开，先找占用进程。

**验证**：让带注入的 Pi 往文件里写一行带盘符的绝对路径并自己打印十六进制——落盘是
`45 3a 5c 44 65 76 5c …`，三个反斜杠都是单个 `5c`，没有控制字符（19 秒）。

顺便记一笔：写这份 STATUS 时我自己又踩了第 1 条（python heredoc 里的反斜杠被折叠），改用 edit 工具落下才对得上。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`ea53da8b6518414f…`）。

## STATUS-069：让 Pi 用中文思考 / 回答（外加一个并行调用的真 bug）（2026-11-22，未发版）

用户要 Pi 在思考、过程说明、回答里都用中文，方式跟以前一样走 `--append-system-prompt` 注入
（`Agents/pi-guidance.md` 增加「说什么语言」一节）：思考也用中文；命令、代码、路径、标识符、日志与报错原文照抄；
代码注释与提交信息按仓库习惯写中文。

**实测（同一道题跑两次，一次带注入一次不带）**

| | 带注入（中文思考） | 不带（英文思考） |
| --- | --- | --- |
| 最终回答语言 | 中文 | **中文**（Pi 本来就跟着用户的语言走） |
| 思考 | 22095 字，33% 汉字 | 20672 字，2% 汉字 |
| 输出 tokens | 13477 | 7190 |
| 墙钟 | 140 秒 | 84 秒 |

复杂任务上中文思考约 2 倍输出 tokens、更慢；但那一次它还自己写了 jsdom 探针验证（cacheRead 522k vs 241k），
所以差距不全来自语言。简单任务反过来省：中文 105 tokens / 英文 151 tokens（中文更密）。
**结论：最终回答本来就会是中文，注入真正改变的是思考语言；质量没掉（两次都找到了同一个 bug，中文那次还验证了一遍）。**

**顺带修掉它找出来的真 bug**：`updateLiveTurn()` 行数不变时只刷新最后一行，所以一段里并行发几个工具、
先完成的那条不是最后一行时，它会一直显示「进行中」（转圈），直到下一次整轮重画。现在每一行都同步一遍。
`scripts/ui-tests/work-detail-keep.test.js` 加了回归：并行两条里先完成的那条（合并成 `×2` 的那行）不再转圈。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`b22f8f805e008ae0…`）。

## STATUS-068：工作中展开的详情被自动收起 + 上下抖动（2026-11-22，未发版）

用户一边看展开着的步骤详情，一边等新步骤，发现：**新步骤一来，展开的详情就自己收起来了**，
而且画面上下抖。

**两个原因都在「整轮重画」上**：

1. 新步骤进来时，`updateLiveTurn()` 一看行数变了就 `body.innerHTML = ''` 整组重画；
   加上任何一条能让 `patchItem()` 落到兜底的话还会整轮重画——展开的详情节点就此消失。
   详情本来只存在 DOM 里（`openStep` 握着节点引用），节点没了就等于「自动收起」。
   现在改成**只增就往后追加**，前面的行连同展开的详情一个都不动；真要重画（行数变少、
   或者整轮重画）就把展开的那一条按「段键 + 步骤 id」找回来重新挂上（`restoreOpenDetail()`）。
2. `renderThread()` 默认 `scrollToBottom(true)`：同一会话里一有事件就把人拽到底部，
   配合详情收起-展开那一跳，就是上下的抖。现在**只有原来就贴底才跟随**，换会话才强制到底
   （`app.renderedKey` 记着上次画的是哪个会话）。

**验证**：jsdom 新增 `scripts/ui-tests/work-detail-keep.test.js`——新步骤进来后原来那一行的节点没被重建、
详情仍然展开且内容不变、行数是追加的；整轮重画后详情仍在；没贴底时重画 `scrollTop` 保持 0。
10 条断言全过。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`bca29046ec500ffc…`）。

## STATUS-067：设置里按区域调字号（2026-11-22，未发版）

用户反馈过程区字偏小，要能自己调，而且**改字号不能夹字、漏字、截字**。

**做法**：`styles.css` 里 146 处 `font-size` 全部改写成 `calc(原值 * var(--fs-区域))`，
区域只分三个：`body`（对话正文与正文里的代码）、`work`（过程区步骤与详情）、`ui`（侧栏、输入框、设置页及其余面板）。
`appearance.js` 按设置把三个倍率写到 `<html>` 上（0.9 / 1 / 1.12 / 1.24），跟主题一起存 localStorage，
在 `<head>` 里同步应用，不会先闪一下标准字号。

设置页新增「字体大小」卡片：三行（对话正文 / 过程区 / 界面）× 四档（小 / 标准 / 大 / 特大），只影响这台设备的显示。

**不夹字的处理**：

- `.kv-row` 的标签原来写死 92px，放大后「Seven Station Core」被挤成两行；改成 `min-width: 92px` + 不换行，
  值那一列不再用省略号截断，放不下就折行。
- 卡片里的说明行与下面的内容之间补了间距。

**验证**：无头 Edge 在四档下各跑一遍，逐个查 `overflow: hidden` 且内容超出容器的元素——除会话名与
长路径这两处「本来就该省略、且带 title」的之外没有命中；对话（含展开的详情）、设置页、技能页在 特大 下截图核对正常。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`cd5c212a0c191b93…`）。

## STATUS-066：过程区四个滚动条（2026-11-22，未发版）

展开一条详情后，右侧挤着四个滚动条：对话、过程区、详情卡片、详情里的输出块各滚各的，
滚轮到底在滚哪个不知道。

**改法**：详情与输出块都不再自己滚，过程区里只留 `.work-body` 一个滚动框（对话本身一个）。
详情顺着内容长，超出就在过程区里滚；输出再长也不额外开框。

**验证**：无头 Edge 里展开一条 120 行输出的详情，数页面里纵向能滚的容器，
展开前 0 个、展开后只剩 `work-body` 一个。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`851b9f00fe0538ee…`）。

## STATUS-065：空白思考也占一行（2026-11-22，未发版）

用户点开最近一轮的「思考」行，详情是空的。

查生产库确认：那一轮里有一条 thinking 块的正文是**一个空格**（`thinking: " "`，模型自己给的就是空白）。
数据没丢，界面也就老老实实画了一行「思考」，点开自然什么都没有，还平白多算一步。

修法：`turnParts()` 里跳过 `trim()` 之后为空的 thinking 块，不画、不计数。
历史与正在跑的都用同一个判断，`thinking_start` 一开一关不会闪出一行空步骤。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`5eddc8ef40e8d9cf…`）。

## STATUS-064：过程区按回答分段 + 详情回到就地展开 + 草稿按会话隔离（2026-11-22，未发版）

用户在一张单子上提了四件事，这轮一起做完：回答后另起一段工作、详情回到就地展开、草稿按会话隔离、
流式更新不再整轮重画。

**一、回答之后的工作不该并回回答前那一段**

以前一轮里所有工作步骤并成一块，摆在所有正文前面。于是一轮里出现「工作 → 回答 → 又工作」时，
后面的步骤被塞进回答之前那一块，用户分不清哪些在回答前、哪些在回答后；回答多次更明显。

现在 `turnParts()` 按出现顺序返回 `segments`：工作段、正文段交替，**正文一出现就把前面的工作段封口**，
后面的工具调用开新的一段，排在正文后面。折叠状态和滚动位置按段记（键是 `turnKey#段号`）。

**二、去掉独立的过程查看弹窗**

`.sm-*` 那套（挂 body 上 fixed 的窗口）整个删掉，回到点一行就地展开（`.st-more`）：
在过程区自己的滚动框里展开，限高 `min(40vh, 300px)` 自己滚，不会把整轮撑变形；Esc 或再点一下收起，同时只开一条。

**三、跨会话草稿误发**

在 A 里打了一段话没发，切到 B 直接回车，那段话就发到 B 去了。现在 `app.drafts` 按会话存草稿，
切会话换一份；发出去就销掉。还没有会话时打的字会在会话建好时认领成它的草稿。

**四、顺带修掉整轮重建**

正在跑的一轮里，每来一条事件原来会整轮重画。现在：正文在长只换最后一个 `.md` 的内容；
步骤在长只改那一行（摘要、条数、状态）；步骤数变了只重画这一段的身子；只有结构真变了（比如回答后又有新工作）才整轮重画。

**验证**：jsdom 两个脚本（`scripts/ui-tests/turn-segments.test.js`、`session-drafts.test.js`）20 + 6 条断言全过；
临时 home 里塞了一段「工作 → 回答 → 工作 → 回答」的历史，用无头 Edge 截图确认两个工作段分列在两条正文之间，
点行就地展开正常。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`2f0134473f4a7efc…`）。

## STATUS-063：首次打开显示没连上 —— 任务排期要十秒（2026-11-22，未发版）

症状：装完第一次打开 Control 显示「没连上」，重启之后打开就是「已连上」。

**原因**：`schtasks /run` 只是把请求交给计划任务服务，真正拉起来要几秒到十几秒
（日志里对过：20:52:46 注册并 `/run`，代理 20:52:56 才起，20:53:08 才连上）。
界面那会儿只显示「没连上」，看着就像坏了；重启那次能连上，是因为登录触发早就把代理起好了。

**改法**：

- 界面在「刚叫过它起来」的 45 秒内显示 **正在启动…**，不再直接报没连上；没连上时 2 秒一问，连上后 5 秒。
- 除了计划任务，**再写一份 HKCU 的 Run 键**：登录那一瞬间 Run 键比计划任务快（任务要排期）。
  两个都起也没关系，第二个占不到管道会自己退出。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`eb3dc73ed12378ab…`）。

## STATUS-062：代理被 cmd 窗口带走了 + 状态一直显示没连上（2026-11-22，未发版）

装完 STATUS-061 的包，用户看到：重启和打开 Control 时都会弹一个 cmd 窗口，而且界面一直「没连上」。

**两个真因**：

1. **代理是被那个窗口弄死的**。`SevenStation.Core.exe` 发布出来是**控制台**子系统，计划任务在登录会话里
   拉它，自然弹一个 cmd 窗口；用户一关窗口，进程收到 CTRL_CLOSE，任务结果就是 `0xC000013A`
   （`schtasks /query /v` 里能看到，正好和 runner.log 里十秒一次的重启对上）。
2. **状态接口在骗人**。核心平时是懒连的（真要用 Pi 才连代理），`/api/runner` 只回「现在有没有连接」，
   所以没发过对话时永远是 `connected: false`，界面就一直「没连上」。

**修法**：

- 发布改成 **GUI 子系统**（`<OutputType>WinExe</OutputType>`）：不再有控制台窗口，也就没有 CTRL_CLOSE。
  服务与 runner 都不需要控制台，日志本来就写文件；用 `dotnet dll` 跑时输出照旧（那是 dotnet 宿主自己的控制台）。
- runner 里再补一刀 `FreeConsole()` 兜底。
- 任务 XML 补 `RestartOnFailure`（1 分钟后重试 3 次），真死了不用等下次登录。
- `/api/runner` 改成先主动探一次连接（`RunnerClient.Probe()`），状态页才反映真实情况。

**验证**：

- 发布出来的 `SevenStation.Core.exe` PE 子系统 = 2（GUI）。
- 沙箱里没发过任何对话，直接查 `/api/runner` 就回 `connected: true`。
- 沙箱链路照旧：`✓ 代理链路通了，Pi 回了：收到`；`cargo test --release` 9 个全过。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`83ff3ec66750c298…`）。

## STATUS-061：Control 与 Core 启动就要管理员（2026-11-22，未发版）

用户定：这两个东西**打开就要 UAC，不给权限就不启动**——反正开关、防火墙、服务状态全要管理员，
每次都确认一遍太烦。据此调整：

- **Seven Station Control**：`main()` 里先看权限，没有就以管理员身份重开自己然后退出；用户点「否」就到此为止。
- **Seven Station Core**：不是服务、不在沙箱里、也没有 `--elevated` 标记，就同样重开自己。
- **`--elevated` 标记**：重开时带上它，那份不再要求权限。判定权限的代码万一有毛病，也不会变成无限弹 UAC。
- **放行**：`SEVENSTATION_PROFILE=test`、`SEVENSTATION_CORE_HOME`、`SEVENSTATION_DATA_DIR` 都不拦，否则开发寸步难行。
- 启动日志里多了一句「管理员权限 True/False」，出问题先看它。

**执行代理反而不许提权**：任务 XML 里是 `InteractiveToken` + `LeastPrivilege`，代理拿到普通令牌，
Pi 也就不会继承管理员身份——不然刚统一好的「跟终端里用 pi 一样」又没了。

于是执行代理回到计划任务方案（STATUS-059）：STATUS-060 换 Run 键只是因为非提权建不了带 Principal 的任务；
现在 Control 提权了，任务建得出来，`schtasks /run` 起的又是普通权限进程，正好。

**验证**：`cargo test --release` 9 个全过（含任务 XML 必须 `LeastPrivilege`、必须 `PT0S`）；
沙箱起核心 + 代理 + 真发一句话，`✓ 代理链路通了，Pi 回了：收到`；发布出来的 dll 里确认有新代码。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`5181481b6aa45a2f…`）。

**注意**：Control 每次启动都会要一次管理员（已经开着一个时再点，UAC 过后会并进已有窗口）。

## STATUS-060：计划任务建不起来，改成 Run 键；重启走壳命令（2026-11-22，未发版）

用户装了 STATUS-059 的包，Control 反复重开都显示「执行代理：未注册」。查 Control 的日志：

```
执行代理没挂上：建不了执行代理的登录任务：错误: 拒绝访问。
```

**原因**：`schtasks /create /xml` 里那份 XML 带 `<Principals>`。非提权进程建这种任务会被计划任务
拒绝（我这边用 SYSTEM 测所以一路通过，正好把这条路试漏了）。

**改法**：不再用计划任务，改用 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`：

- Control 每次启动把 `"<exe>" --runner` 写进 Run 键（写自己家的键，不需要管理员也没限制），
  然后直接 spawn 一个代理。已经在跑时新起的那个会因为占不到管道自己退出，所以随手调是安全的。
- 计划任务那套「跑满三天被收掉」的毛病也跟着没了。
- 「重启」改成壳命令 `runner_restart`：`build.rs` 的 `AppManifest` 与 `capabilities/control.json`
  两处都登记了（这次没漏）。它按命令行里的 `--runner` 认人再杀——服务用的是同一个 exe 名，
  只按进程名会把用户正在用的服务一起带走。
- 核心的 `/api/runner` 收窄成 `{ connected, pipe, log }`，`/api/runner/restart` 与 `RunnerTask.cs` 删掉，
  安装包里那条 `schtasks /delete` 的卸载动作也撤了。

**验证**：

- 起一个 `--runner` 的 `SevenStation.Core.exe` 和一个不带参数的（同一个副本），跑 Control 里那条杀进程脚本：
  只有 `--runner` 那个被杀，另一个和**用户正在跑的生产服务**都还在（生产那个还回了「拒绝访问」，说明没碰到）。
- Run 键写入/读回格式对（`"<exe>" --runner`）。
- `cargo test --release` 7 个测试全过。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`d51120f4e9ea7e38…`）。

**遗留**：卸载后 Run 键还留着（指向不存在的 exe，Windows 会静默跳过）。要清得在卸载时按用户清 HKCU，
先记着不做。

## STATUS-059：执行代理的登录任务 + Control 里的状态与重启（2026-11-22，未发版）

STATUS-058 那三条现在都做完了，可以装。

**登录自启**：Seven Station Control 每次启动都会建一遍计划任务「SevenStation Core Runner」
（`schtasks /create /xml ... /f`，任务 XML 里是 `InteractiveToken` + 登录触发 + `ExecutionTimeLimit=PT0S`），
建完顺手 `/run`，所以装好第一次打开 Control 就生效，不用注销重登。换成 exe 路径变了的老任务也没关系，
每次都带 `/f` 重建。卸载时 MSI 自己把任务删掉（`WixQuietExec` 里调 `schtasks /delete`）。

任务必须由用户这边建：服务账户建不了「跟着某个用户登录跑」的任务。核心只负责查询状态和叫人重启。

**状态与重启**：

- 核心新接口 `GET /api/runner` → `{ connected, pipe, task, registered, account, log }`；
  `POST /api/runner/restart` → `schtasks /run`，任务没注册时回 409 并说明去哪打开。
- Control 的连接卡片多一行「执行代理」：`已连上` / `没连上` / `未注册`，下面配一句为什么，
  右边一个「重启」按钮（走已有的 `core_api`，没新增壳命令，省掉一次 ACL 登记）。

**验证**：

- 计划任务那套 XML 用真实 `schtasks /create|query|run|delete` 跑过一遍（rc 全 0，登录状态是「交互式」）。
- 沙箱核心（临时 home、8958 端口）：没连上时 `connected:false`，真发一句话后变 `true`；
  不带令牌 401；任务没注册时 `restart` 回 409 和那句提示。
- `cargo test --release` 9 个测试全过（新加 3 个锁任务 XML：必须带 `--runner`、必须 `InteractiveToken`、
  必须 `PT0S`、XML 特殊字符要转义、XML 文件要 UTF-16 带 BOM）。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`d6b3073a52f685ce…`）。

**还没验的**：普通（非管理员）用户建自己的登录任务这条路，以及装完之后「客户端里调工具是否跟终端一致」。
这两条只有用户那边能验。

## STATUS-058：Pi 改由用户登录会话里的执行代理来起（2026-11-22，未发版）

**为什么改**：服务跑在 Session 0 / SYSTEM，Pi 作为它的子进程也一样。用户实测在客户端里调工具
比在终端里用 Pi 慢很多、也费 token（npm/node 找不到、凭据不对、生成的文件 owner 变成 SYSTEM），
起 GUI 程序还看不见窗口。根因不是缺几个环境变量，是进程站错了会话。
用户拍板：底层要跟「用户在终端里用 Pi」完全一致；Windows 只是过渡，后面主目标是 Linux，
「没登录 / 注销就不能用」是能接受的结果。

**做法**：同一个 exe 两个角色。

- `SevenStation.Core.exe`（服务，SYSTEM）：对话库、WebSocket、托管页面，**不再直接起 Pi**。
- `SevenStation.Core.exe --runner`（登录后自启，用户会话）：只做一件事——按核心给的 exe/参数/cwd
  起进程，把 stdin/stdout/stderr 转回去。Pi 怎么用、说什么话仍然全在核心这边（Agent 边界不变）。
- 两者之间一条命名管道（`\\.\pipe\sevenstation-runner`，`SEVENSTATION_RUNNER_PIPE` 可改），
  上面跑按行 JSON、按会话 id 分帧：`start` / `line` / `eof` / `kill` ←→ `started` / `out` / `err` / `exit` / `failed`。

**判定**：`Process.GetCurrentProcess().SessionId == 0`（或账户名是 SYSTEM）就必须走代理；
连不上就明确报错（「Pi 需要在已登录的桌面会话里运行……」），**不回落成 SYSTEM 起 Pi**——
回落等于把这次要修的问题悄悄装回去。

**代码**：

- 新 `Rpc/IPiTransport.cs`、`Rpc/ProcessTransport.cs`、`Rpc/PiCommand.cs`、`Rpc/PiHost.cs`、
  `Rpc/RunnerClient.cs`（客户端 + `RunnerTransport` + 按行读写的桥）、`Runner/RunnerHost.cs`（`--runner` 那半边）。
- `Rpc/PiSession.cs` 换成吃 `IPiTransport`，其余 RPC 逻辑没动。
- 去掉 Pi 子进程的 `USERPROFILE`/`HOME` 覆盖：那套是给 Session 0 打的补丁，现在两边环境本来就对，
  再覆盖反而会把配置指错（实测指到了 systemprofile，Pi 报 `No API key found`）。
- `CoreSettings`：`PI_AGENT_DIR` 指到某个用户目录时，`Home` 以前一律写成进程自己的家（服务下就是
  systemprofile），改成从 `<家>\.pi\agent` 反推；另外把已经写错的 systemprofile 一并纠正。

**坑（血的）**：命名管道同步句柄上，挂着的阻塞读会把同一句柄上的写一起卡住——核心连上代理后
`WriteLine` 直接死等，看着像「代理没收到」。两端都必须 `PipeOptions.Asynchronous`。

**验证**：`node scripts/runner-smoke.mjs --port <非8787> --home <临时home> --cwd <目录>`
（临时 home、临时管道名，Pi 用 `magpie/auto/deepseek-v4.1-flash`）。

- 有代理：`✓ 代理链路通了，Pi 回了：收到`，代理日志里有 `起进程 …`。
- 没有代理：界面报「Pi 需要在已登录的桌面会话里运行……」，不回落。

**还没做（不做完这个功能不能发版）**：

1. 代理的登录自启（计划任务，当前用户、无需管理员）与卸载清理。
2. Seven Station Control 显示代理状态、能给个「重启代理」。
3. 安装包里带上这两件事——否则装上新版本的机器根本起不了 Pi。

## STATUS-057：core_api 真的连不上 —— 请求头被写成了裸 LF（2026-11-20，未发版）

补完 ACL 之后还是不行，弹窗报「Seven Station Core 回了一段看不懂的响应」。

**根因**：`core_api` 里手写的 HTTP 请求，`

` 在生成代码时被写成了**真正的换行**（字符串字面量里是裸 LF）。
于是请求头全是坏的：请求行后面直接空行，Kestrel 当成「没有 Host 头的 HTTP/1.1」回 400，
而解析那头找的又是四个换行连在一起，永远找不到 → 报「看不懂的响应」。

**修法**：

- 拼请求单独抽成 `build_request()`，用一个地方写 CRLF；`core_api` 只调它。
- 解析改成 `split_headers()`：先认 `CRLFCRLF`，退化再认 `LFLF`；`dechunk()` 同样先认 CRLF 再认 LF。
- 补 6 个单元测试锁住这些（`cargo test --release`）：请求行/头必须带 CRLF、头后要有空行、去 CRLF 后不能有裸 LF、
  chunked 单块与多块拼接。

**顺带**（用户提的）：出错时那句「读不到设备列表，先确认 Seven Station Core 在运行」是废话 ——
服务在不在运行看主界面状态卡就知道。改成直接摆原因：「读不到设备列表：<错误原文>」，顶部那行只写「读不到」。

验证：raw socket 打沙箱 Core（临时 home，只按 PID 停）确认响应是 `HTTP/1.1 200` + CRLFCRLF，
`/api/devices`、`/api/addresses`、`POST /api/devices` 都是 chunked，`/api/qr` 带 Content-Length；
两种正文都能被新解析拿到。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`5ac2cc3a65de9409…`）。

## STATUS-056：弹窗里「思考」不换行、Control 的 core_api 被 ACL 拦住（2026-11-20，未发版）

装完 STATUS-055 之后用户报两条：

1. **弹窗里的思考文字不换行**，一行被截在右边，还多出一条横向滚动条。
   原因：`renderStepModal()` 给思考那块用的 class 是 `.sm-code`，但样式表里只写了 `.sm-body .st-code`，
   `.sm-code` 没定义 → `<pre>` 用浏览器默认的 `white-space: pre`。
   修法：补 `.sm-code`（正文衬线换成界面字体、`white-space: pre-wrap`、`word-break: break-word`、最高 320px 自己滚）。
2. **添加设备整块不能用**，弹窗里写「读不到设备列表」，页面右下角报 `Command core_api not allowed by ACL`。
   原因：加 `core_api` 时只写了 `generate_handler!`，忘了登记 **`build.rs` 的 `AppManifest`** 与
   **`capabilities/control.json`** 的 `allow-core-api`。Tauri 2 的自定义命令要两处都登记，缺一个就在运行时被 ACL 拒掉。
   修法：两处补上；`cargo build` 后 `permissions/autogenerated/core_api.toml` 自动生成，
   `gen/schemas/capabilities.json` 里也出现了 `allow-core-api`（确认编译进去的是新能力表）。

顺带：设备列表、地址下拉、二维码生成都走同一个 `core_api`，所以这一处一漏整块功能都点不动 —— 以后新增壳命令先改这两处。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`37cf01d73029f15f…`，Control 在 Core 包里）。

## STATUS-055：过程区改成「点击看弹窗 + 自己滚动跟随」（2026-11-20，未发版）

用户定了原型 `work/proto-worklog.html` 的方案，一次改三件：

1. **点一行不再就地展开**，改成弹窗（`.sm-scrim` / `.sm-dlg`）：
   标题是步骤种类 + 时间，下面一行状态与用时、工作目录；正文沿用 `appendSections()` 摆命令、输出、改动；
   合并起来的那一组用 `.sm-tag` 逐条分隔。Esc 关闭，← → 翻上一条/下一条，底部也有按钮。
   弹窗挂在 `body` 上 fixed（跟文件面板一样），不受输入区裁剪影响。
2. **过程区自己滚动**：`.work-body` 限高 `min(48vh, 340px)`，`scrollbar-gutter: stable`。
   贴着底（`nearBottom()`，24 px）才跟随新步骤；用户往上翻就冻在原地，顶部渐变提示上面还有内容。
3. **不在底部时浮出「回到最新（n 条）」**：条数是翻上去之后新出现的步数，点一下回到底部并清零。

配套清理：删掉 `closeOpenItems()`、`.st-body`、`.st-group-body`、`.st-time`、`timeText()`、
`session.ui` 的 `groups`/`steps`；`uiOf()` 只剩 `work`。行尾悬停露出「详情」，让「能点」看得见。

验证（jsdom 里加载真页面 + 假会话）：

| 项 | 结果 |
| --- | --- |
| 过程区结构 | `.work-body` / `.work-latest` 都在，按钮默认隐藏 |
| 就地展开残留 | `.st-body` 0 个 |
| 点一行 | 弹窗出现，标题「思考」，状态「完成·用时 300 毫秒」 |
| 下一条 | 标题变「执行命令 ×3」，组内 3 个分隔标记 |
| Esc | 弹窗关闭 |
| 就地更新 | 内容没变时转圈节点**原样保留**；跑完变 ✓ 且转圈消失 |
| 收起 | 点标题后 `.work-scroll` 跟着隐藏 |

滚动跟随依赖真实布局，jsdom 没有布局，只能靠结构和入口验；真机上看一眼。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`74f17275e22d87dc…`）。

## STATUS-054：步骤上的转圈会「卡住」（2026-11-20，未发版）

用户报：最新一步的转圈动画时不时卡住。不是后端的事，也不是 CSS：**动画被重画重置了**。

原因两条，都落在过程区的增量更新上：

1. `updateLiveRow()` 每来一条事件就 `state.replaceWith(stepStateNode(entry))` —— 状态节点整个换新的，
   `.spin` 上的 `animation` 从 0° 重新开始。事件密的时候永远停在 0° 附近，看着就是不动。
2. 更狠的一条：`patchItem()` 在「这一轮开始出正文」或「换了一步」时会整轮重画，同样把动画打回原点。

改法：

- `sameState()`：状态节点内容（class / title / 文字 / 有没有在转）没变就不替换，留着老节点让它继续转。
- `spinPhase(900)`：新建转圈节点时算 `animation-delay: -<performance.now() % 900>ms`，
  把相位钉到墙上时钟。哪怕整轮被重画，新节点的角度也刚好接上，看起来是连续在转。
  侧栏的 `.session-spin` 同样处理。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`c7a3d71f81de3de5…`）。

## STATUS-053：对话框里冒出空灰条、空地址框（2026-11-20）

装完新版打开「添加设备」看到的两个毛病，同一个根因：**元素自己写了 `display: flex`，把 `[hidden]` 盖掉了**。

- 顶部那条空灰条 = `#deviceSummaryRow`（`.summary` 是 flex），本该在生成前隐藏。
- 空的地址下拉 = `#deviceAddressRow`（`.field-row` 是 flex），局域网没开时本该隐藏。

修法：样式里加全局兜底 `[hidden] { display: none !important; }`（这坑 AGENTS 里早写过，Control 这边漏了）。
顺手：Core 没起来时「已配对的设备」下面不再是空白，改成一行为「读不到设备列表，先确认 Seven Station Core 在运行。」

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`01d1b0a2d71e3029…`）。

## STATUS-052：dist 只留当前版本的包（2026-11-20）

用户嫌安装时挑不清哪个是最新包。清掉 `dist/` 里的 0.4.0 三件套（msi、sha256、wixpdb），
并在两个打包脚本里加了一步：打包前把 `dist/` 里**版本号不是当前版本**的 `*-win-x64-*.msi*` 与 `.wixpdb` 删掉。
顺手补上 `wixpdb` 的覆盖删除（原来只删了 msi 与 sha256）。

验证：故意塞回 `SevenStationCore-win-x64-0.4.0.msi` 与 `SevenStation-win-x64-0.4.0.msi.sha256`，
跑一次 `build-installer-center.ps1`，两个假文件都被清掉，`dist/` 只剩 0.4.1。

## STATUS-051：点路径直接打开文件（2026-11-20，未发版）

用户要求的：路径点到文件就直接打开那个文件，别再开资源管理器把它选中。

- 桌面壳 `reveal_path`：`explorer.exe <路径>` 一句话搞定两种——目录开文件夹，文件用关联程序打开
  （原来文件走 `/select,`，只是选中）。先 `fs::metadata` 确认存在，不存在就直接报「找不到这个路径」，
  不让 explorer 自己弹框。
- Core 的兜底 `RevealPath()` 同步：`ArgumentList.Add(path)`，并删掉没用的 `isDirectory`。
- 前端链接悬停提示从「在资源管理器里打开」改成「打开这个路径」。
- 给 Pi 的说明也改口径：点路径直接打开（目录开文件夹、文件用默认程序），所以给路径要给到具体文件，
  别只给目录让人自己找。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`8bfe546e3fb561f0…`）、
`dist/SevenStation-win-x64-0.4.1.msi`（`91da2b0c3353a499…`）。

## STATUS-050：给 Pi 的界面说明补上「你在 Seven Station 里」（2026-11-20，未发版）

用户提的：Pi 一直以为自己在跟终端里的人对话，答话方式还是终端味。它确实不知道自己在 Seven Station 里跑。

机制本来就有：`PiSession` 启动 Pi 时用 `--append-system-prompt` 把 `Agents/pi-guidance.md` 塞进系统提示
（原来只写了「路径和网址怎么写才可点」）。这次把内容扩成三节：

- **你在哪儿、和谁说话**：Pi 是 Seven Station Core 的子进程；用户在看客户端（桌面/手机/浏览器），
  可能同时开两个客户端看同一个线程；工具调用只显示成一行步骤、输出默认折叠，所以结论要写进正文；
  没有 PTY，全屏程序、方向键、交互确认都无意义；别假设用户有键盘和大屏。
- **干活的样子**：每个命令要有明确目的（步骤摘要就是用户唯一线索），一次推进一件说得清的事。
  2026-11-20 补两条：用户可以直接贴图片/截图（当作消息里的图片给你看，不用让他再描述）；
  用户会随时插话——跑着的时候还能发消息，Core 排队等这一轮结束再交给你，也可能直接点停止打断你。
- **可点的地址与路径**：先分清「给用户照着去用的」还是「说明里提一下」——要用的（网站、服务地址、端口、目录、文件）
  一律写完整（带协议头、带端口、带盘符），客户端才认得出、才能变链接；纯说明/举例的不用刻意补全，
  但也别让半截地址看起来像要点的目标。同一个目标只写一次完整写法。

验证：本机直接起一次 Pi（`--mode rpc --append-system-prompt <新文件>`，1150 字 36 行），`get_state` 正常回
`auto/deepseek-v4.1-flash`，说明多行参数没问题。探测用的子进程按 PID 停掉，没动正式服务里的会话。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi` 43.8 MB（`8b0f84568778e89d…`）。
新说明在**下一个新起的 Pi 子进程**里生效：重开对话、重启 Core、或子进程退出后再发消息都会重起子进程；
正在跑的这一轮仍是旧说明（说明是同一次子进程启动的参数，改不了已经在跑的）。

## STATUS-049：单设备令牌 + 扫码配对 + 网页版填令牌（2026-11-20，未发版）

按 Android 规划的落地顺序先做前两步（Core 侧 API、Control 的「添加设备」），顺带把网页版的令牌入口补上。

**Core**

- 新表 `devices`（`Storage/DeviceStore.cs`）：id / 名字 / 令牌 / 创建时间 / 最后在线 / 作废时间。
- 鉴权规则：`/ws` 接受**主令牌**或**任一未作废的设备令牌**；管理接口只认主令牌（设备令牌不能给自己再发一个）。
- 新接口（都要主令牌）：
  - `GET /api/addresses` —— 本机私网地址（10/8、172.16/12、192.168/16），带网卡名；
  - `GET /api/devices`、`POST /api/devices`（`{name}`）、`POST /api/devices/{id}/revoke`；
  - `GET /api/qr?data=…` —— 返回 **SVG** 二维码（QRCoder 1.6.0）。用 SVG 是为了 Control 那边不用处理二进制。
- `TokenStore` 拆出 `Provided(context)`，`Matches()` 复用。

**网页版**

- 令牌来源：地址栏 `?token=` → `localStorage`。带 `?token=` 打开时存下来并把它从地址栏抹掉（`history.replaceState`），
  免得留在浏览记录里。
- 设置页新增「访问令牌」卡片（浏览器里也有）：显示当前前 8 位、粘贴保存并重连、清除。
- 没令牌时不再装作在连：状态栏写「还没有访问令牌：去「设置」里填一个」，并自动切到设置页。
- 设置里的「访问」一行改成 本机 / 局域网，不再是写死的「只本机能连」。

**Control**

- 新增 Rust 命令 `core_api(method, path, body)`：走回环裸 HTTP + `Authorization: Bearer <token.txt>`，
  自己处理 `chunked` 兜底，不引 HTTP 客户端依赖。
- 连接卡片加一行「设备」（显示几台已配对）+ 添加设备对话框：
  名字 → 生成 → 选地址（`/api/addresses`）→ 显示可复制的地址与令牌、二维码（SVG 直接塞进 DOM）；
  下面列已配对设备，可**移除**（点了先确认一次，因为移除后那台设备要重新扫码）。
  2026-11-20 用户评这一版「不好看」，改成字段式表单（标签在上、输入框整宽）、× 关闭、
  生成后结果区在表单下面展开、设备列表带空状态与台数；顺带修好日志卡片溢出到页脚外面的问题。
  文案：不用「作废」（票据味），统一「移除」；原型里那个单独一个「改」字也删了。
  用户选定原型 **A · 生成后**（`work/proto-device.html`），据此把应用里的流程对齐：
  生成成功后表单收成一行摘要「手机 · 192.168.1.5:8787」，下面展开二维码与地址/令牌，
  主按钮由「生成令牌」换成「完成」（点它关闭并复位，下次打开又是干净的表单）。

**验证**（沙箱 Core，临时 home，只按 PID 停自己起的进程）

| 项 | 结果 |
| --- | --- |
| `/api/addresses` | 6 个私网地址（含 EasyTier 的 10.77.x、Hyper-V 的 192.168.x） |
| 创建设备 | 48 位令牌，列表只回 `8327a021…` 前缀 |
| `/api/qr` | 200，`image/svg+xml`，`:``<svg …` 开头 |
| 设备令牌连 `/ws` | ok；乱令牌 401；设备令牌调管理接口 401 |
| 移除后 | 设备令牌 401，主令牌仍然可用 |
| `/?token=<设备令牌>` | 200，页面正常 |

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（含 Control，最新 `e52e2fba…`）、`dist/SevenStation-win-x64-0.4.1.msi`（`79b55779…`）。

下一步：Android 阶段 0（Gradle 工程 + 扫码/手输 + WebView）。

## STATUS-048：过程区重排 + 展开状态不再回弹（2026-11-20，未发版）

用户报两件事：展开一条 bash 会看到两条（行头重复）；整个过程区读/写/改混在一起看着乱。原型 `work/proto-steps.html` 定稿后落地。

- **行头只画一次**：`toolCard()` 里那份 `.tool-head` 删掉，改成 `appendSections()` 只摆内容（命令 / 输出 / 改了哪几行）。
- **一行一步**：新增 `STEP_KINDS` / `STEP_ICONS`（终端、读、写、改、搜索、网页、清单、思考、兜底），
  左边图标 + 中文动词，中间一句摘要（路径只留尾巴、命令压一行），右边只有一个记号：`✓` / 转圈 / `!` / `—`；
  「完成」两个字和每行的耗时都去掉了，耗时只在展开那一步时露出。
- **同类合并**：连续同类工具折成「执行命令 ×3」，点开摊成子行，每条子行自己还能再展开。
- **手风琴**：同一块里只留一个开着的（`closeOpenItems()`）。
- **展开状态存进会话**：`session.ui = { work: Map, groups: Set, steps: Set }`；`workGroup()` 建节点时按它恢复，
  点击时回写；`onSessionState()` 重建会话时把 `previous.ui` 带过来，断线重连/重新拉状态都不回弹。
- **就地更新不再整轮重画**：`updateLiveTurn()` 匹配 `data-last-step`，展开着的那一步由 `updateLiveRow()`
  只换详情内容；合并、换种类、换步才退回整轮重画（状态在会话里，重画也还在）。
- 保留了原来「点路径在文件面板打开」的行为，移到新的摘要上；行改成可聚焦，回车/空格也能展开。

验证：把纯逻辑函数从 `app.js` 抠出来在 Node 里跑（`groupWork` / `stepSummaryText` / `stepStateNode` / `stepMeta`）——
3 条连续 bash 合并成 ×3、思考/读/改/搜索各自独立、运行中出转圈、没登记的工具回退原名 + 加号图标、种类映射 6 项全对。
视觉部分要装包后看。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi` 43.7 MB（`3df37cb703bfaf13…`）。

## STATUS-047：深色模式发送键用「深底 + 亮描边」（2026-11-20，未发版）

用户报：深色下发送键的白箭头贴在浅灰底上，几乎看不见（箭头 `#ffffff`、底 `#ecedf0`，对比约 1.1:1）。
根因：`--accent` 在深色主题里是浅色 `#ecedf0`，而 `--on-accent` 只在 `:root` 里定义过 `#ffffff`，深色没覆盖。

给了三版原型（`work/proto-send-dark.html`，浅底深墨 / 深底亮描边 / 中性深灰底），用户选 **B：深底 + 亮描边**。

落地：

- 深色主题加 `--send-ring: #55595f`；`.send-btn.ready/.stop` 在 `[data-theme="dark"]` 下改成
  `background: var(--bubble)`、`color: var(--text)`、`box-shadow: inset 0 0 0 1px var(--send-ring)`。
- 深底上压暗会更看不见，悬停从 `brightness(.92)` 改成 `brightness(1.45)`。
- `.send-stop-mark` 的方块色改成 `currentColor`，深浅主题都不用另配。
- `--on-accent` 在深色下保持 `#14161a`（只剩开关旋钮用它，浅色轨道上要深色旋钮）。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi` 43.7 MB（`c3af9200abb09135…`）。

## STATUS-046：正文里的地址点了不跳浏览器（2026-11-20，已修未发版）

用户报：点地址链接也不会跳浏览器，之前以为只有本地路径不行。

原因：地址是渲染成 `<a target="_blank">` 的。WebView2 里「开新窗口」要走宿主的 `NewWindowRequested`，
Tauri 壳没接这个请求，点了就什么都不发生（指针变手、看着能点，实际是空响）。本地路径没事，是因为
`.link-path` 有自己的点击处理，直接调壳的 `reveal_path`。

改法：

- 壳新增 `open_url` 命令：只认 `http://` / `https://`，用 `explorer.exe <地址>` 起系统浏览器
  （不让页面拿壳当随便起程序的入口）。登记进 `build.rs` 的 `AppManifest` 与 `capabilities/center.json`
  （`allow-open-url`）。
- 前端加 `openUrl()`，并在全局点击处理里拦截 `.md a[href]` / `.msg a[href]`：
  壳里调 `invoke('open_url')`，浏览器里退回 `window.open`，其余（`#`、锚点）不受影响。

出包：`dist/SevenStationCore-win-x64-0.4.1.msi`（`5e3f416288fb5bac…`）、
`dist/SevenStation-win-x64-0.4.1.msi`（`757101a764d1213c…`）。
**两个都要装**：开浏览器的命令在壳里，拦截逻辑在 Core 的页面上。

## STATUS-045：Pi 压缩上下文会抹掉对话历史（2026-11-20，已修未发版）

用户报：客户端里看不到在终端（TUI）里那段对话的记录。

查到的链路（全是只读证据）：

1. Pi 的会话文件有 3 条 `compaction` 记录，最后一条 `2026-11-20T02:49:24Z` = 本地 **10:49:24**。
2. Core 库里这条对话有 221 条消息，**最早一条正好是 10:49**——整段更早的历史没了。
3. 原因：每一轮结束 `PersistTurnAsync()` 拿 `get_messages` 回来，`:``SaveTurn()` 先
   `DELETE FROM messages WHERE conversation_id = $id` 再整段重插。Pi 压缩之后 `get_messages` 只回
   窗口里的消息，于是库里只剩窗口那一段，压缩点以前的全被删掉。`seq` 也跟着从 0 重新编号
   （所以早上看到的是 844，现在是 218）。
   ——顺带说明：**跟客户端还是 TUI 无关**，终端里说的话本来就只进 Pi 的会话文件，
   而库里这份是 Core 的副本；副本又被压缩重写过，所以两头都对不上。

改法（`ConversationStore`）：

- `SaveTurn()` 不再整段替换，改成 `MergeMessages()`：按「角色 + 时间戳 + toolCallId」去重后追加，
  已有的行一条都不动。压缩后 Pi 只回窗口内的消息，重复的跳过、新的接着往后排。
- 万一回来的消息比库里还早（跨了压缩点），按时间戳整段重排一次，顺序不会乱。
- `message_count` 改成写库后的真实条数，不再用 Pi 这次给的数组长度。

验证（临时控制台工程直接引用 Core 跑 `ConversationStore`，跑完删掉）：

| 步骤 | 结果 |
| --- | --- |
| 存 A,B,C | 库里 3 条 |
| 压缩后只回 C,D | 库里 4 条：A,B,C,D（C 去重、D 补上） |
| 再塞一条更早的 F | 库里 5 条：A,B,F,C,D（按时间重排） |
| `message_count` | 5 ✓ |

出包：`dist/SevenStationCore-win-x64-0.4.1.msi` 43.7 MB（`474299a30833acc4…`）。

**丢掉的那段能不能补**：能。Pi 的会话文件里全都有，按同样的去重规则并回库即可（历史时间戳更早，
走重排分支）。用户 2026-11-20 决定：不补，那段不重要。

## STATUS-044：卡住的「运行中」、停止卡 120 秒、重连后不出状态，三处一起修（2026-11-20，未发版）

按 STATUS-043 的结论动手：

- **没跑完的步骤不再假装在跑**：`CenterHub.MarkInterruptedSteps()` 在发 `session_state` 前，
  对「有 `toolCall` 没 `toolResult`」的块补 `interrupted: true`（只在没有在跑的回合上做）。
  前端 `stepRunning()` / `stepStatusText()` 统一判断，被中断的显示「已中断」、灰空心点（`.step-dot.is-aborted`），
  不再一直转「运行中」。卡片状态点也把中断当错误色。
- **重连后重新要一遍状态**：`connect()` 里 socket 打开时，如果正看着某条对话，补发一次
  `open_conversation`；以前只发 `list_conversations`，线程就停在上次断开前的样子。
- **停止不再等 120 秒**：`abort` 单独走 `AbortAsync()`，`SendAsync` 超时 5 秒；
  超时就把子进程收掉、`SetStreaming(false)`、发一条 notice 再补 `session_state`。
  `EnsureLive` 靠 `Session.IsRunning` 判断，收掉之后下次发消息会重新起子进程。
- **关闭有总时限**：`ApplicationStopping` 里 `ShutdownAsync().Wait(10s)`，超时就先退出，不陪 SCM 耗。
- 验证（沙箱 Core，临时 home + 8909 端口，只按 PID 停自己起的进程）：
  往临时库塞「一条有结果、一条没结果」的消息 → `open_conversation` 回来
  `call-done interrupted=false`、`call-open interrupted=true`，`isStreaming=false` ✓。
- 出包：`dist/SevenStationCore-win-x64-0.4.1.msi` 43.7 MB（`c0fbac0de01de2b4…`）。

**踩坑（记进 AGENTS.md）**：测试脚本里 `taskkill /F /IM SevenStation.Core.exe` 按镜像名匹配，
会把用户正在用的正式服务一起杀掉，一小时内栽了两次，用户只好退回终端用 pi。
以后只按 PID 停自己 spawn 的进程。另外 `wix extension add WixToolset.Util.wixext/5.0.2`
**不带 `-g` 会返回 0 但什么都没装**，打包就报 WIX0144。

## STATUS-043：查到「断开后状态自相矛盾 / 停止卡住 / 看着像重连失败」的链路（2026-11-20，只调查未改代码）

用户现象：Core 服务停了 → 手动启动 → 客户端「已连接」但任务状态不明 → 点「停止」一直转 →
关掉客户端重开，线框里还挂着一条「运行中」。

证据（生产日志 + 对话库，只读）：

1. `2026-11-20 10:47:00.750 对话 c-426013b16dfa 起子进程 …` 之后，下一条是
   `2026-11-20 11:01:30.975 启动（Windows 服务）`，**中间没有「停止」行**——进程是被硬杀掉/超时终结的，
   回合没走完。同一段 `01:40:08 停止` 之后还继续服务了 30 秒（`open_conversation 失败 :: InvalidOperationException:
   ExecuteReader can only be called when the store…`），说明关闭时连接没断、宿主吊着——已在 `c86fc9e` 修掉。
2. 对话库 `messages` 最后一条（seq 844）是 `{"type":"toolCall","id":"call_00_ET_8Tlf8…","name":"bash"}`，
   **没有对应的 toolResult**。
3. `app.js` 里步骤行是 `const running = entry.kind === 'tool' && !entry.block.done;`（约 1224 行），
   没有结果的 tool 块永远画成「运行中」；而侧栏转圈看的是 Core 的 `conversation.working`，
   新进程里 `_live` 是空的 → 绿点。于是同一条对话「侧栏不转、线框转」，重启 Core、重开客户端都不会变——
   这个状态在 `messages.payload` 里，不在内存里。
4. 「停止」卡住：`abort` 走 `SimpleAsync → live.Session.SendAsync(..., TimeSpan.FromSeconds(120))`
   （`CenterHub.cs:2080`），子进程不回应就干等 **120 秒**，界面上就是一直转。

关于「重装后不自动重连」：前端 `connect()` 的 `close` 处理器是无限退避重试（1s→2s→…→15s 封顶），
令牌也不会因重启而变（`read_center`：`center.json` → `token.txt`，`token.txt` 只在缺失时生成）。
所以更可能是旧 Core 关闭时吊住 30 秒占着 8787，新 Core 起不来/绑不上，页面确实连不上；
叠加第 3 条那个卡住的「运行中」，看起来就像「没重连成功」。**推测，验证方式**：升级前让 Control 先等
`sc query` 到 STOPPED 再放行安装（现在已经 45 秒），或升级后查日志里有没有新的「启动」行。

要改的话四处（还没动手）：

- 打开对话/启动 Core 时，把「有 toolCall 没 toolResult」的尾巴标成中断，界面显示「已中断」而不是「运行中」。
- `session_state`/`open_conversation` 报 `streaming=false` 时，前端把本地 `session.streaming` 清掉。
- `abort` 单独给短超时（5 秒），失败就明确提示，别跟着 120 秒通用超时转。
- 关闭流程：断 WS（已做）+ 子进程退出上限（已有 8 秒），再给整体关闭一个总时限。

## STATUS-042：服务停不下来 → 重启超时 → 服务留在停止状态（2026-11-20，未发版）

- 用户报：重新探测仍提示找不到 Pi；手动改、重新探测、失败回填，三种情况都不会把服务拉起来。
- 查到的因果链（生产日志 + `%LOCALAPPDATA%\SevenStation.Control\control.log`）：
  1. `2026-11-20 10:02:55 Seven Station Core 停止` 之后，进程**又活了 30 秒**，期间客户端还在连、还在报
     SQLite 已释放的错——宿主在等 WebSocket 收尾。
  2. `CenterHub.ShutdownAsync()` 根本不断开连接，Kestrel 关闭要等连接结束，默认超时 30 秒才强断。
  3. Control 的 `restart()` 里 `wait_for(false)` 只等 20 秒（40×500ms），超时就 `?` 直接返回，
     **`sc start` 从来没发出去**，服务就这么留在「已停止」。
  4. 服务没起来 → Core 不会重新探测 → UI 看到 `piReady=false` → 「找不到 Pi」。三个现象其实是同一个原因。
- Core 改法：`CenterConnection.Abort()`（`Interlocked` 置位 + `WebSocket.Abort()`），
  `ShutdownAsync()` 先把所有连接 Abort 掉再收尾。
- Control 改法：停止等待放宽到 90×500ms（45 秒），而且**停不下来不再提前返回**，继续 `sc start`
  让真正的错误暴露出来；启动等待 60×500ms。UI 上如果发现服务没起来，直接提示
  「服务没起来，点上面的『启动』把它拉起来」，而不是含糊地说没找到 Pi。
- 实测（沙箱服务 `SevenStationCore-Sandbox`，自己的数据目录与端口，不碰生产）：
  - 挂着客户端时 `sc stop` → **603 ms** 变 STOPPED（改之前 30 秒起步）。
  - 同一沙箱上跑 `sevenstation-control.exe --do pi ""`（清空 + 重启）→ 整段 **703 ms**，结束后服务 RUNNING，
    Core 日志 `找到 Pi：C:\Users\7inaBranford\.pi\agent`，`settings.json` 回填正确。
  - 测完已删掉沙箱服务与临时目录。
- 出包：`dist/SevenStationCore-win-x64-0.4.1.msi` 43.7 MB（`e2a11355a8e4cdf4…`）。

## STATUS-041：深色模式下一堆写死的浅色底（2026-11-20，未发版）

- 现象：深色模式下正文里的表格、代码块、行内代码亮得刺眼，表头和白底行里的浅灰字几乎看不见。
- 原因：这些样式写死了浅色值，没走主题变量——
  `.md code` `#f3f3f5`/`#e8e8ee`、`.md pre` `#f7f7f9`、`.md tbody tr:nth-child(even)` `#fbfbfc`、
  `.think` `#fbfbfc`、`.tool-body` `#fafafb`、`.table-wrap thead th` `#f7f7f9`、`.log-tail`、
  `.step-detail pre`、`.dir-where`、`.option`、`.badge-soft`、`.dir-row:hover`、`.files-row:hover`、
  `.completion-item.is-active`、`.new-thread:hover`、`.pill-select:hover`、加载转圈的边框色。
  文字色也有两处硬编码：`.md a` 的 `#2f54c9`（深色下深蓝几乎看不见）、`.conn.ok` 的 `#1f7a4d`。
- 改法：全部换成主题变量（`var(--panel)` / `var(--active)` / `var(--border-strong)` / `var(--green)` /
  `color-mix(in oklab, var(--text) 4%, transparent)` 这类）。新增 `--link` 令牌：浅色 `#2f54c9`，深色 `#7ea6ff`。
- 顺手修掉一个一直没生效的东西：`toolCard` 里状态点是按 `state ok/err/running` 这类 **class** 设的，
  样式表里却只写了 `[data-state="ok"]` 选择器，所以那个点一直是透明的。补上 `.state.ok/.err/.running`。
- 出包：`dist/SevenStationCore-win-x64-0.4.1.msi` 43.7 MB（`293df8289abe421a…`）。
- 未验证：深色主题的实际观感（截不了 WebView2 的图），需要用户看一眼。

## STATUS-040：Control 里改 Pi 目录，打一半字被清掉（2026-11-20，未发版）

- 现象：点「更改」进入输入态，输到一半输入框就不能输了，而「保存 / 取消」还杵在原地。
- 原因：Control 每 3 秒 `publish()` 一次（`main.rs` 的 poller），页面收到 `state` 就整份 `render()`，
  里面那行 `el('piDir').textContent = ...` 直接把单元格的子节点换掉——输入框连同上半截字一起没了；
  而按钮是独立元素、只切了 `hidden`，所以还留着。3 秒一次，正好是「改一半就断」。
- 改法：输入态（`el('piInput')` 存在）时不碰 Pi 那一行；`applyPiDir()` 等待期间另立 `piBusy` 标志，
  免得「正在重启…」那行每 3 秒被推送刷回「还没配」。
- 出包：`dist/SevenStationCore-win-x64-0.4.1.msi` 43.7 MB（`9a0c71f923a10d87…`）。

## STATUS-039：只认了一种 Pi 装法——npm 装法现在也认（2026-11-20，未发版）

- 用户贴的截图摊牌了：他那台 Pi 是 **npm 版**，目录是
  `C:\Users\wakab\AppData\Local\pi-node\current`（`pi` / `pi.cmd` / `pi.ps1` +
  `node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js`），数据在 `C:\Users\wakab\.pi`。
  而 Seven Station Core 只认官方安装包那种布局（`<家>\.pi\agent\bin\pi-launcher.js`），于是判定成「没有 Pi」。
  `pi-launcher.js` 确实是 Pi 自己的一部分（本机 `<家>\.pi\agent\bin\` 里就有），只是 npm 装法没有它。
- Core 改法：
  - `PiLocator.ResolveLaunchScript()`：先找 `bin\pi-launcher.js`，没有再读
    `node_modules\@earendil-works\pi-coding-agent\package.json` 的 `bin.pi`（回退 `dist/bundle/cli.js`、`dist/cli.js`）。
    `LauncherPath`、`EnsureInstalled`、`--help` 探测、`PiSession` 起子进程全都走它。
  - `IsPiDirectory()` 取代原来写死的 `File.Exists(bin/pi-launcher.js)`，探测与校验都用它。
  - 探测位置补 `<家>\AppData\Local\pi-node\current`（每个用户档案都看）；`ResolveNode` 补「Pi 目录旁边的 node.exe」。
  - 会话目录：官方装法 `<家>\.pi\agent\sessions`，npm 装法 `<家>\.pi\sessions`，`PiLocator.SessionsDirectory()` 挑存在的那个；
    `PiSessionLibrary.Root` 与 `PiAgent` 的「会话目录」统一用它。`HomeOf()` 也能从 npm 目录反推家目录。
- Control 同步：`pi_entry()` 两种入口都认，「重新探测」「更改」不再把 npm 装法当成无效目录；
  `derive_home()` 支持 `<家>\AppData\Local\pi-node\current`。
- 实测：造一份 npm 布局（package.json + dist/bundle/cli.js）→ Core 用 `PI_AGENT_DIR` 指过去，
  `settings.json` 里 `Agents.pi.Directory` 就写成了那个目录；Control `--do pi <npm 目录>` 退出码 0，
  随便指个 `E:/tmp` 仍然退出码 4。
- 出包：`dist/SevenStationCore-win-x64-0.4.1.msi` 43.7 MB（`90bb9663c0071acc…`）。
- 未验证：真机上 npm 版 Pi 能不能正常起会话（要用户那台才能试）。

## STATUS-038：Control 改 Pi 目录的四个毛病（2026-11-20，未发版）

用户报「点了重新探测反而把已有的路径弄没了，明明就是常规的 `C:\Users\7inaBranford\.pi\agent`」。

- **这条链路本身是通的**（本机按服务账户复现整条流程）：
  `sevenstation-control.exe --do pi ""` → `settings.json` 的 `Agents.pi.Directory` 变空、`Listen` 保留；
  再起 Core → 日志 `找到 Pi：C:\Users\7inaBranford\.pi\agent`、`配置里缺的 Agent 已补上`，
  文件回填正确。用户那台当时为什么没找到，日志里没有 `找到 Pi`，复现不出来。
- 但顺着查发现四个真问题，都修了：
  1. **读完状态太早**：`invoke('set_pi_dir')` 之后立刻 `read_state`，服务还没起来就读，
     于是显示「还没配」——人会以为探测失败。改成轮询最多 15 秒，等到 `piReady` 为止。
  2. **探测失败会丢原值**：现在记住改之前的路径，探测不出来就自动填回去并告知。
  3. **写配置会抹掉整份**：`write_pi_dir` 原来读失败就从空对象开始写，能把 `Listen` 等一起抹了。
     现在「读不懂就拒绝写」（实测：坏 JSON → 退出码 4、文件一字未动）。
  4. **编辑态太脆**：`input` 的 `blur` 直接取消编辑，粘贴时一失焦刚贴的就没，回车也落空。
     去掉 blur 取消，改成显式「保存 / 取消」按钮（改变/重新探测两个按钮在编辑态隐藏），
     键盘仍然支持 Enter 保存、Esc 取消。
- 出包：`dist/SevenStationCore-win-x64-0.4.1.msi` 43.7 MB（`5166c07da24883bc…`）。

## STATUS-037：点路径没反应——服务开不出用户桌面的窗口（2026-11-20，未发版）

- 现象：装了服务版之后，正文里点可点路径，资源管理器不弹。
- 原因：`reveal_path` 由 Seven Station Core 执行，而 Core 是 Windows 服务，`Process.Start("explorer.exe")`
  落在**会话 0**，用户桌面永远不会出现窗口；`Process.Start` 不报错，所以界面既没提示也没动作。
  生产日志里没有「打开路径失败」，本机 `Get-Process explorer` 也只有会话 1 的那一个——都对得上。
- 改法：让壳去开。桌面客户端新增 `reveal_path` 命令（`src/SevenStation.Desktop/src/main.rs`），
  `build.rs` 的 `AppManifest` 与 `capabilities/center.json` 同步登记（`allow-reveal-path`，
  已确认生成在 `gen/schemas/acl-manifests.json`）。页面里 `revealPath()` 优先调壳，
  壳不认账（浏览器、手机）才退回 Core——那条路至少会回一句「找不到这个路径」。
- 连带：**这次两个包都得装**。核心逻辑在 Core 的 wwwroot，新命令在客户端壳里，缺一个都点不开。
- 出包：Core `34e3fee99838b52e…`（43.7 MB）、客户端 `afcae29c390bf0c6…`（3660 KB）。
- 未验证：真实点击是否弹出资源管理器（这台机器的会话 0 无法验证，只能由用户在桌面点一次）。

## STATUS-036：工作过程只留最新一条但能翻出来，细节改成看得懂的写法（2026-11-20，未发版）

- **翻不出已完成步骤**：`workGroup` 里 `work.slice(-1)` 是「只画最新一条」，画完就没了——展开/收起只能操作整组，
  前面完成的步骤根本不在 DOM 里。现在会全部画出来：干活时最新那条直接摆在正文，
  其余的收进「前 N 步已完成」的折子里（`work-more` / `work-earlier`），点一下就展开，再点收起。
  跑完之后整组照旧按状态折叠。
- **就地更新认错行**：`updateLiveTurn` 原来取 `.work-body .step` 的第一个，加了折子之后可能抓到折子里的旧行。
  改成只认 `.work-body` 的直接子节点、按 `data-step`（工具调用 id）比对；对不上就整轮重画，
  对上才就地改文字。
- **细节全是原始 JSON**：`toolCard` 以前把 `args` 原样 `JSON.stringify` 加整段输出倒进 `<pre>`。
  现在按工具给分段（`toolSections`）：`read` 给文件 + 行范围 + 内容，`bash` 给命令 + 输出，
  `edit/multi_edit` 给「原来 / 换成」两条（红底 / 绿底），`write` 给写入 + 内容，
  `web_search` / `fetch_content` / `grep` / `glob` 各给对应的字段，其余退回参数 JSON。
  输出超过 80 行就掐头 60、留尾 20，中间标「…省略 N 行…」；路径用 `shortenPath` 相对当前工作区显示，
  点一下能在文件面板里打开。
- 加工放在前端（`wwwroot/app.js`）而不是 Core：事件里该有的字段都有，加工只是排版；
  前端改了两端（桌面与手机共用一份 wwwroot）同时生效，也不用动库里的历史 payload。
- 验证：`shortenPath` / `trimOutput` / `toolSections` 用 node 逐类跑过（read 带 limit、read 长文件、
  bash、edit、write、未知工具出错），分段与截断都对；界面实际观感没法在这台机器上截图。
- 出包：`dist/SevenStationCore-win-x64-0.4.1.msi` 43.7 MB（`0a01ea231366fd88…`）。

## STATUS-035：追加输入改为「回合边界」送出，不再等整轮结束（2026-11-20，未发版）

- 用户报的现象属实：`DeliverQueuedAsync` 只在 `agent_settled` 里调用，也就是整轮任务彻底结束后才把
  排队的第一条送出去，剩下的还要再等一轮——一个跑五分钟的任务，追加的话要等五分钟才生效。
- 改法：在 `turn_end`（模型这一轮回答 + 它的工具调用结束）就把队首那条交给 Pi，带
  `streamingBehavior: "steer"`，Pi 会在下一次调模型前采用它。`agent_settled` 那条保留，作为兜底
  （整轮结束后还有剩的就当新一轮起点）。一次仍然只送一条。
- 停止保护：新增 `Live.StopRequested`（`abort` 时置位、`agent_settled` 清掉），按过停止就不再往 Pi 塞，
  排队的留在面板里由用户自己决定。只在 `live.Streaming` 时送，避免空闲时带 steer 出错。
- 队列仍然由 Seven Station Core 自己持有，所以「编辑」照旧可用：条目在 panel 里的时候能改，
  被回合边界送出去之后就改不了了——和 Pi TUI 里 alt+Q 的可用窗口一致。删除/清空也照旧。
- 实测（临时实例 8899，多步任务 + 中途追加）：
  `6.6s` 入队（queue_state=1）→ `9.8s` 队空（已在回合边界送出）→ `10.1s` 追加的话落地 → `16.5s` 整轮结束。
  日志里没有「送出排队消息失败」。
- 出包：`dist/SevenStationCore-win-x64-0.4.1.msi` 43.7 MB（`e35ea0b156b69a8c…`）。

## STATUS-034：Control 改 Pi 目录被 ACL 挡了 + 待发图片挪到空隙里（2026-11-19，未发版）

- **`Command set_pi_dir not allowed by ACL`**：用户点的是「重新探测」（空路径 = 清掉后让 Core 重找），
  与「更改」走的是同一条命令，ACL 一挡两个按钮都动不了。新增壳命令要登记两处，我只做了一处。
  `src/SevenStation.Control/build.rs` 的 `AppManifest::commands` 补 `"set_pi_dir"`，
  `capabilities/control.json` 的 `permissions` 补 `allow-set-pi-dir`。
  核对 `gen/schemas/acl-manifests.json` 里已经出现 `allow-set-pi-dir`，权限这次真的生成了。
  （桌面客户端那边一直是这么要求的，AGENTS.md 里也记着「新增壳命令要在 build.rs 登记」，这次漏的是能力表。）
- **粘贴图片把正文顶上去**：`.attachments` 原本是 `.composer` 里的普通流元素，多一行就把上面正文区挤下去。
  现在和提示合并成一个 `.composer-dock`（`position: absolute; bottom: 100%`，容器 `pointer-events: none`，
  只有 `.attachments` 打开点击），两者都不参与布局，正文区纹丝不动。
- **那个叉太丑**：原来是个默认样式的 `<button>×</button>`，浏览器给它画了边框。
  改成 20px 圆形按钮 + 11px 的 SVG 叉（`stroke-width 1.4`），平时只有淡淡的叉，悬停铺一层 `--border`。
  文件名超长时按 260px 封顶、省略号收尾，留 `title` 看全名；缩略图 22px 圆角 5px；
  底色从写死的 `#f7f7f9` 换成 `var(--panel)`，深色主题不会再冒出白块。
- 出包：`dist/SevenStationCore-win-x64-0.4.1.msi` 43.7 MB（`7672200fcbacbb74…`）。
- 未验证：界面观感（叉的样子、图片条浮在空隙里的实际位置）没法在这台机器上截图，需要人眼确认。

## STATUS-033：安装时自动收掉在跑的程序（2026-11-19，未发版）

- 只靠 `util:CloseApplication` 不行：它发的是关闭消息，而 Control 收到关闭请求是 `prevent_close` + 缩回托盘
  （`src/SevenStation.Control/src/main.rs:232`），进程还在、exe 继续被占着，装完还是旧程序。
  便携方式跑的 Core 更是没人管。
- 改成 taskkill：`WixQuietExec`（Util 扩展）执行
  `taskkill /F /T /IM SevenStation.Control.exe /IM SevenStation.Core.exe`（客户端包只有 `/IM SevenStation.exe`）。
  `/T` 连 Pi 子进程与 WebView2 的浏览器进程一起带走，不留孤儿。
- 装与卸各一条：`KillRunningOnInstall` 在 `InstallFiles` 前、「`KillRunningOnRemove`」在 `RemoveFiles` 前。
  服务仍然由 `ServiceControl` 先停（`StopServices`=1900 早于 3999）。
- 踩到两条 WiX 规矩：`BinaryRef` 不是元素（`WIX0005`），扩展的 CA 二进制直接用
  `BinaryRef="Wix4UtilCA_X64"` 属性引用即可；同一个 Action 在序列里只能出现一次（`WIX0091`），
  所以装/卸各建一条 CA。CA 用 `Execute="immediate"`——WixQuietExec 靠与 CA 同名的 Property 取命令，
  deferred 方式拿不到。
- 核对 MSI（`CustomAction` / `InstallExecuteSequence` 两张表）：类型 65（immediate）、
  3999 < 4000、3499 < 3500，命令串与预期一致；两个包都通过。
- 出包：Core `c26414fcf6445af…`（43.7 MB）、客户端 `58c23878860d0596…`（3660 KB）。
- 未真机验证：装的时候真的把托盘里的 Control 杀掉这件事，得在别人的机器上装一次才知道。

## STATUS-032：可点位置双管齐下——渲染器兼容 + 给 Pi 的写法约定（2026-11-19，未发版）

- 渲染器（`wwwroot/app.js` 的 `decorateLinks`）：
  - 行内代码（反引号）里的路径也做成链接；只跳过 `a` 与代码块 `pre`。模型爱把路径包进反引号，这条解决了一大半。
  - 新增引号包裹的路径：`"E:\My Files\notes.md"` 整段识别，引号本身不进链接，也不会被句末标点裁剪。
  - 裸路径不再吞中文标点（`，。；：！？、（）【】《》「」『』`），否则「E:\a\b，然后」整句都成了链接。
  - 验证（node 逐条跑）：裸路径、带空格引号路径、反引号路径、UNC、网址带句号、中文逗号结尾、无路径的普通文字，七种输入结果都对。
- 给 Pi 的写法约定：新增 `src/SevenStation.Core/Agents/pi-guidance.md`（随程序集输出），
  `PiSession.Start` 用 `--append-system-prompt <内容>` 注入。Pi 的这个参数只吃文本，所以 Core 自己读文件再传。
- 兼容兜底：`PiLocator.SupportsAppendSystemPrompt` 先跑一次 `node <agent>\bin\pi-launcher.js --help`
  看有没有这个参数（老版本遇到不认识的参数会直接退出，不能让聊天整个挂掉），结果按进程缓存。
- 实测：
  - 子进程命令行里出现 `--append-system-prompt`（父进程是测试实例）→ `injected=YES`。
  - 问「把这两个文件的完整路径发给我」，回复就是裸绝对路径 + 裸网址，没有反引号也没有相对路径。
- 出包：`dist/SevenStationCore-win-x64-0.4.1.msi` 43.7 MB，SHA-256 `a103b25e6d5d4f26679926011a17ae1730a7dbea84dd8b020fca251b8febdeac`。
- 界面观感（链接在反引号里的样子）还没人眼确认过。

## STATUS-031：服务的 Pi 探测补上用户变量与任意盘用户档案（2026-11-19，未发版）

- 用户反馈：他们机器上 `pi` 直接能跑（Pi 装在 PATH 上），Core 却报「还没有配置 Pi」。
  原因有两层，都是因为 Seven Station Core 跑在 **LocalSystem** 下：
  1. `Environment.GetEnvironmentVariable("PI_AGENT_DIR")` 只拿到**机器级**变量，用户在「环境变量」
     对话框里设的是 `HKEY_USERS\<SID>\Environment`（用户级），服务账户根本看不到。
  2. 用户档案扫描写死了 `C:\Users\*`，家目录在别的盘或自定义路径的用户直接漏掉。
- 改法（`CoreSettings`）：
  - 新增 `UserEnvironmentPiDirectories()`：遍历 `HKEY_USERS\<SID>\Environment` 读 `PI_AGENT_DIR`，
    支持 `%VAR%` 展开；hive 没挂载（用户未登录）时跳过。
  - 新增 `UserHomes()`：从 `HKLM\...\ProfileList\<SID>\ProfileImagePath` 取全部用户家目录（任意盘、任意路径），
    再补 `C:\Users\*` 兜底；跳过 `systemprofile` 与 `Default`。
  - `ProfileCandidates()` 改用 `UserHomes()`。
  - 程序集级 `[assembly: SupportedOSPlatform("windows")]`（读注册表、跑服务本来就只对 Windows 成立），
    消掉 CA1416；`Microsoft.Win32.Registry` 包引用不需要，net10.0 自带。
- 实测：把 `PI_AGENT_DIR=E:\tmp\fake-pi` 写进用户级注册表（服务账户读不到的位置），
  冷启动一个临时实例，`settings.json` 的 `Agents.pi.Directory` 就是 `E:\tmp\fake-pi`——这条路径以前必然漏。
  测完已删除该注册表值、清掉临时目录。
- 出包：`dist/SevenStationCore-win-x64-0.4.1.msi` 已含本次改动（43.7 MB）。

## STATUS-030：Seven Station Control 里能改 Pi 安装目录了（2026-11-19，未发版）

- 起因：另一个用户装完之后 `list_models` 一直报「还没有配置 Pi」。Core 的自动探测只扫
  `C:\Users\*\.pi\agent\bin\pi-launcher.js`，Pi 装在别处（或没装在系统盘家目录）就找不到。
- Control 的「连接」区加了一行 **Pi 安装目录**：显示当前配置（读 `settings.json` 的 `Agents.pi.Directory`），
  不可用会显示一行提示；「更改」就地变输入框（Enter 存、Esc 取消），「重新探测」把目录清空、重启服务让 Core 重新找。
- Rust：`Snapshot` 加 `pi_directory` / `pi_ready`；`set_pi_dir()` 先校验 `bin/pi-launcher.js` 存在，
  再走提权写配置（`--do pi <path>`）；`write_pi_dir()` 改 `Agents.pi` 只动 `Directory`/`Home`，
  `Node` 等其它键保持不变，`<用户>\.pi\agent` 这种标准位置顺手推出家目录；写完重启服务。
- 校验在提权入口里也做了一遍，绕不过去。实测三种情况都对：`E:/tmp` → 退出码 4 且配置不动；
  清空 → `Directory` 变空、`Home` 保留；设好 → `Directory`/`Home` 正确、`Node` 原样保留。
- 出包：`dist/SevenStationCore-win-x64-0.4.1.msi` 已含新版 Control。界面观感需要人眼确认。

## STATUS-029：安装包的版本倒退已修（2026-11-19，未发版）

- `scripts/build-installer-center.ps1`：FileVersion 改成 `0.<年>.<月日>.<时分>`（如 `0.26.1119.2211`）——
  四段各 ≤ 65535、随构建单调递增，且一定大于历史上的 `0.4.39632.0`。不再取模，不会回绕。
- 两个 wxs 都加了 `util:CloseApplication`（挂在 `<Package>` 下，父元素只能是 Package/Module/Fragment）：
  升级前先关掉在跑的 `SevenStation.Core.exe` / `SevenStation.exe`。两个构建脚本都加了
  `-ext WixToolset.Util.wixext`，该扩展已装到 wix 的全局扩展目录。
- 已核对（由脚本重建的两个 0.4.1 MSI）：`Wix4CloseApplication` 表里分别有
  `CloseCore → SevenStation.Core.exe`、`CloseClient → SevenStation.exe`；Core 的 exe 版本
  `0.26.1119.2211`、客户端 `0.4.1.0`。服务那侧本来就有 `Stop="both" Wait="yes"`，占用这条路是通的。
- **没发版**：`<Version>` 仍是 0.4.1，没打新标签。`dist/` 里的 0.4.1 安装包已经是打了补丁的版本，
  与线上已发布的 0.4.1 资产字节不同，下次发版直接用。
- 未验证：拿 0.4.0 真装一次再升级到现在这个包（要重装旧版本，没做）。

## STATUS-028：0.4.1 升级把 Core.exe 装丢了（2026-11-19）

- 现象：用户在自己机器上装 0.4.1 的 Core MSI，安装报成功、ARP 显示 0.4.1，但
  `C:\Program Files\SevenStation Core\SevenStation.Core.exe` 不存在、`SevenStationCore` 服务也没注册；
  Seven Station Control 起成便携模式，弹「没找到 SevenStation.Core.exe」。
- 根因（用户先停了服务，排除占用）：**FileVersion 倒退了**。构建脚本用「UTC 秒数 % 60000」当第三段，
  0.4.0 出过 `0.4.39632.0`，0.4.1 回绕成 `0.4.11411.0`。两个 MSI 里 `CoreExecutable` 组件 GUID 相同
  （`{86036D2D-…}`），Windows Installer 见到目标位置是「更高版本」就跳过替换，组件却记成已安装，
  旧的卸载再把文件删掉 —— 最后 exe 与服务注册（挂在同一组件上）一起没了。
  其余文件没事：DLL 的 AssemblyVersion 是 0.4.1（更新），`wwwroot`/`json` 无版本号按内容比对。
- 处理：`msiexec /fa {976887C6-70AC-4EE9-9EA4-2174D2F41D72} /qn` 修复安装，文件与服务都回来了，
  `127.0.0.1:8787` 返回 200。
- 待修（0.4.2）：在 MSI 里用 `util:CloseApplication` 在 InstallFiles 之前关掉正在跑的
  `SevenStation.Core.exe` / `SevenStation.exe`，并给 WiX 加 `WixToolset.Util.wixext`；
  升级前先停服务这条写进发布说明的升级注意事项。
- 影响面：所有从 0.4.0 升级的机器都会碰到（服务默认常驻），不是个例。

## STATUS-027：0.4.1 发布（2026-11-19）

- 版本号三处改到 `0.4.1`（Core csproj、两个 Cargo.toml、两个 tauri.conf.json），
  发布说明 `docs/release-notes/v0.4.1.md` 过门禁（40 行、分类、链接到 `v0.4.1` 下的 STATUS）。
- 出包：`SevenStationCore-win-x64-0.4.1.msi`（43.3 MB，SHA-256 `54f96072…df7736`）与
  `SevenStation-win-x64-0.4.1.msi`（3.2 MB，SHA-256 `b6d07af3…65e53e9a`），MSI 里 ProductVersion 都是 0.4.1。
  构建信息表在 `build/release/v0.4.1.md`，源码提交 `e77e04e`。
- `main` 与标签 `v0.4.1` 用 SSH 推；Release 由用户在自己会话里执行 `gh release create` 建好。
  核对：标题 `v0.4.1`、非草稿、四个资产（两个 MSI + 两个 .sha256）无显示标签、字节数与本地一致；
  把两个包下载回来算 SHA-256，与本地逐字节一致；正文与 `build/release/v0.4.1.md` 完全相同（40 行，含构建信息表）。
- `gh` 这次踩到：新版 gh 把 token 存进 Windows 凭据管理器，`hosts.yml` 里只剩用户名，
  所以以 SYSTEM 身份（本会话）跑 `gh` 永远 invalid；发布命令要让用户在自己的会话里跑。
- 构建环境的两个坑：`dotnet publish` 卡在还原是 MSBuild server 的问题，设
  `DOTNET_CLI_DO_NOT_USE_MSBUILD_SERVER=1` 后 48 秒过；WiX 的 UI 扩展按系统账户档案找，
  `%USERPROFILE%` 覆盖无效，扩展要复制到 `C:\Windows\system32\config\systemprofile\.wix\extensions`。
- 没做真机安装/升级测试（生产环境隔离：不许覆盖用户正在用的 0.4.0）。

## STATUS-026：进度类操作一条通知到底（2026-11-19）

- 用户定的规则：一秒钟内完不成的操作，用**同一条**通知从「进行中（转圈）」翻成结果，
  不要开始弹一条、结束再弹一条；一次性提示（如模型回退）几秒后自己消失就行。
- 压缩：点按钮先挂一条「正在压缩上下文」+ 转圈，`compaction_end` 时同一条改成「上下文已压缩」
  （3.2 秒后消失）；Pi 自动触发的压缩没点过按钮也会补上这条。120 秒没结束就改成「压缩好像没结束」。
- 停止：`requestStop()` 挂一条「正在停止」+ 转圈，`agent_settled` 回来按 `event.aborted` 翻成
  「已停止」或「本轮已结束」；15 秒没回音提示「还没停下来，可以再点一次」。进程退出也收尾。
- 实现：`statusToast()` 返回可 `update()/remove()` 的句柄，样式 `.toast.is-busy` + `.toast-spin`。
- 动画：进场往上冒（`rise`）；退场分两段——先整块淡出下沉 150ms（文字和框一起走），
  透明后再把高度收成 0（120ms，这时看不见框，只有后面的卡片平滑上移）；
  换文案时新字淡入、卡片高度按新旧差值 200ms 过渡，变长变短都不跳。
- 未验证：动画观感（需要在界面里点一次压缩或停止看那张卡片翻面与收起）。
## STATUS-025：通知挪进正文与输入框之间的留白（2026-11-19）

- 用户定的界面规则：那块留白平时没信息，瞬时的通知就该放这儿，不要浮在右下角挡内容。
- `#toasts` 从根容器挪进 `.composer`（第一个子元素），`.toasts` 改成
  `position:absolute; bottom:100%; left/right:24px`，贴住输入区上沿、只向上叠，绝对定位所以不顶动布局。
- 样式从深色药丸改成浅色卡片（边框 + 10% 底色），warning / error 用边框颜色区分；
  `pointer-events:none`，通知不吃点击。
- 未验证：观感（需要在界面里触发一条通知看一眼）。

## 待办：批三的约定（2026-11-19 用户定）

新对话沿用上次的模型与思考等级：**全局一份**（不按工作区分）、只记**手动切换**、
继承的模型不在清单里时**弹一条简短通知**（不用详细）。还没写代码。

## STATUS-024：发送状态三态与正文里的地址路径（2026-11-19）

- **发送状态**：气泡左边一个 14px 小圈，`sending` 转、送达淡出、失败变红圆底感叹号（挖空）。
  失败时点它弹小面板：取消 / 删除这条 / 重新发送（重发沿用原文与图片，圈转回去再发一次）。
  成功后不撤气泡、不闪一下——回显那条就地换成正牌消息，只把圈淡掉。失败时气泡不再描红边（用户去掉的）。
  回显条目本来就在 `session.items` 里，`turnsOf()` 会画；**别再额外补画一遍**（踩过：气泡变两条）。
  只有从 `raw` 重建 items 的地方（`onOlderMessages`）要接回还没确认的那些。
- **地址与路径可点**：`renderMarkdown()` 外面包了 `decorateLinks()`，正文里的 `http(s)://`、
  `C:\...`、`\\server\share` 会变成链接（跳过 `a`/`code`/`pre`）。网址走新窗口打开；
  绝对路径发 WS `reveal_path`，Core 用 `explorer.exe`（目录直接开、文件用 `/select,`）打开，
  打不开回 `notice` 轻提示。
- 演示开关：`SEVENSTATION_DEBUG_FAIL_PROMPT=1` 时每句话都当场失败，用来看红圈。
- 验证：`node --check` 通过、构建 0 错误、正则单测（URL/盘符/UNC/句末标点/括号）通过；
  `reveal_path` 打不存在的路径回 `notice: warning 找不到这个路径`。用户在测试实例上确认：
  首发的气泡只有一个、红圈点的面板「重新发送」「删除这条」都符合预期（重发后转圈并送达、淡出）。
## STATUS-023：发出去立刻看得见（2026-11-19）

- 问题：说完话到界面上出现自己的气泡之间要等 3~4 秒（实测），因为气泡要等 Pi 回 `message_end`
  才画出来；同时「工作中」也要等 `agent_start`。观感上就是卡住。
- 做法：`submitPrompt()` 在发送前先 `echoPrompt()` 把这句话画进对话，同时把会话标成 streaming，
  「工作 N 秒」立刻开始走；Core 确认后（真正的用户消息到达）用 `echoAt` 把回显换成正牌，不重复。
  提示失败时 `dropEchoes()` 撤掉回显，避免留一条其实没发出去的话。
- 排队的情况不回显：那时这条还没发出去，面板才是它的位置。
- 验证：`node --check` 通过、构建 0 错误；用户在测试客户端确认「气泡立现、停止键与计秒同时切换、
  没有重复的用户消息」。
## STATUS-022：三处「界面在说谎」修掉（2026-11-19）

- 侧栏「工作中」指示器时有时无：`SendConversationList` 只在 list/new/rename/delete 时推送，
  流式开始和结束都不推，客户端也不本地改 `working`。现在状态变化统一走 `SetStreaming()`，
  它会在状态真的变化时 `BroadcastConversations()` 给所有连接。
- 新对话模型显示成 GLM-5.2：新对话 `conversations.Model` 为空，客户端 `currentModel()` 兜到
  模型列表第一条（`v2ex/coder`，显示名 GLM-5.2），而实际跑的是 Pi 的默认。现在 Core 读
  `<agent>/settings.json` 的 `defaultProvider` + `defaultModel`，用缓存列表补全字段后塞进
  `state.model`，胶囊显示的就是真正在跑的模型。
- 模型缓存永不过期：`models` / `thinkingLevels` 加上 `modelsAt` 时间戳，24 小时后自动重取；
  模型面板底部加了「刷新」，发 `list_models` 带 `force: true` 当场重取。
- 验证：临时实例（8899）跑一次真实对话，实测 `state.model = magpie/auto/deepseek-v4.1-flash`、
  `conversation_list` 在开始时 `working=true`、结束时 `working=false`、`modelsAt` 落库。
  界面观感仍需人眼确认。

## STATUS-021：对话区细节与追加输入队列（2026-11-19，开发中）

- 目标：用户提的六条界面问题——自己发的消息认不出来、左侧栏「工作中」指示器不刷新、工作中
  输入卡片被提示行顶高、输入区与正文太挤、步骤刷屏、步骤行悬停时闪、往上翻被拽回底部。
- 已落地（本地提交，未出包）：
  - 用户气泡右对齐加色，三档（跟随主题 / 微信绿 / 薄荷）并入设置页「外观」卡，默认跟随主题。
  - 输入卡片常驻灰影，聚焦时叠蓝色光环，灰影保留；提示行固定预留一行；正文底留白 44 px。
  - 工作中只留最新一条步骤，上一步一完成就折进摘要行；整轮结束后收成一行「工作 N 步」。
  - 正在跑的那一轮改为就地更新步骤文字，不再整轮重建——悬停时不再闪。
  - 滚动只在离底 24 px 内才跟随（原来 90 px），`message_start` / 用户消息落地不再强制拉到底。
  - 追加输入改由 Seven Station Core 自持队列：可看、可改单条、可删单条、可清空，
    这一轮结束后依次送出（`agent_settled` 触发）。Pi 那边的队列命令只有 `clear_queue`，单条改不了。
- 验证：`dotnet build SevenStation.slnx` 0 错误；临时 home + 8899 起核心，脚本走 WebSocket 实测
  「排队两条 → 编辑一条 → 删一条 → 清空」，并确认「本轮结束送出一条、下一轮送出下一条」，
  `session_state` 里带回队列。用户在测试客户端上验过气泡、间距、阴影、步骤收纳、面板与编辑流程。
- 测试中修掉两处：`queue_state` 被错放进 `onEvent()` 导致面板不出现；按停止时未判断
  `agent_settled.aborted`，把排队内容当成下一轮送了出去。编辑改为「取回输入框」。
- 未验证：编辑到一半该条被送出/删除时的自动退出路径（用户跳过）。界面截图仍无（SYSTEM 身份起不了无头浏览器）。
- 未做：左侧栏指示器（`SendConversationList` 只在 list/new/rename/delete 时推，流式开始结束不推）、
  新对话模型的假显示（兜到列表第一条 GLM-5.2）、模型缓存永不过期、新对话继承上次的模型与思考等级。

## 已收口：图标与安装程序画面

- 图标不再是手画：`design/make-icons.py` 用 Segoe UI Semibold 的 π 按包围盒栅格化，一次产出
  Control 的 `icon.ico`/`tray.png`、客户端的深底 `icon.ico`、网页用的 `mark-light.png`/`mark-dark.png`。
- 安装程序画面：`design/make-installer-art.py` 生成 `installer/assets/banner.bmp`（493×58）与
  `dialog.bmp`（493×312），两个 wxs 用 `WixVariable` 指过去，`Icon + ARPPRODUCTICON` 给「应用和功能」配图标。
- 真跑一次向导的截图在 `design/shots/msi-wizard-real.png`：顶栏会被 493×312 的对话框底图盖住，
  页面上看不到 banner；要留顶栏得改底图尺寸，WiX 那个控件尺寸固定，塞进去会拉伸，所以这版就是没有顶栏的样子。

## STATUS-001：Pi 桌面界面能开会话并流式对话

- 做了什么：.NET 10 WPF 窗口托管 WebView2；C# 侧管 `pi --mode rpc` 子进程，一条命令一个
  相关响应、事件原样转发给页面；界面实现会话列表（按工作目录分组）、历史渲染、流式正文与
  思考块、工具卡片、扩展弹窗与状态栏、模型与思考等级切换、上下文用量与压缩。
- 验证方式（2026-11-17，真窗口 + CDP 驱动真实交互）：
  - 冷启动到 `get_state` 响应 4.4 秒，关 stdin 后 0.25 秒退出，退出码 0。
  - 新建会话、发送 prompt、首个 `text_delta` 到 `agent_settled` 全通，正文与思考块落在页面上。
  - 点击侧栏已有会话可续聊：历史 7 条消息、工具卡片 1 张（bash，105 毫秒）渲染正确。
  - 模型下拉 17 项、思考等级、上下文用量（1% · 18k/1000k）都来自真实响应。
  - 扩展状态栏能显示 Pi 扩展推的 `setStatus`，ANSI 色码已剥掉。
- 边界：图片只作为附件随文本发送，`@文件` 补全没做；终端面板没做；扩展弹窗只在
  select / confirm / input / editor 四种上验证了渲染路径，没有真实扩展触发过全流程。
- 证据：`dotnet build` 0 警告 0 错误；界面截图在当时的临时目录，未入库。

## STATUS-002：仓库定名 SevenStation 并推到公开远端

- 按用户要求把项目搬到当前工作目录，仓库名与目录同名（均为 SevenStation），
  程序集、命名空间、exe、日志与界面品牌一并改名，避免同一产品留两个名字。
- 验证：`dotnet build` 通过，`scripts/ui-smoke.mjs` 在改名后重跑通过；`git log` 保留原有提交。
- 记录：那次 `gdi32full.dll` 崩溃（`0xc0000409`）由用户指认为本机 MacType 注入所致，
  不是代码问题，已写进 `AGENTS.md` 的已知坑。

## STATUS-003：拆成 Seven Station Core + 客户端，多端共用一份会话

- 用户 2026-11-17 定下目标形态：一套 Seven Station Core 负责跟 Pi 打交道，PC 与手机都连这套 Seven Station Core；日后客户端再加
  host 能力，用 Seven Station Core 的 Pi 操作别的设备。原「只做 PC 端」的约束作废，见 `docs/DECISIONS.md`。
- 改了什么：新增 `src/SevenStation.Core`（ASP.NET Core，管 pi 子进程、会话扫描、`/ws`、
  托管前端）；桌面端退化成 WebView2 壳，加载 Seven Station Core 地址；`AppBridge` 变成 `CenterHub`，
  命令应答回发起连接、会话事件广播给所有连接。前端从 `chrome.webview` 桥换成 WebSocket。
- 安全：Seven Station Core 默认只监听 `127.0.0.1:8787`；`/ws` 要令牌，令牌文件在 `%LOCALAPPDATA%\SevenStation.Core\token.txt`。
- 验证（2026-11-17，真窗口 + CDP + 第二个 WebSocket 客户端）：
  - `scripts/ui-smoke.mjs` 通过：连接状态「已连接」、新会话、流式、收尾、侧栏刷新。
  - 第二个客户端 `list_sessions` 拿到同一份会话（1 条），`open_session` 拿到 3 条历史。
  - 桌面窗口里发一条消息，第二个客户端收到同一条 `text_delta` 与 `agent_settled`，key 一致。
  - 同一会话打开两次只产生 1 个 key，即一个子进程，满足单写者。
- 边界：局域网与 TLS 没做；手机端只验证了同一页面能被打开（未做窄屏适配）。

## STATUS-004：Seven Station Core 定名 SevenStation.Core，与客户端分家

- 用户 2026-11-17 定名：Seven Station Core 叫 SevenStation.Core（MA 既是 Main 也是 Main Agent），客户端仍是 SevenStation。
- 改了什么：`src/SevenStation.Server` → `src/SevenStation.Core`，程序集与 exe 变成 `SevenStation.Core`；
  Seven Station Core 日志写 `%LOCALAPPDATA%\SevenStation.Core\logs\center.log`，令牌文件 `%LOCALAPPDATA%\SevenStation.Core	oken.txt`；
  环境变量改为 `SEVENSTATION_LISTEN` / `SEVENSTATION_TOKEN`；客户端从 Seven Station Core 的令牌文件自动读取。
- 界面：连接状态显示成「已连接 · SevenStation.Core」；新建会话语义改为「填 Seven Station Core 机器上的目录」；
  空状态文案不再说「本机」。
- 验证：`dotnet build SevenStation.slnx` 0 警告 0 错误；`dev-run.ps1` 起 Seven Station Core 与客户端，
  health 返回真实会话根目录，界面连上后列出 170 个会话。

## STATUS-005：对话归 SevenStation.Core，客户端只读 MA 的数据

- 用户 2026-11-17 定：不再全盘使用 Pi 的会话管理。Pi 的会话目录太乱（一百多条结束未清理），
  点开旧会话要等很久、还有加载失败的。对话改成 SevenStation.Core 自己的概念，客户端只跟 MA 通讯。
  记在 `docs/DECISIONS.md` 的 D5。
- 数据：SQLite（`%LOCALAPPDATA%\SevenStation.Core\data\sevenstation.db`，`SEVENSTATION_DATA_DIR` 可覆盖），
  两张表 `conversations` / `messages`，加一张 `settings` 放模型列表这类缓存。
- 绑定：新建对话时只建一条记录；第一次发消息才起 Pi 子进程，把 Pi 的 `sessionFile` 记进
  `pi_session_file` 字段，续聊时拿它 resume。这个字段不出现在任何客户端响应里。
- 存档：每轮 `agent_settled` 后取一次 `get_messages` / `get_session_stats` / `get_state`，
  整体替换该对话的消息并更新标题、模型、思考等级、用量。
- 验证（2026-11-17，真窗口 + CDP + SQLite 直查）：
  - 新建对话 → 发消息 → 流式 → 收尾，库里落地 5 条消息（含 1 条 system）、标题取首句、
    `pi_session_file` 已写入。
  - 关掉 Seven Station Core（子进程一起没）再开，点开同一对话：109 ms 出历史，**没有**起任何 Pi 子进程。
  - 模型列表改为读缓存后，看历史的路径完全不碰 Pi。
  - 删除对话：侧栏 2 → 1，库里对应行与消息一起消失，Pi 那边文件保留。
  - `scripts/ui-smoke.mjs` 通过（用量 `1.1% · 11k/1000k`）。
- 顺带修：`refresh_stats` 原来回的是整份状态，收尾时会用库里未写完的副本覆盖刚流式出来的内容；
  现在只回用量。SQLite 原生库有已知高危版本，已钉 `SQLitePCLRaw.bundle_e_sqlite3` 3.0.5。
- 边界：旧的 170 条 Pi 会话不迁移，MA 从空库开始；对话不能重命名（标题自动取首句）。

## STATUS-006：对话重命名，切模型不再清空线程

- 用户 2026-11-17 要：对话要能重命名，模型选择要能用（上一轮漏了）。
- 重命名：标题旁加了铅笔按钮，双击标题也能改；库里改标题，所有连着的客户端一起更新。
- 模型/思考等级：之前改设置会回整份 `session_state`，用库里还没写完的副本把流式内容覆盖掉——
  表现为「一切模型对话就空了」。改成只回 `conversation_settings`（标题、模型、思考等级），不碰消息。
- 思考等级：换过模型后库里记的等级可能不在当前模型的可选范围，界面照实把它补成一个选项，
  不再显示成空白。
- 客户端自愈：强杀后残留的 WebView2 进程占着缓存目录会报 `0x800700AA`。现在创建环境失败会重试两次，
  仍失败则提示「先关掉旧的窗口和残留的 msedgewebview2」；`dev-run.ps1` 启动前会顺手清理这些残留。
- 验证（2026-11-17，真窗口 + CDP）：切模型后消息数保持 2、线程文本不丢，下拉显示新模型；
  重开后标题、模型 `v2ex/coder-m3`、思考等级 `medium`、消息数都对；重命名后头部与侧栏同步，消息不丢。

## STATUS-007：模型下拉按 provider 分组，标签带上路由

- 用户的困惑：终端里看到的是 `magpie/auto/deepseek-v4.1-flash`，界面只显示
  `Deepseek-V4.1-Flash · routing group`，两者对不上，也不直观。
- 原因：Pi 的模型列表同时给 `provider`、`id`、`name`，界面只用了 `name`，`id` 只藏在选项值里。
- 改法：下拉按 provider 分组（`v2ex` / `explabs` / `magpie` / `oneapi`）；标签是 `name`，
  若 `id` 带路由前缀而名字里没体现，再补 ` · 路由`（如 `· auto`）；悬停提示给完整 `provider/id`。
  分组标签本身就对应终端里那串前缀。
- 验证：17 个模型分 4 组；当前项显示 `Deepseek-V4.1-Flash · routing group · auto`，
  title 为 `magpie/auto/deepseek-v4.1-flash`。

## STATUS-008：按 pi-gui 重做布局

- 用户指出布局离 pi-gui 差太远，给了截图参照。改成它那套浅色形态，不再是深色两栏。
- 外壳：页面灰底 + 圆角窗口，侧栏独立成浅灰面板。
- 侧栏：顶部收起按钮、整行「新建对话」、导航（对话带数量 / 设置）、对话段头带筛选按钮；
  列表按日期分组（今天 / 昨天 / 本周 / 更早），每条两行：标题 + 时间，工作区 + 运行状态。
- 主区：面包屑「工作区 / 标题」+ 重命名铅笔；空态是品牌方块 + 小标签 + 大标题 + 工作区选择。
- 输入区：卡片 + 胶囊行（工作区、模型、思考等级）+ 圆形发送键；提示行只在有队列时出现。
  空态直接输入也会建对话再发出去。
- 其他：设置面板显示 Seven Station Core 地址、版本、对话库路径、连接状态；侧栏可收起（状态存本地）。
- 验证：真窗口截图（空态、对话、折叠、设置）；新建 → 选 auto 模型 → 发一句话 → 收到「收到」；
  标题在发送后即时更新到面包屑与侧栏。
- 与参考的差异：参考里的 Scheduled / Skills / Extensions 三个入口我们没有对应功能，没有摆空壳。

## STATUS-009：输入侧与常驻

这轮补的都是"用起来缺的那几块"，UI 细化留到后面。

- `@` 文件补全：Seven Station Core 自己扫工作区（不经过 Pi），选了目录会接着往下钻；只允许在工作区里找。
- `/` 命令列表：走 Pi 的 `get_commands`（扩展命令、提示词模板、技能），按工作区缓存。
- 图片可以粘贴、也能直接拖进窗口；拖的时候编辑区给个高亮。
- 代码块右上角「复制」，悬停才出现。
- 头部「导出为 Markdown」：标题、工作区、时间，用户与助手正文，工具调用一行一条。
- Seven Station Core 常驻：`scripts/start-center.ps1`（隐藏窗口、等端口真起来）、`stop-center.ps1`、
  `install-autostart.ps1`（登录自启的计划任务，支持 `-Status` / `-Remove`）。
- 内容根固定到 exe 目录：从任何位置启动都能找到 `wwwroot`，打包后双击也不会白屏。

## STATUS-010：终端面板

- 每条对话一个常驻 shell，从头部终端图标打开，面板摆在对话区与输入区之间。
- 实现走 `pwsh -Command -`：命令一行一行喂标准输入，变量与工作目录都延续，
  不需要 PTY，也不用在前端塞终端模拟器。代价写在文档里：交互式全屏程序（vim、top）用不了。
- 没有 pwsh 的机器退回系统自带 powershell；非 Windows 平台走 `bash -s`。
- 输出是广播：两台设备同时开着，看到的是同一条命令流的同一份输出；
  后来打开的设备会把已经跑出来的缓冲补上。
- 面板上有清空、结束进程、收起；输入框支持上下键翻历史，Esc 收起。
- 控制序列在服务端就剥掉了，界面只显示纯文本，不会变成乱码。

## STATUS-011：工作区文件浏览

- 头部文件夹图标打开右侧抽屉：面包屑路径、进入目录、上一层、关闭。
- 文件点开是只读预览，等宽字体；超过 512 KB 或看起来是二进制的文件直接说明原因，不去猜。
- 路径只能在会话工作区里走：`..` 或绝对路径跑出去一律当作找不到。
- 抽屉打开时正文（顶栏、对话区、终端、输入区）整体让开，不压在输入框上面。

## STATUS-012：搜索、记忆与几个日常缺口

- 搜索：标题与正文一起搜，结果里带命中的那一小段。正文存在 `messages.text` 列
  （`payload` 里的中文是 `\uXXXX` 转义的，直接 LIKE 搜不到），老库启动时补列并回填。
- 工作区记忆：用过的目录记在 Seven Station Core（最多 8 条），新建对话时直接挑；输入框会实时检查目录在不在，
  不存在就不让点「开始」。
- 快捷键：Ctrl+K 新建、Ctrl+B 侧栏、Ctrl+J 终端、Ctrl+E 文件、Ctrl+F 搜索、Esc 关弹层。
- 设置面板：Pi 装没装、会话目录、最近工作区、快捷键清单，外加「看最近日志」——
  手机上出问题先看这一屏。
- 断线兜底：Seven Station Core 没起来时，客户端不再是一页白屏，而是说明连的哪个地址、配置在哪、5 秒自动重试。
- 工具卡片里的文件路径点一下就打开文件面板；聊天里的图片点开可放大。
- 切回窗口时自动对一次会话列表与当前状态（别的设备可能改过）。

## STATUS-013：窗口记忆与图片压缩

- 客户端记住窗口大小与位置（`%LOCALAPPDATA%\SevenStation\window.json`）；
  换了显示器导致坐标跑出屏幕时只恢复尺寸，位置仍回到居中。
- 粘进来或拖进来的图片超过 1600 像素就先等比缩小再发（4000×2000 的截图从 157 KB 降到 39 KB）；
  透明图仍存 PNG，GIF 不动。

## STATUS-014：小收尾

- 设置里显示 Seven Station Core 对外地址，并标出「只本机能连」还是「局域网可连」。
- 对话滚动往上翻时出现「回到最新」，新内容不会把位置顶走。

## STATUS-015：冒烟脚本跟上界面

- `scripts/ui-smoke.mjs` 之前靠按钮文案判断「正在跑」，改成看 `stop` 类；
  新建会话后也不再等「线程出现」，而是等「换成新会话」——旧会话开着时线程本来就可见。
- 工作区输入框不再禁用「开始」：目录检查只给提示，真正把关的是 Seven Station Core 建对话时的校验。
  禁用来禁去会跟人抢跑道，也让自动化脚本点不动。

## STATUS-016：按原型做掉六处细节

- 侧栏的技能与扩展数量改成连上就拉一次，不用点进页面才出现。
- 对话行的删除键换成 24 像素圆角图标键，跟「几分钟前」占同一个位置：悬浮时时间淡出。
  行本身从 `<button>` 换成 `role="button"` 的 div，删除键才能落进第二行。
- 工作区胶囊的箭头从字体符号改成 12 像素图标，名字过长中间省略，箭头固定在右端不参与挤位。
- 模型面板高度写死 392 × 420：切分组、搜模型、只剩三个模型都不再跳高跳矮（原先是 403 上下浮动）。
- 图标按钮尺寸归到 26 / 22 / 28 / 32 / 24 五档，图标按边长取整像素；发送与附加键换成图标。
- 小圆点归到 8 / 12 / 16 三档。原来是 7 和 11，1.25 倍缩放下落在半个物理像素上，
  截图放大是 8×9 的带平边糊块，看着不像圆。
- 顺带修三处暗色主题下看不见的图案：停止方块与开关旋钮写死 `#fff` 压在近白底色上，改成 `--on-accent`；
  侧栏折叠键的悬浮底色也改成主题色。

## STATUS-017：状态点、进行中的历史、每步与整轮用时

- 侧栏状态点按状态上色：跑着是转圈，跑完是绿色，只有还没开始过的空对话是灰色。
  之前跑完也是灰色，看着像出了问题。
- 这一轮还在跑的时候就把内容落库：用户的话、每段模型输出、每个工具结果一产生就
  `AppendMessages` 追加，轮次结束再由 `PersistTurnAsync` 拿 Pi 的完整消息整体替换（能自愈）。
  中途切到别的对话再切回来，看到的是正在跑的内容，不再是空白。
- 每步耗时一直在 Pi 的消息里（`toolResult.durationMs`），历史渲染没往界面传，所以完成之后只剩步数；
  现在补上。整轮用时按消息自己的时间点算（用户那句话到最后一次动作），不再把各步相加当总计；
  还在跑的时候按开始到现在每秒刷新，和输入框下面的提示是同一个数。

## STATUS-018：发布口径收口（命名、许可证、死配置）

- 产物改名成 `<项目名>-<平台>-<架构>-<版本>.msi`：Seven Station Core `SevenStationCore-win-x64-<版本>.msi`，
  客户端 `SevenStation-win-x64-<版本>.msi`。两个 Release 分开建，名字与包名一致。
- 仓库加 `LICENSE`（GPLv3 全文），README 增「装起来用」「许可证」两节，「发布」一节按 MSI 重写；
  `RELEASE.md` 按两个产品的命名、门禁、`gh release create` 两条命令重写。
- 两个安装程序的许可页都换掉 WiX 自带的假文字，改用 `installer/license.rtf`（GPLv3 说明与安装会做的事），
  构建脚本用 `-d LicenseRtf=` 传进去，不再各自放一份。
- 删掉客户端 MSI 里只写不读的 `HKLM\SOFTWARE\SevenStation`（`CenterUrl`/`CenterToken`）：
  安装向导早就不问这两项了，装一次写一对空字符串，属于死配置。客户端现在只认
  `%LOCALAPPDATA%\SevenStation\center.json`、`token.txt` 与环境变量，`winreg` 依赖一并去掉。
- 修「Pi 名片里的会话目录」：写在 `~/.pi/sessions`，那里根本不存在，Pi 1.5 的会话在
  `<agent 目录>\sessions`。
- 发布说明拆成 `docs/release-notes/v0.3.0-core.md` 与 `v0.3.0-client.md`，两份都过门禁
  （`--link-pattern '/blob/[^/\s]+/'`，因为标签不带 `v` 前缀）。
- 验证：`dotnet build SevenStation.slnx` 0 错误；两个 MSI 用 `wix msi decompile` 核过
  （客户端无 Registry 表、Seven Station Core 有 `ServiceInstall`、两边许可页都是 GPL 文本）；
  两个包的 `.sha256` 与文件对应。

## STATUS-019：从 Pi / magpie 恢复会话

- 入口：侧栏「新建对话」右侧常驻一个恢复按钮（原型 A 版）。没配过令牌的新机器仍走引导页。
- 对话框（原型 P1 版）：左列表右预览。列表按工作区分组、按开始时间倒序，能搜标题或工作区；
  每行给标题、时间，已收进对话库的变灰并标「已恢复」。预览给首句、消息数、大小、时间、模型、
  工作目录和最近一条回复。
- 两栏的来源：`Pi` 直接扫 `<agent 目录>\sessions`；`magpie 命令`粘一整条
  `Set-Location -LiteralPath '…'; pi --session <id>`，Seven Station Core 解析出会话 id 再匹配，那一栏是单栏。
- 恢复的语义是**接管**不是复制：对话绑定到原来那个 Pi 会话文件（`pi_session_file`），
  消息按 `user`/`assistant`/`toolResult` 搬进对话库用于渲染，续聊时 `pi --session <文件>`
  接着原来那段跑。验证过：恢复 389 条那段，发一句「只回复两个字：继续」，原 jsonl 从 437 行涨到 438 行。
- 重复恢复直接打开已有那段（`already: true`），不会复制出第二份。
- 扫描带缓存（路径 + mtime + 大小）：197 段冷扫 236 ms，热扫 24 ms。
- 顺手加的：`.modal textarea { min-height: 140px }` 会压住更具体度更低的规则，
  命令输入框带上 `.modal` 前缀才定得住 54 px。

## 归档索引
