# 构建与发布

## 发布前置

- 版本号写在**五处**，必须同号：Seven Station Core 在 `src/SevenStation.Core/SevenStation.Core.csproj` 的 `<Version>`，
  Seven Station Control 与客户端在各自 `Cargo.toml` 的 `version` 与 `tauri.conf.json` 的 `version`
  （Tauri 应用是 Rust，没有 csproj）。五处一致，产物文件名与发布说明里的版本号才跟着对。
- Seven Station Control 不单独发：它打进 Seven Station Core 的 MSI（`docs/DECISIONS.md` D9），跟着一起装、一起卸。
- 发布说明**一个版本一个文件**：`docs/release-notes/v<版本>.md`（两个包共用一份正文），
  过门禁：`python scripts/verify_release_notes.py --link-pattern '/blob/[^/\s]+/' docs/release-notes/v<版本>.md`
- 发布前必须跑通：`dotnet build SevenStation.slnx`，以及
  `node scripts/ui-smoke.mjs --cwd <目录>`（Seven Station Core 与客户端先用 `scripts/dev-run.ps1` 起来）。

## 产物

两个产品各有自己的安装程序，装在不同的机器上（见 `docs/DECISIONS.md` D7）。都不做便携版：
Seven Station Core 要靠服务起来、要有开机自启和升级路径，双击 exe 那种形态撑不住这些。

| 包 | 内容 | 命名 |
| --- | --- | --- |
| Seven Station Core | 安装程序：装到 `%ProgramFiles%\SevenStation Core`，注册服务 `SevenStationCore`（自动启动、系统账户），带 Seven Station Control，开始菜单三个快捷方式 | `SevenStationCore-Setup-<版本>.exe`（约 44 MB） |
| 客户端 | 安装程序：装到 `%ProgramFiles%\SevenStation`，开始菜单与桌面快捷方式；第一次打开走引导页填 Seven Station Core 地址与令牌 | `SevenStation-Setup-<版本>.exe`（约 3.8 MB） |

**外层是 exe，里面还是 MSI**（WiX Burn，`installer/*/Bundle.wxs`）。原因：资源管理器给 `.msi` 的文件图标是系统统一那枚，
MSI 里换图标不生效（两个 msi 的图标提取出来逐像素相同），只有 exe 的图标是我们能控制的——Core 用浅底那枚、
客户端用深底那枚，放一起才分得开。升级兼容性靠 MSI 自己的 `UpgradeCode` + `AllowSameVersionUpgrades`：
以前用 MSI 装过的会被原地升级，不会并存第二份。`dist/` 只放 exe，MSI 是中间产物（`work/msi/`）。

命名规则：`<项目名>-Setup-<版本>.exe`，只用 ASCII 字母、数字、`-` 和 `.`；
校验文件同名加 `.sha256`，内容是 `<哈希> <文件名>`，`sha256sum -c` 能直接读。

- Seven Station Core（含 Seven Station Control）：`powershell -File scripts/build-installer-center.ps1`
  （`-SkipPublish` 复用已有发布输出，脚本会自己构建 Control；`cargo` 不在 PATH 里也没关系，脚本会补）。
- 安装画面素材（`installer/assets/banner.bmp`、`dialog.bmp`）由 `python design/make-installer-art.py` 生成，
  图形取自 `src/SevenStation.Control/icons/tray.png`，不另画。
- 客户端：`powershell -File scripts/build-installer-client.ps1`（`-SkipBuild` 复用已有 `target/release`）。
- 两个安装程序的许可页读 `installer/license.rtf`（GPLv3 说明），构建脚本用 `-d LicenseRtf=` 传进去。
- `scripts/build-release.ps1` 打的是便携 zip，只给本机试跑用，正式发布不发。
- WiX 5 是 dotnet 全局工具（`dotnet tool install -g wix --version 5.0.2`），脚本会自己找 `~/.dotnet/tools/wix.exe`。
- 数据不进安装目录、也不随卸载删除：Seven Station Core 的配置、令牌、对话库、日志都在 `%ProgramData%\SevenStation.Core\`。
- 客户端的连接信息只放在本机 `%LOCALAPPDATA%\SevenStation\center.json`（带 `userSet` 标记），
  安装程序不写注册表，改地址不用重装。
- Seven Station Core 安装时不问 Pi 装在哪：服务第一次启动自己探测（`PI_AGENT_DIR` 优先，其次各用户目录下的 `~/.pi/agent`），
  写进 `settings.json`，之后按配置走；改配置用开始菜单的「打开 Seven Station Core 配置」。
- 服务跑在系统账户下，但 Pi 的子进程会配上配置里记的用户家目录（`HOME`/`USERPROFILE`），
  技能、扩展、会话都在真实用户那边，Seven Station Core 读这些目录也走同一份家目录。
- Seven Station Core 默认只监听 `127.0.0.1`。跨设备使用要改 `settings.json` 里的 `Listen` 并在防火墙放行。
- 两个包都是 Windows x64。Seven Station Core 以后会搬到 Linux 上跑，那时再加 Linux 包。

## 流程

1. 改三处版本号，写一份发布说明 `docs/release-notes/v<版本>.md`，跑门禁，提交。
2. 推 `main`。
3. 出包：两个安装程序脚本各跑一遍，再在一台干净环境里真装、真跑、再卸载。
4. 打标签并推，标签就是版本号：

   ```bash
   git tag -a v<版本> -m "Seven Station <版本>"
   git push origin v<版本>
   ```

5. 建**一个** Release，把这一版的两个包放进同一个发布。标签、标题都是 `v<版本>`：

   ```bash
   gh release create v<版本>      dist/SevenStationCore-Setup-<版本>.exe      dist/SevenStationCore-Setup-<版本>.exe.sha256      dist/SevenStation-Setup-<版本>.exe      dist/SevenStation-Setup-<版本>.exe.sha256      --verify-tag --title "v<版本>" --notes-file build/release/v<版本>.md
   ```

   正文 = 发布说明 + `## 构建信息` 表（版本、平台、架构、运行时、安装形态、源码提交、每个产物的 SHA-256），
   不传 `.wixpdb` 之类的调试符号。两个包同号、同一次发布，读者在一个页面里就能看到配套关系。
6. 复核线上产物名、大小、校验和，确认没有显示标签，`--latest` 落在新版本上。
7. 已发布的标签不改写，修复走递增版本。

## 发布面约定

- **标签只有版本号**（`v0.4.0`），不带产品名。一个版本两个包，就一个 Release。
- **Release 标题就是标签本身**，不加前缀。
- **产物名**是 `<产品>-Setup-<版本>.exe` 加同名 `.sha256`，只有 ASCII 字母、数字、`-`、`.`。
- 发布说明按规范分「新功能」与「问题修复」两节，不超过 40 行，链接指向 `/blob/v<版本>/`。

## 回滚

- 代码：`git revert`。
- 产物：留上一版的 Seven Station Core 与客户端两个包及校验和，说明「Seven Station Core 与客户端版本必须一致」。
