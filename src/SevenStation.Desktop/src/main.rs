// Windows 上不要弹命令行窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_notification::NotificationExt;

/// 壳自己的东西都放这个目录：Seven Station Core 地址、令牌、窗口位置、日志。
/// 设了 `SEVENSTATION_PROFILE` 就换成 `SevenStation-<档案>`，测试不碰正在用的那份配置。
fn data_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".to_string());
    match profile() {
        Some(profile) => PathBuf::from(base).join(format!("SevenStation-{profile}")),
        None => PathBuf::from(base).join("SevenStation"),
    }
}

fn profile() -> Option<String> {
    match std::env::var("SEVENSTATION_PROFILE") {
        Ok(value) if !value.trim().is_empty() => Some(value.trim().to_string()),
        _ => None,
    }
}

fn log(message: &str) {
    let dir = data_dir().join("logs");
    let _ = fs::create_dir_all(&dir);
    let path = dir.join("client.log");
    if fs::metadata(&path).map(|m| m.len() > 1_048_576).unwrap_or(false) {
        let _ = fs::remove_file(&path);
    }
    let line = format!("{} {}\n", timestamp(), message);
    use std::io::Write;
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = file.write_all(line.as_bytes());
    }
}

fn timestamp() -> String {
    let now = time::OffsetDateTime::now_local()
        .unwrap_or_else(|_| time::OffsetDateTime::now_utc());
    let format = time::macros::format_description!(
        "[year]-[month]-[day] [hour]:[minute]:[second]"
    );
    now.format(&format).unwrap_or_default()
}

/// Seven Station Core 地址与令牌分头找，各自取第一个有值的：
/// 地址：`center.json`（用户填过就以它为准）→ 默认本机
/// 令牌：`center.json` → `token.txt` → 环境变量 `SEVENSTATION_TOKEN`
///
/// 令牌优先看 `center.json`：用户自己补一份就生效，不用为了改一个字符串重装一遍。
struct Center {
    base_url: String,
    token: Option<String>,
}

/// 本机保存的那份配置：`userSet` 为真表示用户自己在界面上改过。
fn stored_center() -> Option<Value> {
    let text = fs::read_to_string(data_dir().join("center.json")).ok()?;
    serde_json::from_str::<Value>(&text).ok()
}

