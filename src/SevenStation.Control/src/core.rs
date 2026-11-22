use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};

use serde::Serialize;

/// 服务名、防火墙规则名、Seven Station Core 可执行文件名，都只在这里出现一次。
pub const SERVICE: &str = "SevenStationCore";
pub const FIREWALL_RULE: &str = "Seven Station Core";

/// 服务名：`SEVENSTATION_SERVICE` 可覆盖。
/// 隔离测试用它指到一个不存在的服务名上，免得测试时把正在用的那份停掉。
pub fn service() -> &'static str {
    static NAME: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    NAME.get_or_init(|| override_or("SEVENSTATION_SERVICE", SERVICE))
}

/// 防火墙规则名：`SEVENSTATION_FIREWALL_RULE` 可覆盖，测试时不碰真正在用的那条。
pub fn firewall_rule() -> &'static str {
    static NAME: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    NAME.get_or_init(|| override_or("SEVENSTATION_FIREWALL_RULE", FIREWALL_RULE))
}

/// 测试档案。设了 `SEVENSTATION_PROFILE` 就走测试档案：不挂单实例、日志与配置各放一处，
/// 免得测试时动到正在用的那份。
pub fn profile() -> Option<String> {
    match std::env::var("SEVENSTATION_PROFILE") {
        Ok(value) if !value.trim().is_empty() => Some(value.trim().to_string()),
        _ => None,
    }
}

fn override_or(key: &str, fallback: &str) -> String {
    match std::env::var(key) {
        Ok(value) if !value.trim().is_empty() => value.trim().to_string(),
        _ => fallback.to_string(),
    }
}
/// 规则参数改过就把这串跟着改，老规则会被当成过期重建。
const FIREWALL_MARK: &str = "SevenStation-LAN-V2";

/// 改过名的老规则。名字一换，旧规则就再没人认领，但它还在放行端口，
/// 所以每次动防火墙都顺手清掉。
const LEGACY_FIREWALL_RULES: [&str; 1] = ["Seven Station 中心"];
pub const CORE_EXE: &str = "SevenStation.Core.exe";

/// 要提权才能做的事，把自己再拉起来一次，带上这个参数。
pub const ELEVATE_FLAG: &str = "--do";

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const ERROR_ACCESS_DENIED: i32 = 5;
const DEFAULT_LISTEN: &str = "http://127.0.0.1:8787";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub service_installed: bool,
    pub running: bool,
    pub mode: String,
    pub listen: String,
    pub token: String,
    pub data_directory: String,
    pub version: String,
    pub autostart: bool,
    pub scope: String,
    pub local_address: Option<String>,
    pub logs: Vec<String>,
    pub since: String,
    /// 配置里记下的 Pi 安装目录（空串表示还没配，Core 每次启动会自己探测）。
    pub pi_directory: String,
    /// 这个目录下真的有 bin/pi-launcher.js，也就是 Core 能跑起来。
    pub pi_ready: bool,
}

// ------------------------------ 目录 ------------------------------

