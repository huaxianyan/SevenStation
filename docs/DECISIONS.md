# 长期决策

只记被确立或被推翻过的方向，改了才更新。日常进度在 `docs/STATUS.md`。

## D1 Seven Station Core + 客户端，替代「只做 PC 端」

2026-11-17 用户定。原约束是「只要 PC 端，一个独立桌面应用；不做网页版，不做手机端」——
这条作废，出处是用户当天说明：Seven Station Core 化部署一套系统负责与 Pi 交互，客户端只连这套 Seven Station Core，
在 PC 或手机上打开对接的都是同一份会话；以后客户端再加 host 能力，用 Seven Station Core 的 Pi 去操作别的设备。

交互形态参考 alu-dock，但只借使用体验，不照搬实现：alu-dock 依赖 `aruru-project/pi` 的 fork，
本项目坚持用本机已装的上游 `pi`。

## D2 只有 Seven Station Core 起 Pi 子进程

会话、`pi --mode rpc` 子进程、会话文件扫描全在 Seven Station Core。客户端不碰 Pi，也不读会话文件。
结果：换设备只是换个客户端，任务仍在 Seven Station Core 那台机器上跑。

同一个会话被多个客户端打开时复用同一个子进程，只有一个写者。

## D3 页面由 Seven Station Core 托管，桌面壳与浏览器共用一份前端

前端只有 `src/SevenStation.Core/wwwroot` 一份。桌面客户端是 WebView2 壳，加载 Seven Station Core 地址；
手机浏览器打开同一地址即可。命令与事件都走 `/ws?token=`，不再依赖 `chrome.webview` 桥，
所以同一套 `app.js` 在两种环境里行为一致。

## D5 对话归 SevenStation.Core，客户端不读 Pi

2026-11-17 用户定，替代「客户端直接列 Pi 会话」的做法。起因是实际用起来 Pi 那边的会话目录太乱：
积了一百多条结束未清理的记录，点开旧会话要等很久，还有加载不出来的。

- 对话是 SevenStation.Core 的概念，存在自己的库里。客户端只跟 MA 通讯，列表与历史都来自 MA。
- MA 与 Pi 的会话是内部绑定：用户在某个工作区新建对话，MA 按需开一个 Pi 会话并记下映射；
  每轮结束把 Pi 的消息取回来，存成 MA 自己的副本。绑定字段不出现在任何客户端接口里。
- 结果：看历史不启动 Pi 进程（实测 109 ms）；Pi 那边的会话文件被清掉也能看历史，只是接不上上下文；
  删除对话只删 MA 的副本，Pi 的原始文件保留。
- 旧的 Pi 会话不迁移：MA 从空库开始，避免把原来的乱账搬进来。

## D8 一切以 Seven Station Core 为准：模型只在 Seven Station Core 配，任务由 Seven Station Core 下发，数据全在 Seven Station Core

2026-11-18 用户定的最终形态。终端设备数量不设上限，但配置与数据只有一份，都在 Seven Station Core：

- **模型只在 Seven Station Core 配**：可用的模型、额度、默认模型、思考等级策略都由 Seven Station Core 那台机器上的 Pi 决定，
  客户端不存任何模型凭据，界面上选模型只是给这次对话指定用哪个，不是本地配置。
- **任务由 Seven Station Core 下发与控制**：一条任务除了「说什么」，还要能指定「在哪台设备上做、动哪个目录」。
  没有指定就是 Seven Station Core 本机；指定了某台客户端，就派给那台设备上的节点执行，停止、追问、进度都从 Seven Station Core 控制。
- **数据全在 Seven Station Core**：对话、消息、每一步的输出与耗时都落 Seven Station Core 的库；设备上的执行过程也回写同一份记录，
  换一台设备打开同一个对话看到的是同一份历史。协同靠这一份数据，不靠设备之间互相同步。

要为此留的位置（首版不实现，先把结构摆对）：

- 设备身份：每台客户端有自己的稳定 ID 与名字，连上时声明在线；Seven Station Core 存一份设备表。
- 任务的目标设备：对话/任务带一个设备维度，默认 Seven Station Core 本机。
- 节点执行的结果按同一套消息形状写回，不做第二套渲染。

## D10 全项目只认三个名字：Seven Station Core / Seven Station Control / Seven Station

2026-11-19 用户要求：「全局使用叫 Seven Station Core 和 Seven Station Control，不要擅自翻译中心和控制台了」。

- **Seven Station Core**：服务端，管对话库、Pi 子进程、WebSocket、托管前端。程序集与 Windows 服务名仍是
  `SevenStationCore` / `SevenStation.Core`（代码标识符不动）。
- **Seven Station Control**：那个开停服务、看日志、改监听地址的窗口，跟 Core 装在一个 MSI 里。
- **Seven Station**：客户端，装到要用的机器上。
- 面向用户的每一处（界面文案、窗口标题、托盘菜单、安装向导、「应用和功能」、开始菜单、日志、文档）都用这三个名字，
  不再出现「中心」「控制台」这两个译名。中文句子里夹英文名时，前后各留一个半角空格。
- 例外只有一类：`控制台窗口` 这种指 Windows 命令行窗口的说法（`#![windows_subsystem]` 那句注释），
  跟产品无关，照旧写「命令行窗口」。

## D9 Seven Station Control 并进 Seven Station Core 的安装包，不单独发

