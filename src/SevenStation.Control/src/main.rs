// Windows 上不要弹命令行窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod core;
mod runner;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

/// 托盘里那两项要跟着状态改文字，所以留着句柄。
struct TrayMenu {
    headline: MenuItem<tauri::Wry>,
    toggle: MenuItem<tauri::Wry>,
}

#[tauri::command]
fn set_pi_dir(path: String) -> Result<(), String> {
    core::set_pi_dir(&path)
}


/// 跟本机的 Seven Station Core 说一句话（管理接口都只认主令牌）。
/// 走回环的裸 HTTP：够用，也不必引 HTTP 客户端依赖。
/// 返回响应体文本；二维码是 SVG，页面直接塞进 DOM 就行。
#[tauri::command]
fn core_api(method: String, path: String, body: Option<String>) -> Result<String, String> {
    use std::io::{Read, Write};
    use std::net::TcpStream;

    let token = core::token();
    if token.is_empty() {
        return Err("读不到 Seven Station Core 的访问令牌，先点「启动」把它拉起来。".into());
    }

    let mut stream = TcpStream::connect(("127.0.0.1", core::port()))
        .map_err(|error| format!("连不上 Seven Station Core：{error}"))?;
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(20)))
        .ok();

    let payload = body.unwrap_or_default();
    let request = build_request(&method, &path, &token, &payload);

    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("发给 Seven Station Core 失败：{error}"))?;

    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .map_err(|error| format!("等 Seven Station Core 回话失败：{error}"))?;

    let text = String::from_utf8_lossy(&raw).to_string();
    let (head, rest) = split_headers(&text)
        .ok_or_else(|| "Seven Station Core 回了一段看不懂的响应".to_string())?;

    let status: u16 = head
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);

    let chunked = head.to_ascii_lowercase().contains("transfer-encoding: chunked");
    let payload = if chunked { dechunk(rest) } else { rest.to_string() };

    if status >= 400 {
        return Err(format!("Seven Station Core 回了 {status}：{payload}"));
    }

    Ok(payload)
}

/// 手写 HTTP/1.1 请求。头之间必须是 CRLF：只给 LF 的话 Kestrel 当没有头，
/// 回一个 400，页面那边就成了「看不懂的响应」。
fn build_request(method: &str, path: &str, token: &str, payload: &str) -> String {
    format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n{payload}",
        len = payload.len()
    )
}

/// 头和正文的分界：正常是 CRLFCRLF，个别代理/精简实现只给 LFLF。
fn split_headers(text: &str) -> Option<(&str, &str)> {
    const CRLFCRLF: &str = "\r\n\r\n";
    const LFLF: &str = "\n\n";
    text.split_once(CRLFCRLF).or_else(|| text.split_once(LFLF))
}

/// 把 chunked 响应拼回一整段（小响应 Kestrel 一般直接给 Content-Length，这里只是兜底）。
fn dechunk(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    const CRLF: &str = "\r\n";

    loop {
        let Some(split) = rest.find(CRLF).or_else(|| rest.find(char::from(10))) else {
            break;
        };
        let size_text = rest[..split].trim();
        let Ok(size) = usize::from_str_radix(size_text, 16) else {
            break;
        };
        if size == 0 {
            break;
        }

        let start = split + 2;
        let end = (start + size).min(rest.len());
        out.push_str(&rest[start..end]);
        rest = &rest[(end + 2).min(rest.len())..];
    }

    out
}

#[tauri::command]
fn read_state() -> core::Snapshot {
    core::snapshot()
}

#[tauri::command]
fn control(app: tauri::AppHandle, action: String) -> Result<(), String> {
    match action.as_str() {
        "start" => core::start(),
        "stop" => core::stop(),
        "restart" => core::restart(),
        _ => Err("不认识的操作。".into()),
    }?;

    publish(&app);
    Ok(())
}

#[tauri::command]
fn set_autostart(app: tauri::AppHandle, on: bool) -> Result<(), String> {
    core::set_autostart(on)?;
    publish(&app);
    Ok(())
}

#[tauri::command]
fn set_lan(app: tauri::AppHandle, on: bool) -> Result<(), String> {
    core::set_lan(on)?;
    publish(&app);
    Ok(())
}

#[tauri::command]
fn regenerate_token(app: tauri::AppHandle) -> Result<(), String> {
    core::regenerate_token()?;
    publish(&app);
    let _ = app.emit("toast", "新令牌已生效，其他设备要用它重新连一次。".to_string());
    Ok(())
}

#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    core::copy_text(&text)
}

#[tauri::command]
fn open_target(target: String) -> Result<(), String> {
    core::open_target(&target)
}

/// 状态变了就往页面推一次，同时把托盘上的文字换掉。
// 排查用：关窗这条路到底有没有进来。写到 %LOCALAPPDATA%\SevenStation.Control\control.log。
fn log_line(text: &str) {
    use std::io::Write;
    let base = std::env::var_os("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let dir = match core::profile() {
        Some(profile) => base.join(format!("SevenStation.Control-{profile}")),
        None => base.join("SevenStation.Control"),
    };
    let _ = std::fs::create_dir_all(&dir);
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("control.log"))
    else {
        return;
    };
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = writeln!(file, "{stamp} {text}");
}

fn publish(app: &tauri::AppHandle) {
    let snapshot = core::snapshot();
    let _ = app.emit("state", &snapshot);

    if let Some(menu) = app.try_state::<TrayMenu>() {
        let _ = menu.headline.set_text(if snapshot.running {
            format!("正在运行 · {}", snapshot.listen)
        } else {
            "已停止".to_string()
        });
        let _ = menu.toggle.set_text(if snapshot.running { "停止 Seven Station Core" } else { "启动 Seven Station Core" });
    }

    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(if snapshot.running {
            "Seven Station Core · 正在运行"
        } else {
            "Seven Station Core · 已停止"
        }));
    }
}