/// Seven Station Core 根目录，`SEVENSTATION_CORE_HOME` 可整体挪走（开发和测试用它隔离）。
pub fn home() -> PathBuf {
    match std::env::var("SEVENSTATION_CORE_HOME") {
        Ok(value) if !value.trim().is_empty() => PathBuf::from(value.trim()),
        _ => PathBuf::from(std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".into()))
            .join("SevenStation.Core"),
    }
}

pub fn data_directory() -> PathBuf {
    match std::env::var("SEVENSTATION_DATA_DIR") {
        Ok(value) if !value.trim().is_empty() => PathBuf::from(value.trim()),
        _ => home().join("data"),
    }
}

fn settings_file() -> PathBuf {
    home().join("settings.json")
}

fn token_file() -> PathBuf {
    home().join("token.txt")
}

/// 主令牌。Control 拿它调 Core 的管理接口（局域网里那几台设备拿的是自己的令牌）。
pub fn token() -> String {
    std::fs::read_to_string(token_file())
        .map(|text| text.trim().to_string())
        .unwrap_or_default()
}

/// Core 在听的端口，跟 settings.json 里一致。
pub fn port() -> u16 {
    port_of(&read_listen())
}

fn log_file() -> PathBuf {
    home().join("logs").join("center.log")
}

// ------------------------------ 状态快照 ------------------------------

pub fn snapshot() -> Snapshot {
    let installed = service_exists();
    let running = if installed { service_running() } else { portable_running() };
    let listen = read_listen();

    let pi_directory = read_pi_directory();
    let pi_ready = !pi_directory.is_empty() && pi_entry(&pi_directory).is_some();

    Snapshot {
        service_installed: installed,
        running,
        mode: match (installed, running) {
            (true, true) => "service",
            (true, false) => "stopped",
            (false, true) => "portable",
            (false, false) => "stopped",
        }
        .to_string(),
        listen: listen.clone(),
        token: read_token(),
        data_directory: data_directory().display().to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        autostart: installed && autostart_on(),
        scope: if is_lan(&listen) { "lan" } else { "local" }.to_string(),
        local_address: local_address(),
        logs: tail_log(6),
        since: since_text(),
        pi_directory,
        pi_ready,
    }
}

// ------------------------------ Pi 安装目录 ------------------------------

/// 这个目录里 Pi 的入口。两种装法都认：
/// 官方安装包是 `bin/pi-launcher.js`，npm 装法是 `node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`。
fn pi_entry(directory: &str) -> Option<PathBuf> {
    let launcher = Path::new(directory).join("bin").join("pi-launcher.js");
    if launcher.exists() {
        return Some(launcher);
    }

    let package = Path::new(directory)
        .join("node_modules")
        .join("@earendil-works")
        .join("pi-coding-agent");
    for relative in ["dist/bundle/cli.js", "dist/cli.js"] {
        let candidate = package.join(relative);
        if candidate.exists() {
            return Some(candidate);
        }
    }

    None
}

/// 配置里记下的 Pi 目录。没配过就是空串，交给 Core 启动时自己探测。
pub fn read_pi_directory() -> String {
    fs::read_to_string(settings_file())
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| {
            value
                .get("Agents")
                .and_then(|agents| agents.get("pi"))
                .and_then(|pi| pi.get("Directory"))
                .and_then(|directory| directory.as_str())
                .map(|text| text.to_string())
        })
        .unwrap_or_default()
}

/// 改 Pi 安装目录。空串表示清掉，让 Core 下次启动重新探测。
pub fn set_pi_dir(path: &str) -> Result<(), String> {
    let trimmed = path.trim().trim_matches('"');

    if !trimmed.is_empty() && pi_entry(trimmed).is_none() {
        return Err(
            "这个目录里没找到 Pi：既没有 bin\\pi-launcher.js，也没有 npm 包里的 dist\\bundle\\cli.js。选 Pi 的安装目录，一般是 用户名\\.pi\\agent 或 用户名\\AppData\\Local\\pi-node\\current。"
                .into(),
        );
    }

    // ProgramData 下的配置要管理员才能写，没提权就交给提权进程做。
    if !is_elevated() {
        return elevate(&["pi", trimmed]);
    }

    write_pi_dir(trimmed)
}

fn write_pi_dir(path: &str) -> Result<(), String> {
    // 提权入口也是这条路，校验放在这里，别的地方绕不过去。
    if !path.is_empty() && pi_entry(path).is_none() {
        return Err("这个目录下没有 bin/pi-launcher.js，不是 Pi 的安装目录。".into());
    }

    let file = settings_file();
    fs::create_dir_all(home()).map_err(|error| format!("写不进配置：{error}"))?;

    // 读不懂就别写：以前这里读失败会从空对象开始，一写就把 Listen 之类整份配置抹了。
    let existing = fs::read_to_string(&file).unwrap_or_else(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            String::from("{}")
        } else {
            String::new()
        }
    });
    let mut settings = serde_json::from_str::<serde_json::Value>(&existing)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .ok_or_else(|| format!("现有配置读不懂，先不动它：{}", file.display()))?;

    let agents = settings
        .entry("Agents")
        .or_insert_with(|| serde_json::json!({}));
    if let Some(map) = agents.as_object_mut() {
        let entry = map.entry("pi").or_insert_with(|| serde_json::json!({}));
        if let Some(pi) = entry.as_object_mut() {
            pi.insert("Directory".into(), serde_json::Value::String(path.into()));
            let home_dir = derive_home(path);
            if !home_dir.is_empty() {
                pi.insert("Home".into(), serde_json::Value::String(home_dir));
            }
        }
    }

    let text = serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?;
    fs::write(&file, text).map_err(|error| format!("写不进配置：{error}"))?;

    if service_exists() {
        restart()?;
    }
    Ok(())
}

