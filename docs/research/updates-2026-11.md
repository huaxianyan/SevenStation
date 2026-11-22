# 技能、扩展与 Pi 自身的版本与升级（调研与方案）

2026-11-22。目标：界面上能看见「技能 / 扩展 / Pi 现在是什么版本、有没有新版」，并且能从 Seven Station 里
把升级做掉。这篇只出方案，不动代码。

## 一、现在能看见什么、看不见什么

| | 现在 | 缺什么 |
| --- | --- | --- |
| 技能 | 扫 `SKILL.md`：名字、描述、路径、用户/项目范围 | 来源、版本、有没有新版 |
| 扩展 | 读 `~/.pi/agent/settings.json` 的 `packages[]`，解出 `kind`/`name`/安装目录/`package.json` 里的版本 | 有没有新版、怎么升级 |
| Pi 自身 | 完全没有 | 版本号、有没有新版、怎么升级 |

## 二、这台机器上的实测（数据源是否可用）

```text
pi --version                     1.5.2
install/current-version          1.5.2
install/releases/                1.5.1、1.5.2（旧版还在，能回退）
registry.npmjs.org/@earendil-works/pi-coding-agent/latest   1.6.0   ← 确实有新版没人看得见
```

扩展 7 个，逐个查「本地 vs 最新」的结果：

| 来源 | 包 | 本地 | 最新 |
| --- | --- | --- | --- |
| npm | pi-web-access | 0.48.0 | 0.48.0 |
| npm | pi-btw | 0.8.1 | 0.8.1 |
| npm | pi-proxy-router | 1.2.4 | 1.2.4 |
| npm | @narumitw/pi-lsp | 0.49.12 | 0.49.12 |
| git | pi-v2ex-quota | 5eeeaca | 5eeeaca |
| git | pi-smart-compact（钉在 `@v2ex-recovery`） | 29622f2 | 远端 HEAD cb3c143（要按钉的分支比，不能比默认分支） |
| git | TokenEconomizer | 4a04fe4 | 1bfeccd |

技能 18 个全是本地目录，没有 `.git`、`SKILL.md` 里也没有版本字段 —— **技能没有「版本」这个概念**，
它要么手工维护，要么由某个扩展包带进来。

数据源结论：三类都能查，且都不需要凭据。npm 走 `registry.npmjs.org/<包名>/latest`，git 走
`git ls-remote <remote> <ref>` 与本地 `rev-parse HEAD` 比较，Pi 自身走 npm 上同一个包。

## 三、方案

### 1. 读版本（只读，先做）

**Pi 自身**：Core 读 `<PiHome>/.pi/agent/install/current-version`，拿不到再退回 `pi --version`。

**最新版**：查 npm registry，别每次开页面都打网络 ——
- 缓存 6 小时（跟模型清单的 `modelsAt` 一个路子，存 `settings` 表）；
- 页面上的「检查更新」强制刷新；
- 超时 5 秒，失败只让徽标消失，不报错、不阻塞界面。

**npm 扩展**：`registry.npmjs.org/<name>/latest`，与 `package.json` 的版本比。

**git 扩展**：ref = source 里的 `@xxx`（没有就用当前分支），
`git ls-remote origin <ref>` 的首 7 位与本地 `rev-parse HEAD` 的前 7 位比。**不同就是有新版**——
这里只判断「有没有」，不判断「谁能自动合」，因为钉住的仓库可能要 rebase。

**技能**：不加版本，加两样能看的：
- 来源：用户 / 项目；如果它的路径在某个扩展包目录里，标成「来自 <包名>」；
- 本地目录的 `SKILL.md` 修改时间。

技能升级不做，理由：18 个技能里没有一个是从远端拉的，升级渠道本来就不存在。
将来如果 `pi install` 支持带技能的包，技能的版本就跟着包走，自动就覆盖了。

### 2. 升级动作

| 目标 | 命令 | 走哪 |
| --- | --- | --- |
| Pi 自身 | `pi update`（= `--self`） | 执行代理（用户在登录会话里跑） |
| 全部扩展 | `pi update --extensions` | 同上 |
| 单个扩展 | `pi update <source>` | 同上 |
| 模型目录 | `pi update --models` | 同上，设置页单独一个按钮 |

**为什么必须走执行代理**：Pi 只能由用户登录会话里的进程起（D12），`pi update` 会写
`~/.pi/agent/install` 并可能调 npm/git，用的是用户的环境。Core 在 Session 0 里直接跑，拿到的是 SYSTEM 的
环境变量与凭据，容易装到奇怪的地方去。

2026-11-22 现场核对（本机装的是 v0.4.0，服务形态）：

```text
pid 56576  会话 0  owner=<SYSTEM>            监听 0.0.0.0:8787   ← Seven Station Core（服务）
pid  7320  会话 1  owner=BAHAMUTinaBranford  命令行含 --runner   ← 执行代理（用户态）
```

也就是说：**Core 本身不是用户态**，用户态的是执行代理。但凡「Core 直接起一个子进程」的动作，
拿到的都是 SYSTEM 的环境与家目录；我们自己也有一处专门为这件事打的补丁（`CoreSettings` 里
systemprofile 那段注释），所以升级更不能再走捷径。