fn show_window(app: &tauri::AppHandle) {
    match app.get_webview_window("main") {
        None => log_line("叫窗口回来：找不到 main 窗口"),
        Some(window) => {
            let _ = window.unminimize();
            let shown = window.show();
            let _ = window.set_focus();
            log_line(&format!("叫窗口回来：显示结果 {shown:?}"));
        }
    }
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let headline = MenuItem::with_id(app, "headline", "正在读取状态…", false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "打开 Seven Station Control", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "启动 Seven Station Core", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&headline, &open, &toggle, &quit])?;

    app.manage(TrayMenu {
        headline: headline.clone(),
        toggle: toggle.clone(),
    });

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Seven Station Control")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_window(app),
            "toggle" => {
                let running = core::snapshot().running;
                let result = if running { core::stop() } else { core::start() };
                match result {
                    Ok(()) => publish(app),
                    Err(message) => {
                        show_window(app);
                        let _ = app.emit("toast", message);
                    }
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_window(tray.app_handle());
            }
        });

    // 托盘用浅底那张：客户端托盘是深底，两个放一起才能一眼分开。
    let tray_png = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    builder = builder.icon(tray_png);

    builder.build(app)?;
    Ok(())
}

fn main() {
    log_line(&format!(
        "Seven Station Control 启动，exe = {:?}，档案 = {:?}，服务 = {}",
        std::env::current_exe().ok(),
        core::profile(),
        core::service()
    ));
    // 提权子进程只做一件事就退，别建窗口、别起 WebView。
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 3 && args[1] == core::ELEVATE_FLAG {
        std::process::exit(core::run_elevated(&args[2..]));
    }

    // 测试档案（SEVENSTATION_PROFILE）不挂单实例插件：否则测试版会并进正在用的正式版，
    // 用户那边会莫名其妙弹出一个窗口，测试也会读到正式版的真实状态。
    let profile = core::profile();
    let mut builder = tauri::Builder::default();
    if profile.is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            log_line("又启动了一次，交给已有实例");
            show_window(app);
        }));
    }

    builder
        .invoke_handler(tauri::generate_handler![
            set_pi_dir,
            read_state,
            control,
            set_autostart,
            set_lan,
            regenerate_token,
            copy_text,
            open_target,
            core_api
        ])
        .setup(|app| {
            let window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Seven Station Control")
            .inner_size(720.0, 626.0)
            .min_inner_size(620.0, 560.0)
            .center()
            .build()?;

            // 关窗口只是收进托盘，Seven Station Core 照常跑；真退出走托盘右键。
            let handle = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    // 关窗口只是收进托盘，Seven Station Core 照常跑；真退出走托盘右键。
                    // 收到就立刻收，不加延迟也不弹提示。
                    log_line("收到关闭请求");
                    api.prevent_close();
                    match handle.hide() {
                        Ok(()) => log_line("已隐藏窗口"),
                        Err(error) => log_line(&format!("隐藏窗口失败: {error}")),
                    }
                }
            });

            build_tray(app)?;

            // 登录任务：Pi 必须在用户会话里跑，这个任务就是登录后把执行代理拉起来的那根钉子。
            // 建它不需要管理员（在给自己建），失败也只是没有代理，页面上会说清楚。
            std::thread::spawn(|| match core::core_exe_path() {
                Ok(exe) => match runner::ensure(&exe) {
                    Ok(message) => log_line(&format!("执行代理：{message}")),
                    Err(message) => log_line(&format!("执行代理没挂上：{message}")),
                },
                Err(message) => log_line(&format!("执行代理没挂上：{message}")),
            });

            // 每 3 秒把状态推一次；服务和监听地址都可能被别处改动。
            let poller = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(3));
                publish(&poller);
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Seven Station Control 启动失败");
}

#[cfg(test)]
mod http_tests {
    use super::{build_request, dechunk, split_headers};

    #[test]
    fn builds_a_request_with_real_crlf() {
        let request = build_request("GET", "/api/devices", "t0ken", "");
        assert!(request.starts_with("GET /api/devices HTTP/1.1\r\n"), "请求行要带 CRLF");
        assert!(request.contains("\r\nHost: 127.0.0.1\r\n"), "要有 Host 头");
        assert!(request.ends_with("\r\n\r\n"), "头后面要留一个空行");
        // 去掉所有 CRLF 之后不能再有裸 LF —— 裸 LF 就是当初那个 bug
        assert!(!request.replace("\r\n", "").contains(char::from(10)), "不能出现裸 LF");
    }

    #[test]
    fn puts_the_body_after_the_blank_line() {
        let request = build_request("POST", "/api/devices", "t0ken", "{}");
        assert!(request.ends_with("\r\n\r\n{}"));
        assert!(request.contains("Content-Length: 2"));
    }

    #[test]
    fn splits_head_and_body() {
        let text = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}";
        let (head, rest) = split_headers(text).expect("应当能切开");
        assert!(head.starts_with("HTTP/1.1 200"));
        assert_eq!(rest, "{}");
    }

    #[test]
    fn splits_when_only_lf() {
        let text = "HTTP/1.1 200 OK\n\nok";
        let (_, rest) = split_headers(text).expect("LF 也要能切");
        assert_eq!(rest, "ok");
    }

    #[test]
    fn dechunks_one_chunk() {
        let body = "e\r\n{\"devices\":[]}\r\n0\r\n\r\n";
        assert_eq!(dechunk(body), "{\"devices\":[]}");
    }

    #[test]
    fn dechunks_two_chunks() {
        let body = "3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n";
        assert_eq!(dechunk(body), "abcde");
    }
}