/// 标准位置顺手推出家目录（`<用户>\.pi\agent` 与 `<用户>\AppData\Local\pi-node\current`）；
/// 别的位置留空，交给 Core 兜底。
fn derive_home(path: &str) -> String {
    let directory = Path::new(path);
    let is_standard = directory
        .file_name()
        .map(|name| name.eq_ignore_ascii_case("agent"))
        .unwrap_or(false)
        && directory
            .parent()
            .and_then(|parent| parent.file_name())
            .map(|name| name.eq_ignore_ascii_case(".pi"))
            .unwrap_or(false);

    if !is_standard {
        // npm 装法：<家目录>\AppData\Local\pi-node\current
        let normalized = path.replace('/', "\\");
        let parts: Vec<&str> = normalized.trim_end_matches('\\').split('\\').collect();
        let tail = parts.len();
        if tail >= 4
            && parts[tail - 1].eq_ignore_ascii_case("current")
            && parts[tail - 2].eq_ignore_ascii_case("pi-node")
            && parts[tail - 3].eq_ignore_ascii_case("Local")
            && parts[tail - 4].eq_ignore_ascii_case("AppData")
        {
            return if tail >= 5 { parts[..tail - 4].join("\\") } else { String::new() };
        }
        return String::new();
    }

    directory
        .parent()
        .and_then(|parent| parent.parent())
        .map(|home| home.display().to_string())
        .unwrap_or_default()
}

// ------------------------------ 服务与进程 ------------------------------

fn run(program: &str, args: &[&str]) -> (i32, String) {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);

    match command.output() {
        Ok(output) => {
            let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
            text.push_str(&String::from_utf8_lossy(&output.stderr));
            (output.status.code().unwrap_or(-1), text)
        }
        Err(_) => (-1, String::new()),
    }
}

fn service_exists() -> bool {
    run("sc.exe", &["query", service()]).0 == 0
}

fn service_running() -> bool {
    let (code, text) = run("sc.exe", &["query", service()]);
    code == 0 && text.contains("RUNNING")
}

fn autostart_on() -> bool {
    let (code, text) = run("sc.exe", &["qc", service()]);
    code == 0 && text.contains("AUTO_START")
}

fn portable_running() -> bool {
    let (_, text) = run("tasklist.exe", &["/FI", &format!("IMAGENAME eq {CORE_EXE}"), "/NH"]);
    text.contains(CORE_EXE)
}

pub fn start() -> Result<(), String> {
    if service_exists() {
        let (code, _) = run("sc.exe", &["start", service()]);
        return match code {
            0 => wait_for(true),
            ERROR_ACCESS_DENIED => elevate(&["start"]),
            _ => Err("Seven Station Core 没启动起来，可以在「事件查看器」里看服务为什么退出。".into()),
        };
    }

    let exe = core_exe_path()?;
    if !exe.exists() {
        return Err(format!("没找到 {CORE_EXE}，它应该和 Seven Station Control 放在同一个目录里。"));
    }

    Command::new(&exe)
        .current_dir(exe.parent().unwrap_or_else(|| std::path::Path::new(".")))
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|error| format!("启动失败：{error}"))?;
    Ok(())
}

pub fn stop() -> Result<(), String> {
    if service_exists() {
        let (code, _) = run("sc.exe", &["stop", service()]);
        return match code {
            0 => wait_for(false),
            ERROR_ACCESS_DENIED => elevate(&["stop"]),
            _ => Err("Seven Station Core 没停下来，稍后再试一次。".into()),
        };
    }

    if !portable_running() {
        return Ok(());
    }

    run("taskkill.exe", &["/IM", CORE_EXE, "/T", "/F"]);
    if portable_running() {
        return Err("Seven Station Core 没停下来，稍后再试一次。".into());
    }
    Ok(())
}