fn stored_text(config: &Option<Value>, key: &str) -> Option<String> {
    let value = config.as_ref()?.get(key)?.as_str()?.trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn read_center() -> Center {
    let dir = data_dir();
    let config_path = dir.join("center.json");
    let fallback = "http://127.0.0.1:8787/".to_string();

    if !config_path.exists() {
        let _ = fs::create_dir_all(&dir);
        let _ = fs::write(
            &config_path,
            "{\n \"url\": \"http://127.0.0.1:8787/\",\n \"token\": \"\"\n}\n",
        );
    }

    let stored = stored_center();
    let user_set = stored
        .as_ref()
        .and_then(|value| value.get("userSet"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let mut base_url: Option<String> = None;
    let mut token: Option<String> = None;

    if user_set {
        base_url = stored_text(&stored, "url");
        token = stored_text(&stored, "token");
        log("连接设置来自本机保存的配置");
    }

    if base_url.is_none() {
        base_url = stored_text(&stored, "url");
    }

    if token.is_none() {
        token = stored_text(&stored, "token");
    }

    if token.is_none() {
        if let Ok(value) = fs::read_to_string(dir.join("token.txt")) {
            let trimmed = value.trim();
            if trimmed.len() >= 16 {
                token = Some(trimmed.to_string());
            }
        }
    }

    if token.is_none() {
        if let Ok(value) = std::env::var("SEVENSTATION_TOKEN") {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                token = Some(trimmed.to_string());
            }
        }
    }

    let mut base_url = base_url.unwrap_or(fallback);
    if !base_url.ends_with('/') {
        base_url.push('/');
    }

    Center { base_url, token }
}

/// 界面上读取这台设备的连接设置。
#[tauri::command]
fn client_config_get() -> Value {
    let stored = stored_center();
    let user_set = stored
        .as_ref()
        .and_then(|value| value.get("userSet"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let center = read_center();
    let source = if user_set { "file" } else { "default" };

    serde_json::json!({
        "url": center.base_url,
        "token": center.token.unwrap_or_default(),
        "source": source,
    })
}

/// 界面上保存连接设置：写到本机 `center.json`（带 userSet 标记），然后直接连新的地址。
#[tauri::command]
fn client_config_save(window: tauri::WebviewWindow, url: String, token: String) -> Result<(), String> {
    let mut base_url = url.trim().to_string();
    if base_url.is_empty() {
        return Err("Seven Station Core 地址不能为空".into());
    }
    if !base_url.starts_with("http://") && !base_url.starts_with("https://") {
        return Err("地址要以 http:// 或 https:// 开头".into());
    }
    if !base_url.ends_with('/') {
        base_url.push('/');
    }

    let dir = data_dir();
    fs::create_dir_all(&dir).map_err(|error| format!("建目录失败：{error}"))?;
    let payload = serde_json::json!({
        "url": base_url,
        "token": token.trim(),
        "userSet": true,
    });
    let text = serde_json::to_string_pretty(&payload).map_err(|error| format!("写配置失败：{error}"))?;
    fs::write(dir.join("center.json"), text).map_err(|error| format!("写配置失败：{error}"))?;
    log(&format!("本机连接设置已更新：{base_url}"));

    let mut target = base_url;
    if let Some(value) = payload.get("token").and_then(|value| value.as_str()) {
        if !value.is_empty() {
            let encoded: String = value
                .chars()
                .map(|ch| {
                    if ch.is_ascii_alphanumeric() || "-_.~".contains(ch) {
                        ch.to_string()
                    } else {
                        format!("%{:02X}", ch as u32)
                    }
                })
                .collect();
            target.push_str(&format!("?token={encoded}"));
        }
    }

    let parsed = tauri::Url::parse(&target).map_err(|error| format!("地址解析失败：{error}"))?;
    window.navigate(parsed).map_err(|error| format!("打开新地址失败：{error}"))?;
    Ok(())
}

fn center_url(center: &Center) -> String {
    match &center.token {
        None => center.base_url.clone(),
        Some(token) => {
            let separator = if center.base_url.contains('?') { '&' } else { '?' };
            format!(
                "{}{}token={}",
                center.base_url,
                separator,
                urlencode(token)
            )
        }
    }
}

fn urlencode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Seven Station Core 跟壳是不是同一台机器：决定选目录时该给谁的路径。
fn center_is_local(center: &Center) -> bool {
    let host = center
        .base_url
        .split("//")
        .nth(1)
        .unwrap_or_default()
        .split(['/', ':'])
        .next()
        .unwrap_or_default()
        .to_lowercase();

    host == "127.0.0.1"
        || host == "localhost"
        || host == "::1"
        || host == std::env::var("COMPUTERNAME").unwrap_or_default().to_lowercase()
}

fn bounds_path() -> PathBuf {
    data_dir().join("window.json")
}

fn read_bounds() -> Option<(f64, f64, f64, f64)> {
    let text = fs::read_to_string(bounds_path()).ok()?;
    let parsed: Value = serde_json::from_str(&text).ok()?;
    let get = |key: &str| parsed.get(key).and_then(|v| v.as_f64());
    Some((get("left")?, get("top")?, get("width")?, get("height")?))
}

fn save_bounds(window: &WebviewWindow) {
    let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let payload = json!({
        "left": position.x as f64 / scale,
        "top": position.y as f64 / scale,
        "width": size.width as f64 / scale,
        "height": size.height as f64 / scale,
    });
    let _ = fs::create_dir_all(data_dir());
    let _ = fs::write(
        bounds_path(),
        serde_json::to_string_pretty(&payload).unwrap_or_default(),
    );
}

/// 选目录：交给系统的对话框，选完把路径给页面。
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle, initial: Option<String>) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;

    let mut builder = app.dialog().file();
    if let Some(path) = initial.filter(|p| !p.trim().is_empty()) {
        builder = builder.set_directory(path);
    }

    builder
        .blocking_pick_folder()
        .map(|picked| picked.to_string())
}


/// 用系统的「打开方式」打开：文件交给默认程序，目录开资源管理器，网址开默认浏览器。
///
/// 以前这里是 `Command::new("explorer.exe").arg(path)`，有个毛病：新窗口常常**开在后台**。
/// Windows 的前台锁按「是谁启动了这个进程」算，explorer 那条链不在前台，被它拉起来的程序
/// 就拿不到前台权限——用户看到的只是任务栏闪一下，像点了没反应。
/// ShellExecuteW 相当于在资源管理器里双击，前台权限跟着发起调用的这个进程走。
fn open_via_shell(target: &str) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;

    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            hwnd: *mut core::ffi::c_void,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show: i32,
        ) -> isize;
    }

    fn wide(value: &str) -> Vec<u16> {
        OsStr::new(value).encode_wide().chain(std::iter::once(0)).collect()
    }

    // SW_SHOWNORMAL：不要最大化也不要最小化，按程序自己的默认来。
    const SW_SHOWNORMAL: i32 = 1;
    let operation = wide("open");
    let file = wide(target);
    let result = unsafe {
        ShellExecuteW(
            ptr::null_mut(),
            operation.as_ptr(),
            file.as_ptr(),
            ptr::null(),
            ptr::null(),
            SW_SHOWNORMAL,
        )
    };

    // ShellExecuteW 把 HINSTANCE 当返回值：<= 32 都是错误码（32 是「没有关联程序」）。
    if result <= 32 {
        return Err(format!("打不开：{target}（ShellExecute 返回 {result}）"));
    }
    Ok(())
}