**执行代理要加一条受控通道**：现在它只会按 Core 给的 exe/参数/cwd 起 Pi（`--mode rpc`）。
升级需要的是「跑一次 `pi` 的命令行，把输出流回来」：
- 白名单只允许 `pi update [--self|--extensions|--models|--all|source]`，不接受任意命令；
- 输出按行转成进度卡片（复用「一张卡片从进行中翻成完成/失败」的机制）；
- 退出码非 0 就把最后几行 stderr 放进卡片。

**前置检查**（不做成禁止，做成「默认不让动，除非用户确认」）：
- 有会话正在跑：提示会打断当前 Pi 进程，让他先停或者确认；
- 升级完成后自动跑一次握手：起一次 `--mode rpc` 发 `get_state`，成功才算完成。
  版本校验不用我们做——Pi 自己的更新流程在激活前已经会对新版本做一次 `--version` 冒烟（见下「已经核实过的」）。
- 回退只能回一步：见下。

### 3. 界面

**设置页「连接」卡片下面加「Pi」小节**

```
Pi              1.5.2 → 1.6.0（有新版）      [检查更新] [升级 Pi]
模型目录        上次刷新 3 天前               [刷新]
```

**扩展页**：每行版本徽标后面加一个「→ 1.6.0」或「有新版」徽标；页面头部放「检查更新」「更新全部」。

**技能页**：每行加来源标签（用户 / 项目 / 来自 xxx），不显示版本；页面头部一句说明「技能随手动维护
或随扩展包更新」。

## 三点五、读 Pi 自己的更新代码核实过的事（2026-11-22）

翻了 `install/releases/1.5.2/.../dist/bundle/chunks/chunk-VEJDBY3O.js` 里的托管安装逻辑：

- **激活是原子的**：新版本先装进 `install/staging/update-*`，对装好的版本跑一次 `--version` 冒烟
  （`Managed Pi smoke test returned version …`），通过之后才写 `current-version`（临时文件 + rename）。
  所以「装坏一半」的概率比想象中低，我们的握手只需要验 **RPC**（`--mode rpc` + `get_state`）。
- **并发有锁**：更新时锁住 `install/update`（proper-lockfile）。我们不要自己再造一把锁，
  撞上就提示「已经在更新中」。
- **旧版本只留一步**：`pruneManagedReleases()` 会把 `releases/` 下除「新激活的版本」和「正在跑的更新器版本」
  之外的目录全删。也就是说**回退只能回上一个版本**，而且只在下次升级之前有效。
  方案里「回退到 releases/<旧版>」要按这个写，别承诺能回好几个版本。

## 四、边界与风险

- **不自动升级**：只在用户点按钮时动作。检查更新是只读的网络请求，可以自动跑（带缓存）。
- **网络失败不影响使用**：徽标不显示，界面照常。
- **写的是用户目录**，不需要管理员；如果 Pi 装在 `Program Files` 之类的位置会失败，报错并给出手工命令。
- **升级后老会话还是老进程**（正常）：新会话才用新版。升级期间不建议有长任务在跑。
- **RPC 协议兼容**是唯一实质风险：我们对 Pi 的依赖是 `--mode rpc`、`--append-system-prompt`、
  `--session`。升级后必须有一次自动握手，失败要能一眼看出来，并且能退回旧版本。
- **git 扩展钉住的分支**：只提示「有新版」，不自动改指向 —— 钉住的仓库升级可能改变行为，让人自己决定。

## 四点五、还没验证、必须先试的（决定这条路能不能走）

1. **无 TTY 时 `pi update` 会不会卡住等输入。** `--approve/--no-approve` 只解决项目可信，
   别的提示（例如「要装到哪里」「要不要迁移配置」）还没见过。要实测，并给命令加超时与强杀。
2. **`pi update` 会不会改动用户手改过的配置。** 这台机器的 `models.json` 有 `before-magpie`、`before-explabs`
   两份手工备份，说明改过；Pi 有 `migrations.js`，升级很可能重写 `settings.json` / `models.json`。
   如果会，必须先做「备份 + 差异提示」，否则用户的模型/路由配置可能被静默改掉。这是最实际的风险。
3. **git 扩展的「有新版」判定**：钉的是 tag 还是分支、工作区脏不脏、远端没跟踪的情况，都还没测。
   脏工作区直接 `pi update` 可能冲突或覆盖本地改动。
4. **白名单通道本身**：执行代理一旦能「按 Core 的指令跑命令行」，校验必须在**代理侧**做（只认
   `pi update` 这几种参数），不能靠 Core 自觉；否则等于给一条任意命令执行的路子。

前两条建议用一次**完全隔离**的实跑确认：把 `~/.pi/agent`（不含 `sessions`）复制到
`work/smoke/pi-home`，用 `PI_MANAGED_INSTALL_ROOT` 指过去跑 `pi update --self`，
观察是否有提问、以及对 `settings.json` / `models.json` 的改动。约 150 MB 复制 + 一次下载。

## 五、实施顺序与工作量

1. **只读可见**（Core 读版本 + 缓存 + 前端徽标）：约 1 天。做完就能看见 1.5.2 → 1.6.0，风险最低。
2. **升级通道**（执行代理白名单命令 + 进度卡片 + 握手校验）：约 1 天。
3. **扩展逐个升级 + 模型目录刷新按钮**：半天。
4. **测试**：Core 侧单测（版本比较、git ref 解析、缓存过期）+ 隔离环境冒烟
   （临时 `PI_HOME` 跑 `pi update --models`，不碰真实安装）。

建议先做第 1 步，让「有新版」这件事先可见，再决定升级按钮放在哪儿。