pub fn restart() -> Result<(), String> {
    if service_exists() {
        // 直接 sc stop + sc start 要两跳，提权时也只要一次 UAC，所以合并成一条。
        let (code, _) = run("sc.exe", &["stop", service()]);
        match code {
            0 => {}
            ERROR_ACCESS_DENIED => return elevate(&["restart"]),
            _ => {}
        }
        // 停不下来也别就此收手：继续 start，让它把真正的原因说出来。
        // 以前是 wait_for(false)? 一超时就直接返回，服务就停在「已停止」再没人拉起来。
        let _ = wait_for_tries(false, WAIT_STOP_TRIES);
        let (code, _) = run("sc.exe", &["start", service()]);
        return match code {
            0 => wait_for(true),
            ERROR_ACCESS_DENIED => elevate(&["restart"]),
            _ => Err("Seven Station Core 没启动起来，可以在「事件查看器」里看服务为什么退出。".into()),
        };
    }

    stop()?;
    start()
}

/// `sc start/stop` 是异步的，等它真的换了状态再回界面。
/// 等服务的状态变成期望值。停止可能要几十秒（要收掉 Pi 子进程），所以给足时间。
const WAIT_STOP_TRIES: u32 = 90;
const WAIT_START_TRIES: u32 = 60;

fn wait_for(running: bool) -> Result<(), String> {
    wait_for_tries(running, if running { WAIT_START_TRIES } else { WAIT_STOP_TRIES })
}

fn wait_for_tries(running: bool, tries: u32) -> Result<(), String> {
    for _ in 0..tries {
        if service_running() == running {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }

    Err(if running {
        "Seven Station Core 没启动起来，可以在「事件查看器」里看服务为什么退出。".to_string()
    } else {
        "Seven Station Core 没停下来，稍后再试一次。".to_string()
    })
}

pub fn core_exe_path() -> Result<PathBuf, String> {
    let current = std::env::current_exe().map_err(|error| format!("找不到自己的位置：{error}"))?;
    Ok(current
        .parent()
        .map(|dir| dir.join(CORE_EXE))
        .unwrap_or_else(|| PathBuf::from(CORE_EXE)))
}

// ------------------------------ 自启 ------------------------------

pub fn set_autostart(on: bool) -> Result<(), String> {
    if !service_exists() {
        return Err("还没装成服务，便携模式没有开机自启。".into());
    }

    let value = if on { "auto" } else { "demand" };
    let (code, _) = run("sc.exe", &["config", service(), "start=", value]);
    match code {
        0 => Ok(()),
        ERROR_ACCESS_DENIED => elevate(&[if on { "autostart-on" } else { "autostart-off" }]),
        _ => Err("开机自启没改成，稍后再试一次。".into()),
    }
}

// ------------------------------ 监听范围与防火墙 ------------------------------

pub fn set_lan(on: bool) -> Result<(), String> {
    // 改监听、放行防火墙、重启服务都要管理员，没提权就整套交给提权进程做。
    if !is_elevated() {
        return elevate(&["lan", if on { "on" } else { "off" }]);
    }
    set_lan_now(on)
}

fn set_lan_now(on: bool) -> Result<(), String> {
    let port = port_of(&read_listen());
    let listen = if on {
        format!("http://0.0.0.0:{port}")
    } else {
        format!("http://127.0.0.1:{port}")
    };

    // 先放行，再改监听：反过来的话中间有一段时间端口开着却没规则。
    if on && !has_firewall_rule(port) {
        if let Err(message) = add_firewall_rule(port) {
            return Err(format!("局域网还是没打开：{message}"));
        }
    }

    write_listen(&listen)?;
    restart()
}

fn add_firewall_rule(port: u16) -> Result<(), String> {
    let local_port = format!("localport={port}");
    let name = format!("name={}", firewall_rule());
    let mark = format!("description={FIREWALL_MARK}");

    // 参数变了就重建：老规则可能只放行专用网络，留着等于没生效。
    let _ = run("netsh.exe", &["advfirewall", "firewall", "delete", "rule", &name]);
    for legacy in LEGACY_FIREWALL_RULES {
        let legacy = format!("name={legacy}");
        let _ = run("netsh.exe", &["advfirewall", "firewall", "delete", "rule", &legacy]);
    }

    let (code, _) = run(
        "netsh.exe",
        &[
            "advfirewall",
            "firewall",
            "add",
            "rule",
            &name,
            &mark,
            "dir=in",
            "action=allow",
            "protocol=TCP",
            &local_port,
            // 系统常把家用网络判成「公用」，只写 private,domain 等于没放行；
            // 靠 remoteip 限住来源网段，别把端口摊到整个互联网。
            "profile=any",
            "remoteip=localsubnet",
        ],
    );

    match code {
        0 => Ok(()),
        // netsh 没提权时返回 1（"请求的操作需要提升"），不是 5；两个都当要提权。
        ERROR_ACCESS_DENIED | 1 => elevate(&["firewall", &port.to_string()]),
        _ => Err(format!("防火墙规则没加上（netsh 返回 {code}）。")),
    }
}

fn has_firewall_rule(_port: u16) -> bool {
    let name = format!("name={}", firewall_rule());
    let (code, text) = run("netsh.exe", &["advfirewall", "firewall", "show", "rule", &name]);
    // 认标记不认端口：参数一变就要重建，否则老规则会被当成已经放行。
    code == 0 && text.contains(FIREWALL_MARK)
}

// ------------------------------ 令牌 ------------------------------

pub fn regenerate_token() -> Result<(), String> {
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );

    fs::create_dir_all(home()).map_err(|error| format!("写不进令牌文件：{error}"))?;
    fs::write(token_file(), token).map_err(|error| format!("写不进令牌文件：{error}"))?;

    // Seven Station Core 只在启动时读令牌，改完得让它重新起一次，否则新令牌不生效。
    restart()
}