/// 打开一个路径：目录在资源管理器里打开，文件用默认程序直接打开。
///
/// 这件事必须由壳来做：Seven Station Core 是 Windows 服务，它 `Process.Start` 出来的
/// explorer 活在会话 0，用户屏幕上什么都不会出现（点了就像没反应）。
#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    let target = path.trim();
    if target.is_empty() {
        return Err("没有路径".into());
    }

    // 先确认它还在：不然 explorer 会自己弹一个「找不到」的框，不如我们在页面上说清楚。
    fs::metadata(target).map_err(|_| format!("找不到这个路径：{target}"))?;

    // 目录是打开文件夹，文件是用关联程序打开；前台权限跟着客户端走，窗口不会再藏在后面。
    open_via_shell(target)
}

/// 用系统浏览器打开一个地址。只认 http/https，别让页面把壳当成随便起程序的入口。
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let target = url.trim();
    if !(target.starts_with("http://") || target.starts_with("https://")) {
        return Err("只支持 http/https 地址".into());
    }

    open_via_shell(target).map_err(|error| format!("打不开浏览器：{error}"))
}

/// 一轮工作跑完时提醒一声：只在人没看着这个窗口时才弹（切去干别的就不会错过）。
/// 判断在壳里做，页面那边不用自己猜窗口状态；浏览器里打开时没有壳，这条路径根本不会被调到。
#[tauri::command]
fn notify_done(app: tauri::AppHandle, title: String, body: String) -> Result<bool, String> {
    let focused = app
        .get_webview_window("main")
        .and_then(|window| window.is_focused().ok())
        .unwrap_or(false);
    if focused {
        log("通知：窗口有焦点，不打扰");
        return Ok(false);
    }

    // 弹不出通知时只能靠这一行日志判断卡在哪：AUMID 没注册、系统关了通知、专注助手都会静默丢掉。
    // 必须点名音效：不写 <audio> 时这台机器上是静音弹出的（试过，只有横幅没有声音）。
    // "Default" 就是系统通知音（ms-winsoundevent:Notification.Default），winrt-notification 认这个名字。
    match app
        .notification()
        .builder()
        .title(&title)
        .body(&body)
        .sound("Default")
        .show()
    {
        Ok(()) => log(&format!("通知：已弹出（{title}）")),
        Err(error) => log(&format!("通知：弹出失败 {error}")),
    }

    Ok(true)
}

/// 在资源管理器里打开文件「所在的位置」，并把文件选中。
/// 与 `reveal_path` 的区别：那个是直接打开（文件交给默认程序），这个是打开目录定位到它。
#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    let target = path.trim();
    if target.is_empty() {
        return Err("没有路径".into());
    }

    let meta = fs::metadata(target).map_err(|_| format!("找不到这个路径：{target}"))?;
    let mut command = std::process::Command::new("explorer.exe");

    if meta.is_dir() {
        command.arg(target);
    } else {
        // /select 只吃一个参数，路径带空格也不用加引号（Command 自己会处理）。
        command.arg(format!("/select,{target}"));
    }

    command.spawn().map_err(|error| error.to_string())?;
    Ok(())
}

/// 去掉 canonicalize 加上的 `\\?\` 前缀；UNC 的 `\\?\UNC\` 还原成 `\\`。
fn plain_path(path: &std::path::Path) -> String {
    let text = path.to_string_lossy().to_string();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!("\\\\{rest}")
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        text
    }
}