2026-11-19 定。Seven Station Control（`SevenStation.Control`，Tauri）是用来开停 Seven Station Core、看日志、改监听地址、放行防火墙的，
离不开 Seven Station Core 服务，所以**跟着 Seven Station Core 的安装程序一起装**，不单独出一个 MSI、不单开一个 Release。

- Seven Station Core 的 MSI 里同时放 `SevenStation.Control.exe`，开始菜单给一条快捷方式，卸载时一起清掉。
- 版本号跟 Seven Station Core 同号走（`0.4.0` 起三处一致：Seven Station Core csproj、客户端 Cargo、Seven Station Control Cargo）。
- Seven Station Control 自己不改系统状态时才不需要提权：开停服务、改监听、加防火墙规则都会弹 UAC，这是预期行为。
- 客户端仍是独立产品（D7 不变）：Seven Station Core 那台装 Seven Station Core + Seven Station Control，其它设备只装客户端。

## D7 两个产品分开部署，客户端自己就是节点

2026-11-18 定。Seven Station Core（SevenStation.Core）与客户端（SevenStation）是两个独立产品，各有各的安装程序，
以后大概率不在同一台机器上：Seven Station Core 可以放在一台专用的 Linux 机器上，其它设备只装客户端。

- 客户端不只是看界面的壳：它还要能被 Seven Station Core 派活，在客户端自己的设备上执行操作。
  所以不再单独装一个 agent，节点能力就长在客户端里。
- 节点通道由客户端**主动连 Seven Station Core**（出站 WebSocket，同一套 `/ws`，连接时声明自己是节点），
  不在客户端设备上开入站端口。Seven Station Core 那边按连接派活，断开即视为离线。
- 节点做的事是在用户设备上执行命令与读写文件，等同于把设备交给 Seven Station Core：
  配对要按设备授权，权限范围与二次确认在协议里留位置，第一版只出安装程序、不实现节点。

首版交付：Seven Station Core 的安装程序（装服务）和客户端的安装程序（配置 Seven Station Core 地址与令牌），都是 Windows。
Linux 版等用户的 Linux 环境就绪再做，代码里已经有 `OperatingSystem.IsWindows()` 的分支。

## D6 进行中的一轮由 Seven Station Core 增量落库，不等轮次结束

2026-11-18。按 D5，消息只在轮次结束（`agent_settled`）时整体保存；这一轮没跑完的时候
库里还是空的，用户中途切到别的对话再切回来，看到的就是空白页。

改成：用户的话、每段模型输出、每个工具结果一产生就 `AppendMessages` 追加进库里；
轮次结束再 `PersistTurnAsync` 拿 Pi 的完整消息整体替换，重复或漏的都能自愈。
判重按工具调用号（工具结果）与消息时间点（用户与助手）做，`agent_start` 时清空。

随之确定的还有两件跟时间有关的事：

- 每步耗时用 Pi 随结果给的 `toolResult.durationMs`，历史渲染也要显示，不能只在跑的当场有。
- 整轮用时按消息自己的时间点算（用户那句话到最后一次动作），不是各步相加——
  各步相加只算工具，漏掉思考和模型输出。

## D4 命名：Seven Station Core SevenStation.Core，客户端 SevenStation

**2026-11-19 更正**：面向用户的文字不再把 Seven Station Core 译成「中心」、把 Seven Station Control 译成「控制台」。
界面、安装程序、「应用和功能」、开始菜单、托盘菜单、日志里一律直接写英文名（见 D10）。

2026-11-17 用户定。MA 既是 Main 也是 Main Agent 的缩写，Seven Station Core 就叫 SevenStation.Core；面向用户打开的那个
窗口叫 SevenStation。两个名字分工固定：说 SevenStation.Core 指部署在 Seven Station Core 那套服务，说 SevenStation
指客户端。程序集按这个分。目录不再分两份：改名后 Seven Station Core 与客户端都写 `%LOCALAPPDATA%\SevenStation`，
令牌 `token.txt`、日志 `logs/`、对话库 `data/`、客户端配置 `center.json` 并列在一起。

## D11 发版只由用户主动发起，不问

2026-11-20 用户定：平时开发只管把代码推上仓库，**不要问要不要发版**，也不要顺手打标签、建 Release。
用户要发版会明说；没说就是不发。问一次就够了，反复问是噪音。

## D12 Pi 只在用户登录会话里跑，不做 SYSTEM 回落

2026-11-22 用户定。Seven Station Core 作为服务跑在 Session 0（SYSTEM），Pi 若当场起子进程，
环境、PATH、凭据、窗口站全是服务账户的：调工具经常多绕几圈（费时间也费 token），起的 GUI 窗口
在桌面上看不见，生成的文件 owner 是 SYSTEM。这跟「用户在终端里用 Pi」不是一件事。

所以分两半：服务只当大脑，Pi 由用户登录会话里的执行代理（同一个 exe 的 `--runner` 角色）来起。

- **不回落**：代理连不上就明确报错，不允许退回 SYSTEM 起 Pi。静默降级会变成「有时能用有时不能用」，最难查。
- **没登录就是不能用**：Windows 上接受这个结果。锁屏（Win+L）不影响，注销或停在校验界面时不能跑。
- **Windows 是过渡**：后面主目标是 Linux，那边的会话模型不一样，到时要重新看，别把 Windows 的这套当通用结论。