fn read_token() -> String {
    fs::read_to_string(token_file())
        .map(|text| text.trim().to_string())
        .unwrap_or_default()
}

// ------------------------------ 配置与日志 ------------------------------

fn read_listen() -> String {
    fs::read_to_string(settings_file())
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| value["Listen"].as_str().map(|text| text.to_string()))
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| DEFAULT_LISTEN.to_string())
}

fn write_listen(listen: &str) -> Result<(), String> {
    let path = settings_file();
    fs::create_dir_all(home()).map_err(|error| format!("写不进配置：{error}"))?;

    // 只动 Listen，别的键（比如 Agents）原样留着。
    let mut settings = fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    settings.insert("Listen".into(), serde_json::Value::String(listen.into()));

    let text = serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?;
    fs::write(&path, text).map_err(|error| format!("写不进配置：{error}"))
}

fn port_of(listen: &str) -> u16 {
    let authority = listen
        .split("://")
        .nth(1)
        .unwrap_or(listen)
        .split('/')
        .next()
        .unwrap_or(listen);
    authority
        .rsplit(':')
        .next()
        .and_then(|port| port.parse().ok())
        .unwrap_or(8787)
}

fn is_lan(listen: &str) -> bool {
    listen.contains("0.0.0.0") || listen.contains("[::]") || listen.contains('*')
}

/// 这台机器在局域网里的地址：连一个 UDP 目标只为了问路由表自己是谁，不发包。
fn local_address() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    if ip.is_loopback() || ip.is_unspecified() {
        None
    } else {
        Some(ip.to_string())
    }
}

fn tail_log(lines: usize) -> Vec<String> {
    let mut file = match fs::File::open(log_file()) {
        Ok(file) => file,
        Err(_) => return Vec::new(),
    };

    let length = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let _ = file.seek(SeekFrom::Start(length.saturating_sub(64 * 1024)));

    let mut buffer = Vec::new();
    let _ = file.read_to_end(&mut buffer);

    let all: Vec<String> = String::from_utf8_lossy(&buffer)
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.trim_end().to_string())
        .collect();

    all[all.len().saturating_sub(lines)..].to_vec()
}

/// 运行时长从日志里最后一条「Seven Station Core 启动」反推：服务跑在系统账户下，普通权限读不到它的进程时间。
fn since_text() -> String {
    let started = tail_log(400)
        .into_iter()
        .rev()
        .find(|line| line.contains("Seven Station Core 启动"))
        .and_then(|line| parse_log_time(&line));

    let Some(started) = started else {
        return String::new();
    };

    // 两边都用同一个时区偏移，拿不到本地时区就一起退回 UTC，差值依然对。
    let now = time::OffsetDateTime::now_utc().to_offset(local_offset());
    let span = now - started;
    if span.whole_hours() >= 1 {
        format!("已运行 {} 小时 {} 分", span.whole_hours(), span.whole_minutes() % 60)
    } else if span.whole_minutes() >= 1 {
        format!("已运行 {} 分钟", span.whole_minutes())
    } else {
        "刚启动".to_string()
    }
}