/// 把文件本体放进剪贴板（资源管理器里对着文件按 Ctrl+C 的效果），可以直接粘到聊天窗口。
/// 剪贴板属于当前登录会话，所以只能在壳里做：Core 当服务跑在 Session 0，它碰不到用户的剪贴板。
#[tauri::command]
fn copy_file(path: String) -> Result<(), String> {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    use std::os::windows::process::CommandExt;

    let target = path.trim();
    if target.is_empty() {
        return Err("没有路径".into());
    }

    // canonicalize 在 Windows 上会给结果加 `\\?\` 前缀，带这个前缀的路径塞进剪贴板别人读不了，得去掉。
    let full = plain_path(&fs::canonicalize(target).map_err(|_| format!("找不到这个路径：{target}"))?);

    // 走 PowerShell 的 SetFileDropList：路径从环境变量进去，不拼进命令行，省掉整套引号转义的麻烦。
    let script = "$f = New-Object System.Collections.Specialized.StringCollection;                   [void]$f.Add($env:SEVENSTATION_COPY_FILE);                   Add-Type -AssemblyName System.Windows.Forms;                   [System.Windows.Forms.Clipboard]::SetFileDropList($f)";

    let status = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script])
        .env("SEVENSTATION_COPY_FILE", &full)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|error| format!("起不了剪贴板进程：{error}"))?;

    if !status.status.success() {
        return Err(format!(
            "复制到剪贴板失败：{}",
            String::from_utf8_lossy(&status.stderr).trim()
        ));
    }

    Ok(())
}

/// 页面问壳：Seven Station Core 在本机吗。
#[tauri::command]
fn center_local(app: tauri::AppHandle) -> bool {
    let _ = app;
    center_is_local(&read_center())
}

fn main() {
    // 测试档案不挂单实例：否则测试版开门就并进正在用的那一个窗口。
    let mut builder = tauri::Builder::default();
    if profile().is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 已经开着一个了：把那个窗口提到前面，不再开第二个。
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            pick_folder,
            reveal_path,
            reveal_in_explorer,
            copy_file,
            open_url,
            notify_done,
            center_local,
            client_config_get,
            client_config_save
        ])
        .setup(|app| {
            let center = read_center();
            log(&format!("启动，Seven Station Core {}", center.base_url));

            // 没配过令牌就先给引导页：填完才进主界面，不然打开就是一个连不上的空壳。
            let start_page = if center.token.is_none() {
                log("还没有令牌，先显示引导页");
                "onboard.html"
            } else {
                "index.html"
            };

            let mut builder = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App(start_page.into()),
            )
            .title("Seven Station")
            .inner_size(1240.0, 820.0)
            .min_inner_size(880.0, 560.0);

            if let Some((left, top, width, height)) = read_bounds() {
                builder = builder.position(left, top).inner_size(width, height);
            }

            let window = builder.build()?;

            let handle = window.clone();
            window.on_window_event(move |event| match event {
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => save_bounds(&handle),
                WindowEvent::CloseRequested { .. } => save_bounds(&handle),
                _ => {}
            });

            if center.token.is_none() {
                // 引导页自己会在填完后跳到 Seven Station Core 页面，这里不再抢先导航。
                return Ok(());
            }

            let target = center_url(&center);
            let navigator = window.clone();
            tauri::async_runtime::spawn(async move {
                // 等页面把壳的消息通道准备好再跳，否则页面拿不到 __TAURI__。
                std::thread::sleep(std::time::Duration::from_millis(150));
                match tauri::Url::parse(&target) {
                    Ok(url) => {
                        if let Err(error) = navigator.navigate(url) {
                            log(&format!("打不开 Seven Station Core 页面：{error}"));
                            let _ = navigator.eval(format!(
                                "window.sevenStationShowState && window.sevenStationShowState('连不上 Seven Station Core，检查一下服务是否在跑')"
                            ));
                        }
                    }
                    Err(error) => log(&format!("Seven Station Core 地址不对：{error}")),
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Seven Station 启动失败");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 复制文件这条路只有在真实 Windows 会话里才走得通：这里只验证命令本身不报错，
    /// 剪贴板里到底有没有那个文件，靠 scripts/ui-tests 之外的实测（或系统「粘贴」）确认。
    #[test]
    fn copy_file_puts_a_file_on_the_clipboard() {
        let path = std::env::temp_dir().join("sevenstation-copy-test.txt");
        std::fs::write(&path, b"x").expect("写测试文件");
        let result = copy_file(path.to_string_lossy().to_string());
        let _ = std::fs::remove_file(&path);
        assert!(result.is_ok(), "复制失败：{result:?}");
    }

    #[test]
    fn copy_file_rejects_missing_path() {
        let result = copy_file(r"E:\SevenStation-there-is-no-such-file.txt".into());
        assert!(result.is_err());
    }

    #[test]
    fn reveal_in_explorer_rejects_missing_path() {
        let result = reveal_in_explorer(r"E:\SevenStation-no-such-dir".into());
        assert!(result.is_err());
    }
}