fn local_offset() -> time::UtcOffset {
    time::UtcOffset::current_local_offset().unwrap_or(time::UtcOffset::UTC)
}

fn parse_log_time(line: &str) -> Option<time::OffsetDateTime> {
    // 日志行首是「2026-11-18 19:22:36.866」，取秒级那一段就够。
    let head = line.get(..19)?;
    let format = time::macros::format_description!("[year]-[month]-[day] [hour]:[minute]:[second]");
    let parsed = time::PrimitiveDateTime::parse(head, &format).ok()?;
    Some(parsed.assume_offset(local_offset()))
}

// ------------------------------ 提权 ------------------------------

/// 需要管理员时把自己再拉起来一次（UAC），子进程做完就退。
/// 当前进程有没有管理员权限：`net session` 只有管理员跑得动。
fn is_elevated() -> bool {
    run("net.exe", &["session"]).0 == 0
}

fn elevate(args: &[&str]) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|error| format!("找不到自己的位置：{error}"))?;
    let script = format!(
        "Start-Process -FilePath '{}' -ArgumentList '{ELEVATE_FLAG} {}' -Verb RunAs -Wait",
        exe.display(),
        args.join(" ")
    );

    let status = Command::new("powershell.exe")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|error| format!("起不了管理员进程：{error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err("没拿到管理员权限，这一步没做成。".into())
    }
}

/// 提权子进程的入口：做一件事就退，不建窗口。
pub fn run_elevated(args: &[String]) -> i32 {
    let first = match args.first() {
        Some(value) => value.as_str(),
        None => return 2,
    };

    match first {
        "start" => {
            run("sc.exe", &["start", service()]);
            wait_for(true).ok();
            0
        }
        "stop" => {
            run("sc.exe", &["stop", service()]);
            wait_for(false).ok();
            0
        }
        "restart" => {
            run("sc.exe", &["stop", service()]);
            wait_for(false).ok();
            run("sc.exe", &["start", service()]);
            wait_for(true).ok();
            0
        }
        "autostart-on" => run("sc.exe", &["config", service(), "start=", "auto"]).0,
        "autostart-off" => run("sc.exe", &["config", service(), "start=", "demand"]).0,
        "lan" => match args.get(1).map(|value| value.as_str()) {
            Some("on") => match set_lan_now(true) {
                Ok(()) => 0,
                Err(_) => 4,
            },
            Some("off") => match set_lan_now(false) {
                Ok(()) => 0,
                Err(_) => 4,
            },
            _ => 3,
        },
        "pi" => {
            let path = args.get(1).cloned().unwrap_or_default();
            match write_pi_dir(&path) {
                Ok(()) => 0,
                Err(_) => 4,
            }
        }
        "firewall" => match args.get(1).and_then(|port| port.parse::<u16>().ok()) {
            Some(port) => match add_firewall_rule(port) {
                Ok(()) => 0,
                Err(_) => 4,
            },
            None => 3,
        },
        _ => 3,
    }
}

// ------------------------------ 给界面用的小动作 ------------------------------

pub fn copy_text(text: &str) -> Result<(), String> {
    let mut child = Command::new("clip.exe")
        .stdin(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|error| format!("复制失败：{error}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        // clip 收 UTF-16 也行，但 UTF-8 更省事，它对换行敏感。
        stdin
            .write_all(text.as_bytes())
            .map_err(|error| format!("复制失败：{error}"))?;
    }

    child.wait().map_err(|error| format!("复制失败：{error}"))?;
    Ok(())
}

pub fn open_target(target: &str) -> Result<(), String> {
    match target {
        "url" => {
            let listen = read_listen();
            Command::new("cmd.exe")
                .args(["/c", "start", "", &listen])
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .map_err(|error| format!("打不开地址：{error}"))?;
            Ok(())
        }
        "data" => open_folder(&data_directory()),
        "logs" => open_folder(&log_file().parent().map(PathBuf::from).unwrap_or_else(home)),
        _ => Err("不认识的目标。".into()),
    }
}

fn open_folder(path: &std::path::Path) -> Result<(), String> {
    let _ = fs::create_dir_all(path);
    Command::new("explorer.exe")
        .arg(path)
        .spawn()
        .map_err(|error| format!("打不开目录：{error}"))?;
    Ok(())
}
